/**
 * Constrained candidate selection, and budget-aware exploration.
 *
 * Driven through the real routing engine rather than hand-built evaluations, so
 * what is asserted is what a request would actually produce.
 */

import { describe, expect, it } from 'vitest';

import { LearnedSuccessModel } from '../learning/success-model.js';
import { ModelRegistry } from '../registry/model-registry.js';
import { RoutingEngine } from '../routing/routing-engine.js';
import type { RoutingDecision } from '../types/routing.js';
import { featuresFor, policy } from '../../test-support/routing-fixtures.js';
import {
  InMemoryLearningStore,
  syntheticObservations,
} from '../../test-support/learning-fixtures.js';
import { sleeperArm, steadyArm } from '../../test-support/bandit-fixtures.js';
import type { ExplorationPolicy } from './exploration-gate.js';

// The task the simulation arms were calibrated against. On a trivial task the
// cheap arm wins on expected cost outright and there is nothing to explore —
// correct behaviour, but it proves nothing about the bandit.
const TASK = 'implement a new /users API endpoint';
const ARMS = [steadyArm(), sleeperArm()];

const OPEN: ExplorationPolicy = {
  enabled: true,
  minimumObservations: 5,
  maxRisk: 0.9,
  maxCostPremium: 0.5,
  optimism: 1.5,
};

/** A learned model holding `n` observations of `steady`, so the gate unlocks. */
function trained(n = 20): LearnedSuccessModel {
  const store = new InMemoryLearningStore();
  const learningPolicy = { enabled: true, minimumTrainingSamples: 5 };
  const trainer = new LearnedSuccessModel(store, learningPolicy);
  trainer.observeAll(
    syntheticObservations('sim/steady', n, {
      rate: 0.9,
      taskType: 'feature-implementation',
      scope: 'few-files',
    }),
    1_000,
  );
  return new LearnedSuccessModel(store, learningPolicy);
}

function route(
  exploration: ExplorationPolicy = OPEN,
  overrides: Parameters<typeof policy>[0] = {},
  learned = trained(),
): RoutingDecision {
  return new RoutingEngine(new ModelRegistry(ARMS), learned, exploration).route({
    features: featuresFor(TASK),
    policy: policy({ minimumSuccessProbability: 0.5, ...overrides }),
    operationMode: 'normal',
  });
}

describe('exploration substitutes a different viable model', () => {
  it('chooses something other than the exploiting model', () => {
    const decision = route();

    expect(decision.exploration.explored).toBe(true);
    expect(decision.selectedModelId).not.toBe(decision.exploration.exploitModelId);
  });

  it('records what exploitation would have chosen', () => {
    const decision = route();
    const exploitOnly = route({ ...OPEN, enabled: false });

    expect(decision.exploration.exploitModelId).toBe(exploitOnly.selectedModelId);
  });

  it('reports the estimated premium it paid to learn', () => {
    const decision = route();

    expect(decision.exploration.premium).not.toBeNull();
    expect(typeof decision.exploration.premium).toBe('number');
  });

  it('explains itself in the decision reason', () => {
    const decision = route();

    expect(decision.reason).toContain('exploring');
    expect(decision.reason).toContain('Expected-cost routing would have chosen');
  });
});

describe('constrained candidate selection', () => {
  it('never selects a model that is not viable', () => {
    // Exploration widens which acceptable model is chosen; it never lowers the
    // bar for what counts as acceptable.
    const decision = route(OPEN, { minimumSuccessProbability: 0.85 });
    const selected = decision.evaluations.find((e) => e.modelId === decision.selectedModelId);

    expect(selected?.viable).toBe(true);
  });

  it('falls back to exploiting when only one candidate is viable', () => {
    // With a high threshold the cheap arm drops out, leaving nothing to try.
    const decision = route(OPEN, { minimumSuccessProbability: 0.85 });
    const viable = decision.evaluations.filter((e) => e.viable);

    expect(viable).toHaveLength(1);
    expect(decision.exploration.explored).toBe(false);
  });

  it('never selects a model excluded by a hard constraint', () => {
    const decision = route();
    const excludedIds = decision.excluded.map((entry) => entry.modelId);

    expect(excludedIds).not.toContain(decision.selectedModelId);
  });
});

