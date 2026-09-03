/**
 * Escalation: the eight cases this phase specifies, plus the graph, the limits
 * and the handoff.
 *
 * The theme running through the case list is that most failures are **not** the
 * model's fault, and escalating on them would spend more money reproducing the
 * same failure. Only one of the eight cases ends in a stronger model.
 */

import { describe, expect, it } from 'vitest';

import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  modelLadder,
  ultraModel,
} from '../../test-support/routing-fixtures.js';
import type { FailureClassification, StruggleAssessment } from '../types/execution.js';
import type { EscalationLimits, ExecutionAttempt } from '../types/escalation.js';
import type { FailureType } from '../types/failure.js';
import type { ModelSpec } from '../types/model.js';
import { ContextHandoffBuilder } from './handoff.js';
import { EscalationEngine, type EscalationContext } from './escalation-engine.js';

const LIMITS: EscalationLimits = { maxEscalationsPerTask: 3, maxRetriesPerModel: 1 };

/** A classification with sensible defaults. */
function classification(
  failureType: FailureType,
  overrides: Partial<FailureClassification> = {},
): FailureClassification {
  return {
    failureType,
    confidence: 0.8,
    reason: `classified as ${failureType}`,
    signals: [],
    modelAttributable: failureType === 'MODEL_WEAKNESS',
    ...overrides,
  };
}

/** One failed attempt on a model. */
function attempt(model: ModelSpec, overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    modelId: model.id,
    providerId: model.providerId,
    tier: model.tier,
    succeeded: false,
    failureType: 'MODEL_WEAKNESS',
    cost: 0.02,
    durationMs: 30_000,
    changedFiles: ['src/a.ts'],
    ...overrides,
  };
}

/** Build an escalation context. */
function context(overrides: Partial<EscalationContext> = {}): EscalationContext {
  const current = overrides.currentModel ?? cheapModel();
  return {
    originalTask: 'implement a new /users API endpoint',
    repositoryRoot: '/workspace',
    branch: 'main',
    features: featuresFor('implement a new /users API endpoint'),
    currentModel: current,
    attempts: [attempt(current)],
    classification: classification('MODEL_WEAKNESS'),
    limits: LIMITS,
    totalCost: 0.02,
    elapsedMs: 30_000,
    eligibleModels: modelLadder(),
    ...overrides,
  };
}

/**
 * The engine takes no registry; candidates come from the context. The argument
 * here just documents which model set a given test is working with.
 */
const engine = (_models: ModelSpec[] = modelLadder()): EscalationEngine => new EscalationEngine();

const struggle = (modelScore: number): StruggleAssessment => ({
  score: modelScore,
  modelAttributableScore: modelScore,
  level: 'moderate',
  contributions: [],
});

// ---------------------------------------------------------------------------
// The eight required cases
// ---------------------------------------------------------------------------

describe('CASE — a cheap model succeeds', () => {
  it('does not escalate', () => {
    const decision = engine().decide(
      context({
        attempts: [attempt(cheapModel(), { succeeded: true, failureType: undefined })],
        classification: classification('UNKNOWN'),
      }),
    );

    expect(decision.action).toBe('none');
    expect(decision.targetModelId).toBeNull();
    expect(decision.handoff).toBeNull();
  });
});

describe('CASE — a cheap model fails through model weakness', () => {
  it('moves to a better model', () => {
    const decision = engine().decide(context());

    expect(['escalate-vertical', 'escalate-horizontal']).toContain(decision.action);
    expect(decision.targetModelId).not.toBe('acme/fast-1');
    expect(decision.modelAttributable).toBe(true);
  });

  it('escalates to the cheapest model that is genuinely better, not the dearest', () => {
    const decision = engine().decide(context());

    // Reaching straight for the most expensive option is the failure mode
    // RoutePilot exists to avoid.
    expect(decision.targetModelId).toBe('acme/balanced-1');
    expect(decision.targetModelId).not.toBe('acme/ultra-1');
  });

  it('hands over a briefing rather than only the original prompt', () => {
    const decision = engine().decide(context());

    expect(decision.handoff).not.toBeNull();
    expect(decision.handoff?.previousModelId).toBe('acme/fast-1');
    expect(decision.handoff?.filesChanged).toEqual(['src/a.ts']);
    expect(decision.handoff?.instruction).toContain('Do not blindly repeat');
  });
});

