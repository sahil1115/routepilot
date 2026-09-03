/**
 * The routing engine (spec sections 12, 13, 14, 16 and 50).
 *
 * Selection rule, in order:
 *
 * 1. Apply the hard filter. An impossible model can never be selected.
 * 2. Honour an explicit model request, unless it is impossible.
 * 3. Score every survivor: success probability, risk, latency, and expected
 *    total cost to success.
 * 4. Keep only those meeting the policy's threshold, risk cap, latency cap and
 *    budget.
 * 5. Choose the **cheapest expected path to success** among them — not the
 *    cheapest first attempt.
 * 6. If nothing qualifies, follow the configured behaviour. Never silently
 *    exceed a budget, and never silently pick something below the threshold.
 *
 * **Determinism is a hard requirement.** No clock, no randomness, no iteration
 * over unordered structures. The same inputs always produce byte-identical
 * decisions, including the order of every list in the result.
 */

import type { ModelRegistry } from '../registry/model-registry.js';
import type { RoutingFeatures } from '../types/features.js';
import type { ModelCapabilities, ModelSpec } from '../types/model.js';
import type {
  CostProjection,
  ExplorationSummary,
  ModelEvaluation,
  RoutingDecision,
  RoutingPolicy,
} from '../types/routing.js';
import { LearnedSuccessModel } from '../learning/success-model.js';
import {
  assessExploration,
  EXPLORATION_DISABLED,
  type ExplorationContext,
  type ExplorationPolicy,
} from '../bandit/exploration-gate.js';
import { decideExploration } from '../bandit/explorer.js';
import { ConstraintEngine, type ConstraintOptions } from './constraint-engine.js';
import { CostEstimator, estimateLatencySeconds } from './cost-estimator.js';
import { explainDecision } from './explain.js';
import { RiskEstimator } from './risk-estimator.js';
import { staticTierPrior, tierRank } from './static-priors.js';
import { SuccessPredictor } from './success-predictor.js';

/** A request to route. */
export interface RoutingRequest {
  readonly features: RoutingFeatures;
  readonly policy: RoutingPolicy;
  /**
   * A model the user explicitly asked for.
   *
   * Honoured whenever it is viable. Never silently swapped (spec section 2,
   * rule 8).
   */
  readonly requestedModelId?: string | undefined;
  readonly requiredCapabilities?: Readonly<Partial<ModelCapabilities>> | undefined;
  readonly excludeModelIds?: readonly string[] | undefined;
  readonly optInModelIds?: readonly string[] | undefined;
  readonly providerIds?: readonly string[] | undefined;
  readonly allowDegraded?: boolean | undefined;
  /**
   * How RoutePilot is being operated.
   *
   * Defaults to `production`, not `normal`. A caller that has not said where it
   * is running gets the cautious reading, so forgetting to pass this can only
   * ever suppress an experiment, never authorise one (spec section 40).
   */
  readonly operationMode?: ExplorationContext['mode'] | undefined;
}

/** Selects a model deterministically from configured priors. */
export class RoutingEngine {
  readonly #models: ModelRegistry;
  readonly #constraints: ConstraintEngine;
  readonly #success: SuccessPredictor;
  readonly #risk: RiskEstimator;
  readonly #cost: CostEstimator;
  readonly #learned: LearnedSuccessModel;
  readonly #exploration: ExplorationPolicy;

  /**
   * @param learned Learned success model. Defaults to one that is switched off
   *   and holds nothing, so routing behaves exactly as it did before Phase 10
   *   unless learning is deliberately configured and has enough data.
   */
  constructor(
    models: ModelRegistry,
    learned: LearnedSuccessModel = new LearnedSuccessModel(),
    exploration: ExplorationPolicy = EXPLORATION_DISABLED,
  ) {
    this.#models = models;
    this.#constraints = new ConstraintEngine(models);
    this.#success = new SuccessPredictor();
    this.#risk = new RiskEstimator();
    this.#cost = new CostEstimator();
    this.#learned = learned;
    this.#exploration = exploration;
  }

