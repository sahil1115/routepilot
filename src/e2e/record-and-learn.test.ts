/**
 * The closing of the loop (spec section 75).
 *
 * Section 75 ends with two steps that had never happened:
 *
 *   After completion: record models used, execution path, actual cost, latency,
 *   validation result, failure types, escalation, user outcome.
 *   Later: learn from the result.
 *
 * Every record *type* has existed since Phase 8 and the learning layer since
 * Phase 10, but nothing produced a record from a real run — the store was
 * written to only by its own tests, and the learning layer had never seen an
 * observation it did not synthesise. These tests hold the loop closed.
 *
 * They use a real SQLite store in a temporary directory, because the point is
 * that a run reaches the database. A fake store would prove the call was made,
 * which is the less interesting half.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentRegistry } from '../adapters/registry.js';
import { FakeAgentAdapter } from '../adapters/fake/adapter.js';
import { parseConfig } from '../config/schema.js';
import { runTask } from '../cli/run.js';
import { RoutingEngine } from '../core/routing/routing-engine.js';
import { ModelRegistry } from '../core/registry/model-registry.js';
import { TaskClassifier } from '../core/analysis/task-classifier.js';
import { NOT_ASSESSED } from '../core/calibration/gate.js';
import { stageTimings } from '../core/perf/timings.js';
import { openTelemetryStore, type LocalStore } from '../telemetry/open.js';
import type { RouteResult } from '../cli/route.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  policy,
} from '../test-support/routing-fixtures.js';

// All three tiers, as in section 75's own example. Two would not do: the
// router declines "Fix the authentication bug." on a cheap/medium ladder,
// correctly, because no candidate reaches the confidence threshold.
const MODELS = [cheapModel(), mediumModel(), frontierModel()];
const TASK = 'Fix the authentication bug.';

const dirs: string[] = [];
const stores: LocalStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10 })),
  );
});

function config(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  });
}

async function store(): Promise<LocalStore> {
  const dir = await mkdtemp(join(tmpdir(), 'routepilot-record-'));
  dirs.push(dir);
  const opened = await openTelemetryStore({ enabled: true, storagePath: dir });
  stores.push(opened);
  return opened;
}

function routeResult(): RouteResult {
  const registry = new ModelRegistry(MODELS);
  return {
    analysis: {
      classification: new TaskClassifier().classify({ prompt: TASK }),
      snapshot: undefined as unknown as RouteResult['analysis']['snapshot'],
      features: featuresFor(TASK),
      timings: { analysisMs: 0, featureExtractionMs: 0 },
    },
    decision: new RoutingEngine(registry).route({
      features: featuresFor(TASK),
      policy: policy(),
    }),
    calibration: NOT_ASSESSED,
    shadow: null,
    timings: stageTimings({ analysisMs: 0, featureExtractionMs: 0, routingMs: 0 }),
  };
}

function registry(): AgentRegistry {
  const agents = new AgentRegistry();
  agents.register(new FakeAgentAdapter());
  return agents;
}

const BASE = { workspaceRoot: '/workspace', task: TASK, env: {} as NodeJS.ProcessEnv };

describe('after completion, the run is recorded', () => {
  it('writes a request, a routing decision, an attempt and an outcome', async () => {
    const local = await store();

    await runTask({
      ...BASE,
      route: routeResult(),
      config: config(),
      registry: registry(),
      execute: true,
      store: local,
    });

    const stats = local.statistics();
    expect(stats.requests).toBe(1);
    expect(stats.attempts).toBeGreaterThan(0);
    expect(stats.outcomes).toBe(1);
  });

  it('records the models used and the actual cost, not the estimate', async () => {
    const local = await store();

    const result = await runTask({
      ...BASE,
      route: routeResult(),
      config: config(),
      registry: registry(),
      execute: true,
      store: local,
    });

    const recorded = local.recentOutcomes(10)[0];

    expect(recorded?.modelsUsed).toEqual(result.run?.attempts.map((a) => a.modelId));
    expect(recorded?.totalCost).toBe(result.run?.totalCost);
  });

  it('stores no prompt text anywhere in the database file', async () => {
    // The privacy contract, checked against the bytes on disk rather than
    // against the record type. A schema that promises not to hold the prompt
    // and a file that does not contain it are different claims, and only the
    // second one is worth anything.
    const dir = await mkdtemp(join(tmpdir(), 'routepilot-privacy-'));
    dirs.push(dir);
    const local = await openTelemetryStore({ enabled: true, storagePath: dir });

    await runTask({
      ...BASE,
      route: routeResult(),
      config: config(),
      registry: registry(),
      execute: true,
      store: local,
    });

    local.close();

    const bytes = await readFile(join(dir, 'routepilot.sqlite'));
    expect(bytes.includes(Buffer.from('authentication'))).toBe(false);
    expect(bytes.includes(Buffer.from(TASK))).toBe(false);
  });

  it('records nothing when no store is given', async () => {
    // Principle 17: telemetry off is a supported configuration. The assertion
    // is that the run still finishes, not that it finishes differently.
    const result = await runTask({
      ...BASE,
      route: routeResult(),
      config: config(),
      registry: registry(),
      execute: true,
    });

    expect(result.run?.outcome).toBe('succeeded');
  });

  it('does not fail the run when recording throws', async () => {
    // A task that already succeeded must not be reported as failed because a
    // database was unwritable. The reverse — a silent swallow — is why this
    // reports through `onProblem` rather than doing nothing.
    const problems: string[] = [];
    const broken = {
      ...(await store()),
      recordRequest: () => {
        throw new Error('disk full');
      },
    } as unknown as LocalStore;

    const result = await runTask({
      ...BASE,
      route: routeResult(),
      config: config(),
      registry: registry(),
      execute: true,
      store: broken,
      onProblem: (message) => problems.push(message),
    });

    expect(result.run?.outcome).toBe('succeeded');
    expect(problems.join(' ')).toContain('could not be recorded');
  });
});

describe('later, the result is learned from', () => {
  it('learns nothing from a run nobody validated, even with learning on', async () => {
    // The honest state of `routepilot run` today, and the reason it is worth a
    // test rather than a footnote.
    //
    // `run` configures no validation commands — there is no configuration
    // surface for them — so the run finishes unevaluated, and
    // `observationFromOutcome` refuses it. That refusal is correct: a task
    // nobody checked has an unknown outcome, and recording it as a success
    // because the process exited 0 is exactly how a learned model gets
    // poisoned.
    //
    // The consequence is that the loop section 75 describes is closed for
    // *recording* and still open for *learning*.
    const local = await store();

    await runTask({
      ...BASE,
      route: routeResult(),
      config: config({ learning: { enabled: true } }),
      registry: registry(),
      execute: true,
      store: local,
    });

    // Recorded, but not learned from.
    expect(local.statistics().outcomes).toBe(1);
    expect(local.loadLearnedStats()).toHaveLength(0);
  });

  it('learns from a run that was validated', async () => {
    // Proves the learning half of the wiring is sound, and that the gap above
    // is the missing validation rather than a broken learn path. Driven through
    // `TaskRunner` directly, because that is the level at which a validation
    // engine can be supplied at all today.
    const local = await store();

    const { TaskRunner } = await import('../core/run/task-runner.js');
    const { ValidationEngine } = await import('../core/execution/validation.js');
    const { LearnedSuccessModel } = await import('../core/learning/success-model.js');
    const { ScriptedCommandRunner, ScriptedExecutor, steppingClock } =
      await import('../test-support/e2e-fixtures.js');

    const models = new ModelRegistry(MODELS);
    const runner = new TaskRunner({
      models,
      router: new RoutingEngine(models),
      executor: new ScriptedExecutor({}),
      validation: new ValidationEngine({
        runner: new ScriptedCommandRunner([]),
        commands: { tests: { command: 'npm', args: ['run', 'test'] } },
      }),
      learned: new LearnedSuccessModel(local, { enabled: true, minimumTrainingSamples: 1 }),
      clock: steppingClock(),
    });

    await runner.run({
      requestId: 'validated',
      task: TASK,
      workspaceRoot: '/workspace',
      features: featuresFor(TASK),
      policy: policy(),
    });

    const stats = local.loadLearnedStats();
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.reduce((total, entry) => total + entry.observations, 0)).toBeGreaterThan(0);
  });

  it('records no observation when learning is disabled', async () => {
    // Principle 16, and the distinction that keeps "no data" honest: learning
    // off must mean nothing is written, not that something is written and
    // ignored.
    const local = await store();

    await runTask({
      ...BASE,
      route: routeResult(),
      config: config(),
      registry: registry(),
      execute: true,
      store: local,
    });

    expect(local.loadLearnedStats()).toHaveLength(0);
  });
});
