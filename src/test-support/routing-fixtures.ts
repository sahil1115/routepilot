/**
 * Routing test fixtures.
 *
 * A four-rung model ladder with invented vendor names, plus a helper that runs
 * the real classifier and feature extractor over a synthetic repository
 * snapshot. Using the real classifier matters: the routing cases in the spec
 * are stated in natural language ("rename variable", "normal API endpoint"),
 * and testing them against hand-written feature vectors would prove the router
 * works on inputs the classifier never actually produces.
 *
 * Excluded from the published build (see tsconfig.build.json).
 */

import { FeatureExtractor } from '../core/analysis/feature-extractor.js';
import { TaskClassifier } from '../core/analysis/task-classifier.js';
import type { GitState } from '../core/ports.js';
import type { Level1Facts, Level2Facts, RepositorySnapshot } from '../core/types/analysis.js';
import type { RoutingFeatures, TaskHistory } from '../core/types/features.js';
import type { ModelSpec } from '../core/types/model.js';
import type { RoutingPolicy } from '../core/types/routing.js';
import { makeModel } from './fixtures.js';

/**
 * The cheap rung.
 *
 * Strong at mechanical edits and documentation, weak at reasoning across many
 * files — the profile of a small fast model.
 */
export function cheapModel(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return makeModel({
    id: 'acme/fast-1',
    modelId: 'fast-1',
    displayName: 'Acme Fast 1',
    tier: 'cheap',
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    pricing: { inputPerMillion: 0.5, outputPerMillion: 2.5, currency: 'USD' },
    latency: { firstTokenSeconds: 0.4, outputTokensPerSecond: 140 },
    priors: {
      skills: {
        codeGeneration: 0.74,
        codeEditing: 0.88,
        debugging: 0.6,
        refactoring: 0.62,
        architecture: 0.45,
        reasoning: 0.6,
        testGeneration: 0.7,
        documentation: 0.86,
        multiFileReasoning: 0.52,
      },
      languages: { typescript: 0.76, python: 0.74 },
    },
    ...overrides,
  });
}

/** The medium rung: a solid generalist. */
export function mediumModel(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return makeModel({
    id: 'acme/balanced-1',
    modelId: 'balanced-1',
    displayName: 'Acme Balanced 1',
    tier: 'medium',
    contextWindow: 500_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    latency: { firstTokenSeconds: 1.0, outputTokensPerSecond: 95 },
    priors: {
      skills: {
        codeGeneration: 0.87,
        codeEditing: 0.89,
        debugging: 0.82,
        refactoring: 0.85,
        architecture: 0.74,
        reasoning: 0.82,
        testGeneration: 0.86,
        documentation: 0.88,
        multiFileReasoning: 0.8,
      },
      languages: { typescript: 0.87, python: 0.86 },
    },
    ...overrides,
  });
}

/** The frontier rung. */
export function frontierModel(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return makeModel({
    id: 'acme/deep-1',
    modelId: 'deep-1',
    displayName: 'Acme Deep 1',
    tier: 'frontier',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMillion: 10, outputPerMillion: 50, currency: 'USD' },
    latency: { firstTokenSeconds: 1.8, outputTokensPerSecond: 70 },
    priors: {
      skills: {
        codeGeneration: 0.93,
        codeEditing: 0.93,
        debugging: 0.92,
        refactoring: 0.92,
        architecture: 0.9,
        reasoning: 0.93,
        testGeneration: 0.91,
        documentation: 0.9,
        multiFileReasoning: 0.92,
      },
      languages: { typescript: 0.93, python: 0.92 },
    },
    ...overrides,
  });
}

/** The ultra rung: strongest and by far the most expensive. */
export function ultraModel(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return makeModel({
    id: 'acme/ultra-1',
    modelId: 'ultra-1',
    displayName: 'Acme Ultra 1',
    tier: 'ultra',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMillion: 20, outputPerMillion: 100, currency: 'USD' },
    latency: { firstTokenSeconds: 3.0, outputTokensPerSecond: 55 },
    priors: {
      skills: {
        codeGeneration: 0.96,
        codeEditing: 0.95,
        debugging: 0.96,
        refactoring: 0.95,
        architecture: 0.95,
        reasoning: 0.96,
        testGeneration: 0.94,
        documentation: 0.92,
        multiFileReasoning: 0.95,
      },
      languages: { typescript: 0.96, python: 0.95 },
    },
    ...overrides,
  });
}

/** The standard four-rung ladder, cheapest first. */
export function modelLadder(): ModelSpec[] {
  return [cheapModel(), mediumModel(), frontierModel(), ultraModel()];
}

/** Default routing policy for tests: the spec section 14 example threshold. */
export function policy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return {
    minimumSuccessProbability: 0.85,
    maxRisk: 0.6,
    // 30 minutes. A 64k-token response at ~70 tokens/second is already ~15
    // minutes, so a tighter default would silently exclude frontier models
    // from exactly the long-output tasks they exist for.
    maxLatencySeconds: 1800,
    currency: 'USD',
    onBudgetExceeded: 'stop',
    modelOverrideEnabled: false,
    ...overrides,
  };
}