  /** Route one request. Always returns a decision; never throws for a routine outcome. */
  route(request: RoutingRequest): RoutingDecision {
    const { features, policy } = request;
    const prior = staticTierPrior(features.task.taskType, features.task.scope);

    const constraintOptions: ConstraintOptions = {
      ...(request.requiredCapabilities === undefined
        ? {}
        : { requiredCapabilities: request.requiredCapabilities }),
      ...(request.excludeModelIds === undefined
        ? {}
        : { excludeModelIds: request.excludeModelIds }),
      ...(request.optInModelIds === undefined ? {} : { optInModelIds: request.optInModelIds }),
      ...(request.providerIds === undefined ? {} : { providerIds: request.providerIds }),
      ...(request.allowDegraded === undefined ? {} : { allowDegraded: request.allowDegraded }),
    };

    const { eligible, excluded } = this.#constraints.filter(features, constraintOptions);
    const evaluations = this.#evaluate(eligible, features, policy);

    const base = {
      excluded,
      evaluations,
      staticTierPrior: prior,
      policy,
    };

    // ---- Explicit model request -------------------------------------------
    if (request.requestedModelId !== undefined) {
      const explicit = this.#routeExplicit(request.requestedModelId, evaluations, base, request);
      if (explicit !== null) return explicit;
      // Falls through only when override is enabled and the request is not
      // viable; normal selection then applies, flagged as an override.
    }

    const overrode = request.requestedModelId !== undefined;

    if (evaluations.length === 0) {
      return finish({
        ...base,
        selectedModelId: null,
        outcome: 'no-eligible-model',
        budgetExceeded: false,
        overrodeExplicitRequest: overrode,
        reason: 'No model satisfies the hard constraints for this task.',
      });
    }

    // ---- Normal selection --------------------------------------------------
    const viable = evaluations.filter((evaluation) => evaluation.viable);

    if (viable.length > 0) {
      const exploit = pickCheapestPathToSuccess(viable, prior);

      // The bandit may substitute a different *viable* candidate. It can never
      // widen the field: exploration changes which acceptable model is chosen,
      // never what counts as acceptable.
      const bandit = this.#explore(exploit, viable, features, policy, request);
      const selected =
        viable.find((candidate) => candidate.modelId === bandit.selectedModelId) ?? exploit;

      return finish(
        {
          ...base,
          selectedModelId: selected.modelId,
          outcome: 'selected',
          budgetExceeded: false,
          overrodeExplicitRequest: overrode,
          reason: bandit.explored
            ? `${bandit.reason}. Expected-cost routing would have chosen "${bandit.exploitModelId}".`
            : describeSelection(selected, viable, policy),
        },
        {
          explored: bandit.explored,
          exploitModelId: bandit.exploitModelId,
          premium: bandit.premium,
          blockedBy: bandit.blockedBy,
          reason: bandit.reason,
        },
      );
    }

    // ---- Nothing qualified: follow the configured behaviour ---------------
    return finish(this.#handleNoViableCandidate(evaluations, base, policy, overrode));
  }

  /** Handle an explicit model request. Returns null to fall through to normal routing. */
  #routeExplicit(
    requestedId: string,
    evaluations: readonly ModelEvaluation[],
    base: DecisionBase,
    request: RoutingRequest,
  ): RoutingDecision | null {
    if (!this.#models.has(requestedId)) {
      return finish({
        ...base,
        selectedModelId: null,
        outcome: 'explicit-model-unknown',
        budgetExceeded: false,
        overrodeExplicitRequest: false,
        reason: `Requested model "${requestedId}" is not configured.`,
      });
    }

    const evaluation = evaluations.find((candidate) => candidate.modelId === requestedId);

    if (evaluation !== undefined) {
      // The user asked for a specific model and it can do the job. It is used,
      // whatever the router might otherwise have preferred, and whatever it
      // costs — an explicit choice is a decision, not a hint.
      return finish({
        ...base,
        selectedModelId: requestedId,
        outcome: 'selected-explicit',
        budgetExceeded:
          request.policy.requestBudget !== undefined &&
          evaluation.cost.expectedTotalToSuccess > request.policy.requestBudget,
        overrodeExplicitRequest: false,
        reason: `Using "${requestedId}" because it was explicitly requested.`,
      });
    }

    // Requested but ruled out by a hard constraint.
    const exclusion = base.excluded.find((entry) => entry.modelId === requestedId);
    const detail = exclusion?.detail ?? 'it does not satisfy the constraints for this task';

    if (!request.policy.modelOverrideEnabled) {
      return finish({
        ...base,
        selectedModelId: null,
        outcome: 'explicit-model-ineligible',
        budgetExceeded: false,
        overrodeExplicitRequest: false,
        reason: `Requested model "${requestedId}" cannot run this task: ${detail} Model override is disabled, so no substitute was chosen.`,
      });
    }

    return null;
  }

