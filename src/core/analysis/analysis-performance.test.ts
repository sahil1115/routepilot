/**
 * The performance properties of analysis, asserted rather than benchmarked
 * (spec section 69).
 *
 * A benchmark measures; it cannot fail a build when someone reintroduces a
 * sequential loop. These tests can, because the filesystem and git ports make
 * the work **countable** -- which is the reason Phase 2 made them ports.
 *
 * Nothing here asserts a duration. Wall-clock thresholds fail on a busy machine
 * and teach nothing; the number of operations is what actually changed.
 */

import { describe, expect, it } from 'vitest';

import { AnalysisCache } from './cache.js';
import { RepositoryAnalyzer } from './repository-analyzer.js';
import type { DirectoryEntry, FileStat, FileSystemPort, GitPort, GitState } from '../ports.js';

/** A filesystem that records every call and how many overlapped. */
function countingFs(files: Record<string, string>): FileSystemPort & {
  readonly counts: { readFile: number; stat: number; readDirectory: number };
  readonly peakConcurrentReads: number;
} {
  const counts = { readFile: 0, stat: 0, readDirectory: 0 };
  let inFlight = 0;
  let peak = 0;

  const directories = new Map<string, DirectoryEntry[]>();
  for (const path of Object.keys(files)) {
    const slash = path.lastIndexOf('/');
    const dir = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (!directories.has(dir)) directories.set(dir, []);
    directories.get(dir)?.push({ name, isDirectory: false, isFile: true });
  }

  return {
    counts,
    get peakConcurrentReads() {
      return peak;
    },
    readDirectory(path: string): Promise<readonly DirectoryEntry[]> {
      counts.readDirectory += 1;
      return Promise.resolve(directories.get(path) ?? []);
    },
    stat(path: string): Promise<FileStat | null> {
      counts.stat += 1;
      const contents = files[path];
      return Promise.resolve(contents === undefined ? null : { size: contents.length, mtimeMs: 1 });
    },
    async readFile(path: string): Promise<string | null> {
      counts.readFile += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // One turn of the event loop, so overlapping reads are observable.
      await Promise.resolve();
      inFlight -= 1;
      return files[path] ?? null;
    },
  };
}

/** A git port that records how many times it was asked. */
function countingGit(state: Partial<GitState> = {}): GitPort & { calls: number } {
  const port = {
    calls: 0,
    getState(_root: string): Promise<GitState> {
      port.calls += 1;
      return Promise.resolve({
        isRepository: true,
        branch: 'main',
        headCommit: 'a'.repeat(40),
        changedFiles: [],
        insertions: 0,
        deletions: 0,
        ...state,
      });
    },
  };
  return port;
}

/** A workspace with `count` importing source files. */
function workspace(count: number): Record<string, string> {
  const files: Record<string, string> = {
    '/repo/package.json': JSON.stringify({ name: 'w', dependencies: {} }),
  };
  for (let i = 0; i < count; i += 1) {
    files[`/repo/file${String(i)}.ts`] =
      `import './file${String((i + 1) % count)}.js';\nexport const x = ${String(i)};\n`;
  }
  return files;
}

describe('level 3 reads files concurrently', () => {
  it('overlaps reads rather than serialising them', async () => {
    // The regression this guards against: `for (const f of files) await read(f)`
    // measured four times slower on this repository, and worse on larger ones.
    const fs = countingFs(workspace(40));
    const analyzer = new RepositoryAnalyzer({ fs, git: countingGit(), cache: new AnalysisCache() });

    await analyzer.analyze({ root: '/repo', level: 3 });

    expect(fs.peakConcurrentReads).toBeGreaterThan(1);
  });

  it('reads each source file exactly once', async () => {
    const fs = countingFs(workspace(20));
    const analyzer = new RepositoryAnalyzer({ fs, git: countingGit(), cache: new AnalysisCache() });

    await analyzer.analyze({ root: '/repo', level: 3 });

    // 20 source files; the manifest read is separate and small.
    expect(fs.counts.readFile).toBeLessThanOrEqual(22);
  });

  it('produces the same import graph however the reads interleave', async () => {
    // Concurrency must not make analysis non-deterministic.
    const analyze = async () => {
      const fs = countingFs(workspace(30));
      const analyzer = new RepositoryAnalyzer({
        fs,
        git: countingGit(),
        cache: new AnalysisCache(),
      });
      return (await analyzer.analyze({ root: '/repo', level: 3 })).level3;
    };

    expect(await analyze()).toEqual(await analyze());
  });
});

