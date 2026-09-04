/**
 * Learned success model (spec sections 35, 36, 37 and 39).
 *
 * Learns `P(success | features, model)` online and hands the result to the same
 * expected-cost arithmetic that already decides routes.
 *
 * Observations are stored per bucket and read back as a chain, each level
 * shrunk toward the one above:
 *
 * ```
 * configured prior
 *   -> this model on OTHER task types     (general competence)
 *   -> this task type, OTHER scopes       (competence at this kind of work)
 *   -> this exact bucket                  (competence at exactly this)
 * ```
 *
 * No level needs a minimum of its own: one with no data shrinks completely into
 * its parent and contributes nothing (spec section 37).
 *
 * The levels partition the data rather than nesting. Each counts only what the
 * deeper levels exclude, so every observation enters the chain once. Letting
 * each level aggregate everything beneath it would feed the same observations
 * through the shrinkage repeatedly, producing confidence that grows with the
 * depth of the hierarchy instead of with the evidence.
 *
 * Not a bandit: no exploration term, no optimism, no randomisation, so routing
 * stays deterministic (principle 9). No time decay either -- it would put a
 * clock in the estimate path and make a decision depend on when it was made.
 * The cost is that a model which silently regresses is learned slowly.
 */

import type {
  LearnedEstimate,
  LearnedLevel,
  LearnedStats,
  LearningContext,
  LearningStore,
  Observation,
} from '../types/learning.js';
import type { TaskScope } from '../types/features.js';
import type { TaskType } from '../types/task.js';
import type { TaskOutcome } from '../types/outcome.js';
import type { TaskSuccessScore } from '../types/outcome.js';
import type { CalibrationVerdict } from '../types/calibration.js';
import { NOT_ASSESSED } from '../calibration/gate.js';
import { observedRate, shrinkToPrior } from './beta-model.js';

/**
 * How many observations each prior is worth.
 *
 * 12 is a deliberate compromise. Lower, and a handful of unlucky runs would
 * swing routing; higher, and a genuinely wrong prior would take hundreds of
 * observations to correct. At 12, a model needs roughly a dozen consistent
 * results before it meaningfully disagrees with its configuration — about the
 * point where a human reviewing the same data would also start to believe it.
 */
export const DEFAULT_PRIOR_STRENGTH = 12;

/**
 * Minimum evidence for an outcome to be admitted.
 *
 * An outcome scored on a fifth of the available evidence is a rumour. Admitting
 * it would let unvalidated runs dominate the counts, and the counts are what
 * `minimumTrainingSamples` gates on — so weak evidence would buy false
 * confidence twice over.
 */
export const MINIMUM_EVIDENCE = 0.25;

/** How the learned model may be used. */
export interface LearningPolicy {
  /** Whether learned estimates may influence routing at all. */
  readonly enabled: boolean;
  /**
   * Observations required for this model before its learned estimate is used.
   *
   * Counted across all task types for the model. Below it, the configured prior
   * is returned untouched (spec section 2, rule 12).
   */
  readonly minimumTrainingSamples: number;
  /** How many observations a prior is worth. */
  readonly priorStrength?: number | undefined;
}

/** Learning switched off — the configuration default. */
export const LEARNING_DISABLED: LearningPolicy = {
  enabled: false,
  minimumTrainingSamples: Number.POSITIVE_INFINITY,
};

/** A learning store that persists nothing, for when telemetry is disabled. */
export class NullLearningStore implements LearningStore {
  readonly enabled = false;
  loadLearnedStats(): readonly LearnedStats[] {
    return [];
  }
  saveLearnedStats(_stats: readonly LearnedStats[]): void {}
}

/** In-memory statistics keyed by the finest granularity. */
type Bucket = { observations: number; successMass: number; updatedAt: number };

/**
 * Online estimator for `P(success | features, model)`.
 *
 * Statistics live in memory and are written through to the store, so a routing
 * decision never waits on I/O and a store failure never fails a task.
 */
