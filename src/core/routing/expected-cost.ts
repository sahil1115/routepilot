/**
 * The expected-cost-to-success model (spec sections 1, 14 and 15).
 *
 * RoutePilot's central claim as arithmetic, isolated as a pure function so it
 * can be tested without a registry, a model or a task:
 *
 * ```
 * expectedTotal(m) = initial(m) + P(fail | m) x recovery(m)
 *
 * recovery(m)      = retryShare      x retry(m)
 *                  + escalationShare x escalation(m)
 *
 * escalation(m)    = expectedTotal(next) x (1 + handoffOverhead)
 * ```
 *
 * Cheapest-initial is not always cheapest-expected. For two models A and B with
 * B the escalation target, A is the dearer path when:
 *
 * ```
 * initialA x (1 + retryShare x fA) + escalationShare x (1+overhead) x fA x expectedTotalB
 *     >  expectedTotalB
 * ```
 *
 * With the defaults below and a small `fA` that needs `initialA` to be roughly
 * 85-90% of `initialB`. So when a cheap model is much cheaper, opening with it
 * is genuinely cheaper even at a poor success rate; when two models are close in
 * price and differ in reliability, the cheaper sticker price is a trap.
 *
 * The first case is why `minimumSuccessProbability` is a separate constraint:
 * expected dollars alone would always gamble, and dollars are not the only cost
 * of a failure.
 */

/** Inputs to the expected-cost calculation. */
export interface ExpectedCostInput {
  /** Cost of one attempt on this model. */
  readonly initial: number;
  /** Probability this attempt succeeds, in [0, 1]. */
  readonly successProbability: number;
  /**
   * Expected total cost to success of the model this one escalates to.
   *
   * `null` when nothing stronger is available.
   */
  readonly escalationTargetCost: number | null;
}

/** Tunable shares of the recovery model. */
export interface RecoveryModel {
  /**
   * Share of failures resolved by retrying the same model.
   *
   * A prior. Phase 12 replaces it with observation, and the failure classifier
   * (Phase 6) already distinguishes the cases this is averaging over.
   */
  readonly retryShare: number;
  /** How much of an attempt a retry repeats. A retry resends and regenerates. */
  readonly retryCostFraction: number;
  /**
   * Extra cost of handing over to another model.
   *
   * The receiving model gets a compact briefing rather than a transcript
   * (spec section 28), so a handoff is not free but is far cheaper than the
   * full history would be.
   */
  readonly handoffOverhead: number;
}

/** Defaults used by the router. */
export const DEFAULT_RECOVERY_MODEL: RecoveryModel = {
  retryShare: 0.35,
  retryCostFraction: 1.0,
  handoffOverhead: 0.2,
};

/** Every term of the calculation, so a result can be audited. */
export interface ExpectedCostBreakdown {
  readonly initial: number;
  readonly failureProbability: number;
  readonly retry: number;
  readonly escalation: number;
  readonly recovery: number;
  readonly expectedTotalToSuccess: number;
}

/**
 * Compute the expected cost to success for one model.
 *
 * @throws RangeError when a probability is outside [0, 1] or a cost is negative.
 */
export function expectedCostToSuccess(
  input: ExpectedCostInput,
  model: RecoveryModel = DEFAULT_RECOVERY_MODEL,
): ExpectedCostBreakdown {
  if (!Number.isFinite(input.initial) || input.initial < 0) {
    throw new RangeError(`initial cost must be finite and non-negative (got ${input.initial})`);
  }
  if (
    !Number.isFinite(input.successProbability) ||
    input.successProbability < 0 ||
    input.successProbability > 1
  ) {
    throw new RangeError(
      `successProbability must be within [0, 1] (got ${input.successProbability})`,
    );
  }

  const failureProbability = 1 - input.successProbability;
  const retry = input.initial * model.retryCostFraction;

  // Nothing stronger to escalate to: the honest projection is one more attempt
  // on this same model. Inventing a cost for human intervention would be a
  // fabricated number.
  const escalation =
    input.escalationTargetCost === null
      ? retry
      : input.escalationTargetCost * (1 + model.handoffOverhead);

  const recovery = model.retryShare * retry + (1 - model.retryShare) * escalation;

  return {
    initial: input.initial,
    failureProbability,
    retry,
    escalation,
    recovery,
    expectedTotalToSuccess: input.initial + failureProbability * recovery,
  };
}

/**
 * The largest first-attempt cost at which a model is still the cheaper expected
 * path than its escalation target.
 *
 * Above this, a lower sticker price is a trap: the model looks cheaper and
 * costs more. Exposed so the boundary can be asserted in tests and explained to
 * a user, rather than being an emergent property nobody can point at.
 *
 * Returns `null` when there is nothing to compare against.
 */
export function breakevenInitialCost(
  successProbability: number,
  escalationTargetCost: number | null,
  model: RecoveryModel = DEFAULT_RECOVERY_MODEL,
): number | null {
  if (escalationTargetCost === null) return null;

  const failure = 1 - successProbability;
  const escalation = escalationTargetCost * (1 + model.handoffOverhead);

  // Solve initial + failure x (retryShare x initial + (1-retryShare) x escalation)
  //         = escalationTargetCost   for `initial`.
  const escalationTerm = failure * (1 - model.retryShare) * escalation;
  const initialCoefficient = 1 + failure * model.retryShare * model.retryCostFraction;

  const breakeven = (escalationTargetCost - escalationTerm) / initialCoefficient;
  return breakeven > 0 ? breakeven : 0;
}
