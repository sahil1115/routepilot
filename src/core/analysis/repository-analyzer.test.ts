import { afterEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../../infra/node-filesystem.js';
import {
  CountingFileSystem,
  FakeClock,
  FakeDiagnostics,
  FakeGit,
  createRepo,
  diagnosticsForBrokenRepo,
  mediumPythonRepo,
  monorepoRepo,
  repoWithDiagnostics,
  repoWithTests,
  repoWithoutTests,
  tinyTypeScriptRepo,
  type FixtureRepo,
} from '../../test-support/repo-fixtures.js';
import { AnalysisCache } from './cache.js';
import { RepositoryAnalyzer } from './repository-analyzer.js';

const cleanups: FixtureRepo[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((repo) => repo.cleanup()));
});

/** Build a fixture plus an analyzer wired to counting doubles. */
async function setup(
  files: Record<string, string>,
  options: { diagnostics?: FakeDiagnostics } = {},
) {
  const repo = await createRepo(files);
  cleanups.push(repo);

  const fs = new CountingFileSystem(new NodeFileSystem());
  const git = new FakeGit();
  const clock = new FakeClock();
  const cache = new AnalysisCache();

  const analyzer = new RepositoryAnalyzer({
    fs,
    git,
    clock,
    cache,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });

  return { repo, fs, git, clock, cache, analyzer };
}

describe('repository detection — tiny TypeScript repo', () => {
  it('detects language, package manager and framework', async () => {
    const { repo, analyzer } = await setup(tinyTypeScriptRepo());

    const snapshot = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(snapshot.level1.primaryLanguage).toBe('typescript');
    expect(snapshot.level1.packageManager).toBe('npm');
    expect(snapshot.level1.frameworks).toContain('express');
    expect(snapshot.level1.isMonorepo).toBe(false);
    expect(snapshot.level1.fileCount).toBe(6);
    expect(snapshot.level1.truncated).toBe(false);
  });

  it('does not let markdown or json outvote the source language', async () => {
    const { repo, analyzer } = await setup({
      ...tinyTypeScriptRepo(),
      'docs/guide.md': 'x'.repeat(50_000),
    });

    const snapshot = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(snapshot.level1.primaryLanguage).toBe('typescript');
    expect(snapshot.level1.languages[0]?.language).toBe('markdown');
  });
});

describe('repository detection — medium Python repo', () => {
  it('detects python, its package manager, framework and CI', async () => {
    const { repo, analyzer } = await setup(mediumPythonRepo());

    const snapshot = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(snapshot.level1.primaryLanguage).toBe('python');
    expect(snapshot.level1.packageManager).toBe('pip');
    expect(snapshot.level1.frameworks).toEqual(expect.arrayContaining(['fastapi', 'pandas']));
    expect(snapshot.level1.hasContinuousIntegration).toBe(true);
    expect(snapshot.level1.fileCount).toBeGreaterThan(15);
  });

  it('reads dependencies from pyproject.toml without a TOML parser', async () => {
    const { repo, analyzer } = await setup(mediumPythonRepo());

    const snapshot = await analyzer.analyze({ root: repo.root, level: 2 });
    const names = snapshot.level2?.dependencies.map((d) => d.name) ?? [];

    expect(names).toContain('fastapi');
    expect(names).toContain('pandas');
    // Metadata keys must not be mistaken for dependencies.
    expect(names).not.toContain('name');
    expect(names).not.toContain('version');
    expect(names).not.toContain('requires-python');
  });
});

describe('repository detection — monorepo', () => {
  it('detects a monorepo and counts its workspaces', async () => {
    const { repo, analyzer } = await setup(monorepoRepo());

    const snapshot = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(snapshot.level1.isMonorepo).toBe(true);
    expect(snapshot.level1.workspaceCount).toBe(3);
    expect(snapshot.level1.packageManager).toBe('pnpm');
  });

  it('does not call a single-package repository a monorepo', async () => {
    const { repo, analyzer } = await setup(tinyTypeScriptRepo());

    const snapshot = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(snapshot.level1.isMonorepo).toBe(false);
    expect(snapshot.level1.workspaceCount).toBe(0);
  });
});

describe('repository detection — tests present and absent', () => {
  it('finds tests and their framework', async () => {
    const { repo, analyzer } = await setup(repoWithTests());

    const snapshot = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(snapshot.level2?.tests.hasTests).toBe(true);
    expect(snapshot.level2?.tests.testFileCount).toBe(2);
    expect(snapshot.level2?.tests.frameworks).toContain('vitest');
    expect(snapshot.level2?.tests.testFileRatio).toBeGreaterThan(0);
  });

  it('reports no tests when there are none', async () => {
    const { repo, analyzer } = await setup(repoWithoutTests());

    const snapshot = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(snapshot.level2?.tests.hasTests).toBe(false);
    expect(snapshot.level2?.tests.testFileCount).toBe(0);
    expect(snapshot.level2?.tests.testFileRatio).toBe(0);
    expect(snapshot.level2?.tests.frameworks).toEqual([]);
  });
});

