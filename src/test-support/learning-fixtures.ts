/**
 * Learning test fixtures: a synthetic world with known ground truth.
 *
 * The acceptance criterion for Phase 10 is that a learned policy **improves
 * routing on a deterministic synthetic dataset**. That demands three things
 * this file provides:
 *
 * 1. **Priors that are wrong in a specific, measurable way.** Two models are
 *    configured with misleading priors — one overrated, one underrated — so
 *    that static routing provably picks the worse model. If the priors were
 *    right, learning could not improve anything and the test would prove
 *    nothing.
 * 2. **Ground truth to score against.** Each model has a true success rate that
 *    the configuration does not know. "Improvement" is measured against these
 *    rates, not against the router's own opinion — otherwise the router would
 *    be grading its own homework.
 * 3. **Determinism.** Outcomes come from a fixed repeating pattern, never a
 *    random number generator. The same dataset produces byte-identical
 *    statistics on every run, on every machine.
 *
 * Excluded from the published build (see tsconfig.build.json).
 */

import type { LearnedStats, LearningStore, Observation } from '../core/types/learning.js';
import type { ModelSpec } from '../core/types/model.js';
import type { TaskScope } from '../core/types/features.js';
import type { TaskType } from '../core/types/task.js';
import { makeModel } from './fixtures.js';

/**
 * A model whose configuration flatters it.
 *
 * Declares near-frontier competence at code generation; actually succeeds
 * three times in ten. This is the failure mode static priors cannot detect: a
 * plausible number in a configuration file that nobody has checked against
 * reality (spec section 39).
 */
export function overratedModel(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return makeModel({
    id: 'acme/flatters-1',
    modelId: 'flatters-1',
    displayName: 'Acme Flatters 1',
    tier: 'medium',
    contextWindow: 400_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    latency: { firstTokenSeconds: 0.8, outputTokensPerSecond: 110 },
    priors: { skills: { codeGeneration: 0.96 }, languages: {} },
    ...overrides,
  });
}

/**
 * A model whose configuration undersells it.
 *
 * Declares modest competence; actually succeeds nineteen times in twenty. Priced
 * slightly above the overrated model, so static routing has every reason to
 * pass it over and only evidence can rescue it.
 */
export function underratedModel(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return makeModel({
    id: 'acme/modest-1',
    modelId: 'modest-1',
    displayName: 'Acme Modest 1',
    tier: 'medium',
    contextWindow: 400_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMillion: 3.3, outputPerMillion: 16.5, currency: 'USD' },
    latency: { firstTokenSeconds: 0.8, outputTokensPerSecond: 110 },
    priors: { skills: { codeGeneration: 0.74 }, languages: {} },
    ...overrides,
  });
}

/** Ground truth the router is not told. */
export const TRUE_SUCCESS_RATE: Readonly<Record<string, number>> = {
  'acme/flatters-1': 0.3,
  'acme/modest-1': 0.95,
};

/**
 * A deterministic run of outcomes for one model.
 *
 * Successes are spread through the sequence by comparing a running index
 * against the true rate, so a prefix of `n` observations always contains
 * `round(n x rate)` successes — no clustering, no randomness, and a short run
 * is a fair sample rather than an accident of ordering.
 */
export function syntheticObservations(
  modelId: string,
  count: number,
  options: {
    readonly rate?: number;
    readonly taskType?: TaskType;
    readonly scope?: TaskScope;
    readonly language?: string;
  } = {},
): Observation[] {
  const rate = options.rate ?? TRUE_SUCCESS_RATE[modelId] ?? 0.5;
  const taskType = options.taskType ?? 'feature-implementation';
  const scope = options.scope ?? 'few-files';
  const language = options.language ?? 'unknown';

  const observations: Observation[] = [];
  for (let index = 0; index < count; index += 1) {
    // True whenever crossing the next 1/rate boundary: evenly spaced, exact.
    const success = Math.floor((index + 1) * rate) > Math.floor(index * rate);
    observations.push({
      modelId,
      taskType,
      scope,
      language,
      success: success ? 1 : 0,
      evidence: 1,
    });
  }
  return observations;
}

/**
 * Expected cost to success under the **true** success rate.
 *
 * The scoring function for the acceptance test. It deliberately mirrors the
 * shape of the production expected-cost model rather than calling it, so that a
 * bug in the production model cannot make a routing decision look good by the
 * same mistaken arithmetic that produced it.
 */
export function trueExpectedCost(initialCost: number, trueRate: number): number {
  const RETRY_SHARE = 0.35;
  const HANDOFF_OVERHEAD = 0.2;
  const failure = 1 - trueRate;
  const retry = initialCost;
  const escalation = initialCost * (1 + HANDOFF_OVERHEAD);
  return initialCost + failure * (RETRY_SHARE * retry + (1 - RETRY_SHARE) * escalation);
}

/**
 * A learning store held in memory.
 *
 * Persists for the lifetime of the object, which is what makes "save, discard
 * the model, reload" expressible as a test without touching a disk.
 */
export class InMemoryLearningStore implements LearningStore {
  readonly enabled = true;
  #rows = new Map<string, LearnedStats>();
  /** Number of save calls, so write-through can be asserted. */
  saveCount = 0;

  constructor(initial: readonly LearnedStats[] = []) {
    for (const entry of initial) this.#rows.set(keyOf(entry), entry);
  }

  loadLearnedStats(): readonly LearnedStats[] {
    return [...this.#rows.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  }

  saveLearnedStats(stats: readonly LearnedStats[]): void {
    this.saveCount += 1;
    for (const entry of stats) this.#rows.set(keyOf(entry), entry);
  }

  /** Total rows held. */
  get size(): number {
    return this.#rows.size;
  }
}

function keyOf(stats: { modelId: string; taskType: string; scope: string }): string {
  return `${stats.modelId}\n${stats.taskType}\n${stats.scope}`;
}
