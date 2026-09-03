/**
 * The calibration safeguard (spec sections 41 and 44).
 *
 * "Do not activate poorly calibrated predictions without safeguards." This is
 * the safeguard: it stands between the learned model of Phase 10 and the
 * routing engine, and it can switch learning off on evidence.
 *
 * ## Three states, not two
 *
 * A predictor with nine predictions to its name has not failed — it has not
 * been examined, and the difference is the whole of absent-is-not-zero applied
 * to calibration itself:
 *
 * - **`trusted`** — measured, and within every threshold.
 * - **`unassessed`** — too few predictions to judge. Phase 10's own training
 *   minimum still governs, and nothing here overrides it.
 * - **`distrusted`** — measured, and demonstrably outside a threshold. Learning
 *   is suppressed and the configured priors are restored.
 *
 * ## Why the default is "distrust on evidence" rather than "prove it first"
 *
 * Requiring proof before activation is a deadlock: predictions are only
 * generated while learning is active, so a predictor that must be proved
 * calibrated before it may be used can never generate the evidence to prove it.
 *
 * The default therefore lets an unassessed predictor run under Phase 10's
 * gate and withdraws it the moment the evidence says it is wrong. Operators who
 * would rather pay for a worse route than an unproven one set
 * `requireCalibration`, and then `unassessed` blocks too. Both paths are
 * tested.
 *
 * ## What "poorly calibrated" means here
 *
 * Four ways to fail, because one number cannot catch them all:
 *
 * 1. **Expected calibration error** too high — the probabilities are wrong on
 *    average.
 * 2. **Maximum calibration error** too high — they are wrong somewhere
 *    specific, which an average can hide, and routing acts hardest in exactly
 *    the high-confidence range where it matters most.
 * 3. **Brier skill score** too low — the predictor explains too little of the
 *    outcome variance to be worth consulting. This is what catches the
 *    predictor that answers 0.78 to everything: perfectly calibrated by every
 *    other measure here, and useless. The floor is deliberately **above zero**,
 *    because a skill score of exactly zero *is* that predictor.
 * 4. **Systematic over-confidence** — a signed bias that ECE cannot express,
 *    and the direction that actually costs money, because it spends on attempts
 *    that fail.
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
