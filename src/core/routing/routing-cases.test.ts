/**
 * The eight routing cases the phase specifies, tested exactly as stated.
 *
 * These run the real classifier, the real feature extractor and the real
 * routing engine. Only the repository snapshot is synthetic.
 */

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../registry/model-registry.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  modelLadder,
  policy,
  ultraModel,
} from '../../test-support/routing-fixtures.js';
import { noCapabilities } from '../../test-support/fixtures.js';
import { RoutingEngine } from './routing-engine.js';

const ladder = () => new RoutingEngine(new ModelRegistry(modelLadder()));

/** Tier of the selected model, for asserting the spec's tier expectations. */
function selectedTier(decision: {
  selectedModelId: string | null;
  evaluations: readonly { modelId: string; tier: string }[];
}) {
  return decision.evaluations.find((e) => e.modelId === decision.selectedModelId)?.tier;
}

describe('CASE 1 — rename variable routes to a cheap model', () => {
  it('selects the cheap rung', () => {
    const decision = ladder().route({
      features: featuresFor('rename the variable userId to userIdentifier'),
      policy: policy(),
    });

    expect(decision.outcome).toBe('selected');
    expect(decision.selectedModelId).toBe('acme/fast-1');
    expect(selectedTier(decision)).toBe('cheap');
  });

  it('chose it on expected cost, not merely on sticker price', () => {
    const decision = ladder().route({
      features: featuresFor('rename the variable userId to userIdentifier'),
      policy: policy(),
    });

    const selected = decision.evaluations.find((e) => e.modelId === decision.selectedModelId);
    expect(selected?.meetsThreshold).toBe(true);
    // Every other viable candidate must have a higher expected total cost.
    for (const other of decision.evaluations.filter(
      (e) => e.viable && e.modelId !== selected?.modelId,
    )) {
      expect(other.cost.expectedTotalToSuccess).toBeGreaterThanOrEqual(
        selected?.cost.expectedTotalToSuccess ?? 0,
      );
    }
  });
});

describe('CASE 2 — simple documentation routes to a cheap model', () => {
  it('selects the cheap rung', () => {
    const decision = ladder().route({
      features: featuresFor('write documentation for the config module'),
      policy: policy(),
    });

    expect(decision.outcome).toBe('selected');
    expect(selectedTier(decision)).toBe('cheap');
  });

  it('agrees with the static tier prior for documentation', () => {
    const decision = ladder().route({
      features: featuresFor('write documentation for the config module'),
      policy: policy(),
    });

    expect(decision.staticTierPrior).toBe('cheap');
  });
});

describe('CASE 3 — a normal API endpoint routes to a medium model', () => {
  it('selects the medium rung', () => {
    const decision = ladder().route({
      features: featuresFor('implement a new /users API endpoint'),
      policy: policy(),
    });

    expect(decision.outcome).toBe('selected');
    expect(decision.selectedModelId).toBe('acme/balanced-1');
    expect(selectedTier(decision)).toBe('medium');
  });

  it('rejects the cheap model on confidence, not on price', () => {
    const decision = ladder().route({
      features: featuresFor('implement a new /users API endpoint'),
      policy: policy(),
    });

    const cheap = decision.evaluations.find((e) => e.modelId === 'acme/fast-1');
    const medium = decision.evaluations.find((e) => e.modelId === 'acme/balanced-1');

    expect(cheap?.meetsThreshold).toBe(false);

    // This is the important part: the cheap model is cheaper on *both* the
    // first attempt and the expected total. Pure cost minimisation would have
    // opened with it. The confidence threshold is what ruled it out, which is
    // exactly the separation of concerns spec section 14 describes.
    expect(cheap?.cost.initial).toBeLessThan(medium?.cost.initial ?? 0);
    expect(cheap?.cost.expectedTotalToSuccess).toBeLessThan(
      medium?.cost.expectedTotalToSuccess ?? 0,
    );
    expect(cheap?.viable).toBe(false);
  });
});

