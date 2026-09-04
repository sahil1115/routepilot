/**
 * Learning types (spec sections 35-37, 39).
 *
 * Learns one thing: P(success | features, model), feeding the same
 * expected-cost arithmetic that already decides routes.
 *
 * Three invariants: sample counts are real observations and never include
 * prior pseudo-counts (rule 11); absent is unknown, not zero; and learning
 * cannot move a decision below `minimumTrainingSamples` (rule 12).
 */

import type { TaskScope } from './features.js';
import type { TaskType } from './task.js';

/**
 * The bucket an observation belongs to.
 *
 * Deliberately coarse: keying on the full feature vector would give every
 * request its own bucket and never accumulate two observations in one place.
 */
export interface LearningContext {
  readonly modelId: string;
  readonly taskType: TaskType;
  readonly scope: TaskScope;
  /**
   * Primary language, or `'unknown'`.
   *
   * Static priors already discriminate by language, so pooling languages would
   * shrink a language-aware prior toward a language-blind rate. Normalised,
   * never a raw path; repository identity is excluded because it would make
   * every bucket a sample of one.
   */
  readonly language: string;
}

/**
 * One admitted outcome, ready to be learned from.
 *
 * Built by the caller, not derived inside the model: attribution is a
 * judgement, and `observationFromOutcome` refuses to credit an escalated task
 * to any single model.
 */
export interface Observation extends LearningContext {
  /** Success in [0, 1]. Fractional: code that builds but fails tests is neither. */
  readonly success: number;
  /** How much of the possible evidence backed that score, in [0, 1]. */
  readonly evidence: number;
}

/**
 * Accumulated evidence for one bucket.
 *
 * Stored at the finest granularity only; coarser views are summed at read time,
 * so nothing is double-counted and no aggregate can drift from its parts.
 */
export interface LearnedStats extends LearningContext {
  /** Real admitted outcomes. Always an integer, never prior pseudo-counts. */
  readonly observations: number;
  /** Sum of `success`, in [0, observations]. Mass, not a mean, so merging is addition. */
  readonly successMass: number;
  /** Last update, for inspection only. Never used in estimation. */
  readonly updatedAt: number;
}

/** One level of the backoff hierarchy, exposed so an estimate can be audited. */
export interface LearnedLevel {
  /**
   * Coarsest first. The four levels are disjoint -- each counts only what the
   * deeper ones exclude -- so every observation enters the chain exactly once.
   */
  readonly level: 'model' | 'task' | 'scope' | 'language';
  /** Real observations aggregated at this level. */
  readonly observations: number;
  /** Observed success rate at this level, or `null` with no observations. */
  readonly observedRate: number | null;
  /** Posterior mean after shrinking this level's data toward the level above. */
  readonly posterior: number;
}

/**
 * A success probability with its provenance: the prior, the posterior, the
 * evidence behind it, and whether any of it changed the answer.
 */
export interface LearnedEstimate {
  /** The probability routing should use. */
  readonly probability: number;
  /** What the static priors alone said. */
  readonly staticProbability: number;
  /** Whether learning moved the estimate. False if disabled, starved, or unchanged. */
  readonly applied: boolean;
  /** Total real observations for this model, across all task types. */
  readonly observations: number;
  /** Per-level breakdown, coarsest first. Empty when learning did not apply. */
  readonly levels: readonly LearnedLevel[];
  /** Why learning did or did not apply, in one phrase. */
  readonly reason: string;
}

/**
 * Persistence for learned statistics.
 *
 * The model holds statistics in memory and writes through, so routing never
 * waits on I/O and a failed write cannot fail a user's task.
 */
export interface LearningStore {
  /** Whether this store actually persists anything. */
  readonly enabled: boolean;
  /** Load every bucket. Order is not significant; the model sorts. */
  loadLearnedStats(): readonly LearnedStats[];
  /** Insert or replace the given buckets. */
  saveLearnedStats(stats: readonly LearnedStats[]): void;
}