export class LearnedSuccessModel {
  readonly #store: LearningStore;
  readonly #policy: LearningPolicy;
  readonly #strength: number;
  readonly #calibration: CalibrationVerdict;
  /** Finest-granularity buckets, keyed `modelId\ntaskType\nscope`. */
  readonly #buckets = new Map<string, Bucket>();

  /**
   * @param calibration The safeguard's verdict on this predictor. Defaults to
   *   `NOT_ASSESSED`, which permits learning under the training minimum alone —
   *   the Phase 10 behaviour, unchanged until a verdict is actually supplied.
   */
  constructor(
    store: LearningStore = new NullLearningStore(),
    policy: LearningPolicy = LEARNING_DISABLED,
    calibration: CalibrationVerdict = NOT_ASSESSED,
  ) {
    this.#store = store;
    this.#policy = policy;
    this.#calibration = calibration;
    this.#strength = policy.priorStrength ?? DEFAULT_PRIOR_STRENGTH;

    for (const stats of store.loadLearnedStats()) {
      // Reject anything that would corrupt the arithmetic. A store can be
      // hand-edited, and a negative count would produce a nonsense estimate
      // rather than an obvious failure.
      if (!isUsable(stats)) continue;
      this.#buckets.set(keyOf(stats), {
        observations: stats.observations,
        successMass: stats.successMass,
        updatedAt: stats.updatedAt,
      });
    }
  }

  /** Whether learning is switched on. Independent of whether it has enough data. */
  get enabled(): boolean {
    return this.#policy.enabled;
  }

  /** The calibration verdict this model is operating under. */
  get calibration(): CalibrationVerdict {
    return this.#calibration;
  }

  /**
   * How much evidence stands behind a model's estimate, prior included.
   *
   * This is the Beta posterior's concentration: the prior's pseudo-count plus
   * the real observations. The bandit needs it to size its confidence bound,
   * and it is deliberately **not** a sample count — `strength` is imaginary
   * evidence and is never reported as data (spec section 2, rule 11).
   */
  concentration(modelId: string): number {
    return this.#strength + this.#modelTotals(modelId).observations;
  }

  /** Total real observations held, across every model. */
  get totalObservations(): number {
    let total = 0;
    for (const bucket of this.#buckets.values()) total += bucket.observations;
    return total;
  }

  /**
   * Record one observation and persist it.
   *
   * `at` is supplied rather than read from a clock so that a replay is
   * reproducible and the estimate path stays free of time.
   */
  observe(observation: Observation, at: number): void {
    if (
      !Number.isFinite(observation.success) ||
      observation.success < 0 ||
      observation.success > 1
    ) {
      throw new RangeError(`success must be within [0, 1] (got ${observation.success})`);
    }

    const key = keyOf(observation);
    const existing = this.#buckets.get(key);
    const updated: Bucket = {
      observations: (existing?.observations ?? 0) + 1,
      successMass: (existing?.successMass ?? 0) + observation.success,
      updatedAt: at,
    };
    this.#buckets.set(key, updated);

    this.#store.saveLearnedStats([{ ...toContext(key), ...updated }]);
  }

  /** Record many observations, persisting once. */
  observeAll(observations: readonly Observation[], at: number): void {
    if (observations.length === 0) return;

    const touched = new Set<string>();
    for (const observation of observations) {
      const key = keyOf(observation);
      const existing = this.#buckets.get(key);
      this.#buckets.set(key, {
        observations: (existing?.observations ?? 0) + 1,
        successMass: (existing?.successMass ?? 0) + observation.success,
        updatedAt: at,
      });
      touched.add(key);
    }

    this.#store.saveLearnedStats(this.#snapshot(touched));
  }

  /**
   * Adjust a static estimate with what has been observed.
   *
   * Returns the static probability untouched whenever learning is off, has too
   * little data, or has none for this model — and says which in `reason`.
   */
  estimate(staticProbability: number, context: LearningContext): LearnedEstimate {
    const modelObservations = this.#modelTotals(context.modelId).observations;

    const unchanged = (reason: string): LearnedEstimate => ({
      probability: staticProbability,
      staticProbability,
      applied: false,
      observations: modelObservations,
      levels: [],
      reason,
    });

    if (!this.#policy.enabled) return unchanged('learning is disabled');

    // The calibration safeguard, checked before the data is consulted. A
    // predictor whose probabilities have been measured and found wrong must not
    // reach the expected-cost arithmetic, however many observations back it —
    // volume of evidence is not the same as quality of prediction
    // (spec section 41).
    if (!this.#calibration.mayApply) return unchanged(this.#calibration.reason);

    if (modelObservations === 0) return unchanged('no observations for this model');
    if (modelObservations < this.#policy.minimumTrainingSamples) {
      return unchanged(
        `only ${String(modelObservations)} of ${String(this.#policy.minimumTrainingSamples)} required observations`,
      );
    }

    // Shrink down the hierarchy, each level's prior being the level above.
    const levels: LearnedLevel[] = [];
    let prior = staticProbability;

    for (const level of LEVELS) {
      const totals = this.#partition(context, level);
      const posterior = shrinkToPrior({
        prior,
        strength: this.#strength,
        observations: totals.observations,
        successMass: totals.successMass,
      });
      levels.push({
        level,
        observations: totals.observations,
        observedRate: observedRate(totals.observations, totals.successMass),
        posterior,
      });
      prior = posterior;
    }

    return {
      probability: prior,
      staticProbability,
      applied: true,
      observations: modelObservations,
      levels,
      reason: `learned from ${String(modelObservations)} observations`,
    };
  }

  /** Every bucket, in a deterministic order. For inspection and persistence. */
  snapshot(): readonly LearnedStats[] {
    return this.#snapshot(new Set(this.#buckets.keys()));
  }

  /**
   * Sum the buckets belonging to exactly one level of the chain.
   *
   * The three levels are disjoint and together cover every observation for the
   * model. That invariant is asserted in the tests, because it is what stops
   * the same evidence being counted once per level.
   */
  #partition(
    context: LearningContext,
    level: Level,
  ): { observations: number; successMass: number } {
    let observations = 0;
    let successMass = 0;

    for (const [key, bucket] of this.#buckets) {
      const [modelId, taskType, scope, language] = splitKey(key);
      if (modelId !== context.modelId) continue;

      const sameTask = taskType === context.taskType;
      const sameScope = scope === context.scope;
      const sameLanguage = language === context.language;
      const belongs =
        level === 'model'
          ? !sameTask
          : level === 'task'
            ? sameTask && !sameScope
            : level === 'scope'
              ? sameTask && sameScope && !sameLanguage
              : sameTask && sameScope && sameLanguage;

      if (!belongs) continue;
      observations += bucket.observations;
      successMass += bucket.successMass;
    }

    return { observations, successMass };
  }

  /** Total observations held for one model, across every task type and scope. */
  #modelTotals(modelId: string): { observations: number; successMass: number } {
    let observations = 0;
    let successMass = 0;

    for (const [key, bucket] of this.#buckets) {
      if (splitKey(key)[0] !== modelId) continue;
      observations += bucket.observations;
      successMass += bucket.successMass;
    }

    return { observations, successMass };
  }

  #snapshot(keys: ReadonlySet<string>): readonly LearnedStats[] {
    return [...keys]
      .sort()
      .map((key) => {
        const bucket = this.#buckets.get(key);
        return bucket === undefined ? null : { ...toContext(key), ...bucket };
      })
      .filter((entry): entry is LearnedStats => entry !== null);
  }
}

