/**
 * The safeguard in the routing path.
 *
 * "Do not activate poorly calibrated predictions without safeguards." The unit
 * tests prove the verdict is correct; these prove the verdict is **obeyed** —
 * that a distrusted predictor genuinely stops influencing routing, and the
 * configured priors come back.
 *
 * The setup is Phase 10's: two models with deliberately misleading priors, and
 * enough observations for learning to reverse the choice. Here that reversal
 * becomes the *signal*: if the safeguard works, a distrusted predictor undoes
 * it.
 */

import { describe, expect, it } from 'vitest';

import { LearnedSuccessModel, type LearningPolicy } from '../learning/success-model.js';
import { emptyOutcome, OutcomeRecorder } from '../outcome/outcome-recorder.js';
import { ModelRegistry } from '../registry/model-registry.js';
import { RoutingEngine } from '../routing/routing-engine.js';
import type { CalibrationVerdict } from '../types/calibration.js';
import type { RoutingDecision } from '../types/routing.js';
import { featuresFor, policy } from '../../test-support/routing-fixtures.js';
import {
  InMemoryLearningStore,
  overratedModel,
  syntheticObservations,
  underratedModel,
} from '../../test-support/learning-fixtures.js';
import { noSkill, overConfident, wellCalibrated } from '../../test-support/calibration-fixtures.js';
import { assessCalibration, NOT_ASSESSED } from './gate.js';
import { predictionFromDecision } from './tracking.js';

const TASK = 'implement a new /users API endpoint';
const REGISTRY = new ModelRegistry([overratedModel(), underratedModel()]);
const PERMISSIVE = policy({ minimumSuccessProbability: 0.5 });
const LEARNING_ON: LearningPolicy = { enabled: true, minimumTrainingSamples: 50 };

/** A store with enough evidence for learning to reverse the static choice. */
function trainedStore(): InMemoryLearningStore {
  const store = new InMemoryLearningStore();
  const trainer = new LearnedSuccessModel(store, LEARNING_ON);
  trainer.observeAll(syntheticObservations('acme/flatters-1', 200), 1_000);
  trainer.observeAll(syntheticObservations('acme/modest-1', 200), 1_000);
  return store;
}

function routeUnder(verdict: CalibrationVerdict): RoutingDecision {
  return new RoutingEngine(
    REGISTRY,
    new LearnedSuccessModel(trainedStore(), LEARNING_ON, verdict),
  ).route({ features: featuresFor(TASK), policy: PERMISSIVE });
}

// ---------------------------------------------------------------------------
// The safeguard is obeyed
// ---------------------------------------------------------------------------

describe('a trusted predictor is applied', () => {
  const decision = routeUnder(assessCalibration(wellCalibrated()));

  it('reverses the static choice, as Phase 10 established', () => {
    expect(decision.selectedModelId).toBe('acme/modest-1');
  });

  it('marks the estimates as learned', () => {
    expect(decision.evaluations.every((candidate) => candidate.learningApplied)).toBe(true);
  });
});

describe('a distrusted predictor is withdrawn', () => {
  const decision = routeUnder(assessCalibration(overConfident()));

  it('restores the configured priors', () => {
    for (const candidate of decision.evaluations) {
      expect(candidate.learningApplied).toBe(false);
      expect(candidate.successProbability).toBe(candidate.staticSuccessProbability);
    }
  });

  it('routes exactly as it would with no learning at all', () => {
    const withoutLearning = new RoutingEngine(REGISTRY).route({
      features: featuresFor(TASK),
      policy: PERMISSIVE,
    });

    expect(decision.selectedModelId).toBe(withoutLearning.selectedModelId);
    expect(decision.selectedModelId).toBe('acme/flatters-1');
  });

  it('still reports the observations it is declining to use', () => {
    // The data is not hidden, only disbelieved. Concealing it would misrepresent
    // how much RoutePilot knows.
    const flatters = decision.evaluations.find((c) => c.modelId === 'acme/flatters-1');
    expect(flatters?.observations).toBe(200);
  });

  it('overrides the training minimum, however much data exists', () => {
    // Two hundred observations is far past the minimum. Volume of evidence is
    // not quality of prediction, and the safeguard outranks the count.
    const generous = new LearnedSuccessModel(
      trainedStore(),
      { enabled: true, minimumTrainingSamples: 1 },
      assessCalibration(overConfident()),
    );

    expect(
      generous.estimate(0.9, {
        modelId: 'acme/flatters-1',
        taskType: 'feature-implementation',
        scope: 'few-files',
        language: 'unknown',
      }).applied,
    ).toBe(false);
  });
});

describe('a useless predictor is withdrawn too', () => {
  it('is refused despite perfect calibration', () => {
    // The predictor that answers the base rate to everything. Replacing the
    // models' differentiated priors with one flat number would destroy real
    // signal, so this must not be applied.
    const decision = routeUnder(assessCalibration(noSkill()));

    expect(decision.selectedModelId).toBe('acme/flatters-1');
    expect(decision.evaluations.every((c) => !c.learningApplied)).toBe(true);
  });
});

describe('an unassessed predictor', () => {
  it('runs under the training minimum alone, by default', () => {
    // Not yet examined is not "found wanting". Blocking here would deadlock:
    // predictions only accumulate while learning is active.
    expect(routeUnder(NOT_ASSESSED).selectedModelId).toBe('acme/modest-1');
  });

  it('is blocked when proof is demanded', () => {
    const verdict = assessCalibration(overConfident(10), {
      minimumSamples: 50,
      maxExpectedCalibrationError: 0.15,
      maxCalibrationError: 0.3,
      minimumBrierSkillScore: 0.02,
      requireCalibration: true,
    });

    expect(verdict.status).toBe('unassessed');
    expect(routeUnder(verdict).selectedModelId).toBe('acme/flatters-1');
  });
});