  /** No candidate met the policy. Apply the configured behaviour (spec section 16). */
  #handleNoViableCandidate(
    evaluations: readonly ModelEvaluation[],
    base: DecisionBase,
    policy: RoutingPolicy,
    overrode: boolean,
  ): FinishInput {
    const budget = formatMoney(policy.requestBudget, policy.currency);
    const threshold = percent(policy.minimumSuccessProbability);

    // Spec section 16 orders the remedies: before doing anything drastic,
    // "attempt cheaper eligible model". A model that fits the budget but sits
    // below the confidence threshold is exactly that — affordable, just not
    // confident. It is preferable to overspending, and the user is told the
    // trade-off either way.
    const affordable = evaluations.filter(
      (candidate) => candidate.withinBudget && candidate.withinRisk && candidate.withinLatency,
    );

    const budgetBinds =
      policy.requestBudget !== undefined &&
      evaluations.some((candidate) => !candidate.withinBudget);

    if (affordable.length > 0) {
      // Nothing here exceeds the budget; the shortfall is confidence.
      const best = mostLikelyToSucceed(affordable);

      switch (policy.onBudgetExceeded) {
        case 'allow-fallback':
          return {
            ...base,
            selectedModelId: best.modelId,
            outcome: 'selected-below-threshold',
            budgetExceeded: false,
            overrodeExplicitRequest: overrode,
            reason:
              `No model reaches the ${threshold} confidence threshold within the ${budget} budget. ` +
              `Configuration allows a fallback, so the best affordable candidate "${best.modelId}" ` +
              `was selected at an estimated ${percent(best.successProbability)} success.`,
          };
        case 'ask':
          return {
            ...base,
            selectedModelId: null,
            outcome: 'ask-user',
            budgetExceeded: false,
            overrodeExplicitRequest: overrode,
            reason:
              `No model reaches the ${threshold} confidence threshold within the ${budget} budget. ` +
              `The best affordable candidate is "${best.modelId}" at ${percent(best.successProbability)}. ` +
              `Asking how to proceed.`,
          };
        case 'stop':
        default:
          return {
            ...base,
            selectedModelId: null,
            outcome: 'no-model-meets-threshold',
            budgetExceeded: false,
            overrodeExplicitRequest: overrode,
            reason:
              `No model reaches the ${threshold} confidence threshold; stopping rather than ` +
              `spending on an attempt that is unlikely to succeed.`,
          };
      }
    }

    // Nothing is affordable at all. Only now can a budget be at stake.
    const cheapest = cheapestPath(evaluations);

    switch (policy.onBudgetExceeded) {
      case 'allow-fallback':
        return {
          ...base,
          selectedModelId: cheapest.modelId,
          outcome: 'selected-over-budget',
          budgetExceeded: !cheapest.withinBudget,
          overrodeExplicitRequest: overrode,
          reason:
            `No model fits the ${budget} request budget; configuration allows a fallback, so ` +
            `"${cheapest.modelId}" was selected at an estimated ` +
            `${formatMoney(cheapest.cost.expectedTotalToSuccess, policy.currency)}.`,
        };

      case 'ask':
        return {
          ...base,
          selectedModelId: null,
          outcome: 'ask-user',
          budgetExceeded: false,
          overrodeExplicitRequest: overrode,
          reason:
            `No model fits the ${budget} request budget. The cheapest path to success is ` +
            `"${cheapest.modelId}" at an estimated ` +
            `${formatMoney(cheapest.cost.expectedTotalToSuccess, policy.currency)}. ` +
            `Asking before spending it.`,
        };

      case 'stop':
      default: {
        if (budgetBinds) {
          return {
            ...base,
            selectedModelId: null,
            outcome: 'stopped',
            budgetExceeded: false,
            overrodeExplicitRequest: overrode,
            reason: `No model fits the ${budget} request budget; stopping rather than overspending.`,
          };
        }

        // Name the constraint that actually did the eliminating. Reporting
        // "not confident enough" when the real problem was a latency cap sends
        // the user off to fix the wrong setting.
        const binding = bindingConstraints(evaluations);
        const thresholdIsBinding = binding.length === 1 && binding[0] === 'confidence threshold';

        return {
          ...base,
          selectedModelId: null,
          outcome: thresholdIsBinding ? 'no-model-meets-threshold' : 'no-model-satisfies-policy',
          budgetExceeded: false,
          overrodeExplicitRequest: overrode,
          reason:
            `No model satisfies the routing policy (${binding.join(', ')}); ` +
            `stopping rather than guessing.`,
        };
      }
    }
  }

  /**
   * Ask the bandit whether to experiment.
   *
   * Every safety condition is evaluated before any candidate is looked at, so
   * an unsafe request cannot be explored however attractive a confidence bound
   * might be.
   */
  #explore(
    exploit: ModelEvaluation,
    viable: readonly ModelEvaluation[],
    features: RoutingFeatures,
    policy: RoutingPolicy,
    request: RoutingRequest,
  ): ReturnType<typeof decideExploration> {
    const context: ExplorationContext = {
      // Absent means production: the cautious reading of a caller that did not
      // say where it is running.
      mode: request.operationMode ?? 'production',
      explicitModelRequested: request.requestedModelId !== undefined,
      totalObservations: this.#learned.totalObservations,
      calibrationPermits: this.#learned.calibration.mayApply,
    };

    const verdict = assessExploration(this.#exploration, features, context, policy);

    return decideExploration({
      viable,
      exploit,
      policy: this.#exploration,
      verdict,
      concentration: (modelId) => this.#learned.concentration(modelId),
      ...(policy.requestBudget === undefined ? {} : { requestBudget: policy.requestBudget }),
    });
  }

  /** Score every eligible model. */
  #evaluate(
    eligible: readonly ModelSpec[],
    features: RoutingFeatures,
    policy: RoutingPolicy,
  ): ModelEvaluation[] {
    if (eligible.length === 0) return [];

    // Static priors first, then whatever has actually been observed. Learning
    // corrects the probability and nothing else: the cost model, the risk model
    // and the selection rule are untouched, so a better-calibrated number
    // improves routing through the machinery that was already there.
    const estimates = eligible.map((model) => {
      const estimate = this.#success.estimate(model, features);
      const learned = this.#learned.estimate(estimate.probability, {
        modelId: model.id,
        taskType: features.task.taskType,
        scope: features.task.scope,
      });
      return { model, estimate, learned };
    });

    const costs = this.#cost.estimate(
      estimates.map((entry) => ({
        model: entry.model,
        successProbability: entry.learned.probability,
      })),
      features,
    );

    const evaluations = estimates.map(({ model, estimate, learned }) => {
      const costed = costs.get(model.id);
      const probability = learned.probability;
      const risk = this.#risk.estimate(model, features, probability);
      const latency = estimateLatencySeconds(model, features);

      // Unreachable in practice — every eligible model is costed — but a
      // typed zero is safer than a non-null assertion if that ever changes.
      const cost: CostProjection = costed?.cost ?? {
        initial: 0,
        failureProbability: 1 - probability,
        retry: 0,
        escalation: 0,
        recovery: 0,
        expectedTotalToSuccess: 0,
        currency: model.pricing.currency,
      };

      const meetsThreshold = probability >= policy.minimumSuccessProbability;
      const withinRisk = risk <= policy.maxRisk;
      const withinLatency = latency <= policy.maxLatencySeconds;
      const withinBudget =
        policy.requestBudget === undefined || cost.expectedTotalToSuccess <= policy.requestBudget;

      return {
        modelId: model.id,
        tier: model.tier,
        successProbability: probability,
        staticSuccessProbability: learned.staticProbability,
        observations: learned.observations,
        learningApplied: learned.applied,
        capabilityFit: estimate.capabilityFit,
        contextFit:
          model.contextWindow <= 0 ? 1 : features.context.contextRequirement / model.contextWindow,
        risk,
        estimatedLatencySeconds: latency,
        cost,
        escalationTargetId: costed?.escalationTargetId ?? null,
        meetsThreshold,
        withinBudget,
        withinRisk,
        withinLatency,
        viable: meetsThreshold && withinRisk && withinLatency && withinBudget,
        usedTierDefault: estimate.usedTierDefault,
      } satisfies ModelEvaluation;
    });

    // Deterministic order: cheapest expected path to success first.
    return evaluations.sort(compareByExpectedCost);
  }
}