/**
 * Backoff levels, coarsest first.
 *
 * `language` was inserted as the deepest level in Phase 25. The three above it
 * keep their exact meanings; what changed is that the most specific bucket is
 * now language-aware, and "same task, same scope, a different language" became
 * a level of its own rather than disappearing.
 *
 * That last part is the whole reason this is a fourth level and not a redefined
 * third: the levels must **partition** the model's observations. If a bucket
 * belonged to no level its evidence would vanish, and if it belonged to two it
 * would be counted twice -- the Phase 10 bug, in both directions.
 */
const LEVELS = ['model', 'task', 'scope', 'language'] as const;

/** One level of the backoff chain. */
type Level = (typeof LEVELS)[number];

/**
 * Bucket key.
 *
 * A newline separator, because no model id, task type or scope may contain one
 * — model ids are validated identifiers and the other two are enumerations —
 * so a key can always be split back into exactly its three parts.
 */
function keyOf(context: LearningContext): string {
  return `${context.modelId}\n${context.taskType}\n${context.scope}\n${context.language}`;
}

function splitKey(key: string): [string, string, string, string] {
  const [
    modelId = '',
    taskType = 'unknown',
    scope = 'single-file',
    // Keys written before language joined the key have three parts. They read
    // back as `unknown`, which is exactly where a language-blind observation
    // belongs, rather than being silently attributed to one language.
    language = UNKNOWN_LANGUAGE,
  ] = key.split('\n');
  return [modelId, taskType, scope, language];
}

