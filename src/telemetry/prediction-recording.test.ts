/**
 * Scoring a prediction against what actually happened.
 *
 * A defect found by review and reproduced here before it was fixed.
 *
 * Phase 11 built a calibration safeguard: score each learned success
 * probability against the outcome it produced, and withdraw the learned model
 * when its probabilities are measurably wrong. `predictionFromDecision` builds
 * the pairs and `recordPredictions` stores them, both fully tested since.
 *
 * **Neither had a production caller.** A whole-repository search outside tests
 * found the function definition, the interface declaration and the two store
 * implementations, and nothing that called either. So
 * `loadPredictions(2000, 'learned')` in `cli/route.ts` always returned an empty
 * set, the gate always returned `NOT_ASSESSED`, and `routepilot calibration`
 * could only ever print "no predictions have been scored yet". The safeguard
 * could not fire, and nothing said so.
 *
 * The seventh instance of "declared, plumbed, never set" in this repository,
 * after `permissionMode`, `allowFallback`, `maxEscalationsPerTask`,
 * `repositoryBrokenBeforeRun`, `userAccepted` and the cost-calibration store
 * gate. Every unit test passed throughout, which is the point: the missing
 * thing was a *call*, and only a test that exercises the production entry point
 * or reads the source can see one of those.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { ModelRegistry } from '../core/registry/model-registry.js';
import { OutcomeRecorder, emptyOutcome } from '../core/outcome/outcome-recorder.js';
import { RoutingEngine } from '../core/routing/routing-engine.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  policy,
} from '../test-support/routing-fixtures.js';
import type { RoutingDecision } from '../core/types/routing.js';
import type { RunResult } from '../core/types/run.js';
import type { TaskOutcome } from '../core/types/outcome.js';
import { observationFromOutcome } from '../core/learning/success-model.js';
import { predictionFromDecision } from '../core/calibration/tracking.js';
import { openTelemetryStore, type LocalStore } from './open.js';
import { recordRun } from './recorder.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASK = 'Fix the authentication bug.';
// All three tiers. On a cheap/medium ladder the router declines this task
// outright -- no candidate reaches the confidence threshold -- and a decision
// that selected nothing has no prediction to score.
const MODELS = [cheapModel(), mediumModel(), frontierModel()];

const dirs: string[] = [];
const stores: LocalStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10 })),
  );
});

/** A real SQLite store, because the point is that a prediction reaches the database. */
async function store(): Promise<LocalStore> {
  const dir = await mkdtemp(join(tmpdir(), 'routepilot-prediction-'));
  dirs.push(dir);
  const opened = await openTelemetryStore({ enabled: true, storagePath: dir });
  stores.push(opened);
  return opened;
}

function decision(): RoutingDecision {
  return new RoutingEngine(new ModelRegistry(MODELS)).route({
    features: featuresFor(TASK),
    policy: policy(),
  });
}

/**
 * A finished run carrying the evidence a caller chooses.
 *
 * Built rather than executed because the question here is what `recordRun`
 * does with an outcome, not how the outcome was reached. `e2e/record-and-learn`
 * covers the executed path.
 */
function finishedRun(overrides: Partial<TaskOutcome> = {}): RunResult {
  const chosen = decision();
  const modelId = chosen.selectedModelId ?? cheapModel().id;
  const signals = emptyOutcome('prediction-recording', {
    taskType: 'bug-fix',
    modelsUsed: [modelId],
    totalCost: 0.01,
    ...overrides,
  });

  return {
    requestId: 'prediction-recording',
    outcome: 'succeeded',
    decision: chosen,
    attempts: [],
    escalations: [],
    finalModelId: modelId,
    totalCost: 0.01,
    score: new OutcomeRecorder().score(signals),
    signals,
    question: null,
    reason: 'recorded for calibration',
  };
}

