/**
 * Bounded-concurrency mapping.
 *
 * Two properties carry the weight. **Order is preserved**, because analysis
 * output must not depend on which disk read finished first. And **the bound is
 * real**, because the alternative on a large monorepo is running out of file
 * descriptors.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONCURRENCY, mapWithConcurrency } from './concurrency.js';

/** A task that records how many were in flight at its peak. */
function tracker() {
  let inFlight = 0;
  let peak = 0;

  return {
    get peak() {
      return peak;
    },
    async run<T>(value: T, delayMs = 0): Promise<T> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      return value;
    },
  };
}

describe('mapWithConcurrency', () => {
  it('returns results in input order, not completion order', async () => {
    // The property analysis correctness depends on. Reversing the delays means
    // the last item finishes first, so an implementation that pushed results as
    // they arrived would fail here.
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 5, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, (6 - value) * 5));
      return value * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('passes the index alongside the item', async () => {
    const results = await mapWithConcurrency(['a', 'b', 'c'], 2, (item, index) =>
      Promise.resolve(`${String(index)}:${item}`),
    );

    expect(results).toEqual(['0:a', '1:b', '2:c']);
  });

  it('never exceeds the limit', async () => {
    const track = tracker();
    await mapWithConcurrency(
      Array.from({ length: 50 }, (_unused, i) => i),
      4,
      (value) => track.run(value, 2),
    );

    expect(track.peak).toBeLessThanOrEqual(4);
  });

  it('actually runs work in parallel, rather than quietly serialising', async () => {
    // A correct-looking implementation that awaited each item in turn would
    // pass every test above. This is the one that catches it.
    const track = tracker();
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_unused, i) => i),
      8,
      (value) => track.run(value, 5),
    );

    expect(track.peak).toBeGreaterThan(1);
  });

  it('spawns no more workers than there are items', async () => {
    const track = tracker();
    await mapWithConcurrency([1, 2, 3], 32, (value) => track.run(value, 5));

    expect(track.peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list without spawning anything', async () => {
    let called = 0;
    const results = await mapWithConcurrency([], 8, () => {
      called += 1;
      return Promise.resolve(0);
    });

    expect(results).toEqual([]);
    expect(called).toBe(0);
  });

  it('visits every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency(
      Array.from({ length: 100 }, (_unused, i) => i),
      7,
      (value) => {
        seen.push(value);
        return Promise.resolve(value);
      },
    );

    expect(seen).toHaveLength(100);
    expect(new Set(seen).size).toBe(100);
  });

  it('propagates a rejection rather than returning a partial result', async () => {
    // A silently truncated analysis would be worse than a failed one.
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (value) =>
        value === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(value),
      ),
    ).rejects.toThrow('boom');
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a limit of %s', async (limit) => {
    await expect(mapWithConcurrency([1], limit, () => Promise.resolve(1))).rejects.toThrow(
      RangeError,
    );
  });

  it('defaults to the measured plateau', () => {
    // 32 was where the measured gain stopped; 128 bought nothing and costs
    // descriptors.
    expect(DEFAULT_CONCURRENCY).toBe(32);
  });
});
