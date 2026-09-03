/**
 * Feature extraction (spec section 11).
 *
 * Turns a classification, a repository snapshot and any task history into the
 * feature vector the routing engine consumes.
 *
 * The rule this file follows throughout: **absent is not zero.** If level 2 was
 * never run, `hasTests` is `undefined`, not `false`. A router that cannot tell
 * "this repository has no tests" from "nobody looked" will make confident
 * decisions on facts it does not have.
 */

import type { RepositorySnapshot } from '../types/analysis.js';
import type {
  ContextFeatures,
  HistoryFeatures,
  RepositoryFeatures,
  RoutingFeatures,
  TaskClassification,
  TaskFeatures,
  TaskHistory,
  TaskScope,
} from '../types/features.js';
import { estimateOutputTokens, estimateTokens, withSafetyMargin } from './tokens.js';

/** Everything needed to build a feature vector. */
export interface FeatureExtractionInput {
  readonly prompt: string;
  readonly classification: TaskClassification;
  readonly snapshot: RepositorySnapshot;
  /** Prior attempts at this task. Absent means none are known. */
  readonly history?: TaskHistory | undefined;
}

/** Expected files touched, by scope. Priors, to be replaced by observation. */
const FILES_BY_SCOPE: Record<TaskScope, number> = {
  'single-file': 1,
  'few-files': 3,
  'many-files': 10,
  'repository-wide': 30,
};

/** Expected tool calls, by scope. */
const TOOL_CALLS_BY_SCOPE: Record<TaskScope, number> = {
  'single-file': 4,
  'few-files': 10,
  'many-files': 25,
  'repository-wide': 60,
};

/** Builds routing features from analysis output. */
export class FeatureExtractor {
  /** Extract the complete feature vector. */
  extract(input: FeatureExtractionInput): RoutingFeatures {
    const task = this.#taskFeatures(input);
    const repository = this.#repositoryFeatures(input.snapshot);
    const history = this.#historyFeatures(input.history);
    const context = this.#contextFeatures(input, task);

    return {
      task,
      repository,
      context,
      history,
      analysisLevel: input.snapshot.level,
    };
  }

  #taskFeatures(input: FeatureExtractionInput): TaskFeatures {
    const { classification } = input;
    const scope = classification.scope;

    const referencedCount = input.snapshot.level2?.relevantFiles.length ?? 0;
    const expectedFileCount = Math.max(
      FILES_BY_SCOPE[scope],
      Math.min(referencedCount, FILES_BY_SCOPE[scope] * 2),
    );

    return {
      taskType: classification.taskType,
      classificationConfidence: classification.confidence,
      promptLength: input.prompt.length,
      ambiguity: classification.ambiguity,
      reasoningRequirement: classification.reasoningRequirement,
      novelty: computeNovelty(input.history),
      expectedFileCount,
      expectedToolCalls: TOOL_CALLS_BY_SCOPE[scope],
      risk: classification.risk,
      hazards: classification.hazards,
      scope,
    };
  }

  #repositoryFeatures(snapshot: RepositorySnapshot): RepositoryFeatures {
    const { level1, level2, level3 } = snapshot;

    return {
      fileCount: level1.fileCount,
      totalBytes: level1.totalBytes,
      truncated: level1.truncated,
      primaryLanguage: level1.primaryLanguage,
      frameworks: level1.frameworks,
      isMonorepo: level1.isMonorepo,
      hasContinuousIntegration: level1.hasContinuousIntegration,
      isGitRepository: level1.git.isRepository,

      // Omitted rather than zeroed when git could not answer. A model that has
      // seen "0 files changed" cannot tell a clean tree from a failed query;
      // an absent key says plainly that nobody knows.
      ...(level1.changedFiles === null ? {} : { changedFileCount: level1.changedFiles.length }),
      ...(level1.git.insertions === null || level1.git.deletions === null
        ? {}
        : { diffSize: level1.git.insertions + level1.git.deletions }),

      // Level 2 facts. Undefined until level 2 has actually run.
      ...(level2 === undefined
        ? {}
        : {
            dependencyCount: level2.dependencyCount,
            hasTests: level2.tests.hasTests,
            testFileRatio: level2.tests.testFileRatio,
            // Only defined when a diagnostics source was actually connected.
            ...(level2.diagnostics.observed
              ? { diagnosticErrorCount: level2.diagnostics.errorCount }
              : {}),
          }),

      ...(level3 === undefined ? {} : { dependencyFanOut: level3.maxFanOut }),
    };
  }

  #contextFeatures(input: FeatureExtractionInput, task: TaskFeatures): ContextFeatures {
    const promptTokens = estimateTokens(input.prompt);
    const fileTokens = input.snapshot.level2?.estimatedContextTokens ?? 0;

    const estimatedInputTokens = promptTokens + fileTokens;
    const estimatedOutputTokens = estimateOutputTokens(
      estimatedInputTokens,
      task.expectedFileCount,
    );

    return {
      estimatedInputTokens,
      estimatedOutputTokens,
      // The margin applies here because this is the number compared against a
      // model's context window (spec section 12).
      contextRequirement: withSafetyMargin(estimatedInputTokens + estimatedOutputTokens),
      relevantFileCount: input.snapshot.level2?.relevantFiles.length ?? 0,
      ...(input.snapshot.level3 === undefined
        ? {}
        : { relevantSymbolCount: input.snapshot.level3.edges.length }),
    };
  }

  #historyFeatures(history: TaskHistory | undefined): HistoryFeatures {
    const attempts = history?.attempts ?? [];
    const last = attempts[attempts.length - 1];

    return {
      previousAttempts: attempts.length,
      previousFailures: attempts.filter((attempt) => !attempt.succeeded).length,
      previousEscalations: attempts.filter((attempt) => attempt.escalated).length,
      previousModelId: last?.modelId ?? null,
      attemptedModelIds: [...new Set(attempts.map((attempt) => attempt.modelId))],
      taskTypeObservations: history?.taskTypeObservations ?? 0,
    };
  }
}

/**
 * Novelty in [0, 1].
 *
 * With no history, novelty is 1: nothing has been observed, so the task is
 * maximally unfamiliar. Reporting 0 ("very familiar") on absent data would be
 * fabricated confidence (spec section 39).
 */
function computeNovelty(history: TaskHistory | undefined): number {
  const observations = history?.taskTypeObservations ?? 0;
  if (observations <= 0) return 1;
  // Decays towards 0 as observations accumulate; ~0.5 at 10 observations.
  return Math.min(1, Math.max(0, 10 / (10 + observations)));
}
