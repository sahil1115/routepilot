/**
 * Synthetic predictions with known calibration behaviour.
 *
 * The phase's validation instruction is to use predictions whose calibration is
 * known in advance and check that the metrics report it. That only works if the
 * data is exact — so every generator here places successes at even spacing
 * rather than drawing them, and each scenario is chosen so its Brier score,
 * ECE and skill score can be worked out by hand and asserted as literals.
 *
 * Each prediction level sits in its own reliability bin, which makes the Murphy
 * decomposition exact (`decompositionResidual === 0`) and lets the tests check
 * the identity rather than approximate it.
 *
 * Excluded from the published build (see tsconfig.build.json).
 */

import type { PredictionRecord } from '../core/types/calibration.js';
import type { Scored } from '../core/calibration/metrics.js';

/** One group of identical predictions and the rate at which they came true. */
export interface PredictionLevel {
  /** The probability predicted for every record in this group. */
  readonly predicted: number;
  /** How many predictions were made at this level. */
  readonly count: number;
  /** Fraction that actually succeeded. Realised exactly, not sampled. */
  readonly actualRate: number;
}

/**
 * Build predictions realising each level's rate exactly.
 *
 * `count x actualRate` must be a whole number, otherwise the requested rate is
 * not achievable and the caller would be asserting against a figure the data
 * cannot produce.
 */
export function syntheticPredictions(levels: readonly PredictionLevel[]): Scored[] {
  const records: Scored[] = [];

  for (const level of levels) {
    const successes = level.count * level.actualRate;
    if (Math.abs(successes - Math.round(successes)) > 1e-9) {
      throw new RangeError(
        `count ${String(level.count)} cannot realise rate ${String(level.actualRate)} exactly`,
      );
    }

    for (let index = 0; index < level.count; index += 1) {
      // Evenly spaced, so any prefix is also a fair sample of the level.
      const success =
        Math.floor((index + 1) * level.actualRate) > Math.floor(index * level.actualRate);
      records.push({ predicted: level.predicted, actual: success ? 1 : 0 });
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Named scenarios, with their hand-computed metrics in the doc comments
// ---------------------------------------------------------------------------

/**
 * Well calibrated **and** informative.
 *
 * Four prediction levels, each delivering exactly what it promised.
 * Reliability 0, ECE 0, and resolution well above zero because the levels
 * genuinely separate likely tasks from unlikely ones.
 */
export function wellCalibrated(): Scored[] {
  return syntheticPredictions([
    { predicted: 0.2, count: 50, actualRate: 0.2 },
    { predicted: 0.5, count: 50, actualRate: 0.5 },
    { predicted: 0.8, count: 50, actualRate: 0.8 },
    { predicted: 0.95, count: 100, actualRate: 0.95 },
  ]);
}

/**
 * Over-confident: claims 90%, delivers 60%.
 *
 * Brier 0.33, ECE 0.30, bias +0.30, skill -0.375. The dangerous direction —
 * an over-confident router spends money on attempts that fail.
 */
export function overConfident(count = 100): Scored[] {
  return syntheticPredictions([{ predicted: 0.9, count, actualRate: 0.6 }]);
}

/**
 * Under-confident: claims 50%, delivers 80%.
 *
 * Brier 0.25, ECE 0.30, bias **-0.30**. Just as miscalibrated as
 * {@link overConfident}, and caught by ECE, but the signed bias distinguishes
 * them: this router escalates to models it did not need.
 */
export function underConfident(count = 100): Scored[] {
  return syntheticPredictions([{ predicted: 0.5, count, actualRate: 0.8 }]);
}

/**
 * Perfectly calibrated and completely useless.
 *
 * Predicts the base rate for everything. Reliability 0 and ECE 0 — it passes
 * every calibration check — while resolution and skill are both 0, because it
 * cannot tell a task it will fail from one it will pass. This is the scenario
 * that proves calibration alone is not enough to trust a predictor.
 */
export function noSkill(count = 200, rate = 0.7): Scored[] {
  return syntheticPredictions([{ predicted: rate, count, actualRate: rate }]);
}

/**
 * A perfect predictor: 1 when it succeeds, 0 when it fails.
 *
 * Brier 0, ECE 0, skill 1. The upper bound, asserted so the metrics are pinned
 * at both ends of their range.
 */
export function perfect(count = 100, rate = 0.6): Scored[] {
  const successes = Math.round(count * rate);
  return [
    ...Array.from({ length: successes }, () => ({ predicted: 1, actual: 1 })),
    ...Array.from({ length: count - successes }, () => ({ predicted: 0, actual: 0 })),
  ];
}

/**
 * Worse than useless: confident exactly when it is wrong.
 *
 * Brier 0.81, skill deeply negative. A predictor whose ranking is inverted —
 * which no amount of recalibration would fix, and which the skill score is the
 * only metric here that catches.
 */
export function inverted(count = 100): Scored[] {
  return [
    ...Array.from({ length: count / 2 }, () => ({ predicted: 0.9, actual: 0 })),
    ...Array.from({ length: count / 2 }, () => ({ predicted: 0.1, actual: 1 })),
  ];
}

/**
 * Well calibrated on average, badly wrong in one band.
 *
 * Over-confident at the top and under-confident at the bottom by equal amounts,
 * so the **signed bias cancels to zero** while ECE stays high. Included because
 * a safeguard that watched only the bias would wave this through, and the band
 * it is wrong in is the high-confidence one routing acts on hardest.
 */
export function offsettingErrors(): Scored[] {
  return syntheticPredictions([
    { predicted: 0.9, count: 100, actualRate: 0.55 },
    { predicted: 0.2, count: 100, actualRate: 0.55 },
  ]);
}

/** Wrap scored pairs as full prediction records, for store-level tests. */
export function asRecords(
  scored: readonly Scored[],
  overrides: Partial<PredictionRecord> = {},
): PredictionRecord[] {
  return scored.map((record, index) => ({
    requestId: `req-${String(index).padStart(4, '0')}`,
    modelId: 'acme/one',
    taskType: 'feature-implementation',
    scope: 'few-files',
    predicted: record.predicted,
    actual: record.actual,
    source: 'learned',
    observations: 100,
    at: 1_700_000_000_000 + index,
    ...overrides,
  }));
}

/** A prediction store held in memory. */
export class InMemoryPredictionStore {
  readonly enabled = true;
  #rows: PredictionRecord[] = [];

  constructor(initial: readonly PredictionRecord[] = []) {
    this.#rows = [...initial];
  }

  recordPredictions(records: readonly PredictionRecord[]): void {
    for (const record of records) {
      const existing = this.#rows.findIndex(
        (row) => row.requestId === record.requestId && row.modelId === record.modelId,
      );
      if (existing >= 0) this.#rows[existing] = record;
      else this.#rows.push(record);
    }
  }

  loadPredictions(limit: number, source?: PredictionRecord['source']): readonly PredictionRecord[] {
    return this.#rows
      .filter((row) => source === undefined || row.source === source)
      .sort((a, b) => b.at - a.at || b.requestId.localeCompare(a.requestId))
      .slice(0, limit);
  }

  get size(): number {
    return this.#rows.length;
  }
}
