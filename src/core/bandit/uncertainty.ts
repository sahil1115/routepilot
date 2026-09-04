/**
 * Uncertainty and optimism (spec sections 36 and 40).
 *
 * The width around a success probability. 0.70 from twelve observations and
 * 0.70 from four hundred carry very different doubt, and only the first is
 * worth paying to learn about.
 *
 * Thompson sampling is deliberately not used: decisions must be deterministic,
 * and principle 9 forbids randomly selecting an expensive model. An upper
 * confidence bound gives the same optimism deterministically.
 *
 * The posterior is Beta-Bernoulli, so `variance = p(1-p)/(n+1)` where `n` is
 * the prior pseudo-count plus real observations. The width shrinks as evidence
 * accumulates, which makes exploration self-limiting rather than a permanent
 * tax.
 */

/** Inputs to a confidence bound. */
export interface UncertaintyInput {
  /** Posterior mean success probability, in [0, 1]. */
  readonly probability: number;
  /**
   * Prior pseudo-count plus real observations. Always positive, since the prior
   * contributes even to a model that has never been tried.
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
 * `optimism` is how many standard deviations of benefit of the doubt to give:
 * 1 is roughly the 84th percentile, 2 roughly the 98th. Clamped to
 * `[probability, 1]`.
 *
 * @throws RangeError on negative optimism, or on the inputs
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
 * (the value at `p = 0.5`). Reporting only; decisions use the bound directly.
 */
export function relativeUncertainty(input: UncertaintyInput): number {
  const widest = posteriorStdDev({ probability: 0.5, concentration: input.concentration });
  if (widest === 0) return 0;
  return Math.min(1, posteriorStdDev(input) / widest);
}