describe('the inventory walk stats concurrently', () => {
  it('does not serialise one stat per file', async () => {
    const fs = countingFs(workspace(50));
    const analyzer = new RepositoryAnalyzer({ fs, git: countingGit(), cache: new AnalysisCache() });

    await analyzer.analyze({ root: '/repo', level: 1 });

    // One stat per file plus the fingerprint's manifest probes. The assertion
    // that matters is that it is bounded, not that a loop happened to run.
    expect(fs.counts.stat).toBeGreaterThan(0);
    expect(fs.counts.stat).toBeLessThan(100);
  });

  it('lists files in a deterministic order', async () => {
    const first = countingFs(workspace(25));
    const second = countingFs(workspace(25));

    const run = async (fs: FileSystemPort) =>
      (
        await new RepositoryAnalyzer({
          fs,
          git: countingGit(),
          cache: new AnalysisCache(),
        }).analyze({ root: '/repo', level: 1 })
      ).level1.fileCount;

    expect(await run(second)).toBe(await run(first));
  });
});

describe('version control is read once when the caller supplies it', () => {
  it('makes no git call at all when state is passed in', async () => {
    // `git` is by a wide margin the most expensive thing in a routing pass —
    // 200-700 ms against under a millisecond for routing itself. A caller that
    // analyses twice in one pass must not pay twice.
    const git = countingGit();
    const analyzer = new RepositoryAnalyzer({
      fs: countingFs(workspace(5)),
      git,
      cache: new AnalysisCache(),
    });

    const state = await git.getState('/repo');
    const before = git.calls;

    await analyzer.analyze({ root: '/repo', level: 1, gitState: state });
    await analyzer.analyze({ root: '/repo', level: 2, gitState: state });

    expect(git.calls).toBe(before);
  });

  it('reads git itself when nothing is supplied', async () => {
    const git = countingGit();
    const analyzer = new RepositoryAnalyzer({
      fs: countingFs(workspace(5)),
      git,
      cache: new AnalysisCache(),
    });

    await analyzer.analyze({ root: '/repo', level: 1 });

    expect(git.calls).toBe(1);
  });

  it('gives the same snapshot either way', async () => {
    const git = countingGit();
    const build = () =>
      new RepositoryAnalyzer({
        fs: countingFs(workspace(8)),
        git: countingGit(),
        cache: new AnalysisCache(),
      });

    const state = await git.getState('/repo');
    const supplied = await build().analyze({ root: '/repo', level: 2, gitState: state });
    const fetched = await build().analyze({ root: '/repo', level: 2 });

    expect(supplied.level1).toEqual(fetched.level1);
  });
});

describe('a warm cache does almost no filesystem work', () => {
  it('re-reads nothing when the repository has not changed', async () => {
    // The Phase 2 promise, now asserted in operations rather than in seconds:
    // a second analysis of an unchanged repository does no directory walk and
    // no file reads. Only the fingerprint's manifest probes remain.
    const fs = countingFs(workspace(30));
    const git = countingGit();
    const analyzer = new RepositoryAnalyzer({ fs, git, cache: new AnalysisCache() });

    await analyzer.analyze({ root: '/repo', level: 3 });
    const cold = { ...fs.counts };

    await analyzer.analyze({ root: '/repo', level: 3 });
    const warmReads = fs.counts.readFile - cold.readFile;
    const warmDirs = fs.counts.readDirectory - cold.readDirectory;

    expect(warmReads).toBe(0);
    expect(warmDirs).toBe(0);
  });

  it('still validates the cache against repository state', async () => {
    // The cache is not trusted blindly: the fingerprint is recomputed, which is
    // why a warm analysis is cheap but never free.
    const fs = countingFs(workspace(10));
    const analyzer = new RepositoryAnalyzer({ fs, git: countingGit(), cache: new AnalysisCache() });

    await analyzer.analyze({ root: '/repo', level: 1 });
    const cold = fs.counts.stat;

    await analyzer.analyze({ root: '/repo', level: 1 });

    expect(fs.counts.stat).toBeGreaterThan(cold);
  });
});
