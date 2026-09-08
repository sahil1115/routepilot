/**
 * Correcting a projection with measured spend (spec sections 14 and 15).
 *
 * Every routing decision multiplies by a projected cost, and that projection is
 * two guesses stacked: how many tokens a task will take, and what a token
 * costs. Either being wrong produces confidently wrong routing no matter how
 * good the success model is.
 *
 * Where an adapter reports token usage, the telemetry store already records
 * what an attempt was projected to cost and what that usage actually priced at.
 * This turns those pairs into a per-model correction factor and applies it to
 * the projection.
 *
 * ## What it measures, precisely
 *
 * **Token-estimate error, not price error.** Both sides of the ratio are priced
 * with the same configured table, so the price cancels: double the configured
 * price and projection and outcome double together, leaving the ratio
 * unchanged. What survives is the gap between estimated and actual token
 * counts, which is the coarser of the two guesses -- `estimateOutputTokens` is
 * an admitted heuristic.
 *
 * Detecting a *stale price* needs a source of truth for what was actually
 * charged, which no adapter reports. That is a separate factor and is not
 * implemented.
 *
 * ## Why an upper bound rather than the mean
 *
 * The mean is the best guess; it is not the safe one. Under-pricing a model
 * routes work to it on a budget that will not hold, and the overspend is
 * discovered after the money is gone. Over-pricing at worst routes to a dearer
 * model that was affordable anyway.
 *
 * So the factor is the upper end of a confidence interval on the mean ratio:
 *
 * ```
 * factor = mean(actual / estimated) + confidence x standardError
 * standardError = sampleStdDev / sqrt(n)
 * ```
 *
 * With few measurements the interval is wide and the correction is cautious in
 * the expensive direction. As measurements accumulate the interval narrows onto
 * the truth, so a model that genuinely costs *less* than its listed price is
 * eventually corrected downward too — the conservatism is in the bound, not in
 * a refusal to ever lower a price.
 *
 * ## What it will not do
 *
 * - Move anything below `minimumMeasuredAttempts`. One surprising invoice is
 *   not a correction factor, and `null` spread from a single sample cannot
 *   support an interval at all.
 * - Count an attempt whose usage was never reported. Some agents report none at
 *   all, so their runs are priced from the estimate; counting those would be
 *   comparing a number with itself and would drag every factor toward 1.
 * - Exceed `maxFactor`. A single pathological run should not make a model look
 *   unroutable.
 *
 * Deterministic throughout: the same measurements produce the same factor.
 */

import type { CostCorrection } from '../types/routing.js';
import type { CostReconciliation } from '../types/telemetry.js';

export type { CostCorrection };

/** How measured spend is allowed to correct a configured price. */
export interface CostCalibrationPolicy {
  readonly enabled: boolean;
  /**
   * Measured attempts required before a factor may move a decision.
   *
   * Below this the factor is exactly 1. A sample standard deviation needs at
   * least two points, so anything under 2 could not produce an interval anyway.
   */
  readonly minimumMeasuredAttempts: number;
  /**
   * Standard errors of headroom above the mean ratio.
   *
   * 1.64 is the one-sided 95% point of the normal distribution. Larger is more
   * cautious about under-pricing and more willing to overpay.
   */
  readonly confidence: number;
  /** Ceiling on the correction, so one pathological run cannot exclude a model. */
  readonly maxFactor: number;
}

/** Off. No measurement changes any price. */
export const COST_CALIBRATION_DISABLED: CostCalibrationPolicy = {
  enabled: false,
  minimumMeasuredAttempts: 5,
  confidence: 1.64,
  maxFactor: 3,
};

/** The default: on, but inert until there is enough measured evidence. */
export const DEFAULT_COST_CALIBRATION: CostCalibrationPolicy = {
  ...COST_CALIBRATION_DISABLED,
  enabled: true,
};

/** No correction, with the reason it was not applied. */
function none(modelId: string, measuredAttempts: number, reason: string): CostCorrection {
  return { modelId, factor: 1, applied: false, measuredAttempts, meanRatio: null, reason };
}

/**
 * Per-model price corrections derived from measured spend.
 *
 * Constructed with whatever the telemetry store reported. An empty set is the
 * normal state before any run has happened, and it corrects nothing.
 */
export class CostCalibration {
  readonly #byModel = new Map<string, CostReconciliation>();
  readonly #policy: CostCalibrationPolicy;

  constructor(
    reconciliations: readonly CostReconciliation[] = [],
    policy: CostCalibrationPolicy = COST_CALIBRATION_DISABLED,
  ) {
    this.#policy = policy;
    for (const entry of reconciliations) this.#byModel.set(entry.modelId, entry);
  }

  /** Whether calibration is switched on at all. */
  get enabled(): boolean {
    return this.#policy.enabled;
  }

  /** The correction for one model. Always safe to call; never throws. */
  correctionFor(modelId: string): CostCorrection {
    if (!this.#policy.enabled) return none(modelId, 0, 'cost calibration is disabled');

    const measured = this.#byModel.get(modelId);
    if (measured === undefined) {
      return none(modelId, 0, 'no measured spend for this model yet');
    }

    const { measuredAttempts, meanRatio, ratioStdDev } = measured;

    if (measuredAttempts < Math.max(2, this.#policy.minimumMeasuredAttempts)) {
      return none(
        modelId,
        measuredAttempts,
        `only ${String(measuredAttempts)} measured attempt(s); ` +
          `${String(this.#policy.minimumMeasuredAttempts)} needed before prices are corrected`,
      );
    }

    if (meanRatio === null || ratioStdDev === null || !Number.isFinite(meanRatio)) {
      return none(modelId, measuredAttempts, 'measured spend has no usable ratio');
    }

    // The upper end of a confidence interval on the mean, not the mean itself.
    // Under-pricing spends money that was never budgeted; over-pricing at worst
    // picks a dearer model that was affordable anyway.
    const standardError = ratioStdDev / Math.sqrt(measuredAttempts);
    const bound = meanRatio + this.#policy.confidence * standardError;

    // A negative or zero factor is not a price. It can only come from corrupt
    // data, and treating it as free would be the most expensive possible bug.
    const factor = Math.min(this.#policy.maxFactor, Math.max(0, bound));
    if (!Number.isFinite(factor) || factor <= 0) {
      return none(modelId, measuredAttempts, 'measured spend produced no usable factor');
    }

    return {
      modelId,
      factor,
      applied: true,
      measuredAttempts,
      meanRatio,
      reason:
        `measured spend over ${String(measuredAttempts)} attempt(s) runs ` +
        `${meanRatio.toFixed(2)}x the configured price; ` +
        `priced at the ${this.#policy.confidence}-sigma upper bound of ${factor.toFixed(2)}x`,
    };
  }
}