function toContext(key: string): LearningContext {
  const [modelId, taskType, scope, language] = splitKey(key);
  return { modelId, taskType: taskType as TaskType, scope: scope as TaskScope, language };
}

/**
 * The language of a repository nobody could identify.
 *
 * A real value rather than null, because it is a legitimate bucket: an
 * observation from a repository with no dominant language is still evidence
 * about the model, and dropping it would lose data to tidiness.
 */
export const UNKNOWN_LANGUAGE = 'unknown';

/** Normalise a language for use as a key. */
export function learningLanguage(language: string | null | undefined): string {
  const trimmed = language?.trim().toLowerCase() ?? '';
  return trimmed === '' ? UNKNOWN_LANGUAGE : trimmed;
}

function isUsable(stats: LearnedStats): boolean {
  return (
    Number.isInteger(stats.observations) &&
    stats.observations >= 0 &&
    Number.isFinite(stats.successMass) &&
    stats.successMass >= 0 &&
    stats.successMass <= stats.observations
  );
}

/**
 * Derive an observation from a scored outcome, or refuse to.
 *
 * Returns `null` — meaning "this teaches us nothing about any single model" —
 * in four cases, each required by the specification:
 *
 * - **Not model-attributable.** A provider outage or a broken environment says
 *   nothing about model capability (spec section 2, rule 10).
 * - **Nothing was evaluated.** `score === null` is unknown, not failure.
 *   Recording it as a zero would slander every model it touched.
 * - **Too little evidence.** See {@link MINIMUM_EVIDENCE}.
 * - **More than one model was involved.** After an escalation there is no
 *   honest way to say which model's work produced the result. Splitting the
 *   credit would be inventing data; assigning it to one of them would be worse.
 *   This is a real limitation of Phase 10, not an oversight.
 */
export function observationFromOutcome(
  outcome: TaskOutcome,
  score: TaskSuccessScore,
): Observation | null {
  if (!score.modelAttributable) return null;
  if (score.score === null) return null;
  if (score.evidence < MINIMUM_EVIDENCE) return null;
  if (outcome.escalationCount > 0) return null;
  if (outcome.modelsUsed.length !== 1) return null;

  const modelId = outcome.modelsUsed[0];
  if (modelId === undefined) return null;

  return {
    modelId,
    taskType: outcome.taskType,
    scope: outcome.scope,
    language: learningLanguage(outcome.primaryLanguage),
    success: score.score,
    evidence: score.evidence,
  };
}
