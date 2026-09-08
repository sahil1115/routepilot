/**
 * The throwaway repository the verification scripts drive a real agent against.
 *
 * Duplicated from `src/test-support/agent-fixture-repo.ts` rather than imported:
 * that module is excluded from the published build (`tsconfig.build.json`), so
 * `dist/` does not contain it. Keeping it here means the verification scripts
 * run against a plain `npm run build`.
 *
 * The two copies must agree, because a fixture that differed between the
 * adapter check and the loop check would make their results incomparable.
 * `src/test-support/agent-fixture-repo.test.ts` holds the TypeScript side;
 * `scripts/lib/fixture-repo.test.mjs`-style coverage is not worth a runner, so
 * the shape is asserted by `fixture-parity.test.ts` instead.
 *
 * A real agent gets write access to whatever this creates, so it is built to be
 * worth nothing: under the system temp directory, no credentials, no network,
 * and a self-contained Node test runner that needs no install.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The manifest, with or without a script for validation to find. */
function manifest(withTestScript) {
  return `${JSON.stringify(
    {
      name: 'routepilot-agent-fixture',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: withTestScript ? { test: 'node test.mjs' } : {},
    },
    null,
    2,
  )}\n`;
}

const SOURCE =
  '/** Add two numbers. */\n' +
  'export function add(a, b) {\n' +
  '  // Deliberately wrong: this is the defect a fixture task asks an agent to fix.\n' +
  '  return a - b;\n' +
  '}\n\n' +
  '/** Multiply two numbers. */\n' +
  'export function multiply(a, b) {\n' +
  '  return a * b;\n' +
  '}\n';

const TEST =
  "import assert from 'node:assert/strict';\n" +
  "import { add, multiply } from './src/calculator.mjs';\n\n" +
  "assert.equal(add(2, 3), 5, 'add(2, 3) should be 5');\n" +
  "assert.equal(multiply(2, 3), 6, 'multiply(2, 3) should be 6');\n\n" +
  "console.log('all tests passed');\n";

const README =
  '# Fixture repository\n\nA throwaway workspace for verifying RoutePilot.\n' +
  'It contains one deliberate defect in `src/calculator.mjs`. Nothing here is real.\n';

/** The defect the fixture ships with, for a task to describe. */
export const FIXTURE_DEFECT =
  'src/calculator.mjs exports add(a, b) which returns a - b instead of a + b';

/**
 * Create the fixture in a fresh temporary directory.
 *
 * `withoutTestScript` produces a workspace RoutePilot cannot validate: it
 * derives its checks from the manifest's scripts, and this one declares none.
 * `test.mjs` is still written, so the caller can tell whether the agent did the
 * work even though RoutePilot could not.
 */
export async function createFixtureRepo(options = {}) {
  const withTestScript = options.withoutTestScript !== true;
  const dir = join(
    tmpdir(),
    `routepilot-fixture-${String(process.pid)}-${String(Date.now())}-${String(
      Math.floor(Math.random() * 1e6),
    )}`,
  );

  const files = {
    'package.json': manifest(withTestScript),
    'src/calculator.mjs': SOURCE,
    'test.mjs': TEST,
    'README.md': README,
  };

  for (const [relative, contents] of Object.entries(files)) {
    const path = join(dir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }

  return {
    dir,

    read(relative) {
      return readFile(join(dir, relative), 'utf8').catch(() => null);
    },

    /** Run the fixture's own test, directly. No install, no npm shim. */
    async testsPass() {
      try {
        await run(process.execPath, ['test.mjs'], { cwd: dir, timeout: 60_000, shell: false });
        return true;
      } catch {
        return false;
      }
    },

    /** Best-effort: an agent can hold a handle briefly after it exits. */
    async cleanup() {
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(
        () => undefined,
      );
    },
  };
}
