/**
 * The predicted escalation target and the real one are the same model.
 *
 * Two implementations chose it independently until Phase 25. The sharpest
 * disagreement was the ranking key: the estimator took the lowest **expected
 * total cost to success**, and the engine took the lowest **sticker price per
 * output token** — the exact thing `expected-cost.ts` was written to argue is a
 * trap. So `routepilot route` could print "escalates to X", price the whole
 * decision on that, and the runtime would move to Y.
 *
 * They also disagreed on the margin (`> p` against `> p + 0.02`) and on whether
 * a model that had already failed this task was eligible.
 *
 * The models below are built so that the two rankings genuinely differ: the
 * cheaper-per-token option is the worse bet, which is the case the whole
 * project exists to get right.
 */

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../registry/model-registry.js';
import { RoutingEngine } from '../routing/routing-engine.js';
import { featuresFor, policy } from '../../test-support/routing-fixtures.js';
import { makeModel } from '../../test-support/fixtures.js';
import { EscalationEngine } from './escalation-engine.js';
import type { ModelSpec } from '../types/model.js';
import {
  chooseVerticalTarget,
  VERTICAL_ESCALATION_MARGIN,
  type EscalationCandidate,
} from './target-selection.js';

/** Cheap per token, and much likelier to need a second attempt. */
const cheapButWeak: ModelSpec = makeModel({
  id: 'acme/cheap-but-weak',
  modelId: 'cheap-but-weak',
  tier: 'medium',
  pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
});

/** Dearer per token, and far likelier to finish first time. */
const dearButStrong: ModelSpec = makeModel({
  id: 'acme/dear-but-strong',
  modelId: 'dear-but-strong',
  tier: 'frontier',
  pricing: { inputPerMillion: 5, outputPerMillion: 30, currency: 'USD' },
});

describe('the shared vertical-escalation rule', () => {
  it('ranks by expected cost, not by sticker price', () => {
    // The regression. `cheapButWeak` wins on price per token and loses on the
    // number that matters, and the old engine picked it for exactly that
    // reason while the estimator picked the other one.
    const target = chooseVerticalTarget(
      [
        { model: cheapButWeak, successProbability: 0.7, expectedTotalCost: 0.9 },
        { model: dearButStrong, successProbability: 0.95, expectedTotalCost: 0.4 },
      ],
      0.5,
    );

    expect(target?.id).toBe('acme/dear-but-strong');
  });

  it('falls back to sticker price only when nothing has been costed', () => {
    // The engine holds specs and a predictor, not expected costs. It still has
    // to choose, and a stable defensible order beats an arbitrary one.
    const target = chooseVerticalTarget(
      [
        { model: cheapButWeak, successProbability: 0.7 },
        { model: dearButStrong, successProbability: 0.95 },
      ],
      0.5,
    );

    expect(target?.id).toBe('acme/cheap-but-weak');
  });

  it('requires a real improvement, not a rounding difference', () => {
    // Moving between two models whose priors differ in the third decimal
    // spends a handoff to buy nothing.
    const marginal: EscalationCandidate[] = [
      { model: dearButStrong, successProbability: 0.5 + VERTICAL_ESCALATION_MARGIN / 2 },
    ];

    expect(chooseVerticalTarget(marginal, 0.5)).toBeNull();
  });

  it('never escalates back to a model that already failed this task', () => {
    const target = chooseVerticalTarget(
      [
        { model: cheapButWeak, successProbability: 0.9, expectedTotalCost: 0.1 },
        { model: dearButStrong, successProbability: 0.95, expectedTotalCost: 0.4 },
      ],
      0.5,
      { exclude: ['acme/cheap-but-weak'] },
    );

    expect(target?.id).toBe('acme/dear-but-strong');
  });

  it('returns null when nothing is better', () => {
    expect(
      chooseVerticalTarget([{ model: cheapButWeak, successProbability: 0.4 }], 0.9),
    ).toBeNull();
    expect(chooseVerticalTarget([], 0.5)).toBeNull();
  });

  it('is deterministic when candidates tie', () => {
    // Two runs must pick the same model. Ties break on id, so the order the
    // caller happened to build its list in cannot change a decision.
    const twin: ModelSpec = makeModel({ id: 'acme/aaa', modelId: 'aaa', tier: 'frontier' });
    const other: ModelSpec = makeModel({ id: 'acme/zzz', modelId: 'zzz', tier: 'frontier' });

    const forwards = chooseVerticalTarget(
      [
        { model: twin, successProbability: 0.9, expectedTotalCost: 1 },
        { model: other, successProbability: 0.9, expectedTotalCost: 1 },
      ],
      0.5,
    );
    const backwards = chooseVerticalTarget(
      [
        { model: other, successProbability: 0.9, expectedTotalCost: 1 },
        { model: twin, successProbability: 0.9, expectedTotalCost: 1 },
      ],
      0.5,
    );

    expect(forwards?.id).toBe('acme/aaa');
    expect(backwards?.id).toBe(forwards?.id);
  });
});

