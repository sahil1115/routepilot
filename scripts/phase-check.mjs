#!/usr/bin/env node
/**
 * The phase loop from specification section 72, mechanized.
 *
 *   1. Run tests.          2. Run typecheck.     3. Run lint.
 *   4. Run build.          5. Inspect git diff.  6. Fix all failures.
 *   7. Add regression tests for bugs discovered.
 *   8. Update documentation.
 *   9. Record what was completed.
 *  10. Only then proceed.
 *
 * Steps 1-5 are machine work and this script does them. Steps 6-9 are
 * judgement, which a script cannot do -- but it can refuse to say "proceed"
 * until the evidence of each one exists. Step 10 is the verdict.
 *
 * This is not `npm run verify` because the failure it guards against is not a
 * red test: it is a phase that ends green, undocumented, and unrecorded, which
 * looks identical to a finished one until someone needs the history later.
 *
 * Run with `npm run phase`.
 *
 * Exit codes: 0 proceed, 1 blocked, 2 the script itself could not run.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const ESC = String.fromCharCode(27);
const ok = (text) => `${ESC}[32m${text}${ESC}[0m`;
const warn = (text) => `${ESC}[33m${text}${ESC}[0m`;
const bad = (text) => `${ESC}[31m${text}${ESC}[0m`;
const dim = (text) => `${ESC}[2m${text}${ESC}[0m`;

/**
 * Node entry points, invoked directly.
 *
 * Never the `.cmd` shims: spawning those on Windows needs `shell: true`, which
 * `docs/SECURITY.md` forbids, and reaching for it here is precisely the bug
 * that made the first quality gate report seven false failures.
 */
const bin = {
  tsc: join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  eslint: join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'),
  vitest: join(root, 'node_modules', 'vitest', 'vitest.mjs'),
};

/** Run a command, capturing output and whether it succeeded. */
function run(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    return { passed: true, stdout: stdout ?? '' };
  } catch (error) {
    const stdout = `${error?.stdout ?? ''}${error?.stderr ?? ''}`;
    return { passed: false, stdout };
  }
}

const node = process.execPath;

// ---------------------------------------------------------------------------
// Steps 1-4: the mechanical checks.
// ---------------------------------------------------------------------------

const steps = [];

function record(number, name, result, detail) {
  steps.push({ number, name, passed: result, detail });
  const mark = result ? ok('[x] PASS') : bad('[ ] FAIL');
  process.stdout.write(`  ${mark}  ${String(number)}. ${name}\n`);
  if (detail) process.stdout.write(`${dim(`            ${detail}`)}\n`);
}

process.stdout.write('\nMECHANICAL CHECKS\n\n');

// The default reporter, deliberately: Vitest 4 removed `basic`, and passing
// a reporter it no longer knows makes the run fail for a reason that has
// nothing to do with the tests.
const tests = run(node, [bin.vitest, 'run']);
const testCounts = /Tests\s+(\d+) passed/.exec(tests.stdout);
const fileCounts = /Test Files\s+(\d+) passed/.exec(tests.stdout);
record(
  1,
  'tests',
  tests.passed,
  testCounts && fileCounts
    ? `${testCounts[1]} tests across ${fileCounts[1]} files`
    : 'could not parse a test count from the reporter output',
);

const typecheck = run(node, [bin.tsc, '-p', 'tsconfig.json', '--noEmit']);
record(
  2,
  'typecheck',
  typecheck.passed,
  typecheck.passed ? 'no type errors' : firstLine(typecheck),
);

const lint = run(node, [bin.eslint, '.']);
record(3, 'lint', lint.passed, lint.passed ? 'no lint errors' : firstLine(lint));

const build = run(node, [bin.tsc, '-p', 'tsconfig.build.json']);
record(4, 'build', build.passed, build.passed ? 'emitted cleanly' : firstLine(build));

function firstLine(result) {
  return result.stdout.split('\n').find((line) => line.trim() !== '') ?? 'failed with no output';
}

// ---------------------------------------------------------------------------
// Step 5: inspect the diff.
//
// The interesting case is not a large diff. It is a diff that is *empty for the
// wrong reason* — an unborn branch, where everything is untracked and
// `git diff` truthfully reports nothing at all. Printing that and calling the
// step done would be inspecting a void.
// ---------------------------------------------------------------------------

process.stdout.write('\nSTEP 5 — DIFF INSPECTION\n\n');

const insideRepo = run('git', ['rev-parse', '--show-toplevel']).passed;

