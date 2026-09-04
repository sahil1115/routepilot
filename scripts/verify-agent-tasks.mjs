#!/usr/bin/env node
/**
 * Verify an adapter against real coding tasks.
 *
 * `verify-adapter.mjs` sends one prompt and asserts the run reached
 * `completed`, which proves the transport and event schema but forbids the
 * agent from doing anything.
 *
 * This asks for work in a throwaway repository and checks the filesystem
 * afterwards. Every assertion is an observation -- a file exists, its contents
 * changed, the fixture's own test suite passes -- never the agent's transcript,
 * since the whole question is whether that account is true.
 *
 * Usage:
 *   node scripts/verify-agent-tasks.mjs cursor-cli
 *   node scripts/verify-agent-tasks.mjs claude-code --permission-mode acceptEdits
 *
 *   --command <path>          explicit path to the CLI
 *   --command-args <arg>      argument placed before the adapter's own; repeatable
 *   --permission-mode <mode>  passed through to the adapter
 *   --only <task>             run one task by name
 *   --dump-events             print each event, including whether tools were refused
 *
 * This spends real quota and lets a real agent write files, all of them in a
 * fresh temp directory worth nothing. Your repository is never the workspace.
 *
 * Exit code 0 means every task it ran was observed to work.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const ADAPTERS = {
  'claude-code': {
    module: '../dist/adapters/claude-code/adapter.js',
    className: 'ClaudeCodeAdapter',
    modelId: 'haiku',
  },
  'cursor-cli': {
    module: '../dist/adapters/cursor/adapter.js',
    className: 'CursorCliAdapter',
    modelId: 'auto',
  },
};

const id = process.argv[2];
const target = ADAPTERS[id];

if (!target) {
  console.error(`Usage: node scripts/verify-agent-tasks.mjs <${Object.keys(ADAPTERS).join('|')}>`);
  console.error('       [--command <path>] [--command-args <arg>] [--permission-mode <mode>]');
  console.error('       [--only <task>]');
  process.exit(2);
}

const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const dumpEvents = process.argv.includes('--dump-events');
const commandArgs = [];
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--command-args' && process.argv[i + 1]) {
    commandArgs.push(process.argv[i + 1]);
  }
}

if (id === 'claude-code' && process.env.CLAUDECODE) {
  console.error(
    'Refusing to run: this looks like a Claude Code session (CLAUDECODE is set).\n' +
      'Claude Code cannot run nested inside itself.\n\n' +
      'Open a plain terminal — PowerShell or Command Prompt from the Start menu,\n' +
      'NOT the terminal inside VS Code — then:\n' +
      `  cd ${repoRoot}\n` +
      '  node scripts/verify-agent-tasks.mjs claude-code',
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The fixture repository
//
// Duplicated from `src/test-support/agent-fixture-repo.ts` rather than imported:
// that module is excluded from the published build (`tsconfig.build.json`), so
// `dist/` does not contain it. Keeping the files here means this script runs
// against a plain `npm run build`.
// ---------------------------------------------------------------------------

const FIXTURE_FILES = {
  'package.json': `${JSON.stringify(
    {
      name: 'routepilot-agent-fixture',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: { test: 'node test.mjs' },
    },
    null,
    2,
  )}\n`,
  'src/calculator.mjs':
    '/** Add two numbers. */\n' +
    'export function add(a, b) {\n' +
    '  return a - b;\n' +
    '}\n\n' +
    '/** Multiply two numbers. */\n' +
    'export function multiply(a, b) {\n' +
    '  return a * b;\n' +
    '}\n',
  'test.mjs':
    "import assert from 'node:assert/strict';\n" +
    "import { add, multiply } from './src/calculator.mjs';\n\n" +
    "assert.equal(add(2, 3), 5, 'add(2, 3) should be 5');\n" +
    "assert.equal(multiply(2, 3), 6, 'multiply(2, 3) should be 6');\n\n" +
    "console.log('all tests passed');\n",
  'README.md':
    '# Fixture repository\n\nA throwaway workspace for verifying RoutePilot adapters.\n' +
    'It contains one deliberate defect in `src/calculator.mjs`. Nothing here is real.\n',
};

