/**
 * Shadow policy types (spec sections 42, 43 and 44).
 *
 * A shadow policy answers "what would a different router have done?" without
 * spending anything. The current policy decides and executes; shadow policies
 * decide and are recorded.
 *
 * Non-execution is structural: `ShadowRouter` is built from a model registry
 * and nothing else, `src/core/**` may not import `src/adapters/**` (enforced by
 * an architectural test), and a shadow outcome carries a model id rather than a
 * session, so there is no handle to execute by mistake.
 *
 * A shadow comparison can tell you how often two policies disagree, which
 * models a candidate prefers, and what the difference costs under current
 * estimates. It cannot tell you the shadow policy is better: its model never
 * ran, and the delta is computed from the same success probabilities that
 * produced the live decision, so miscalibration moves both sides together.
 *
 * Every quantity here is therefore named as an estimate, and
 * {@link ShadowOutcome.estimatedCostDelta} is `null` when either side selected
 * nothing rather than being reported as a saving (spec section 44).
 */

import type { ModelTier } from './model.js';
import type { RoutingDecision, RoutingPolicy } from './routing.js';

/** How a policy picks among the candidates that satisfy it. */
export const SELECTION_RULES = ['expected-cost', 'cheapest-first', 'strongest-first'] as const;

/**
 * How a policy picks among the candidates that satisfy it.
 *
 * `expected-cost` is production behaviour. The other two exist as baselines
 * (spec section 42): a router that cannot beat "always use the cheap model" or
 * "always use the best model" is not earning its complexity.
 */
export type SelectionRule = (typeof SELECTION_RULES)[number];

/** Whether a shadow policy sees what has been learned. */
export const SHADOW_LEARNING_MODES = ['inherit', 'disabled'] as const;

/**
 * Whether a shadow policy sees what has been learned.
 *
 * `disabled` runs the policy on configured priors alone, which makes
 * "is learning actually changing anything?" a question with an answer.
 */
export type ShadowLearningMode = (typeof SHADOW_LEARNING_MODES)[number];

/** A policy to evaluate alongside the live one. */
export interface ShadowPolicySpec {
  /** Stable id, used as the persistence key. */
  readonly id: string;
  /** One line explaining what this policy is for. */
  readonly description: string;
  readonly rule: SelectionRule;
  /** Changes applied on top of the live policy. Absent means "same limits". */
  readonly policyOverrides?: Partial<RoutingPolicy> | undefined;
  readonly learning: ShadowLearningMode;
}

/** What one shadow policy would have done. */
export interface ShadowOutcome {
  readonly policyId: string;
  readonly description: string;
  /** The model this policy would have chosen, or `null` if it would have stopped. */
  readonly selectedModelId: string | null;
  readonly tier: ModelTier | null;
  /** Whether it chose what the live policy chose. */
  readonly agrees: boolean;
  /**
   * Estimated expected-cost difference, `shadow - current`.
   *
   * Negative looks like a saving. It is **not evidence of one**: both sides come
   * from the same success estimates, so a miscalibrated predictor moves both
   * together. `null` when either side selected nothing — a policy that stops has
   * no cost to compare, and reporting the full cost as a saving would be a lie.
   */
  readonly estimatedCostDelta: number | null;
  /** Estimated difference in success probability, `shadow - current`. */
  readonly successProbabilityDelta: number | null;
  /** The full decision, so a divergence can be explained rather than just counted. */
  readonly decision: RoutingDecision;
}

/** The live decision and every shadow evaluated beside it. */
export interface ShadowComparison {
  /** The decision that will actually be executed. */
  readonly current: RoutingDecision;
  /** Shadow evaluations, in the order their policies were supplied. */
  readonly shadows: readonly ShadowOutcome[];
}

/** One recorded shadow decision. */
export interface ShadowRecord {
  readonly requestId: string;
  readonly policyId: string;
  /** What the live policy chose and actually ran. */
  readonly currentModelId: string | null;
  /** What this shadow policy would have chosen. Never executed. */
  readonly shadowModelId: string | null;
  readonly agrees: boolean;
  readonly estimatedCostDelta: number | null;
  readonly successProbabilityDelta: number | null;
  readonly at: number;
}

/** Aggregate agreement for one policy over recorded history. */
export interface ShadowAgreement {
  readonly policyId: string;
  /** Recorded decisions for this policy. */
  readonly count: number;
  /** How often it chose what the live policy chose. */
  readonly agreements: number;
  /** Agreement as a fraction, or `null` with nothing recorded. */
  readonly agreementRate: number | null;
  /**
   * Summed estimated cost difference over the recorded decisions.
   *
   * An estimate under shared assumptions, never a measured saving. Only the
   * decisions where both policies selected something contribute.
   */
  readonly estimatedCostDelta: number;
  /** Decisions that contributed to the delta. */
  readonly comparableCount: number;
  /** The models this policy preferred when it disagreed, most frequent first. */
  readonly divergentChoices: readonly { readonly modelId: string; readonly count: number }[];
}

/** Persistence for shadow decisions. */
export interface ShadowStore {
  readonly enabled: boolean;
  recordShadowDecisions(records: readonly ShadowRecord[]): void;
  /** Load recent shadow decisions, newest first. */
  loadShadowDecisions(limit: number, policyId?: string): readonly ShadowRecord[];
}
