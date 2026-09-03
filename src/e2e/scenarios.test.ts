/**
 * End-to-end scenarios (spec section 68).
 *
 * Fourteen complete situations, each driven through the **whole** pipeline:
 * route, execute, monitor, validate, classify, escalate, score, learn. Nothing
 * is stubbed except the two edges RoutePilot does not own — the coding agent
 * and the shell — and both are scripted rather than mocked, so what is asserted
 * is behaviour and not a call count.
 *
 * These are the tests that would catch a regression no unit test can see: every
 * component in isolation can be correct while the pipeline built from them
 * escalates on a database outage or learns from a cancelled run.
 */

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../core/registry/model-registry.js';
import { RoutingEngine } from '../core/routing/routing-engine.js';
import { TaskRunner } from '../core/run/task-runner.js';
import { ValidationEngine } from '../core/execution/validation.js';
import { LearnedSuccessModel } from '../core/learning/success-model.js';
import { ShadowRouter } from '../core/shadow/shadow-router.js';
import { DEFAULT_SHADOW_POLICIES } from '../core/shadow/policies.js';
import type { RunResult } from '../core/types/run.js';
import type { RoutingPolicy } from '../core/types/routing.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  policy,
} from '../test-support/routing-fixtures.js';
import { InMemoryLearningStore, syntheticObservations } from '../test-support/learning-fixtures.js';
import {
  cancelled,
  environmentFailure,
  makesBadEdits,
  providerFailure,
  ScriptedCommandRunner,
  ScriptedExecutor,
  steppingClock,
  succeeds,
  type ScriptedRun,
} from '../test-support/e2e-fixtures.js';

const LADDER = [cheapModel(), mediumModel(), frontierModel()];

/** How a scenario is set up. */
interface ScenarioOptions {
  /** What each model does when asked to run. */
  scripts?: Record<string, ScriptedRun>;
  /** Validation commands that should fail. */
  failingChecks?: readonly string[];
  learned?: LearnedSuccessModel;
  models?: typeof LADDER;
  policyOverrides?: Partial<RoutingPolicy>;
  requestedModelId?: string;
}

/** Run one task through the full pipeline. */
async function run(
  task: string,
  options: ScenarioOptions = {},
): Promise<{ result: RunResult; executor: ScriptedExecutor }> {
  const models = new ModelRegistry(options.models ?? LADDER);
  const executor = new ScriptedExecutor(options.scripts ?? {});
  const commands = new ScriptedCommandRunner(options.failingChecks ?? []);

  const runner = new TaskRunner({
    models,
    router: new RoutingEngine(models, options.learned),
    executor,
    validation: new ValidationEngine({
      runner: commands,
      commands: {
        tests: { command: 'npm', args: ['run', 'test'] },
        build: { command: 'npm', args: ['run', 'build'] },
        lint: { command: 'npm', args: ['run', 'lint'] },
      },
    }),
    ...(options.learned === undefined ? {} : { learned: options.learned }),
    clock: steppingClock(),
  });

  const result = await runner.run({
    requestId: `req-${task.slice(0, 12)}`,
    task,
    workspaceRoot: '/workspace',
    features: featuresFor(task),
    // The configured default threshold, not a relaxed one. Lowering it here
    // would make the cheap model viable for tasks the scenarios expect to route
    // higher, and the tier assertions and the run assertions would then be
    // testing two different routers.
    policy: policy({ ...options.policyOverrides }),
    ...(options.requestedModelId === undefined
      ? {}
      : { requestedModelId: options.requestedModelId }),
  });

  return { result, executor };
}

/** The tier the router chose for a task, without running anything. */
function tierFor(task: string, overrides: Partial<RoutingPolicy> = {}): string | undefined {
  const models = new ModelRegistry(LADDER);
  const decision = new RoutingEngine(models).route({
    features: featuresFor(task),
    policy: policy(overrides),
  });
  return decision.evaluations.find((entry) => entry.modelId === decision.selectedModelId)?.tier;
}

// ===========================================================================
// 1-3: the routing ladder
// ===========================================================================

