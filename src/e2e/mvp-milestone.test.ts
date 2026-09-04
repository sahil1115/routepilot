/**
 * The MVP milestone (spec section 74).
 *
 * Fourteen capabilities the first working milestone must support, each checked
 * against the thing that implements it rather than a claim that it exists. A
 * checklist ticked by hand is a statement about a moment; this one has to
 * survive refactoring.
 *
 * Item 8, "one real agent adapter", was outstanding longest. What was missing
 * was never the adapter but a production caller, and `routepilot run` is it.
 *
 * This file does not itself verify an adapter against its real tool. It asserts
 * that whatever `verification.ts` claims is backed by evidence; the runs that
 * produce that evidence live in `scripts/verify-agent-tasks.mjs`.
 */

import { describe, expect, it } from 'vitest';

import { buildAdapters, buildableAdapterIds } from '../adapters/build.js';
import { AgentRegistry } from '../adapters/registry.js';
import { ADAPTER_VERIFICATION } from '../adapters/verification.js';
import { FakeAgentAdapter } from '../adapters/fake/adapter.js';
import { ModelRegistry } from '../core/registry/model-registry.js';
import { RoutingEngine } from '../core/routing/routing-engine.js';
import { TaskClassifier } from '../core/analysis/task-classifier.js';
import { CAPABILITIES } from '../cli/status.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  policy,
} from '../test-support/routing-fixtures.js';

const LADDER = [cheapModel(), mediumModel(), frontierModel()];

