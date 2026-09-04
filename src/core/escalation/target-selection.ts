/**
 * Which model a vertical escalation moves to.
 *
 * One rule, used by both the code that predicts an escalation and the code that
 * performs one. They previously disagreed:
 *
 * | | estimator | engine |
 * | --- | --- | --- |
 * | "stronger" means | `p > current` | `p > current + 0.02` |
 * | ranked by | lowest expected total cost | lowest `outputPerMillion` |
 * | already-tried models | included | excluded |
 *
 * The ranking mattered most. `expected-cost.ts` exists to argue that the
 * cheapest sticker price is a trap, yet the engine picked its target by sticker
 * price -- so RoutePilot would report "escalates to X" while the runtime moved
 * to Y, having justified the original choice with X's number.
 *
 * Only target selection is shared; the estimator's recovery pricing stays put.
 *
 * Deliberately not unified: the engine tries a horizontal move first for
 * `MODEL_WEAKNESS`, and only `MODEL_WEAKNESS` escalates vertically at all,
 * while the estimator applies one retry/escalate split to every failure.
 * Closing that needs a distribution over failure types -- a design change, not
 * a correctness fix. The remaining error is conservative: the estimate prices
 * the vertical path, and the engine may take a cheaper sideways one.
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