describe('CASE 4 — a multi-file authentication refactor routes high', () => {
  const prompt = 'refactor the authentication module across the entire repository';

  it('selects a high-capability model', () => {
    const decision = ladder().route({ features: featuresFor(prompt), policy: policy() });

    expect(decision.outcome).toBe('selected');
    expect(['frontier', 'ultra']).toContain(selectedTier(decision));
  });

  it('picks the frontier rung rather than the most expensive one', () => {
    const decision = ladder().route({ features: featuresFor(prompt), policy: policy() });

    // Spending more than necessary is as much a failure as spending too little.
    expect(decision.selectedModelId).toBe('acme/deep-1');
  });

  it('rules out the cheap and medium rungs on confidence', () => {
    const decision = ladder().route({ features: featuresFor(prompt), policy: policy() });

    expect(decision.evaluations.find((e) => e.modelId === 'acme/fast-1')?.meetsThreshold).toBe(
      false,
    );
    expect(decision.evaluations.find((e) => e.modelId === 'acme/balanced-1')?.meetsThreshold).toBe(
      false,
    );
  });

  it('classifies the task as a multi-file refactor', () => {
    expect(featuresFor(prompt).task.taskType).toBe('multi-file-refactoring');
    expect(featuresFor(prompt).task.scope).toBe('repository-wide');
  });
});

describe('CASE 5 — a model that cannot fit the context is excluded', () => {
  it('excludes it before scoring, with a reason', () => {
    const registry = new ModelRegistry([
      cheapModel({ id: 'acme/small', contextWindow: 8_000 }),
      frontierModel(),
    ]);

    const decision = new RoutingEngine(registry).route({
      // 400k tokens of context cannot fit an 8k window.
      features: featuresFor('refactor the payment pipeline', { contextTokens: 400_000 }),
      policy: policy(),
    });

    const exclusion = decision.excluded.find((e) => e.modelId === 'acme/small');
    expect(exclusion?.reason).toBe('CONTEXT_WINDOW_TOO_SMALL');
    expect(exclusion?.detail).toContain('8,000');
    expect(decision.evaluations.some((e) => e.modelId === 'acme/small')).toBe(false);
    expect(decision.selectedModelId).not.toBe('acme/small');
  });

  it('reports no eligible model when nothing can fit', () => {
    const registry = new ModelRegistry([cheapModel({ id: 'acme/small', contextWindow: 8_000 })]);

    const decision = new RoutingEngine(registry).route({
      features: featuresFor('refactor the payment pipeline', { contextTokens: 400_000 }),
      policy: policy(),
    });

    expect(decision.outcome).toBe('no-eligible-model');
    expect(decision.selectedModelId).toBeNull();
    expect(decision.reason).toContain('No model satisfies the hard constraints');
  });
});

describe('CASE 6 — a model lacking tools is excluded from a task that needs them', () => {
  it('excludes it, naming the missing capability', () => {
    const registry = new ModelRegistry([
      cheapModel({ id: 'acme/text-only', capabilities: { ...noCapabilities, streaming: true } }),
      mediumModel(),
    ]);

    const decision = new RoutingEngine(registry).route({
      features: featuresFor('implement a new /users API endpoint'),
      policy: policy(),
    });

    const exclusion = decision.excluded.find((e) => e.modelId === 'acme/text-only');
    expect(exclusion?.reason).toBe('MISSING_CAPABILITY');
    expect(exclusion?.detail).toContain('toolUse');
    expect(exclusion?.detail).toContain('agenticExecution');
  });

  it('does not require tools for a task that does not need them', () => {
    // Over-requiring capabilities silently pushes cheap work to expensive
    // models. An autocomplete needs neither tools nor an agentic loop.
    const registry = new ModelRegistry([
      cheapModel({ id: 'acme/text-only', capabilities: { ...noCapabilities, streaming: true } }),
    ]);

    const decision = new RoutingEngine(registry).route({
      features: featuresFor('complete this function'),
      policy: policy(),
    });

    expect(decision.excluded).toEqual([]);
    expect(decision.evaluations.some((e) => e.modelId === 'acme/text-only')).toBe(true);
  });
});