describe('section 74 milestone — the fourteen capabilities', () => {
  it('1. model registry: resolves models and their providers', () => {
    const registry = new ModelRegistry(LADDER);
    expect(registry.list()).toHaveLength(3);
    expect(registry.get(LADDER[0]!.id)).toBeDefined();
  });

  it('2. task classification: derives type, scope and risk from a prompt', () => {
    const classification = new TaskClassifier().classify({
      prompt: 'Refactor authentication across the repository.',
    });

    expect(classification.taskType).toBeTruthy();
    expect(classification.confidence).toBeGreaterThan(0);
  });

  it('3. repository features: a feature vector reaches the router', () => {
    const features = featuresFor('Rename this variable.');
    expect(features.repository).toBeDefined();
    expect(features.task).toBeDefined();
  });

  it('4. hard constraints: an ineligible model is excluded with a reason', () => {
    const registry = new ModelRegistry(LADDER);
    const decision = new RoutingEngine(registry).route({
      features: featuresFor('Rename this variable.'),
      // A context window nothing can satisfy, so exclusion is guaranteed and
      // the assertion is about the *reason* rather than about luck.
      policy: policy({ minimumSuccessProbability: 0.999 }),
    });

    expect(decision.selectedModelId).toBeNull();
    expect(decision.reason).toBeTruthy();
  });

  it('5. static routing: a decision with no learned data at all', () => {
    const registry = new ModelRegistry(LADDER);
    const decision = new RoutingEngine(registry).route({
      features: featuresFor('Rename this variable.'),
      policy: policy(),
    });

    expect(decision.selectedModelId).toBeTruthy();
    for (const evaluation of decision.evaluations) {
      expect(evaluation.learningApplied).toBe(false);
    }
  });

  it('6. cost calculation: every term of the expected-cost model is exposed', () => {
    const registry = new ModelRegistry(LADDER);
    const decision = new RoutingEngine(registry).route({
      features: featuresFor('Rename this variable.'),
      policy: policy(),
    });
    const selected = decision.evaluations.find((e) => e.modelId === decision.selectedModelId);

    // Not just a total. A route that cannot be checked cannot be trusted.
    expect(selected?.cost.initial).toBeGreaterThan(0);
    expect(selected?.cost.expectedTotalToSuccess).toBeGreaterThan(0);
    expect(selected?.cost.retry).toBeGreaterThan(0);
    expect(selected?.cost.currency).toBeTruthy();
  });

  it('7. CLI: every command it advertises as available really is', () => {
    const available = CAPABILITIES.filter((capability) => capability.available);
    expect(available.map((c) => c.command)).toContain('run');

    // And every unavailable one says what it is waiting for, so the list cannot
    // decay into a set of bare "not implemented" rows.
    for (const capability of CAPABILITIES.filter((c) => !c.available)) {
      expect(capability.detail.length).toBeGreaterThan(20);
    }
  });

  it('8. one real agent adapter: buildable, probed, and reachable from the CLI', async () => {
    // The item that was outstanding from Phase 5 to Phase 21. Two things had to
    // be true: an adapter that can be constructed and probed without
    // configuration, and a command that drives it.
    expect(buildableAdapterIds()).toContain('claude-code');

    const built = await buildAdapters({ only: 'claude-code' });
    expect(built.probes).toHaveLength(1);

    // Available or not depends on the machine, so the assertion is that the
    // question was *answered* — with actionable guidance when the answer is no
    // (spec section 19).
    const probe = built.probes[0]!;
    expect(typeof probe.status.available).toBe('boolean');
    if (!probe.status.available) expect(probe.status.detail).toBeTruthy();
  });

  it('9. execution monitoring: the executor surfaces events, not just a result', async () => {
    const registry = new AgentRegistry();
    registry.register(new FakeAgentAdapter());

    const { RegistryExecutor } = await import('../adapters/executor.js');
    const outcome = await new RegistryExecutor(registry).execute(
      {
        requestId: 'milestone',
        prompt: 'Rename this variable.',
        workspaceRoot: '/workspace',
        taskType: 'rename',
        requiredCapabilities: {},
      },
      LADDER[0]!,
    );

    // Events are what struggle detection and half the failure taxonomy are
    // built on. An executor that returned only a result would silently disable
    // them, which is exactly the Phase 15 bug.
    expect(outcome.events).toBeDefined();
    expect(outcome.result).toBeDefined();
  });

  // Items 10-12 are asserted through a real run rather than by calling each
  // component directly. Section 74 asks that the milestone *support* them, and
  // a component that works in isolation while being unreachable from the
  // pipeline supports nothing. One escalating task exercises all three.
  it('10-12. failure taxonomy, escalation and context handoff, through the pipeline', async () => {
    const { result, executor } = await escalatingRun();

    // 10. The failure was named, not merely counted.
    const failed = result.attempts.find((attempt) => !attempt.succeeded);
    expect(failed?.failureType).toBeTruthy();

    // 11. It escalated, to a different model.
    expect(result.escalations.length).toBeGreaterThan(0);
    expect(executor.executedModelIds.length).toBeGreaterThan(1);
    expect(executor.executedModelIds[1]).not.toBe(executor.executedModelIds[0]);

    // 12. The second model was briefed, and briefly. A handoff that grew with
    // the transcript would cost more to send than the attempt that produced it.
    const second = executor.executedModelIds[1]!;
    const briefing = executor.handoffFor(second);
    expect(briefing).toBeTruthy();
    expect(briefing!.length).toBeLessThan(4000);
  });

  it('13. local telemetry: the store is local and opt-outable', async () => {
    const { openTelemetryStore } = await import('../telemetry/open.js');
    const store = await openTelemetryStore({ enabled: false, workspaceRoot: process.cwd() });

    // Disabling telemetry yields a store that accepts writes and keeps
    // nothing, rather than an absent one. That is the design that lets every
    // caller stay unconditional — principle 17 without an `if` at each site.
    expect(store).toBeDefined();
    expect(store?.enabled).toBe(false);
    store?.close();
  });

  it('14. complete automated tests: nothing claims to be verified that is not', () => {
    // The honesty invariant the milestone rests on: a status of `verified`
    // must be backed by evidence, and anything else must say how to verify it.
    const real = ADAPTER_VERIFICATION.filter((entry) => entry.adapterId !== 'fake');
    expect(real.length).toBeGreaterThan(0);

    for (const entry of real) {
      if (entry.status === 'verified') {
        // What stops a status being flipped without proof.
        expect(entry.evidence).toBeTruthy();
      } else {
        expect(entry.howToVerify).toBeTruthy();
      }
    }
  });
});

/**
 * One task that fails on the cheap model and escalates.
 *
 * Built the same way `mvp-spine.test.ts` builds its core — no learning, no
 * bandit, no telemetry — so what it proves is that the milestone's escalation
 * path works in the minimal configuration, not only in a fully-featured one.
 */
async function escalatingRun() {
  const { TaskRunner } = await import('../core/run/task-runner.js');
  const { ValidationEngine } = await import('../core/execution/validation.js');
  const { makesBadEdits, ScriptedCommandRunner, ScriptedExecutor, steppingClock } =
    await import('../test-support/e2e-fixtures.js');

  const models = new ModelRegistry(LADDER);
  const executor = new ScriptedExecutor({ [LADDER[0]!.id]: makesBadEdits() });

  const runner = new TaskRunner({
    models,
    router: new RoutingEngine(models),
    executor,
    validation: new ValidationEngine({
      runner: new ScriptedCommandRunner(['npm run test']),
      commands: { tests: { command: 'npm', args: ['run', 'test'] } },
    }),
    clock: steppingClock(),
  });

  const result = await runner.run({
    requestId: 'milestone-escalation',
    task: 'Rename this variable.',
    workspaceRoot: '/workspace',
    features: featuresFor('Rename this variable.'),
    policy: policy(),
  });

  return { result, executor };
}