/** Fields shared by every decision. */
interface DecisionBase {
  readonly excluded: RoutingDecision['excluded'];
  readonly evaluations: readonly ModelEvaluation[];
  readonly staticTierPrior: RoutingDecision['staticTierPrior'];
  readonly policy: RoutingPolicy;
}

/** A decision without its rendered explanation. */
type FinishInput = DecisionBase & Omit<RoutingDecision, 'explanation' | 'exploration'>;

/**
 * No experiment took place.
 *
 * The default for every decision that never reached the bandit — nothing was
 * selected, an explicit model was honoured, a budget stopped the request. The
 * absence is recorded explicitly rather than left implicit.
 */
const NO_EXPLORATION: ExplorationSummary = {
  explored: false,
  exploitModelId: null,
  premium: null,
  blockedBy: 'disabled',
  reason: 'no exploration was considered for this decision',
};

/** Attach the human-readable explanation and the bandit's summary. */
function finish(
  input: FinishInput,
  exploration: ExplorationSummary = NO_EXPLORATION,
): RoutingDecision {
  return { ...input, exploration, explanation: explainDecision(input) };
}

/**
 * Choose the cheapest expected path to success.
 *
 * Ties are broken deterministically, and the static tier prior acts only as a
 * tie-break — the primary objective remains expected cost (spec section 1).
 */
