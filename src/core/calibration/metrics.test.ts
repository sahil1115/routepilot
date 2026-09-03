/**
 * Calibration metrics against synthetic predictions with known behaviour.
 *
 * Every expected value here is worked out by hand from the fixture definition,
 * not copied from a run. A metric test that asserts whatever the code produced
 * proves only that the code is deterministic.
 */

import { describe, expect, it } from 'vitest';

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
import { brierScore, calibrationReport, DEFAULT_BIN_COUNT, toScored } from './metrics.js';

describe('brierScore', () => {
  it('is zero for a predictor that is always right and certain', () => {
    expect(brierScore(perfect())).toBe(0);
  });

  it('is one for a predictor that is always wrong and certain', () => {
    expect(
      brierScore([
        { predicted: 1, actual: 0 },
        { predicted: 0, actual: 1 },
      ]),
    ).toBe(1);
  });

  it('is 0.25 for a coin-flip prediction, whatever happens', () => {
    expect(brierScore([{ predicted: 0.5, actual: 1 }])).toBe(0.25);
    expect(brierScore([{ predicted: 0.5, actual: 0 }])).toBe(0.25);
  });

  it('computes the over-confident case by hand: 0.6 x 0.01 + 0.4 x 0.81', () => {
    expect(brierScore(overConfident())).toBeCloseTo(0.33, 10);
  });

  it('handles fractional outcomes, since success is not binary', () => {
    // Phase 8 scores a partial success between 0 and 1, and it must survive
    // into the metrics rather than being rounded to a verdict.
    expect(brierScore([{ predicted: 0.8, actual: 0.6 }])).toBeCloseTo(0.04, 10);
  });

  it.each([
    ['an empty set', []],
    ['a prediction above 1', [{ predicted: 1.5, actual: 1 }]],
    ['a negative prediction', [{ predicted: -0.1, actual: 1 }]],
    ['an outcome above 1', [{ predicted: 0.5, actual: 2 }]],
    ['a negative outcome', [{ predicted: 0.5, actual: -1 }]],
  ])('rejects %s rather than returning a plausible number', (_label, records) => {
    expect(() => brierScore(records)).toThrow(RangeError);
  });

  it('refuses an empty set specifically, because no data is not perfect calibration', () => {
    expect(() => brierScore([])).toThrow(/at least one prediction/);
  });
});

describe('calibrationReport — a well calibrated, informative predictor', () => {
  const report = calibrationReport(wellCalibrated());

  it('reports zero calibration error', () => {
    expect(report.expectedCalibrationError).toBeCloseTo(0, 10);
    expect(report.maximumCalibrationError).toBeCloseTo(0, 10);
    expect(report.reliability).toBeCloseTo(0, 10);
  });

  it('reports real resolution, because the levels genuinely discriminate', () => {
    // Base rate 0.68 over 250 predictions; the four levels sit well away from it.
    expect(report.baseRate).toBeCloseTo(0.68, 10);
    expect(report.resolution).toBeCloseTo(0.0846, 6);
    expect(report.resolution).toBeGreaterThan(0);
  });

  it('reports positive skill against the base rate', () => {
    expect(report.brierSkillScore).toBeCloseTo(0.388787, 5);
  });

  it('carries no systematic bias', () => {
    expect(report.bias).toBeCloseTo(0, 10);
  });

  it('places each prediction level in its own bin', () => {
    const populated = report.bins.filter((bin) => bin.count > 0);

    expect(populated).toHaveLength(4);
    expect(populated.map((bin) => bin.count)).toEqual([50, 50, 50, 100]);
    expect(populated.map((bin) => bin.lowerBound)).toEqual([0.2, 0.5, 0.8, 0.9]);
  });
});

describe('the Murphy decomposition', () => {
  it('is exact when predictions are constant within each bin', () => {
    // BS = reliability - resolution + uncertainty. Asserting the residual is
    // what makes this a check rather than a restatement.
    for (const records of [wellCalibrated(), overConfident(), noSkill(), perfect(), inverted()]) {
      expect(Math.abs(calibrationReport(records).decompositionResidual)).toBeLessThan(1e-12);
    }
  });

  it('reconstructs the Brier score from its three parts', () => {
    const report = calibrationReport(overConfident());

    expect(report.reliability - report.resolution + report.uncertainty).toBeCloseTo(
      report.brierScore,
      10,
    );
    // Hand-computed: reliability 0.3^2 = 0.09, resolution 0, uncertainty 0.24.
    expect(report.reliability).toBeCloseTo(0.09, 10);
    expect(report.resolution).toBeCloseTo(0, 10);
    expect(report.uncertainty).toBeCloseTo(0.24, 10);
  });

  it('shows uncertainty equal to resolution for a perfect predictor', () => {
    // Perfect discrimination explains all of the outcome variance, leaving a
    // Brier score of zero.
    const report = calibrationReport(perfect());

    expect(report.resolution).toBeCloseTo(report.uncertainty, 10);
    expect(report.brierScore).toBe(0);
  });
});