describe('repository detection — diagnostics', () => {
  it('reports diagnostics when a source is connected', async () => {
    const diagnostics = new FakeDiagnostics(diagnosticsForBrokenRepo());
    const { repo, analyzer } = await setup(repoWithDiagnostics(), { diagnostics });

    const snapshot = await analyzer.analyze({ root: repo.root, level: 2 });
    const facts = snapshot.level2?.diagnostics;

    expect(facts?.observed).toBe(true);
    expect(facts?.errorCount).toBe(3);
    expect(facts?.warningCount).toBe(1);
    expect(facts?.affectedFiles).toEqual(['src/index.ts', 'src/other.ts']);
  });

  it('distinguishes "no diagnostics source" from "no problems"', async () => {
    // Same broken repository, but nothing is connected to report on it.
    const { repo, analyzer } = await setup(repoWithDiagnostics());

    const snapshot = await analyzer.analyze({ root: repo.root, level: 2 });
    const facts = snapshot.level2?.diagnostics;

    expect(facts?.observed).toBe(false);
    expect(facts?.errorCount).toBe(0);
  });

  it('reports a connected source that finds nothing as observed', async () => {
    const { repo, analyzer } = await setup(repoWithTests(), {
      diagnostics: new FakeDiagnostics([]),
    });

    const snapshot = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(snapshot.level2?.diagnostics.observed).toBe(true);
    expect(snapshot.level2?.diagnostics.errorCount).toBe(0);
  });
});

describe('changed file detection', () => {
  it('surfaces changed files and derives the affected modules', async () => {
    const { repo, git, analyzer } = await setup(mediumPythonRepo());
    git.setChanged([
      { path: 'app/routes.py', change: 'modified' },
      { path: 'app/models.py', change: 'modified' },
      { path: 'tests/test_main.py', change: 'modified' },
    ]);

    const snapshot = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(snapshot.level1.changedFiles).toHaveLength(3);
    expect(snapshot.level2?.affectedModules).toEqual(['app', 'tests']);
  });

  it('carries diff size through from git', async () => {
    const { repo, git, analyzer } = await setup(tinyTypeScriptRepo());
    git.set({ insertions: 120, deletions: 45 });

    const snapshot = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(snapshot.level1.git.insertions).toBe(120);
    expect(snapshot.level1.git.deletions).toBe(45);
  });

  it('handles a workspace that is not a repository at all', async () => {
    const repo = await createRepo(tinyTypeScriptRepo());
    cleanups.push(repo);

    const analyzer = new RepositoryAnalyzer({
      fs: new NodeFileSystem(),
      git: new FakeGit({ isRepository: false, branch: null, headCommit: null }),
    });

    const snapshot = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(snapshot.level1.git.isRepository).toBe(false);
    expect(snapshot.level1.changedFiles).toEqual([]);
    expect(snapshot.level1.fileCount).toBeGreaterThan(0);
  });
});

describe('context estimation', () => {
  it('estimates context from the relevant files', async () => {
    const { repo, analyzer } = await setup(mediumPythonRepo());

    const snapshot = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(snapshot.level2?.estimatedContextTokens).toBeGreaterThan(0);
    expect(snapshot.level2?.relevantFiles.length).toBeGreaterThan(0);
  });

  it('grows the estimate with the amount of code', async () => {
    const small = await setup(repoWithoutTests());
    const large = await setup({
      ...repoWithoutTests(),
      'src/huge.ts': 'const x = 1;\n'.repeat(5000),
    });

    const smallSnapshot = await small.analyzer.analyze({ root: small.repo.root, level: 2 });
    const largeSnapshot = await large.analyzer.analyze({ root: large.repo.root, level: 2 });

    expect(largeSnapshot.level2?.estimatedContextTokens).toBeGreaterThan(
      smallSnapshot.level2?.estimatedContextTokens ?? 0,
    );
  });

  it('puts referenced and active files first among relevant files', async () => {
    const { repo, analyzer } = await setup(mediumPythonRepo());

    const snapshot = await analyzer.analyze({
      root: repo.root,
      level: 2,
      referencedFiles: ['app/models.py'],
      activeFile: 'app/routes.py',
    });

    const paths = snapshot.level2?.relevantFiles.map((f) => f.path) ?? [];
    expect(paths[0]).toBe('app/models.py');
    expect(paths[1]).toBe('app/routes.py');
  });

  it('bounds the relevant file set rather than returning the whole repository', async () => {
    const files: Record<string, string> = { 'package.json': '{}' };
    for (let i = 0; i < 200; i += 1)
      files[`src/m${String(i)}.ts`] = `export const v = ${String(i)};\n`;

    const { repo, analyzer } = await setup(files);
    const snapshot = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(snapshot.level1.fileCount).toBe(201);
    expect(snapshot.level2?.relevantFiles.length).toBeLessThanOrEqual(40);
  });
});

