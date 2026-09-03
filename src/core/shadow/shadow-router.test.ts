/**
 * Shadow routing: selection rules, divergence, and the guarantees around it.
 *
 * Each of the three standing baselines gets a scenario where it genuinely
 * disagrees with the live policy. A baseline that always agrees proves nothing
 * — it would pass whether or not the code worked — so the fixtures are chosen
 * to force each rule to show its hand.
 */

import { describe, expect, it } from 'vitest';

import { LearnedSuccessModel } from '../learning/success-model.js';
import { ModelRegistry } from '../registry/model-registry.js';
import type { ModelEvaluation } from '../types/routing.js';
import type { ShadowPolicySpec } from '../types/shadow.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  policy,
  steadyModel,
  thriftyModel,
} from '../../test-support/routing-fixtures.js';
import {
  InMemoryLearningStore,
  overratedModel,
  syntheticObservations,
  underratedModel,
} from '../../test-support/learning-fixtures.js';
import {
  CHEAPEST_FIRST,
  DEFAULT_SHADOW_POLICIES,
  PRIORS_ONLY,
  STRONGEST_FIRST,
} from './policies.js';
import { selectBy } from './selection.js';
import { ShadowRouter, toShadowRecords } from './shadow-router.js';

const TASK = 'implement a new /users API endpoint';
const LADDER = [cheapModel(), mediumModel(), frontierModel()];
const PERMISSIVE = policy({ minimumSuccessProbability: 0.5 });

const compareLadder = (policies = DEFAULT_SHADOW_POLICIES) =>
  new ShadowRouter(new ModelRegistry(LADDER)).compare({
    features: featuresFor(TASK),
    policy: PERMISSIVE,
    shadowPolicies: policies,
  });

const shadow = (comparison: ReturnType<typeof compareLadder>, policyId: string) => {
  const found = comparison.shadows.find((entry) => entry.policyId === policyId);
  if (found === undefined) throw new Error(`no shadow named ${policyId}`);
  return found;
};

// ---------------------------------------------------------------------------
// Each baseline diverges somewhere
// ---------------------------------------------------------------------------

describe('strongest-first', () => {
  it('reaches for the top tier where the live policy does not', () => {
    const comparison = compareLadder();

    expect(comparison.current.selectedModelId).toBe('acme/fast-1');
    expect(shadow(comparison, STRONGEST_FIRST.id).selectedModelId).toBe('acme/deep-1');
    expect(shadow(comparison, STRONGEST_FIRST.id).tier).toBe('frontier');
  });

  it('costs more, by the router’s own estimates', () => {
    const delta = shadow(compareLadder(), STRONGEST_FIRST.id).estimatedCostDelta;

    expect(delta).not.toBeNull();
    expect(delta as number).toBeGreaterThan(0);
  });

  it('buys a higher success probability for that money', () => {
    // The trade the baseline exists to make visible: strongest-first is not
    // wrong, it is expensive.
    const outcome = shadow(compareLadder(), STRONGEST_FIRST.id);
    expect(outcome.successProbabilityDelta as number).toBeGreaterThan(0);
  });
});

describe('cheapest-first', () => {
  /** The Phase 9 pair: thrifty is cheaper up front and dearer overall. */
  const compareThrifty = () =>
    new ShadowRouter(new ModelRegistry([thriftyModel(), steadyModel()])).compare({
      features: featuresFor(TASK),
      policy: PERMISSIVE,
      shadowPolicies: [CHEAPEST_FIRST],
    });

  it('prefers the lower sticker price where the live policy prefers the cheaper path', () => {
    // This is RoutePilot's founding claim expressed as a policy comparison.
    const comparison = compareThrifty();
    const outcome = comparison.shadows[0];

    expect(comparison.current.selectedModelId).toBe('acme/steady-1');
    expect(outcome?.selectedModelId).toBe('acme/thrifty-1');
    expect(outcome?.agrees).toBe(false);
  });

  it('is estimated to cost more overall despite the cheaper first attempt', () => {
    const outcome = compareThrifty().shadows[0];
    expect(outcome?.estimatedCostDelta as number).toBeGreaterThan(0);
  });

  it('agrees with the live policy when the cheap model is genuinely cheapest', () => {
    // Agreement is a real result, not a failure of the baseline.
    expect(shadow(compareLadder(), CHEAPEST_FIRST.id).agrees).toBe(true);
  });
});