describe('SCENARIO 1 — "Rename this variable." routes to a cheap model', () => {
  it('chooses the cheap tier', () => {
    expect(tierFor('Rename this variable.')).toBe('cheap');
  });

  it('does so because it is the cheapest path to success, not because it is cheap', () => {
    // The distinction matters: the frontier model is also viable here, and is
    // rejected on expected cost rather than by a tier rule.
    const models = new ModelRegistry(LADDER);
    const decision = new RoutingEngine(models).route({
      features: featuresFor('Rename this variable.'),
      policy: policy(),
    });

    expect(decision.evaluations.every((entry) => entry.viable)).toBe(true);
    expect(decision.selectedModelId).toBe('acme/fast-1');
  });

  it('runs it and succeeds', async () => {
    const { result, executor } = await run('Rename this variable.');

    expect(result.outcome).toBe('succeeded');
    expect(executor.executedModelIds).toEqual(['acme/fast-1']);
    expect(result.escalations).toEqual([]);
  });
});

describe('SCENARIO 2 — "Add a standard REST endpoint." routes to a medium model', () => {
  it('chooses the medium tier', () => {
    expect(tierFor('Add a standard REST endpoint.')).toBe('medium');
  });

  it('rejects the cheap model on confidence, not on price', () => {
    // The cheap model is *cheaper* here and still loses: it falls below the
    // confidence threshold.
    const models = new ModelRegistry(LADDER);
    const decision = new RoutingEngine(models).route({
      features: featuresFor('Add a standard REST endpoint.'),
      policy: policy(),
    });
    const cheap = decision.evaluations.find((entry) => entry.modelId === 'acme/fast-1');

    expect(cheap?.cost.expectedTotalToSuccess).toBeLessThan(
      decision.evaluations.find((entry) => entry.modelId === decision.selectedModelId)?.cost
        .expectedTotalToSuccess ?? 0,
    );
    expect(cheap?.meetsThreshold).toBe(false);
  });

  it('runs it and succeeds', async () => {
    const { result, executor } = await run('Add a standard REST endpoint.');

    expect(result.outcome).toBe('succeeded');
    expect(executor.executedModelIds).toEqual(['acme/balanced-1']);
  });
});

describe('SCENARIO 3 — "Refactor authentication across the repository." routes higher', () => {
  it('chooses the frontier tier', () => {
    expect(tierFor('Refactor authentication across the repository.')).toBe('frontier');
  });

  it('leaves both cheaper models below the bar', () => {
    const models = new ModelRegistry(LADDER);
    const decision = new RoutingEngine(models).route({
      features: featuresFor('Refactor authentication across the repository.'),
      policy: policy(),
    });

    expect(decision.selectedModelId).toBe('acme/deep-1');
    expect(decision.evaluations.filter((entry) => entry.viable)).toHaveLength(1);
  });

  it('recognises the task as repository-wide and credential-touching', () => {
    // Both feed the risk score, and the hazard is what blocks exploration on a
    // task like this (Phase 13).
    const features = featuresFor('Refactor authentication across the repository.');

    expect(features.task.scope).toBe('repository-wide');
    expect(features.task.hazards).toContain('credentials');
  });
});

// ===========================================================================
// 4: escalation on model weakness
// ===========================================================================

