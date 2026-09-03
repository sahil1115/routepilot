/**
 * Limits and budget during execution (Phase 24, spec section 27 and 16).
 *
 * An external review found that `run --execute` applied none of the limits the
 * configuration states, that the request budget bounded model *selection* only,
 * and that escalation could land on a candidate the router had already marked
 * non-viable. These tests hold the runner to each, through the real
 * `TaskRunner` with scripted executors — the same construction the end-to-end
 * scenarios use.
 */

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../registry/model-registry.js';
import { RoutingEngine } from '../routing/routing-engine.js';
import { ValidationEngine } from '../execution/validation.js';
import { priceModelTokens } from '../pricing.js';
import type { EscalationLimits } from '../types/escalation.js';
import type { RoutingDecision } from '../types/routing.js';
import type { ModelSpec } from '../types/model.js';
import {
  makesBadEdits,
  ScriptedCommandRunner,
  ScriptedExecutor,
  steppingClock,
  type ScriptedRun,
} from '../../test-support/e2e-fixtures.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  policy,
} from '../../test-support/routing-fixtures.js';
import { TaskRunner } from './task-runner.js';

const TASK = 'Rename this variable.';
const LADDER: readonly ModelSpec[] = [cheapModel(), mediumModel(), frontierModel()];

const DEFAULT_LIMITS: EscalationLimits = { maxEscalationsPerTask: 2, maxRetriesPerModel: 1 };

/** Route the task with the given policy, so a test can inspect the decision first. */
function decide(overrides: Parameters<typeof policy>[0] = {}): RoutingDecision {
  return new RoutingEngine(new ModelRegistry(LADDER)).route({
    features: featuresFor(TASK),
    policy: policy(overrides),
  });
}

/**
 * A runner whose cheap rung leaves the tests failing, so every run classifies
 * as MODEL_WEAKNESS and escalation is exercised.
 */
function runner(
  scripts: Record<string, ScriptedRun>,
  limits: EscalationLimits,
): { runner: TaskRunner; executor: ScriptedExecutor } {
  const executor = new ScriptedExecutor(scripts);
  const models = new ModelRegistry(LADDER);
  return {
    executor,
    runner: new TaskRunner({
      models,
      executor,
      limits,
      validation: new ValidationEngine({
        runner: new ScriptedCommandRunner(['npm run test']),
        commands: { tests: { command: 'npm', args: ['run', 'test'] } },
      }),
      clock: steppingClock(),
    }),
  };
}

async function run(
  decision: RoutingDecision,
  scripts: Record<string, ScriptedRun>,
  limits: EscalationLimits,
) {
  const built = runner(scripts, limits);
  const result = await built.runner.run({
    requestId: 'limits',
    task: TASK,
    workspaceRoot: '/workspace',
    features: featuresFor(TASK),
    policy: decision.policy,
    decision,
  });
  return { result, executor: built.executor };
}

describe('configured escalation limits are applied', () => {
  it('stops after one attempt when no escalation is permitted', async () => {
    const decision = decide();
    const cheap = decision.selectedModelId!;

    const { result } = await run(
      decision,
      { [cheap]: makesBadEdits() },
      { ...DEFAULT_LIMITS, maxEscalationsPerTask: 0 },
    );

    expect(result.outcome).toBe('stopped');
    expect(result.attempts).toHaveLength(1);
    expect(result.escalations.at(-1)?.limitReached).toBe('escalations');
  });
});

describe('the request budget caps total spend, not just the first attempt', () => {
  it('stops on cost before an escalation that would exceed it', async () => {
    const decision = decide();
    const cheap = LADDER.find((model) => model.id === decision.selectedModelId)!;

    // The cheap attempt spends 0.6 of the budget; the budget is set from that.
    // `makesBadEdits` reports real usage, so its cost is priced from tokens,
    // not estimated.
    const cheapCost = priceModelTokens(cheap, {
      inputTokens: 30_000,
      outputTokens: 4_000,
    }).totalCost;
    const budget = cheapCost / 0.6;

    // Precondition, so the scenario is what its name says: whichever stronger
    // model escalation would pick, its projected first attempt must push the
    // total past the budget. If fixture prices ever change, this fails here
    // with a clear message rather than passing for the wrong reason.
    const { context } = featuresFor(TASK);
    const projected = LADDER.filter((model) => model.id !== cheap.id).map(
      (model) =>
        priceModelTokens(model, {
          inputTokens: context.estimatedInputTokens,
          outputTokens: context.estimatedOutputTokens,
        }).totalCost,
    );
    expect(Math.min(...projected)).toBeGreaterThan(0.4 * budget);

    const { result, executor } = await run(
      decision,
      { [cheap.id]: makesBadEdits() },
      { ...DEFAULT_LIMITS, maxTotalCost: budget },
    );

    expect(result.outcome).toBe('stopped');
    expect(result.escalations.at(-1)?.limitReached).toBe('cost');
    expect(executor.executedModelIds).toEqual([cheap.id]);
    expect(result.totalCost).toBeLessThan(budget);
    // The refusal names what it would have run, so the stop is auditable.
    expect(result.escalations.at(-1)?.toModelId).not.toBeNull();
  });
});

describe('escalation never lowers the bar', () => {
  it('does not select a candidate the router marked non-viable', async () => {
    // Find a request budget that admits cheap and medium but not frontier, by
    // reading the router's own estimates rather than guessing at prices.
    const unconstrained = decide();
    const expected = (id: string) =>
      unconstrained.evaluations.find((e) => e.modelId === id)!.cost.expectedTotalToSuccess;
    const medium = mediumModel().id;
    const frontier = frontierModel().id;
    const budget = (expected(medium) + expected(frontier)) / 2;

    const decision = decide({ requestBudget: budget });
    const frontierEvaluation = decision.evaluations.find((e) => e.modelId === frontier);
    expect(frontierEvaluation).toBeDefined();
    expect(frontierEvaluation?.viable).toBe(false);
    expect(decision.selectedModelId).not.toBe(frontier);

    // Both affordable rungs fail, so escalation runs out of viable candidates.
    // The non-viable frontier model is present in the decision and must still
    // never be reached for.
    const { result, executor } = await run(
      decision,
      { [decision.selectedModelId!]: makesBadEdits(), [medium]: makesBadEdits() },
      // No cost cap here: the point is viability, and a cap would stop the run
      // for a different reason before the escalation under test.
      DEFAULT_LIMITS,
    );

    expect(executor.executedModelIds).not.toContain(frontier);
    expect(result.outcome).toBe('stopped');
  });
});

describe('a supplied decision is executed as-is', () => {
  it('runs the model the decision names, without a router', async () => {
    const decision = decide();
    const { result, executor } = await run(decision, {}, DEFAULT_LIMITS);

    expect(result.decision).toBe(decision);
    expect(executor.executedModelIds[0]).toBe(decision.selectedModelId);
  });

  it('refuses to run with neither a decision nor a router', async () => {
    const executor = new ScriptedExecutor({});
    const bare = new TaskRunner({ models: new ModelRegistry(LADDER), executor });

    await expect(
      bare.run({
        requestId: 'no-router',
        task: TASK,
        workspaceRoot: '/workspace',
        features: featuresFor(TASK),
        policy: policy(),
      }),
    ).rejects.toThrow(/neither a routing decision nor a router/);
  });
});
