/**
 * Shadow routing (spec sections 42, 43 and 44).
 *
 * Evaluates alternative policies alongside the live one and records what they
 * would have chosen. No shadow policy ever executes anything.
 *
 * That guarantee is structural rather than a rule to remember. This class is
 * built from a registry and a learned model, neither of which can start a
 * process or reach a provider; `src/core` may not import `src/adapters` at all,
 * which an architectural test enforces; and a {@link ShadowOutcome} carries a
 * model id, not a session, so there is nothing to await.
 *
 * Each shadow decision carries an estimated cost difference, which must not be
 * read as money saved. The shadow's model never ran, and both sides are priced
 * from the same success probabilities, so a miscalibrated predictor shifts them
 * together and the delta preserves the error rather than exposing it. What the
 * comparison supports is narrower: how often the policies disagree, and which
 * model the alternative prefers. Claiming one is better needs outcomes for both
 * arms, which is offline policy evaluation.
 */

import type { ModelRegistry } from '../registry/model-registry.js';
import type { ModelEvaluation, RoutingDecision } from '../types/routing.js';
import type {
  ShadowComparison,
  ShadowOutcome,
  ShadowPolicySpec,
  ShadowRecord,
} from '../types/shadow.js';
import { LearnedSuccessModel } from '../learning/success-model.js';
import { EXPLORATION_DISABLED, type ExplorationPolicy } from '../bandit/exploration-gate.js';
import { RoutingEngine, type RoutingRequest } from '../routing/routing-engine.js';
import { selectBy } from './selection.js';

/** A request to evaluate under the live policy and its shadows. */
export interface ShadowRequest extends RoutingRequest {
  /** Policies to evaluate alongside. An empty list is a normal, supported case. */
  readonly shadowPolicies?: readonly ShadowPolicySpec[] | undefined;
}

/**
 * Routes a request under the live policy and, separately, under each shadow.
 *
 * Deterministic: given the same registry, learned statistics and policies, the
 * comparison is identical every time. No clock, no randomness.
 */
export class ShadowRouter {
  readonly #models: ModelRegistry;
  readonly #live: RoutingEngine;
  /** Engine with learning switched off, built once and reused. */
  readonly #priorsOnly: RoutingEngine;

  /**
   * @param exploration The live exploration policy. Passed through so the
   *   `current` decision is genuinely the live one — an earlier version built
   *   its own engine without it, which meant switching shadow routing on
   *   silently switched the bandit off.
   */
  constructor(
    models: ModelRegistry,
    learned: LearnedSuccessModel = new LearnedSuccessModel(),
    exploration: ExplorationPolicy = EXPLORATION_DISABLED,
  ) {
    this.#models = models;
    this.#live = new RoutingEngine(models, learned, exploration);
    // A second engine holding a model that is disabled and empty, and never
    // exploring: a baseline that runs its own experiments is not a baseline.
    // Constructing it here rather than per request keeps the comparison free of
    // any per-call state.
    this.#priorsOnly = new RoutingEngine(models, new LearnedSuccessModel());
  }

  /** The models available. Exposed so a caller can confirm no adapter is involved. */
  get modelCount(): number {
    return this.#models.size;
  }

  /**
   * Route under the live policy, and evaluate every shadow beside it.
   *
   * The returned `current` decision is the only one a caller may act on.
   */
  compare(request: ShadowRequest): ShadowComparison {
    const current = this.#live.route(request);
    const policies = request.shadowPolicies ?? [];

    const shadows = policies.map((spec) => this.#evaluate(spec, request, current));
    return { current, shadows };
  }

  /** Evaluate one shadow policy against the live decision. */
  #evaluate(
    spec: ShadowPolicySpec,
    request: ShadowRequest,
    current: RoutingDecision,
  ): ShadowOutcome {
    const engine = spec.learning === 'disabled' ? this.#priorsOnly : this.#live;

    // Re-run only when the limits differ. Reusing the live decision otherwise
    // keeps a same-limits shadow exactly comparable — any divergence is then
    // attributable to the selection rule alone, which is what makes the
    // baselines interpretable.
    const decision =
      spec.policyOverrides === undefined && spec.learning !== 'disabled'
        ? current
        : engine.route({
            ...request,
            policy: { ...request.policy, ...spec.policyOverrides },
          });

    const chosen = selectBy(spec.rule, decision.evaluations);
    const liveChoice = findEvaluation(current, current.selectedModelId);

    return {
      policyId: spec.id,
      description: spec.description,
      selectedModelId: chosen?.modelId ?? null,
      tier: chosen?.tier ?? null,
      agrees: (chosen?.modelId ?? null) === current.selectedModelId,
      estimatedCostDelta: delta(
        chosen?.cost.expectedTotalToSuccess,
        liveChoice?.cost.expectedTotalToSuccess,
      ),
      successProbabilityDelta: delta(chosen?.successProbability, liveChoice?.successProbability),
      decision,
    };
  }
}

/**
 * Turn a comparison into records for persistence.
 *
 * `at` is supplied rather than read from a clock, so a replay reproduces
 * byte-identical records.
 */
export function toShadowRecords(
  comparison: ShadowComparison,
  requestId: string,
  at: number,
): ShadowRecord[] {
  return comparison.shadows.map((shadow) => ({
    requestId,
    policyId: shadow.policyId,
    currentModelId: comparison.current.selectedModelId,
    shadowModelId: shadow.selectedModelId,
    agrees: shadow.agrees,
    estimatedCostDelta: shadow.estimatedCostDelta,
    successProbabilityDelta: shadow.successProbabilityDelta,
    at,
  }));
}

function findEvaluation(
  decision: RoutingDecision,
  modelId: string | null,
): ModelEvaluation | undefined {
  if (modelId === null) return undefined;
  return decision.evaluations.find((candidate) => candidate.modelId === modelId);
}

/**
 * Difference between two estimates, or `null` when either is missing.
 *
 * A policy that selected nothing has no cost. Treating that as zero would make
 * "stop and do nothing" look like the cheapest policy available, which is true
 * and useless.
 */
function delta(shadow: number | undefined, current: number | undefined): number | null {
  if (shadow === undefined || current === undefined) return null;
  return shadow - current;
}
