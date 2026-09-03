/**
 * NodeGit tests.
 *
 * The porcelain parsers are unit-tested against captured output. `getState` is
 * then exercised against a **real git repository** created in a temp directory,
 * because parsing git output correctly and actually invoking git correctly are
 * different claims, and only the second one proves the integration works
 * (spec section 2, rule 20).
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { NodeGit, parseNumstat, parseStatus } from './node-git.js';

const run = promisify(execFile);

let gitAvailable = false;

beforeAll(async () => {
  try {
    await run('git', ['--version'], { shell: false });
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
});

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'routepilot-git-'));
  dirs.push(dir);

  const git = (args: string[]) => run('git', args, { cwd: dir, shell: false });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await git(['config', 'user.name', 'RoutePilot Test']);
  await git(['config', 'commit.gpgsign', 'false']);

  await writeFile(join(dir, 'a.txt'), 'one\n', 'utf8');
  await writeFile(join(dir, 'b.txt'), 'two\n', 'utf8');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);

  return dir;
}

describe('parseStatus', () => {
  it('parses modified, added, deleted and untracked entries', () => {
    const output = [' M src/a.ts', 'A  src/new.ts', ' D src/gone.ts', '?? src/untracked.ts'].join(
      '\n',
    );

    expect(parseStatus(output)).toEqual([
      { path: 'src/a.ts', change: 'modified' },
      { path: 'src/new.ts', change: 'added' },
      { path: 'src/gone.ts', change: 'deleted' },
      { path: 'src/untracked.ts', change: 'untracked' },
    ]);
  });

  it('takes the new path from a rename', () => {
    expect(parseStatus('R  old/name.ts -> new/name.ts')).toEqual([
      { path: 'new/name.ts', change: 'renamed' },
    ]);
  });

  it('normalises separators and strips git quoting', () => {
    expect(parseStatus('?? "src/odd name.ts"')).toEqual([
      { path: 'src/odd name.ts', change: 'untracked' },
    ]);
  });

  it('returns nothing for a clean tree', () => {
    expect(parseStatus('')).toEqual([]);
    expect(parseStatus('\n\n')).toEqual([]);
  });
});

describe('parseNumstat', () => {
  it('totals insertions and deletions', () => {
    expect(parseNumstat('10\t4\tsrc/a.ts\n3\t0\tsrc/b.ts')).toEqual({
      insertions: 13,
      deletions: 4,
    });
  });

  it('ignores binary files, which report dashes', () => {
    expect(parseNumstat('-\t-\timage.png\n5\t2\tsrc/a.ts')).toEqual({
      insertions: 5,
      deletions: 2,
    });
  });

  it('returns zeros for empty output', () => {
    expect(parseNumstat('')).toEqual({ insertions: 0, deletions: 0 });
  });
});

describe('NodeGit against a real repository', () => {
  it('reads branch, HEAD and a clean working tree', async () => {
    if (!gitAvailable) return;

    const root = await makeRepo();
    const state = await new NodeGit().getState(root);

    expect(state.isRepository).toBe(true);
    expect(state.branch).toBe('main');
    expect(state.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(state.changedFiles).toEqual([]);
  });

  it('detects a modification and counts the diff', async () => {
    if (!gitAvailable) return;

    const root = await makeRepo();
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');

    const state = await new NodeGit().getState(root);

    expect(state.changedFiles).toEqual([{ path: 'a.txt', change: 'modified' }]);
    expect(state.insertions).toBe(2);
    expect(state.deletions).toBe(0);
  });

  it('detects an untracked file', async () => {
    if (!gitAvailable) return;

    const root = await makeRepo();
    await writeFile(join(root, 'c.txt'), 'new\n', 'utf8');

    const state = await new NodeGit().getState(root);

    expect(state.changedFiles).toContainEqual({ path: 'c.txt', change: 'untracked' });
  });

  it('reports a path that does not exist without throwing', async () => {
    const state = await new NodeGit().getState(join(tmpdir(), 'routepilot-does-not-exist-xyz'));
    expect(state.isRepository).toBe(false);
  });

  it('scopes status to the analysed subtree, not the whole repository', async () => {
    if (!gitAvailable) return;

    const root = await makeRepo();
    await mkdir(join(root, 'packages', 'inner'), { recursive: true });
    await writeFile(join(root, 'packages', 'inner', 'x.txt'), 'inner\n', 'utf8');
    await writeFile(join(root, 'outside.txt'), 'outside\n', 'utf8');

    const state = await new NodeGit().getState(join(root, 'packages', 'inner'));
    const paths = (state.changedFiles ?? []).map((f) => f.path);

    // Paths are rebased onto the analysed root, and anything outside it is
    // dropped. Without this, analysing one package of a monorepo would report
    // every change in the repository.
    expect(paths).toContain('x.txt');
    expect(paths).not.toContain('outside.txt');
    expect(paths.some((p) => p.startsWith('packages/'))).toBe(false);
  });

  it('survives a directory whose enclosing repository is enormous', async () => {
    // On a machine where the user's home directory is itself a git repository
    // (a common dotfiles setup), every temp directory is "inside a work tree".
    // Scoping the walk with a pathspec is what keeps this fast; without it,
    // git enumerates the whole profile.
    const dir = await mkdtemp(join(tmpdir(), 'routepilot-plain-'));
    dirs.push(dir);

    const started = Date.now();
    const state = await new NodeGit({ timeoutMs: 5_000 }).getState(dir);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    // Whether this reports a repository depends on the machine; what must hold
    // either way is that no unrelated change is attributed to this directory.
    expect(state.changedFiles).toEqual([]);
  });
});
