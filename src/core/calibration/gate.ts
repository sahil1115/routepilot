/**
 * The calibration safeguard (spec sections 41 and 44).
 *
 * Stands between the learned model and the routing engine, and can switch
 * learning off on evidence. Three states, because a predictor with nine
 * predictions has not failed -- it has not been examined:
 *
 * - `trusted` -- measured, within every threshold.
 * - `unassessed` -- too few predictions to judge; the training minimum governs.
 * - `distrusted` -- measured and outside a threshold. Priors are restored.
 *
 * The default distrusts on evidence rather than demanding proof first, because
 * proof-first deadlocks: predictions are generated only while learning is
 * active. Operators who prefer a worse route to an unproven one set
 * `requireCalibration`, and then `unassessed` blocks too.
 *
 * Four ways to fail, since one number cannot catch them all: expected
 * calibration error (wrong on average); maximum calibration error (wrong
 * somewhere specific, which an average hides); Brier skill score (explains too
 * little variance -- this catches the predictor that answers 0.78 to
 * everything, so the floor sits above zero); and systematic over-confidence,
 * the signed bias ECE cannot express and the direction that costs money.
 */

import type {
  CalibrationReport,
  CalibrationThresholds,
  CalibrationVerdict,
} from '../types/calibration.js';
import { calibrationReport, type Scored } from './metrics.js';

/**
 * Default thresholds.
 *
 * Deliberately loose. A gate that fires constantly gets switched off, and a
 * switched-off gate protects nobody — so these are set to catch a predictor
 * that is *badly* wrong rather than one that is imperfect.
 */
export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  // Enough for ten bins to hold something meaningful without demanding a
  // history most users will never accumulate.
  minimumSamples: 50,
  // 0.15 means a claimed 90% that delivers 75%. Beyond that the number is not
  // a probability in any useful sense.
  maxExpectedCalibrationError: 0.15,
  // A single bin may stray further than the average before it disqualifies the
  // predictor, since one thin bin can swing on very little data.
  maxCalibrationError: 0.3,
  // Not zero. Zero admits the predictor that answers 0.70 to everything and is
  // right 70% of the time: perfectly calibrated, and unable to tell any task
  // from any other. Since
  //
  //     skill = (resolution - reliability) / uncertainty
  //
  // a small positive floor demands the predictor explain at least a little
  // outcome variance, which is exactly the discrimination a constant lacks.
  // Adopting it also protects the differentiated configured priors it would
  // otherwise replace with one flat number.
  minimumBrierSkillScore: 0.02,
  requireCalibration: false,
};

/** How far mean prediction may exceed mean outcome before it counts as over-confidence. */
export const MAX_OVERCONFIDENCE = 0.2;

/**
 * Judge whether a predictor may be believed.
 *
 * @param records Prediction/outcome pairs for **one** source. Pooling priors
 *   with learned estimates would let the former disguise the latter.
 */
export function assessCalibration(
  records: readonly Scored[],
  thresholds: CalibrationThresholds = DEFAULT_CALIBRATION_THRESHOLDS,
): CalibrationVerdict {
  if (records.length < thresholds.minimumSamples) {
    const detail = `${String(records.length)} of ${String(thresholds.minimumSamples)} predictions needed to judge calibration`;
    return {
      status: 'unassessed',
      // Unassessed is not a failure, so it blocks only where proof is demanded.
      mayApply: !thresholds.requireCalibration,
      reason: thresholds.requireCalibration
        ? `calibration unproven and proof is required — ${detail}`
        : `calibration not yet assessed — ${detail}`,
      failures: [],
      report: null,
    };
  }

  const report = calibrationReport(records);
  const failures = findFailures(report, thresholds);

  if (failures.length > 0) {
    return {
      status: 'distrusted',
      mayApply: false,
      reason: `predictions are poorly calibrated (${failures[0] ?? 'unknown'})`,
      failures,
      report,
    };
  }

  return {
    status: 'trusted',
    mayApply: true,
    reason: `calibrated over ${String(report.count)} predictions (ECE ${report.expectedCalibrationError.toFixed(3)})`,
    failures: [],
    report,
  };
}

/** A verdict for a predictor that has produced nothing yet. */
export const NOT_ASSESSED: CalibrationVerdict = {
  status: 'unassessed',
  mayApply: true,
  reason: 'no predictions have been scored',
  failures: [],
  report: null,
};

/**
 * Every threshold breached, most serious first.
 *
 * Ordered by what a user should fix first: a predictor with no skill is a
 * deeper problem than one whose probabilities are merely shifted.
 */
function findFailures(report: CalibrationReport, thresholds: CalibrationThresholds): string[] {
  const failures: string[] = [];

  // Checked first because it is the failure a calibration metric alone would
  // miss entirely: a constant predictor is perfectly calibrated.
  if (
    report.brierSkillScore !== null &&
    report.brierSkillScore < thresholds.minimumBrierSkillScore
  ) {
    failures.push(
      `little or no advantage over assuming the base rate ` +
        `(skill ${report.brierSkillScore.toFixed(3)} below ${thresholds.minimumBrierSkillScore.toFixed(3)})`,
    );
  }

  if (report.expectedCalibrationError > thresholds.maxExpectedCalibrationError) {
    failures.push(
      `expected calibration error ${report.expectedCalibrationError.toFixed(3)} ` +
        `above ${thresholds.maxExpectedCalibrationError.toFixed(3)}`,
    );
  }

  if (report.maximumCalibrationError > thresholds.maxCalibrationError) {
    failures.push(
      `worst bin off by ${report.maximumCalibrationError.toFixed(3)}, ` +
        `above ${thresholds.maxCalibrationError.toFixed(3)}`,
    );
  }

  if (report.bias > MAX_OVERCONFIDENCE) {
    failures.push(`systematically over-confident by ${report.bias.toFixed(3)}`);
  }

  return failures;
}