describe('CASE — a cheap model fails because of the environment', () => {
  it('retries rather than escalating the model', () => {
    const decision = engine().decide(
      context({ classification: classification('ENVIRONMENT_FAILURE') }),
    );

    expect(decision.action).toBe('retry');
    expect(decision.targetModelId).toBe('acme/fast-1');
  });

  it('never escalates the model, even once retries are gone', () => {
    // Spec section 26: escalating would spend more money reproducing the same
    // failure. The environment needs fixing.
    const current = cheapModel();
    const decision = engine().decide(
      context({
        classification: classification('ENVIRONMENT_FAILURE'),
        attempts: [attempt(current), attempt(current)],
      }),
    );

    expect(decision.action).toBe('stop');
    expect(decision.reason).toContain('environment');
    expect(decision.modelAttributable).toBe(false);
  });

  it('says the failure will not inform routing or learning', () => {
    const decision = engine().decide(
      context({ classification: classification('ENVIRONMENT_FAILURE') }),
    );

    expect(decision.explanation.join('\n')).toContain('does not implicate the model');
  });

  it('treats a flaky test the same way — retry, never escalate', () => {
    const decision = engine().decide(context({ classification: classification('FLAKY_TEST') }));

    expect(decision.action).toBe('retry');
    expect(decision.reason).toContain('flaky');
  });
});

describe('CASE — the model hits a context limit', () => {
  it('moves to a larger-context candidate', () => {
    const decision = engine().decide(
      context({
        classification: classification('CONTEXT_LIMIT'),
        features: featuresFor('refactor everything', { contextTokens: 300_000 }),
      }),
    );

    expect(decision.action).toBe('escalate-vertical');
    expect(decision.reason).toContain('context window');

    // A bigger window is what is needed, not a cleverer model.
    const chosen = modelLadder().find((m) => m.id === decision.targetModelId);
    expect(chosen?.contextWindow).toBeGreaterThan(cheapModel().contextWindow);
  });

  it('picks the smallest window that actually fits, not the biggest available', () => {
    const decision = engine().decide(
      context({
        classification: classification('CONTEXT_LIMIT'),
        features: featuresFor('refactor everything', { contextTokens: 300_000 }),
      }),
    );

    expect(decision.targetModelId).toBe('acme/balanced-1');
  });

  it('stops when nothing has a larger window', () => {
    const only = ultraModel();
    const decision = engine([only]).decide(
      context({
        currentModel: only,
        attempts: [attempt(only)],
        classification: classification('CONTEXT_LIMIT'),
        eligibleModels: [only],
      }),
    );

    expect(decision.action).toBe('stop');
    expect(decision.reason).toContain('Compacting');
  });
});

describe('CASE — the provider is unavailable', () => {
  it('retries the same model first', () => {
    const decision = engine().decide(
      context({ classification: classification('PROVIDER_FAILURE') }),
    );

    expect(decision.action).toBe('retry');
    expect(decision.targetModelId).toBe('acme/fast-1');
  });

  it('falls back to another provider once retries are gone', () => {
    const current = cheapModel();
    const other = mediumModel({ id: 'globex/balanced-1', providerId: 'globex' });

    const decision = engine([current, other]).decide(
      context({
        classification: classification('PROVIDER_FAILURE'),
        attempts: [attempt(current), attempt(current)],
        eligibleModels: [current, other],
      }),
    );

    expect(decision.action).toBe('provider-fallback');
    expect(decision.targetModelId).toBe('globex/balanced-1');
    expect(decision.reason).toContain('model class is unchanged');
  });

  it('stops when no other provider offers anything', () => {
    const current = cheapModel();
    const decision = engine([current]).decide(
      context({
        classification: classification('PROVIDER_FAILURE'),
        attempts: [attempt(current), attempt(current)],
        eligibleModels: [current],
      }),
    );

    expect(decision.action).toBe('stop');
    expect(decision.limitReached).toBe('no-candidates');
  });

  it('sends no handoff for a provider outage, since nothing was attempted', () => {
    const current = cheapModel();
    const other = mediumModel({ id: 'globex/balanced-1', providerId: 'globex' });

    const decision = engine([current, other]).decide(
      context({
        classification: classification('PROVIDER_FAILURE'),
        attempts: [attempt(current), attempt(current)],
        eligibleModels: [current, other],
      }),
    );

    expect(decision.handoff).toBeNull();
  });
});

