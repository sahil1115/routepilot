/**
 * Expected cost to success (spec sections 1, 14 and 15).
 *
 * The claim under test is RoutePilot's whole reason for existing: **the model
 * with the cheapest first attempt is not always the cheapest path to a
 * completed task.**
 *
 * The decisive scenario below is constructed so the confidence threshold is
 * *not* doing the work. Both candidates clear it comfortably. The only thing
 * separating them is expected cost, and the router must pick on that.
 */

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../registry/model-registry.js';
import {
  bargainModel,
  featuresFor,
  policy,
  steadyModel,
  thriftyModel,
} from '../../test-support/routing-fixtures.js';
import {
  DEFAULT_RECOVERY_MODEL,
  breakevenInitialCost,
  expectedCostToSuccess,
} from './expected-cost.js';
import { RoutingEngine } from './routing-engine.js';

const TASK = 'implement a new /users API endpoint';

const route = (models: ReturnType<typeof steadyModel>[], overrides = {}) =>
  new RoutingEngine(new ModelRegistry(models)).route({
    features: featuresFor(TASK),
    policy: policy(overrides),
  });

/** The evaluation for one model in a decision. */
const evaluationFor = (decision: ReturnType<RoutingEngine['route']>, modelId: string) => {
  const found = decision.evaluations.find((candidate) => candidate.modelId === modelId);
  if (found === undefined) throw new Error(`no evaluation for ${modelId}`);
  return found;
};

// ---------------------------------------------------------------------------
// The five quantities
// ---------------------------------------------------------------------------

