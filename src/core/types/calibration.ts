/**
 * Calibration types (spec sections 41 and 44).
 *
 * Asks whether a learned probability is any good. Two failures need telling
 * apart:
 *
 * - **Miscalibration.** Says 90%, right 60% of the time. Ranking may be fine,
 *   but the number cannot be believed -- and expected-cost multiplies by it.
 * - **No discrimination.** Says 78% for everything and is right 78% of the
 *   time. Perfectly calibrated and useless.
 *
 * No single number expresses both, so the report carries a Brier score, its
 * decomposition, and a skill score against the base rate.
 */

import type { TaskScope } from './features.js';
import type { TaskType } from './task.js';

/** Where a prediction came from. */
export const PREDICTION_SOURCES = ['prior', 'learned'] as const;

/**
 * Where a prediction came from. Recorded per prediction so the two are scored
 * separately: pooling would let good priors disguise bad learned estimates.
 */
export type PredictionSource = (typeof PREDICTION_SOURCES)[number];

/** One prediction paired with what actually happened. */
export interface PredictionRecord {
  readonly requestId: string;
  readonly modelId: string;
  readonly taskType: TaskType;
  readonly scope: TaskScope;
  /** The probability that was predicted, in [0, 1]. */
  readonly predicted: number;
  /** What happened, in [0, 1]. Fractional: success is multi-dimensional. */
  readonly actual: number;
  readonly source: PredictionSource;
  /** Real observations behind the prediction when it was made. Never a pseudo-count. */
  readonly observations: number;
  readonly at: number;
}

/** One bucket of a reliability diagram. */
export interface CalibrationBin {
  /** Inclusive lower bound of the predicted-probability range. */
  readonly lowerBound: number;
  /** Exclusive upper bound, except for the final bin which includes 1. */
  readonly upperBound: number;
  /** Predictions falling in this range. Zero is a normal, reported value. */
  readonly count: number;
  /** Mean prediction in this bin, or `null` when the bin is empty. */
  readonly meanPrediction: number | null;
  /** Mean actual outcome in this bin, or `null` when the bin is empty. */
  readonly meanOutcome: number | null;
  /**
   * Signed gap, `meanPrediction - meanOutcome`, or `null` when empty. Positive
   * is over-confident. The sign matters: over-confidence wastes money on
   * attempts that fail, under-confidence escalates unnecessarily.
   */
  readonly gap: number | null;
}

/**
 * Calibration measured over a set of predictions. Each metric documents the
 * direction of "better", since one whose direction must be guessed gets
 * misread.
 */
export interface CalibrationReport {
  /** Predictions scored. */
  readonly count: number;
  /** Mean actual outcome -- what "always guess the average" would predict. */
  readonly baseRate: number;
  /**
   * Brier score: mean squared error of the probabilities. **Lower is better**;
   * 0 is perfect, 0.25 is what a constant 0.5 scores on a balanced problem.
   */
  readonly brierScore: number;
  /**
   * Improvement over always predicting the base rate. **Higher is better.**
   * Zero means no more useful than a constant; negative means worse. This is
   * what catches a predictor that is well calibrated and tells you nothing.
   *
   * `null` when every outcome is identical, since dividing by a zero reference
   * would manufacture a score out of nothing.
   */
  readonly brierSkillScore: number | null;
  /**
   * Reliability: how far bin accuracy strays from bin confidence.
   * **Lower is better**, 0 is perfectly calibrated.
   */
  readonly reliability: number;
  /**
   * Resolution: how much predictions vary from the base rate. **Higher is
   * better** -- the discrimination a constant predictor lacks entirely.
   */
  readonly resolution: number;
  /** Uncertainty: variance inherent in the outcomes. Not a quality measure. */
  readonly uncertainty: number;
  /**
   * `brierScore - (reliability - resolution + uncertainty)`.
   *
   * The Murphy decomposition is exact only when predictions are constant within
   * each bin; with ranged bins a within-bin spread term remains. Reported so it
   * can be checked rather than trusted.
   */
  readonly decompositionResidual: number;
  /**
   * Expected calibration error: count-weighted mean absolute bin gap.
   * **Lower is better.** The headline calibration number.
   */
  readonly expectedCalibrationError: number;
  /**
   * Worst single bin gap. **Lower is better.** Reported alongside ECE because a
   * predictor can look fine on average while being badly wrong in exactly the
   * high-confidence range routing acts on.
   */
  readonly maximumCalibrationError: number;
  /**
   * Signed mean error, `mean(predicted) - mean(actual)`. Positive is
   * over-confident. Unlike ECE this cannot cancel across bins into a flattering
   * number.
   */
  readonly bias: number;
  /** The reliability diagram, coarsest bound first. Empty bins included. */
  readonly bins: readonly CalibrationBin[];
}

/** Limits a predictor must satisfy before it may influence routing. */
export interface CalibrationThresholds {
  /** Predictions required before calibration can be judged at all. */
  readonly minimumSamples: number;
  /** Largest tolerable expected calibration error. */
  readonly maxExpectedCalibrationError: number;
  /** Largest tolerable single-bin error. */
  readonly maxCalibrationError: number;
  /** Smallest acceptable improvement over the base rate. */
  readonly minimumBrierSkillScore: number;
  /**
   * Whether a predictor must be proved well calibrated before use. False by
   * default, leaving an unassessed predictor to the training minimum; true
   * demands positive evidence, which suits expensive mistakes.
   */
  readonly requireCalibration: boolean;
}

/** How much a predictor may be believed. */
export const CALIBRATION_STATUSES = ['trusted', 'unassessed', 'distrusted'] as const;

/**
 * How much a predictor may be believed. Three states, because "not yet
 * measured" is not "bad" -- the absent-is-not-zero rule applies to calibration
 * itself.
 */
export type CalibrationStatus = (typeof CALIBRATION_STATUSES)[number];

/** The safeguard's decision, with its reasoning. */
export interface CalibrationVerdict {
  readonly status: CalibrationStatus;
  /** Whether learned predictions may be applied under this verdict. */
  readonly mayApply: boolean;
  /** One-phrase summary, suitable for a CLI line. */
  readonly reason: string;
  /** Every threshold that was breached, most serious first. Empty when none. */
  readonly failures: readonly string[];
  /** The metrics behind the decision, or `null` when there were too few to judge. */
  readonly report: CalibrationReport | null;
}

/** Persistence for prediction/outcome pairs. */
export interface PredictionStore {
  readonly enabled: boolean;
  /** Append prediction records. */
  recordPredictions(records: readonly PredictionRecord[]): void;
  /**
   * Load recent predictions, newest first. `source` narrows to one kind,
   * because pooling would hide the miscalibration this exists to find.
   */
  loadPredictions(limit: number, source?: PredictionSource): readonly PredictionRecord[];
}