describe('budget-aware exploration', () => {
  it('refuses an experiment that exceeds the cost premium', () => {
    // The price of information is capped. At zero premium nothing can be
    // afforded, and the gate says so.
    const decision = route({ ...OPEN, maxCostPremium: 0 });

    expect(decision.exploration.explored).toBe(false);
    expect(decision.exploration.blockedBy).toBe('no-budget-headroom');
  });

  it('refuses an experiment that would break the request budget', () => {
    const exploring = route();
    const exploitCost =
      exploring.evaluations.find((e) => e.modelId === exploring.exploration.exploitModelId)?.cost
        .expectedTotalToSuccess ?? 0;

    // A budget that admits the exploiting choice and nothing dearer.
    const constrained = route(OPEN, { requestBudget: exploitCost * 1.0001 });
    const selected = constrained.evaluations.find((e) => e.modelId === constrained.selectedModelId);

    expect(selected?.cost.expectedTotalToSuccess).toBeLessThanOrEqual(exploitCost * 1.0001);
  });

  it('keeps every earlier budget safeguard intact', () => {
    const decision = route(OPEN, { requestBudget: 0.001, onBudgetExceeded: 'stop' });

    expect(decision.selectedModelId).toBeNull();
    expect(decision.exploration.explored).toBe(false);
  });
});

describe('exploration is self-limiting', () => {
  it('stops once a model has been observed enough', () => {
    // The same request with far more evidence behind the cheap arm: its bound
    // has tightened onto its (poor) mean and it is no longer worth trying.
    const store = new InMemoryLearningStore();
    const learningPolicy = { enabled: true, minimumTrainingSamples: 5 };
    const trainer = new LearnedSuccessModel(store, learningPolicy);
    for (const [modelId, rate] of [
      ['sim/steady', 0.92],
      ['sim/sleeper', 0.55],
    ] as const) {
      trainer.observeAll(
        syntheticObservations(modelId, 400, {
          rate,
          taskType: 'feature-implementation',
          scope: 'few-files',
        }),
        1_000,
      );
    }

    const decision = route(OPEN, {}, new LearnedSuccessModel(store, learningPolicy));
    expect(decision.exploration.explored).toBe(false);
  });
});

describe('exploration stays deterministic', () => {
  it('gives the same answer every time', () => {
    // No sampling. Twenty identical requests, one answer.
    const choices = Array.from({ length: 20 }, () => route().selectedModelId);
    expect(new Set(choices).size).toBe(1);
  });

  it('does not depend on model registration order', () => {
    const forward = new RoutingEngine(new ModelRegistry(ARMS), trained(), OPEN).route({
      features: featuresFor(TASK),
      policy: policy({ minimumSuccessProbability: 0.5 }),
      operationMode: 'normal',
    });
    const backward = new RoutingEngine(
      new ModelRegistry([...ARMS].reverse()),
      trained(),
      OPEN,
    ).route({
      features: featuresFor(TASK),
      policy: policy({ minimumSuccessProbability: 0.5 }),
      operationMode: 'normal',
    });

    expect(backward.selectedModelId).toBe(forward.selectedModelId);
  });
});

describe('every decision carries an exploration summary', () => {
  it('records the absence explicitly when exploration is off', () => {
    const decision = route({ ...OPEN, enabled: false });

    expect(decision.exploration.explored).toBe(false);
    expect(decision.exploration.blockedBy).toBe('disabled');
    expect(decision.exploration.reason).toContain('disabled');
  });

  it('records it on a decision that selected nothing', () => {
    const decision = route(OPEN, { requestBudget: 0.0001, onBudgetExceeded: 'stop' });

    expect(decision.selectedModelId).toBeNull();
    expect(decision.exploration.explored).toBe(false);
    expect(decision.exploration.reason.length).toBeGreaterThan(0);
  });

  it('defaults the operation mode to production, not normal', () => {
    // A caller that did not say where it is running gets the cautious reading.
    // Forgetting this argument can only suppress an experiment, never
    // authorise one.
    const decision = new RoutingEngine(new ModelRegistry(ARMS), trained(), OPEN).route({
      features: featuresFor(TASK),
      policy: policy({ minimumSuccessProbability: 0.5 }),
    });

    expect(decision.exploration.explored).toBe(false);
    expect(decision.exploration.blockedBy).toBe('operation-mode');
  });
});
