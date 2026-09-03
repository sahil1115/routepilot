/**
 * Analysis cache (spec section 10).
 *
 * Deliberately simple: an in-memory, bounded, per-root store. The intelligence
 * about *what to keep* lives in the fingerprint diff, not here — this class only
 * has to store, evict and report.
 *
 * Nothing here is persisted. A cache that survived restarts would need a
 * staleness story that a cheap fingerprint cannot honestly provide, and the
 * cost of one cold analysis per session is small.
 */

import type { FileInventory, Level1Facts, Level2Facts, Level3Facts } from '../types/analysis.js';
import type { RepositoryFingerprint } from './fingerprint.js';

/** One cached analysis of one repository. */
export interface CachedAnalysis {
  readonly fingerprint: RepositoryFingerprint;
  /** The shared file inventory. The expensive artefact worth preserving. */
  readonly inventory: FileInventory;
  readonly level1: Level1Facts;
  readonly level2?: Level2Facts | undefined;
  readonly level3?: Level3Facts | undefined;
}

/** Counters describing how well the cache is performing. */
export interface CacheStatistics {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly size: number;
}

const DEFAULT_MAX_ENTRIES = 8;

/** A bounded, in-memory cache of repository analyses, keyed by root path. */
export class AnalysisCache {
  readonly #entries = new Map<string, CachedAnalysis>();
  readonly #maxEntries: number;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`maxEntries must be a positive integer (received ${maxEntries})`);
    }
    this.#maxEntries = maxEntries;
  }

  /** Number of repositories currently cached. */
  get size(): number {
    return this.#entries.size;
  }

  /** Hit, miss and eviction counters. */
  get statistics(): CacheStatistics {
    return {
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      size: this.#entries.size,
    };
  }

  /** Look up a cached analysis, refreshing its recency on a hit. */
  get(root: string): CachedAnalysis | undefined {
    const key = normaliseRoot(root);
    const entry = this.#entries.get(key);

    if (entry === undefined) {
      this.#misses += 1;
      return undefined;
    }

    // Re-insert so iteration order is least-recently-used first.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#hits += 1;
    return entry;
  }

  /** Store an analysis, evicting the least recently used entry when full. */
  set(root: string, analysis: CachedAnalysis): void {
    const key = normaliseRoot(root);
    this.#entries.delete(key);

    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) {
        this.#entries.delete(oldest.value);
        this.#evictions += 1;
      }
    }

    this.#entries.set(key, analysis);
  }

  /** Forget one repository. Returns false when it was not cached. */
  invalidate(root: string): boolean {
    return this.#entries.delete(normaliseRoot(root));
  }

  /** Forget everything, including the statistics. */
  clear(): void {
    this.#entries.clear();
    this.#hits = 0;
    this.#misses = 0;
    this.#evictions = 0;
  }
}

/** Normalise a root path so separator style does not split cache entries. */
function normaliseRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