describe('the target the router prints is the target the engine runs', () => {
  // The end-to-end form of the same defect. `ModelEvaluation.escalationTargetId`
  // is shown by `routepilot route`, by the extension and by the explanation, and
  // the cost attached to it is part of why a model was chosen at all -- but it
  // never reached the runtime, so nothing had ever compared the two.
  const LADDER: readonly ModelSpec[] = [
    makeModel({
      id: 'acme/weak',
      modelId: 'weak',
      tier: 'cheap',
      contextWindow: 400_000,
      maxOutputTokens: 64_000,
      pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
      priors: { skills: { codeGeneration: 0.5, refactoring: 0.5, debugging: 0.5 }, languages: {} },
    }),
    makeModel({
      id: 'acme/middle',
      modelId: 'middle',
      tier: 'medium',
      contextWindow: 400_000,
      maxOutputTokens: 64_000,
      pricing: { inputPerMillion: 2, outputPerMillion: 4, currency: 'USD' },
      priors: { skills: { codeGeneration: 0.7, refactoring: 0.7, debugging: 0.7 }, languages: {} },
    }),
    makeModel({
      id: 'acme/strong',
      modelId: 'strong',
      tier: 'frontier',
      contextWindow: 400_000,
      maxOutputTokens: 64_000,
      pricing: { inputPerMillion: 4, outputPerMillion: 8, currency: 'USD' },
      priors: {
        skills: { codeGeneration: 0.95, refactoring: 0.95, debugging: 0.95 },
        languages: {},
      },
    }),
  ];

  const TASK = 'Refactor authentication across the repository.';

  it('agrees on the model to escalate to after a MODEL_WEAKNESS failure', () => {
    const models = new ModelRegistry(LADDER);
    const decision = new RoutingEngine(models).route({
      features: featuresFor(TASK),
      policy: policy({ minimumSuccessProbability: 0.4 }),
    });

    const selected = decision.evaluations.find((e) => e.modelId === decision.selectedModelId);
    expect(selected).toBeDefined();
    const predicted = selected?.escalationTargetId ?? null;
    expect(predicted).not.toBeNull();

    const current = LADDER.find((model) => model.id === decision.selectedModelId);
    expect(current).toBeDefined();

    const actual = new EscalationEngine().decide({
      originalTask: TASK,
      repositoryRoot: '/workspace',
      branch: null,
      features: featuresFor(TASK),
      currentModel: current!,
      attempts: [
        {
          modelId: current!.id,
          providerId: current!.providerId,
          tier: current!.tier,
          succeeded: false,
          failureType: 'MODEL_WEAKNESS',
          failureReason: 'left the tests failing',
          cost: 0.01,
          durationMs: 1000,
          changedFiles: ['src/auth.ts'],
          failedChecks: ['tests'],
        },
      ],
      classification: {
        failureType: 'MODEL_WEAKNESS',
        confidence: 0.9,
        reason: 'the changes it made fail validation that was passing before',
        signals: ['weakness.broke-validation'],
        modelAttributable: true,
      },
      limits: { maxEscalationsPerTask: 2, maxRetriesPerModel: 1 },
      totalCost: 0.01,
      elapsedMs: 1000,
      eligibleModels: decision.evaluations
        .filter((evaluation) => evaluation.viable)
        .map((evaluation) => LADDER.find((model) => model.id === evaluation.modelId))
        .filter((model): model is ModelSpec => model !== undefined),
    });

    // A horizontal move is a legitimate answer the estimator does not model,
    // and is documented as such. What must never happen is the two choosing
    // different *vertical* targets, which is what the split rules produced.
    if (actual.action === 'escalate-vertical') {
      expect(actual.targetModelId).toBe(predicted);
    } else {
      expect(actual.action).toBe('escalate-horizontal');
    }
  });
});
