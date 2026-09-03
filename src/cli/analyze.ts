/**
 * `routepilot analyze` (spec section 48).
 *
 * Runs the Phase 2 pipeline — classify, analyse, extract features — and prints
 * what RoutePilot understood. It selects no model: that is the routing engine's
 * job, and it does not exist yet.
 *
 * The command exists so the analysis stack can be exercised against real
 * repositories from a terminal, without VS Code and without a provider.
 */

import {
  FeatureExtractor,
  RepositoryAnalyzer,
  TaskClassifier,
  type AnalysisLevel,
  type RoutingFeatures,
  type TaskClassification,
  type RepositorySnapshot,
} from '../core/index.js';
import { NodeFileSystem } from '../infra/node-filesystem.js';
import { NodeGit } from '../infra/node-git.js';
import type { GitPort } from '../core/ports.js';

import { AnalysisCache } from '../core/analysis/cache.js';
/** What `analyze` produced. */
export interface AnalyzeResult {
  readonly classification: TaskClassification;
  readonly snapshot: RepositorySnapshot;
  readonly features: RoutingFeatures;
  /**
   * How long each stage took.
   *
   * Carried beside the analysis rather than inside it: a snapshot that included
   * a wall-clock reading would no longer be comparable between two runs, and
   * determinism has been a hard requirement since Phase 3.
   */
  readonly timings: {
    readonly analysisMs: number;
    readonly featureExtractionMs: number;
  };
}

/** Options for {@link analyzeTask}. */
export interface AnalyzeOptions {
  readonly prompt: string;
  readonly root: string;
  readonly level: AnalysisLevel;
  readonly activeFile?: string | undefined;
  readonly referencedFiles?: readonly string[] | undefined;
  /**
   * An analyzer to reuse, and with it its cache.
   *
   * Absent means a fresh one, which is right for the CLI: a one-shot process
   * has nothing to reuse. A long-lived host — the VS Code extension — should
   * pass the same analyzer every time, or every request re-reads a repository
   * that has not changed (spec section 69).
   */
  readonly analyzer?: RepositoryAnalyzer | undefined;
  /** Version-control reader. Injected so the benchmark and tests can supply one. */
  readonly git?: GitPort | undefined;
}

/**
 * Choose an analysis level from the task itself (spec section 10).
 *
 * This is the progressive-analysis policy: expensive analysis is earned by the
 * task, not run by default. An explanation gets level 1; a repository-wide
 * migration earns level 3.
 */
export function chooseAnalysisLevel(classification: TaskClassification): AnalysisLevel {
  const { scope, taskType, reasoningRequirement, ambiguity } = classification;

  if (scope === 'repository-wide' || taskType === 'architecture' || taskType === 'migration') {
    return 3;
  }
  if (scope === 'many-files' || reasoningRequirement >= 0.7) return 3;

  const trivial =
    taskType === 'explanation' ||
    taskType === 'documentation' ||
    taskType === 'formatting' ||
    taskType === 'autocomplete';

  // High ambiguity is itself a reason to look harder before committing money.
  if (trivial && ambiguity < 0.6) return 1;

  return 2;
}

/**
 * Whether this platform's default filesystem distinguishes letter case.
 *
 * Decided here, at the edge, so `src/core` keeps no platform knowledge. Windows
 * and macOS fold case by default; everything else does not, and folding there
 * would serve one repository's analysis for another whose path differs only in
 * case.
 */
const FILESYSTEM_IS_CASE_SENSITIVE = !(
  process.platform === 'win32' || process.platform === 'darwin'
);

/** Run the analysis pipeline against a real workspace. */
export async function analyzeTask(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const analyzer =
    options.analyzer ??
    new RepositoryAnalyzer({
      fs: new NodeFileSystem(),
      git: new NodeGit(),
      cache: new AnalysisCache({ caseSensitive: FILESYSTEM_IS_CASE_SENSITIVE }),
    });

  const analysisStarted = now();

  // Read version control **once** for the whole pass. Both analyses below would
  // otherwise spawn `git` separately, and that subprocess is by a wide margin
  // the most expensive thing in a routing pass — benchmarks put it at 200-700 ms
  // against under a millisecond for everything else. Sharing it also means both
  // analyses see one consistent view of the working tree.
  const gitState = await (options.git ?? new NodeGit()).getState(options.root);

  // Level 1 first, so the classifier can see the repository's actual state.
  const preliminary = await analyzer.analyze({ root: options.root, level: 1, gitState });

  const classifier = new TaskClassifier();
  const classification = classifier.classify({
    prompt: options.prompt,
    ...(options.activeFile === undefined ? {} : { activeFile: options.activeFile }),
    ...(options.referencedFiles === undefined ? {} : { referencedFiles: options.referencedFiles }),
    // Omitted when unknown. The classifier treats an absent list as "no
    // information" and a present empty one as "nothing changed", and those
    // pull its risk estimate in different directions.
    ...(preliminary.level1.changedFiles === null
      ? {}
      : { changedFiles: preliminary.level1.changedFiles.map((file) => file.path) }),
    ...(preliminary.level1.primaryLanguage === null
      ? {}
      : { primaryLanguage: preliminary.level1.primaryLanguage }),
    repositoryFileCount: preliminary.level1.fileCount,
  });

  // Deepen only as far as the task warrants. This reuses the level 1 work.
  const snapshot = await analyzer.analyze({
    root: options.root,
    level: options.level,
    gitState,
    ...(options.activeFile === undefined ? {} : { activeFile: options.activeFile }),
    ...(options.referencedFiles === undefined ? {} : { referencedFiles: options.referencedFiles }),
  });

  const analysisMs = now() - analysisStarted;

  const extractionStarted = now();
  const features = new FeatureExtractor().extract({
    prompt: options.prompt,
    classification,
    snapshot,
  });
  const featureExtractionMs = now() - extractionStarted;

  return {
    classification,
    snapshot,
    features,
    timings: { analysisMs, featureExtractionMs },
  };
}

