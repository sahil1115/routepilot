/**
 * Phase 10 acceptance: a learned policy must improve routing on a deterministic
 * synthetic dataset.
 *
 * The setup is built so that improvement is *measurable against ground truth*
 * rather than against the router's own opinion. Two models carry deliberately
 * misleading priors:
 *
 * | model             | declared | true rate | first attempt |
 * | ----------------- | -------- | --------- | ------------- |
 * | `acme/flatters-1` | 0.96     | **0.30**  | 0.13507 USD   |
 * | `acme/modest-1`   | 0.74     | **0.95**  | 0.14858 USD   |
 *
 * Static routing picks `flatters` — it looks more capable *and* costs less per
 * attempt, so nothing in the Phase 9 machinery can catch the error. Only
 * evidence can. The improvement is then scored with `trueExpectedCost`, which
 * uses the true rates the router was never told.
 */

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../registry/model-registry.js';
import { RoutingEngine } from '../routing/routing-engine.js';
import type { ModelEvaluation, RoutingDecision } from '../types/routing.js';
import { featuresFor, policy } from '../../test-support/routing-fixtures.js';
import {
  InMemoryLearningStore,
  overratedModel,
  syntheticObservations,
  TRUE_SUCCESS_RATE,
  trueExpectedCost,
  underratedModel,
} from '../../test-support/learning-fixtures.js';
import { LearnedSuccessModel, type LearningPolicy } from './success-model.js';

const TASK = 'implement a new /users API endpoint';
const MODELS = [overratedModel(), underratedModel()];
const REGISTRY = new ModelRegistry(MODELS);

/** Confidence low enough that the threshold cannot be what decides anything. */
const PERMISSIVE = policy({ minimumSuccessProbability: 0.5 });

const learningOn: LearningPolicy = { enabled: true, minimumTrainingSamples: 50 };

/** A store holding the full synthetic dataset: 200 observations per model. */
function trainedStore(count = 200): InMemoryLearningStore {
  const store = new InMemoryLearningStore();
  const trainer = new LearnedSuccessModel(store, learningOn);
  trainer.observeAll(syntheticObservations('acme/flatters-1', count), 1_000);
  trainer.observeAll(syntheticObservations('acme/modest-1', count), 1_000);
  return store;
}

function routeWith(store: InMemoryLearningStore | null, learning = learningOn): RoutingDecision {
  const model =
    store === null ? new LearnedSuccessModel() : new LearnedSuccessModel(store, learning);
  return new RoutingEngine(REGISTRY, model).route({
    features: featuresFor(TASK),
    policy: PERMISSIVE,
  });
}

const evaluationFor = (decision: RoutingDecision, modelId: string): ModelEvaluation => {
  const found = decision.evaluations.find((candidate) => candidate.modelId === modelId);
  if (found === undefined) throw new Error(`no evaluation for ${modelId}`);
  return found;
};

/** Expected cost of a decision, scored against the rates the router never saw. */
function realisedCost(decision: RoutingDecision): number {
  const selected = decision.selectedModelId;
  if (selected === null) throw new Error('nothing was selected');
  const evaluation = evaluationFor(decision, selected);
  const truth = TRUE_SUCCESS_RATE[selected];
  if (truth === undefined) throw new Error(`no ground truth for ${selected}`);
  return trueExpectedCost(evaluation.cost.initial, truth);
}

// ---------------------------------------------------------------------------
// The premise: static routing gets this wrong
// ---------------------------------------------------------------------------

