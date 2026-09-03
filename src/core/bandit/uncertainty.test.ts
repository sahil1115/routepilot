/**
 * Posterior width and optimism.
 *
 * The properties asserted here are what make exploration self-limiting: the
 * bound has to shrink as evidence accumulates, or a bandit built on it explores
 * forever.
 */

import { describe, expect, it } from 'vitest';

import { posteriorStdDev, relativeUncertainty, upperConfidenceBound } from './uncertainty.js';

describe('posteriorStdDev', () => {
  it('matches the Beta variance by hand', () => {
    // sqrt(0.5 x 0.5 / 13) = 0.13868
    expect(posteriorStdDev({ probability: 0.5, concentration: 12 })).toBeCloseTo(0.13868, 5);
  });

  it('is widest at a probability of one half', () => {
    const middle = posteriorStdDev({ probability: 0.5, concentration: 12 });

    for (const probability of [0.1, 0.3, 0.7, 0.9]) {
      expect(posteriorStdDev({ probability, concentration: 12 })).toBeLessThan(middle);
    }
  });

  it('is zero at certainty, because there is nothing left to doubt', () => {
    expect(posteriorStdDev({ probability: 0, concentration: 12 })).toBe(0);
    expect(posteriorStdDev({ probability: 1, concentration: 12 })).toBe(0);
  });

  it('shrinks monotonically as evidence accumulates', () => {
    // The property exploration depends on. Without it the bound never tightens
    // and the bandit keeps paying to re-learn what it already knows.
    const widths = [12, 50, 200, 1000].map((concentration) =>
      posteriorStdDev({ probability: 0.8, concentration }),
    );

    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeLessThan(widths[i - 1] as number);
    }
    expect(widths[3]).toBeLessThan(0.02);
  });

  it.each([
    ['a probability above 1', { probability: 1.5, concentration: 12 }],
    ['a negative probability', { probability: -0.1, concentration: 12 }],
    ['zero concentration', { probability: 0.5, concentration: 0 }],
    ['negative concentration', { probability: 0.5, concentration: -3 }],
  ])('rejects %s', (_label, input) => {
    expect(() => posteriorStdDev(input)).toThrow(RangeError);
  });
});

describe('upperConfidenceBound', () => {
  it('adds the requested number of standard deviations', () => {
    const input = { probability: 0.6, concentration: 12 };
    const sd = posteriorStdDev(input);

    expect(upperConfidenceBound(input, 1)).toBeCloseTo(0.6 + sd, 10);
    expect(upperConfidenceBound(input, 2)).toBeCloseTo(0.6 + 2 * sd, 10);
  });

  it('returns the mean itself at zero optimism', () => {
    // Zero optimism is pure exploitation, and it must be exactly that rather
    // than approximately.
    expect(upperConfidenceBound({ probability: 0.62, concentration: 12 }, 0)).toBe(0.62);
  });

  it('never exceeds 1', () => {
    expect(upperConfidenceBound({ probability: 0.98, concentration: 12 }, 5)).toBe(1);
  });

  it('never falls below the mean', () => {
    // A bound beneath the estimate would be a contradiction.
    for (const probability of [0, 0.3, 1]) {
      expect(upperConfidenceBound({ probability, concentration: 12 }, 2)).toBeGreaterThanOrEqual(
        probability,
      );
    }
  });

  it('gives a barely-tried model far more benefit of the doubt than a well-tried one', () => {
    // The whole mechanism in one assertion: same estimate, different evidence,
    // very different optimism.
    const novice = upperConfidenceBound({ probability: 0.7, concentration: 12 }, 1.5);
    const veteran = upperConfidenceBound({ probability: 0.7, concentration: 500 }, 1.5);

    expect(novice).toBeGreaterThan(veteran);
    expect(novice - 0.7).toBeGreaterThan(4 * (veteran - 0.7));
  });

  it('converges on the mean as evidence accumulates', () => {
    const bounds = [12, 100, 1000, 10_000].map((concentration) =>
      upperConfidenceBound({ probability: 0.8, concentration }, 1.5),
    );

    for (let i = 1; i < bounds.length; i += 1) {
      expect(bounds[i]).toBeLessThan(bounds[i - 1] as number);
    }
    // sqrt(0.16 / 10001) = 0.004, so at 1.5 sigma the bound sits at 0.806:
    // still above the mean, and small enough that optimism no longer decides
    // anything.
    expect(bounds[3]).toBeGreaterThan(0.8);
    expect(bounds[3]).toBeLessThan(0.81);
  });

  it('rejects a negative optimism', () => {
    expect(() => upperConfidenceBound({ probability: 0.5, concentration: 12 }, -1)).toThrow(
      RangeError,
    );
  });

  it('is deterministic — no sampling anywhere', () => {
    // Thompson sampling would fail this. Determinism has been a hard
    // requirement since Phase 3, and principle 9 forbids random selection.
    const input = { probability: 0.55, concentration: 40 };
    const bounds = Array.from({ length: 50 }, () => upperConfidenceBound(input, 1.5));

    expect(new Set(bounds).size).toBe(1);
  });
});

describe('relativeUncertainty', () => {
  it('is 1 at the widest point for a given amount of evidence', () => {
    expect(relativeUncertainty({ probability: 0.5, concentration: 30 })).toBeCloseTo(1, 10);
  });

  it('is 0 at certainty', () => {
    expect(relativeUncertainty({ probability: 1, concentration: 30 })).toBe(0);
  });

  it('stays within [0, 1] across the range', () => {
    for (const probability of [0, 0.2, 0.5, 0.8, 1]) {
      const value = relativeUncertainty({ probability, concentration: 25 });
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
