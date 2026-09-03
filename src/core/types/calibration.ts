/**
 * Calibration types (spec sections 41 and 44).
 *
 * Phase 10 made RoutePilot able to learn a success probability. This phase asks
 * the question that has to follow: **is that number any good?**
 *
 * The two failures are different and need telling apart:
 *
 * - **Miscalibration.** The model says 90% and is right 60% of the time. The
 *   ranking may still be fine — it just cannot be believed as a probability,
 *   which matters enormously here because the expected-cost arithmetic
 *   multiplies by it.
 * - **No discrimination.** The model says 78% for everything and is right 78%
 *   of the time. Perfectly calibrated, and completely useless, because it
 *   cannot tell a task it will fail from one it will pass.
 *
 * A single number cannot express both, which is why the report below carries a
 * Brier score *and* its decomposition *and* a skill score against the base rate.
 * A predictor that fails either way must not be quietly trusted.
 */

import type { TaskScope } from './features.js';
import type { TaskType } from './task.js';

/** Where a prediction came from. */
export const PREDICTION_SOURCES = ['prior', 'learned'] as const;

/**
 * Where a prediction came from.
 *
 * Recorded per prediction so the two can be scored **separately**. Pooling them
 * would let well-calibrated priors disguise badly calibrated learned estimates,
 * which is precisely the failure this phase exists to catch.
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
  /**
   * What actually happened, in [0, 1].
   *
   * Fractional because success is multi-dimensional (Phase 8). A task that
   * builds and lints but fails its tests is neither a 1 nor a 0.
   */
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
   * Signed gap, `meanPrediction - meanOutcome`, or `null` when empty.
   *
   * Positive means over-confident. The sign matters: an over-confident router
   * spends money on attempts that fail, while an under-confident one escalates
   * to models it did not need. They are not the same problem.
   */
  readonly gap: number | null;
}

/**
 * Calibration measured over a set of predictions.
 *
 * Every field is `null`-free except where a quantity genuinely cannot be
 * computed, and each is documented with the direction of "better", because a
 * metric whose direction the reader has to guess is a metric that will be
 * misread.
 */
export interface CalibrationReport {
  /** Predictions scored. */
  readonly count: number;
  /** Mean actual outcome — what "always guess the average" would predict. */
  readonly baseRate: number;
  /**
   * Brier score: mean squared error of the probabilities. **Lower is better**,
   * 0 is perfect, 0.25 is what a constant 0.5 scores on a balanced problem.
   */
  readonly brierScore: number;
  /**
   * Improvement over always predicting the base rate. **Higher is better.**
   *
   * Zero means the predictor is no more useful than a constant, and negative
   * means it is actively worse. This is the metric that catches a predictor
   * which is beautifully calibrated and tells you nothing.
   *
   * `null` when the base rate leaves no room to improve — every outcome
   * identical — because dividing by a zero reference would manufacture a score
   * out of nothing.
   */
  readonly brierSkillScore: number | null;
  /**
   * Reliability: how far bin accuracy strays from bin confidence.
   * **Lower is better**, 0 is perfectly calibrated.
   */
  readonly reliability: number;
  /**
   * Resolution: how much predictions vary from the base rate.
   * **Higher is better** — this is the discrimination a constant predictor
   * lacks entirely.
   */
  readonly resolution: number;
  /** Uncertainty: the variance inherent in the outcomes. Not a quality measure. */
  readonly uncertainty: number;
  /**
   * `brierScore - (reliability - resolution + uncertainty)`.
   *
   * The Murphy decomposition is exact only when predictions are constant within
   * each bin; with ranged bins a within-bin spread term remains. Reporting it
   * rather than hiding it means the decomposition can be checked instead of
   * trusted.
   */
  readonly decompositionResidual: number;
  /**
   * Expected calibration error: count-weighted mean absolute bin gap.
   * **Lower is better.** The headline calibration number.
   */
  readonly expectedCalibrationError: number;
  /**
   * Maximum calibration error: the worst single bin gap. **Lower is better.**
   *
   * Reported alongside ECE because a predictor can look fine on average while
   * being badly wrong in exactly the high-confidence range that routing acts on.
   */
  readonly maximumCalibrationError: number;
  /**
   * Signed mean error, `mean(predicted) - mean(actual)`.
   *
   * Positive is over-confident overall. Unlike ECE this does not cancel across
   * bins into a flattering number by accident — it is the systematic direction.
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
   * Whether a predictor must be *proved* well calibrated before it is used.
   *
   * False by default: an unassessed predictor is governed by Phase 10's own
   * training minimum. True demands positive evidence, which is the right
   * setting where a wrong route is expensive.
   */
  readonly requireCalibration: boolean;
}

/** How much a predictor may be believed. */
export const CALIBRATION_STATUSES = ['trusted', 'unassessed', 'distrusted'] as const;

/**
 * How much a predictor may be believed.
 *
 * Three states, not two, because "not yet measured" is not "bad" — the same
 * absent-is-not-zero rule that governs outcomes governs calibration itself. A
 * predictor with nine predictions to its name has not failed; it has not been
 * examined.
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
   * Load recent predictions, newest first.
   *
   * `source` narrows to one kind, because pooling priors with learned estimates
   * would hide exactly the miscalibration this phase looks for.
   */
  loadPredictions(limit: number, source?: PredictionSource): readonly PredictionRecord[];
}
