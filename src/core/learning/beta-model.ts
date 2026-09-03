/**
 * Beta-Bernoulli shrinkage (spec sections 35 and 39).
 *
 * The whole of Phase 10's statistics, isolated as a pure function so the
 * arithmetic can be argued with directly.
 *
 * A prior is treated as if it were `strength` imaginary observations at rate
 * `prior`. Real observations are added to those, and the posterior mean is the
 * combined rate:
 *
 * ```
 * alpha = strength x prior       + successMass
 * beta  = strength x (1 - prior) + (observations - successMass)
 * mean  = alpha / (alpha + beta)
 *       = (strength x prior + successMass) / (strength + observations)
 * ```
 *
 * Three properties make this the right tool for the phase's requirements, and
 * each is asserted in the tests rather than assumed:
 *
 * - **Zero observations returns the prior exactly.** Not approximately, not
 *   0.5, not zero. `mean = (strength x prior) / strength = prior`.
 * - **Sparse observations barely move it.** One success against a prior of 0.6
 *   at strength 12 gives 0.63, not 1.0. A single lucky run cannot promote a
 *   model, which is what stops early noise from thrashing routing.
 * - **Enough observations dominate.** As `observations` grows the prior's fixed
 *   `strength` is swamped and the mean converges on the observed rate, which is
 *   what lets learning correct a prior that was simply wrong.
 *
 * **The imaginary observations are never counted as data.** They exist only
 * inside this arithmetic. Nothing here returns a sample count, and the caller's
 * `observations` is passed through untouched (spec section 2, rule 11).
 */

/** Inputs to one shrinkage step. */
export interface ShrinkageInput {
  /** The rate to fall back to, in [0, 1]. */
  readonly prior: number;
  /**
   * How many observations the prior is worth.
   *
   * The half-life of disagreement: at `strength` real observations, data and
   * prior carry equal weight. Must be positive — a strength of zero would let a
   * single observation set the estimate to 0 or 1.
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

  // Short-circuited rather than left to the general formula. Algebraically
  // `(strength x prior) / strength` is `prior`, but in floating point it is not
  // always: at prior 0.8 and strength 12 it comes back 0.8000000000000002. A
  // level with no data must be an exact pass-through, because the backoff chain
  // feeds each level's result into the next and that error would compound.
  if (observations === 0) return prior;

  return (strength * prior + successMass) / (strength + observations);
}

/**
 * The observed rate, or `null` when nothing has been observed.
 *
 * `null` rather than 0, because no data is not the same as no successes. Every
 * consumer of this value has to make that distinction explicitly.
 */
export function observedRate(observations: number, successMass: number): number | null {
  return observations === 0 ? null : successMass / observations;
}

/**
 * Observations needed before data outweighs the prior by the given factor.
 *
 * Exposed so `minimumTrainingSamples` can be chosen against the arithmetic
 * rather than guessed: at `factor` 1 the data merely matches the prior's
 * weight, which is not much of a claim.
 */
export function observationsForWeight(strength: number, factor: number): number {
  return Math.ceil(strength * factor);
}
