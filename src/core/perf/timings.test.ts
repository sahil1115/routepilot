/**
 * Stage timings and the overhead ratio.
 *
 * The specification's actual question is "is routing overhead small compared
 * with model execution", so the thing that must be right is the ratio — and
 * what it does when there is nothing to compare against.
 */

import { describe, expect, it } from 'vitest';

import { measure, measureSync, runTimings, stageTimings } from './timings.js';

/** A clock that returns each value in turn, so durations are exact. */
function scriptedClock(...values: number[]) {
  let index = 0;
  return {
    now: () => {
      const value = values[Math.min(index, values.length - 1)] ?? 0;
      index += 1;
      return value;
    },
  };
}

describe('stageTimings', () => {
  it('totals the stages', () => {
    const timings = stageTimings({ analysisMs: 200, featureExtractionMs: 0.5, routingMs: 0.25 });
    expect(timings.totalOverheadMs).toBeCloseTo(200.75, 10);
  });

  it('reports zero overhead as zero, not as missing', () => {
    const timings = stageTimings({ analysisMs: 0, featureExtractionMs: 0, routingMs: 0 });
    expect(timings.totalOverheadMs).toBe(0);
  });
});

describe('runTimings', () => {
  const stages = stageTimings({ analysisMs: 300, featureExtractionMs: 0, routingMs: 0 });

  it('reports overhead as a fraction of execution', () => {
    // The number the specification asks about: 300 ms of routing against a
    // 30-second run is one percent.
    expect(runTimings(stages, 30_000).overheadRatio).toBeCloseTo(0.01, 10);
  });

  it('reports null when nothing executed, rather than a number', () => {
    // Zero execution makes the ratio undefined. Returning 0 would claim the
    // overhead was free and Infinity would claim it was total; both invent a
    // comparison that was never made.
    expect(runTimings(stages, 0).overheadRatio).toBeNull();
  });

  it('carries the execution time through unchanged', () => {
    expect(runTimings(stages, 12_345).executionMs).toBe(12_345);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an execution time of %s',
    (value) => {
      expect(() => runTimings(stages, value)).toThrow(RangeError);
    },
  );

  it('does not pretend overhead is small when it is not', () => {
    // A guard against the metric being quietly flattering: 300 ms of overhead
    // on a 100 ms execution is 300%, and it should say so.
    expect(runTimings(stages, 100).overheadRatio).toBeCloseTo(3, 10);
  });
});

describe('measure', () => {
  it('times an async stage against the supplied clock', async () => {
    const { value, ms } = await measure(scriptedClock(1_000, 1_250), () => Promise.resolve('done'));

    expect(value).toBe('done');
    expect(ms).toBe(250);
  });

  it('times a synchronous stage', () => {
    const { value, ms } = measureSync(scriptedClock(500, 502), () => 42);

    expect(value).toBe(42);
    expect(ms).toBe(2);
  });

  it('uses the injected clock and no other, so a test is deterministic', async () => {
    // Twice, same clock script, same answer. A wall clock would not manage it.
    const first = await measure(scriptedClock(0, 7), () => Promise.resolve(null));
    const second = await measure(scriptedClock(0, 7), () => Promise.resolve(null));

    expect(second.ms).toBe(first.ms);
  });

  it('propagates a rejection rather than reporting a duration', async () => {
    await expect(
      measure(scriptedClock(0, 5), () => Promise.reject(new Error('failed'))),
    ).rejects.toThrow('failed');
  });
});