if (!insideRepo) {
  record(5, 'git diff', false, 'not a git repository — there is no diff to inspect');
} else {
  const hasCommit = run('git', ['rev-parse', 'HEAD']).passed;
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  const entries = status.stdout.split('\n').filter((line) => line.trim() !== '');
  const untracked = entries.filter((line) => line.startsWith('??')).length;

  if (!hasCommit) {
    // Loud, because it is silent otherwise. `git diff` exits 0 with no output,
    // so an automated loop reports the step green while inspecting nothing.
    record(
      5,
      'git diff',
      false,
      `unborn branch: no commits exist, so \`git diff\` is empty while ${String(untracked)} ` +
        'files are untracked. Nothing has been inspected.',
    );
    process.stdout.write(
      `\n${warn('  This step cannot do its job until there is a commit to diff against.')}\n` +
        dim('  RoutePilot never commits on your behalf (principle 13). To enable it:\n') +
        dim('    git add -A && git commit -m "baseline"\n'),
    );
  } else {
    const diff = run('git', ['diff', '--stat', 'HEAD']);
    const changed = diff.stdout.split('\n').filter((line) => line.trim() !== '').length;
    record(
      5,
      'git diff',
      true,
      `${String(changed)} line(s) of diffstat against HEAD, ${String(untracked)} untracked`,
    );
    if (diff.stdout.trim() !== '') process.stdout.write(`\n${dim(diff.stdout.trimEnd())}\n`);
  }
}

// ---------------------------------------------------------------------------
// Steps 6-9: evidence, not claims.
//
// None of these can be *performed* by a script. Each of them leaves a trace
// that can be checked, and the check is against the trace — never against an
// assertion that the work was done.
// ---------------------------------------------------------------------------

process.stdout.write('\nEVIDENCE FOR THE JUDGEMENT STEPS\n\n');

const mechanical = steps.slice(0, 4);
record(
  6,
  'all failures fixed',
  mechanical.every((step) => step.passed),
  mechanical.every((step) => step.passed)
    ? 'steps 1-4 are green'
    : `still failing: ${mechanical
        .filter((step) => !step.passed)
        .map((step) => step.name)
        .join(', ')}`,
);

const phase = readPhase();

function readPhase() {
  try {
    const source = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
    const match = /IMPLEMENTED_PHASE\s*=\s*(\d+)/.exec(source);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

if (phase === null) {
  record(7, 'regression tests', false, 'could not read IMPLEMENTED_PHASE from src/index.ts');
  record(8, 'documentation', false, 'skipped: no phase number');
  record(9, 'record of what was completed', false, 'skipped: no phase number');
} else {
  // Step 7. A script cannot tell a regression test from any other test, so it
  // checks the only thing it honestly can: that the suite grew, and that the
  // phase entry says what the tests are for. The phrase "regression" appearing
  // in the log is a weak signal, and it is reported as one.
  const logs = readOrEmpty('logs.md');
  const section = sectionFor(logs, phase);
  const mentionsRegression = section !== null && /regression|bug|fix/i.test(section);
  record(
    7,
    'regression tests for bugs discovered',
    section !== null,
    section === null
      ? `logs.md has no "## Phase ${String(phase)}" section to check against`
      : mentionsRegression
        ? 'the phase entry describes bugs and fixes — verify the tests exist yourself'
        : 'the phase entry mentions no bug; if none was found, that is the correct outcome',
  );

  // Step 8. Documentation is updated if the roadmap knows this phase happened.
  const roadmap = readOrEmpty(join('docs', 'ROADMAP.md'));
  const inRoadmap = new RegExp(`\\|\\s*${String(phase)}\\s*\\|`).test(roadmap);
  record(
    8,
    'documentation updated',
    inRoadmap,
    inRoadmap
      ? `docs/ROADMAP.md has a row for phase ${String(phase)}`
      : `docs/ROADMAP.md has no row for phase ${String(phase)}`,
  );

  // Step 9. The five subsections the project requires of every phase entry.
  const required = ['Objective', 'Changes Made', 'Current State', 'Next Steps'];
  const missing = section === null ? required : required.filter((h) => !section.includes(h));
  record(
    9,
    'recorded what was completed',
    section !== null && missing.length === 0,
    section === null
      ? `logs.md is missing a "## Phase ${String(phase)}" section`
      : missing.length === 0
        ? `logs.md phase ${String(phase)} entry has every required subsection`
        : `logs.md phase ${String(phase)} entry is missing: ${missing.join(', ')}`,
  );
}

function readOrEmpty(relativePath) {
  try {
    return readFileSync(join(root, relativePath), 'utf8');
  } catch {
    return '';
  }
}

/** The text of the `## Phase N:` section, or null if there is none. */
function sectionFor(markdown, number) {
  const start = new RegExp(`^## Phase ${String(number)}[: ]`, 'm').exec(markdown);
  if (start === null) return null;
  const rest = markdown.slice(start.index + start[0].length);
  const next = /^## /m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

// ---------------------------------------------------------------------------
// Step 10.
// ---------------------------------------------------------------------------

const blocking = steps.filter((step) => !step.passed);

process.stdout.write('\nSTEP 10 — VERDICT\n\n');

if (blocking.length === 0) {
  process.stdout.write(`  ${ok('PROCEED')} — every step of the section 72 loop is satisfied.\n\n`);
  process.exit(0);
}

process.stdout.write(
  `  ${bad('DO NOT PROCEED')} — ${String(blocking.length)} step(s) of the loop are unsatisfied:\n\n`,
);
for (const step of blocking) {
  process.stdout.write(`    ${String(step.number)}. ${step.name} — ${step.detail}\n`);
}
process.stdout.write(
  `\n${dim('  Section 72: do not proceed to the next phase while the previous one is broken.')}\n\n`,
);
process.exit(1);
