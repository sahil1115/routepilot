/**
 * Stage timings (spec section 69).
 *
 * Tracks feature extraction, repository analysis, routing and model execution.
 * The goal is explicitly not an absolute like "under 10ms" but the ratio of
 * routing overhead to the execution it is deciding about, so these are measured
 * and reported rather than asserted against a threshold: a benchmark that fails
 * when a machine is busy teaches nothing.
 *
 * The clock is injected because a decision carrying a wall-clock reading is no
 * longer byte-identical between runs. Timings are therefore carried beside
 * decisions, never inside them, and every measurement takes its clock as an
 * argument so a test can supply a fake.
 */

import type { Clock } from '../ports.js';

/** How long each stage of a routing pass took, in milliseconds. */
export interface StageTimings {
  /** Reading and understanding the repository. Usually dominated by one git call. */
  readonly analysisMs: number;
  /** Turning the analysis and the prompt into a feature vector. */
  readonly featureExtractionMs: number;
  /** Scoring every candidate and choosing one. */
  readonly routingMs: number;
  /** Everything above: what RoutePilot cost before a model was asked to do anything. */
  readonly totalOverheadMs: number;
}

/** Stage timings alongside what a model execution actually took. */
export interface RunTimings extends StageTimings {
  /** Time spent inside models, across every attempt. */
  readonly executionMs: number;
  /**
   * Overhead as a fraction of execution, or `null` when nothing executed.
   *
   * `null` rather than 0 or Infinity: with no execution to compare against,
   * the ratio is undefined, and reporting a number would invent a comparison
   * that was never made.
   */
  readonly overheadRatio: number | null;
}

/** Measure one stage. */
export async function measure<T>(
  clock: Clock,
  fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const started = clock.now();
  const value = await fn();
  return { value, ms: clock.now() - started };
}

/** Measure one synchronous stage. */
export function measureSync<T>(clock: Clock, fn: () => T): { value: T; ms: number } {
  const started = clock.now();
  const value = fn();
  return { value, ms: clock.now() - started };
}

/** Combine stage timings, computing the total. */
export function stageTimings(parts: {
  analysisMs: number;
  featureExtractionMs: number;
  routingMs: number;
}): StageTimings {
  return {
    ...parts,
    totalOverheadMs: parts.analysisMs + parts.featureExtractionMs + parts.routingMs,
  };
}

/**
 * Add execution time and the ratio the specification actually cares about.
 *
 * @throws RangeError on a negative execution time, which would make the ratio
 *   meaningless rather than merely wrong.
 */
export function runTimings(stages: StageTimings, executionMs: number): RunTimings {
  if (!Number.isFinite(executionMs) || executionMs < 0) {
    throw new RangeError(`executionMs must be finite and non-negative (got ${executionMs})`);
  }

  return {
    ...stages,
    executionMs,
    overheadRatio: executionMs === 0 ? null : stages.totalOverheadMs / executionMs,
  };
}