describe('priors-only', () => {
  /** The Phase 10 pair, with enough evidence for learning to reverse the choice. */
  const compareLearned = () => {
    const store = new InMemoryLearningStore();
    const learningPolicy = { enabled: true, minimumTrainingSamples: 50 };
    const trainer = new LearnedSuccessModel(store, learningPolicy);
    trainer.observeAll(syntheticObservations('acme/flatters-1', 200), 1_000);
    trainer.observeAll(syntheticObservations('acme/modest-1', 200), 1_000);

    return new ShadowRouter(
      new ModelRegistry([overratedModel(), underratedModel()]),
      new LearnedSuccessModel(store, learningPolicy),
    ).compare({
      features: featuresFor(TASK),
      policy: PERMISSIVE,
      shadowPolicies: [PRIORS_ONLY],
    });
  };

  it('shows what routing would do without what has been learned', () => {
    const comparison = compareLearned();

    expect(comparison.current.selectedModelId).toBe('acme/modest-1');
    expect(comparison.shadows[0]?.selectedModelId).toBe('acme/flatters-1');
    expect(comparison.shadows[0]?.agrees).toBe(false);
  });

  it('agrees when learning is not influencing anything', () => {
    // With no learned data the live engine and the priors-only engine are the
    // same computation, so agreement here is the correct answer.
    expect(shadow(compareLadder(), PRIORS_ONLY.id).agrees).toBe(true);
    expect(shadow(compareLadder(), PRIORS_ONLY.id).estimatedCostDelta).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The selection rules themselves
// ---------------------------------------------------------------------------

describe('selectBy', () => {
  const evaluations = () => compareLadder([]).current.evaluations;

  it('picks the cheapest expected path under the production rule', () => {
    expect(selectBy('expected-cost', evaluations())?.modelId).toBe('acme/fast-1');
  });

  it('picks the lowest first-attempt price under cheapest-first', () => {
    const chosen = selectBy('cheapest-first', evaluations());
    const cheapest = [...evaluations()]
      .filter((candidate) => candidate.viable)
      .sort((a, b) => a.cost.initial - b.cost.initial)[0];

    expect(chosen?.modelId).toBe(cheapest?.modelId);
  });

  it('picks the highest tier under strongest-first', () => {
    expect(selectBy('strongest-first', evaluations())?.tier).toBe('frontier');
  });

  it('considers only viable candidates, whatever the rule', () => {
    // A rule that ignored the policy would propose routes RoutePilot is not
    // allowed to take, making any reported saving imaginary.
    const strict = new ShadowRouter(new ModelRegistry(LADDER)).compare({
      features: featuresFor(TASK),
      policy: policy({ minimumSuccessProbability: 0.85 }),
      shadowPolicies: [CHEAPEST_FIRST],
    });

    const fast = strict.current.evaluations.find((c) => c.modelId === 'acme/fast-1');
    expect(fast?.viable).toBe(false);
    // Cheapest overall, but below the threshold, so cheapest-first cannot take it.
    expect(strict.shadows[0]?.selectedModelId).not.toBe('acme/fast-1');
  });

  it('returns null when nothing is viable, rather than relaxing the rule', () => {
    expect(selectBy('cheapest-first', [])).toBeNull();

    const unviable = evaluations().map(
      (candidate) => ({ ...candidate, viable: false }) satisfies ModelEvaluation,
    );
    expect(selectBy('expected-cost', unviable)).toBeNull();
  });

  it('is deterministic regardless of candidate order', () => {
    const forward = evaluations();
    const backward = [...forward].reverse();

    for (const rule of ['expected-cost', 'cheapest-first', 'strongest-first'] as const) {
      expect(selectBy(rule, backward)?.modelId).toBe(selectBy(rule, forward)?.modelId);
    }
  });
});

// ---------------------------------------------------------------------------
// Guarantees
// ---------------------------------------------------------------------------

describe('the comparison itself', () => {
  it('leaves the live decision untouched by shadow evaluation', () => {
    const withShadows = compareLadder();
    const withoutShadows = compareLadder([]);

    expect(withShadows.current).toEqual(withoutShadows.current);
  });

  it('is deterministic', () => {
    expect(compareLadder()).toEqual(compareLadder());
  });

  it('preserves the order policies were supplied in', () => {
    const comparison = compareLadder([STRONGEST_FIRST, CHEAPEST_FIRST, PRIORS_ONLY]);
    expect(comparison.shadows.map((entry) => entry.policyId)).toEqual([
      'strongest-first',
      'cheapest-first',
      'priors-only',
    ]);
  });

  it('supports having no shadow policies at all', () => {
    expect(compareLadder([]).shadows).toEqual([]);
  });

  it('carries the full decision so a divergence can be explained', () => {
    const outcome = shadow(compareLadder(), STRONGEST_FIRST.id);

    expect(outcome.decision.evaluations.length).toBeGreaterThan(0);
    expect(outcome.description).toBe(STRONGEST_FIRST.description);
  });

  it('reports null deltas rather than a saving when a policy would stop', () => {
    // A policy that selects nothing has no cost. Treating that as zero would
    // make "do nothing" the cheapest policy on offer.
    const strict: ShadowPolicySpec = {
      id: 'impossible',
      description: 'unsatisfiable limits',
      rule: 'expected-cost',
      learning: 'inherit',
      policyOverrides: { minimumSuccessProbability: 0.999 },
    };

    const outcome = compareLadder([strict]).shadows[0];

    expect(outcome?.selectedModelId).toBeNull();
    expect(outcome?.estimatedCostDelta).toBeNull();
    expect(outcome?.successProbabilityDelta).toBeNull();
    expect(outcome?.agrees).toBe(false);
  });

  it('honours a shadow policy with its own limits', () => {
    const tight: ShadowPolicySpec = {
      id: 'tight-budget',
      description: 'a smaller request budget',
      rule: 'strongest-first',
      learning: 'inherit',
      policyOverrides: { requestBudget: 0.1, onBudgetExceeded: 'stop' },
    };

    const outcome = compareLadder([tight]).shadows[0];

    // The frontier model is unaffordable under the tighter budget, so even
    // strongest-first cannot choose it.
    expect(outcome?.selectedModelId).not.toBe('acme/deep-1');
  });
});

describe('toShadowRecords', () => {
  it('records what was chosen and what would have been', () => {
    const records = toShadowRecords(compareLadder(), 'req-1', 5_000);
    const strongest = records.find((record) => record.policyId === STRONGEST_FIRST.id);

    expect(records).toHaveLength(3);
    expect(strongest?.currentModelId).toBe('acme/fast-1');
    expect(strongest?.shadowModelId).toBe('acme/deep-1');
    expect(strongest?.agrees).toBe(false);
    expect(strongest?.at).toBe(5_000);
  });

  it('takes the timestamp from the caller, so a replay reproduces', () => {
    expect(toShadowRecords(compareLadder(), 'req-1', 7)[0]?.at).toBe(7);
  });

  it('produces nothing when there are no shadow policies', () => {
    expect(toShadowRecords(compareLadder([]), 'req-1', 1)).toEqual([]);
  });
});
