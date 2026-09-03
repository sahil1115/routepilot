/**
 * The learned success model.
 *
 * Covers the phase's validation list directly: train/update on outcomes,
 * persist, reload, zero observations, sparse observations, priors remaining
 * active, and — the one that needs the most care — no fake sample counts.
 */

import { describe, expect, it } from 'vitest';

import { emptyOutcome, OutcomeRecorder } from '../outcome/outcome-recorder.js';
import type { LearningContext, Observation } from '../types/learning.js';
import {
  InMemoryLearningStore,
  syntheticObservations,
} from '../../test-support/learning-fixtures.js';
import {
  DEFAULT_PRIOR_STRENGTH,
  LEARNING_DISABLED,
  LearnedSuccessModel,
  MINIMUM_EVIDENCE,
  NullLearningStore,
  observationFromOutcome,
} from './success-model.js';

const CONTEXT: LearningContext = {
  modelId: 'acme/one',
  taskType: 'feature-implementation',
  scope: 'few-files',
};

const ON = { enabled: true, minimumTrainingSamples: 20 };

const observation = (overrides: Partial<Observation> = {}): Observation => ({
  ...CONTEXT,
  success: 1,
  evidence: 1,
  ...overrides,
});

/** A model with `n` observations of which `successes` succeeded. */
function trained(n: number, successes: number, policy = ON): LearnedSuccessModel {
  const model = new LearnedSuccessModel(new InMemoryLearningStore(), policy);
  const batch: Observation[] = [];
  for (let i = 0; i < n; i += 1) batch.push(observation({ success: i < successes ? 1 : 0 }));
  model.observeAll(batch, 1_000);
  return model;
}

// ---------------------------------------------------------------------------
// Zero and sparse observations
// ---------------------------------------------------------------------------

describe('with no data at all', () => {
  it('returns the static prior untouched', () => {
    const model = new LearnedSuccessModel(new InMemoryLearningStore(), ON);
    const estimate = model.estimate(0.83, CONTEXT);

    expect(estimate.probability).toBe(0.83);
    expect(estimate.staticProbability).toBe(0.83);
    expect(estimate.applied).toBe(false);
  });

  it('reports zero observations and says why it did nothing', () => {
    const model = new LearnedSuccessModel(new InMemoryLearningStore(), ON);
    const estimate = model.estimate(0.83, CONTEXT);

    expect(estimate.observations).toBe(0);
    expect(estimate.reason).toBe('no observations for this model');
    expect(estimate.levels).toEqual([]);
  });

  it('does not borrow another model’s data', () => {
    const model = trained(50, 10);
    const other = model.estimate(0.83, { ...CONTEXT, modelId: 'acme/two' });

    expect(other.observations).toBe(0);
    expect(other.probability).toBe(0.83);
  });
});

