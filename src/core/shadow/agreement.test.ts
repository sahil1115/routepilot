/**
 * Aggregating recorded shadow decisions.
 *
 * The numbers here are what a user reads to decide whether to adopt a different
 * policy, so the ones that must not lie are the ones that could be mistaken for
 * measured savings.
 */

import { describe, expect, it } from 'vitest';

import type { ShadowRecord } from '../types/shadow.js';
import { summariseAgreement } from './agreement.js';

const record = (overrides: Partial<ShadowRecord> = {}): ShadowRecord => ({
  requestId: 'req-1',
  policyId: 'cheapest-first',
  currentModelId: 'acme/balanced-1',
  shadowModelId: 'acme/balanced-1',
  agrees: true,
  estimatedCostDelta: 0,
  successProbabilityDelta: 0,
  at: 1_000,
  ...overrides,
});

/** `n` records, the first `agreeing` of which agree. */
function history(
  n: number,
  agreeing: number,
  overrides: Partial<ShadowRecord> = {},
): ShadowRecord[] {
  return Array.from({ length: n }, (_unused, index) =>
    record({
      requestId: `req-${String(index)}`,
      agrees: index < agreeing,
      shadowModelId: index < agreeing ? 'acme/balanced-1' : 'acme/fast-1',
      estimatedCostDelta: index < agreeing ? 0 : -0.05,
      ...overrides,
    }),
  );
}

describe('summariseAgreement', () => {
  it('counts agreements and reports the rate', () => {
    const [summary] = summariseAgreement(history(10, 7));

    expect(summary?.count).toBe(10);
    expect(summary?.agreements).toBe(7);
    expect(summary?.agreementRate).toBeCloseTo(0.7, 10);
  });

  it('reports an unmeasured rate as null, not as perfect agreement', () => {
    // Nothing recorded means the rate is unknown. Zero would read as total
    // disagreement and one as total agreement; both would be inventions.
    expect(summariseAgreement([])).toEqual([]);
  });

  it('separates policies and keeps them in first-seen order', () => {
    const summaries = summariseAgreement([
      record({ policyId: 'strongest-first', requestId: 'a' }),
      record({ policyId: 'cheapest-first', requestId: 'b' }),
      record({ policyId: 'strongest-first', requestId: 'c' }),
    ]);

    expect(summaries.map((entry) => entry.policyId)).toEqual(['strongest-first', 'cheapest-first']);
    expect(summaries[0]?.count).toBe(2);
    expect(summaries[1]?.count).toBe(1);
  });

  it('sums the estimated cost delta over comparable decisions only', () => {
    const [summary] = summariseAgreement(history(10, 7));

    // Three divergences at -0.05 each.
    expect(summary?.estimatedCostDelta).toBeCloseTo(-0.15, 10);
    expect(summary?.comparableCount).toBe(10);
  });

  it('excludes a decision where either policy selected nothing', () => {
    // `null` is not zero. Counting it as a zero delta would quietly pull the
    // total toward "no difference" and inflate the comparable count.
    const [summary] = summariseAgreement([
      record({ requestId: 'a', agrees: false, estimatedCostDelta: -0.2 }),
      record({ requestId: 'b', agrees: false, estimatedCostDelta: null, shadowModelId: null }),
    ]);

    expect(summary?.estimatedCostDelta).toBeCloseTo(-0.2, 10);
    expect(summary?.comparableCount).toBe(1);
    expect(summary?.count).toBe(2);
  });

  it('reports the comparable count separately, so a total cannot be misread', () => {
    // A delta summed over three decisions and one summed over three hundred
    // look identical without this.
    const summaries = summariseAgreement([
      ...history(3, 0),
      record({ requestId: 'x', agrees: false, estimatedCostDelta: null }),
    ]);

    expect(summaries[0]?.count).toBe(4);
    expect(summaries[0]?.comparableCount).toBe(3);
  });

  it('lists which models a policy preferred when it disagreed', () => {
    const summaries = summariseAgreement([
      record({ requestId: 'a', agrees: false, shadowModelId: 'acme/deep-1' }),
      record({ requestId: 'b', agrees: false, shadowModelId: 'acme/deep-1' }),
      record({ requestId: 'c', agrees: false, shadowModelId: 'acme/fast-1' }),
    ]);

    expect(summaries[0]?.divergentChoices).toEqual([
      { modelId: 'acme/deep-1', count: 2 },
      { modelId: 'acme/fast-1', count: 1 },
    ]);
  });

  it('excludes agreements from the divergent choices', () => {
    // A list dominated by the model both policies already chose says nothing
    // about the alternative.
    const [summary] = summariseAgreement(history(10, 7));

    expect(summary?.divergentChoices).toEqual([{ modelId: 'acme/fast-1', count: 3 }]);
  });

  it('breaks ties by model id, so the report is deterministic', () => {
    const summaries = summariseAgreement([
      record({ requestId: 'a', agrees: false, shadowModelId: 'zeta/one' }),
      record({ requestId: 'b', agrees: false, shadowModelId: 'alpha/one' }),
    ]);

    expect(summaries[0]?.divergentChoices.map((choice) => choice.modelId)).toEqual([
      'alpha/one',
      'zeta/one',
    ]);
  });

  it('is unaffected by the order records arrive in', () => {
    const forward = history(10, 7);
    const backward = [...forward].reverse();

    const a = summariseAgreement(forward)[0];
    const b = summariseAgreement(backward)[0];

    expect(b?.agreementRate).toBe(a?.agreementRate);
    expect(b?.estimatedCostDelta).toBeCloseTo(a?.estimatedCostDelta ?? 0, 10);
    expect(b?.divergentChoices).toEqual(a?.divergentChoices);
  });

  it('handles total agreement and total disagreement', () => {
    expect(summariseAgreement(history(5, 5))[0]?.agreementRate).toBe(1);
    expect(summariseAgreement(history(5, 0))[0]?.agreementRate).toBe(0);
  });
});
