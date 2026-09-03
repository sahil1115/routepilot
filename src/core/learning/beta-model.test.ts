/**
 * Beta-Bernoulli shrinkage.
 *
 * The three properties asserted here are the phase's stated requirements
 * expressed as arithmetic — zero observations, sparse observations, and priors
 * remaining active — so they are tested on the pure function before anything
 * built on top of it is trusted.
 */

import { describe, expect, it } from 'vitest';

import { observationsForWeight, observedRate, shrinkToPrior } from './beta-model.js';

describe('shrinkToPrior', () => {
  it('returns the prior exactly when nothing has been observed', () => {
    // Not approximately, not 0.5, not zero. The requirement is "handle zero
    // observations", and the honest answer with no data is the prior itself.
    //
    // 0.8 is in this list deliberately: it is the value at which the general
    // formula returns 0.8000000000000002 in floating point, so it is the case
    // that proves the exactness claim rather than assuming it.
    for (const prior of [0.01, 0.3, 0.62, 0.8, 0.9, 0.99]) {
      expect(shrinkToPrior({ prior, strength: 12, observations: 0, successMass: 0 })).toBe(prior);
    }
  });

  it('barely moves on a single observation', () => {
    const after = shrinkToPrior({ prior: 0.6, strength: 12, observations: 1, successMass: 1 });

    // (12 x 0.6 + 1) / 13 = 0.6308. One lucky run must not promote a model.
    expect(after).toBeCloseTo(0.6308, 4);
    expect(after - 0.6).toBeLessThan(0.05);
  });

  it('converges on the observed rate once there is enough data', () => {
    const rates = [10, 50, 200, 1000].map((n) =>
      shrinkToPrior({ prior: 0.95, strength: 12, observations: n, successMass: n * 0.3 }),
    );

    // Monotonically abandoning a wrong prior, and close to the truth by 1000.
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]).toBeLessThan(rates[i - 1] as number);
    }
    // (12 x 0.95 + 300) / 1012 = 0.3077. The prior's fixed weight is all that
    // still separates it from the truth, and it shrinks as data grows.
    expect(rates[3]).toBeCloseTo(0.3077, 4);
    expect(Math.abs((rates[3] as number) - 0.3)).toBeLessThan(0.01);
  });

  it('weighs data and prior equally at exactly `strength` observations', () => {
    // The defining property of the strength parameter, so it means something
    // a user can reason about rather than being an unexplained constant.
    const result = shrinkToPrior({ prior: 0.4, strength: 12, observations: 12, successMass: 12 });
    expect(result).toBeCloseTo((0.4 + 1) / 2, 10);
  });

  it('never leaves [0, 1], even at the extremes', () => {
    expect(
      shrinkToPrior({ prior: 0, strength: 1, observations: 100, successMass: 100 }),
    ).toBeLessThanOrEqual(1);
    expect(
      shrinkToPrior({ prior: 1, strength: 1, observations: 100, successMass: 0 }),
    ).toBeGreaterThanOrEqual(0);
  });

  it('accepts fractional success mass, because success is not binary', () => {
    // Phase 8 scores a task that builds and lints but fails its tests somewhere
    // between 0 and 1; that partial credit must survive into learning.
    const result = shrinkToPrior({ prior: 0.5, strength: 10, observations: 4, successMass: 2.5 });
    expect(result).toBeCloseTo((10 * 0.5 + 2.5) / 14, 10);
  });

  it.each([
    ['a prior above 1', { prior: 1.2, strength: 12, observations: 0, successMass: 0 }],
    ['a negative prior', { prior: -0.1, strength: 12, observations: 0, successMass: 0 }],
    ['zero strength', { prior: 0.5, strength: 0, observations: 1, successMass: 1 }],
    ['a negative strength', { prior: 0.5, strength: -1, observations: 1, successMass: 1 }],
    [
      'a fractional observation count',
      { prior: 0.5, strength: 12, observations: 1.5, successMass: 1 },
    ],
    [
      'a negative observation count',
      { prior: 0.5, strength: 12, observations: -1, successMass: 0 },
    ],
    ['success mass above the count', { prior: 0.5, strength: 12, observations: 2, successMass: 3 }],
    ['negative success mass', { prior: 0.5, strength: 12, observations: 2, successMass: -1 }],
  ])('rejects %s', (_label, input) => {
    expect(() => shrinkToPrior(input)).toThrow(RangeError);
  });

  it('rejects a non-integer count specifically, so counts stay countable', () => {
    // A fractional sample count is the shape a fabricated count would take:
    // weighting an observation by its confidence and calling the total a
    // number of observations. The type system cannot stop it; this does.
    expect(() =>
      shrinkToPrior({ prior: 0.5, strength: 12, observations: 3.7, successMass: 1 }),
    ).toThrow(/non-negative integer/);
  });
});

describe('observedRate', () => {
  it('is null with no observations, not zero', () => {
    // No data is not the same as no successes, and a consumer must be forced
    // to tell the two apart.
    expect(observedRate(0, 0)).toBeNull();
  });

  it('is the plain empirical rate otherwise', () => {
    expect(observedRate(4, 1)).toBe(0.25);
    expect(observedRate(10, 0)).toBe(0);
  });
});

describe('observationsForWeight', () => {
  it('reports how much data is needed to outweigh the prior', () => {
    expect(observationsForWeight(12, 1)).toBe(12);
    expect(observationsForWeight(12, 4)).toBe(48);
  });

  it('rounds up, because a partial observation does not exist', () => {
    expect(observationsForWeight(12, 1.1)).toBe(14);
  });
});
