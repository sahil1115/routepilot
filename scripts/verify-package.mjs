#!/usr/bin/env node
/**
 * Prove the extension package can stand on its own.
 *
 * A `.vsix` is a self-contained archive installed to a directory with no
 * ancestor `node_modules`. Inside the repository every runtime dependency
 * resolves anyway, because Node walks up and finds the root `node_modules` —
 * so a package missing its own copy of a dependency works perfectly on the
 * machine that built it and crashes on every machine that installs it.
 *
 * That is exactly what happened: `zod` was declared in `extension/package.json`
 * but nothing ever installed it into `extension/node_modules`, so the packaged
 * extension resolved `zod` from the repository root and would have failed with
 * `Cannot find package 'zod'` the first time a user opened it.
 *
 * ## How this checks it
 *
 * Not by putting the files somewhere isolated and hoping: a temporary directory
 * can itself sit under an ancestor `node_modules` (this machine has one at
 * `C:\Users\<name>\node_modules`), and the check would then pass for the wrong
 * reason. Instead it resolves each declared dependency the way Node will and
 * asserts **where the resolution lands**. A copy inside `extension/` is
 * self-contained; anything outside it is borrowed and will not ship.
 *
 * Run by `npm run verify:extension` and `npm run package:extension`.
 * Exit code 0 means the package is self-contained.
 */

import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extension = join(root, 'extension');

/** Files `.vscodeignore` keeps, which is what a `.vsix` actually contains. */
const SHIPPED = ['out', 'dist', 'node_modules', 'package.json'];

/**
 * Entry points the extension loads at runtime.
 *
 * `config/load.js` is the one that pulls in `zod`; the others are listed
 * because a dependency added to any of them would fail the same way and should
 * fail here first.
 */
const ENTRY_POINTS = [
  'dist/config/load.js',
  'dist/cli/route.js',
  'dist/cli/analyze.js',
  'dist/extension/index.js',
  'dist/telemetry/open.js',
  'dist/infra/node-filesystem.js',
  'dist/infra/node-git.js',
];

const problems = [];
const note = (message) => process.stdout.write(`  ${message}\n`);

/** Whether `candidate` lives inside `parent`. */
const inside = (parent, candidate) => {
  const rel = relative(parent, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

process.stdout.write('\nVerifying the extension package is self-contained\n\n');

// ---------------------------------------------------------------------------
// 1. Everything that must ship, ships.
// ---------------------------------------------------------------------------

for (const entry of SHIPPED) {
  if ((await stat(join(extension, entry)).catch(() => null)) === null) {
    problems.push(`extension/${entry} is missing — run "npm run build:extension"`);
  }
}

// ---------------------------------------------------------------------------
// 2. The decisive check: every declared runtime dependency resolves to a copy
//    inside the package, not to one borrowed from an ancestor.
// ---------------------------------------------------------------------------

const manifest = JSON.parse(await readFile(join(extension, 'package.json'), 'utf8'));
const declared = Object.keys(manifest.dependencies ?? {});
note(`declared runtime dependencies: ${declared.length === 0 ? 'none' : declared.join(', ')}`);

// Resolved from the deepest shipped file, because that is the position Node
// resolves from at runtime and the one with the most ancestors to borrow from.
const resolveFrom = createRequire(join(extension, 'dist', 'config', 'load.js'));

for (const name of declared) {
  let resolved;
  try {
    resolved = resolveFrom.resolve(name);
  } catch {
    problems.push(
      `"${name}" is declared in extension/package.json and cannot be resolved at all — ` +
        'run "npm run build:extension"',
    );
    continue;
  }

  if (inside(extension, resolved)) {
    note(`${name} -> ${relative(extension, resolved)} (inside the package)`);
  } else {
    problems.push(
      `"${name}" resolves to ${resolved}, which is outside extension/. ` +
        'It works here only because Node walks up into the repository; the .vsix ' +
        'would ship without it and fail on install.',
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Smoke test: the shipped core actually loads.
//
// Weaker than the check above — a copy placed in the sandbox can still borrow
// from an ancestor — so it proves the build is loadable, not that it is
// self-contained. Both matter.
// ---------------------------------------------------------------------------

const sandbox = await mkdtemp(join(tmpdir(), 'routepilot-vsix-'));
const installed = join(sandbox, 'publisher.routepilot-0.0.0');

try {
  for (const entry of SHIPPED) {
    await cp(join(extension, entry), join(installed, entry), { recursive: true }).catch(() => {
      // Absence is already reported above when it matters.
    });
  }

  for (const entry of ENTRY_POINTS) {
    const target = join(installed, entry);
    if ((await stat(target).catch(() => null)) === null) {
      problems.push(`${entry} is not in the package`);
      continue;
    }
    try {
      await import(pathToFileURL(target).href);
    } catch (error) {
      problems.push(`${entry} cannot load when installed: ${describe(error)}`);
    }
  }

  note(`loaded ${String(ENTRY_POINTS.length)} entry point(s) from a copy of the package`);
} finally {
  await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

report();

function describe(error) {
  if (error instanceof Error) {
    const code = 'code' in error && error.code ? ` (${String(error.code)})` : '';
    return `${error.message.split('\n')[0]}${code}`;
  }
  return String(error);
}

function report() {
  if (problems.length === 0) {
    process.stdout.write('\n  PASS  the extension package is self-contained\n\n');
    process.exit(0);
  }

  process.stdout.write('\n  FAIL  the extension package is NOT self-contained\n\n');
  for (const problem of problems) process.stdout.write(`    - ${problem}\n`);
  process.stdout.write(
    '\n  Fix: "npm run build:extension" installs the extension\'s own dependencies.\n' +
      '  Inside the repository a missing one still resolves from the root\n' +
      '  node_modules, which is why resolution has to be checked by location.\n\n',
  );
  process.exit(1);
}
