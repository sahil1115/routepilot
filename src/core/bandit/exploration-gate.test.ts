/**
 * The exploration safety gate.
 *
 * The specification names five conditions under which exploration must never
 * occur, and each has its own section below. These are the tests that matter
 * most in this phase: a bandit that explores slightly too rarely costs money,
 * and one that explores on a production database migration costs something
 * else entirely.
 */

import { describe, expect, it } from 'vitest';

import type { RoutingFeatures, TaskHazard } from '../types/features.js';
import { featuresFor, policy } from '../../test-support/routing-fixtures.js';
import {
  assessExploration,
  EXPLORATION_BLOCKING_HAZARDS,
  EXPLORATION_DISABLED,
  type ExplorationContext,
  type ExplorationPolicy,
} from './exploration-gate.js';

/** A permissive policy, so a refusal is always attributable to the gate. */
const OPEN: ExplorationPolicy = {
  enabled: true,
  minimumObservations: 10,
  maxRisk: 0.5,
  maxCostPremium: 0.25,
  optimism: 1.5,
};

/** A context in which everything is permitted. */
const SAFE: ExplorationContext = {
  mode: 'normal',
  explicitModelRequested: false,
  totalObservations: 500,
  calibrationPermits: true,
};

const ROUTING = policy();

/** Features for a benign task: low risk, no hazards. */
const benign = (): RoutingFeatures => featuresFor('rename a local variable');

const assess = (
  overrides: Partial<ExplorationContext> = {},
  features: RoutingFeatures = benign(),
  explorationPolicy: ExplorationPolicy = OPEN,
  routing = ROUTING,
) => assessExploration(explorationPolicy, features, { ...SAFE, ...overrides }, routing);