function pickCheapestPathToSuccess(
  viable: readonly ModelEvaluation[],
  prior: RoutingDecision['staticTierPrior'],
): ModelEvaluation {
  const sorted = [...viable].sort((a, b) => {
    const byCost = compareByExpectedCost(a, b);
    if (byCost !== 0) return byCost;

    // Costs are indistinguishable: prefer the tier the static prior suggests.
    const priorRank = tierRank(prior);
    const aDistance = Math.abs(tierRank(a.tier) - priorRank);
    const bDistance = Math.abs(tierRank(b.tier) - priorRank);
    if (aDistance !== bDistance) return aDistance - bDistance;

    return a.modelId.localeCompare(b.modelId);
  });

  // `viable` is non-empty at every call site.
  return sorted[0] as ModelEvaluation;
}

/**
 * Total ordering over evaluations.
 *
 * Every comparison ends in a model-id tie-break, so the sort is stable
 * regardless of the order models were registered in.
 */
function compareByExpectedCost(a: ModelEvaluation, b: ModelEvaluation): number {
  const costDifference = a.cost.expectedTotalToSuccess - b.cost.expectedTotalToSuccess;
  // Costs are floating point; treat imperceptible differences as equal so that
  // rounding noise cannot flip a decision.
  if (Math.abs(costDifference) > 1e-9) return costDifference;

  if (a.successProbability !== b.successProbability) {
    return b.successProbability - a.successProbability;
  }
  if (a.cost.initial !== b.cost.initial) return a.cost.initial - b.cost.initial;
  return a.modelId.localeCompare(b.modelId);
}

/**
 * The most capable candidate, used when confidence is the binding constraint.
 *
 * Ties break towards the cheaper model, then by id, so the choice is stable.
 */
function mostLikelyToSucceed(evaluations: readonly ModelEvaluation[]): ModelEvaluation {
  const sorted = [...evaluations].sort(
    (a, b) =>
      b.successProbability - a.successProbability ||
      a.cost.expectedTotalToSuccess - b.cost.expectedTotalToSuccess ||
      a.modelId.localeCompare(b.modelId),
  );
  return sorted[0] as ModelEvaluation;
}

/**
 * Which policy limits eliminated candidates, most common first.
 *
 * Used so the failure message points at the setting the user would actually
 * need to change.
 */
function bindingConstraints(evaluations: readonly ModelEvaluation[]): string[] {
  const counts: [string, number][] = [
    ['confidence threshold', evaluations.filter((e) => !e.meetsThreshold).length],
    ['risk limit', evaluations.filter((e) => !e.withinRisk).length],
    ['latency limit', evaluations.filter((e) => !e.withinLatency).length],
    ['request budget', evaluations.filter((e) => !e.withinBudget).length],
  ];

  return counts
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);
}

/** The cheapest path to success, used when money is the binding constraint. */
function cheapestPath(evaluations: readonly ModelEvaluation[]): ModelEvaluation {
  return [...evaluations].sort(compareByExpectedCost)[0] as ModelEvaluation;
}

function describeSelection(
  selected: ModelEvaluation,
  viable: readonly ModelEvaluation[],
  policy: RoutingPolicy,
): string {
  const cheaperRejected = viable.length > 1;
  const base =
    `Selected "${selected.modelId}" — estimated ${percent(selected.successProbability)} success, ` +
    `${formatMoney(selected.cost.expectedTotalToSuccess, policy.currency)} expected total cost to success`;

  return cheaperRejected
    ? `${base}, the cheapest path to success above the ${percent(policy.minimumSuccessProbability)} threshold.`
    : `${base}, the only candidate above the ${percent(policy.minimumSuccessProbability)} threshold.`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatMoney(value: number | undefined, currency: string): string {
  if (value === undefined) return 'unlimited';
  return `${value.toFixed(4)} ${currency}`;
}
