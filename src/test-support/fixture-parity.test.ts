/**
 * The two fixture repositories must stay identical.
 *
 * `src/test-support/agent-fixture-repo.ts` is what the unit tests drive;
 * `scripts/lib/fixture-repo.mjs` is what the verification scripts drive,
 * duplicated because `test-support` is excluded from the published build
 * (`tsconfig.build.json`) and so is absent from `dist/`.
 *
 * Duplication is the price of that exclusion. Drift is not: if the adapter
 * check and the loop check ran against different workspaces, their results
 * would not be comparable, and a defect fixed in one copy would silently
 * survive in the other. This holds them together.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createAgentFixtureRepo, FIXTURE_DEFECT } from './agent-fixture-repo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The half of the script-side module these tests use. */
interface ScriptFixtureModule {
  readonly FIXTURE_DEFECT: string;
  readonly createFixtureRepo: (options?: { withoutTestScript?: boolean }) => Promise<{
    readonly dir: string;
    readonly read: (relative: string) => Promise<string | null>;
    readonly testsPass: () => Promise<boolean>;
    readonly cleanup: () => Promise<void>;
  }>;
}

/**
 * Load the script-side copy, which is plain ESM and needs no build.
 *
 * Typed by hand rather than with `typeof import(...)`: the module is JavaScript
 * with no declaration file, so the compiler would infer `any` and this guard
 * would stop checking the very shapes it exists to compare.
 */
async function scriptFixture(): Promise<ScriptFixtureModule> {
  return (await import(
    /* @vite-ignore */ pathToFileURL(join(root, 'scripts', 'lib', 'fixture-repo.mjs')).href
  )) as ScriptFixtureModule;
}

describe('the two fixture repositories agree', () => {
  it('produce byte-identical files', async () => {
    const { createFixtureRepo } = await scriptFixture();

    const typescript = await createAgentFixtureRepo();
    const script = await createFixtureRepo();

    try {
      for (const file of ['package.json', 'src/calculator.mjs', 'test.mjs']) {
        expect(await script.read(file), `${file} differs between the two copies`).toBe(
          await typescript.read(file),
        );
      }
    } finally {
      await typescript.cleanup();
      await script.cleanup();
    }
  });

  it('agree on the variant with no test script', async () => {
    const { createFixtureRepo } = await scriptFixture();

    const typescript = await createAgentFixtureRepo({ withoutTestScript: true });
    const script = await createFixtureRepo({ withoutTestScript: true });

    try {
      expect(await script.read('package.json')).toBe(await typescript.read('package.json'));
      // And the variant genuinely differs from the default, or the option does
      // nothing and both assertions above would pass vacuously.
      const withScript = await createAgentFixtureRepo();
      expect(await typescript.read('package.json')).not.toBe(await withScript.read('package.json'));
      await withScript.cleanup();
    } finally {
      await typescript.cleanup();
      await script.cleanup();
    }
  });

  it('describe the same defect', async () => {
    const { FIXTURE_DEFECT: scriptDefect } = await scriptFixture();
    expect(scriptDefect).toBe(FIXTURE_DEFECT);
  });

  it('both start with a failing test', async () => {
    // The property everything else rests on. A fixture that passed on arrival
    // would make every task built on it succeed without the agent doing
    // anything.
    const { createFixtureRepo } = await scriptFixture();
    const script = await createFixtureRepo();

    try {
      expect(await script.testsPass()).toBe(false);
    } finally {
      await script.cleanup();
    }
  });

  it('the verification scripts do not carry a third copy', async () => {
    // `verify-agent-tasks.mjs` had its own inline fixture before this was
    // extracted. A third copy would defeat the parity guard above, so it is
    // asserted gone rather than remembered.
    const source = await readFile(join(root, 'scripts', 'verify-agent-tasks.mjs'), 'utf8');
    expect(source).not.toContain('const FIXTURE_FILES');
  });
});
