/**
 * Calibration metrics (spec section 41).
 *
 * Pure arithmetic over `(predicted, actual)` pairs, isolated so it can be
 * checked against hand-computed values without a router, store or model.
 *
 * ```
 * Brier score  = mean( (p - o)^2 )                     lower is better
 *              = reliability - resolution + uncertainty
 *
 * reliability  = sum_k (n_k/N) (pbar_k - obar_k)^2     lower is better
 * resolution   = sum_k (n_k/N) (obar_k - obar)^2       higher is better
 * uncertainty  = obar (1 - obar)                       a property of the data
 *
 * ECE          = sum_k (n_k/N) |pbar_k - obar_k|       lower is better
 * MCE          = max_k |pbar_k - obar_k|               lower is better
 * skill        = 1 - BS / BS_baseRate                  higher is better
 * ```
 *
 * The Brier score alone cannot decide whether a predictor may be trusted: one
 * that answers 0.78 to everything scores respectably while distinguishing
 * nothing. `resolution` and `brierSkillScore` catch that, and the safeguard
 * checks them.
 *
 * The decomposition is exact only when predictions within each bin are
 * identical; with ranged bins a within-bin spread term survives. It is computed
 * explicitly as `decompositionResidual` so the identity can be verified rather
 * than assumed.
 */

import type { CalibrationBin, CalibrationReport, PredictionRecord } from '../types/calibration.js';

/** Default reliability-diagram resolution: ten bins of width 0.1. */
export const DEFAULT_BIN_COUNT = 10;

/** A prediction paired with its outcome, which is all the metrics need. */
export interface Scored {
  readonly predicted: number;
  readonly actual: number;
}

/**
 * Mean squared error of the predicted probabilities.
 *
 * @throws RangeError on an empty set, or on any value outside [0, 1].
 */
export function brierScore(records: readonly Scored[]): number {
  assertScorable(records);

  let total = 0;
  for (const record of records) {
    const error = record.predicted - record.actual;
    total += error * error;
  }
  return total / records.length;
}

/**
 * Full calibration report.
 *
 * @param binCount Reliability-diagram resolution. More bins resolve the shape
 *   of the miscalibration; fewer keep each bin populated enough to mean
 *   something. Ten is the usual compromise.
 * @throws RangeError on an empty set, a bin count below 2, or a value outside
 *   [0, 1].
 */
export function calibrationReport(
  records: readonly Scored[],
  binCount: number = DEFAULT_BIN_COUNT,
): CalibrationReport {
  assertScorable(records);
  if (!Number.isInteger(binCount) || binCount < 2) {
    throw new RangeError(`binCount must be an integer of at least 2 (got ${binCount})`);
  }

  const count = records.length;
  const baseRate = mean(records.map((record) => record.actual));
  const meanPredicted = mean(records.map((record) => record.predicted));
  const score = brierScore(records);

  const bins = buildBins(records, binCount);

  let reliability = 0;
  let resolution = 0;
  let weightedAbsoluteGap = 0;
  let worstGap = 0;

  for (const bin of bins) {
    // An empty bin is not evidence of anything. Counting it as a perfect zero
    // would flatter every report, and counting it as a failure would slander
    // every predictor that simply never emits that range.
    if (bin.count === 0 || bin.meanOutcome === null || bin.gap === null) continue;

    const weight = bin.count / count;
    reliability += weight * bin.gap * bin.gap;
    resolution += weight * (bin.meanOutcome - baseRate) ** 2;
    weightedAbsoluteGap += weight * Math.abs(bin.gap);
    worstGap = Math.max(worstGap, Math.abs(bin.gap));
  }

  const uncertainty = baseRate * (1 - baseRate);

  return {
    count,
    baseRate,
    brierScore: score,
    brierSkillScore: skillScore(score, records, baseRate),
    reliability,
    resolution,
    uncertainty,
    decompositionResidual: score - (reliability - resolution + uncertainty),
    expectedCalibrationError: weightedAbsoluteGap,
    maximumCalibrationError: worstGap,
    bias: meanPredicted - baseRate,
    bins,
  };
}

/**
 * Improvement over always predicting the base rate.
 *
 * `null` when the reference itself scores zero — every outcome identical, so
 * there is nothing to improve on. Returning 0, or 1, or dividing anyway, would
 * each invent a claim the data cannot support.
 */
function skillScore(score: number, records: readonly Scored[], baseRate: number): number | null {
  const reference = mean(records.map((record) => (baseRate - record.actual) ** 2));
  if (reference === 0) return null;
  return 1 - score / reference;
}

/** Partition predictions into equal-width bins over [0, 1]. */
function buildBins(records: readonly Scored[], binCount: number): CalibrationBin[] {
  const width = 1 / binCount;
  const buckets: Scored[][] = Array.from({ length: binCount }, () => []);

  for (const record of records) {
    // The final bin is closed at 1 so a prediction of exactly 1 has somewhere
    // to go; every other bin is half-open.
    const index = Math.min(binCount - 1, Math.floor(record.predicted / width));
    buckets[index]?.push(record);
  }

  return buckets.map((bucket, index) => {
    const lowerBound = index * width;
    const upperBound = index === binCount - 1 ? 1 : (index + 1) * width;

    if (bucket.length === 0) {
      return {
        lowerBound,
        upperBound,
        count: 0,
        meanPrediction: null,
        meanOutcome: null,
        gap: null,
      };
    }

    const meanPrediction = mean(bucket.map((record) => record.predicted));
    const meanOutcome = mean(bucket.map((record) => record.actual));

    return {
      lowerBound,
      upperBound,
      count: bucket.length,
      meanPrediction,
      meanOutcome,
      gap: meanPrediction - meanOutcome,
    };
  });
}

/** Narrow prediction records to the pairs the metrics need. */
export function toScored(records: readonly PredictionRecord[]): Scored[] {
  return records.map((record) => ({ predicted: record.predicted, actual: record.actual }));
}

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * Reject inputs that would produce a plausible-looking wrong number.
 *
 * An empty set has no calibration — not a perfect one — and a probability
 * outside [0, 1] means a caller has a bug that a silently clamped metric would
 * hide.
 */
function assertScorable(records: readonly Scored[]): void {
  if (records.length === 0) {
    throw new RangeError('calibration needs at least one prediction');
  }
  for (const record of records) {
    if (!Number.isFinite(record.predicted) || record.predicted < 0 || record.predicted > 1) {
      throw new RangeError(`predicted must be within [0, 1] (got ${record.predicted})`);
    }
    if (!Number.isFinite(record.actual) || record.actual < 0 || record.actual > 1) {
      throw new RangeError(`actual must be within [0, 1] (got ${record.actual})`);
    }
  }
}
