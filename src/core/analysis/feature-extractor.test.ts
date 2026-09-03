import { afterEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../../infra/node-filesystem.js';
import {
  FakeDiagnostics,
  FakeGit,
  createRepo,
  diagnosticsForBrokenRepo,
  mediumPythonRepo,
  repoWithDiagnostics,
  repoWithTests,
  repoWithoutTests,
  tinyTypeScriptRepo,
  type FixtureRepo,
} from '../../test-support/repo-fixtures.js';
import type { TaskHistory } from '../types/features.js';
import { FeatureExtractor } from './feature-extractor.js';
import { RepositoryAnalyzer } from './repository-analyzer.js';
import { TaskClassifier } from './task-classifier.js';

const cleanups: FixtureRepo[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((repo) => repo.cleanup()));
});

const classifier = new TaskClassifier();
const extractor = new FeatureExtractor();

/** Run the whole pipeline: classify, analyse, extract. */
async function pipeline(
  prompt: string,
  files: Record<string, string>,
  options: {
    level?: 1 | 2 | 3;
    diagnostics?: FakeDiagnostics;
    history?: TaskHistory;
    changedFiles?: { path: string; change: 'modified' }[];
  } = {},
) {
  const repo = await createRepo(files);
  cleanups.push(repo);

  const git = new FakeGit();
  if (options.changedFiles !== undefined) git.setChanged(options.changedFiles);

  const analyzer = new RepositoryAnalyzer({
    fs: new NodeFileSystem(),
    git,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });

  const snapshot = await analyzer.analyze({ root: repo.root, level: options.level ?? 2 });
  const classification = classifier.classify({ prompt });

  return extractor.extract({
    prompt,
    classification,
    snapshot,
    ...(options.history === undefined ? {} : { history: options.history }),
  });
}

describe('FeatureExtractor — task features', () => {
  it('carries the classification through', async () => {
    const features = await pipeline('migrate the build to vite', tinyTypeScriptRepo());

    expect(features.task.taskType).toBe('migration');
    expect(features.task.scope).toBe('repository-wide');
    expect(features.task.promptLength).toBe('migrate the build to vite'.length);
    expect(features.task.risk).toBeGreaterThan(0);
  });

  it('expects more files and tool calls for a wider task', async () => {
    const narrow = await pipeline('explain this function', tinyTypeScriptRepo());
    const wide = await pipeline(
      'refactor authentication across the repository',
      tinyTypeScriptRepo(),
    );

    expect(wide.task.expectedFileCount).toBeGreaterThan(narrow.task.expectedFileCount);
    expect(wide.task.expectedToolCalls).toBeGreaterThan(narrow.task.expectedToolCalls);
  });
});

describe('FeatureExtractor — repository features', () => {
  it('describes a monorepo differently from a single package', async () => {
    const tiny = await pipeline('add a feature', tinyTypeScriptRepo());

    expect(tiny.repository.primaryLanguage).toBe('typescript');
    expect(tiny.repository.isMonorepo).toBe(false);
    expect(tiny.repository.fileCount).toBeGreaterThan(0);
  });

  it('reports test presence once level 2 has run', async () => {
    const tested = await pipeline('add a feature', repoWithTests());
    const untested = await pipeline('add a feature', repoWithoutTests());

    expect(tested.repository.hasTests).toBe(true);
    expect(untested.repository.hasTests).toBe(false);
    expect(tested.repository.testFileRatio).toBeGreaterThan(0);
  });

  it('leaves level 2 facts undefined at level 1 — absent is not false', async () => {
    const features = await pipeline('explain this', repoWithoutTests(), { level: 1 });

    // The repository genuinely has no tests, but level 1 did not look.
    // Reporting `false` here would be a fact nobody established.
    expect(features.repository.hasTests).toBeUndefined();
    expect(features.repository.dependencyCount).toBeUndefined();
    expect(features.analysisLevel).toBe(1);
  });

  it('reports diagnostic errors only when a source was connected', async () => {
    const observed = await pipeline('fix this', repoWithDiagnostics(), {
      diagnostics: new FakeDiagnostics(diagnosticsForBrokenRepo()),
    });
    const unobserved = await pipeline('fix this', repoWithDiagnostics());

    expect(observed.repository.diagnosticErrorCount).toBe(3);
    expect(unobserved.repository.diagnosticErrorCount).toBeUndefined();
  });

  it('exposes dependency fan-out only at level 3', async () => {
    const shallow = await pipeline('refactor', mediumPythonRepo(), { level: 2 });
    const deep = await pipeline('refactor', mediumPythonRepo(), { level: 3 });

    expect(shallow.repository.dependencyFanOut).toBeUndefined();
    expect(deep.repository.dependencyFanOut).toBeGreaterThanOrEqual(1);
  });

  it('reports changed files and diff size', async () => {
    const features = await pipeline('continue', mediumPythonRepo(), {
      changedFiles: [
        { path: 'app/routes.py', change: 'modified' },
        { path: 'app/models.py', change: 'modified' },
      ],
    });

    expect(features.repository.changedFileCount).toBe(2);
    expect(features.repository.isGitRepository).toBe(true);
  });
});