describe('the baseline', () => {
  it('permits exploration on a benign task with plenty of data', () => {
    // Without this the rest of the file would pass trivially: every refusal
    // test needs a case that would otherwise have been allowed.
    const verdict = assess();

    expect(verdict.allowed).toBe(true);
    expect(verdict.blockedBy).toBeNull();
  });

  it('is off by default', () => {
    expect(EXPLORATION_DISABLED.enabled).toBe(false);
    expect(assess({}, benign(), EXPLORATION_DISABLED).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1. High risk
// ---------------------------------------------------------------------------

describe('NEVER explores when the task is high risk', () => {
  it('refuses a task above the risk limit', () => {
    const risky = featuresFor('rewrite the billing engine across the whole repository');
    expect(risky.task.risk).toBeGreaterThan(OPEN.maxRisk);

    const verdict = assess({}, risky);
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toMatch(/high-risk|hazardous-task/);
  });

  it('refuses at exactly one point above the limit, and permits at the limit', () => {
    const at = withRisk(benign(), OPEN.maxRisk);
    const above = withRisk(benign(), OPEN.maxRisk + 0.001);

    expect(assess({}, at).allowed).toBe(true);
    expect(assess({}, above).blockedBy).toBe('high-risk');
  });

  it('names the limit it exceeded, so the setting can be found', () => {
    const verdict = assess({}, withRisk(benign(), 0.9));
    expect(verdict.reason).toContain('90%');
    expect(verdict.reason).toContain('50%');
  });
});

// ---------------------------------------------------------------------------
// 2. Budget disallows it
// ---------------------------------------------------------------------------

describe('NEVER explores when the budget disallows it', () => {
  it('refuses when the cost premium is zero', () => {
    // No premium means no experiment could ever be afforded. Reported as a
    // budget block so the message points at the setting responsible.
    const verdict = assess({}, benign(), { ...OPEN, maxCostPremium: 0 });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toBe('no-budget-headroom');
  });

  it('refuses when the request budget is zero or negative', () => {
    for (const requestBudget of [0, -1]) {
      const verdict = assess({}, benign(), OPEN, policy({ requestBudget }));
      expect(verdict.blockedBy).toBe('no-budget-headroom');
    }
  });

  it('permits when a budget exists with room in it', () => {
    expect(assess({}, benign(), OPEN, policy({ requestBudget: 5 })).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The user explicitly selected a model
// ---------------------------------------------------------------------------

describe('NEVER explores when a model was explicitly requested', () => {
  it('refuses outright', () => {
    // An explicit choice is a decision, not a hint (spec section 2, rule 8).
    // Substituting a different model to satisfy curiosity is exactly the silent
    // override that rule forbids.
    const verdict = assess({ explicitModelRequested: true });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toBe('explicit-model');
  });

  it('refuses however safe and well-funded everything else is', () => {
    const verdict = assess(
      { explicitModelRequested: true, totalObservations: 100_000 },
      withRisk(benign(), 0),
      { ...OPEN, maxCostPremium: 2 },
      policy({ requestBudget: 1_000 }),
    );

    expect(verdict.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Production / critical mode
// ---------------------------------------------------------------------------

describe('NEVER explores in production or critical mode', () => {
  it.each(['production', 'critical'] as const)('refuses in %s mode', (mode) => {
    const verdict = assess({ mode });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toBe('operation-mode');
    expect(verdict.reason).toContain(mode);
  });

  it('permits only in normal mode', () => {
    expect(assess({ mode: 'normal' }).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Destructive task
// ---------------------------------------------------------------------------

describe('NEVER explores on a destructive task', () => {
  it('refuses a task carrying a destructive verb', () => {
    const verdict = assess({}, featuresFor('delete the stale user records'));

    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toBe('hazardous-task');
    expect(verdict.reason).toContain('destructive');
  });

  it.each(EXPLORATION_BLOCKING_HAZARDS)('refuses a task flagged %s', (hazard) => {
    const verdict = assess({}, withHazards(benign(), [hazard]));

    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toBe('hazardous-task');
  });

  it('refuses on the hazard even when the risk score is low', () => {
    // The reason hazards are named rather than summed. A destructive task that
    // happens to score 0.05 is still destructive, and a threshold on the score
    // alone would wave it through.
    const features = withHazards(withRisk(benign(), 0.01), ['destructive']);

    expect(features.task.risk).toBeLessThan(OPEN.maxRisk);
    expect(assess({}, features).blockedBy).toBe('hazardous-task');
  });

  it('detects the hazards from a real prompt, not a hand-set flag', () => {
    // The classifier surfaces these; the gate does not re-derive them.
    expect(featuresFor('drop the payments table in production').task.hazards).toEqual(
      expect.arrayContaining(['production', 'destructive', 'payments']),
    );
  });
});

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

describe('only after enough data exists', () => {
  it('refuses below the observation minimum', () => {
    const verdict = assess({ totalObservations: 9 });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toBe('insufficient-data');
    expect(verdict.reason).toContain('9 of 10');
  });

  it('permits at the minimum, and not one observation below', () => {
    expect(assess({ totalObservations: 9 }).allowed).toBe(false);
    expect(assess({ totalObservations: 10 }).allowed).toBe(true);
  });

  it('refuses when the calibration safeguard has withdrawn learning', () => {
    // A predictor whose probabilities are measurably wrong cannot be used to
    // decide what is worth experimenting on either.
    const verdict = assess({ calibrationPermits: false });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedBy).toBe('uncalibrated');
  });
});

describe('the refusal is reported, not merely applied', () => {
  it('gives a stable id and a sentence for every block', () => {
    const cases: [Partial<ExplorationContext>, RoutingFeatures][] = [
      [{ totalObservations: 0 }, benign()],
      [{ calibrationPermits: false }, benign()],
      [{ explicitModelRequested: true }, benign()],
      [{ mode: 'production' }, benign()],
      [{}, withHazards(benign(), ['destructive'])],
      [{}, withRisk(benign(), 0.99)],
    ];

    for (const [context, features] of cases) {
      const verdict = assess(context, features);
      expect(verdict.blockedBy).not.toBeNull();
      expect(verdict.reason.length).toBeGreaterThan(10);
    }
  });

  it('is deterministic', () => {
    expect(assess({ mode: 'production' })).toEqual(assess({ mode: 'production' }));
  });
});

/** Replace a task's risk score, leaving everything else alone. */
function withRisk(features: RoutingFeatures, risk: number): RoutingFeatures {
  return { ...features, task: { ...features.task, risk, hazards: [] } };
}

/** Replace a task's hazards, leaving everything else alone. */
function withHazards(features: RoutingFeatures, hazards: readonly TaskHazard[]): RoutingFeatures {
  return { ...features, task: { ...features.task, hazards } };
}
