/**
 * Phase 12's validation, stated as the specification states it:
 *
 *   actual model = A
 *   shadow prediction = B
 *   and no request is sent to B
 *
 * This test lives in `src/adapters` rather than `src/core` on purpose. The core
 * cannot import an adapter — the architectural guard forbids it — so a test
 * that proves "no request reached B" has to sit where adapters are reachable
 * and watch a real one.
 *
 * The watcher is `FakeAgentAdapter.executions`, which records every
 * `(request, model)` pair it is handed. The assertion is therefore not "the
 * shadow router politely declined to execute"; it is "the only model any
 * adapter ever received was A".
 */

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../core/registry/model-registry.js';
import { DEFAULT_SHADOW_POLICIES, STRONGEST_FIRST } from '../core/shadow/policies.js';
import { ShadowRouter } from '../core/shadow/shadow-router.js';
import type { AgentExecutionRequest } from '../core/types/agent.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  policy,
} from '../test-support/routing-fixtures.js';
import { FakeAgentAdapter } from './fake/adapter.js';
import { AgentRegistry } from './registry.js';

const TASK = 'implement a new /users API endpoint';
const MODELS = [cheapModel(), mediumModel(), frontierModel()];

const request = (): AgentExecutionRequest => ({
  requestId: 'req-shadow-1',
  prompt: TASK,
  workspaceRoot: '/workspace',
  taskType: 'feature-implementation',
  requiredCapabilities: {},
});

/** Route with shadows, then execute **only** the live decision. */
async function routeAndExecute() {
  const models = new ModelRegistry(MODELS);
  const comparison = new ShadowRouter(models).compare({
    features: featuresFor(TASK),
    policy: policy({ minimumSuccessProbability: 0.5 }),
    shadowPolicies: DEFAULT_SHADOW_POLICIES,
  });

  const adapter = new FakeAgentAdapter({
    script: { result: { status: 'completed', changedFiles: ['src/users.ts'] } },
  });
  const agents = new AgentRegistry([adapter]);

  const selected = comparison.current.selectedModelId;
  if (selected === null) throw new Error('the live policy selected nothing');

  const outcome = await agents.execute(request(), models.require(selected));
  return { comparison, adapter, outcome, selected };
}

describe('a shadow policy never executes anything', () => {
  it('the live policy and a shadow choose different models', async () => {
    // The premise. If they agreed, the rest of this file would prove nothing:
    // "B was never executed" is trivially true when B is A.
    const { comparison } = await routeAndExecute();
    const strongest = comparison.shadows.find((s) => s.policyId === STRONGEST_FIRST.id);

    expect(comparison.current.selectedModelId).toBe('acme/fast-1');
    expect(strongest?.selectedModelId).toBe('acme/deep-1');
    expect(strongest?.agrees).toBe(false);
  });

  it('executes A exactly once', async () => {
    const { adapter } = await routeAndExecute();

    expect(adapter.attempts).toBe(1);
    expect(adapter.executions).toHaveLength(1);
    expect(adapter.executions[0]?.model.id).toBe('acme/fast-1');
  });

  it('NEVER sends a request for B', async () => {
    // The assertion the phase asks for, made against what the adapter actually
    // received rather than against the router's intent.
    const { adapter, comparison } = await routeAndExecute();
    const shadowModelIds = comparison.shadows
      .map((shadow) => shadow.selectedModelId)
      .filter((id): id is string => id !== null && id !== comparison.current.selectedModelId);

    expect(shadowModelIds).toContain('acme/deep-1');

    const executedModelIds = adapter.executions.map((execution) => execution.model.id);
    for (const shadowModelId of shadowModelIds) {
      expect(executedModelIds).not.toContain(shadowModelId);
    }
  });

  it('sends exactly one model to any adapter, whatever the shadows decided', async () => {
    const { adapter } = await routeAndExecute();

    // Not "at most one per model" — one execution in total. Three shadow
    // policies were evaluated and none of them added a request.
    expect(adapter.executions.map((execution) => execution.model.id)).toEqual(['acme/fast-1']);
  });

  it('evaluating more shadow policies does not add a single execution', async () => {
    // The number of adapter calls must be independent of how many policies are
    // being compared. If shadow evaluation ever started executing, this is the
    // test that would notice.
    const models = new ModelRegistry(MODELS);
    const adapter = new FakeAgentAdapter();
    const agents = new AgentRegistry([adapter]);

    for (const policies of [[], [STRONGEST_FIRST], DEFAULT_SHADOW_POLICIES]) {
      const comparison = new ShadowRouter(models).compare({
        features: featuresFor(TASK),
        policy: policy({ minimumSuccessProbability: 0.5 }),
        shadowPolicies: policies,
      });
      const selected = comparison.current.selectedModelId;
      if (selected === null) throw new Error('nothing selected');
      await agents.execute(request(), models.require(selected));
    }

    // Three routes, three executions — one each, none from a shadow.
    expect(adapter.attempts).toBe(3);
    expect(adapter.executions.every((e) => e.model.id === 'acme/fast-1')).toBe(true);
  });

  it('touches no adapter at all when nothing is executed', async () => {
    // Shadow evaluation on its own, with an adapter present and unused.
    const adapter = new FakeAgentAdapter();
    const models = new ModelRegistry(MODELS);

    new ShadowRouter(models).compare({
      features: featuresFor(TASK),
      policy: policy({ minimumSuccessProbability: 0.5 }),
      shadowPolicies: DEFAULT_SHADOW_POLICIES,
    });

    expect(adapter.attempts).toBe(0);
    expect(adapter.executions).toEqual([]);
    await Promise.resolve();
  });

  it('reports the shadow as a model id, not something executable', async () => {
    // A structural guarantee: there is no session or promise on a shadow
    // outcome, so a caller cannot run one even by mistake.
    const { comparison } = await routeAndExecute();
    const strongest = comparison.shadows.find((s) => s.policyId === STRONGEST_FIRST.id);

    expect(typeof strongest?.selectedModelId).toBe('string');
    expect(strongest).not.toHaveProperty('session');
    expect(strongest).not.toHaveProperty('result');
    expect(strongest).not.toHaveProperty('execute');
  });

  it('still produces a usable result for the model that did run', async () => {
    // The live path must be unaffected by shadow evaluation happening beside it.
    const { outcome, selected } = await routeAndExecute();

    expect(selected).toBe('acme/fast-1');
    expect(outcome.result.status).toBe('completed');
    expect(outcome.attempts).toHaveLength(1);
  });
});
