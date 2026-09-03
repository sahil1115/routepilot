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

import { priceModelTokens } from '../pricing.js';
import { expectedCostToSuccess } from './expected-cost.js';
import type { RoutingFeatures } from '../types/features.js';
import type { ModelSpec } from '../types/model.js';
import type { CostProjection } from '../types/routing.js';

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

      // Candidates already processed are strictly stronger; the escalation
      // target is whichever of them is cheapest to reach success through.
      const stronger = ordered
        .slice(0, i)
        .filter((other) => other.successProbability > candidate.successProbability);

      const target = cheapestToSuccess(stronger, results);
      const targetCost =
        target === null ? null : (results.get(target)?.cost.expectedTotalToSuccess ?? null);

      const breakdown = expectedCostToSuccess({
        initial,
        successProbability: candidate.successProbability,
        escalationTargetCost: targetCost,
      });

      results.set(candidate.model.id, {
        modelId: candidate.model.id,
        cost: { ...breakdown, currency: candidate.model.pricing.currency },
        escalationTargetId: target,
      });
    }

    return results;
  }
}

/** The already-costed model with the lowest expected total cost to success. */
function cheapestToSuccess(
  stronger: readonly CandidateInput[],
  costed: ReadonlyMap<string, CostedCandidate>,
): string | null {
  let best: { id: string; cost: number } | null = null;

  for (const candidate of stronger) {
    const entry = costed.get(candidate.model.id);
    if (entry === undefined) continue;

    const cost = entry.cost.expectedTotalToSuccess;
    if (best === null || cost < best.cost || (cost === best.cost && candidate.model.id < best.id)) {
      best = { id: candidate.model.id, cost };
    }
  }

  return best?.id ?? null;
}

/** Estimated wall-clock seconds for one attempt on a model. */
export function estimateLatencySeconds(model: ModelSpec, features: RoutingFeatures): number {
  const { firstTokenSeconds, outputTokensPerSecond } = model.latency;
  if (outputTokensPerSecond <= 0) return Number.POSITIVE_INFINITY;
  return firstTokenSeconds + features.context.estimatedOutputTokens / outputTokensPerSecond;
}
