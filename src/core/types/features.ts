/**
 * Task classification and routing features (spec sections 9 and 11).
 */

import type { TaskType } from './task.js';

/**
 * Named hazards a task carries (spec sections 14 and 40).
 *
 * The classifier already detects each of these while computing task risk; it
 * used to collapse them into a single number and throw the labels away. They
 * are kept because a scalar cannot answer the question safety rules actually
 * ask. "Risk 0.62" does not say whether the task deletes data or merely touches
 * a large repository, and exploration must refuse the first regardless of where
 * the arithmetic lands.
 */
export const TASK_HAZARDS = [
  'production',
  'destructive',
  'security',
  'credentials',
  'data-migration',
  'payments',
] as const;

/** A named hazard a task carries. */
export type TaskHazard = (typeof TASK_HAZARDS)[number];

/** How much of the repository a task is expected to touch. */
export const TASK_SCOPES = ['single-file', 'few-files', 'many-files', 'repository-wide'] as const;

/** How much of the repository a task is expected to touch. */
export type TaskScope = (typeof TASK_SCOPES)[number];

/** One piece of evidence that contributed to a classification. */
export interface ClassificationSignal {
  /** Stable id of the rule that fired. */
  readonly rule: string;
  /** Task type the evidence supports. */
  readonly taskType: TaskType;
  /** Weight contributed. */
  readonly weight: number;
  /** Human-readable justification, shown verbatim in explanations. */
  readonly reason: string;
}

/** A task type and the score it accumulated. */
export interface ScoredTaskType {
  readonly taskType: TaskType;
  readonly score: number;
}

/**
 * The result of classifying a task.
 *
 * Classification is deterministic and interpretable: every point of score is
 * traceable to a named rule in {@link TaskClassification.signals}. That is what
 * makes a routing decision explainable (spec section 50), and it is why V1 uses
 * scored rules rather than a model.
 */
export interface TaskClassification {
  readonly taskType: TaskType;
  /**
   * Confidence in [0, 1]: the winning type's share of total evidence.
   *
   * Low confidence is a real answer. It feeds ambiguity, which is a reason to
   * ask the user rather than to spend money guessing (spec section 26).
   */
  readonly confidence: number;
  /**
   * Ambiguity in [0, 1].
   *
   * High when the top candidates are close together, or when almost no
   * evidence was found at all.
   */
  readonly ambiguity: number;
  /** Runner-up classifications, best first. */
  readonly alternatives: readonly ScoredTaskType[];
  /** Every rule that fired, for explanation and debugging. */
  readonly signals: readonly ClassificationSignal[];
  readonly scope: TaskScope;
  /** How much reasoning the task appears to demand, in [0, 1]. */
  readonly reasoningRequirement: number;
  /** Estimated risk of the change, in [0, 1]. */
  readonly risk: number;
  /** Named hazards detected in the prompt, in a stable order. */
  readonly hazards: readonly TaskHazard[];
}

/** Task-shaped routing features. */
export interface TaskFeatures {
  readonly taskType: TaskType;
  readonly classificationConfidence: number;
  readonly promptLength: number;
  readonly ambiguity: number;
  readonly reasoningRequirement: number;
  /**
   * How unfamiliar this task is, in [0, 1].
   *
   * 1 means nothing comparable has been seen. With no history supplied it is 1,
   * because "no data" is not the same as "familiar".
   */
  readonly novelty: number;
  readonly expectedFileCount: number;
  readonly expectedToolCalls: number;
  readonly risk: number;
  /**
   * Named hazards, carried through from classification.
   *
   * Consumed by the exploration gate, which must be able to refuse a
   * destructive or production task on the hazard itself rather than on a risk
   * score that might happen to fall below a threshold.
   */
  readonly hazards: readonly TaskHazard[];
  readonly scope: TaskScope;
}

/** Repository-shaped routing features. */
export interface RepositoryFeatures {
  readonly fileCount: number;
  readonly totalBytes: number;
  /** True when the file count is a lower bound rather than exact. */
  readonly truncated: boolean;
  readonly primaryLanguage: string | null;
  readonly frameworks: readonly string[];
  readonly isMonorepo: boolean;
  /** Maximum outgoing imports from any one file. Undefined until level 3. */
  readonly dependencyFanOut?: number | undefined;
  /** Declared direct dependencies. Undefined until level 2. */
  readonly dependencyCount?: number | undefined;
  /** Undefined until level 2 — not the same as "no tests". */
  readonly hasTests?: boolean | undefined;
  readonly testFileRatio?: number | undefined;
  readonly hasContinuousIntegration: boolean;
  /** Undefined when no diagnostics source is connected. */
  readonly diagnosticErrorCount?: number | undefined;
  /** Undefined when the status query failed — not the same as "nothing changed". */
  readonly changedFileCount?: number | undefined;
  /** Lines added plus removed among tracked files. Undefined when not countable. */
  readonly diffSize?: number | undefined;
  readonly isGitRepository: boolean;
}

/** Context-shaped routing features. */
export interface ContextFeatures {
  /**
   * Estimated input tokens.
   *
   * An estimate from byte counts, not a tokenizer result. Consumers must treat
   * it as approximate (see `estimateTokens`).
   */
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  /** Total context the request is expected to need. */
  readonly contextRequirement: number;
  readonly relevantFileCount: number;
  /** Undefined until level 3. */
  readonly relevantSymbolCount?: number | undefined;
}

/** A previous attempt at the same task. */
export interface AttemptRecord {
  readonly modelId: string;
  readonly succeeded: boolean;
  readonly escalated: boolean;
  /** Failure classification, when the attempt failed. */
  readonly failureType?: string | undefined;
}

/** History supplied by the caller. Absent history means unknown, never zero risk. */
export interface TaskHistory {
  readonly attempts: readonly AttemptRecord[];
  /** How often this task type has been seen before in this repository. */
  readonly taskTypeObservations?: number | undefined;
}

/** History-shaped routing features. */
export interface HistoryFeatures {
  readonly previousAttempts: number;
  readonly previousFailures: number;
  readonly previousEscalations: number;
  readonly previousModelId: string | null;
  /** Models already tried, so the router does not repeat a failure. */
  readonly attemptedModelIds: readonly string[];
  readonly taskTypeObservations: number;
}

/**
 * The complete feature vector the routing engine consumes.
 *
 * Execution features (tool failures, edit churn, time without progress) are
 * deliberately absent: they only exist once execution has started, and they
 * arrive with the execution monitor in Phase 8.
 */
export interface RoutingFeatures {
  readonly task: TaskFeatures;
  readonly repository: RepositoryFeatures;
  readonly context: ContextFeatures;
  readonly history: HistoryFeatures;
  /** The analysis level the repository features were derived from. */
  readonly analysisLevel: number;
}
