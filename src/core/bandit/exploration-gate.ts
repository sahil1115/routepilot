/**
 * The exploration safety gate (spec section 40).
 *
 * Exploration means deliberately choosing a model the router does not believe
 * is best. That is reasonable for a rename in a scratch branch and
 * indefensible for a production database migration, so this file lists the
 * places it must never happen.
 *
 * Every block is hard. There is no scoring and no combination of favourable
 * conditions that overrides one; the gate returns the first reason it finds.
 *
 * | condition | why |
 * | --- | --- |
 * | high risk | a failed experiment on a risky task is a cost, not a data point |
 * | budget disallows it | information is worth paying for, but not unboundedly |
 * | user picked a model | an explicit choice is a decision, not a hint (rule 8) |
 * | production / critical | the wrong place to find out something new |
 * | destructive task | a failure may not be recoverable, so nothing is learned |
 *
 * `enabled` defaults to false and `minimumObservations` gates it even when
 * switched on. Exploring before there is anything to compare against is
 * guessing: with no observations every model looks equally uncertain, so the
 * bandit would pick on optimism alone and reliably choose whichever model has
 * the widest posterior (section 40; principles 9 and 12).
 */

import type { RoutingFeatures, TaskHazard } from '../types/features.js';
import type { RoutingPolicy } from '../types/routing.js';

/** How RoutePilot is being operated. */
export const OPERATION_MODES = ['normal', 'production', 'critical'] as const;

/**
 * How RoutePilot is being operated.
 *
 * `normal` is a developer's own workspace. `production` and `critical` both
 * forbid exploration outright; they are distinguished only so a user can say
 * which one they meant, and so the refusal message is accurate.
 */
export type OperationMode = (typeof OPERATION_MODES)[number];

/** Hazards that forbid exploration whatever the risk score says. */
export const EXPLORATION_BLOCKING_HAZARDS: readonly TaskHazard[] = [
  'destructive',
  'production',
  'data-migration',
  'security',
  'credentials',
  'payments',
];

/** Settings governing when exploration is permitted. */
export interface ExplorationPolicy {
  /** Whether exploration may ever occur. Defaults to false. */
  readonly enabled: boolean;
  /**
   * Observations required for a model before it may be explored *away from*.
   *
   * "Only after enough data exists." Below this the router does not yet have a
   * baseline worth deviating from.
   */
  readonly minimumObservations: number;
  /** Task risk above which exploration is refused, in [0, 1]. */
  readonly maxRisk: number;
  /**
   * How much more than the exploiting choice an experiment may cost, as a
   * fraction.
   *
   * This is the price of information, and it is capped rather than unbounded.
   * At 0.25 the router will pay a quarter more than the safe option to learn
   * something, and not a penny beyond.
   */
  readonly maxCostPremium: number;
  /** Standard deviations of benefit of the doubt given to an unexplored model. */
  readonly optimism: number;
}

/** Exploration switched off — the default everywhere. */
export const EXPLORATION_DISABLED: ExplorationPolicy = {
  enabled: false,
  minimumObservations: 200,
  maxRisk: 0.3,
  maxCostPremium: 0.25,
  optimism: 1.5,
};

/** Everything the gate needs that is not in the routing features. */
export interface ExplorationContext {
  readonly mode: OperationMode;
  /** True when the user named a model explicitly. */
  readonly explicitModelRequested: boolean;
  /** Total real observations available for this task's context. */
  readonly totalObservations: number;
  /** Whether the calibration safeguard permits learned estimates at all. */
  readonly calibrationPermits: boolean;
}

/** Why exploration was or was not permitted. */
export interface ExplorationVerdict {
  readonly allowed: boolean;
  /** Stable identifier of the blocking condition, or `null` when allowed. */
  readonly blockedBy: ExplorationBlock | null;
  /** One sentence a user can act on. */
  readonly reason: string;
}

/** Stable identifiers for every reason exploration can be refused. */
export const EXPLORATION_BLOCKS = [
  'disabled',
  'insufficient-data',
  'uncalibrated',
  'explicit-model',
  'operation-mode',
  'hazardous-task',
  'high-risk',
  'no-budget-headroom',
] as const;

/** A reason exploration was refused. */
export type ExplorationBlock = (typeof EXPLORATION_BLOCKS)[number];

/**
 * Decide whether exploration is permitted for this request at all.
 *
 * Checked before any candidate is considered, so an unsafe request cannot be
 * explored regardless of how attractive some model's confidence bound looks.
 * Budget headroom is checked separately by the explorer, once the cost of the
 * exploiting choice is known — but a policy with no premium at all is refused
 * here, because then no experiment can ever be afforded.
 *
 * Order matters only for the message: the first block found is reported, and
 * the most fundamental prerequisites are checked first so the advice is the
 * most useful one available.
 */
export function assessExploration(
  policy: ExplorationPolicy,
  features: RoutingFeatures,
  context: ExplorationContext,
  routing: RoutingPolicy,
): ExplorationVerdict {
  const block = (blockedBy: ExplorationBlock, reason: string): ExplorationVerdict => ({
    allowed: false,
    blockedBy,
    reason,
  });

  if (!policy.enabled) {
    return block('disabled', 'exploration is disabled');
  }

  // "Only after enough data exists." Exploring with nothing to compare against
  // is not exploration; it is choosing the widest posterior every time.
  if (context.totalObservations < policy.minimumObservations) {
    return block(
      'insufficient-data',
      `only ${String(context.totalObservations)} of ${String(policy.minimumObservations)} observations needed before exploring`,
    );
  }

  // A predictor whose probabilities have been measured and found wrong cannot
  // be used to decide what is worth exploring either (Phase 11).
  if (!context.calibrationPermits) {
    return block('uncalibrated', 'success predictions are not currently trusted');
  }

  // An explicit choice is a decision, not a hint (spec section 2, rule 8).
  // Substituting a different model to satisfy the router's curiosity would be
  // exactly the silent override that rule forbids.
  if (context.explicitModelRequested) {
    return block('explicit-model', 'a model was explicitly requested');
  }

  if (context.mode !== 'normal') {
    return block(
      'operation-mode',
      `operating in ${context.mode} mode, which is not a place to try something new`,
    );
  }

  // Matched on the hazard, not the risk score. A destructive task that happens
  // to score below the risk threshold is still destructive.
  const hazard = features.task.hazards.find((candidate) =>
    EXPLORATION_BLOCKING_HAZARDS.includes(candidate),
  );
  if (hazard !== undefined) {
    return block(
      'hazardous-task',
      `the task is ${hazard}, where a failed experiment is not undoable`,
    );
  }

  if (features.task.risk > policy.maxRisk) {
    return block(
      'high-risk',
      `task risk ${(features.task.risk * 100).toFixed(0)}% is above the ${(policy.maxRisk * 100).toFixed(0)}% exploration limit`,
    );
  }

  // A premium of zero means no experiment can ever be afforded, which is a
  // configuration saying "do not explore" in a roundabout way. Reported as a
  // budget block so the message points at the setting that caused it.
  if (policy.maxCostPremium <= 0) {
    return block('no-budget-headroom', 'the exploration cost premium is zero');
  }

  if (routing.requestBudget !== undefined && routing.requestBudget <= 0) {
    return block('no-budget-headroom', 'the request budget leaves no room to experiment');
  }

  return { allowed: true, blockedBy: null, reason: 'exploration is permitted for this request' };
}