describe('CASE 7 — an explicit model request is honoured', () => {
  it('uses the requested model even when the router would prefer another', () => {
    const unconstrained = ladder().route({
      features: featuresFor('rename the variable userId to userIdentifier'),
      policy: policy(),
    });
    expect(unconstrained.selectedModelId).toBe('acme/fast-1');

    const explicit = ladder().route({
      features: featuresFor('rename the variable userId to userIdentifier'),
      policy: policy(),
      requestedModelId: 'acme/deep-1',
    });

    expect(explicit.outcome).toBe('selected-explicit');
    expect(explicit.selectedModelId).toBe('acme/deep-1');
    expect(explicit.overrodeExplicitRequest).toBe(false);
    expect(explicit.reason).toContain('explicitly requested');
  });

  it('honours it even when it costs far more than the router would spend', () => {
    const explicit = ladder().route({
      features: featuresFor('write documentation for the config module'),
      policy: policy(),
      requestedModelId: 'acme/ultra-1',
    });

    expect(explicit.selectedModelId).toBe('acme/ultra-1');
  });

  it('reports clearly when the requested model is not configured', () => {
    const decision = ladder().route({
      features: featuresFor('rename a variable'),
      policy: policy(),
      requestedModelId: 'acme/does-not-exist',
    });

    expect(decision.outcome).toBe('explicit-model-unknown');
    expect(decision.selectedModelId).toBeNull();
    expect(decision.reason).toContain('is not configured');
  });

  it('refuses to substitute silently when the request cannot run the task', () => {
    const registry = new ModelRegistry([
      cheapModel({ id: 'acme/small', contextWindow: 8_000 }),
      frontierModel(),
    ]);

    const decision = new RoutingEngine(registry).route({
      features: featuresFor('refactor the payment pipeline', { contextTokens: 400_000 }),
      policy: policy({ modelOverrideEnabled: false }),
      requestedModelId: 'acme/small',
    });

    expect(decision.outcome).toBe('explicit-model-ineligible');
    expect(decision.selectedModelId).toBeNull();
    expect(decision.reason).toContain('context window');
    expect(decision.reason).toContain('override is disabled');
  });

  it('substitutes only when override is explicitly enabled, and says it did', () => {
    const registry = new ModelRegistry([
      cheapModel({ id: 'acme/small', contextWindow: 8_000 }),
      frontierModel(),
    ]);

    const decision = new RoutingEngine(registry).route({
      features: featuresFor('refactor the payment pipeline', { contextTokens: 400_000 }),
      policy: policy({ modelOverrideEnabled: true }),
      requestedModelId: 'acme/small',
    });

    expect(decision.selectedModelId).toBe('acme/deep-1');
    expect(decision.overrodeExplicitRequest).toBe(true);
    expect(decision.explanation.join('\n')).toContain('model override is enabled');
  });
});

