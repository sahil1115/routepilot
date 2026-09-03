/**
 * A synthetic bandit environment with known ground truth.
 *
 * "Use synthetic simulations before real activation." Exploration deliberately
 * spends money on a model the router does not currently believe is best, so
 * before that is allowed anywhere near a real workspace it has to be shown, in
 * a world where the right answer is known, that it pays for itself and then
 * stops.
 *
 * ## The scenario
 *
 * | model | prior | **true rate** | first attempt |
 * | --- | --- | --- | --- |
 * | `sim/steady` | 0.92 | 0.90 | 0.135 |
 * | `sim/sleeper` | 0.55 | **0.98** | 0.090 |
 *
 * The gap matters. An earlier version of this fixture had the two arms within
 * 0.0001 of each other on expected cost, which made each trivially "plausibly
 * better" than the other: the bandit alternated forever, reported an
 * experiment on 95 rounds out of 100, and demonstrated nothing. Arms that are
 * genuinely equivalent make a bandit look broken while it is behaving
 * correctly, so the fixture separates them.
 *
 * `steady` is honestly configured and perfectly adequate. `sleeper` is cheaper
 * *and* better, and its pessimistic prior means expected-cost routing will
 * never choose it — so it is never run, so nothing is ever learned about it.
 * Exploitation alone is stuck at a local optimum forever, and no amount of data
 * about `steady` can reveal that, because the data that would is never
 * collected.
 *
 * That is the precise situation a bandit exists for, and it is why the
 * simulation measures **total cost over a run of tasks** rather than the
 * quality of any single decision. Exploration always loses on the first task.
 * The question is whether it wins over a hundred.
 *
 * Everything is deterministic — successes are spread by even spacing, never
 * drawn — so the whole simulation produces identical numbers on every run.
 *
 * Excluded from the published build (see tsconfig.build.json).
 */

import { LearnedSuccessModel, type LearningPolicy } from '../core/learning/success-model.js';
import { ModelRegistry } from '../core/registry/model-registry.js';
import { RoutingEngine } from '../core/routing/routing-engine.js';
import type { ExplorationPolicy, OperationMode } from '../core/bandit/exploration-gate.js';
import type { ModelSpec } from '../core/types/model.js';
import type { RoutingFeatures } from '../core/types/features.js';
import type { RoutingPolicy } from '../core/types/routing.js';
import { makeModel } from './fixtures.js';
import { InMemoryLearningStore } from './learning-fixtures.js';

/** Honestly configured, genuinely adequate, and slightly expensive. */
export function steadyArm(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return makeModel({
    id: 'sim/steady',
    modelId: 'steady',
    displayName: 'Sim Steady',
    tier: 'medium',
    contextWindow: 400_000,
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    priors: { skills: { codeGeneration: 0.92 }, languages: {} },
    ...overrides,
  });
}

/**
 * Cheaper and better than it claims, and therefore never chosen.
 *
 * The arm exploitation cannot find, because finding it requires trying it.
 */
export function sleeperArm(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return makeModel({
    id: 'sim/sleeper',
    modelId: 'sleeper',
    displayName: 'Sim Sleeper',
    tier: 'medium',
    contextWindow: 400_000,
    // Two thirds the price of `steady`, with a prior pessimistic enough that
    // expected-cost routing puts it behind (0.156 against 0.146) yet still
    // *viable*. Both halves matter: a candidate below the confidence threshold
    // is not an exploration target at all, so a prior any lower would make the
    // scenario untestable rather than merely unattractive.
    pricing: { inputPerMillion: 2, outputPerMillion: 10, currency: 'USD' },
    priors: { skills: { codeGeneration: 0.58 }, languages: {} },
    ...overrides,
  });
}

/** Ground truth the router is never told. */
export const TRUE_RATES: Readonly<Record<string, number>> = {
  'sim/steady': 0.9,
  'sim/sleeper': 0.98,
};