describe('SCENARIO 4 — bad edits, failing tests, MODEL_WEAKNESS, escalation, success', () => {
  /** The cheap model breaks the tests; the medium model repairs them. */
  async function escalationRun() {
    const models = new ModelRegistry(LADDER);
    const commands = new ScriptedCommandRunner(['test']);
    const executor = new ScriptedExecutor({
      'acme/fast-1': makesBadEdits(),
      // When the stronger model runs, the tests start passing. This is how the
      // scenario expresses a repair rather than a coincidence.
      'acme/balanced-1': { ...succeeds(), afterExecute: () => commands.setFailing([]) },
    });

    const runner = new TaskRunner({
      models,
      router: new RoutingEngine(models),
      executor,
      validation: new ValidationEngine({
        runner: commands,
        commands: {
          tests: { command: 'npm', args: ['run', 'test'] },
          build: { command: 'npm', args: ['run', 'build'] },
        },
      }),
      clock: steppingClock(),
    });

    const task = 'Fix the failing session handling in the auth module';
    const result = await runner.run({
      requestId: 'req-escalate',
      task,
      workspaceRoot: '/workspace',
      features: featuresFor(task),
      policy: policy({ minimumSuccessProbability: 0.5 }),
    });

    return { result, executor };
  }

  it('starts on the cheap model', async () => {
    const { result } = await escalationRun();
    expect(result.attempts[0]?.modelId).toBe('acme/fast-1');
  });

  it('detects the failure through validation, not through the exit status', async () => {
    // The agent reported `completed`. Only running the tests reveals otherwise.
    const { result } = await escalationRun();
    const first = result.attempts[0];

    expect(first?.succeeded).toBe(false);
    expect(first?.failedChecks).toContain('tests');
  });

  it('classifies the failure as MODEL_WEAKNESS', async () => {
    const { result } = await escalationRun();
    expect(result.attempts[0]?.failureType).toBe('MODEL_WEAKNESS');
  });

  it('escalates vertically to a stronger model', async () => {
    const { result } = await escalationRun();

    expect(result.escalations[0]?.action).toBe('escalate-vertical');
    expect(result.escalations[0]?.toModelId).toBe('acme/balanced-1');
    expect(result.escalations[0]?.modelAttributable).toBe(true);
  });

  it('hands the stronger model a compact briefing, not a transcript', async () => {
    const { executor } = await escalationRun();
    const handoff = executor.handoffFor('acme/balanced-1');

    expect(handoff).toBeDefined();
    // It says what was tried and what is broken...
    expect(handoff).toContain('acme/fast-1');
    expect(handoff).toMatch(/tests/i);
    expect(handoff).toContain('src/auth/session.ts');
    // ...and stays short. A transcript would be orders of magnitude larger.
    expect((handoff ?? '').length).toBeLessThan(2_000);
  });

  it('succeeds on the second model', async () => {
    const { result, executor } = await escalationRun();

    expect(result.outcome).toBe('succeeded');
    expect(result.finalModelId).toBe('acme/balanced-1');
    expect(executor.executedModelIds).toEqual(['acme/fast-1', 'acme/balanced-1']);
  });

  it('reports the total cost of both attempts, not just the successful one', async () => {
    const { result } = await escalationRun();
    const first = result.attempts[0]?.cost ?? 0;

    expect(result.attempts).toHaveLength(2);
    expect(result.totalCost).toBeGreaterThan(first);
  });
});

// ===========================================================================
// 5: environment failure
// ===========================================================================

describe('SCENARIO 5 — the database is down: ENVIRONMENT_FAILURE, no escalation', () => {
  const scripts = {
    'acme/fast-1': environmentFailure('could not connect to postgres at localhost:5432'),
    'acme/balanced-1': environmentFailure('could not connect to postgres at localhost:5432'),
    'acme/deep-1': environmentFailure('could not connect to postgres at localhost:5432'),
  };

  it('classifies it as ENVIRONMENT_FAILURE', async () => {
    const { result } = await run('Rename this variable.', { scripts });
    expect(result.attempts[0]?.failureType).toBe('ENVIRONMENT_FAILURE');
  });

  it('does NOT escalate to a more expensive model', async () => {
    // The whole point. A stronger model cannot start a database, and buying one
    // to try is the exact waste the failure taxonomy exists to prevent.
    const { result, executor } = await run('Rename this variable.', { scripts });

    expect(executor.executedModelIds).not.toContain('acme/balanced-1');
    expect(executor.executedModelIds).not.toContain('acme/deep-1');
    expect(result.escalations.every((entry) => entry.action !== 'escalate-vertical')).toBe(true);
  });

  it('does not treat the failure as the model’s fault', async () => {
    const { result } = await run('Rename this variable.', { scripts });

    for (const escalation of result.escalations) {
      expect(escalation.modelAttributable).toBe(false);
    }
  });

  it('stops or asks rather than looping', async () => {
    const { result } = await run('Rename this variable.', { scripts });
    expect(['stopped', 'needs-clarification', 'failed']).toContain(result.outcome);
  });
});

// ===========================================================================
// 6: provider unavailable
// ===========================================================================

describe('SCENARIO 6 — provider unavailable: retry then fall back', () => {
  const scripts = {
    'acme/fast-1': providerFailure('503 from the provider gateway', 3),
    'acme/balanced-1': succeeds(),
  };

  it('classifies it as PROVIDER_FAILURE', async () => {
    const { result } = await run('Rename this variable.', { scripts });
    expect(result.attempts[0]?.failureType).toBe('PROVIDER_FAILURE');
  });

  it('does not blame the model for the provider being down', async () => {
    const { result } = await run('Rename this variable.', { scripts });

    for (const escalation of result.escalations) {
      expect(escalation.modelAttributable).toBe(false);
    }
  });

  it('moves on rather than stopping the task outright', async () => {
    // A provider outage is recoverable by going elsewhere, unlike a database
    // being down, so the run should continue rather than give up.
    const { result } = await run('Rename this variable.', { scripts });

    expect(result.escalations.length).toBeGreaterThan(0);
    expect(['retry', 'provider-fallback', 'escalate-vertical', 'escalate-horizontal']).toContain(
      result.escalations[0]?.action,
    );
  });
});