describe('CASE 8 — an insufficient budget yields a cheaper model or a safe stop', () => {
  const prompt = 'implement a new /users API endpoint';

  it('falls back to a cheaper affordable model when configuration allows it', () => {
    // The medium rung would win, but the budget only stretches to the cheap one.
    const unconstrained = ladder().route({ features: featuresFor(prompt), policy: policy() });
    const winnerCost =
      unconstrained.evaluations.find((e) => e.modelId === unconstrained.selectedModelId)?.cost
        .expectedTotalToSuccess ?? 0;

    const decision = ladder().route({
      features: featuresFor(prompt),
      policy: policy({ requestBudget: winnerCost / 2, onBudgetExceeded: 'allow-fallback' }),
    });

    expect(decision.selectedModelId).toBe('acme/fast-1');
    expect(decision.outcome).toBe('selected-below-threshold');
    // The budget was respected; what was traded away was confidence.
    expect(decision.budgetExceeded).toBe(false);
    expect(decision.reason).toContain('confidence threshold');
  });

  it('stops safely rather than overspending when configured to stop', () => {
    const decision = ladder().route({
      features: featuresFor(prompt),
      policy: policy({ requestBudget: 0.0001, onBudgetExceeded: 'stop' }),
    });

    expect(decision.selectedModelId).toBeNull();
    expect(decision.outcome).toBe('stopped');
    expect(decision.budgetExceeded).toBe(false);
    expect(decision.reason).toContain('stopping rather than overspending');
  });

  it('asks the user when configured to ask, naming the cost it would incur', () => {
    const decision = ladder().route({
      features: featuresFor(prompt),
      policy: policy({ requestBudget: 0.0001, onBudgetExceeded: 'ask' }),
    });

    expect(decision.selectedModelId).toBeNull();
    expect(decision.outcome).toBe('ask-user');
    expect(decision.reason).toContain('Asking before spending it');
  });

  it('never exceeds a budget without saying so', () => {
    const decision = ladder().route({
      features: featuresFor(prompt),
      policy: policy({ requestBudget: 0.0001, onBudgetExceeded: 'allow-fallback' }),
    });

    expect(decision.outcome).toBe('selected-over-budget');
    expect(decision.budgetExceeded).toBe(true);
    expect(decision.explanation.join('\n')).toContain('exceeds the request budget');
    expect(decision.explanation.join('\n')).toContain('allow-fallback');
  });

  it('selects normally when the budget is generous', () => {
    const decision = ladder().route({
      features: featuresFor(prompt),
      policy: policy({ requestBudget: 1000 }),
    });

    expect(decision.outcome).toBe('selected');
    expect(decision.budgetExceeded).toBe(false);
  });

  it('treats an absent budget as unlimited, not as zero', () => {
    const decision = ladder().route({ features: featuresFor(prompt), policy: policy() });

    expect(decision.outcome).toBe('selected');
    expect(decision.evaluations.every((e) => e.withinBudget)).toBe(true);
  });
});

describe('the eight cases together', () => {
  it('routes cheap work cheaply and hard work expensively', () => {
    const engine = ladder();
    const cost = (prompt: string): number => {
      const decision = engine.route({ features: featuresFor(prompt), policy: policy() });
      return (
        decision.evaluations.find((e) => e.modelId === decision.selectedModelId)?.cost.initial ?? 0
      );
    };

    const rename = cost('rename the variable userId to userIdentifier');
    const endpoint = cost('implement a new /users API endpoint');
    const refactor = cost('refactor the authentication module across the entire repository');

    expect(rename).toBeLessThan(endpoint);
    expect(endpoint).toBeLessThan(refactor);
  });

  it('never selects a model that failed a hard constraint', () => {
    const registry = new ModelRegistry([
      cheapModel({ id: 'acme/small', contextWindow: 8_000 }),
      cheapModel({ id: 'acme/text-only', capabilities: { ...noCapabilities, streaming: true } }),
      mediumModel(),
      ultraModel({ availability: 'unavailable' }),
    ]);
    const engine = new RoutingEngine(registry);

    for (const prompt of [
      'rename a variable',
      'implement a new endpoint',
      'refactor everything across the repository',
      'explain this function',
    ]) {
      const decision = engine.route({
        features: featuresFor(prompt, { contextTokens: 300_000 }),
        policy: policy({ onBudgetExceeded: 'allow-fallback' }),
      });

      const excludedIds = decision.excluded.map((e) => e.modelId);
      expect(excludedIds).not.toContain(decision.selectedModelId);
    }
  });
});
