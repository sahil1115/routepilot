/**
 * `routepilot run` (spec section 74).
 *
 * The command that finally gives the MVP spine a production caller. Every test
 * here injects a registry, so the suite never spawns a coding agent — the one
 * thing that must stay true of a test file for a command whose job is to start
 * one.
 */

import { describe, expect, it } from 'vitest';

import { AgentRegistry } from '../adapters/registry.js';
import { FakeAgentAdapter } from '../adapters/fake/adapter.js';
import { parseConfig } from '../config/schema.js';
import { RoutingEngine } from '../core/routing/routing-engine.js';
import { TaskClassifier } from '../core/analysis/task-classifier.js';
import { ModelRegistry } from '../core/registry/model-registry.js';
import { stageTimings } from '../core/perf/timings.js';
import { cheapModel, featuresFor, mediumModel, policy } from '../test-support/routing-fixtures.js';
import { NOT_ASSESSED } from '../core/calibration/gate.js';
import type { RouteResult } from './route.js';
import { nestedAdapterIds, renderRun, runTask } from './run.js';

const MODELS = [cheapModel(), mediumModel()];

/**
 * A configuration containing the fixture models, so `run` can resolve them.
 *
 * Built from the same fixtures the router is given, rather than from the
 * example config: the model the router selects has to be a model the runner can
 * look up, and two independent lists would drift.
 */
function config() {
  return parseConfig({
    version: 1,
    providers: [
      {
        id: 'acme',
        displayName: 'Acme',
        kind: 'cloud',
        auth: { kind: 'apiKey', envVar: 'ACME_API_KEY' },
      },
    ],
    models: MODELS.map((model) => ({ ...model, providerId: 'acme' })),
  });
}

/** A real routing decision, produced by the real router. */
function routeResult(task = 'Rename this variable.'): RouteResult {
  const registry = new ModelRegistry(MODELS);
  const decision = new RoutingEngine(registry).route({
    features: featuresFor(task),
    policy: policy(),
  });

  return {
    analysis: {
      // The real classifier, not a stub: `run` reads the analysis it is handed,
      // and a hand-built one could disagree with what `route` actually produces.
      classification: new TaskClassifier().classify({ prompt: task }),
      // The snapshot is the one part `run` never reads. Casting through
      // `unknown` says that plainly rather than building a fake repository.
      snapshot: undefined as unknown as RouteResult['analysis']['snapshot'],
      features: featuresFor(task),
      timings: { analysisMs: 0, featureExtractionMs: 0 },
    },
    decision,
    calibration: NOT_ASSESSED,
    shadow: null,
    timings: stageTimings({ analysisMs: 0, featureExtractionMs: 0, routingMs: 0 }),
  };
}

/** A registry holding one adapter that always succeeds. */
function fakeRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(new FakeAgentAdapter());
  return registry;
}

const BASE = {
  config: config(),
  workspaceRoot: '/workspace',
  task: 'Rename this variable.',
  // Empty: every test that reaches the execute path must not be blocked by the
  // host machine happening to be inside a Claude Code session.
  env: {} as NodeJS.ProcessEnv,
};

describe('run plans by default', () => {
  it('executes nothing without --execute', async () => {
    // The safety property that matters most. `run` hands a coding agent write
    // access to a workspace, and no adapter has ever been verified, so the
    // default must be inert.
    const registry = fakeRegistry();
    const result = await runTask({ ...BASE, route: routeResult(), registry });

    expect(result.refusal).toBe('plan-only');
    expect(result.run).toBeNull();
  });

  it('says so in the rendered output', async () => {
    const result = await runTask({ ...BASE, route: routeResult(), registry: fakeRegistry() });
    const rendered = renderRun(result);

    expect(rendered).toContain('Plan (nothing executed)');
    expect(rendered).toContain('--execute');
  });
});

describe('run executes when asked', () => {
  it('carries the task to an outcome', async () => {
    const result = await runTask({
      ...BASE,
      route: routeResult(),
      registry: fakeRegistry(),
      execute: true,
    });

    expect(result.refusal).toBeNull();
    expect(result.run?.outcome).toBe('succeeded');
    expect(result.run?.attempts.length).toBeGreaterThan(0);
  });

  it('runs the model the plan named', async () => {
    // Routing happens once and its result is handed to `run`, so the plan and
    // the execution cannot disagree. If `run` re-routed internally, a change in
    // learned state between the two passes could silently substitute a model.
    const route = routeResult();
    const result = await runTask({
      ...BASE,
      route,
      registry: fakeRegistry(),
      execute: true,
    });

    expect(result.run?.attempts[0]?.modelId).toBe(route.decision.selectedModelId);
  });
});

describe('run refuses rather than guessing', () => {
  it('will not execute a decision the router declined', async () => {
    const declined = routeResult();
    const route: RouteResult = {
      ...declined,
      decision: { ...declined.decision, selectedModelId: null },
    };

    const result = await runTask({ ...BASE, route, registry: fakeRegistry(), execute: true });

    expect(result.refusal).toBe('no-model');
    expect(result.run).toBeNull();
  });

  it('will not execute with no adapter available', async () => {
    const result = await runTask({
      ...BASE,
      route: routeResult(),
      registry: new AgentRegistry(),
      execute: true,
    });

    expect(result.refusal).toBe('no-adapter');
  });

  it('reports an unknown adapter id instead of silently running another', async () => {
    const result = await runTask({
      ...BASE,
      route: routeResult(),
      registry: fakeRegistry(),
      execute: true,
      adapterId: 'not-a-real-adapter',
    });

    expect(result.refusal).toBe('unknown-adapter');
  });
});

describe('the nested-session guard', () => {
  it('recognises a Claude Code session', () => {
    expect(nestedAdapterIds({ CLAUDECODE: '1' })).toEqual(['claude-code']);
  });

  it('ignores an empty or absent variable', () => {
    // An exported-but-empty variable is not a session, and treating it as one
    // would block execution on machines that merely mention the name.
    expect(nestedAdapterIds({})).toEqual([]);
    expect(nestedAdapterIds({ CLAUDECODE: '' })).toEqual([]);
  });

  it('refuses to execute the agent it is running inside', async () => {
    // Running Claude Code inside Claude Code crashes every active session.
    // `scripts/verify-adapter.mjs` has refused this since Phase 5; `run`
    // reaches the same binary by a different path and needs the same guard.
    const registry = new AgentRegistry();
    registry.register(new FakeAgentAdapter({ id: 'claude-code' }));

    const result = await runTask({
      ...BASE,
      route: routeResult(),
      registry,
      execute: true,
      env: { CLAUDECODE: '1' },
    });

    expect(result.refusal).toBe('nested-session');
    expect(result.run).toBeNull();
  });

  it('still produces a plan inside such a session', async () => {
    // Refusing to *execute* is right; refusing to answer "what would you do" is
    // not, and would make the command useless in the environment where it is
    // most likely to be tried first.
    const registry = new AgentRegistry();
    registry.register(new FakeAgentAdapter({ id: 'claude-code' }));

    const result = await runTask({
      ...BASE,
      route: routeResult(),
      registry,
      env: { CLAUDECODE: '1' },
    });

    expect(result.refusal).toBe('plan-only');
  });
});