// ===========================================================================
// 7: context too large
// ===========================================================================

describe('SCENARIO 7 — context too large: a model that fits is chosen', () => {
  it('excludes models whose window is too small, before scoring', () => {
    const models = new ModelRegistry(LADDER);
    const decision = new RoutingEngine(models).route({
      // 600k tokens: past the cheap (200k) and medium (500k) windows.
      features: featuresFor('Rename this variable.', { contextTokens: 600_000 }),
      policy: policy({ minimumSuccessProbability: 0.5 }),
    });

    const excludedIds = decision.excluded.map((entry) => entry.modelId);
    expect(excludedIds).toContain('acme/fast-1');
    expect(excludedIds).toContain('acme/balanced-1');
    expect(decision.selectedModelId).toBe('acme/deep-1');
  });

  it('names the window as the reason, so the user can act on it', () => {
    const models = new ModelRegistry(LADDER);
    const decision = new RoutingEngine(models).route({
      features: featuresFor('Rename this variable.', { contextTokens: 600_000 }),
      policy: policy({ minimumSuccessProbability: 0.5 }),
    });

    const excluded = decision.excluded.find((entry) => entry.modelId === 'acme/fast-1');
    expect(excluded?.reason).toBe('CONTEXT_WINDOW_TOO_SMALL');
    expect(excluded?.detail).toMatch(/context window/i);
  });

  it('runs on the larger model', async () => {
    const models = new ModelRegistry(LADDER);
    const executor = new ScriptedExecutor({});
    const runner = new TaskRunner({
      models,
      router: new RoutingEngine(models),
      executor,
      clock: steppingClock(),
    });

    const result = await runner.run({
      requestId: 'req-context',
      task: 'Rename this variable.',
      workspaceRoot: '/workspace',
      features: featuresFor('Rename this variable.', { contextTokens: 600_000 }),
      policy: policy({ minimumSuccessProbability: 0.5 }),
    });

    expect(result.outcome).toBe('succeeded');
    expect(executor.executedModelIds).toEqual(['acme/deep-1']);
  });

  it('stops safely when nothing has a large enough window', () => {
    const models = new ModelRegistry([cheapModel()]);
    const decision = new RoutingEngine(models).route({
      features: featuresFor('Rename this variable.', { contextTokens: 5_000_000 }),
      policy: policy(),
    });

    expect(decision.selectedModelId).toBeNull();
    expect(decision.evaluations).toHaveLength(0);
  });
});

// ===========================================================================
// 8: budget exceeded
// ===========================================================================

describe('SCENARIO 8 — budget exceeded: a safe stop', () => {
  it('selects nothing and does not run', async () => {
    const { result, executor } = await run('Refactor authentication across the repository.', {
      policyOverrides: { requestBudget: 0.0001, onBudgetExceeded: 'stop' },
    });

    expect(result.outcome).toBe('no-model');
    expect(result.finalModelId).toBeNull();
    expect(executor.executedModelIds).toEqual([]);
  });

  it('spends nothing', async () => {
    const { result } = await run('Refactor authentication across the repository.', {
      policyOverrides: { requestBudget: 0.0001, onBudgetExceeded: 'stop' },
    });

    expect(result.totalCost).toBe(0);
  });

  it('explains that the budget was the constraint', async () => {
    const { result } = await run('Refactor authentication across the repository.', {
      policyOverrides: { requestBudget: 0.0001, onBudgetExceeded: 'stop' },
    });

    expect(result.reason).toMatch(/budget/i);
  });

  it('never silently exceeds the budget', async () => {
    // Architectural principle 7. The alternative to stopping is asking, and it
    // is never spending anyway.
    const { result, executor } = await run('Refactor authentication across the repository.', {
      policyOverrides: { requestBudget: 0.0001, onBudgetExceeded: 'ask' },
    });

    expect(executor.executedModelIds).toEqual([]);
    expect(result.outcome).toBe('needs-clarification');
  });
});

// ===========================================================================
// 9: explicit model selection
// ===========================================================================

