/**
 * The phase's acceptance criterion: routing must be deterministic.
 *
 * "Deterministic" here means more than "does not call Math.random". It means
 * the decision is a pure function of its inputs — insensitive to the order
 * models were registered in, stable across repeated calls and across separate
 * engine instances, and free of any dependence on the clock. A router whose
 * answer drifts cannot be evaluated offline (spec section 42) or trusted by a
 * user (spec section 50).
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
import { RoutingEngine } from './routing-engine.js';

const PROMPTS = [
  'rename the variable userId to userIdentifier',
  'write documentation for the config module',
  'implement a new /users API endpoint',
  'refactor the authentication module across the entire repository',
  'debug why the worker pool deadlocks under load',
  'explain what this function does',
  'migrate the build from webpack to vite',
  '',
  'x',
];

describe('determinism — repeated calls', () => {
  it('produces an identical decision every time', () => {
    const engine = new RoutingEngine(new ModelRegistry(modelLadder()));

    for (const prompt of PROMPTS) {
      const features = featuresFor(prompt);
      const first = engine.route({ features, policy: policy() });

      for (let i = 0; i < 5; i += 1) {
        expect(engine.route({ features, policy: policy() })).toEqual(first);
      }
    }
  });

  it('serialises identically, including every list order', () => {
    const engine = new RoutingEngine(new ModelRegistry(modelLadder()));
    const features = featuresFor('implement a new /users API endpoint');

    const a = JSON.stringify(engine.route({ features, policy: policy() }));
    const b = JSON.stringify(engine.route({ features, policy: policy() }));

    expect(a).toBe(b);
  });

  it('gives the same answer from a fresh engine instance', () => {
    const features = featuresFor('refactor the authentication module across the entire repository');

    const first = new RoutingEngine(new ModelRegistry(modelLadder())).route({
      features,
      policy: policy(),
    });
    const second = new RoutingEngine(new ModelRegistry(modelLadder())).route({
      features,
      policy: policy(),
    });

    expect(second).toEqual(first);
  });
});

describe('determinism — registration order', () => {
  it('is unaffected by the order models were registered in', () => {
    const orders = [
      [cheapModel(), mediumModel(), frontierModel(), ultraModel()],
      [ultraModel(), frontierModel(), mediumModel(), cheapModel()],
      [frontierModel(), cheapModel(), ultraModel(), mediumModel()],
      [mediumModel(), ultraModel(), cheapModel(), frontierModel()],
    ];

    for (const prompt of PROMPTS) {
      const features = featuresFor(prompt);
      const decisions = orders.map((models) =>
        new RoutingEngine(new ModelRegistry(models)).route({ features, policy: policy() }),
      );

      const [reference] = decisions;
      for (const decision of decisions) {
        expect(decision).toEqual(reference);
      }
    }
  });

  it('orders evaluations by expected cost regardless of registration order', () => {
    const shuffled = new RoutingEngine(
      new ModelRegistry([ultraModel(), cheapModel(), frontierModel(), mediumModel()]),
    ).route({ features: featuresFor('implement a new /users API endpoint'), policy: policy() });

    const costs = shuffled.evaluations.map((e) => e.cost.expectedTotalToSuccess);
    const sorted = [...costs].sort((a, b) => a - b);
    expect(costs).toEqual(sorted);
  });
});

describe('determinism — ties', () => {
  it('breaks an exact tie by model id, not by insertion order', () => {
    // Two models identical in everything the router scores. The only stable
    // way to choose is the id, and it must not depend on registration order.
    const twinA = cheapModel({ id: 'acme/twin-a', modelId: 'twin-a' });
    const twinB = cheapModel({ id: 'acme/twin-b', modelId: 'twin-b' });
    const features = featuresFor('rename the variable userId to userIdentifier');

    const forward = new RoutingEngine(new ModelRegistry([twinA, twinB])).route({
      features,
      policy: policy(),
    });
    const backward = new RoutingEngine(new ModelRegistry([twinB, twinA])).route({
      features,
      policy: policy(),
    });

    expect(forward.selectedModelId).toBe('acme/twin-a');
    expect(backward.selectedModelId).toBe('acme/twin-a');
  });

  it('is not perturbed by floating-point noise below the comparison epsilon', () => {
    // Prices differing by a fraction of a millionth of a cent must not flip a
    // decision; that would make routing look random to a user.
    const a = cheapModel({ id: 'acme/twin-a', modelId: 'twin-a' });
    const b = cheapModel({
      id: 'acme/twin-b',
      modelId: 'twin-b',
      pricing: { inputPerMillion: 0.5 + 1e-15, outputPerMillion: 2.5, currency: 'USD' },
    });

    const decision = new RoutingEngine(new ModelRegistry([b, a])).route({
      features: featuresFor('rename the variable userId to userIdentifier'),
      policy: policy(),
    });

    expect(decision.selectedModelId).toBe('acme/twin-a');
  });
});

describe('determinism — no hidden inputs', () => {
  it('does not depend on the wall clock', async () => {
    const engine = new RoutingEngine(new ModelRegistry(modelLadder()));
    const features = featuresFor('implement a new /users API endpoint');

    const before = engine.route({ features, policy: policy() });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const after = engine.route({ features, policy: policy() });

    expect(after).toEqual(before);
    // A decision carries no timestamp; timing belongs to the outcome record.
    expect(before).not.toHaveProperty('timestamp');
    expect(before).not.toHaveProperty('decidedAt');
  });

  it('contains no randomness in the routing sources', async () => {
    // Exploration is off by default and arrives in a later phase
    // (spec section 40). Until then, nothing in routing may sample.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');

    const directory = path.dirname(url.fileURLToPath(import.meta.url));
    const entries = await fs.readdir(directory);
    const sources = entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const contents = await fs.readFile(path.join(directory, name), 'utf8');
      expect(contents, `${name} must not use randomness`).not.toMatch(
        /Math\.random|crypto\.getRandomValues/,
      );
      expect(contents, `${name} must not read the clock`).not.toMatch(/Date\.now|new Date\(/);
    }
  });
});

describe('determinism — policy changes are the only way to change the answer', () => {
  it('changes the decision only when an input changes', () => {
    const engine = new RoutingEngine(new ModelRegistry(modelLadder()));
    const features = featuresFor('implement a new /users API endpoint');

    const strict = engine.route({
      features,
      policy: policy({ minimumSuccessProbability: 0.95, onBudgetExceeded: 'allow-fallback' }),
    });
    const lenient = engine.route({ features, policy: policy({ minimumSuccessProbability: 0.5 }) });

    // Same models, same task — different policy, so a different answer is
    // expected, and it must still be stable.
    expect(strict.selectedModelId).not.toBe(lenient.selectedModelId);
    expect(
      engine.route({
        features,
        policy: policy({ minimumSuccessProbability: 0.95, onBudgetExceeded: 'allow-fallback' }),
      }),
    ).toEqual(strict);
  });
});
