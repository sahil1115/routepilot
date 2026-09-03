/**
 * Uncertainty and optimism (spec sections 36 and 40).
 *
 * Phase 10 produces a success probability. This produces the *width* around it,
 * which is what makes principled exploration possible: a model estimated at
 * 0.70 from twelve observations and one estimated at 0.70 from four hundred are
 * the same number carrying completely different amounts of doubt, and only the
 * first is worth spending money to learn more about.
 *
 * ## Why an upper confidence bound rather than sampling
 *
 * The textbook bandit answer is Thompson sampling — draw from the posterior and
 * act on the draw. It is deliberately **not** used here, for two reasons that
 * are not about statistics:
 *
 * 1. **Determinism has been a hard requirement since Phase 3.** The same inputs
 *    must produce byte-identical decisions. A sampled policy cannot promise
 *    that, and a router whose answer changes between two identical invocations
 *    is one nobody can debug.
 * 2. **Architectural principle 9 forbids randomly selecting an expensive
 *    model.** Thompson sampling does exactly that, occasionally, by design.
 *
 * An upper confidence bound gives the same optimism-in-the-face-of-uncertainty
 * behaviour deterministically: rank by what a model could plausibly be worth at
 * its best, not by what it is expected to be worth.
 *
 * ## The posterior width
 *
 * The learned model is Beta-Bernoulli, so the posterior around mean `p` with
 * concentration `n` (the prior's pseudo-count plus real observations) has
 *
 * ```
 * variance = p (1 - p) / (n + 1)
 * ```
 *
 * The width therefore shrinks as evidence accumulates — which is what makes
 * exploration self-limiting rather than a permanent tax. A model explored
 * enough times stops looking uncertain, and the bandit stops paying to try it.
 */

/** Inputs to a confidence bound. */
export interface UncertaintyInput {
  /** Posterior mean success probability, in [0, 1]. */
  readonly probability: number;
  /**
   * Total evidence behind it: prior pseudo-count plus real observations.
   *
   * Must be positive. The prior always contributes, so this is never zero even
   * for a model that has never been tried.
   */
  readonly concentration: number;
}

/**
 * Standard deviation of the Beta posterior.
 *
 * @throws RangeError on a probability outside [0, 1] or a non-positive
 *   concentration.
 */
export function posteriorStdDev(input: UncertaintyInput): number {
  const { probability, concentration } = input;

  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError(`probability must be within [0, 1] (got ${probability})`);
  }
  if (!Number.isFinite(concentration) || concentration <= 0) {
    throw new RangeError(`concentration must be positive (got ${concentration})`);
  }

  return Math.sqrt((probability * (1 - probability)) / (concentration + 1));
}

/**
 * Optimistic upper bound on a success probability.
 *
 * `optimism` is how many standard deviations of benefit of the doubt to give.
 * At 1 the bound sits around the 84th percentile of the posterior; at 2, around
 * the 98th. Higher means more willing to gamble on a model that might be good.
 *
 * The result is clamped to `[probability, 1]`: a bound below the mean would be
 * a contradiction, and above 1 is not a probability.
 *
 * @throws RangeError on a negative optimism, or on the inputs
 *   {@link posteriorStdDev} rejects.
 */
export function upperConfidenceBound(input: UncertaintyInput, optimism: number): number {
  if (!Number.isFinite(optimism) || optimism < 0) {
    throw new RangeError(`optimism must be non-negative (got ${optimism})`);
  }

  const bound = input.probability + optimism * posteriorStdDev(input);
  return Math.min(1, Math.max(input.probability, bound));
}

/**
 * How much of the estimate is still doubt, in [0, 1].
 *
 * Normalised against the widest a Beta posterior can be at this concentration
 * — the value at `p = 0.5` — so it reads as "how uncertain is this, relative to
 * the most uncertain it could be given this much evidence". Used for reporting
 * rather than for the decision itself, which uses the bound directly.
 */
export function relativeUncertainty(input: UncertaintyInput): number {
  const widest = posteriorStdDev({ probability: 0.5, concentration: input.concentration });
  if (widest === 0) return 0;
  return Math.min(1, posteriorStdDev(input) / widest);
}
