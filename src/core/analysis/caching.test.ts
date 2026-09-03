/**
 * Cache behaviour and the phase's acceptance criterion.
 *
 * "The same repository should not be fully rescanned unnecessarily" is asserted
 * here against **counted filesystem calls**, not against a cache-hit flag. A hit
 * counter can be wrong; a syscall count cannot.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../../infra/node-filesystem.js';
import {
  CountingFileSystem,
  FakeGit,
  createRepo,
  mediumPythonRepo,
  tinyTypeScriptRepo,
  type FixtureRepo,
} from '../../test-support/repo-fixtures.js';
import { AnalysisCache } from './cache.js';
import { RepositoryAnalyzer } from './repository-analyzer.js';

const cleanups: FixtureRepo[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((repo) => repo.cleanup()));
});

async function setup(files: Record<string, string> = mediumPythonRepo()) {
  const repo = await createRepo(files);
  cleanups.push(repo);

  const fs = new CountingFileSystem(new NodeFileSystem());
  const git = new FakeGit();
  const cache = new AnalysisCache();
  const analyzer = new RepositoryAnalyzer({ fs, git, cache });

  return { repo, fs, git, cache, analyzer };
}

describe('acceptance — an unchanged repository is not rescanned', () => {
  it('performs no directory walking on a repeated identical analysis', async () => {
    const { repo, fs, analyzer } = await setup();

    await analyzer.analyze({ root: repo.root, level: 1 });
    const firstScan = fs.counts;
    expect(firstScan.readDirectory).toBeGreaterThan(0);

    fs.reset();
    const second = await analyzer.analyze({ root: repo.root, level: 1 });

    // The only filesystem work permitted is the fingerprint's manifest stats.
    expect(fs.counts.readDirectory).toBe(0);
    expect(fs.counts.readFile).toBe(0);
    expect(second.cache.hit).toBe(true);
    expect(second.cache.reusedInventory).toBe(true);
    expect(second.cache.computedLevels).toEqual([]);
  });

  it('costs the same to check the cache regardless of repository size', async () => {
    // The property that matters is not a ratio — it is that a cache check is
    // O(1) in the size of the repository while a scan is O(files). A fixed
    // number of manifest stats is the entire cost of a hit.
    const small = await setup(tinyTypeScriptRepo());
    const large = await setup(mediumPythonRepo());

    await small.analyzer.analyze({ root: small.repo.root, level: 2 });
    const smallScan = small.fs.counts.total;
    small.fs.reset();
    await small.analyzer.analyze({ root: small.repo.root, level: 2 });
    const smallCached = small.fs.counts.total;

    await large.analyzer.analyze({ root: large.repo.root, level: 2 });
    const largeScan = large.fs.counts.total;
    large.fs.reset();
    await large.analyzer.analyze({ root: large.repo.root, level: 2 });
    const largeCached = large.fs.counts.total;

    // Scanning the larger repository costs meaningfully more...
    expect(largeScan).toBeGreaterThan(smallScan * 1.5);
    // ...but checking the cache costs exactly the same for both.
    expect(largeCached).toBe(smallCached);
    expect(largeCached).toBeLessThan(largeScan);
  });

  it('returns identical facts from cache', async () => {
    const { repo, analyzer } = await setup();

    const first = await analyzer.analyze({ root: repo.root, level: 2 });
    const second = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(second.level1.fileCount).toBe(first.level1.fileCount);
    expect(second.level1.languages).toEqual(first.level1.languages);
    expect(second.level2?.dependencies).toEqual(first.level2?.dependencies);
  });
});

describe('acceptance — deepening the level reuses earlier work', () => {
  it('does not walk the tree again when going from level 1 to level 2', async () => {
    const { repo, fs, analyzer } = await setup();

    await analyzer.analyze({ root: repo.root, level: 1 });

    fs.reset();
    const deeper = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(fs.counts.readDirectory).toBe(0);
    expect(deeper.cache.reusedInventory).toBe(true);
    expect(deeper.cache.reusedLevels).toContain(1);
    expect(deeper.cache.computedLevels).toEqual([2]);
  });

  it('does not walk the tree again when going from level 2 to level 3', async () => {
    const { repo, fs, analyzer } = await setup();

    await analyzer.analyze({ root: repo.root, level: 2 });

    fs.reset();
    const deeper = await analyzer.analyze({ root: repo.root, level: 3 });

    expect(fs.counts.readDirectory).toBe(0);
    expect(deeper.cache.computedLevels).toEqual([3]);
    expect(deeper.level3).toBeDefined();
  });

  it('keeps deeper facts when a shallower level is later requested', async () => {
    const { repo, analyzer } = await setup();

    await analyzer.analyze({ root: repo.root, level: 3 });
    const shallow = await analyzer.analyze({ root: repo.root, level: 1 });

    // Work already paid for is not thrown away.
    expect(shallow.cache.hit).toBe(true);
    expect(shallow.level1).toBeDefined();
  });
});

describe('cache invalidation', () => {
  it('rebuilds the inventory when a file is added', async () => {
    const { repo, fs, git, analyzer } = await setup(tinyTypeScriptRepo());

    const first = await analyzer.analyze({ root: repo.root, level: 1 });
    expect(first.level1.fileCount).toBe(6);

    await repo.write('src/extra.ts', 'export const extra = 1;\n');
    git.setChanged([{ path: 'src/extra.ts', change: 'untracked' }]);

    fs.reset();
    const second = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(fs.counts.readDirectory).toBeGreaterThan(0);
    expect(second.level1.fileCount).toBe(7);
    expect(second.cache.hit).toBe(false);
    expect(second.cache.invalidatedBy.join(' ')).toContain('added');
  });

  it('rebuilds when a file is deleted', async () => {
    const { repo, git, analyzer } = await setup(tinyTypeScriptRepo());

    await analyzer.analyze({ root: repo.root, level: 1 });

    await repo.remove('src/greet.ts');
    git.setChanged([{ path: 'src/greet.ts', change: 'deleted' }]);

    const second = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(second.level1.fileCount).toBe(5);
    expect(second.cache.reusedInventory).toBe(false);
  });

  it('rebuilds everything when HEAD moves', async () => {
    const { repo, git, analyzer } = await setup();

    await analyzer.analyze({ root: repo.root, level: 2 });
    git.set({ headCommit: 'b'.repeat(40) });

    const second = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(second.cache.reusedInventory).toBe(false);
    expect(second.cache.invalidatedBy.join(' ')).toContain('HEAD');
  });

  it('rebuilds when the branch changes', async () => {
    const { repo, git, analyzer } = await setup();

    await analyzer.analyze({ root: repo.root, level: 1 });
    git.set({ branch: 'feature/other' });

    expect((await analyzer.analyze({ root: repo.root, level: 1 })).cache.hit).toBe(false);
  });
});

describe('cache invalidation is incremental', () => {
  it('keeps the expensive inventory when only existing files are modified', async () => {
    // The core of the "not fully rescanned" requirement: editing a line must
    // not cost a full tree walk of a large repository.
    const { repo, fs, git, analyzer } = await setup();

    const first = await analyzer.analyze({ root: repo.root, level: 1 });
    git.setChanged([{ path: 'app/routes.py', change: 'modified' }]);

    fs.reset();
    const second = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(fs.counts.readDirectory).toBe(0);
    expect(second.cache.reusedInventory).toBe(true);
    expect(second.level1.fileCount).toBe(first.level1.fileCount);
  });

  it('still refreshes the git facts on that modification', async () => {
    const { repo, git, analyzer } = await setup();

    await analyzer.analyze({ root: repo.root, level: 1 });
    git.setChanged([{ path: 'app/routes.py', change: 'modified' }]);
    git.set({ insertions: 12, deletions: 3 });

    const second = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(second.level1.changedFiles).toEqual([{ path: 'app/routes.py', change: 'modified' }]);
    expect(second.level1.git.insertions).toBe(12);
  });

  it('discards level 2 and 3 when file contents change, since they read contents', async () => {
    const { repo, git, analyzer } = await setup();

    await analyzer.analyze({ root: repo.root, level: 3 });
    git.setChanged([{ path: 'app/routes.py', change: 'modified' }]);

    const second = await analyzer.analyze({ root: repo.root, level: 3 });

    expect(second.cache.reusedInventory).toBe(true);
    expect(second.cache.computedLevels).toEqual(expect.arrayContaining([2, 3]));
  });

  it('invalidates dependency facts when a manifest is edited', async () => {
    const { repo, analyzer } = await setup(tinyTypeScriptRepo());

    const first = await analyzer.analyze({ root: repo.root, level: 2 });
    expect(first.level1.frameworks).toContain('express');

    await repo.write(
      'package.json',
      JSON.stringify({ name: 'tiny-ts', dependencies: { fastify: '^4.0.0' } }),
    );

    const second = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(second.level1.frameworks).toContain('fastify');
    expect(second.level1.frameworks).not.toContain('express');
    expect(second.cache.invalidatedBy.join(' ')).toContain('manifest');
  });
});

describe('AnalysisCache', () => {
  it('reports hits and misses', () => {
    const cache = new AnalysisCache();
    expect(cache.get('/nope')).toBeUndefined();
    expect(cache.statistics.misses).toBe(1);
    expect(cache.statistics.hits).toBe(0);
  });

  it('treats path separators and a trailing slash as the same repository', () => {
    // Asserted against the cache itself rather than through the analyzer: a
    // backslash is a legal filename character on Linux, so an analyzer-level
    // test with rewritten separators was testing the filesystem, not the key.
    const cache = new AnalysisCache();
    const entry = {
      fingerprint: {
        headCommit: null,
        branch: null,
        workingTree: '0',
        fileSet: '0',
        manifests: '0',
      },
      inventory: { files: [], directoriesScanned: 0, truncated: false },
      level1: {
        root: '/a',
        fileCount: 0,
        totalBytes: 0,
        truncated: false,
        languages: [],
        primaryLanguage: null,
        packageManager: null,
        frameworks: [],
        isMonorepo: false,
        workspaceCount: 0,
        hasContinuousIntegration: false,
        git: {
          isRepository: false,
          branch: null,
          headCommit: null,
          changedFiles: [],
          insertions: 0,
          deletions: 0,
        },
        changedFiles: [],
      },
    };

    cache.set('/srv/repo', entry);

    expect(cache.get('/srv/repo/')).toBeDefined();
    expect(cache.get('\\srv\\repo')).toBeDefined();
  });

  it('folds case only when told the filesystem does', () => {
    // On Windows and macOS `/srv/App` and `/srv/app` are one directory; on
    // Linux they are two, and folding them would serve one repository's
    // analysis for the other. The cache is told which, and does not guess.
    const entry = {
      fingerprint: {
        headCommit: null,
        branch: null,
        workingTree: '0',
        fileSet: '0',
        manifests: '0',
      },
      inventory: { files: [], directoriesScanned: 0, truncated: false },
      level1: {
        root: '/a',
        fileCount: 0,
        totalBytes: 0,
        truncated: false,
        languages: [],
        primaryLanguage: null,
        packageManager: null,
        frameworks: [],
        isMonorepo: false,
        workspaceCount: 0,
        hasContinuousIntegration: false,
        git: {
          isRepository: false,
          branch: null,
          headCommit: null,
          changedFiles: [],
          insertions: 0,
          deletions: 0,
        },
        changedFiles: [],
      },
    };

    const insensitive = new AnalysisCache({ caseSensitive: false });
    insensitive.set('/srv/App', entry);
    expect(insensitive.get('/srv/app')).toBeDefined();

    const sensitive = new AnalysisCache({ caseSensitive: true });
    sensitive.set('/srv/App', entry);
    expect(sensitive.get('/srv/app')).toBeUndefined();
  });

  it('is case-sensitive by default, because the core has no platform knowledge', () => {
    // The safe default is never to conflate. The CLI decides per platform and
    // passes the answer in; a core that read `process.platform` would be a core
    // that could be wrong about it.
    const entry = {
      fingerprint: {
        headCommit: null,
        branch: null,
        workingTree: '0',
        fileSet: '0',
        manifests: '0',
      },
      inventory: { files: [], directoriesScanned: 0, truncated: false },
      level1: {
        root: '/a',
        fileCount: 0,
        totalBytes: 0,
        truncated: false,
        languages: [],
        primaryLanguage: null,
        packageManager: null,
        frameworks: [],
        isMonorepo: false,
        workspaceCount: 0,
        hasContinuousIntegration: false,
        git: {
          isRepository: false,
          branch: null,
          headCommit: null,
          changedFiles: [],
          insertions: 0,
          deletions: 0,
        },
        changedFiles: [],
      },
    };

    const cache = new AnalysisCache();
    cache.set('/srv/App', entry);
    expect(cache.get('/srv/app')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new AnalysisCache(2);
    const entry = {
      fingerprint: {
        headCommit: null,
        branch: null,
        workingTree: '0',
        fileSet: '0',
        manifests: '0',
      },
      inventory: { files: [], directoriesScanned: 0, truncated: false },
      level1: {
        root: '/a',
        fileCount: 0,
        totalBytes: 0,
        truncated: false,
        languages: [],
        primaryLanguage: null,
        packageManager: null,
        frameworks: [],
        isMonorepo: false,
        workspaceCount: 0,
        hasContinuousIntegration: false,
        git: {
          isRepository: false,
          branch: null,
          headCommit: null,
          changedFiles: [],
          insertions: 0,
          deletions: 0,
        },
        changedFiles: [],
      },
    };

    cache.set('/a', entry);
    cache.set('/b', entry);
    cache.get('/a'); // /a is now the most recently used
    cache.set('/c', entry);

    expect(cache.get('/a')).toBeDefined();
    expect(cache.get('/c')).toBeDefined();
    expect(cache.get('/b')).toBeUndefined();
    expect(cache.statistics.evictions).toBe(1);
  });

  it('can be invalidated and cleared explicitly', async () => {
    const { repo, fs, analyzer, cache } = await setup(tinyTypeScriptRepo());

    await analyzer.analyze({ root: repo.root, level: 1 });
    expect(cache.invalidate(repo.root)).toBe(true);
    expect(cache.invalidate(repo.root)).toBe(false);

    fs.reset();
    const afterInvalidation = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(fs.counts.readDirectory).toBeGreaterThan(0);
    expect(afterInvalidation.cache.hit).toBe(false);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.statistics.hits).toBe(0);
  });

  it('rejects a nonsensical capacity', () => {
    expect(() => new AnalysisCache(0)).toThrow(RangeError);
    expect(() => new AnalysisCache(1.5)).toThrow(RangeError);
  });

  it('keeps separate repositories separate', async () => {
    const first = await setup(tinyTypeScriptRepo());
    const secondRepo = await createRepo(monorepoFiles());
    cleanups.push(secondRepo);

    const a = await first.analyzer.analyze({ root: first.repo.root, level: 1 });
    const b = await first.analyzer.analyze({ root: secondRepo.root, level: 1 });

    expect(a.level1.isMonorepo).toBe(false);
    expect(b.level1.isMonorepo).toBe(true);
    expect(b.cache.hit).toBe(false);
  });
});

function monorepoFiles(): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'packages/a/package.json': '{"name":"a"}',
  };
}
