/**
 * Correcting a stale price with measured spend.
 *
 * The half that changes behaviour. Recording what an attempt actually cost is
 * worth nothing on its own: v0.9.1 shipped the measurement and no routing
 * decision read it, which is the same "declared, plumbed, never set" shape that
 * had already bitten `permissionMode`, `allowFallback` and
 * `maxEscalationsPerTask` in this repository.
 */

import { describe, expect, it } from 'vitest';

import {
  cheapModel,
  featuresFor,
  mediumModel,
  policy,
} from '../../test-support/routing-fixtures.js';
import type { CostReconciliation } from '../types/telemetry.js';
import {
  CostCalibration,
  COST_CALIBRATION_DISABLED,
  DEFAULT_COST_CALIBRATION,
} from './cost-calibration.js';
import { CostEstimator } from './cost-estimator.js';
import { EXPLORATION_DISABLED } from '../bandit/exploration-gate.js';
import { LearnedSuccessModel } from '../learning/success-model.js';
import { ModelRegistry } from '../registry/model-registry.js';
import { RoutingEngine } from './routing-engine.js';

/**
 * A measured model.
 *
 * `ratioStdDev` is supplied directly rather than derived, so a test can say
 * "tight agreement" or "wildly scattered" without hand-rolling sums.
 */
function measured(overrides: Partial<CostReconciliation> = {}): CostReconciliation {
  return {
    modelId: 'acme/fast-1',
    measuredAttempts: 10,
    estimatedCost: 1,
    actualCost: 2,
    difference: 1,
    correctionFactor: 2,
    meanRatio: 2,
    ratioStdDev: 0,
    ...overrides,
  };
}

describe('measured spend corrects a configured price', () => {
  it('applies nothing when calibration is off', () => {
    const calibration = new CostCalibration([measured()], COST_CALIBRATION_DISABLED);
    const correction = calibration.correctionFor('acme/fast-1');

    expect(correction.applied).toBe(false);
    expect(correction.factor).toBe(1);
  });

  it('applies nothing for a model with no measurements', () => {
    // The normal state before any run. Absent must not read as "agrees".
    const calibration = new CostCalibration([measured()], DEFAULT_COST_CALIBRATION);
    const correction = calibration.correctionFor('acme/never-run');

    expect(correction.applied).toBe(false);
    expect(correction.factor).toBe(1);
    expect(correction.measuredAttempts).toBe(0);
  });

  it('refuses to move a price on too few attempts, and says how many it needs', () => {
    // One surprising invoice is not a correction factor.
    const calibration = new CostCalibration(
      [measured({ measuredAttempts: 2 })],
      DEFAULT_COST_CALIBRATION,
    );
    const correction = calibration.correctionFor('acme/fast-1');

    expect(correction.applied).toBe(false);
    expect(correction.factor).toBe(1);
    expect(correction.reason).toContain('2 measured attempt');
    expect(correction.reason).toContain('5 needed');
  });

  it('corrects upward when measured spend exceeds the configured price', () => {
    const calibration = new CostCalibration([measured()], DEFAULT_COST_CALIBRATION);
    const correction = calibration.correctionFor('acme/fast-1');

    expect(correction.applied).toBe(true);
    // Zero spread, so the bound sits on the mean.
    expect(correction.factor).toBeCloseTo(2, 10);
    expect(correction.meanRatio).toBe(2);
  });

  it('prices at the upper bound, not the mean, when the ratios are scattered', () => {
    // The conservative direction. Under-pricing spends money that was never
    // budgeted; over-pricing at worst picks a dearer model that was affordable.
    const tight = new CostCalibration(
      [measured({ ratioStdDev: 0.1 })],
      DEFAULT_COST_CALIBRATION,
    ).correctionFor('acme/fast-1');
    const scattered = new CostCalibration(
      [measured({ ratioStdDev: 1.0 })],
      DEFAULT_COST_CALIBRATION,
    ).correctionFor('acme/fast-1');

    expect(scattered.factor).toBeGreaterThan(tight.factor);
    expect(tight.factor).toBeGreaterThan(2);
  });

  it('narrows onto the mean as measurements accumulate', () => {
    // The interval is wide when uncertain and tightens with evidence, so the
    // caution is temporary rather than a permanent surcharge.
    const few = new CostCalibration(
      [measured({ measuredAttempts: 5, ratioStdDev: 0.5 })],
      DEFAULT_COST_CALIBRATION,
    ).correctionFor('acme/fast-1');
    const many = new CostCalibration(
      [measured({ measuredAttempts: 500, ratioStdDev: 0.5 })],
      DEFAULT_COST_CALIBRATION,
    ).correctionFor('acme/fast-1');

    expect(few.factor).toBeGreaterThan(many.factor);
    expect(many.factor).toBeCloseTo(2, 1);
  });

  it('will correct downward once a cheaper model is well evidenced', () => {
    // The conservatism is in the bound, not in a refusal to ever lower a price.
    // A model that genuinely costs half its listed price should eventually be
    // routed as such, or the correction only ever penalises.
    const correction = new CostCalibration(
      [measured({ measuredAttempts: 500, meanRatio: 0.5, ratioStdDev: 0.05 })],
      DEFAULT_COST_CALIBRATION,
    ).correctionFor('acme/fast-1');

    expect(correction.applied).toBe(true);
    expect(correction.factor).toBeLessThan(1);
  });

  it('caps a pathological factor rather than making a model unroutable', () => {
    const correction = new CostCalibration(
      [measured({ meanRatio: 1_000, ratioStdDev: 0 })],
      DEFAULT_COST_CALIBRATION,
    ).correctionFor('acme/fast-1');

    expect(correction.factor).toBe(DEFAULT_COST_CALIBRATION.maxFactor);
  });

  it('refuses a non-finite or negative ratio rather than pricing from it', () => {
    // Corrupt data must not become a free model, which would be the most
    // expensive possible failure of this feature.
    for (const meanRatio of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const correction = new CostCalibration(
        [measured({ meanRatio, ratioStdDev: 0 })],
        DEFAULT_COST_CALIBRATION,
      ).correctionFor('acme/fast-1');

      expect(correction.factor).toBeGreaterThan(0);
      expect(Number.isFinite(correction.factor)).toBe(true);
    }
  });

  it('does not apply without a spread to build an interval from', () => {
    const correction = new CostCalibration(
      [measured({ ratioStdDev: null })],
      DEFAULT_COST_CALIBRATION,
    ).correctionFor('acme/fast-1');

    expect(correction.applied).toBe(false);
    expect(correction.factor).toBe(1);
  });
});

