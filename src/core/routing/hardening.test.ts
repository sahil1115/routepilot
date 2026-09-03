/**
 * Guards that were documented, believed, and unenforced.
 *
 * Two invariants this project states plainly and did not check:
 *
 * - **Costs are only comparable within one currency.**
 *   `isComparableCurrency` was written in Phase 3 with a docstring saying
 *   callers ranking models on price "must check this first". No caller ever
 *   did. The config schema rejects a mixed-currency document, so the CLI was
 *   safe, and every other consumer — the registry and the routing engine both
 *   accept hand-built `ModelSpec`s — got a silently nonsensical ranking.
 *
 * - **A budget bounds what runs, not merely what is selected.**
 *   `TaskRunner` never read `decision.budgetExceeded`. Only `src/cli/run.ts`
 *   refused, so any other caller handing the runner an over-budget decision
 *   would have executed it — the budget applying or not depending on which
 *   entry point was used.
 */

import { describe, expect, it } from 'vitest';

import { makeModel } from '../../test-support/fixtures.js';
import { featuresFor, policy } from '../../test-support/routing-fixtures.js';
import { ScriptedExecutor, steppingClock } from '../../test-support/e2e-fixtures.js';
import { ModelRegistry } from '../registry/model-registry.js';
import { TaskRunner } from '../run/task-runner.js';
import type { ModelSpec } from '../types/model.js';
import { RoutingEngine } from './routing-engine.js';

const TASK = 'Rename this variable.';

const usd: ModelSpec = makeModel({
  id: 'acme/usd',
  modelId: 'usd',
  pricing: { inputPerMillion: 1, outputPerMillion: 5, currency: 'USD' },
});
const eur: ModelSpec = makeModel({
  id: 'acme/eur',
  modelId: 'eur',
  pricing: { inputPerMillion: 1, outputPerMillion: 5, currency: 'EUR' },
});

describe('costs are never compared across currencies', () => {
  it('refuses to route a mixed-currency model set', () => {
    // Throws rather than degrading. There is no sensible fallback: converting
    // needs a rate this project does not have, and comparing the numbers anyway
    // produces a confident wrong answer, which is the worst option available.
    const engine = new RoutingEngine(new ModelRegistry([usd, eur]));

    expect(() => engine.route({ features: featuresFor(TASK), policy: policy() })).toThrow(
      /across currencies/i,
    );
  });

  it('names both models and both currencies, so the fix is obvious', () => {
    const engine = new RoutingEngine(new ModelRegistry([usd, eur]));

    expect(() => engine.route({ features: featuresFor(TASK), policy: policy() })).toThrow(
      /acme\/eur.*EUR|EUR.*acme\/eur/,
    );
  });

  it('routes normally when every model shares a currency', () => {
    const engine = new RoutingEngine(new ModelRegistry([usd]));
    const decision = engine.route({
      features: featuresFor(TASK),
      policy: policy({ minimumSuccessProbability: 0.1 }),
    });

    expect(decision.selectedModelId).toBe('acme/usd');
  });
});

describe('the runner enforces the budget it was handed', () => {
  const models = new ModelRegistry([usd]);

  function runner() {
    const executor = new ScriptedExecutor({});
    return {
      executor,
      runner: new TaskRunner({ models, executor, clock: steppingClock() }),
    };
  }

  /** A decision that knowingly exceeds the request budget. */
  function overBudget() {
    const decision = new RoutingEngine(models).route({
      features: featuresFor(TASK),
      policy: policy({ requestBudget: 0.000_001, minimumSuccessProbability: 0.1 }),
      requestedModelId: 'acme/usd',
    });
    expect(decision.selectedModelId).toBe('acme/usd');
    expect(decision.budgetExceeded).toBe(true);
    return decision;
  }

  it('refuses an over-budget decision when no override is given', async () => {
    const built = runner();
    const result = await built.runner.run({
      requestId: 'budget-guard',
      task: TASK,
      workspaceRoot: '/workspace',
      features: featuresFor(TASK),
      policy: policy({ requestBudget: 0.000_001 }),
      decision: overBudget(),
    });

    expect(result.outcome).toBe('stopped');
    expect(result.reason).toMatch(/exceeds the request budget/i);
    // The point of the guard: nothing was spent.
    expect(built.executor.executedModelIds).toEqual([]);
    expect(result.totalCost).toBe(0);
  });

  it('executes once the caller says the overspend is permitted', async () => {
    // The override has to be explicit. `src/cli/run.ts` sets it only after
    // applying `budgets.onExceeded`, so the two agree rather than each assuming
    // the other checked.
    const built = runner();
    const result = await built.runner.run({
      requestId: 'budget-guard-allowed',
      task: TASK,
      workspaceRoot: '/workspace',
      features: featuresFor(TASK),
      policy: policy({ requestBudget: 0.000_001 }),
      decision: overBudget(),
      allowOverBudget: true,
    });

    expect(result.outcome).not.toBe('stopped');
    expect(built.executor.executedModelIds).toEqual(['acme/usd']);
  });
});
