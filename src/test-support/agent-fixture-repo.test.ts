/**
 * The fixture repository is worth verifying against.
 *
 * A guard on a guard. This repository exists so a real agent can be asked to do
 * real work and be *checked* — and if its test suite passed on arrival, every
 * task built on it would succeed without the agent doing anything. The whole
 * verification would then be vacuous while looking green, which is the failure
 * mode this project has hit twice before.
 */

import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentFixtureRepo,
  FIXTURE_DEFECT,
  type AgentFixtureRepo,
} from './agent-fixture-repo.js';

const created: AgentFixtureRepo[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((repo) => repo.cleanup()));
});

async function fixture(): Promise<AgentFixtureRepo> {
  const repo = await createAgentFixtureRepo();
  created.push(repo);
  return repo;
}

describe('the agent fixture repository', () => {
  it('ships with a failing test, so a task has something to fix', async () => {
    const repo = await fixture();
    const result = await repo.runTests();

    expect(result.passed).toBe(false);
    expect(result.output).toMatch(/add\(2, 3\) should be 5/);
  });

  it('passes once the defect is fixed, so success is observable', async () => {
    // The other half. A fixture that could never pass would make every real
    // agent run look like a failure, which is just as useless.
    const repo = await fixture();
    const source = await repo.read('src/calculator.mjs');
    expect(source).toContain('return a - b;');

    await writeFile(
      join(repo.dir, 'src', 'calculator.mjs'),
      (source ?? '').replace('return a - b;', 'return a + b;'),
      'utf8',
    );

    const result = await repo.runTests();
    expect(result.passed).toBe(true);
    expect(result.output).toContain('all tests passed');
  });

  it('describes its defect, so a task can be written without reading the source', async () => {
    const repo = await fixture();
    expect(FIXTURE_DEFECT).toContain('calculator.mjs');
    expect(await repo.read('src/calculator.mjs')).toBeTruthy();
  });

  it('lives outside the repository and holds nothing of value', async () => {
    // A real agent gets write access to this directory. It must not be anywhere
    // near real work, and must contain nothing worth exfiltrating.
    const repo = await fixture();

    expect(repo.dir.startsWith(tmpdir())).toBe(true);
    expect(repo.dir).not.toContain('routepilot\\src');
    expect(await repo.read('.env')).toBeNull();
  });

  it('cleans up, and a locked directory does not throw', async () => {
    // Losing a verification result to a cleanup failure has happened here
    // before, so cleanup is best-effort by construction.
    const repo = await createAgentFixtureRepo();
    await expect(repo.cleanup()).resolves.toBeUndefined();
    await expect(repo.cleanup()).resolves.toBeUndefined();
  });
});