/** What one simulation run produced. */
export interface SimulationResult {
  /** Tasks routed. */
  readonly rounds: number;
  /** Rounds on which the bandit chose to experiment. */
  readonly explorations: number;
  /**
   * Total cost actually incurred, counting a retry for every failure.
   *
   * The measure that matters: a policy that picks a cheap model which fails
   * half the time has not saved anything.
   */
  readonly totalCost: number;
  /** Successful tasks. */
  readonly successes: number;
  /** How often each model was chosen. */
  readonly picks: Readonly<Record<string, number>>;
  /** The model chosen on the final round. */
  readonly finalChoice: string | null;
  /** Rounds on which exploration happened, earliest first. */
  readonly exploredAt: readonly number[];
}

/** Options for {@link simulate}. */
export interface SimulationOptions {
  readonly rounds: number;
  readonly exploration: ExplorationPolicy;
  readonly learning: LearningPolicy;
  readonly features: RoutingFeatures;
  readonly policy: RoutingPolicy;
  readonly models?: readonly ModelSpec[] | undefined;
  readonly trueRates?: Readonly<Record<string, number>> | undefined;
  /** Operation mode every request is routed under. Defaults to `normal`. */
  readonly mode?: OperationMode | undefined;
  /** A model the user pinned, so the explicit-model block can be exercised. */
  readonly requestedModelId?: string | undefined;
}

/**
 * Route and execute `rounds` tasks in a world with known success rates.
 *
 * Each round routes, "executes" the chosen model against its true rate, records
 * the outcome, and moves on — so learning accumulates exactly as it would in
 * production, and exploration's cost and benefit both land in `totalCost`.
 */
export function simulate(options: SimulationOptions): SimulationResult {
  const models = options.models ?? [steadyArm(), sleeperArm()];
  const trueRates = options.trueRates ?? TRUE_RATES;
  const registry = new ModelRegistry(models);

  const store = new InMemoryLearningStore();
  const learned = new LearnedSuccessModel(store, options.learning);
  const engine = new RoutingEngine(registry, learned, options.exploration);

  // Per-model attempt counters drive deterministic success: the k-th attempt on
  // a model succeeds exactly when the running rate crosses an integer.
  const attempts = new Map<string, number>();
  const picks: Record<string, number> = {};
  const exploredAt: number[] = [];

  let totalCost = 0;
  let successes = 0;
  let explorations = 0;
  let finalChoice: string | null = null;

  for (let round = 0; round < options.rounds; round += 1) {
    const decision = engine.route({
      features: options.features,
      policy: options.policy,
      operationMode: options.mode ?? 'normal',
      ...(options.requestedModelId === undefined
        ? {}
        : { requestedModelId: options.requestedModelId }),
    });

    finalChoice = decision.selectedModelId;
    if (finalChoice === null) continue;

    if (decision.exploration.explored) {
      explorations += 1;
      exploredAt.push(round);
    }

    const evaluation = decision.evaluations.find((entry) => entry.modelId === finalChoice);
    if (evaluation === undefined) continue;

    picks[finalChoice] = (picks[finalChoice] ?? 0) + 1;

    const index = attempts.get(finalChoice) ?? 0;
    attempts.set(finalChoice, index + 1);

    const rate = trueRates[finalChoice] ?? 0;
    const succeeded = Math.floor((index + 1) * rate) > Math.floor(index * rate);

    // A failure costs the attempt and one retry. Crude, but it is the same
    // crude rule for every policy, so the comparison stays fair.
    totalCost += succeeded ? evaluation.cost.initial : evaluation.cost.initial * 2;
    if (succeeded) successes += 1;

    learned.observe(
      {
        modelId: finalChoice,
        taskType: options.features.task.taskType,
        scope: options.features.task.scope,
        language: 'unknown',
        success: succeeded ? 1 : 0,
        evidence: 1,
      },
      1_000 + round,
    );
  }

  return {
    rounds: options.rounds,
    explorations,
    totalCost,
    successes,
    picks,
    finalChoice,
    exploredAt,
  };
}