describe('SCENARIO 9 — the user picked a model: the selection is honoured', () => {
  it('runs the requested model even when the router would choose another', async () => {
    // The router would pick the cheap model for a rename.
    const { result, executor } = await run('Rename this variable.', {
      requestedModelId: 'acme/deep-1',
    });

    expect(result.decision.outcome).toBe('selected-explicit');
    expect(executor.executedModelIds).toEqual(['acme/deep-1']);
    expect(result.outcome).toBe('succeeded');
  });

  it('says the choice was the user’s', async () => {
    const { result } = await run('Rename this variable.', { requestedModelId: 'acme/deep-1' });
    expect(result.decision.reason).toMatch(/explicitly requested/i);
  });

  it('never silently substitutes another model', async () => {
    // Architectural principle 8.
    const { result, executor } = await run('Rename this variable.', {
      requestedModelId: 'acme/balanced-1',
    });

    expect(result.decision.overrodeExplicitRequest).toBe(false);
    expect(executor.executedModelIds).toEqual(['acme/balanced-1']);
  });

  it('reports an unknown model rather than choosing something else', async () => {
    const { result, executor } = await run('Rename this variable.', {
      requestedModelId: 'acme/does-not-exist',
    });

    expect(result.decision.outcome).toBe('explicit-model-unknown');
    expect(executor.executedModelIds).toEqual([]);
  });
});

// ===========================================================================
// 10-11: learning off, then on
// ===========================================================================

describe('SCENARIO 10 — learning disabled: the static router works', () => {
  it('routes and runs with no learned data at all', async () => {
    const { result, executor } = await run('Add a standard REST endpoint.');

    expect(result.outcome).toBe('succeeded');
    expect(executor.executedModelIds).toEqual(['acme/balanced-1']);
  });

  it('reports every estimate as a configured prior', async () => {
    const { result } = await run('Add a standard REST endpoint.');

    for (const candidate of result.decision.evaluations) {
      expect(candidate.learningApplied).toBe(false);
      expect(candidate.observations).toBe(0);
      expect(candidate.successProbability).toBe(candidate.staticSuccessProbability);
    }
  });

  it('is the default: nothing has to be switched off', async () => {
    // The system must be fully usable with learning disabled
    // (architectural principle 16).
    const { result } = await run('Rename this variable.');
    expect(result.outcome).toBe('succeeded');
  });
});

describe('SCENARIO 11 — learning enabled: history changes the route', () => {
  /** A learned model in which the medium model has proved unreliable. */
  function trained(): LearnedSuccessModel {
    const store = new InMemoryLearningStore();
    const learningPolicy = { enabled: true, minimumTrainingSamples: 20 };
    const trainer = new LearnedSuccessModel(store, learningPolicy);
    trainer.observeAll(
      syntheticObservations('acme/balanced-1', 60, {
        rate: 0.2,
        taskType: 'feature-implementation',
        scope: 'few-files',
      }),
      1_000,
    );
    return new LearnedSuccessModel(store, learningPolicy);
  }

  it('routes elsewhere once the usual choice has proved unreliable', async () => {
    const withoutHistory = await run('Add a standard REST endpoint.');
    const withHistory = await run('Add a standard REST endpoint.', { learned: trained() });

    expect(withoutHistory.executor.executedModelIds).toEqual(['acme/balanced-1']);
    expect(withHistory.executor.executedModelIds).not.toEqual(['acme/balanced-1']);
  });

  it('reports the estimate as learned, with the real observation count', async () => {
    const { result } = await run('Add a standard REST endpoint.', { learned: trained() });
    const balanced = result.decision.evaluations.find(
      (entry) => entry.modelId === 'acme/balanced-1',
    );

    expect(balanced?.learningApplied).toBe(true);
    expect(balanced?.observations).toBe(60);
    expect(balanced?.successProbability).toBeLessThan(balanced?.staticSuccessProbability ?? 1);
  });

  it('records a new observation after a successful run', async () => {
    const store = new InMemoryLearningStore();
    const learningPolicy = { enabled: true, minimumTrainingSamples: 20 };
    const learned = new LearnedSuccessModel(store, learningPolicy);
    const before = learned.totalObservations;

    await run('Rename this variable.', { learned });

    expect(learned.totalObservations).toBe(before + 1);
  });
});

// ===========================================================================
// 12: shadow policy
// ===========================================================================

