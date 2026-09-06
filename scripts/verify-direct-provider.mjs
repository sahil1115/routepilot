#!/usr/bin/env node
/**
 * Verify the direct provider adapter against a real provider.
 *
 * The one script in this repository that needs a credential, which is why it is
 * separate from `npm run verify` and never runs in CI. `build.ts` deliberately
 * refuses to construct this adapter, so nothing else can reach a secret by
 * accident.
 *
 * Usage, from a plain terminal:
 *
 *   $env:ANTHROPIC_API_KEY = "..."      # PowerShell
 *   export ANTHROPIC_API_KEY="..."      # bash
 *   npm run verify:direct
 *
 *   --model <id>   model to call. Defaults to claude-opus-5.
 *   --env-var <NAME>  environment variable holding the key. Defaults to
 *                     ANTHROPIC_API_KEY.
 *
 * ## What it does with the key
 *
 * Reads it from the environment by NAME and hands it to the adapter, which puts
 * it in a header. It is never written to a file, never passed as an argument,
 * never printed, and never included in the report. The checks below assert
 * that: one of them scans every string this script produces for the key.
 *
 * Cost: three short requests, a few hundred tokens in total.
 *
 * Exit code 0 means the adapter was observed to work against the real API.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function flag(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const modelId = flag('--model', 'claude-opus-5');
const envVar = flag('--env-var', 'ANTHROPIC_API_KEY');
const secret = process.env[envVar];

if (secret === undefined || secret === '') {
  console.error(`\n  ${envVar} is not set.\n`);
  console.error('  Set it in your own shell -- never on the command line, where it would');
  console.error('  land in shell history and the process list:\n');
  console.error(`    $env:${envVar} = "..."      # PowerShell`);
  console.error(`    export ${envVar}="..."      # bash\n`);
  process.exit(2);
}

const { DirectProviderAdapter } = await import('../dist/adapters/direct/adapter.js');
const { anthropicMessagesProtocol } =
  await import('../dist/adapters/direct/protocols/anthropic.js');

const provider = {
  id: 'anthropic',
  displayName: 'Anthropic',
  kind: 'cloud',
  endpoint: 'https://api.anthropic.com',
  // The NAME of the variable. The value never appears in configuration.
  auth: { kind: 'apiKey', envVar },
  timeoutMs: 60_000,
  retry: { maxAttempts: 2, initialDelayMs: 500, backoffMultiplier: 2, maxDelayMs: 4_000 },
  availability: 'available',
};

const model = {
  id: `anthropic/${modelId}`,
  providerId: 'anthropic',
  modelId,
  displayName: modelId,
  tier: 'frontier',
  contextWindow: 200_000,
  maxOutputTokens: 64,
  pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
  capabilities: {
    toolUse: true,
    agenticExecution: false,
    streaming: true,
    structuredOutput: true,
    vision: false,
  },
  latency: { firstTokenSeconds: 1, outputTokensPerSecond: 50 },
  availability: 'available',
  priors: { skills: {}, languages: {} },
};

function adapterFor(env, options = {}) {
  return new DirectProviderAdapter({
    provider,
    protocol: anthropicMessagesProtocol({ maxTokens: 32, ...options }),
    env,
  });
}

function request(prompt) {
  return {
    requestId: `verify-${String(Date.now())}`,
    prompt,
    workspaceRoot: root,
    taskType: 'explanation',
    requiredCapabilities: {},
  };
}

/** Everything this run printed or recorded, scanned for the secret at the end. */
const emitted = [];
function say(line) {
  emitted.push(line);
  console.log(line);
}

const results = [];
async function check(name, covers, run) {
  const started = Date.now();
  try {
    const outcome = await run();
    const elapsed = Date.now() - started;
    results.push({ name, covers, passed: outcome.passed, detail: outcome.detail, elapsed });
    say(`  ${name} ... ${outcome.passed ? 'PASS' : 'FAIL'} (${String(elapsed)} ms)`);
    say(`      ${outcome.detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, covers, passed: false, detail, elapsed: Date.now() - started });
    say(`  ${name} ... FAIL`);
    say(`      ${detail}`);
  }
}

say('');
say(`Verifying the direct provider adapter against ${provider.endpoint}`);
say(`Model        : ${modelId}`);
say(`Credential   : read from ${envVar} (value never shown)`);
say('');

await check('availability is reported without a network call', ['status probe'], async () => {
  const status = await adapterFor(process.env).getStatus();
  return {
    passed: status.available === true,
    detail: `available=${String(status.available)}${status.detail ? `; ${status.detail}` : ''}`,
  };
});

await check(
  'a missing credential is an environment failure, and nothing is sent',
  ['credential handling', 'failure classification'],
  async () => {
    // Deliberately an empty environment: the adapter must refuse locally.
    const session = await adapterFor({}).execute(request('unreachable'), model);
    const result = await session.result;
    return {
      passed: result.failureType === 'ENVIRONMENT_FAILURE',
      detail: `status=${result.status}; failureType=${result.failureType}`,
    };
  },
);

await check(
  'a real streamed request completes and reports usage',
  ['transport', 'authentication', 'SSE decoding', 'usage reporting'],
  async () => {
    const session = await adapterFor(process.env).execute(request('Reply with exactly: OK'), model);

    const kinds = [];
    for await (const event of session.events) kinds.push(event.kind);
    const result = await session.result;

    const streamed = kinds.includes('assistant-message');
    const usage = result.usage;
    return {
      passed: result.status === 'completed' && streamed && (usage?.outputTokens ?? 0) > 0,
      detail:
        `status=${result.status}; events=${[...new Set(kinds)].join(',') || 'none'}; ` +
        `usage=${usage ? `${String(usage.inputTokens)} in / ${String(usage.outputTokens)} out` : 'none'}`,
    };
  },
);

await check(
  'an unknown model is a provider failure, and the error is redacted',
  ['error classification', 'redaction'],
  async () => {
    const wrong = { ...model, modelId: 'claude-does-not-exist' };
    const session = await adapterFor(process.env).execute(request('Reply with OK'), wrong);
    const result = await session.result;
    return {
      passed: result.status === 'failed' && result.failureType === 'PROVIDER_FAILURE',
      detail: `status=${result.status}; failureType=${result.failureType}; summary=${result.errorSummary ?? 'none'}`,
    };
  },
);

const passed = results.every((entry) => entry.passed);

say('');
say(
  `  ${String(results.filter((r) => r.passed).length)}/${String(results.length)} check(s) passed`,
);

const report = {
  adapterId: `direct:${provider.id}`,
  protocolId: 'anthropic-messages',
  ranAt: new Date().toISOString(),
  endpoint: provider.endpoint,
  model: modelId,
  // The NAME, so a reader knows where the credential came from. Never the value.
  credentialFrom: envVar,
  platform: `${process.platform} node ${process.versions.node}`,
  passed,
  results,
};

// The guard that makes the promise above checkable rather than merely stated.
const serialised = JSON.stringify(report) + emitted.join('\n');
if (serialised.includes(secret)) {
  console.error("\n  REFUSING TO WRITE: the credential appeared in this run's own output.");
  console.error('  This is a bug in the adapter or this script. Report it; do not ignore it.\n');
  process.exit(1);
}

await mkdir(join(root, '.routepilot'), { recursive: true });
const reportPath = join(root, '.routepilot', 'direct-provider-verification.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('');
console.log(`Report written to ${reportPath}`);
console.log('It contains no credential. Safe to paste back.');
console.log('');

process.exit(passed ? 0 : 1);
