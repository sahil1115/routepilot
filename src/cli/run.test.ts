/**
 * `routepilot run` (spec section 74).
 *
 * The command that finally gives the MVP spine a production caller. Every test
 * here injects a registry, so the suite never spawns a coding agent — the one
 * thing that must stay true of a test file for a command whose job is to start
 * one.
 */

import { afterEach, describe, expect, it } from 'vitest';

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
import { EXIT_CODE_DESCRIPTIONS, EXIT_ERROR, EXIT_OK, EXIT_UNVERIFIED } from './exit-codes.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTelemetryStore, type LocalStore } from '../telemetry/open.js';
import { LearnedSuccessModel } from '../core/learning/success-model.js';
import {
  overratedModel,
  syntheticObservations,
  underratedModel,
} from '../test-support/learning-fixtures.js';

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
  it('reports `unverified`, not `succeeded`, when nothing validated the work', async () => {
    const result = await runTask({
      ...BASE,
      route: routeResult(),
      registry: fakeRegistry(),
      execute: true,
    });

    // The bug this file previously encoded: `run --execute` configures a
    // validation engine but no commands, so every check is skipped, and a
    // report where nothing ran used to read as passing. The task ran; nothing
    // confirmed it did what was asked, and the outcome now says so.
    expect(result.refusal).toBeNull();
    expect(result.run?.outcome).toBe('unverified');
    expect(result.run?.attempts.length).toBeGreaterThan(0);
    expect(result.run?.reason).toMatch(/nothing verified it/i);
    // And the unfounded claim never reaches scoring or learning.
    expect(result.run?.signals?.taskCriteriaMet).toBeNull();
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

// ---------------------------------------------------------------------------
// Phase 24, defect 1: the model the plan names is the model that executes.
// ---------------------------------------------------------------------------

describe('the plan is the model that executes', () => {
  // The Phase 10 fixture: static priors flatter `flatters-1`, and two hundred
  // observations per model reveal `modest-1` as the better bet. A plan routed
  // with learning names modest; a runner that re-routed without learning would
  // execute flatters. That is exactly the divergence the review found.
  const LEARNED = [overratedModel(), underratedModel()];
  const TASK = 'implement a new /users API endpoint';
  const learning = { enabled: true, minimumTrainingSamples: 50 };

  const dirs: string[] = [];
  const stores: LocalStore[] = [];

  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10 })),
    );
  });

  function learnedConfig() {
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
      models: LEARNED.map((model) => ({ ...model, providerId: 'acme' })),
      routing: { minimumSuccessProbability: 0.5 },
      learning,
    });
  }

  async function trainedStore(): Promise<LocalStore> {
    const dir = await mkdtemp(join(tmpdir(), 'routepilot-plan-'));
    dirs.push(dir);
    const store = await openTelemetryStore({ enabled: true, storagePath: dir });
    stores.push(store);

    const trainer = new LearnedSuccessModel(store, learning);
    trainer.observeAll(syntheticObservations('acme/flatters-1', 200), 1_000);
    trainer.observeAll(syntheticObservations('acme/modest-1', 200), 1_000);
    return store;
  }

  /** Route the way `routepilot route` does: with the learned model consulted. */
  function planWith(store: LocalStore): RouteResult {
    const registry = new ModelRegistry(LEARNED);
    const decision = new RoutingEngine(registry, new LearnedSuccessModel(store, learning)).route({
      features: featuresFor(TASK),
      policy: policy({ minimumSuccessProbability: 0.5 }),
    });
    return {
      analysis: {
        classification: new TaskClassifier().classify({ prompt: TASK }),
        snapshot: undefined as unknown as RouteResult['analysis']['snapshot'],
        features: featuresFor(TASK),
        timings: { analysisMs: 0, featureExtractionMs: 0 },
      },
      decision,
      calibration: NOT_ASSESSED,
      shadow: null,
      timings: stageTimings({ analysisMs: 0, featureExtractionMs: 0, routingMs: 0 }),
    };
  }

  it('executes the model the learned plan named, not the static favourite', async () => {
    const store = await trainedStore();
    const plan = planWith(store);

    // Precondition: learning really did flip the choice. Without this the test
    // would pass on any plan, including one that agreed with static routing.
    expect(plan.decision.selectedModelId).toBe('acme/modest-1');
    const unlearned = new RoutingEngine(new ModelRegistry(LEARNED)).route({
      features: featuresFor(TASK),
      policy: policy({ minimumSuccessProbability: 0.5 }),
    });
    expect(unlearned.selectedModelId).toBe('acme/flatters-1');

    const adapter = new FakeAgentAdapter();
    const registry = new AgentRegistry();
    registry.register(adapter);

    const result = await runTask({
      route: plan,
      config: learnedConfig(),
      workspaceRoot: '/workspace',
      task: TASK,
      env: {},
      registry,
      execute: true,
      store,
    });

    expect(result.refusal).toBeNull();
    expect(adapter.executions[0]?.model.id).toBe(plan.decision.selectedModelId);
    // Identity, not equality: the runner was handed this object and kept it.
    expect(result.run?.decision).toBe(plan.decision);
  });

  it('records the decision the run executed', async () => {
    const store = await trainedStore();
    const plan = planWith(store);
    const adapter = new FakeAgentAdapter();
    const registry = new AgentRegistry();
    registry.register(adapter);

    await runTask({
      route: plan,
      config: learnedConfig(),
      workspaceRoot: '/workspace',
      task: TASK,
      env: {},
      registry,
      execute: true,
      store,
    });

    const recorded = store.recentRouting(1)[0];
    expect(recorded?.selectedModelId).toBe(adapter.executions[0]?.model.id);
    expect(recorded?.selectedModelId).toBe('acme/modest-1');
  });
});