describe('FeatureExtractor — context features', () => {
  it('estimates input, output and total context requirement', async () => {
    const features = await pipeline('implement caching', mediumPythonRepo());

    expect(features.context.estimatedInputTokens).toBeGreaterThan(0);
    expect(features.context.estimatedOutputTokens).toBeGreaterThan(0);
    expect(features.context.contextRequirement).toBeGreaterThan(
      features.context.estimatedInputTokens + features.context.estimatedOutputTokens,
    );
  });

  it('applies a safety margin, so the requirement errs high', async () => {
    const features = await pipeline('implement caching', mediumPythonRepo());
    const raw = features.context.estimatedInputTokens + features.context.estimatedOutputTokens;

    // Underestimating context fails a request that has already been paid for.
    expect(features.context.contextRequirement).toBeGreaterThanOrEqual(raw);
    expect(features.context.contextRequirement).toBeLessThan(raw * 1.5);
  });

  it('needs more context for a bigger repository', async () => {
    const small = await pipeline('add a feature', tinyTypeScriptRepo());
    const large = await pipeline('add a feature', mediumPythonRepo());

    expect(large.context.estimatedInputTokens).toBeGreaterThan(small.context.estimatedInputTokens);
  });

  it('counts no relevant files at level 1', async () => {
    const features = await pipeline('explain this', mediumPythonRepo(), { level: 1 });
    expect(features.context.relevantFileCount).toBe(0);
  });
});

describe('FeatureExtractor — history features', () => {
  it('reports zeroed history when none is supplied', async () => {
    const features = await pipeline('add a feature', tinyTypeScriptRepo());

    expect(features.history.previousAttempts).toBe(0);
    expect(features.history.previousModelId).toBeNull();
    expect(features.history.attemptedModelIds).toEqual([]);
  });

  it('summarises prior attempts, failures and escalations', async () => {
    const history: TaskHistory = {
      attempts: [
        {
          modelId: 'acme/fast-1',
          succeeded: false,
          escalated: true,
          failureType: 'MODEL_WEAKNESS',
        },
        { modelId: 'acme/deep-1', succeeded: false, escalated: false },
      ],
      taskTypeObservations: 30,
    };

    const features = await pipeline('fix the bug', tinyTypeScriptRepo(), { history });

    expect(features.history.previousAttempts).toBe(2);
    expect(features.history.previousFailures).toBe(2);
    expect(features.history.previousEscalations).toBe(1);
    expect(features.history.previousModelId).toBe('acme/deep-1');
    expect(features.history.attemptedModelIds).toEqual(['acme/fast-1', 'acme/deep-1']);
  });

  it('treats an unseen task as maximally novel rather than familiar', async () => {
    // Spec section 39: no fabricated confidence. Zero observations means
    // "unknown", which is novelty 1 — not novelty 0.
    const unseen = await pipeline('add a feature', tinyTypeScriptRepo());
    expect(unseen.task.novelty).toBe(1);

    const seen = await pipeline('add a feature', tinyTypeScriptRepo(), {
      history: { attempts: [], taskTypeObservations: 50 },
    });
    expect(seen.task.novelty).toBeLessThan(0.3);
  });

  it('decreases novelty monotonically as observations accumulate', async () => {
    const results = await Promise.all(
      [0, 5, 20, 100].map((observations) =>
        pipeline('add a feature', tinyTypeScriptRepo(), {
          history: { attempts: [], taskTypeObservations: observations },
        }),
      ),
    );

    const novelties = results.map((r) => r.task.novelty);
    for (let i = 1; i < novelties.length; i += 1) {
      expect(novelties[i]).toBeLessThan(novelties[i - 1] ?? 1);
    }
  });
});

describe('FeatureExtractor — completeness', () => {
  it('produces every feature group the spec names (section 11)', async () => {
    const features = await pipeline('refactor the API layer', mediumPythonRepo(), { level: 3 });

    expect(Object.keys(features).sort()).toEqual([
      'analysisLevel',
      'context',
      'history',
      'repository',
      'task',
    ]);

    // Execution features are absent by design: they exist only once execution
    // has begun, and arrive with the execution monitor in Phase 8.
    expect(features).not.toHaveProperty('execution');
  });

  it('keeps every normalised score inside [0, 1]', async () => {
    const features = await pipeline(
      'urgently migrate the production auth schema across the whole repository',
      mediumPythonRepo(),
    );

    for (const value of [
      features.task.ambiguity,
      features.task.novelty,
      features.task.reasoningRequirement,
      features.task.risk,
      features.task.classificationConfidence,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