async function makeFixture() {
  const dir = join(tmpdir(), `routepilot-tasks-${String(process.pid)}-${String(Date.now())}`);
  for (const [relative, contents] of Object.entries(FIXTURE_FILES)) {
    const path = join(dir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }
  return dir;
}

const read = (dir, relative) => readFile(join(dir, relative), 'utf8').catch(() => null);

async function fixtureTestsPass(dir) {
  try {
    await run(process.execPath, ['test.mjs'], { cwd: dir, timeout: 60_000, shell: false });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort, never fatal: a locked directory must not lose a result. */
const cleanup = (dir) =>
  rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const { [target.className]: Adapter } = await import(target.module);
const permissionMode = flag('--permission-mode');
const command = flag('--command');

const adapter = new Adapter({
  ...(command ? { command } : {}),
  ...(commandArgs.length > 0 ? { commandArgs } : {}),
  ...(permissionMode ? { permissionMode } : {}),
});

const model = {
  id: `verify/${target.modelId}`,
  providerId: 'verify',
  modelId: target.modelId,
  displayName: target.modelId,
  tier: 'cheap',
  contextWindow: 200_000,
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

/** Drive one prompt to completion, collecting the event kinds seen. */
async function execute(dir, prompt, taskType = 'bug-fix', onSession) {
  const session = await adapter.execute(
    {
      requestId: `tasks-${String(Date.now())}`,
      prompt,
      workspaceRoot: dir,
      taskType,
      requiredCapabilities: { toolUse: true, agenticExecution: true },
    },
    model,
  );

  onSession?.(session);

  const kinds = [];
  const events = [];
  for await (const event of session.events) {
    kinds.push(event.kind);
    events.push(event);
    if (dumpEvents) {
      // `ok` is the field that answers "was the tool call refused, or did it
      // succeed and change nothing" -- a distinction the event *kind* cannot
      // carry, and one this script previously discarded.
      const parts = [event.kind];
      if (event.ok !== undefined) parts.push(`ok=${String(event.ok)}`);
      if (event.tool) parts.push(`tool=${event.tool}`);
      if (event.path) parts.push(`path=${event.path}`);
      if (event.summary) parts.push(`summary=${String(event.summary).slice(0, 120)}`);
      console.log(`        · ${parts.join(' ')}`);
    }
  }
  const result = await session.result;
  return { result, kinds, events };
}

// ---------------------------------------------------------------------------
// The tasks
//
// Each returns { passed, detail }. `passed` is decided by looking at the
// workspace, never at what the agent said it did.
// ---------------------------------------------------------------------------

const TASKS = [
  {
    name: 'file-modification + test-execution',
    covers: ['file modification', 'tool/terminal execution', 'test execution', 'completion'],
    async run(dir) {
      const before = await fixtureTestsPass(dir);
      if (before) return { passed: false, detail: 'the fixture arrived already passing' };

      const { result, kinds, events } = await execute(
        dir,
        'The test suite in this repository fails. Fix the bug in src/calculator.mjs ' +
          'so that `node test.mjs` passes. Run it to confirm before you finish.',
      );

      const after = await fixtureTestsPass(dir);
      const source = (await read(dir, 'src/calculator.mjs')) ?? '';
      const refused = events.filter((event) => event.kind === 'tool-result' && event.ok === false);

      return {
        passed: after,
        detail:
          `tests ${after ? 'pass' : 'still fail'} after the run; ` +
          `status=${result.status}; ` +
          `source ${source.includes('a + b') ? 'was corrected' : 'unchanged'}; ` +
          // The decisive number when a write task fails: a refused tool call is
          // a permission problem, zero refusals with no change is something else.
          `changed=[${result.changedFiles.join(', ')}]; ` +
          (result.failureType ? `failureType=${result.failureType}; ` : '') +
          `tool-results refused=${String(refused.length)}/` +
          `${String(events.filter((e) => e.kind === 'tool-result').length)}; ` +
          `events=${[...new Set(kinds)].join(',') || 'none'}`,
      };
    },
  },
  {
    name: 'file-creation',
    covers: ['file creation'],
    async run(dir) {
      const { result, kinds } = await execute(
        dir,
        'Create a new file src/subtract.mjs that exports a function ' +
          'subtract(a, b) returning a minus b. Do not change any other file.',
        'feature-implementation',
      );

      const created = await read(dir, 'src/subtract.mjs');
      const correct = created !== null && /export\s+function\s+subtract/.test(created);

      return {
        passed: correct,
        detail:
          `${created === null ? 'file was not created' : 'file created'}; ` +
          `status=${result.status}; events=${[...new Set(kinds)].join(',') || 'none'}`,
      };
    },
  },
  {
    name: 'controlled-failure',
    covers: ['controlled failure'],
    async run(dir) {
      // Asks for something impossible. What is being checked is that RoutePilot
      // does not report success regardless -- a failure that reads as a success
      // is worse than a failure.
      const { result } = await execute(
        dir,
        'Read the file src/does-not-exist-anywhere.mjs and tell me the exact ' +
          'value of the constant SECRET_TOKEN defined in it. Do not create the file. ' +
          'If it does not exist, say so and stop.',
        'investigation',
      );

      const invented = await read(dir, 'src/does-not-exist-anywhere.mjs');

      return {
        // The agent may legitimately "complete" by reporting the file is
        // missing. What must not happen is it fabricating the file.
        passed: invented === null,
        detail:
          `status=${result.status}; ` +
          `${invented === null ? 'did not fabricate the missing file' : 'FABRICATED the file'}`,
      };
    },
  },
  {
    name: 'cancellation',
    covers: ['cancellation'],
    async run(dir) {
      let cancelled = false;
      const { result } = await execute(
        dir,
        'Carefully review every file in this repository and write a detailed ' +
          'report of your findings into REVIEW.md, taking as long as you need.',
        'investigation',
        (session) => {
          // Cancel shortly after the run starts, so there is something to cancel.
          setTimeout(() => {
            cancelled = true;
            void adapter.cancel(session.id);
          }, 3_000);
        },
      );

      return {
        passed: cancelled && result.status !== 'completed',
        detail:
          `status=${result.status}; ` +
          `${result.status === 'completed' ? 'finished before cancellation landed' : 'stopped'}`,
      };
    },
  },
];

// Escalation is deliberately absent. It is a TaskRunner decision across two
// models, not an adapter behaviour, and forcing a real agent to fail on demand
// costs money to observe something the scripted end-to-end scenarios already
// cover deterministically.

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const only = flag('--only');
const selected = only ? TASKS.filter((task) => task.name === only) : TASKS;

if (selected.length === 0) {
  console.error(`No task named "${only}". Known: ${TASKS.map((t) => t.name).join(', ')}`);
  process.exit(2);
}

console.log(`\nVerifying real coding tasks: ${id}`);
if (command) console.log(`Using command: ${command}`);
if (commandArgs.length > 0) console.log(`Leading args : ${commandArgs.join(' ')}`);
console.log(`Permission   : ${permissionMode ?? '(adapter default — none passed)'}`);

const status = await adapter.getStatus();
console.log(`Available    : ${status.available}${status.version ? ` (${status.version})` : ''}\n`);

if (!status.available) {
  console.error(`Not available:\n${status.detail}`);
  process.exit(1);
}

const results = [];

for (const task of selected) {
  const dir = await makeFixture();
  const started = Date.now();
  process.stdout.write(`  ${task.name} … `);

  let outcome;
  try {
    outcome = await task.run(dir);
  } catch (error) {
    outcome = {
      passed: false,
      detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const elapsedMs = Date.now() - started;
  console.log(`${outcome.passed ? 'PASS' : 'FAIL'} (${String(Math.round(elapsedMs / 1000))}s)`);
  console.log(`      ${outcome.detail}`);

  results.push({ name: task.name, covers: task.covers, ...outcome, elapsedMs });
  await cleanup(dir);
}

const passed = results.filter((result) => result.passed).length;
console.log(`\n  ${String(passed)}/${String(results.length)} task(s) observed to work\n`);

const reportDir = join(repoRoot, '.routepilot');
await mkdir(reportDir, { recursive: true });
const reportPath = join(reportDir, `agent-tasks-${id}.json`);
await writeFile(
  reportPath,
  JSON.stringify(
    {
      adapterId: id,
      ranAt: new Date().toISOString(),
      toolVersion: status.version ?? null,
      permissionMode: permissionMode ?? null,
      platform: `${process.platform} node ${process.versions.node}`,
      passed: passed === results.length,
      results,
    },
    null,
    2,
  ),
);

console.log(`Report written to ${reportPath}`);
process.exit(passed === results.length ? 0 : 1);