describe('the priors are wrong, and static routing cannot tell', () => {
  it('picks the overrated model', () => {
    expect(routeWith(null).selectedModelId).toBe('acme/flatters-1');
  });

  it('picks it on both confidence and cost, so nothing else could catch the error', () => {
    const decision = routeWith(null);
    const flatters = evaluationFor(decision, 'acme/flatters-1');
    const modest = evaluationFor(decision, 'acme/modest-1');

    expect(flatters.successProbability).toBeGreaterThan(modest.successProbability);
    expect(flatters.cost.initial).toBeLessThan(modest.cost.initial);
    expect(flatters.cost.expectedTotalToSuccess).toBeLessThan(modest.cost.expectedTotalToSuccess);
  });

  it('and it is the more expensive choice in reality', () => {
    // 0.24191 against 0.15697 USD, under the true rates.
    const decision = routeWith(null);
    expect(realisedCost(decision)).toBeGreaterThan(
      trueExpectedCost(evaluationFor(decision, 'acme/modest-1').cost.initial, 0.95),
    );
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE: learning improves routing
// ---------------------------------------------------------------------------

describe('ACCEPTANCE — a learned policy improves routing', () => {
  it('reverses the choice once the evidence is in', () => {
    expect(routeWith(trainedStore()).selectedModelId).toBe('acme/modest-1');
  });

  it('lowers the true expected cost to success', () => {
    const before = realisedCost(routeWith(null));
    const after = realisedCost(routeWith(trainedStore()));

    expect(after).toBeLessThan(before);
    // 0.15697 against 0.24191 — a 35% reduction in what the task really costs.
    expect(after / before).toBeLessThan(0.7);
  });

  it('chooses the model that is genuinely cheapest under the true rates', () => {
    const decision = routeWith(trainedStore());
    const trueCosts = decision.evaluations.map((candidate) => ({
      modelId: candidate.modelId,
      cost: trueExpectedCost(candidate.cost.initial, TRUE_SUCCESS_RATE[candidate.modelId] ?? 0),
    }));
    const best = [...trueCosts].sort((a, b) => a.cost - b.cost)[0];

    expect(decision.selectedModelId).toBe(best?.modelId);
  });

  it('learns probabilities close to the truth', () => {
    const decision = routeWith(trainedStore());

    expect(evaluationFor(decision, 'acme/flatters-1').successProbability).toBeCloseTo(0.3, 1);
    expect(evaluationFor(decision, 'acme/modest-1').successProbability).toBeCloseTo(0.95, 1);
  });

  it('corrects the estimate in both directions', () => {
    // An overrated model must come down and an underrated one must go up. A
    // model that only ever revised downward would look like it was learning
    // while merely being pessimistic.
    const decision = routeWith(trainedStore());
    const flatters = evaluationFor(decision, 'acme/flatters-1');
    const modest = evaluationFor(decision, 'acme/modest-1');

    expect(flatters.successProbability).toBeLessThan(flatters.staticSuccessProbability);
    expect(modest.successProbability).toBeGreaterThan(modest.staticSuccessProbability);
  });

  it('keeps the decision explainable: what was thought before, and on what evidence', () => {
    const decision = routeWith(trainedStore());

    for (const candidate of decision.evaluations) {
      expect(candidate.learningApplied).toBe(true);
      expect(candidate.observations).toBe(200);
      expect(candidate.staticSuccessProbability).not.toBe(candidate.successProbability);
    }
  });
});

// ---------------------------------------------------------------------------
// The gates hold
// ---------------------------------------------------------------------------

describe('learning does not act before it has earned the right to', () => {
  it('changes no decision when disabled, however much data exists', () => {
    const store = trainedStore();
    const off = routeWith(store, { enabled: false, minimumTrainingSamples: 50 });
    const none = routeWith(null);

    expect(off.selectedModelId).toBe('acme/flatters-1');
    expect(off.reason).toBe(none.reason);
    expect(off.explanation).toEqual(none.explanation);

    // Every decision-affecting value is identical to a run with no data at all.
    const decisive = (decision: RoutingDecision) =>
      decision.evaluations.map(({ observations: _observations, ...rest }) => rest);
    expect(decisive(off)).toEqual(decisive(none));
  });

  it('still reports honestly what it knows but is not using', () => {
    // `observations` is the one field that legitimately differs: hiding the 200
    // recorded outcomes would misrepresent how much RoutePilot actually knows.
    // Disabled means "not acting on it", not "pretending it does not exist".
    const off = routeWith(trainedStore(), { enabled: false, minimumTrainingSamples: 50 });
    const flatters = evaluationFor(off, 'acme/flatters-1');

    expect(flatters.observations).toBe(200);
    expect(flatters.learningApplied).toBe(false);
    expect(flatters.successProbability).toBe(flatters.staticSuccessProbability);
  });

  it('changes nothing below the training minimum', () => {
    // Ten observations that all point the other way, and routing is unmoved.
    const sparse = routeWith(trainedStore(10));

    expect(sparse.selectedModelId).toBe('acme/flatters-1');
    expect(evaluationFor(sparse, 'acme/flatters-1').learningApplied).toBe(false);
  });

  it('reports the real count while refusing to act on it', () => {
    const sparse = routeWith(trainedStore(10));
    const flatters = evaluationFor(sparse, 'acme/flatters-1');

    // Not zero — that would hide the data. Not inflated by the prior's
    // pseudo-count — that would be a fabricated number.
    expect(flatters.observations).toBe(10);
    expect(flatters.successProbability).toBe(flatters.staticSuccessProbability);
  });

  it('acts as soon as the minimum is met, and not before', () => {
    expect(routeWith(trainedStore(49)).selectedModelId).toBe('acme/flatters-1');
    expect(routeWith(trainedStore(50)).selectedModelId).toBe('acme/modest-1');
  });
});

// ---------------------------------------------------------------------------
// Properties that must survive
// ---------------------------------------------------------------------------

describe('learned routing stays well behaved', () => {
  it('is deterministic across repeated runs', () => {
    const store = trainedStore();
    expect(routeWith(store)).toEqual(routeWith(store));
  });

  it('produces the same decision after a reload as before', () => {
    // Persist, discard the model, reload from the store, route again.
    const store = trainedStore();
    const first = routeWith(store);
    const reloaded = routeWith(new InMemoryLearningStore(store.loadLearnedStats()));

    expect(reloaded).toEqual(first);
  });

  it('still refuses to exceed a budget', () => {
    // Learning changes the probability, not the policy. The safeguards from
    // earlier phases are unaffected by it.
    const decision = new RoutingEngine(
      REGISTRY,
      new LearnedSuccessModel(trainedStore(), learningOn),
    ).route({
      features: featuresFor(TASK),
      policy: policy({
        minimumSuccessProbability: 0.5,
        requestBudget: 0.01,
        onBudgetExceeded: 'stop',
      }),
    });

    expect(decision.selectedModelId).toBeNull();
    expect(decision.evaluations.every((candidate) => !candidate.withinBudget)).toBe(true);
  });

  it('still honours an explicit model request', () => {
    // Learning must never silently override an explicit choice
    // (spec section 2, rule 8), even when it believes the choice is poor.
    const decision = new RoutingEngine(
      REGISTRY,
      new LearnedSuccessModel(trainedStore(), learningOn),
    ).route({
      features: featuresFor(TASK),
      policy: PERMISSIVE,
      requestedModelId: 'acme/flatters-1',
    });

    expect(decision.selectedModelId).toBe('acme/flatters-1');
    expect(decision.outcome).toBe('selected-explicit');
  });

  it('does not randomise: no exploration, ever', () => {
    // Phase 10 excludes bandits, and principle 9 forbids randomly selecting an
    // expensive model. Twenty identical routes must give twenty identical
    // answers.
    const store = trainedStore();
    const decisions = Array.from({ length: 20 }, () => routeWith(store).selectedModelId);

    expect(new Set(decisions).size).toBe(1);
  });
});
