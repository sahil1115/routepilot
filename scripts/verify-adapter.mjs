#!/usr/bin/env node
/**
 * Real-execution verification for an agent adapter.
 *
 * Mock tests prove an adapter handles the shapes it was told to expect. Only a
 * real run proves those are the shapes the tool actually emits. Until this
 * script has been run and its output recorded in
 * `src/adapters/verification.ts`, an adapter stays `unverified` and RoutePilot
 * does not claim it works (spec section 2, rule 20).
 *
 * Usage:
 *   node scripts/verify-adapter.mjs claude-code
 *   node scripts/verify-adapter.mjs cursor-cli
 *
 * This spends real quota or money: it asks a real agent to do a trivial task in
 * a throwaway directory. Nothing in your repository is touched.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const ADAPTERS = {
  'claude-code': {
    module: '../dist/adapters/claude-code/adapter.js',
    className: 'ClaudeCodeAdapter',
    modelId: 'haiku',
    note: 'Claude Code must be run from a plain terminal, not inside a Claude Code session.',
  },
  'cursor-cli': {
    module: '../dist/adapters/cursor/adapter.js',
    className: 'CursorCliAdapter',
    modelId: 'auto',
    note: 'Requires `cursor-agent` on PATH.',
  },
};

const id = process.argv[2];
const target = ADAPTERS[id];

if (!target) {
  console.error(`Usage: node scripts/verify-adapter.mjs <${Object.keys(ADAPTERS).join('|')}>`);
  console.error('       [--command <path to the CLI>]');
  process.exit(2);
}

/**
 * An explicit path to the tool, for when it is installed but not on PATH.
 *
 * Installers routinely put a binary somewhere the current shell has not picked
 * up yet -- a new PATH entry needs a new terminal -- and "not found" would then
 * be reported as an adapter problem, which it is not.
 */
const commandFlag = process.argv.indexOf('--command');
const explicitCommand =
  commandFlag === -1 ? process.env.ROUTEPILOT_ADAPTER_COMMAND : process.argv[commandFlag + 1];

if (commandFlag !== -1 && !explicitCommand) {
  console.error('--command needs a path, for example: --command "C:\path\to\cursor-agent.exe"');
  process.exit(2);
}

if (id === 'claude-code' && process.env.CLAUDECODE) {
  console.error(
    'Refusing to run: this looks like a Claude Code session (CLAUDECODE is set).\n' +
      'Claude Code cannot run nested inside itself.\n\n' +
      'Open a plain terminal -- PowerShell or Command Prompt from the Start menu,\n' +
      'NOT the terminal inside VS Code -- then:\n' +
      `  cd ${repoRoot}\n` +
      '  npm run verify:adapters -- claude-code',
  );
  process.exit(2);
}

const { [target.className]: Adapter } = await import(target.module);
const adapter = new Adapter(explicitCommand ? { command: explicitCommand } : {});

console.log(`Verifying adapter: ${id}`);
console.log(target.note);
if (explicitCommand) console.log(`Using command: ${explicitCommand}`);
console.log('');

// --- 1. Availability -------------------------------------------------------
const status = await adapter.getStatus();
console.log(`status.available : ${status.available}`);
console.log(`status.version   : ${status.version ?? '(unknown)'}`);
if (!status.available) {
  console.error(`\nNot available:\n${status.detail}`);
  process.exit(1);
}

// --- 2. A real, trivial run in a throwaway directory -----------------------
const dir = await mkdtemp(join(tmpdir(), 'routepilot-verify-'));
await writeFile(join(dir, 'NOTES.md'), '# notes\n', 'utf8');

const model = {
  id: `verify/${target.modelId}`,
  providerId: 'verify',
  modelId: target.modelId,
  displayName: target.modelId,
  tier: 'cheap',
  contextWindow: 200000,
  pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
  capabilities: {
    toolUse: true,
    agenticExecution: true,
    streaming: true,
    structuredOutput: true,
    vision: false,
  },
  latency: { firstTokenSeconds: 1, outputTokensPerSecond: 100 },
  availability: 'available',
  priors: { skills: {}, languages: {} },
};

const request = {
  requestId: 'verify-1',
  prompt: 'Reply with exactly the word OK. Do not use any tools.',
  workspaceRoot: dir,
  taskType: 'explanation',
  requiredCapabilities: { toolUse: true },
};

console.log(`\nRunning a trivial task in ${dir} …\n`);

const started = Date.now();
const session = await adapter.execute(request, model);

const kinds = [];
for await (const event of session.events) {
  kinds.push(event.kind);
  console.log(`  event: ${event.kind}${event.summary ? ` — ${event.summary}` : ''}`);
}

const result = await session.result;
const elapsed = Date.now() - started;

// Cleanup deliberately happens *after* the report is written. On Windows the
// agent's process can still hold a handle to the workspace for a moment after
// it exits, and an EBUSY from rmdir once destroyed the entire result of a real
// verification run that had already succeeded.

// --- 3. Report -------------------------------------------------------------
console.log('');
console.log(`result.status    : ${result.status}`);
console.log(`result.failure   : ${result.failureType ?? '(none)'}`);
console.log(`result.usage     : ${JSON.stringify(result.usage ?? null)}`);
console.log(`event kinds      : ${kinds.join(', ') || '(none)'}`);
console.log(`elapsed          : ${elapsed}ms`);

const ok = result.status === 'completed' && kinds.includes('completed');

console.log('');
if (ok) {
  console.log('PASS — the adapter completed a real run.');
  console.log('');
  console.log('To record this, set the entry in src/adapters/verification.ts to:');
  console.log(`  status: 'verified',`);
  console.log(`  evidence: {`);
  console.log(`    date: '${new Date().toISOString().slice(0, 10)}',`);
  console.log(`    toolVersion: '${status.version ?? 'unknown'}',`);
  console.log(`    note: 'Ran a trivial task end to end; observed events: ${kinds.join(', ')}.',`);
  console.log(`  },`);
} else {
  console.log('FAIL — the adapter did not complete a real run.');
  console.log(`Error summary: ${result.errorSummary ?? '(none)'}`);
  console.log('');
  console.log('Leave the adapter marked unverified and fix the normalisation first.');
}

// Written to disk as well as printed, so the outcome can be recorded without
// anyone re-typing it. `.routepilot/` is gitignored: this is evidence, not
// source.
const reportDir = join(repoRoot, '.routepilot');
await mkdir(reportDir, { recursive: true });
const reportPath = join(reportDir, `adapter-verification-${id}.json`);
await writeFile(
  reportPath,
  JSON.stringify(
    {
      adapterId: id,
      passed: ok,
      ranAt: new Date().toISOString(),
      toolVersion: status.version ?? null,
      available: status.available,
      resultStatus: result.status,
      failureType: result.failureType ?? null,
      usage: result.usage ?? null,
      eventKinds: kinds,
      elapsedMs: elapsed,
      errorSummary: result.errorSummary ?? null,
      platform: `${process.platform} node ${process.versions.node}`,
    },
    null,
    2,
  ),
);

console.log('');
console.log(`Report written to ${reportPath}`);
console.log('Nothing else is needed: that file is enough to record the result.');

// Best-effort, and never fatal: removing a temporary directory is tidying up,
// not part of the verification. `maxRetries` matches the convention used
// everywhere else in this repository for exactly this Windows behaviour.
try {
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
} catch (error) {
  console.log('');
  console.log(`Note: could not remove ${dir} (${String(error)}).`);
  console.log('That is a cleanup problem, not a verification failure.');
}

process.exit(ok ? 0 : 1);