describe('the correction reaches the expected-cost projection', () => {
  const features = featuresFor('add a small feature');
  const candidates = [
    { model: cheapModel(), successProbability: 0.8 },
    { model: mediumModel(), successProbability: 0.9 },
  ];

  it('raises the projected cost of a model measured to be dearer', () => {
    // The decisive test. Everything above is arithmetic; this is the arithmetic
    // reaching a routing decision.
    const uncorrected = new CostEstimator().estimate(candidates, features);
    const corrected = new CostEstimator(
      new CostCalibration(
        [measured({ modelId: cheapModel().id, meanRatio: 3, ratioStdDev: 0 })],
        DEFAULT_COST_CALIBRATION,
      ),
    ).estimate(candidates, features);

    const before = uncorrected.get(cheapModel().id)?.cost.initial ?? 0;
    const after = corrected.get(cheapModel().id)?.cost.initial ?? 0;

    expect(before).toBeGreaterThan(0);
    expect(after).toBeCloseTo(before * 3, 8);
  });

  it('leaves a model with no measurements exactly as configured', () => {
    // The positive control: a correction that moved everything would be a bug
    // dressed as a feature.
    const uncorrected = new CostEstimator().estimate(candidates, features);
    const corrected = new CostEstimator(
      new CostCalibration(
        [measured({ modelId: cheapModel().id, meanRatio: 3, ratioStdDev: 0 })],
        DEFAULT_COST_CALIBRATION,
      ),
    ).estimate(candidates, features);

    expect(corrected.get(mediumModel().id)?.cost.initial).toBe(
      uncorrected.get(mediumModel().id)?.cost.initial,
    );
  });

  it('can change which model is cheapest', () => {
    // The whole point: a stale price that routing believed is corrected, and
    // the decision moves with it.
    const cheap = cheapModel();
    const medium = mediumModel();
    const plain = new CostEstimator().estimate(candidates, features);

    const cheapFirst =
      (plain.get(cheap.id)?.cost.initial ?? 0) < (plain.get(medium.id)?.cost.initial ?? 0);
    expect(cheapFirst).toBe(true);

    // Measured at 10x, the cheap model is no longer the cheaper first attempt.
    const corrected = new CostEstimator(
      new CostCalibration(
        [measured({ modelId: cheap.id, meanRatio: 10, ratioStdDev: 0, measuredAttempts: 50 })],
        { ...DEFAULT_COST_CALIBRATION, maxFactor: 20 },
      ),
    ).estimate(candidates, features);

    expect(corrected.get(cheap.id)?.cost.initial ?? 0).toBeGreaterThan(
      corrected.get(medium.id)?.cost.initial ?? 0,
    );
  });
});

describe('a corrected price is auditable', () => {
  it('says so in the explanation, with the factor', () => {
    // A projection that differs from the configured table must say why, or a
    // reader checking it against their own price list cannot reconcile the two
    // and will reasonably conclude the router is wrong.
    const models = new ModelRegistry([cheapModel(), mediumModel()]);
    const decision = new RoutingEngine(
      models,
      new LearnedSuccessModel(),
      EXPLORATION_DISABLED,
      new CostCalibration(
        [measured({ modelId: cheapModel().id, meanRatio: 2, ratioStdDev: 0 })],
        DEFAULT_COST_CALIBRATION,
      ),
    ).route({ features: featuresFor('add a small feature'), policy: policy() });

    const corrected = decision.evaluations.find((e) => e.modelId === cheapModel().id);
    expect(corrected?.costCorrection?.applied).toBe(true);
    expect(corrected?.costCorrection?.factor).toBeCloseTo(2, 6);
    expect(decision.explanation.join(' ')).toContain('price corrected 2.00x');
  });

  it('says nothing when no price was corrected', () => {
    // An unapplied correction on every candidate would be noise in every
    // explanation, so absence has to stay silent.
    const models = new ModelRegistry([cheapModel(), mediumModel()]);
    const decision = new RoutingEngine(models).route({
      features: featuresFor('add a small feature'),
      policy: policy(),
    });

    expect(decision.evaluations.every((e) => e.costCorrection === undefined)).toBe(true);
    expect(decision.explanation.join(' ')).not.toContain('price corrected');
  });
});