describe('progressive analysis', () => {
  it('runs only what the requested level needs', async () => {
    const { repo, analyzer } = await setup(tinyTypeScriptRepo());

    const level1 = await analyzer.analyze({ root: repo.root, level: 1 });
    expect(level1.level2).toBeUndefined();
    expect(level1.level3).toBeUndefined();

    const level2 = await analyzer.analyze({ root: repo.root, level: 2 });
    expect(level2.level2).toBeDefined();
    expect(level2.level3).toBeUndefined();

    const level3 = await analyzer.analyze({ root: repo.root, level: 3 });
    expect(level3.level3).toBeDefined();
  });

  it('costs more filesystem work at level 3 than at level 1', async () => {
    const first = await setup(mediumPythonRepo());
    const firstSnapshot = await first.analyzer.analyze({ root: first.repo.root, level: 1 });
    const level1Cost = first.fs.counts.total;

    const second = await setup(mediumPythonRepo());
    await second.analyzer.analyze({ root: second.repo.root, level: 3 });
    const level3Cost = second.fs.counts.total;

    expect(firstSnapshot.level1.fileCount).toBeGreaterThan(0);
    expect(level3Cost).toBeGreaterThan(level1Cost);
  });

  it('builds an approximate import graph at level 3', async () => {
    const { repo, analyzer } = await setup(mediumPythonRepo());

    const snapshot = await analyzer.analyze({ root: repo.root, level: 3 });
    const graph = snapshot.level3;

    expect(graph?.approximate).toBe(true);
    expect(graph?.edges.length).toBeGreaterThan(0);
    // Every service module imports models, so models has the highest fan-in.
    expect(graph?.maxFanIn).toBeGreaterThan(5);
  });

  it('resolves relative TypeScript imports across extensions', async () => {
    const { repo, analyzer } = await setup({
      'package.json': '{}',
      'src/index.ts': "import { greet } from './greet.js';\nimport './side-effect.js';\n",
      'src/greet.ts': "export const greet = () => 'hi';\n",
      'src/side-effect.ts': 'export {};\n',
    });

    const snapshot = await analyzer.analyze({ root: repo.root, level: 3 });

    expect(snapshot.level3?.edges).toEqual(
      expect.arrayContaining([
        { from: 'src/index.ts', to: 'src/greet.ts' },
        { from: 'src/index.ts', to: 'src/side-effect.ts' },
      ]),
    );
  });
});

describe('walk bounds', () => {
  it('never descends into ignored directories', async () => {
    const { repo, analyzer } = await setup({
      ...tinyTypeScriptRepo(),
      'node_modules/left-pad/index.js': 'module.exports = 1;\n',
      'dist/index.js': 'compiled\n',
      '.git/config': '[core]\n',
      '__pycache__/x.pyc': 'bytes\n',
    });

    const snapshot = await analyzer.analyze({ root: repo.root, level: 1 });
    const paths = snapshot.level1.languages.flatMap((l) => l.language);

    expect(snapshot.level1.fileCount).toBe(6);
    expect(paths).not.toContain('compiled');
  });

  it('reports truncation instead of silently miscounting a huge repository', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) files[`src/f${String(i)}.ts`] = 'export {};\n';

    const repo = await createRepo(files);
    cleanups.push(repo);

    const analyzer = new RepositoryAnalyzer({
      fs: new NodeFileSystem(),
      git: new FakeGit(),
      maxFiles: 25,
    });

    const snapshot = await analyzer.analyze({ root: repo.root, level: 1 });

    expect(snapshot.level1.truncated).toBe(true);
    expect(snapshot.level1.fileCount).toBeLessThanOrEqual(25);
  });

  it('survives a malformed package.json without crashing', async () => {
    const { repo, analyzer } = await setup({
      'package.json': '{ this is not json',
      'src/a.ts': 'export {};\n',
    });

    const snapshot = await analyzer.analyze({ root: repo.root, level: 2 });

    expect(snapshot.level2?.dependencies).toEqual([]);
    expect(snapshot.level1.primaryLanguage).toBe('typescript');
  });
});
