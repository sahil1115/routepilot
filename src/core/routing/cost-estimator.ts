/**
 * Expected cost to success (spec sections 1, 14 and 15).
 *
 * This is the file that encodes RoutePilot's central claim: the right thing to
 * minimise is **expected total cost to a successful completion**, not the price
 * of the first attempt. A model that costs $0.02 and fails 40% of the time can
 * easily be more expensive than one that costs $0.07 and fails 10%, once the
 * retry and the escalation are paid for.
 *
 *     expectedTotal(m) = initial(m)
 *                      + P(fail | m) × [ retryShare × initial(m)
 *                                      + escalationShare × expectedTotal(next) ]
 *
 * where `next` is the cheapest-to-success model strictly stronger than `m`.
 *
 * The recursion terminates because candidates are processed from strongest to
 * weakest, and the strongest model has nothing to escalate to. Every input is a
 * configured prior; nothing here is measured yet. Phase 12 replaces the
 * constants with observations.
 *
 * The arithmetic itself lives in `expected-cost.ts` as a pure function, so it
 * can be reasoned about and tested without a registry or a task. This file is
 * responsible only for pricing tokens and resolving escalation targets.
 */

import { priceModelTokens, isComparableCurrency } from '../pricing.js';
import { expectedCostToSuccess } from './expected-cost.js';
import type { RoutingFeatures } from '../types/features.js';
import type { ModelSpec } from '../types/model.js';
import type { CostProjection } from '../types/routing.js';
import { chooseVerticalTarget } from '../escalation/target-selection.js';

/** One model's success estimate, as produced by the success predictor. */
export interface CandidateInput {
  readonly model: ModelSpec;
  readonly successProbability: number;
}

/** A costed candidate. */
export interface CostedCandidate {
  readonly modelId: string;
  readonly cost: CostProjection;
  /** The model this one escalates to on failure, or null if it is the strongest. */
  readonly escalationTargetId: string | null;
}

/** Computes expected total cost to success for a set of candidates. */
export class CostEstimator {
  /**
   * Cost every candidate, resolving escalation targets among them.
   *
   * @param candidates Eligible models with their success estimates.
   * @param features The request, for token estimates.
   * @returns One entry per candidate, keyed by model id.
   */
  estimate(
    candidates: readonly CandidateInput[],
    features: RoutingFeatures,
  ): Map<string, CostedCandidate> {
    const results = new Map<string, CostedCandidate>();
    if (candidates.length === 0) return results;

    // Every comparison below is a bare numeric one -- ranking by expected cost,
    // testing against a budget, choosing an escalation target. All of that is
    // meaningless across currencies, and `isComparableCurrency` existed to say
    // so while no caller checked it.
    //
    // The config schema rejects a mixed-currency document, so a run driven by
    // the CLI cannot reach this. A library consumer building `ModelSpec`s by
    // hand can, and would otherwise get a silently nonsensical ranking rather
    // than an error.
    assertOneCurrency(candidates);

    const usage = {
      inputTokens: features.context.estimatedInputTokens,
      outputTokens: features.context.estimatedOutputTokens,
    };

    // Strongest first, so a model's escalation target is already costed by the
    // time it is needed. Ties broken by id for determinism.
    const ordered = [...candidates].sort(
      (a, b) => b.successProbability - a.successProbability || a.model.id.localeCompare(b.model.id),
    );

    for (let i = 0; i < ordered.length; i += 1) {
      const candidate = ordered[i];
      if (candidate === undefined) continue;

      const initial = priceModelTokens(candidate.model, usage).totalCost;

      // Candidates already processed are strictly stronger and already costed,
      // so the shared rule can rank them on expected cost -- the same rule the
      // escalation engine applies at runtime, so the target named here is the
      // one that would actually run.
      //
      // Models already attempted for this task are excluded, because the engine
      // refuses them. Without this the estimate could be justified by a move to
      // a model that has already failed.
      const target = chooseVerticalTarget(
        ordered.slice(0, i).map((other) => ({
          model: other.model,
          successProbability: other.successProbability,
          expectedTotalCost: results.get(other.model.id)?.cost.expectedTotalToSuccess ?? null,
        })),
        candidate.successProbability,
        { exclude: features.history.attemptedModelIds },
      );

      const targetId = target?.id ?? null;
      const targetCost =
        targetId === null ? null : (results.get(targetId)?.cost.expectedTotalToSuccess ?? null);

      const breakdown = expectedCostToSuccess({
        initial,
        successProbability: candidate.successProbability,
        escalationTargetCost: targetCost,
      });

      results.set(candidate.model.id, {
        modelId: candidate.model.id,
        cost: { ...breakdown, currency: candidate.model.pricing.currency },
        escalationTargetId: targetId,
      });
    }

    return results;
  }
}

/** Estimated wall-clock seconds for one attempt on a model. */
export function estimateLatencySeconds(model: ModelSpec, features: RoutingFeatures): number {
  const { firstTokenSeconds, outputTokensPerSecond } = model.latency;
  if (outputTokensPerSecond <= 0) return Number.POSITIVE_INFINITY;
  return firstTokenSeconds + features.context.estimatedOutputTokens / outputTokensPerSecond;
}

/**
 * Refuse to rank models priced in different currencies.
 *
 * Throws rather than degrading: there is no sensible fallback. Converting would
 * need a rate this project does not have and should not invent, and comparing
 * the numbers anyway produces a confident, wrong answer -- the worst outcome
 * available.
 */
function assertOneCurrency(candidates: readonly CandidateInput[]): void {
  const first = candidates[0]?.model;
  if (first === undefined) return;

  for (const candidate of candidates) {
    if (isComparableCurrency(first.pricing, candidate.model.pricing)) continue;

    throw new RangeError(
      `Cannot compare model costs across currencies: "${first.id}" is priced in ` +
        `${first.pricing.currency} and "${candidate.model.id}" in ` +
        `${candidate.model.pricing.currency}. Price every model in one currency, ` +
        `or convert before routing -- RoutePilot has no exchange rate and will not guess one.`,
    );
  }
}