describe('the verdict is explained, not just applied', () => {
  it('gives the reason as the estimate’s reason', () => {
    const model = new LearnedSuccessModel(
      trainedStore(),
      LEARNING_ON,
      assessCalibration(overConfident()),
    );
    const estimate = model.estimate(0.9, {
      modelId: 'acme/flatters-1',
      taskType: 'feature-implementation',
      scope: 'few-files',
      language: 'unknown',
    });

    expect(estimate.reason).toContain('poorly calibrated');
    expect(model.calibration.status).toBe('distrusted');
  });
});

describe('routing safeguards from earlier phases are unaffected', () => {
  it('a distrusted verdict does not disable budgets', () => {
    const decision = new RoutingEngine(
      REGISTRY,
      new LearnedSuccessModel(trainedStore(), LEARNING_ON, assessCalibration(overConfident())),
    ).route({
      features: featuresFor(TASK),
      policy: policy({
        minimumSuccessProbability: 0.5,
        requestBudget: 0.01,
        onBudgetExceeded: 'stop',
      }),
    });

    expect(decision.selectedModelId).toBeNull();
  });

  it('routing stays deterministic under every verdict', () => {
    for (const verdict of [
      NOT_ASSESSED,
      assessCalibration(wellCalibrated()),
      assessCalibration(overConfident()),
    ]) {
      expect(routeUnder(verdict)).toEqual(routeUnder(verdict));
    }
  });
});

// ---------------------------------------------------------------------------
// Prediction vs actual outcome
// ---------------------------------------------------------------------------

describe('predictionFromDecision', () => {
  const recorder = new OutcomeRecorder();
  const decision = routeUnder(assessCalibration(wellCalibrated()));
  const context = { requestId: 'req-1', scope: 'few-files' as const, at: 5_000 };

  const outcomeFor = (overrides: Parameters<typeof emptyOutcome>[1]) =>
    emptyOutcome('req-1', {
      taskType: 'feature-implementation',
      modelsUsed: ['acme/modest-1'],
      ...overrides,
    });

  it('pairs the prediction with what actually happened', () => {
    const outcome = outcomeFor({ buildPassed: true, testsPassed: true, taskCriteriaMet: true });
    const record = predictionFromDecision(decision, outcome, recorder.score(outcome), context);

    expect(record?.modelId).toBe('acme/modest-1');
    expect(record?.predicted).toBeCloseTo(0.9374, 3);
    expect(record?.actual).toBeGreaterThan(0.9);
  });

  it('labels the source, so learned and prior are scored separately', () => {
    const outcome = outcomeFor({ buildPassed: true, testsPassed: true, taskCriteriaMet: true });
    const learned = predictionFromDecision(decision, outcome, recorder.score(outcome), context);

    expect(learned?.source).toBe('learned');

    const priorDecision = new RoutingEngine(REGISTRY).route({
      features: featuresFor(TASK),
      policy: PERMISSIVE,
    });
    const priorOutcome = outcomeFor({
      buildPassed: true,
      testsPassed: true,
      taskCriteriaMet: true,
      modelsUsed: ['acme/flatters-1'],
    });
    const prior = predictionFromDecision(
      priorDecision,
      priorOutcome,
      recorder.score(priorOutcome),
      context,
    );

    expect(prior?.source).toBe('prior');
  });

  it('records the real observation count behind the prediction', () => {
    const outcome = outcomeFor({ buildPassed: true, testsPassed: true, taskCriteriaMet: true });
    const record = predictionFromDecision(decision, outcome, recorder.score(outcome), context);

    expect(record?.observations).toBe(200);
  });

  it('refuses an outcome nothing evaluated', () => {
    const outcome = outcomeFor({});
    expect(recorder.score(outcome).score).toBeNull();
    expect(predictionFromDecision(decision, outcome, recorder.score(outcome), context)).toBeNull();
  });

  it('refuses an outcome that is not the model’s fault', () => {
    const outcome = outcomeFor({ buildPassed: false, failureType: 'PROVIDER_FAILURE' });
    expect(predictionFromDecision(decision, outcome, recorder.score(outcome), context)).toBeNull();
  });

  it('refuses an escalated task, which no single prediction owns', () => {
    const outcome = outcomeFor({
      buildPassed: true,
      testsPassed: true,
      escalationCount: 1,
      modelsUsed: ['acme/modest-1', 'acme/flatters-1'],
    });

    expect(predictionFromDecision(decision, outcome, recorder.score(outcome), context)).toBeNull();
  });

  it('refuses when nothing was selected', () => {
    const stopped = new RoutingEngine(REGISTRY).route({
      features: featuresFor(TASK),
      policy: policy({ requestBudget: 0.001, onBudgetExceeded: 'stop' }),
    });
    const outcome = outcomeFor({ buildPassed: true, testsPassed: true });

    expect(stopped.selectedModelId).toBeNull();
    expect(predictionFromDecision(stopped, outcome, recorder.score(outcome), context)).toBeNull();
  });

  it('carries a partial success through as a fractional outcome', () => {
    const outcome = outcomeFor({ buildPassed: true, testsPassed: false, taskCriteriaMet: false });
    const record = predictionFromDecision(decision, outcome, recorder.score(outcome), context);

    expect(record?.actual).toBeGreaterThan(0);
    expect(record?.actual).toBeLessThan(1);
  });
});
