/**
 * Bounded-concurrency mapping (spec section 69).
 *
 * Repository analysis is almost entirely filesystem I/O, and the analyzer used
 * to do it one file at a time. On this repository that measured:
 *
 * ```
 * readFile   182 files   sequential 47ms   concurrency 32   11ms
 * stat       182 files   sequential 22ms   concurrency 32    3ms
 * ```
 *
 * Four to seven times faster, and the gap widens with repository size — which
 * is exactly where analysis time starts to be noticeable.
 *
 * ## Why bounded rather than `Promise.all`
 *
 * `Promise.all(files.map(read))` on a large monorepo opens every file at once
 * and exhausts the process's file descriptors. The limit is not a performance
 * tuning knob so much as the thing that stops a big repository from failing
 * outright.
 *
 * 32 is the measured plateau: 128 was no faster on the same workload, and
 * every additional descriptor is one more thing to run out of.
 */

/** Default worker count. The measured plateau; higher buys nothing. */
export const DEFAULT_CONCURRENCY = 32;

/**
 * Map over `items` with at most `limit` operations in flight.
 *
 * Results keep the order of `items`, not the order they completed in, so the
 * caller sees a deterministic array however the I/O interleaved. Analysis
 * output must not depend on disk timing.
 *
 * @throws RangeError when `limit` is not a positive integer.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer (got ${limit})`);
  }
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;

      // `items[index]` is in range, but `noUncheckedIndexedAccess` cannot see
      // that from the bound above.
      results[index] = await fn(items[index] as T, index);
    }
  };

  await Promise.all(
    // Never more workers than items: spawning 32 promises to read 3 files is
    // pure overhead.
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  return results;
}
