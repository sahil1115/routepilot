/**
 * Synthetic simulation, before real activation.
 *
 * "Use synthetic simulations before real activation." Exploration deliberately
 * spends money on a model the router does not believe is best, so before it is
 * allowed near a real workspace it has to be shown — in a world where the right
 * answer is known — that it pays for itself, finds the better model, and then
 * stops.
 *
 * The environment is `bandit-fixtures.ts`: `sim/steady` is honestly configured
 * and adequate; `sim/sleeper` is cheaper and better than its pessimistic prior
 * suggests, so expected-cost routing never chooses it, so nothing is ever
 * learned about it. Exploitation alone is stuck at a local optimum that no
 * amount of further data can reveal, because the data that would reveal it is
 * never collected.
 */

import { describe, expect, it } from 'vitest';

import { EXPLORATION_DISABLED, type ExplorationPolicy } from './exploration-gate.js';
import { featuresFor, policy } from '../../test-support/routing-fixtures.js';
import { simulate, TRUE_RATES } from '../../test-support/bandit-fixtures.js';

const FEATURES = featuresFor('implement a new /users API endpoint');
const POLICY = policy({ minimumSuccessProbability: 0.5 });
const LEARNING = { enabled: true, minimumTrainingSamples: 5 };
const ROUNDS = 300;

const EXPLORING: ExplorationPolicy = {
  enabled: true,
  minimumObservations: 5,
  maxRisk: 0.9,
  maxCostPremium: 0.5,
  optimism: 1.5,
};

const run = (exploration: ExplorationPolicy, rounds = ROUNDS) =>
  simulate({ rounds, exploration, learning: LEARNING, features: FEATURES, policy: POLICY });

describe('the premise: exploitation alone gets stuck', () => {
  const exploit = run(EXPLORATION_DISABLED);

  it('never tries the cheaper, better model', () => {
    expect(exploit.picks['sim/sleeper']).toBeUndefined();
    expect(exploit.picks['sim/steady']).toBe(ROUNDS);
  });

  it('is stuck on the worse arm at the end, after three hundred tasks', () => {
    // Not for want of data. It has three hundred observations of `steady` and
    // none of `sleeper`, and no quantity of the former can reveal the latter.
    expect(exploit.finalChoice).toBe('sim/steady');
    expect(TRUE_RATES['sim/sleeper']).toBeGreaterThan(TRUE_RATES['sim/steady'] as number);
  });
});

describe('ACCEPTANCE: exploration finds the better model and pays for itself', () => {
  const explore = run(EXPLORING);
  const exploit = run(EXPLORATION_DISABLED);

  it('discovers the arm exploitation never tries', () => {
    expect(explore.picks['sim/sleeper']).toBeGreaterThan(0);
    expect(explore.finalChoice).toBe('sim/sleeper');
  });

  it('costs less overall, counting every experiment it paid for', () => {
    // The measure that matters. Exploration always loses on the first task; the
    // question is whether it wins over three hundred.
    expect(explore.totalCost).toBeLessThan(exploit.totalCost);
    expect(explore.totalCost / exploit.totalCost).toBeLessThan(0.75);
  });

  it('completes more tasks successfully as well as more cheaply', () => {
    // Cheaper by picking something that fails more often would be no bargain.
    expect(explore.successes).toBeGreaterThan(exploit.successes);
  });

  it('converges: exploration stops once the answer is known', () => {
    // The property that makes this a bandit rather than a permanent tax.
    const last = explore.exploredAt[explore.exploredAt.length - 1] ?? 0;

    expect(explore.explorations).toBeLessThan(ROUNDS * 0.1);
    expect(last).toBeLessThan(ROUNDS / 2);
  });

  it('spends its experiments early, then commits', () => {
    expect(explore.exploredAt.every((round) => round < 50)).toBe(true);
  });
});

describe('the result is robust, not a tuned coincidence', () => {
  it.each([1, 1.5, 2, 2.5])('holds at optimism %s', (optimism) => {
    const explore = run({ ...EXPLORING, optimism });
    const exploit = run(EXPLORATION_DISABLED);

    expect(explore.finalChoice).toBe('sim/sleeper');
    expect(explore.totalCost).toBeLessThan(exploit.totalCost);
  });

  it('holds over a shorter run, so the gain is not an artefact of length', () => {
    const explore = run(EXPLORING, 100);
    const exploit = run(EXPLORATION_DISABLED, 100);

    expect(explore.totalCost).toBeLessThan(exploit.totalCost);
  });

  it('is deterministic — the same simulation twice, the same numbers', () => {
    expect(run(EXPLORING)).toEqual(run(EXPLORING));
  });
});

describe('the safety gates hold inside a full run', () => {
  it.each(['production', 'critical'] as const)('never explores in %s mode', (mode) => {
    const guarded = simulate({
      rounds: ROUNDS,
      exploration: EXPLORING,
      learning: LEARNING,
      features: FEATURES,
      policy: POLICY,
      mode,
    });

    expect(guarded.explorations).toBe(0);
    expect(guarded.picks['sim/sleeper']).toBeUndefined();
    // The identical environment in normal mode does explore, so zero here is a
    // consequence of the mode and not of the fixture being unexplorable.
    expect(run(EXPLORING).explorations).toBeGreaterThan(0);
  });

  it('never explores when the user pinned a model', () => {
    const pinned = simulate({
      rounds: ROUNDS,
      exploration: EXPLORING,
      learning: LEARNING,
      features: FEATURES,
      policy: POLICY,
      requestedModelId: 'sim/steady',
    });

    expect(pinned.explorations).toBe(0);
    expect(pinned.picks['sim/steady']).toBe(ROUNDS);
  });

  it('never explores on a hazardous task, over three hundred tasks', () => {
    const hazardousTask = {
      rounds: ROUNDS,
      learning: LEARNING,
      features: featuresFor('delete the stale user records in production'),
      policy: policy({ minimumSuccessProbability: 0.4, maxRisk: 1 }),
    };

    const withExploration = simulate({ ...hazardousTask, exploration: EXPLORING });
    const withoutExploration = simulate({ ...hazardousTask, exploration: EXPLORATION_DISABLED });

    expect(withExploration.explorations).toBe(0);
    // Not merely "did not explore": routing on a hazardous task is
    // indistinguishable from routing with exploration switched off entirely.
    // Which model exploitation happens to prefer is beside the point.
    expect(withExploration).toEqual(withoutExploration);
  });

  it('never explores when exploration is disabled, over three hundred tasks', () => {
    expect(run(EXPLORATION_DISABLED).explorations).toBe(0);
  });

  it('never explores before the observation minimum is reached', () => {
    // A minimum beyond the length of the run means the gate never opens.
    const gated = run({ ...EXPLORING, minimumObservations: ROUNDS + 1 });

    expect(gated.explorations).toBe(0);
    expect(gated.finalChoice).toBe('sim/steady');
  });
});