// ---------------------------------------------------------------------------
// Phase 24, defect 3: an explicit model over budget is never run silently.
// ---------------------------------------------------------------------------

describe('an explicitly requested model over the request budget', () => {
  const BUDGET = 0.0001;
  const REQUESTED = mediumModel().id;

  function budgetConfig(onExceeded: 'stop' | 'ask' | 'allow-fallback') {
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
      budgets: { request: BUDGET, onExceeded },
    });
  }

  /** A plan that pins a model whose estimate is far over a tiny budget. */
  function overBudgetPlan(): RouteResult {
    const base = routeResult();
    const decision = new RoutingEngine(new ModelRegistry(MODELS)).route({
      features: featuresFor('Rename this variable.'),
      policy: policy({ requestBudget: BUDGET }),
      requestedModelId: REQUESTED,
    });
    // Precondition for every test below.
    expect(decision.selectedModelId).toBe(REQUESTED);
    expect(decision.budgetExceeded).toBe(true);
    return { ...base, decision };
  }

  function harness() {
    const adapter = new FakeAgentAdapter();
    const registry = new AgentRegistry();
    registry.register(adapter);
    return { adapter, registry };
  }

  it('is refused when onExceeded is "stop", naming the model, estimate and budget', async () => {
    const { adapter, registry } = harness();
    const result = await runTask({
      ...BASE,
      route: overBudgetPlan(),
      config: budgetConfig('stop'),
      registry,
      execute: true,
    });

    expect(result.refusal).toBe('budget-exceeded');
    expect(adapter.attempts).toBe(0);

    const rendered = renderRun(result);
    expect(rendered).toContain('over budget');
    expect(rendered).toContain(REQUESTED);
    expect(rendered).toContain('cannot be overridden');
  });

  it('is refused when onExceeded is "ask", and names the override flag', async () => {
    const { adapter, registry } = harness();
    const result = await runTask({
      ...BASE,
      route: overBudgetPlan(),
      config: budgetConfig('ask'),
      registry,
      execute: true,
    });

    expect(result.refusal).toBe('budget-exceeded');
    expect(adapter.attempts).toBe(0);
    expect(renderRun(result)).toContain('--allow-over-budget');
  });

  it('executes under "ask" once --allow-over-budget is given, and prints the overspend', async () => {
    const { adapter, registry } = harness();
    const result = await runTask({
      ...BASE,
      route: overBudgetPlan(),
      config: budgetConfig('ask'),
      registry,
      execute: true,
      allowOverBudget: true,
    });

    expect(result.refusal).toBeNull();
    expect(adapter.attempts).toBe(1);
    expect(result.overspend?.permittedBy).toBe('flag');

    const rendered = renderRun(result);
    expect(rendered).toContain('over budget');
    expect(rendered).toContain('--allow-over-budget was passed');
  });

  it('executes under "allow-fallback" and prints the overspend', async () => {
    const { adapter, registry } = harness();
    const result = await runTask({
      ...BASE,
      route: overBudgetPlan(),
      config: budgetConfig('allow-fallback'),
      registry,
      execute: true,
    });

    expect(result.refusal).toBeNull();
    expect(adapter.attempts).toBe(1);
    expect(result.overspend?.permittedBy).toBe('policy');
    expect(renderRun(result)).toContain('over budget');
  });

  it('does not let the flag outrank a policy of "stop"', async () => {
    // `stop` is the configuration saying no. A command-line flag is not the
    // place to overrule an administrator's decision about money.
    const { adapter, registry } = harness();
    const result = await runTask({
      ...BASE,
      route: overBudgetPlan(),
      config: budgetConfig('stop'),
      registry,
      execute: true,
      allowOverBudget: true,
    });

    expect(result.refusal).toBe('budget-exceeded');
    expect(adapter.attempts).toBe(0);
  });

  it('still produces a plan, with the marker, when not executing', async () => {
    const { adapter, registry } = harness();
    const result = await runTask({
      ...BASE,
      route: overBudgetPlan(),
      config: budgetConfig('stop'),
      registry,
    });

    expect(result.refusal).toBe('plan-only');
    expect(adapter.attempts).toBe(0);
    expect(renderRun(result)).toContain('over budget');
  });
});

describe('exit codes distinguish unverified from broken', () => {
  it('gives an unverified run its own code, not the error code', async () => {
    // EXIT_ERROR means the tool broke. A run that completed with nothing to
    // check it did not break, and a script told otherwise would treat a
    // missing test script as a RoutePilot fault.
    const result = await runTask({
      ...BASE,
      route: routeResult(),
      config: config(),
      registry: fakeRegistry(),
      execute: true,
    });

    expect(result.run?.outcome).toBe('unverified');
    expect(EXIT_UNVERIFIED).not.toBe(EXIT_ERROR);
    expect(EXIT_UNVERIFIED).not.toBe(EXIT_OK);
  });

  it('is non-zero, so a chained command does not act on unchecked work', () => {
    // `routepilot run --execute && deploy` must not deploy on work nobody
    // validated. That is the whole reason this is not EXIT_OK.
    expect(EXIT_UNVERIFIED).toBeGreaterThan(0);
  });

  it('is documented, so the contract stays scriptable', () => {
    const described = EXIT_CODE_DESCRIPTIONS.find(([code]) => code === EXIT_UNVERIFIED);
    expect(described?.[1]).toMatch(/nothing validated it/i);
  });
});