describe('over-confidence and under-confidence are distinguished', () => {
  it('signs the bias positive when claims exceed delivery', () => {
    const report = calibrationReport(overConfident());

    expect(report.bias).toBeCloseTo(0.3, 10);
    expect(report.expectedCalibrationError).toBeCloseTo(0.3, 10);
  });

  it('signs the bias negative when delivery exceeds claims', () => {
    const report = calibrationReport(underConfident());

    expect(report.bias).toBeCloseTo(-0.3, 10);
    // Equally miscalibrated by ECE, which is unsigned — the bias is what tells
    // the two apart, and they call for opposite corrections.
    expect(report.expectedCalibrationError).toBeCloseTo(0.3, 10);
  });

  it('reports a zero bias when errors in opposite bands cancel', () => {
    // The case a bias-only check would wave through: the average is perfect and
    // both bands are badly wrong.
    const report = calibrationReport(offsettingErrors());

    expect(report.bias).toBeCloseTo(0, 10);
    expect(report.expectedCalibrationError).toBeCloseTo(0.35, 10);
    expect(report.maximumCalibrationError).toBeCloseTo(0.35, 10);
  });
});

describe('skill against the base rate', () => {
  it('is 1 for a perfect predictor', () => {
    expect(calibrationReport(perfect()).brierSkillScore).toBeCloseTo(1, 10);
  });

  it('is exactly 0 for a predictor that always answers the base rate', () => {
    // Perfectly calibrated and entirely uninformative. This number is why the
    // safeguard's floor sits above zero.
    const report = calibrationReport(noSkill());

    expect(report.brierSkillScore).toBeCloseTo(0, 10);
    expect(report.expectedCalibrationError).toBeCloseTo(0, 10);
    expect(report.resolution).toBeCloseTo(0, 10);
  });

  it('is deeply negative for an inverted predictor', () => {
    expect(calibrationReport(inverted()).brierSkillScore).toBeCloseTo(-2.24, 10);
  });

  it('is null when every outcome is identical, rather than invented', () => {
    // The reference scores zero, so there is nothing to improve on. Returning a
    // number here would be manufacturing a claim out of a division by zero.
    const report = calibrationReport(
      syntheticPredictions([{ predicted: 0.9, count: 60, actualRate: 1 }]),
    );

    expect(report.brierSkillScore).toBeNull();
    expect(report.uncertainty).toBe(0);
  });
});

describe('binning', () => {
  it('treats an empty bin as absent, not as perfectly calibrated', () => {
    // Ten bins, one populated. If empty bins counted as zero-gap they would
    // dilute ECE by a factor of ten and flatter every report.
    const report = calibrationReport(overConfident());

    expect(report.bins).toHaveLength(DEFAULT_BIN_COUNT);
    expect(report.bins.filter((bin) => bin.count > 0)).toHaveLength(1);
    expect(report.expectedCalibrationError).toBeCloseTo(0.3, 10);
  });

  it('reports an empty bin as null rather than zero', () => {
    const empty = calibrationReport(overConfident()).bins[0];

    expect(empty?.count).toBe(0);
    expect(empty?.meanPrediction).toBeNull();
    expect(empty?.meanOutcome).toBeNull();
    expect(empty?.gap).toBeNull();
  });

  it('closes the final bin so a prediction of exactly 1 has somewhere to go', () => {
    const report = calibrationReport([{ predicted: 1, actual: 1 }]);
    const last = report.bins[report.bins.length - 1];

    expect(last?.count).toBe(1);
    expect(last?.upperBound).toBe(1);
  });

  it('weights bins by their population', () => {
    // One badly wrong prediction among ninety well calibrated ones must not
    // read as a badly calibrated predictor.
    const records = [
      ...syntheticPredictions([{ predicted: 0.9, count: 90, actualRate: 0.9 }]),
      { predicted: 0.1, actual: 1 },
    ];
    const report = calibrationReport(records);

    // The worst bin is off by 0.9, but it holds one of ninety-one predictions.
    expect(report.maximumCalibrationError).toBeCloseTo(0.9, 10);
    expect(report.expectedCalibrationError).toBeCloseTo(0.9 / 91, 10);
  });

  it('accepts a different bin count', () => {
    expect(calibrationReport(wellCalibrated(), 4).bins).toHaveLength(4);
    expect(calibrationReport(wellCalibrated(), 20).bins).toHaveLength(20);
  });

  it.each([1, 0, -3, 2.5])('rejects a bin count of %s', (binCount) => {
    expect(() => calibrationReport(wellCalibrated(), binCount)).toThrow(RangeError);
  });
});

describe('toScored', () => {
  it('narrows records to the pairs the metrics need', () => {
    const scored = toScored([
      {
        requestId: 'r1',
        modelId: 'acme/one',
        taskType: 'bug-fix',
        scope: 'single-file',
        predicted: 0.7,
        actual: 1,
        source: 'learned',
        observations: 40,
        at: 1,
      },
    ]);

    expect(scored).toEqual([{ predicted: 0.7, actual: 1 }]);
  });
});
