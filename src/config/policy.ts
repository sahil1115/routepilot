/**
 * Bridge from a validated configuration to a routing policy.
 *
 * The core defines `RoutingPolicy` and knows nothing about configuration files;
 * this is the single place the two meet. Keeping the mapping here is what lets
 * the routing engine be tested with hand-written policies and keeps the core
 * free of any dependency on the config layer.
 */

import type { ExplorationPolicy } from '../core/bandit/exploration-gate.js';
import type { CalibrationThresholds } from '../core/types/calibration.js';
import type { LearningPolicy } from '../core/learning/success-model.js';
import type { RoutingPolicy } from '../core/types/routing.js';
import type { EscalationLimits } from '../core/types/escalation.js';
import type { RoutePilotConfig } from './types.js';

/** Build the routing policy a configuration implies. */
export function toRoutingPolicy(config: RoutePilotConfig): RoutingPolicy {
  const { routing, budgets } = config;

  return {
    minimumSuccessProbability: routing.minimumSuccessProbability,
    maxRisk: routing.maxRisk,
    maxLatencySeconds: routing.maxLatencySeconds,
    // An absent budget means "not limited at this scope", never zero.
    ...(budgets.request === undefined ? {} : { requestBudget: budgets.request }),
    currency: budgets.currency,
    onBudgetExceeded: budgets.onExceeded,
    modelOverrideEnabled: routing.modelOverrideEnabled,
  };
}

/**
 * Build the escalation limits a configuration implies (spec section 27).
 *
 * Until Phase 24 nothing converted these, so `maxEscalationsPerTask` and
 * `maxRetriesPerModel` were validated, documented and then ignored in favour of
 * the runner's built-in defaults — which happened to equal the example
 * configuration, so no test noticed. `budgets.request` is mapped to
 * `maxTotalCost`: a request budget that bounded model selection but not the
 * spend across retries and escalations was not a budget.
 */
export function toEscalationLimits(config: RoutePilotConfig): EscalationLimits {
  const { routing, budgets } = config;

  return {
    maxEscalationsPerTask: routing.maxEscalationsPerTask,
    maxRetriesPerModel: routing.maxRetriesPerModel,
    // Absent means unlimited at this scope, never zero.
    ...(budgets.request === undefined ? {} : { maxTotalCost: budgets.request }),
    ...(routing.maxExecutionTimeMs === undefined
      ? {}
      : { maxExecutionTimeMs: routing.maxExecutionTimeMs }),
  };
}

/**
 * Build the learning policy a configuration implies.
 *
 * Both fields are gates, not hints. `enabled` false means learned data is not
 * consulted at all; `minimumTrainingSamples` means it is not consulted until
 * there is enough of it (spec section 2, rule 12).
 */
export function toLearningPolicy(config: RoutePilotConfig): LearningPolicy {
  return {
    enabled: config.learning.enabled,
    minimumTrainingSamples: config.learning.minimumTrainingSamples,
  };
}

/** Build the calibration thresholds a configuration implies. */
export function toCalibrationThresholds(config: RoutePilotConfig): CalibrationThresholds {
  const { calibration } = config.learning;
  return {
    minimumSamples: calibration.minimumSamples,
    maxExpectedCalibrationError: calibration.maxExpectedCalibrationError,
    maxCalibrationError: calibration.maxCalibrationError,
    minimumBrierSkillScore: calibration.minimumBrierSkillScore,
    requireCalibration: calibration.requireCalibration,
  };
}

/**
 * Build the exploration policy a configuration implies.
 *
 * Every field is a narrowing. Nothing here can permit an experiment the safety
 * gate would refuse — the gate's hazard, mode and explicit-model checks are not
 * configurable (spec section 40).
 */
export function toExplorationPolicy(config: RoutePilotConfig): ExplorationPolicy {
  const { exploration } = config.learning;
  return {
    // Exploration needs learning: without it every estimate is a fixed prior
    // and there is nothing an experiment could update.
    enabled: config.learning.enabled && exploration.enabled,
    minimumObservations: exploration.minimumObservations,
    maxRisk: exploration.maxRisk,
    maxCostPremium: exploration.maxCostPremium,
    optimism: exploration.optimism,
  };
}