/**
 * Monotonic milliseconds.
 *
 * `performance.now` rather than `Date.now`: it is monotonic, so a clock
 * adjustment mid-analysis cannot produce a negative duration, and it has
 * sub-millisecond resolution — which matters when the stage being measured is
 * a fraction of a millisecond.
 */
function now(): number {
  return performance.now();
}

/** Render an analysis as human-readable text. */
export function renderAnalysis(result: AnalyzeResult): string {
  const { classification, snapshot, features } = result;
  const lines: string[] = [];

  lines.push(`Task`);
  lines.push(`  type:       ${classification.taskType}`);
  lines.push(`  scope:      ${classification.scope}`);
  lines.push(`  confidence: ${percent(classification.confidence)}`);
  lines.push(`  ambiguity:  ${percent(classification.ambiguity)}`);
  lines.push(`  reasoning:  ${percent(classification.reasoningRequirement)}`);
  lines.push(`  risk:       ${percent(classification.risk)}`);

  lines.push('');
  lines.push('Why');
  if (classification.signals.length === 0) {
    lines.push('  (no evidence found — the task type is unknown)');
  }
  for (const signal of classification.signals) {
    lines.push(`  ${signal.rule}  +${signal.weight.toFixed(1)} ${signal.taskType}`);
    lines.push(`    ${signal.reason}`);
  }

  lines.push('');
  lines.push(`Repository (analysis level ${String(snapshot.level)})`);
  lines.push(
    `  files:      ${format(snapshot.level1.fileCount)}${snapshot.level1.truncated ? '+ (truncated)' : ''}`,
  );
  lines.push(`  language:   ${snapshot.level1.primaryLanguage ?? 'unknown'}`);
  lines.push(`  frameworks: ${list(snapshot.level1.frameworks)}`);
  lines.push(`  monorepo:   ${String(snapshot.level1.isMonorepo)}`);
  lines.push(`  git:        ${describeGit(snapshot)}`);
  lines.push(
    `  changed:    ${
      snapshot.level1.changedFiles === null
        ? 'unknown (git status could not be read)'
        : `${format(snapshot.level1.changedFiles.length)} file(s)`
    }`,
  );
  lines.push(`  CI:         ${String(snapshot.level1.hasContinuousIntegration)}`);

  if (snapshot.level2 !== undefined) {
    const { tests, diagnostics, dependencyCount, relevantFiles } = snapshot.level2;
    lines.push(`  deps:       ${format(dependencyCount)}`);
    lines.push(
      `  tests:      ${tests.hasTests ? `${format(tests.testFileCount)} file(s)` : 'none'}${
        tests.frameworks.length > 0 ? ` (${tests.frameworks.join(', ')})` : ''
      }`,
    );
    lines.push(
      `  diagnostics: ${
        diagnostics.observed
          ? `${format(diagnostics.errorCount)} error(s), ${format(diagnostics.warningCount)} warning(s)`
          : 'not observed (no diagnostics source connected)'
      }`,
    );
    lines.push(`  relevant:   ${format(relevantFiles.length)} file(s)`);
  }

  if (snapshot.level3 !== undefined) {
    lines.push(
      `  imports:    ${format(snapshot.level3.edges.length)} edge(s), max fan-out ${format(
        snapshot.level3.maxFanOut,
      )}, max fan-in ${format(snapshot.level3.maxFanIn)} (approximate)`,
    );
  }

  lines.push('');
  lines.push('Context estimate (approximate — not a tokenizer result)');
  lines.push(`  input:      ~${format(features.context.estimatedInputTokens)} tokens`);
  lines.push(`  output:     ~${format(features.context.estimatedOutputTokens)} tokens`);
  lines.push(`  required:   ~${format(features.context.contextRequirement)} tokens`);

  lines.push('');
  lines.push(
    `Cache: ${
      snapshot.cache.hit
        ? 'hit (nothing rescanned)'
        : `computed level(s) ${snapshot.cache.computedLevels.join(', ')}${
            snapshot.cache.invalidatedBy.length > 0
              ? ` — ${snapshot.cache.invalidatedBy.join('; ')}`
              : ''
          }`
    }`,
  );

  lines.push('');
  lines.push('No model selected: the routing engine arrives in Phase 3 (see docs/ROADMAP.md).');

  return lines.join('\n');
}

function describeGit(snapshot: RepositorySnapshot): string {
  const { git } = snapshot.level1;
  if (!git.isRepository) return 'not a repository';
  const branch = git.branch ?? 'detached';
  // Churn counts tracked files only, so a repository with no commits reports
  // +0/-0 however much is sitting in the working tree. Saying so is cheaper
  // than letting a reader conclude nothing has changed.
  const churn =
    git.insertions === null || git.deletions === null
      ? 'churn unknown'
      : `+${String(git.insertions)}/-${String(git.deletions)}${
          git.headCommit === null ? ', untracked — no commits yet' : ''
        }`;
  return `${branch} (${churn})`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function format(value: number): string {
  return value.toLocaleString('en-US');
}

function list(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : 'none detected';
}