describe('SCENARIO 12 — a shadow policy predicts without executing', () => {
  it('names a different model without running it', () => {
    const models = new ModelRegistry(LADDER);
    const comparison = new ShadowRouter(models).compare({
      features: featuresFor('Rename this variable.'),
      policy: policy({ minimumSuccessProbability: 0.5 }),
      shadowPolicies: DEFAULT_SHADOW_POLICIES,
    });

    const strongest = comparison.shadows.find((entry) => entry.policyId === 'strongest-first');
    expect(comparison.current.selectedModelId).toBe('acme/fast-1');
    expect(strongest?.selectedModelId).toBe('acme/deep-1');
  });

  it('sends no request for the shadow model, through the full runner', async () => {
    // The guarantee, asserted where it matters: after a complete run, the only
    // model any executor was handed is the one the live policy chose.
    const models = new ModelRegistry(LADDER);
    const executor = new ScriptedExecutor({});

    const comparison = new ShadowRouter(models).compare({
      features: featuresFor('Rename this variable.'),
      policy: policy({ minimumSuccessProbability: 0.5 }),
      shadowPolicies: DEFAULT_SHADOW_POLICIES,
    });

    const runner = new TaskRunner({
      models,
      router: new RoutingEngine(models),
      executor,
      clock: steppingClock(),
    });
    await runner.run({
      requestId: 'req-shadow',
      task: 'Rename this variable.',
      workspaceRoot: '/workspace',
      features: featuresFor('Rename this variable.'),
      policy: policy({ minimumSuccessProbability: 0.5 }),
    });

    const shadowChoices = comparison.shadows
      .map((entry) => entry.selectedModelId)
      .filter((id): id is string => id !== null && id !== comparison.current.selectedModelId);

    expect(shadowChoices).toContain('acme/deep-1');
    expect(executor.executedModelIds).toEqual(['acme/fast-1']);
  });
});

// ===========================================================================
// 13: user cancellation
// ===========================================================================

describe('SCENARIO 13 — the user cancels: USER_CANCELLED, and nothing is learned', () => {
  const scripts = { 'acme/fast-1': cancelled() };

  it('classifies it as USER_CANCELLED', async () => {
    const { result } = await run('Rename this variable.', { scripts });
    expect(result.attempts[0]?.failureType).toBe('USER_CANCELLED');
  });

  it('ends the run rather than escalating', async () => {
    // Cancelling means "stop", not "try harder". Escalating would spend money
    // the user just declined to spend.
    const { result, executor } = await run('Rename this variable.', { scripts });

    expect(result.outcome).toBe('cancelled');
    expect(result.escalations).toEqual([]);
    expect(executor.executedModelIds).toEqual(['acme/fast-1']);
  });

  it('records NO negative observation about the model', async () => {
    // Spec section 32, explicitly. A user may cancel because they changed their
    // mind, got interrupted, or realised the task was wrong — none of which is
    // evidence about the model.
    const store = new InMemoryLearningStore();
    const learned = new LearnedSuccessModel(store, {
      enabled: true,
      minimumTrainingSamples: 1,
    });

    await run('Rename this variable.', { scripts, learned });

    expect(learned.totalObservations).toBe(0);
    expect(store.loadLearnedStats()).toEqual([]);
  });

  it('does not score a cancelled run as a failure', async () => {
    const { result } = await run('Rename this variable.', { scripts });

    // `null` means not evaluated. Zero would mean the model failed.
    expect(result.score?.score).toBeNull();
    expect(result.score?.modelAttributable).toBe(false);
  });
});

// ===========================================================================
// 14: ambiguous requirement
// ===========================================================================

describe('SCENARIO 14 — an ambiguous requirement asks the user', () => {
  const AMBIGUOUS = 'make it better';

  it('detects the ambiguity', () => {
    const features = featuresFor(AMBIGUOUS);
    expect(features.task.ambiguity).toBeGreaterThan(0.6);
  });

  it('asks rather than guessing when the run then fails', async () => {
    // An ambiguous task that fails is much more likely to be an unclear request
    // than a weak model, and spending on a stronger one would not fix it
    // (spec section 26).
    const { result } = await run(AMBIGUOUS, {
      scripts: { 'acme/fast-1': makesBadEdits(), 'acme/balanced-1': makesBadEdits() },
      failingChecks: ['test'],
    });

    expect(result.attempts[0]?.failureType).toBe('USER_AMBIGUITY');
  });

  it('does not blame the model for an unclear request', async () => {
    const { result } = await run(AMBIGUOUS, {
      scripts: { 'acme/fast-1': makesBadEdits() },
      failingChecks: ['test'],
    });

    for (const escalation of result.escalations) {
      expect(escalation.modelAttributable).toBe(false);
    }
  });

  it('surfaces a question for the user', async () => {
    const { result } = await run(AMBIGUOUS, {
      scripts: { 'acme/fast-1': makesBadEdits() },
      failingChecks: ['test'],
    });

    expect(result.outcome).toBe('needs-clarification');
    expect(result.question).not.toBeNull();
  });
});