describe('a completed run is scored against what it predicted', () => {
  it('writes a prediction record a real run can be calibrated from', async () => {
    // The defect. Everything below it was already true; nothing produced one.
    const local = await store();

    recordRun({
      store: local,
      requestId: 'prediction-recording',
      prompt: TASK,
      workspaceRoot: '/workspace',
      features: featuresFor(TASK),
      run: finishedRun({ testsPassed: true, buildPassed: true }),
    });

    expect(local.loadPredictions(10)).toHaveLength(1);
  });

  it('pairs the probability the router acted on with the outcome it got', async () => {
    // A record with the wrong prediction in it is worse than none: calibration
    // would report a number computed from something the router never claimed.
    const local = await store();
    const run = finishedRun({ testsPassed: true, buildPassed: true });

    recordRun({
      store: local,
      requestId: 'prediction-recording',
      prompt: TASK,
      workspaceRoot: '/workspace',
      features: featuresFor(TASK),
      run,
    });

    const recorded = local.loadPredictions(10)[0];
    const evaluation = run.decision.evaluations.find(
      (candidate) => candidate.modelId === run.decision.selectedModelId,
    );

    expect(recorded?.predicted).toBe(evaluation?.successProbability);
    expect(recorded?.actual).toBe(run.score?.score);
    expect(recorded?.modelId).toBe(run.decision.selectedModelId);
  });

  it('records nothing from a run only a typecheck vouched for', async () => {
    // The Phase 27 rule has to hold on this path too. Calibration and learning
    // read the same evidence, so admitting here what learning refuses would let
    // hygiene-only runs back in through a side door.
    const local = await store();

    recordRun({
      store: local,
      requestId: 'prediction-recording',
      prompt: TASK,
      workspaceRoot: '/workspace',
      features: featuresFor(TASK),
      run: finishedRun({ syntaxValid: true }),
    });

    expect(local.loadPredictions(10)).toHaveLength(0);
  });

  it('records nothing from a run nothing evaluated', async () => {
    const local = await store();

    recordRun({
      store: local,
      requestId: 'prediction-recording',
      prompt: TASK,
      workspaceRoot: '/workspace',
      features: featuresFor(TASK),
      run: finishedRun(),
    });

    expect(local.loadPredictions(10)).toHaveLength(0);
  });

  it('records nothing from a task that took more than one model', async () => {
    // Unchanged, and asserted here because wiring this path is exactly when an
    // existing refusal is easiest to lose.
    const local = await store();

    recordRun({
      store: local,
      requestId: 'prediction-recording',
      prompt: TASK,
      workspaceRoot: '/workspace',
      features: featuresFor(TASK),
      run: finishedRun({
        testsPassed: true,
        escalationCount: 1,
        modelsUsed: [cheapModel().id, mediumModel().id],
      }),
    });

    expect(local.loadPredictions(10)).toHaveLength(0);
  });

  it('still records the run when the store cannot take predictions', async () => {
    // A `TelemetryStore` that is not also a `PredictionStore` is a supported
    // caller. Predictions are an addition to recording, never a precondition
    // for it.
    const local = await store();
    // Delegates every telemetry method and offers no `recordPredictions`.
    // Spreading the instance would not do: its methods live on the prototype.
    const withoutPredictions = {
      recordRequest: local.recordRequest.bind(local),
      recordRouting: local.recordRouting.bind(local),
      recordAttempt: local.recordAttempt.bind(local),
      recordEscalation: local.recordEscalation.bind(local),
      recordEvents: local.recordEvents.bind(local),
      recordOutcome: local.recordOutcome.bind(local),
      recordUserSignal: local.recordUserSignal.bind(local),
    };

    recordRun({
      store: withoutPredictions as unknown as LocalStore,
      requestId: 'prediction-recording',
      prompt: TASK,
      workspaceRoot: '/workspace',
      features: featuresFor(TASK),
      run: finishedRun({ testsPassed: true }),
    });

    expect(local.statistics().outcomes).toBe(1);
  });
});

describe('the wiring that feeds calibration cannot rot silently', () => {
  it('the recorder calls the tracking helper', async () => {
    // Asserted against the source, because the defect was the absence of a
    // call. Every behavioural test in this file passed for six phases while
    // nothing invoked the path they cover -- `cost-calibration.test.ts` holds
    // the CLI's store wiring to the same standard for the same reason.
    const source = await readFile(join(root, 'src', 'telemetry', 'recorder.ts'), 'utf8');

    expect(source).toContain('predictionFromDecision');
    expect(source).toContain('recordPredictions');
  });
});

describe('the two admission gates agree', () => {
  /**
   * Learning and calibration read the same evidence and must refuse the same
   * runs. They were written that way, and `tracking.ts` said so in a comment --
   * which is exactly what rotted: Phase 27 added a rule to learning and not to
   * calibration, and nothing failed. This asserts the parity instead of
   * describing it.
   *
   * Not a claim that the two must always be identical. If they ever diverge on
   * purpose, this test is where that decision gets written down.
   */
  const CASES: readonly [string, Partial<TaskOutcome>][] = [
    ['a passing test suite', { testsPassed: true }],
    ['a failing test suite', { testsPassed: false }],
    ['a passing build with no tests', { buildPassed: true }],
    ['a typecheck alone', { syntaxValid: true }],
    ['lint alone', { lintPassed: true }],
    ['hygiene only, both passing', { syntaxValid: true, lintPassed: true }],
    // The case with teeth. Hygiene alone scores 0.15 of the weight table and is
    // already refused by MINIMUM_EVIDENCE, so it cannot tell the gates apart.
    // Add an accepting user and the evidence reaches 0.3 -- over the floor,
    // with no build or test verdict behind it. Only the substantive-check rule
    // refuses this, so it is the row that fails if the two gates drift again.
    ['hygiene plus an accepting user', { syntaxValid: true, lintPassed: true, userAccepted: true }],
    ['nothing evaluated', {}],
    ['a provider outage', { testsPassed: true, failureType: 'PROVIDER_FAILURE' }],
    ['a cancelled run', { testsPassed: true, userCancelled: true }],
    [
      'an escalated task',
      { testsPassed: true, escalationCount: 1, modelsUsed: [cheapModel().id, mediumModel().id] },
    ],
  ];

  it.each(CASES)('%s', (_name, overrides) => {
    const run = finishedRun(overrides);
    const signals = run.signals;
    const score = run.score;
    if (signals === null || score === null) throw new Error('fixture produced no signals');

    const learns = observationFromOutcome(signals, score) !== null;
    const scores =
      predictionFromDecision(run.decision, signals, score, {
        requestId: 'parity',
        scope: 'single-file',
        at: 1,
      }) !== null;

    expect(scores, 'calibration and learning must admit the same runs').toBe(learns);
  });
});
