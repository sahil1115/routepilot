/**
 * Risk estimation (spec section 14).
 *
 * Distinct from the task risk the classifier produces. That measures how
 * dangerous the *task* is; this measures how risky it is to attempt that task
 * **with this particular model**. A destructive migration is dangerous whoever
 * does it, but attempting it with a model that will probably fail part-way
 * through — leaving the workspace half-migrated — is worse.
 */

import type { RoutingFeatures } from '../types/features.js';
import type { ModelSpec } from '../types/model.js';

/** Contributions to the combined risk score. They sum to 1. */
const WEIGHTS = {
  taskRisk: 0.4,
  failureProbability: 0.35,
  contextPressure: 0.15,
  degradedAvailability: 0.1,
} as const;

/**
 * Extra risk when a task is broad.
 *
 * A partial failure across many files leaves a workspace in a worse state than
 * a partial failure in one, because the change is harder to reason about and
 * harder to undo.
 */
const BREADTH_PENALTY = 0.1;

/** Scores how risky a given model is for a given task. */
export class RiskEstimator {
  /**
   * Combined risk in [0, 1].
   *
   * @param successProbability The model's estimated probability of success.
   */
  estimate(model: ModelSpec, features: RoutingFeatures, successProbability: number): number {
    const contextPressure =
      model.contextWindow <= 0
        ? 1
        : clamp(features.context.contextRequirement / model.contextWindow);

    let risk =
      WEIGHTS.taskRisk * features.task.risk +
      WEIGHTS.failureProbability * (1 - successProbability) +
      WEIGHTS.contextPressure * contextPressure +
      WEIGHTS.degradedAvailability * (model.availability === 'degraded' ? 1 : 0);

    const broad = features.task.scope === 'many-files' || features.task.scope === 'repository-wide';
    if (broad) {
      // Breadth multiplies the consequence of an incomplete attempt, so it is
      // weighted by how likely that attempt is to fail.
      risk += BREADTH_PENALTY * (1 - successProbability);
    }

    return clamp(risk);
  }
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