describe('CASE — the request is ambiguous', () => {
  it('asks the user rather than escalating', () => {
    const decision = engine().decide(context({ classification: classification('USER_AMBIGUITY') }));

    expect(decision.action).toBe('ask-user');
    expect(decision.targetModelId).toBeNull();
    expect(decision.question).toBeTruthy();
  });

  it('explains that a stronger model would answer the wrong question better', () => {
    const decision = engine().decide(
      context({ classification: classification('BAD_SPECIFICATION') }),
    );

    expect(decision.action).toBe('ask-user');
    expect(decision.reason).toContain('wrong question');
  });

  it('asks the user when the repository itself is broken', () => {
    const decision = engine().decide(
      context({ classification: classification('REPOSITORY_PROBLEM') }),
    );

    expect(decision.action).toBe('ask-user');
    expect(decision.question).toContain('repository');
  });
});

describe('CASE — the budget is exhausted', () => {
  it('stops on a budget failure', () => {
    const decision = engine().decide(
      context({ classification: classification('BUDGET_EXCEEDED') }),
    );

    expect(decision.action).toBe('stop');
    expect(decision.limitReached).toBe('cost');
  });

  it('stops when the accumulated cost reaches the limit, before anything else', () => {
    const decision = engine().decide(
      context({
        classification: classification('MODEL_WEAKNESS'),
        limits: { ...LIMITS, maxTotalCost: 0.5 },
        totalCost: 0.6,
      }),
    );

    // Even genuine model weakness must not spend past the cap.
    expect(decision.action).toBe('stop');
    expect(decision.limitReached).toBe('cost');
  });

  it('stops when the time limit is reached', () => {
    const decision = engine().decide(
      context({
        limits: { ...LIMITS, maxExecutionTimeMs: 60_000 },
        elapsedMs: 90_000,
      }),
    );

    expect(decision.action).toBe('stop');
    expect(decision.limitReached).toBe('time');
  });
});

describe('CASE — the strongest model fails', () => {
  it('does not escalate endlessly', () => {
    const strongest = ultraModel();
    const decision = engine().decide(
      context({
        currentModel: strongest,
        attempts: [attempt(strongest)],
        classification: classification('MODEL_WEAKNESS'),
      }),
    );

    expect(decision.action).toBe('stop');
    expect(decision.limitReached).toBe('no-candidates');
    expect(decision.reason).toContain('strongest suitable model');
  });

  it('stops once the escalation limit is reached, whatever is left', () => {
    const decision = engine().decide(
      context({
        currentModel: mediumModel(),
        limits: { maxEscalationsPerTask: 1, maxRetriesPerModel: 1 },
        attempts: [attempt(cheapModel()), attempt(mediumModel())],
      }),
    );

    expect(decision.action).toBe('stop');
    expect(decision.limitReached).toBe('escalations');
  });

  it('terminates: repeatedly deciding never loops forever', () => {
    // Drive the graph until it stops, and assert it does.
    const models = modelLadder();
    const attempts: ExecutionAttempt[] = [];
    let current = cheapModel();
    let steps = 0;

    for (; steps < 20; steps += 1) {
      attempts.push(attempt(current));
      const decision = engine(models).decide(
        context({
          currentModel: current,
          attempts: [...attempts],
          classification: classification('MODEL_WEAKNESS'),
          eligibleModels: models,
        }),
      );

      if (decision.action === 'stop' || decision.action === 'ask-user') break;

      const next = models.find((m) => m.id === decision.targetModelId);
      if (next === undefined) break;
      current = next;
    }

    expect(steps).toBeLessThan(10);
  });
});

