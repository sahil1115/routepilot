/**
 * Beta-Bernoulli shrinkage (spec sections 35 and 39).
 *
 * A prior is treated as `strength` imaginary observations at rate `prior`; real
 * observations are added to those:
 *
 * ```
 * alpha = strength x prior       + successMass
 * beta  = strength x (1 - prior) + (observations - successMass)
 * mean  = (strength x prior + successMass) / (strength + observations)
 * ```
 *
 * Three properties, each asserted in the tests: zero observations returns the
 * prior exactly; sparse observations barely move it, so one lucky run cannot
 * promote a model; and enough observations swamp the prior, so learning can
 * correct one that was wrong.
 *
 * The imaginary observations are never counted as data -- they exist only in
 * this arithmetic (spec section 2, rule 11).
 */

/** Inputs to one shrinkage step. */
export interface ShrinkageInput {
  /** The rate to fall back to, in [0, 1]. */
  readonly prior: number;
  /**
   * How many observations the prior is worth: at `strength` real observations,
   * data and prior carry equal weight. Must be positive, or one observation
   * could set the estimate to 0 or 1.
   */
  readonly strength: number;
  /** Real observation count. A non-negative integer. */
  readonly observations: number;
  /** Sum of success scores over those observations, in [0, observations]. */
  readonly successMass: number;
}

/**
 * Posterior mean after shrinking observations toward a prior.
 *
 * @throws RangeError on a prior outside [0, 1], a non-positive strength, a
 *   negative or non-integer observation count, or a success mass outside
 *   [0, observations].
 */
export function shrinkToPrior(input: ShrinkageInput): number {
  const { prior, strength, observations, successMass } = input;

  if (!Number.isFinite(prior) || prior < 0 || prior > 1) {
    throw new RangeError(`prior must be within [0, 1] (got ${prior})`);
  }
  if (!Number.isFinite(strength) || strength <= 0) {
    throw new RangeError(`strength must be positive (got ${strength})`);
  }
  if (!Number.isInteger(observations) || observations < 0) {
    throw new RangeError(`observations must be a non-negative integer (got ${observations})`);
  }
  if (!Number.isFinite(successMass) || successMass < 0 || successMass > observations) {
    throw new RangeError(`successMass must be within [0, ${observations}] (got ${successMass})`);
  }

  // Algebraically `(strength x prior) / strength` is `prior`, but in floating
  // point it is not always: 0.8 at strength 12 returns 0.8000000000000002. The
  // backoff chain feeds each level into the next, so that error would compound.
  if (observations === 0) return prior;

  return (strength * prior + successMass) / (strength + observations);
}

/**
 * The observed rate, or `null` when nothing has been observed -- no data is not
 * the same as no successes, and every consumer must make that distinction.
 */
export function observedRate(observations: number, successMass: number): number | null {
  return observations === 0 ? null : successMass / observations;
}

/**
 * Observations needed before data outweighs the prior by the given factor.
 *
 * Exposed so `minimumTrainingSamples` can be chosen against the arithmetic:
 * at `factor` 1 the data merely matches the prior's weight.
 */
export function observationsForWeight(strength: number, factor: number): number {
  return Math.ceil(strength * factor);
}