describe('with sparse observations', () => {
  it('keeps using the prior below the training minimum', () => {
    const model = trained(19, 0, { enabled: true, minimumTrainingSamples: 20 });
    const estimate = model.estimate(0.9, CONTEXT);

    // Nineteen straight failures, and the estimate has not moved. That is the
    // point: below the minimum, learning must not influence routing at all
    // (spec section 2, rule 12).
    expect(estimate.probability).toBe(0.9);
    expect(estimate.applied).toBe(false);
  });

  it('says exactly how far short it is, rather than just refusing', () => {
    const model = trained(7, 3, { enabled: true, minimumTrainingSamples: 20 });
    expect(model.estimate(0.9, CONTEXT).reason).toBe('only 7 of 20 required observations');
  });

  it('crosses the threshold on the observation that reaches it, and not before', () => {
    const model = trained(19, 0, { enabled: true, minimumTrainingSamples: 20 });
    expect(model.estimate(0.9, CONTEXT).applied).toBe(false);

    model.observe(observation({ success: 0 }), 2_000);
    expect(model.estimate(0.9, CONTEXT).applied).toBe(true);
  });

  it('still shrinks heavily just past the minimum', () => {
    // Twenty failures against a 0.9 prior. The estimate drops, but nowhere near
    // to zero — the prior is worth 12 observations and has not been outvoted
    // by much yet.
    const estimate = trained(20, 0).estimate(0.9, CONTEXT);

    expect(estimate.probability).toBeCloseTo((12 * 0.9) / 32, 6);
    expect(estimate.probability).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// No fake sample counts
// ---------------------------------------------------------------------------

describe('sample counts are real counts', () => {
  it('never counts the prior’s pseudo-observations as data', () => {
    // The prior is worth 12 observations *inside the arithmetic*. If that
    // leaked into the reported count, this would say 12, or 32, instead of 20.
    const estimate = trained(20, 15).estimate(0.9, CONTEXT);

    expect(estimate.observations).toBe(20);
    expect(estimate.observations).not.toBe(DEFAULT_PRIOR_STRENGTH);
    expect(estimate.observations).not.toBe(20 + DEFAULT_PRIOR_STRENGTH);
  });

  it('counts each observation exactly once across the level partition', () => {
    // The levels are disjoint and cover everything. Were they nested instead,
    // the same evidence would be applied three times and this sum would come
    // to more than the total.
    const model = new LearnedSuccessModel(new InMemoryLearningStore(), ON);
    model.observeAll(
      [
        ...syntheticObservations('acme/one', 10, { taskType: 'bug-fix', scope: 'single-file' }),
        ...syntheticObservations('acme/one', 14, {
          taskType: 'feature-implementation',
          scope: 'many-files',
        }),
        ...syntheticObservations('acme/one', 6, {
          taskType: 'feature-implementation',
          scope: 'few-files',
        }),
      ],
      1_000,
    );

    const estimate = model.estimate(0.8, CONTEXT);
    const perLevel = estimate.levels.map((level) => level.observations);

    expect(perLevel).toEqual([10, 14, 6]);
    expect(perLevel.reduce((a, b) => a + b, 0)).toBe(estimate.observations);
    expect(estimate.observations).toBe(30);
  });

  it('keeps counts integral even when success is fractional', () => {
    const model = new LearnedSuccessModel(new InMemoryLearningStore(), ON);
    model.observeAll([observation({ success: 0.4 }), observation({ success: 0.7 })], 1_000);

    const [stats] = model.snapshot();
    expect(stats?.observations).toBe(2);
    expect(Number.isInteger(stats?.observations)).toBe(true);
    expect(stats?.successMass).toBeCloseTo(1.1, 10);
  });

  it('reports an unobserved level as null rate rather than a zero rate', () => {
    const estimate = trained(30, 20).estimate(0.8, CONTEXT);
    const [modelLevel, taskLevel, scopeLevel] = estimate.levels;

    expect(modelLevel?.observations).toBe(0);
    expect(modelLevel?.observedRate).toBeNull();
    expect(taskLevel?.observedRate).toBeNull();
    expect(scopeLevel?.observedRate).toBeCloseTo(20 / 30, 10);
  });

  it('passes the prior straight through a level with no data', () => {
    const estimate = trained(30, 20).estimate(0.8, CONTEXT);
    expect(estimate.levels[0]?.posterior).toBe(0.8);
    expect(estimate.levels[1]?.posterior).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// Priors remain active
// ---------------------------------------------------------------------------

describe('priors remain active', () => {
  it('is a complete no-op when learning is disabled, however much data exists', () => {
    const store = new InMemoryLearningStore();
    const trainer = new LearnedSuccessModel(store, ON);
    trainer.observeAll(syntheticObservations('acme/one', 500, { rate: 0 }), 1_000);

    const off = new LearnedSuccessModel(store, LEARNING_DISABLED);
    const estimate = off.estimate(0.9, CONTEXT);

    expect(estimate.probability).toBe(0.9);
    expect(estimate.applied).toBe(false);
    expect(estimate.reason).toBe('learning is disabled');
    // The data is still there and still counted honestly; it is just not used.
    expect(estimate.observations).toBe(500);
  });

  it('still anchors the estimate once learning is on', () => {
    // Even with data in charge, the prior contributes. A model observed 30
    // times at a rate of 1.0 is not certain to succeed.
    const estimate = trained(30, 30).estimate(0.5, CONTEXT);
    expect(estimate.probability).toBeLessThan(1);
    expect(estimate.probability).toBeCloseTo((12 * 0.5 + 30) / 42, 6);
  });

  it('moves a different distance from a different prior on identical data', () => {
    const optimistic = trained(30, 15).estimate(0.9, CONTEXT).probability;
    const pessimistic = trained(30, 15).estimate(0.4, CONTEXT).probability;

    expect(optimistic).toBeGreaterThan(pessimistic);
  });
});

// ---------------------------------------------------------------------------
// Train, persist, reload
// ---------------------------------------------------------------------------

describe('training and persistence', () => {
  it('accumulates across separate observations', () => {
    const model = new LearnedSuccessModel(new InMemoryLearningStore(), ON);
    model.observe(observation({ success: 1 }), 1_000);
    model.observe(observation({ success: 0 }), 2_000);

    const [stats] = model.snapshot();
    expect(stats?.observations).toBe(2);
    expect(stats?.successMass).toBe(1);
    expect(stats?.updatedAt).toBe(2_000);
  });

  it('writes through on every observation', () => {
    const store = new InMemoryLearningStore();
    const model = new LearnedSuccessModel(store, ON);

    model.observe(observation(), 1_000);
    model.observe(observation(), 2_000);

    expect(store.saveCount).toBe(2);
    expect(store.loadLearnedStats()[0]?.observations).toBe(2);
  });

  it('persists a batch in a single write', () => {
    const store = new InMemoryLearningStore();
    const model = new LearnedSuccessModel(store, ON);

    model.observeAll(syntheticObservations('acme/one', 40), 1_000);

    expect(store.saveCount).toBe(1);
    expect(store.loadLearnedStats()[0]?.observations).toBe(40);
  });

  it('reloads to exactly the same estimate', () => {
    const store = new InMemoryLearningStore();
    const first = new LearnedSuccessModel(store, ON);
    first.observeAll(syntheticObservations('acme/one', 60, { rate: 0.25 }), 1_000);

    const before = first.estimate(0.9, CONTEXT);
    const after = new LearnedSuccessModel(store, ON).estimate(0.9, CONTEXT);

    expect(after).toEqual(before);
  });

  it('re-saving the same snapshot cannot inflate a count', () => {
    // Replace semantics, not increment. A crashed run that repeats its final
    // write must not double the evidence it recorded.
    const store = new InMemoryLearningStore();
    const model = new LearnedSuccessModel(store, ON);
    model.observeAll(syntheticObservations('acme/one', 30), 1_000);

    store.saveLearnedStats(model.snapshot());
    store.saveLearnedStats(model.snapshot());

    expect(new LearnedSuccessModel(store, ON).totalObservations).toBe(30);
  });

  it('discards a corrupt row rather than computing from it', () => {
    // A store is a file on disk and can be edited. A negative count would make
    // the arithmetic produce a confident nonsense number instead of failing.
    const store = new InMemoryLearningStore([
      { ...CONTEXT, observations: -5, successMass: 0, updatedAt: 1 },
      { ...CONTEXT, taskType: 'bug-fix', observations: 3, successMass: 99, updatedAt: 1 },
      { ...CONTEXT, scope: 'many-files', observations: 30, successMass: 12, updatedAt: 1 },
    ]);

    const model = new LearnedSuccessModel(store, ON);
    expect(model.totalObservations).toBe(30);
  });

  it('works with a store that persists nothing', () => {
    // Telemetry off must still be a working system (spec section 2, rule 17).
    const model = new LearnedSuccessModel(new NullLearningStore(), ON);
    model.observeAll(syntheticObservations('acme/one', 40), 1_000);

    expect(model.totalObservations).toBe(40);
    expect(new LearnedSuccessModel(new NullLearningStore(), ON).totalObservations).toBe(0);
  });

  it('rejects a success score outside [0, 1]', () => {
    const model = new LearnedSuccessModel(new InMemoryLearningStore(), ON);
    expect(() => model.observe(observation({ success: 1.5 }), 1)).toThrow(RangeError);
    expect(() => model.observe(observation({ success: -0.1 }), 1)).toThrow(RangeError);
  });

  it('is deterministic: same data, same answer, regardless of insertion order', () => {
    const forward = new LearnedSuccessModel(new InMemoryLearningStore(), ON);
    const backward = new LearnedSuccessModel(new InMemoryLearningStore(), ON);

    const batch = [
      ...syntheticObservations('acme/one', 12, { taskType: 'bug-fix' }),
      ...syntheticObservations('acme/one', 18, { scope: 'many-files' }),
    ];
    forward.observeAll(batch, 1_000);
    backward.observeAll([...batch].reverse(), 1_000);

    expect(backward.estimate(0.8, CONTEXT)).toEqual(forward.estimate(0.8, CONTEXT));
  });
});

// ---------------------------------------------------------------------------
// Admission: what may be learned from
// ---------------------------------------------------------------------------

describe('observationFromOutcome', () => {
  const recorder = new OutcomeRecorder();

  const outcomeWith = (overrides: Parameters<typeof emptyOutcome>[1]) =>
    emptyOutcome('r1', { modelsUsed: ['acme/one'], ...overrides });

  it('admits a clean, evaluated, single-model outcome', () => {
    const outcome = outcomeWith({ buildPassed: true, testsPassed: true, taskCriteriaMet: true });
    const result = observationFromOutcome(outcome, recorder.score(outcome));

    expect(result).not.toBeNull();
    expect(result?.modelId).toBe('acme/one');
    expect(result?.success).toBeGreaterThan(0.9);
  });

  it('refuses an outcome nothing evaluated', () => {
    // score === null means unknown. Recording it as a zero would slander the
    // model for work nobody checked.
    const outcome = outcomeWith({});
    const score = recorder.score(outcome);

    expect(score.score).toBeNull();
    expect(observationFromOutcome(outcome, score)).toBeNull();
  });

  it('refuses an outcome that is not the model’s fault', () => {
    const outcome = outcomeWith({ buildPassed: false, failureType: 'PROVIDER_FAILURE' });
    const score = recorder.score(outcome);

    expect(score.modelAttributable).toBe(false);
    expect(observationFromOutcome(outcome, score)).toBeNull();
  });

  it('refuses an outcome backed by too little evidence', () => {
    const outcome = outcomeWith({ buildPassed: true, testsPassed: true });
    const score = recorder.score(outcome);

    expect(
      observationFromOutcome(outcome, { ...score, evidence: MINIMUM_EVIDENCE - 0.01 }),
    ).toBeNull();
    expect(
      observationFromOutcome(outcome, { ...score, evidence: MINIMUM_EVIDENCE }),
    ).not.toBeNull();
  });

  it('refuses to attribute an escalated task to any single model', () => {
    // After a handoff there is no honest way to say whose work succeeded.
    // Splitting the credit would be inventing data (spec section 2, rule 11).
    const outcome = outcomeWith({
      buildPassed: true,
      testsPassed: true,
      taskCriteriaMet: true,
      escalationCount: 1,
      modelsUsed: ['acme/one', 'acme/two'],
    });

    expect(observationFromOutcome(outcome, recorder.score(outcome))).toBeNull();
  });

  it('carries partial success through as partial credit', () => {
    const outcome = outcomeWith({ buildPassed: true, testsPassed: false, taskCriteriaMet: false });
    const score = recorder.score(outcome);
    const result = observationFromOutcome(outcome, score);

    expect(result?.success).toBe(score.score);
    expect(result?.success).toBeGreaterThan(0);
    expect(result?.success).toBeLessThan(1);
  });
});