// ---------------------------------------------------------------------------
// The graph, beyond the eight cases
// ---------------------------------------------------------------------------

describe('the escalation graph is not a ladder', () => {
  it('prefers a sideways move when a same-tier model is markedly better at the task', () => {
    // Spec sections 8 and 24: a model can be excellent at one kind of work and
    // mediocre at another, so "better" is task-specific.
    const weakDebugger = cheapModel({
      id: 'acme/generalist',
      priors: { skills: { debugging: 0.5 }, languages: {} },
    });
    const strongDebugger = cheapModel({
      id: 'acme/specialist',
      priors: { skills: { debugging: 0.85 }, languages: {} },
    });

    const decision = engine([weakDebugger, strongDebugger]).decide(
      context({
        currentModel: weakDebugger,
        attempts: [attempt(weakDebugger)],
        features: featuresFor('debug why the worker pool deadlocks'),
        eligibleModels: [weakDebugger, strongDebugger],
      }),
    );

    expect(decision.action).toBe('escalate-horizontal');
    expect(decision.targetModelId).toBe('acme/specialist');
  });

  it('does not move sideways for a marginal difference', () => {
    const a = cheapModel({ id: 'acme/a', priors: { skills: { debugging: 0.7 }, languages: {} } });
    const b = cheapModel({ id: 'acme/b', priors: { skills: { debugging: 0.73 }, languages: {} } });
    const strong = frontierModel();

    const decision = engine([a, b, strong]).decide(
      context({
        currentModel: a,
        attempts: [attempt(a)],
        features: featuresFor('debug why the worker pool deadlocks'),
        eligibleModels: [a, b, strong],
      }),
    );

    expect(decision.action).toBe('escalate-vertical');
  });

  it('never re-tries a model that already failed', () => {
    const decision = engine().decide(
      context({
        currentModel: mediumModel(),
        attempts: [attempt(cheapModel()), attempt(mediumModel())],
      }),
    );

    expect(decision.targetModelId).not.toBe('acme/fast-1');
    expect(decision.targetModelId).not.toBe('acme/balanced-1');
  });

  it('improves context rather than changing model when context was missing', () => {
    const decision = engine().decide(
      context({ classification: classification('MISSING_CONTEXT') }),
    );

    // Spec section 26: attempt context improvement before changing model.
    expect(['retry', 'improve-context']).toContain(decision.action);
    expect(decision.targetModelId).toBe('acme/fast-1');
  });

  it('treats an unexplained failure with visible struggle as weakness', () => {
    const decision = engine().decide(
      context({ classification: classification('UNKNOWN'), struggle: struggle(0.8) }),
    );

    expect(['escalate-vertical', 'escalate-horizontal']).toContain(decision.action);
  });

  it('retries an unexplained failure when the model was not visibly struggling', () => {
    const decision = engine().decide(
      context({ classification: classification('UNKNOWN'), struggle: struggle(0.1) }),
    );

    expect(decision.action).toBe('retry');
  });

  it('explains every decision', () => {
    for (const failureType of [
      'MODEL_WEAKNESS',
      'ENVIRONMENT_FAILURE',
      'PROVIDER_FAILURE',
      'CONTEXT_LIMIT',
      'USER_AMBIGUITY',
      'USER_CANCELLED',
      'FLAKY_TEST',
    ] as const) {
      const decision = engine().decide(context({ classification: classification(failureType) }));

      expect(decision.reason.length, failureType).toBeGreaterThan(20);
      expect(decision.explanation.join('\n'), failureType).toContain(failureType);
      expect(decision.explanation.join('\n')).toContain('Action:');
    }
  });

  it('stops immediately on cancellation', () => {
    const decision = engine().decide(context({ classification: classification('USER_CANCELLED') }));

    expect(decision.action).toBe('stop');
    expect(decision.modelAttributable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Context handoff
// ---------------------------------------------------------------------------

describe('ContextHandoffBuilder', () => {
  const builder = new ContextHandoffBuilder();

  const input = {
    originalTask: 'refactor the authentication module',
    repositoryRoot: '/workspace',
    branch: 'feature/auth',
    escalationReason: 'the previous model repeatedly failed',
    attempts: [
      attempt(cheapModel(), {
        changedFiles: ['src/auth.ts', 'src/session.ts'],
        inspectedFiles: ['src/index.ts'],
        approaches: ['tried extracting a Session class'],
        failedChecks: ['tests'],
        failureReason: 'tests failed after the change',
      }),
    ],
  };

  it('carries everything the spec section 28 list names', () => {
    const handoff = builder.build(input);

    expect(handoff.originalTask).toBe(input.originalTask);
    expect(handoff.repositoryRoot).toBe('/workspace');
    expect(handoff.branch).toBe('feature/auth');
    expect(handoff.filesChanged).toEqual(['src/auth.ts', 'src/session.ts']);
    expect(handoff.filesInspected).toEqual(['src/index.ts']);
    expect(handoff.failingChecks).toEqual(['tests']);
    expect(handoff.approachesTried).toEqual(['tried extracting a Session class']);
    expect(handoff.previousModelId).toBe('acme/fast-1');
    expect(handoff.failureType).toBe('MODEL_WEAKNESS');
    expect(handoff.escalationReason).toBe(input.escalationReason);
  });

  it('tells the next model not to start over or repeat failed approaches', () => {
    const rendered = builder.render(builder.build(input));

    expect(rendered).toContain('A previous model attempted this task');
    expect(rendered).toContain('Continue from the current workspace state');
    expect(rendered).toContain('Review the existing changes');
    expect(rendered).toContain('Do not blindly repeat');
  });

  it('is a briefing, not a transcript', () => {
    // Spec section 28: do not send unnecessary full transcripts.
    const many: ExecutionAttempt[] = Array.from({ length: 12 }, (_, i) =>
      attempt(cheapModel(), {
        changedFiles: Array.from({ length: 20 }, (_, j) => `src/f${String(i)}-${String(j)}.ts`),
        approaches: [`approach ${String(i)}`],
      }),
    );

    const handoff = builder.build({ ...input, attempts: many });

    expect(handoff.filesChanged.length).toBeLessThanOrEqual(40);
    expect(handoff.approachesTried.length).toBeLessThanOrEqual(12);
    expect(handoff.previousAttempts.length).toBeLessThanOrEqual(6);
    expect(builder.size(handoff)).toBeLessThan(6_000);
  });

  it('carries no file contents', () => {
    const rendered = builder.render(builder.build(input));

    // Paths and summaries only — the same discipline the event stream follows.
    expect(rendered).not.toContain('function ');
    expect(rendered).not.toContain('import ');
  });

  it('omits empty sections rather than padding with "none"', () => {
    const rendered = builder.render(
      builder.build({
        ...input,
        attempts: [attempt(cheapModel(), { changedFiles: [], approaches: [] })],
      }),
    );

    expect(rendered).not.toContain('Approaches already tried');
    expect(rendered).not.toContain('Files already changed');
  });

  it('de-duplicates and sorts across attempts', () => {
    const handoff = builder.build({
      ...input,
      attempts: [
        attempt(cheapModel(), { changedFiles: ['src/b.ts', 'src/a.ts'] }),
        attempt(mediumModel(), { changedFiles: ['src/a.ts', 'src/c.ts'] }),
      ],
    });

    expect(handoff.filesChanged).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('summarises each previous attempt in one line', () => {
    const handoff = builder.build({
      ...input,
      attempts: [
        attempt(cheapModel(), { failureType: 'TOOL_FAILURE', failureReason: 'edit did not apply' }),
        attempt(mediumModel(), { succeeded: true, failureType: undefined }),
      ],
    });

    expect(handoff.previousAttempts).toEqual([
      'acme/fast-1: failed (TOOL_FAILURE) — edit did not apply',
      'acme/balanced-1: succeeded',
    ]);
  });
});
