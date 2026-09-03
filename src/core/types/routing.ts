/**
 * Routing decision types (spec sections 12, 14, 15, 16 and 50).
 *
 * A decision carries far more than the chosen model. It carries what every
 * candidate scored, why each rejected model was rejected, and the policy that
 * was in force. Without that, a user cannot tell a good decision from a lucky
 * one, and spec section 50 requires that they can.
 */

import type { ModelExclusion } from './eligibility.js';
import type { ModelTier } from './model.js';

/** The thresholds and limits a routing decision must respect. */
export interface RoutingPolicy {
  /** A model is only selectable at or above this estimated success probability. */
  readonly minimumSuccessProbability: number;
  /** Upper bound on estimated risk, in [0, 1]. */
  readonly maxRisk: number;
  /** Upper bound on estimated wall-clock seconds for one attempt. */
  readonly maxLatencySeconds: number;
  /** Spending limit for this single request. Absent means unlimited. */
  readonly requestBudget?: number | undefined;
  /** ISO 4217 currency the budget is denominated in. */
  readonly currency: string;
  /** What to do when nothing satisfies both the budget and the threshold. */
  readonly onBudgetExceeded: 'ask' | 'stop' | 'allow-fallback';
  /** Whether the router may override an explicitly requested model. */
  readonly modelOverrideEnabled: boolean;
}

/**
 * Itemised cost projection for one model (spec sections 1 and 15).
 *
 * Every term of the expected-cost model is exposed, not just the total, so a
 * decision can be checked rather than taken on trust:
 *
 * ```
 * expectedTotalToSuccess = initial
 *                        + failureProbability x recovery
 *
 * recovery               = retryShare      x retry
 *                        + escalationShare x escalation
 * ```
 */
export interface CostProjection {
  /** Cost of the first attempt. */
  readonly initial: number;
  /**
   * Estimated probability this attempt fails, in [0, 1].
   *
   * `1 - successProbability`, carried here so the cost arithmetic is
   * self-contained and auditable.
   */
  readonly failureProbability: number;
  /** Expected cost of retrying this same model after a failure. */
  readonly retry: number;
  /**
   * Expected cost of continuing on a stronger model after this one fails,
   * including the handoff overhead.
   */
  readonly escalation: number;
  /**
   * Expected cost of recovering from a failure, however that happens.
   *
   * A blend of {@link CostProjection.retry} and
   * {@link CostProjection.escalation}, weighted by how often each is the right
   * response.
   */
  readonly recovery: number;
  /**
   * Expected total spend to reach a successful completion.
   *
   * This is the quantity the router minimises (spec section 1), **not**
   * {@link CostProjection.initial}. A model with the cheapest first attempt can
   * easily have the dearest path to success.
   */
  readonly expectedTotalToSuccess: number;
  readonly currency: string;
}

/** Everything the router computed about one eligible model. */
export interface ModelEvaluation {
  readonly modelId: string;
  readonly tier: ModelTier;
  /**
   * Estimated probability of completing the task, in [0, 1].
   *
   * A prior until learning has enough data, an observation-corrected estimate
   * after. {@link ModelEvaluation.learningApplied} says which, and
   * {@link ModelEvaluation.staticSuccessProbability} preserves what the priors
   * alone said, so the two can always be compared.
   */
  readonly successProbability: number;
  /** What the configured priors alone predicted, before any learning. */
  readonly staticSuccessProbability: number;
  /**
   * Real observations informing this model's estimate. Never a pseudo-count.
   *
   * Zero is a normal, honest answer (spec section 2, rule 11).
   */
  readonly observations: number;
  /** Whether learned data actually moved this estimate. */
  readonly learningApplied: boolean;
  /** How well the model's declared strengths match the task, in [0, 1]. */
  readonly capabilityFit: number;
  /**
   * Required context as a fraction of the model's window.
   *
   * Above 1 the model would have been excluded outright; a high value below 1
   * still raises risk.
   */
  readonly contextFit: number;
  /** Estimated risk of choosing this model for this task, in [0, 1]. */
  readonly risk: number;
  readonly estimatedLatencySeconds: number;
  readonly cost: CostProjection;
  /** The model this one would escalate to on failure, or null if it is the strongest. */
  readonly escalationTargetId: string | null;
  readonly meetsThreshold: boolean;
  readonly withinBudget: boolean;
  readonly withinRisk: boolean;
  readonly withinLatency: boolean;
  /** True when every policy constraint is satisfied. */
  readonly viable: boolean;
  /**
   * Whether the success estimate rested on a tier default because the model
   * declared no prior for this task's skill.
   *
   * Surfaced so a confident-looking number is not mistaken for a
   * well-grounded one (spec section 39).
   */
  readonly usedTierDefault: boolean;
}

/**
 * What the contextual bandit decided (spec section 40).
 *
 * Present on every decision, whether or not exploration is switched on, so a
 * user can always see that it did not happen and why.
 */
export interface ExplorationSummary {
  /** True when the selected model differs from the exploiting choice. */
  readonly explored: boolean;
  /** What expected-cost routing would have chosen. */
  readonly exploitModelId: string | null;
  /** Estimated extra cost of the experiment, or `null` when not exploring. */
  readonly premium: number | null;
  /** Stable id of the blocking condition, or `null` when exploration was permitted. */
  readonly blockedBy: string | null;
  readonly reason: string;
}

/** How a routing attempt concluded. */
export const ROUTING_OUTCOMES = [
  'selected',
  'selected-explicit',
  'selected-over-budget',
  'selected-below-threshold',
  'no-eligible-model',
  'explicit-model-unknown',
  'explicit-model-ineligible',
  'no-model-meets-threshold',
  'no-model-satisfies-policy',
  'stopped',
  'ask-user',
] as const;

/** How a routing attempt concluded. */
export type RoutingOutcome = (typeof ROUTING_OUTCOMES)[number];

/** The complete, explainable result of routing one request. */
export interface RoutingDecision {
  /** The chosen model, or null when nothing could be chosen safely. */
  readonly selectedModelId: string | null;
  readonly outcome: RoutingOutcome;
  /** One-line summary, suitable for a status bar. */
  readonly reason: string;
  /** Full justification, one point per line (spec section 50). */
  readonly explanation: readonly string[];
  /** Every eligible model with its scores, ordered by expected total cost. */
  readonly evaluations: readonly ModelEvaluation[];
  /** Every model removed by the hard filter, each with a reason. */
  readonly excluded: readonly ModelExclusion[];
  /**
   * What the contextual bandit decided.
   *
   * Always present. When exploration is off or refused, this records that fact
   * and the reason, so "no experiment happened" is an auditable statement
   * rather than an absence.
   */
  readonly exploration: ExplorationSummary;
  /** The tier the static cold-start prior suggests for this task (spec section 13). */
  readonly staticTierPrior: ModelTier;
  /** The policy that was in force. */
  readonly policy: RoutingPolicy;
  /**
   * True when the selection knowingly exceeds the request budget.
   *
   * Only ever true when the configured behaviour permits it. A budget is never
   * exceeded silently (spec section 16).
   */
  readonly budgetExceeded: boolean;
  /** True when the router did not use the model the user explicitly asked for. */
  readonly overrodeExplicitRequest: boolean;
}
