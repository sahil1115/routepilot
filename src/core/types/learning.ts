/**
 * Learning types (spec sections 35, 36, 37 and 39).
 *
 * Phase 10 learns exactly one thing: **P(success | features, model)**. Not a
 * bandit, not a policy, not a value function — a calibrated probability that
 * replaces a guessed prior with an observed rate, and feeds the same
 * expected-cost arithmetic that was already deciding routes in Phase 9.
 *
 * Three rules shape every type in this file, and each exists because the
 * specification forbids a specific dishonesty:
 *
 * 1. **A sample count is a count of real observations.** Bayesian shrinkage
 *    works by treating a prior as if it were pseudo-observations, and it would
 *    be trivial — and completely wrong — to report that pseudo-count as data.
 *    {@link LearnedStats.observations} is an integer count of admitted
 *    outcomes and nothing else (spec section 2, rule 11).
 * 2. **Absent is not zero.** A model with no observations has an *unknown*
 *    success rate, not a zero one. It falls back to its configured prior.
 * 3. **Learning is off until it has earned the right to be on.** Below
 *    `minimumTrainingSamples`, a learned estimate must not move a routing
 *    decision at all (spec section 2, rule 12).
 */

import type { TaskScope } from './features.js';
import type { TaskType } from './task.js';

/**
 * The bucket an observation belongs to.
 *
 * Deliberately coarse. Learning `P(success | exact feature vector, model)`
 * directly would give every request its own bucket and never accumulate two
 * observations in the same place. Task type and scope are the two features that
 * most change what a model is being asked to do, and both are already
 * classified deterministically upstream.
 */
export interface LearningContext {
  readonly modelId: string;
  readonly taskType: TaskType;
  readonly scope: TaskScope;
}

/**
 * One admitted outcome, ready to be learned from.
 *
 * Constructed by the caller rather than derived from a `TaskOutcome` inside the
 * model, because attribution is a judgement — see `observationFromOutcome`,
 * which refuses to attribute an escalated task to any single model.
 */
export interface Observation extends LearningContext {
  /**
   * How successful the task was, in [0, 1].
   *
   * Fractional because success is multi-dimensional (Phase 8): code that builds
   * and lints but fails its tests is not a total loss and not a win.
   */
  readonly success: number;
  /** How much of the possible evidence backed that score, in [0, 1]. */
  readonly evidence: number;
}

/**
 * Accumulated evidence for one bucket.
 *
 * Stored at the finest granularity only — `(modelId, taskType, scope)`. Coarser
 * views are summed at read time, so a single observation is never counted twice
 * and no aggregate can drift out of step with its parts.
 */
export interface LearnedStats extends LearningContext {
  /**
   * Number of real admitted outcomes. An integer, always.
   *
   * Never includes prior pseudo-counts. This is the number a user is shown when
   * they ask how much RoutePilot actually knows.
   */
  readonly observations: number;
  /**
   * Sum of `success` over those observations, in [0, observations].
   *
   * Kept as mass rather than a mean so that merging two buckets is addition.
   */
  readonly successMass: number;
  /** Last update, for inspection only. Never used in estimation. */
  readonly updatedAt: number;
}

/** One level of the backoff hierarchy, exposed so an estimate can be audited. */
export interface LearnedLevel {
  /** `model`, `model+task`, or `model+task+scope`. */
  readonly level: 'model' | 'task' | 'scope';
  /** Real observations aggregated at this level. */
  readonly observations: number;
  /** Observed success rate at this level, or `null` with no observations. */
  readonly observedRate: number | null;
  /** Posterior mean after shrinking this level's data toward the level above. */
  readonly posterior: number;
}

/**
 * A success probability with its provenance.
 *
 * Every field answers a question a user is entitled to ask about a routing
 * decision: what did you think before, what do you think now, how much do you
 * actually know, and did any of it change the answer.
 */
export interface LearnedEstimate {
  /** The probability routing should use. */
  readonly probability: number;
  /** What the static priors alone said. */
  readonly staticProbability: number;
  /**
   * Whether learning moved the estimate.
   *
   * False when learning is disabled, when there are too few observations, or
   * when the posterior happens to equal the prior.
   */
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
 * Separate from the estimate path on purpose: the model holds its statistics in
 * memory and writes through, so a routing decision never waits on I/O and a
 * failed write can never fail a user's task.
 */
export interface LearningStore {
  /** Whether this store actually persists anything. */
  readonly enabled: boolean;
  /** Load every bucket. Order is not significant; the model sorts. */
  loadLearnedStats(): readonly LearnedStats[];
  /** Insert or replace the given buckets. */
  saveLearnedStats(stats: readonly LearnedStats[]): void;
}