/** Options for {@link featuresFor}. */
export interface FeatureOptions {
  readonly fileCount?: number;
  readonly primaryLanguage?: string | null;
  readonly isMonorepo?: boolean;
  readonly activeFile?: string;
  readonly referencedFiles?: readonly string[];
  /** Estimated tokens for the relevant files, standing in for level 2 output. */
  readonly contextTokens?: number;
  readonly analysisLevel?: 1 | 2 | 3;
  readonly history?: TaskHistory;
}

const CLEAN_GIT: GitState = {
  isRepository: true,
  branch: 'main',
  headCommit: 'a'.repeat(40),
  changedFiles: [],
  insertions: 0,
  deletions: 0,
};

/**
 * Build routing features for a prompt, using the real classifier and extractor.
 *
 * The repository snapshot is synthetic so that tests stay fast and fully
 * deterministic; everything downstream of it is production code.
 */
export function featuresFor(prompt: string, options: FeatureOptions = {}): RoutingFeatures {
  const level1: Level1Facts = {
    root: '/workspace',
    fileCount: options.fileCount ?? 200,
    totalBytes: (options.fileCount ?? 200) * 2_000,
    truncated: false,
    languages: [],
    primaryLanguage: options.primaryLanguage === undefined ? 'typescript' : options.primaryLanguage,
    packageManager: 'npm',
    frameworks: [],
    isMonorepo: options.isMonorepo ?? false,
    workspaceCount: 0,
    hasContinuousIntegration: true,
    git: CLEAN_GIT,
    changedFiles: [],
  };

  const level = options.analysisLevel ?? 2;

  const level2: Level2Facts | undefined =
    level >= 2
      ? {
          relevantFiles: [],
          dependencies: [],
          dependencyCount: 12,
          tests: { hasTests: true, testFileCount: 20, testFileRatio: 0.2, frameworks: ['vitest'] },
          diagnostics: {
            observed: false,
            errorCount: 0,
            warningCount: 0,
            affectedFiles: [],
            diagnostics: [],
          },
          estimatedContextTokens: options.contextTokens ?? 20_000,
          affectedModules: [],
        }
      : undefined;

  const snapshot: RepositorySnapshot = {
    root: '/workspace',
    level,
    level1,
    ...(level2 === undefined ? {} : { level2 }),
    analyzedAt: 0,
    cache: {
      hit: false,
      reusedLevels: [],
      computedLevels: [level],
      reusedInventory: false,
      invalidatedBy: [],
    },
  };

  const classification = new TaskClassifier().classify({
    prompt,
    ...(options.activeFile === undefined ? {} : { activeFile: options.activeFile }),
    ...(options.referencedFiles === undefined ? {} : { referencedFiles: options.referencedFiles }),
  });

  return new FeatureExtractor().extract({
    prompt,
    classification,
    snapshot,
    ...(options.history === undefined ? {} : { history: options.history }),
  });
}

// ---------------------------------------------------------------------------
// Expected-cost scenarios (Phase 9)
// ---------------------------------------------------------------------------

/**
 * A model that is cheaper per token but noticeably less reliable.
 *
 * Priced at ~91% of {@link steadyModel}. That ratio matters: the breakeven is
 * around 87%, so this model's lower sticker price does *not* buy a cheaper path
 * to success. Its success prior is set so it still clears a 0.85 threshold,
 * which is the point — the router must reject it on **expected cost**, not
 * because the confidence filter removed it.
 */
export function thriftyModel(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return makeModel({
    id: 'acme/thrifty-1',
    modelId: 'thrifty-1',
    displayName: 'Acme Thrifty 1',
    tier: 'medium',
    contextWindow: 500_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMillion: 2.73, outputPerMillion: 13.65, currency: 'USD' },
    latency: { firstTokenSeconds: 1, outputTokensPerSecond: 95 },
    // Language priors are left empty so capability fit is the skill prior
    // alone, keeping the scenario's arithmetic easy to follow.
    priors: { skills: { codeGeneration: 0.88 }, languages: {} },
    ...overrides,
  });
}

/**
 * A model that costs a little more per token and almost never fails.
 *
 * The cheaper expected path, despite the dearer first attempt.
 */
export function steadyModel(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return makeModel({
    id: 'acme/steady-1',
    modelId: 'steady-1',
    displayName: 'Acme Steady 1',
    tier: 'medium',
    contextWindow: 500_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    latency: { firstTokenSeconds: 1, outputTokensPerSecond: 95 },
    priors: { skills: { codeGeneration: 0.99 }, languages: {} },
    ...overrides,
  });
}

/**
 * A model that is dramatically cheaper and much less reliable.
 *
 * The contrasting case: when the price gap is wide enough, opening with the
 * cheap model genuinely *is* the cheaper expected path, even at a poor success
 * rate. Used to document that boundary rather than pretend it does not exist.
 */
export function bargainModel(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return makeModel({
    id: 'acme/bargain-1',
    modelId: 'bargain-1',
    displayName: 'Acme Bargain 1',
    tier: 'cheap',
    contextWindow: 500_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMillion: 0.5, outputPerMillion: 2.5, currency: 'USD' },
    latency: { firstTokenSeconds: 0.4, outputTokensPerSecond: 140 },
    priors: { skills: { codeGeneration: 0.88 }, languages: {} },
    ...overrides,
  });
}