describe('the expected-cost model exposes every term', () => {
  it('computes failure probability from the success estimate', () => {
    const breakdown = expectedCostToSuccess({
      initial: 0.1,
      successProbability: 0.86,
      escalationTargetCost: 0.2,
    });

    expect(breakdown.failureProbability).toBeCloseTo(0.14, 10);
  });

  it('computes the retry cost as a repeat of the attempt', () => {
    const breakdown = expectedCostToSuccess({
      initial: 0.1,
      successProbability: 0.9,
      escalationTargetCost: 0.2,
    });

    expect(breakdown.retry).toBeCloseTo(0.1 * DEFAULT_RECOVERY_MODEL.retryCostFraction, 10);
  });

  it('computes the escalation cost as the target plus handoff overhead', () => {
    const breakdown = expectedCostToSuccess({
      initial: 0.1,
      successProbability: 0.9,
      escalationTargetCost: 0.2,
    });

    expect(breakdown.escalation).toBeCloseTo(
      0.2 * (1 + DEFAULT_RECOVERY_MODEL.handoffOverhead),
      10,
    );
  });

  it('blends retry and escalation into the recovery cost', () => {
    const breakdown = expectedCostToSuccess({
      initial: 0.1,
      successProbability: 0.9,
      escalationTargetCost: 0.2,
    });

    const expected =
      DEFAULT_RECOVERY_MODEL.retryShare * breakdown.retry +
      (1 - DEFAULT_RECOVERY_MODEL.retryShare) * breakdown.escalation;

    expect(breakdown.recovery).toBeCloseTo(expected, 10);
  });

  it('assembles the total from initial plus expected recovery', () => {
    const breakdown = expectedCostToSuccess({
      initial: 0.1,
      successProbability: 0.86,
      escalationTargetCost: 0.2,
    });

    expect(breakdown.expectedTotalToSuccess).toBeCloseTo(
      breakdown.initial + breakdown.failureProbability * breakdown.recovery,
      10,
    );
  });

  it('charges nothing beyond the attempt when success is certain', () => {
    const breakdown = expectedCostToSuccess({
      initial: 0.1,
      successProbability: 1,
      escalationTargetCost: 5,
    });

    expect(breakdown.expectedTotalToSuccess).toBeCloseTo(0.1, 10);
  });

  it('falls back to a retry when nothing stronger exists, rather than inventing a cost', () => {
    const breakdown = expectedCostToSuccess({
      initial: 0.1,
      successProbability: 0.5,
      escalationTargetCost: null,
    });

    expect(breakdown.escalation).toBe(breakdown.retry);
  });

  it('rises monotonically as failure becomes more likely', () => {
    const costs = [0.99, 0.9, 0.7, 0.4].map(
      (p) =>
        expectedCostToSuccess({ initial: 0.1, successProbability: p, escalationTargetCost: 0.2 })
          .expectedTotalToSuccess,
    );

    for (let i = 1; i < costs.length; i += 1) {
      expect(costs[i]).toBeGreaterThan(costs[i - 1] as number);
    }
  });

  it.each([
    ['a negative cost', { initial: -1, successProbability: 0.5, escalationTargetCost: null }],
    ['a probability above 1', { initial: 1, successProbability: 1.5, escalationTargetCost: null }],
    [
      'a negative probability',
      { initial: 1, successProbability: -0.1, escalationTargetCost: null },
    ],
  ])('rejects %s rather than producing a nonsense figure', (_label, input) => {
    expect(() => expectedCostToSuccess(input)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// The decisive scenario
// ---------------------------------------------------------------------------

describe('SCENARIO — cheapest initial is not cheapest expected', () => {
  it('the cheaper model really does have the cheaper first attempt', () => {
    const decision = route([thriftyModel(), steadyModel()]);

    const thrifty = evaluationFor(decision, 'acme/thrifty-1');
    const steady = evaluationFor(decision, 'acme/steady-1');

    expect(thrifty.cost.initial).toBeLessThan(steady.cost.initial);
  });

  it('and the dearer expected path to success', () => {
    const decision = route([thriftyModel(), steadyModel()]);

    const thrifty = evaluationFor(decision, 'acme/thrifty-1');
    const steady = evaluationFor(decision, 'acme/steady-1');

    expect(thrifty.cost.expectedTotalToSuccess).toBeGreaterThan(steady.cost.expectedTotalToSuccess);
  });

  it('the router chooses the lower expected cost, not the lower sticker price', () => {
    const decision = route([thriftyModel(), steadyModel()]);

    expect(decision.selectedModelId).toBe('acme/steady-1');
    expect(decision.outcome).toBe('selected');
  });

  it('and the confidence threshold is demonstrably not what decided it', () => {
    // This is the crux. If the cheaper model had been filtered out on
    // confidence, the test above would prove nothing about the cost model.
    const decision = route([thriftyModel(), steadyModel()]);
    const thrifty = evaluationFor(decision, 'acme/thrifty-1');

    expect(thrifty.meetsThreshold).toBe(true);
    expect(thrifty.withinRisk).toBe(true);
    expect(thrifty.withinLatency).toBe(true);
    expect(thrifty.withinBudget).toBe(true);
    // Fully viable, comfortably above the threshold — and still rejected.
    expect(thrifty.viable).toBe(true);
    expect(thrifty.successProbability).toBeGreaterThan(0.85);
  });

  it('holds even when the threshold is lowered far below both candidates', () => {
    // With the threshold at 0.1 it cannot possibly be doing any filtering.
    const decision = route([thriftyModel(), steadyModel()], {
      minimumSuccessProbability: 0.1,
    });

    expect(decision.selectedModelId).toBe('acme/steady-1');
  });

  it('the difference is paid for by the cheaper model failing more often', () => {
    const decision = route([thriftyModel(), steadyModel()]);
    const thrifty = evaluationFor(decision, 'acme/thrifty-1');
    const steady = evaluationFor(decision, 'acme/steady-1');

    expect(thrifty.cost.failureProbability).toBeGreaterThan(steady.cost.failureProbability);
    // The extra expected spend is exactly failure probability times recovery.
    expect(thrifty.cost.expectedTotalToSuccess - thrifty.cost.initial).toBeCloseTo(
      thrifty.cost.failureProbability * thrifty.cost.recovery,
      10,
    );
  });

  it('explains the choice in terms of expected cost', () => {
    const decision = route([thriftyModel(), steadyModel()]);
    expect(decision.reason).toContain('expected total cost to success');
  });

  it('orders the candidate list by expected cost, not by first-attempt cost', () => {
    const decision = route([thriftyModel(), steadyModel()]);

    expect(decision.evaluations.map((e) => e.modelId)).toEqual(['acme/steady-1', 'acme/thrifty-1']);
  });
});

// ---------------------------------------------------------------------------
// The boundary, stated rather than assumed
// ---------------------------------------------------------------------------

describe('the breakeven between cheap-first and reliable-first', () => {
  it('reports the first-attempt cost at which a model stops being worth opening with', () => {
    const targetCost = 0.1111;
    const breakeven = breakevenInitialCost(0.86, targetCost);

    expect(breakeven).not.toBeNull();
    expect(breakeven as number).toBeGreaterThan(0);
    expect(breakeven as number).toBeLessThan(targetCost);
  });

  it('a model priced just under breakeven is the cheaper expected path', () => {
    const targetCost = 0.1111;
    const breakeven = breakevenInitialCost(0.86, targetCost) as number;

    const cheaper = expectedCostToSuccess({
      initial: breakeven * 0.95,
      successProbability: 0.86,
      escalationTargetCost: targetCost,
    });

    expect(cheaper.expectedTotalToSuccess).toBeLessThan(targetCost);
  });

  it('a model priced just over breakeven is the dearer expected path', () => {
    const targetCost = 0.1111;
    const breakeven = breakevenInitialCost(0.86, targetCost) as number;

    const dearer = expectedCostToSuccess({
      initial: breakeven * 1.05,
      successProbability: 0.86,
      escalationTargetCost: targetCost,
    });

    expect(dearer.expectedTotalToSuccess).toBeGreaterThan(targetCost);
  });

  it('has no breakeven when there is nothing to escalate to', () => {
    expect(breakevenInitialCost(0.86, null)).toBeNull();
  });

  it('moves the breakeven down as the model becomes less reliable', () => {
    const reliable = breakevenInitialCost(0.95, 0.1) as number;
    const unreliable = breakevenInitialCost(0.5, 0.1) as number;

    // The more often it fails, the cheaper it has to be to be worth trying.
    expect(unreliable).toBeLessThan(reliable);
  });
});

describe('the contrasting case, recorded rather than hidden', () => {
  it('a much cheaper model IS the cheaper expected path, even failing as often', () => {
    // Same success prior as the thrifty model, but roughly six times cheaper.
    // Here opening with it genuinely minimises expected spend, and the router
    // correctly does so. This is why `minimumSuccessProbability` exists as a
    // separate constraint: dollars are not the only cost of a failure.
    const decision = route([bargainModel(), steadyModel()]);

    const bargain = evaluationFor(decision, 'acme/bargain-1');
    const steady = evaluationFor(decision, 'acme/steady-1');

    expect(bargain.successProbability).toBeCloseTo(0.8739, 3);
    expect(bargain.cost.expectedTotalToSuccess).toBeLessThan(steady.cost.expectedTotalToSuccess);
    expect(decision.selectedModelId).toBe('acme/bargain-1');
  });

  it('raising the threshold is what stops the router gambling', () => {
    // The cost model has not changed; the policy has.
    const decision = route([bargainModel(), steadyModel()], {
      minimumSuccessProbability: 0.95,
    });

    expect(decision.selectedModelId).toBe('acme/steady-1');
    expect(evaluationFor(decision, 'acme/bargain-1').meetsThreshold).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Properties that must survive
// ---------------------------------------------------------------------------

describe('expected-cost routing stays well behaved', () => {
  it('is deterministic across repeated and reordered runs', () => {
    const forward = route([thriftyModel(), steadyModel()]);
    const backward = route([steadyModel(), thriftyModel()]);

    expect(backward).toEqual(forward);
    expect(route([thriftyModel(), steadyModel()])).toEqual(forward);
  });

  it('never reports an expected cost below the first attempt', () => {
    // Recovery can only add. A total below the initial would mean failure was
    // somehow profitable.
    const decision = route([thriftyModel(), steadyModel(), bargainModel()]);

    for (const candidate of decision.evaluations) {
      expect(candidate.cost.expectedTotalToSuccess).toBeGreaterThanOrEqual(candidate.cost.initial);
    }
  });

  it('gives the strongest candidate no escalation target', () => {
    const decision = route([thriftyModel(), steadyModel()]);
    expect(evaluationFor(decision, 'acme/steady-1').escalationTargetId).toBeNull();
  });

  it('points a weaker candidate at the cheapest stronger path', () => {
    const decision = route([thriftyModel(), steadyModel()]);
    expect(evaluationFor(decision, 'acme/thrifty-1').escalationTargetId).toBe('acme/steady-1');
  });

  it('a budget between the two expected costs excludes only the dearer path', () => {
    const unconstrained = route([thriftyModel(), steadyModel()]);
    const steadyCost = evaluationFor(unconstrained, 'acme/steady-1').cost.expectedTotalToSuccess;
    const thriftyCost = evaluationFor(unconstrained, 'acme/thrifty-1').cost.expectedTotalToSuccess;

    // Sits above the better expected path and below the worse one.
    const budget = (steadyCost + thriftyCost) / 2;
    const decision = route([thriftyModel(), steadyModel()], { requestBudget: budget });

    expect(evaluationFor(decision, 'acme/steady-1').withinBudget).toBe(true);
    expect(evaluationFor(decision, 'acme/thrifty-1').withinBudget).toBe(false);
    expect(decision.selectedModelId).toBe('acme/steady-1');
    expect(decision.budgetExceeded).toBe(false);
  });

  it('a budget below the cheapest expected path leaves nothing affordable', () => {
    // Because the budget bounds *expected* cost, a limit under the cheapest
    // expected path rules out every candidate — the model with the lower
    // sticker price included, since its path to success costs more.
    const unconstrained = route([thriftyModel(), steadyModel()]);
    const cheapestExpected = evaluationFor(unconstrained, 'acme/steady-1').cost
      .expectedTotalToSuccess;

    const decision = route([thriftyModel(), steadyModel()], {
      requestBudget: cheapestExpected * 0.9,
      onBudgetExceeded: 'allow-fallback',
    });

    expect(decision.evaluations.every((candidate) => !candidate.withinBudget)).toBe(true);
    // Fallback still picks the cheapest path to success, and says it overspent.
    expect(decision.selectedModelId).toBe('acme/steady-1');
    expect(decision.budgetExceeded).toBe(true);
  });

  it('stops rather than overspending when configured to stop', () => {
    const unconstrained = route([thriftyModel(), steadyModel()]);
    const cheapestExpected = evaluationFor(unconstrained, 'acme/steady-1').cost
      .expectedTotalToSuccess;

    const decision = route([thriftyModel(), steadyModel()], {
      requestBudget: cheapestExpected * 0.9,
      onBudgetExceeded: 'stop',
    });

    expect(decision.selectedModelId).toBeNull();
    expect(decision.budgetExceeded).toBe(false);
  });
});
