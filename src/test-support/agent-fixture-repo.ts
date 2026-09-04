/**
 * A throwaway repository for real agent runs.
 *
 * Scripted tests -- `ScriptedExecutor` and `stub-cli.ts` -- prove RoutePilot
 * handles the shapes it was told to expect. They cannot prove those are the
 * shapes a real agent produces when asked to do actual work.
 *
 * This is a real directory with a real failing test, so an agent can be asked
 * to fix something and the result checked by running the test rather than by
 * taking the agent's word for it.
 *
 * A real agent gets write access to whatever directory it is pointed at, so
 * this one is built to be worth nothing: created under the system temp
 * directory, never inside a real repository; no network, no credentials, no
 * `.env`; a self-contained Node test runner needing no install; and deleted
 * afterwards, best-effort, so a locked file cannot fail a verification that
 * already succeeded.
 */

import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A fixture repository on disk. */
export interface AgentFixtureRepo {
  readonly dir: string;
  /** Read a file back, to see what the agent actually did. */
  read(relativePath: string): Promise<string | null>;
  /** Run the fixture's own test script. Resolves with whether it passed. */
  runTests(): Promise<{ passed: boolean; output: string }>;
  cleanup(): Promise<void>;
}

/**
 * The failing test every task builds on.
 *
 * `add` returns the wrong answer. It is a small, unambiguous defect: an agent
 * either fixes it or does not, and `runTests` says which without anyone reading
 * a transcript.
 */
const FILES: Readonly<Record<string, string>> = {
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

  'src/calculator.mjs': `/** Add two numbers. */
export function add(a, b) {
  // Deliberately wrong: this is the defect a fixture task asks an agent to fix.
  return a - b;
}

/** Multiply two numbers. */
export function multiply(a, b) {
  return a * b;
}
`,

  'test.mjs': `import assert from 'node:assert/strict';
import { add, multiply } from './src/calculator.mjs';

assert.equal(add(2, 3), 5, 'add(2, 3) should be 5');
assert.equal(multiply(2, 3), 6, 'multiply(2, 3) should be 6');

console.log('all tests passed');
`,

  'README.md': `# Fixture repository

A throwaway workspace used to verify RoutePilot's agent adapters against real
tools. It contains one deliberate defect in \`src/calculator.mjs\`.

Nothing here is real. Do not add credentials or anything of value.
`,
};

/** Create the fixture in a fresh temporary directory. */
export async function createAgentFixtureRepo(): Promise<AgentFixtureRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'routepilot-fixture-'));

  for (const [relativePath, contents] of Object.entries(FILES)) {
    const target = join(dir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }

  return {
    dir,

    async read(relativePath: string): Promise<string | null> {
      return readFile(join(dir, relativePath), 'utf8').catch(() => null);
    },

    async runTests(): Promise<{ passed: boolean; output: string }> {
      // `node test.mjs` directly rather than `npm test`: no install, no
      // lockfile, and on Windows no `.cmd` shim that `execFile` cannot launch.
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);

      try {
        const { stdout, stderr } = await run(process.execPath, ['test.mjs'], {
          cwd: dir,
          timeout: 60_000,
          shell: false,
        });
        return { passed: true, output: `${stdout}${stderr}`.trim() };
      } catch (error) {
        const detail = error as { stdout?: string; stderr?: string; message?: string };
        return {
          passed: false,
          output: `${detail.stdout ?? ''}${detail.stderr ?? ''}`.trim() || (detail.message ?? ''),
        };
      }
    },

    async cleanup(): Promise<void> {
      // Best-effort, and never fatal. An agent's process can hold a handle for a
      // moment after it exits, and losing a verification result to a locked
      // temporary directory has happened here before.
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(
        () => undefined,
      );
    },
  };
}

/** The defect the fixture ships with, for a task to describe. */
export const FIXTURE_DEFECT =
  'src/calculator.mjs exports add(a, b) which returns a - b instead of a + b';
