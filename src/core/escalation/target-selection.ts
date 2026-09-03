/**
 * Which model a vertical escalation moves to.
 *
 * One rule, used by both the thing that *predicts* an escalation and the thing
 * that *performs* one. They disagreed until Phase 25:
 *
 * | | estimator (`cost-estimator.ts`) | engine (`escalation-engine.ts`) |
 * | --- | --- | --- |
 * | "stronger" means | `p > current` | `p > current + 0.02` |
 * | ranked by | lowest expected total cost | lowest `pricing.outputPerMillion` |
 * | already-tried models | included | excluded |
 *
 * The ranking difference is the one that mattered. `expected-cost.ts` exists to
 * argue that the cheapest sticker price is a trap — a model that costs less per
 * token and fails more often is the more expensive path — and the escalation
 * engine picked its target by sticker price. So RoutePilot would tell a user
 * "escalates to X" while the runtime moved to Y, and the number attached to X
 * was the justification for choosing the model in the first place.
 *
 * This module is that rule, once. The estimator's own recovery *pricing* stays
 * where it is; only target selection is shared.
 *
 * ## What is deliberately not unified
 *
 * The engine tries a **horizontal** move first for `MODEL_WEAKNESS`, and only
 * `MODEL_WEAKNESS` reaches a vertical escalation at all — every other failure
 * type retries, asks, changes provider, or stops. The estimator models none of
 * that: it applies one retry/escalate split to every failure. Closing that gap
 * means giving the estimator a distribution over failure types, which is a
 * design change rather than a correctness fix, and it is left open on purpose.
 * The direction of the remaining error is conservative: the estimate prices the
 * vertical path, and the engine may take a cheaper sideways one.
 */

import type { ModelSpec } from '../types/model.js';

/**
 * A model that could be escalated to, with what is known about it.
 *
 * `expectedTotalCost` is the estimator's own figure. The engine does not have
 * one — it holds specs and a predictor — so it passes `null` and the ranking
 * falls back to the next key. That keeps one implementation rather than two
 * that agree only by inspection.
 */
export interface EscalationCandidate {
  readonly model: ModelSpec;
  /** Estimated probability of success on this task, in [0, 1]. */
  readonly successProbability: number;
  /** Expected total cost to success, when the caller has computed one. */
  readonly expectedTotalCost?: number | null | undefined;
}

/**
 * How much better a candidate must be before it counts as an escalation.
 *
 * A margin, not a strict inequality: two models whose priors differ in the
 * third decimal are not meaningfully different, and moving between them spends
 * a handoff to buy nothing. The engine has used 0.02 since Phase 7; the
 * estimator used no margin at all, which is why it could name a target the
 * engine would refuse.
 */
export const VERTICAL_ESCALATION_MARGIN = 0.02;

/** Options for {@link chooseVerticalTarget}. */
export interface VerticalTargetOptions {
  /** Models already attempted for this task. Never escalated back to. */
  readonly exclude?: Iterable<string> | undefined;
  /** Minimum improvement required. Defaults to {@link VERTICAL_ESCALATION_MARGIN}. */
  readonly margin?: number | undefined;
}

/**
 * The model a vertical escalation should move to, or null if none qualifies.
 *
 * Ranked by **expected total cost to success**, falling back to per-token
 * output price only when no expected cost is available. Deterministic: ties
 * break on model id, so two callers with the same inputs choose the same model.
 */
export function chooseVerticalTarget(
  candidates: readonly EscalationCandidate[],
  currentSuccessProbability: number,
  options: VerticalTargetOptions = {},
): ModelSpec | null {
  const excluded = new Set(options.exclude ?? []);
  const margin = options.margin ?? VERTICAL_ESCALATION_MARGIN;

  const better = candidates.filter(
    (candidate) =>
      !excluded.has(candidate.model.id) &&
      candidate.successProbability > currentSuccessProbability + margin,
  );

  if (better.length === 0) return null;

  const sorted = [...better].sort((a, b) => {
    // Expected cost first: the whole thesis of this project is that it, and not
    // the sticker price, is what a route should be chosen on.
    const costA = a.expectedTotalCost ?? null;
    const costB = b.expectedTotalCost ?? null;
    if (costA !== null && costB !== null && costA !== costB) return costA - costB;

    // Only when neither side has been costed. A caller holding specs alone
    // still gets a stable, defensible order rather than an arbitrary one.
    if (a.model.pricing.outputPerMillion !== b.model.pricing.outputPerMillion) {
      return a.model.pricing.outputPerMillion - b.model.pricing.outputPerMillion;
    }

    return b.successProbability - a.successProbability || a.model.id.localeCompare(b.model.id);
  });

  return sorted[0]?.model ?? null;
}
