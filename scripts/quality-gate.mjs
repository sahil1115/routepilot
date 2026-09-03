#!/usr/bin/env node
/**
 * RoutePilot final quality gate (spec section 71).
 *
 * Runs every gate, then maps each item on the specification's checklist to the
 * **evidence that actually proves it** — the named tests that exercise it, or a
 * static check over the source.
 *
 * ## Why this exists rather than a hand-written report
 *
 * A checklist ticked by a human once is a claim about a moment. This re-derives
 * every tick from the suite, so an item cannot stay ticked after the tests that
 * justified it are deleted or renamed: a checklist item whose evidence has
 * vanished is reported as **BROKEN**, which is louder than a silent pass.
 *
 * ## Three verdicts, not two
 *
 * - **PASS** — evidence exists and every piece of it passed.
 * - **PARTIAL** — the capability works in part, and the part that does not is
 *   named. Ticking these would be a lie by omission.
 * - **CANNOT VERIFY** — no evidence can be produced here, with the reason.
 *   Three items are in this state and all three trace to the same root cause:
 *   nothing has ever been executed against a real model.
 *
 * Usage: npm run gate
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const resultsPath = join(tmpdir(), `routepilot-gate-${String(process.pid)}.json`);

const ok = (text) => `\u001B[32m${text}\u001B[0m`;
const warn = (text) => `\u001B[33m${text}\u001B[0m`;
const bad = (text) => `\u001B[31m${text}\u001B[0m`;

/** Run a command, capturing whether it succeeded. */
function run(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...options,
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * Tool entry points, invoked through `node` rather than through `npx`.
 *
 * On Windows `npx` is `npx.cmd`, and Node refuses to spawn a `.cmd` without a
 * shell — deliberate hardening, because `.cmd` re-parses its arguments. The
 * first version of this script spawned `npx.cmd` and every gate reported FAIL
 * for that reason alone, which is a good demonstration of why the rule exists.
 *
 * Enabling a shell to get around it would contradict `docs/SECURITY.md`, so the
 * script does what the Claude Code adapter does: reach the real JavaScript entry
 * point directly.
 */
const node = process.execPath;
const bin = {
  tsc: join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  eslint: join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'),
  prettier: join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs'),
  vitest: join(root, 'node_modules', 'vitest', 'vitest.mjs'),
};

// ---------------------------------------------------------------------------
// Part 1 — the gates
// ---------------------------------------------------------------------------

console.log('RoutePilot — final quality gate\n');
console.log('GATES\n');

const gates = [];
const gate = (name, result, detail = '') => {
  gates.push({ name, ok: result.ok, detail });
  console.log(`  ${result.ok ? ok('PASS') : bad('FAIL')}  ${name}${detail ? `  ${detail}` : ''}`);
  return result;
};

gate('typecheck', run(node, [bin.tsc, '-p', 'tsconfig.json', '--noEmit']));
gate('lint', run(node, [bin.eslint, '.']));
gate('format', run(node, [bin.prettier, '--check', '.']));

const tests = run(node, [bin.vitest, 'run', '--reporter=json', `--outputFile=${resultsPath}`]);

let report = { numTotalTests: 0, numPassedTests: 0, testResults: [] };
if (existsSync(resultsPath)) {
  report = JSON.parse(readFileSync(resultsPath, 'utf8'));
  rmSync(resultsPath, { force: true });
}

gate(
  'tests (unit, integration, end-to-end)',
  { ok: tests.ok && report.numFailedTests === 0 },
  `${String(report.numPassedTests)}/${String(report.numTotalTests)} across ${String(report.testResults.length)} files`,
);

gate('build', run(node, [bin.tsc, '-p', 'tsconfig.build.json']));

// `npm audit` has no JavaScript entry point that can be invoked this way, so it
// is the one command that goes through the shell — with a fixed argument list
// and no interpolation of anything.
const audit = run(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['audit', '--audit-level=low'],
  {
    shell: process.platform === 'win32',
  },
);
gate('dependency audit', audit, audit.ok ? '0 vulnerabilities' : 'see `npm audit`');

// The extension shell is CommonJS with its own build; its checker is a plain
// node script, so it needs no shell either.
// Built here when missing, rather than reported as a failure. The artifact is
// not produced by `npm run build`, so a fresh clone reported FAIL for a gate
// that had simply never been given the chance to run — which is the one thing
// this script exists not to do.
if (!existsSync(join(root, 'extension', 'out', 'extension.js'))) {
  run(node, [join(root, 'scripts', 'sync-extension-core.mjs')]);
  run(node, [bin.tsc, '-p', join(root, 'extension', 'tsconfig.json')]);
}

const extensionBuilt = existsSync(join(root, 'extension', 'out', 'extension.js'));
const extension = extensionBuilt
  ? run(node, [join(root, 'extension', 'scripts', 'verify-extension.cjs')], {
      cwd: join(root, 'extension'),
    })
  : { ok: false, stdout: 'could not be built' };

gate(
  'extension (fake VS Code host)',
  { ok: extension.ok && /19\/19 checks passed/.test(extension.stdout) },
  extensionBuilt ? 'against a fake host, not real VS Code' : 'could not be built',
);

// ---------------------------------------------------------------------------
// Part 2 — the checklist
// ---------------------------------------------------------------------------

/** Every assertion the suite ran, flattened to `full name -> status`. */
const assertions = new Map();
for (const file of report.testResults) {
  for (const assertion of file.assertionResults ?? []) {
    assertions.set(assertion.fullName, assertion.status);
  }
}

/** Tests whose full name contains every one of `needles`. */
function matching(...needles) {
  const found = [];
  for (const [name, status] of assertions) {
    const lower = name.toLowerCase();
    if (needles.every((needle) => lower.includes(needle.toLowerCase()))) {
      found.push({ name, status });
    }
  }
  return found;
}

/** A source-level check: `pattern` must (or must not) appear in shipping code. */
function sourceCheck(description, pattern, { shouldMatch = false, paths = ['src'] } = {}) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSyncSafe(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'coverage', 'out', '.git'].includes(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const text = readFileSync(full, 'utf8');
        if (pattern.test(text)) hits.push(full);
      }
    }
  };
  for (const path of paths) walk(join(root, path));

  return {
    description,
    ok: shouldMatch ? hits.length > 0 : hits.length === 0,
    detail: hits.length === 0 ? 'no occurrences' : `${String(hits.length)} file(s)`,
  };
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * The checklist.
 *
 * Each entry names the evidence. `tests` are substrings that must all appear in
 * a passing test's full name; `verdict` overrides the outcome where the honest
 * answer is not a simple pass.
 */
