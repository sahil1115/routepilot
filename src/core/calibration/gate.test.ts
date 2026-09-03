/**
 * The calibration safeguard.
 *
 * The phase's operative instruction is "do not activate poorly calibrated
 * predictions without safeguards". These tests are that safeguard, exercised
 * against predictors whose calibration is known in advance.
 */

import { describe, expect, it } from 'vitest';

import type { CalibrationThresholds } from '../types/calibration.js';
import {
  inverted,
  noSkill,
  offsettingErrors,
  overConfident,
  perfect,
  syntheticPredictions,
  underConfident,
  wellCalibrated,
} from '../../test-support/calibration-fixtures.js';
import {
  assessCalibration,
  DEFAULT_CALIBRATION_THRESHOLDS,
  MAX_OVERCONFIDENCE,
  NOT_ASSESSED,
} from './gate.js';

const thresholds = (overrides: Partial<CalibrationThresholds> = {}): CalibrationThresholds => ({
  ...DEFAULT_CALIBRATION_THRESHOLDS,
  ...overrides,
});

/** A badly calibrated predictor at any even count, for sample-boundary tests. */
const mildlyOff = (count: number) =>
  syntheticPredictions([{ predicted: 0.9, count, actualRate: 0.5 }]);

describe('a well calibrated, informative predictor', () => {
  it('is trusted', () => {
    const verdict = assessCalibration(wellCalibrated());

    expect(verdict.status).toBe('trusted');
    expect(verdict.mayApply).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it('reports the evidence behind the verdict', () => {
    const verdict = assessCalibration(wellCalibrated());

    expect(verdict.report).not.toBeNull();
    expect(verdict.report?.count).toBe(250);
    expect(verdict.reason).toContain('250 predictions');
  });

  it('so is a perfect one', () => {
    expect(assessCalibration(perfect()).status).toBe('trusted');
  });
});

describe('a poorly calibrated predictor is withdrawn', () => {
  it('refuses an over-confident predictor', () => {
    const verdict = assessCalibration(overConfident());

    expect(verdict.status).toBe('distrusted');
    expect(verdict.mayApply).toBe(false);
  });

  it('names every threshold it breached, not just the first', () => {
    const verdict = assessCalibration(overConfident());

    expect(verdict.failures.length).toBeGreaterThan(1);
    expect(verdict.failures.join(' ')).toContain('expected calibration error');
    expect(verdict.failures.join(' ')).toContain('over-confident');
  });

  it('refuses an under-confident predictor too', () => {
    // Costly in the other direction: escalating to models that were not needed.
    const verdict = assessCalibration(underConfident());

    expect(verdict.status).toBe('distrusted');
    expect(verdict.failures.join(' ')).toContain('expected calibration error');
    // Not flagged as over-confident, because it is not.
    expect(verdict.failures.join(' ')).not.toContain('over-confident');
  });

  it('refuses an inverted predictor', () => {
    expect(assessCalibration(inverted()).status).toBe('distrusted');
  });

  it('catches errors that cancel in the average', () => {
    // Bias exactly zero, both bands badly wrong. A safeguard watching only the
    // signed bias would wave this through.
    const verdict = assessCalibration(offsettingErrors());

    expect(verdict.report?.bias).toBeCloseTo(0, 10);
    expect(verdict.status).toBe('distrusted');
  });
});

describe('the useless predictor', () => {
  it('is refused despite being perfectly calibrated', () => {
    // Answers the base rate to everything: reliability 0, ECE 0, and no ability
    // to tell one task from another. Every calibration metric passes it, which
    // is precisely why the skill floor exists.
    const records = noSkill();
    const verdict = assessCalibration(records);

    expect(verdict.report?.expectedCalibrationError).toBeCloseTo(0, 10);
    expect(verdict.report?.brierSkillScore).toBeCloseTo(0, 10);
    expect(verdict.status).toBe('distrusted');
    expect(verdict.failures[0]).toContain('base rate');
  });

  it('would have been trusted under a zero skill floor', () => {
    // Documents why the default is not zero: at zero this predictor passes.
    const permissive = assessCalibration(noSkill(), thresholds({ minimumBrierSkillScore: -1 }));
    expect(permissive.status).toBe('trusted');
  });
});

describe('too little evidence is not a failure', () => {
  it('reports unassessed rather than distrusted', () => {
    // Absent-is-not-zero, applied to calibration itself. Forty-five predictions
    // is not a bad predictor; it is an unexamined one.
    const verdict = assessCalibration(overConfident(45));

    expect(verdict.status).toBe('unassessed');
    expect(verdict.failures).toEqual([]);
    expect(verdict.report).toBeNull();
  });

  it('says how far short the evidence is', () => {
    expect(assessCalibration(overConfident(10)).reason).toContain('10 of 50');
  });

  it('permits learning by default, leaving the training minimum in charge', () => {
    // Requiring proof before activation would deadlock: predictions are only
    // generated while learning is active.
    expect(assessCalibration(overConfident(10)).mayApply).toBe(true);
  });

  it('blocks when proof is demanded', () => {
    const verdict = assessCalibration(overConfident(10), thresholds({ requireCalibration: true }));

    expect(verdict.status).toBe('unassessed');
    expect(verdict.mayApply).toBe(false);
    expect(verdict.reason).toContain('proof is required');
  });

  it('judges as soon as the sample threshold is met, and not before', () => {
    expect(assessCalibration(overConfident(45)).status).toBe('unassessed');
    expect(assessCalibration(mildlyOff(50)).status).toBe('distrusted');
  });

  it('starts from unassessed before anything has been scored', () => {
    expect(NOT_ASSESSED.status).toBe('unassessed');
    expect(NOT_ASSESSED.report).toBeNull();
    expect(NOT_ASSESSED.mayApply).toBe(true);
  });
});

describe('thresholds are configurable in both directions', () => {
  it('a stricter error limit withdraws a predictor the default accepts', () => {
    // Two levels, so the predictor genuinely discriminates and clears the skill
    // floor; each is off by 0.1, so ECE is 0.1 and the default accepts it.
    // A single-level predictor could not be used here: with resolution
    // necessarily zero, its skill score can never clear the floor.
    const records = syntheticPredictions([
      { predicted: 0.9, count: 100, actualRate: 0.8 },
      { predicted: 0.3, count: 100, actualRate: 0.2 },
    ]);

    expect(assessCalibration(records).report?.expectedCalibrationError).toBeCloseTo(0.1, 10);

    expect(
      assessCalibration(records, thresholds({ maxExpectedCalibrationError: 0.5 })).status,
    ).toBe('trusted');
    expect(
      assessCalibration(records, thresholds({ maxExpectedCalibrationError: 0.05 })).status,
    ).toBe('distrusted');
  });

  it('the worst-bin limit catches a predictor whose average looks acceptable', () => {
    // Ninety good predictions and ten badly wrong ones: ECE stays low while one
    // band is off by 0.8. Routing acts hardest in exactly such a band.
    const records = [
      ...syntheticPredictions([{ predicted: 0.9, count: 90, actualRate: 0.9 }]),
      ...syntheticPredictions([{ predicted: 0.2, count: 10, actualRate: 1 }]),
    ];
    const report = assessCalibration(records).report;

    expect(report?.expectedCalibrationError).toBeLessThan(
      DEFAULT_CALIBRATION_THRESHOLDS.maxExpectedCalibrationError,
    );
    expect(report?.maximumCalibrationError).toBeCloseTo(0.8, 10);
    expect(assessCalibration(records).status).toBe('distrusted');
  });

  it('flags over-confidence past the documented limit', () => {
    const justOver = syntheticPredictions([
      { predicted: 0.9, count: 100, actualRate: 0.9 - MAX_OVERCONFIDENCE - 0.05 },
    ]);

    expect(assessCalibration(justOver).failures.join(' ')).toContain('over-confident');
  });
});

describe('the verdict is deterministic', () => {
  it('returns the same answer for the same data', () => {
    expect(assessCalibration(wellCalibrated())).toEqual(assessCalibration(wellCalibrated()));
    expect(assessCalibration(overConfident())).toEqual(assessCalibration(overConfident()));
  });
});