const CHECKLIST = [
  {
    item: 'core router works without VS Code',
    tests: [['routepilot help'], ['routepilot models'], ['status', 'what it reports']],
  },
  {
    item: 'static routing works',
    tests: [['routes to a cheap model'], ['routes to a medium model']],
  },
  { item: 'model registry works', tests: [['register']] },
  {
    item: 'budget enforcement works',
    tests: [['budget exceeded', 'safe stop'], ['never silently exceeds']],
    verdict: 'PARTIAL',
    note: 'only the REQUEST budget is enforced; session, daily and monthly are validated and displayed but never applied',
  },
  { item: 'capability filtering works', tests: [['context too large'], ['excludes models']] },
  { item: 'repository analysis works', tests: [['warm cache'], ['level 3']] },
  { item: 'execution monitoring works', tests: [['struggle'], ['signals']] },
  { item: 'failure taxonomy works', tests: [['environment_failure'], ['model_weakness']] },
  { item: 'escalation works', tests: [['escalates vertically'], ['succeeds on the second model']] },
  {
    // The tests call it a "sideways move"; the checklist calls it horizontal.
    item: 'horizontal escalation works',
    tests: [['prefers a sideways move'], ['does not move sideways for a marginal difference']],
  },
  { item: 'human clarification works', tests: [['surfaces a question for the user']] },
  { item: 'context handoff works', tests: [['compact briefing']] },
  { item: 'telemetry works', tests: [['persists and reloads']] },
  {
    item: 'privacy redaction works',
    tests: [
      ['keeps no absolute path in the database file'],
      ['stores no absolute path from an event'],
      ['redacts a key pasted into the prompt'],
    ],
  },
  {
    item: 'learning can be disabled',
    tests: [['learning disabled'], ['no-op when learning is disabled']],
  },
  {
    item: 'learned policy works when enabled',
    tests: [['history changes the route'], ['acceptance']],
  },
  { item: 'calibration works', tests: [['trusted'], ['withdrawn']] },
  { item: 'shadow routing works', tests: [['predicts without executing'], ['never executes']] },
  {
    item: 'no fake training counts',
    tests: [['sample counts are real counts'], ['pseudo-observations']],
  },
  {
    item: 'no automatic commits',
    static: () =>
      sourceCheck(
        'no git write command in shipping code',
        /['"](commit|add|push|reset --hard|checkout)['"][\s\S]{0,40}\)/,
        { paths: ['src/infra'] },
      ),
  },
  {
    item: 'no infinite retries',
    tests: [
      ['does not escalate endlessly'],
      ['stops once the escalation limit is reached'],
      ['stops retrying at the attempt limit'],
      ['repeatedly deciding never loops forever'],
    ],
  },
  {
    item: 'no secret leakage',
    tests: [
      ['nothing user-facing carries a secret'],
      ['no chat reply carries a secret'],
      ['no secrets are stored'],
    ],
  },
  {
    item: 'Claude Code adapter tested',
    verdict: 'CANNOT VERIFY',
    note: 'availability and version detection confirmed against a real install; execution has never been run. `npm run verify:adapters -- claude-code`, from a plain terminal',
  },
  {
    item: 'Cursor adapter tested',
    verdict: 'CANNOT VERIFY',
    note: '`cursor-agent` is not installed on this machine, so nothing has been confirmed — not even availability',
  },
  {
    item: 'VS Code extension tested',
    verdict: 'PARTIAL',
    note: '19/19 checks against a fake VS Code host; never opened in real VS Code (docs/EXTENSION.md)',
  },
];

console.log('\nCHECKLIST\n');

let passed = 0;
let partial = 0;
let unverifiable = 0;
let broken = 0;

for (const entry of CHECKLIST) {
  let evidence = '';
  let status = entry.verdict ?? 'PASS';

  if (entry.static !== undefined) {
    const result = entry.static();
    evidence = result.detail;
    if (!result.ok) status = 'BROKEN';
  } else if (entry.tests !== undefined) {
    let total = 0;
    let failing = 0;
    let missing = 0;

    for (const needles of entry.tests) {
      const found = matching(...needles);
      if (found.length === 0) missing += 1;
      total += found.length;
      failing += found.filter((test) => test.status !== 'passed').length;
    }

    evidence = `${String(total)} test(s)`;
    // Evidence that has vanished is louder than a silent pass: a renamed or
    // deleted test must not leave an item quietly ticked.
    if (missing > 0) {
      status = 'BROKEN';
      evidence = `evidence missing for ${String(missing)} of ${String(entry.tests.length)} probes`;
    } else if (failing > 0) {
      status = 'BROKEN';
      evidence = `${String(failing)} failing`;
    }
  }

  const label =
    status === 'PASS'
      ? ok('[x] PASS         ')
      : status === 'PARTIAL'
        ? warn('[~] PARTIAL      ')
        : status === 'CANNOT VERIFY'
          ? warn('[ ] CANNOT VERIFY')
          : bad('[!] BROKEN       ');

  console.log(`  ${label} ${entry.item}`);
  if (evidence !== '') console.log(`                    ${evidence}`);
  if (entry.note !== undefined) console.log(`                    ${entry.note}`);

  if (status === 'PASS') passed += 1;
  else if (status === 'PARTIAL') partial += 1;
  else if (status === 'CANNOT VERIFY') unverifiable += 1;
  else broken += 1;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const gatesFailed = gates.filter((entry) => !entry.ok);

console.log('\nVERDICT\n');
console.log(
  `  gates:      ${String(gates.length - gatesFailed.length)}/${String(gates.length)} passing`,
);
console.log(
  `  checklist:  ${String(passed)} pass, ${String(partial)} partial, ${String(unverifiable)} cannot verify, ${String(broken)} broken`,
);

if (broken > 0 || gatesFailed.length > 0) {
  console.log(`\n  ${bad('NOT READY')} — a gate failed or a checklist item lost its evidence.`);
  process.exit(1);
}

console.log(
  `\n  ${warn('READY, WITH STATED LIMITS')} — every gate passes and every checklist item is\n` +
    '  either proven or explicitly unproven. RoutePilot routes; it has never\n' +
    '  executed against a real model, and nothing here claims otherwise.',
);
process.exit(0);
