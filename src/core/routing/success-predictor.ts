/**
 * Static success prediction (spec sections 13, 14 and 35).
 *
 * Answers "how likely is this model to complete this task" using nothing but
 * configured priors. There is no learning here — learned estimates arrive in
 * Phase 12, and until enough observations exist they must not be pretended into
 * existence (spec section 35).
 *
 * The model is deliberately simple enough to explain in one sentence:
 *
 *     failure probability = (1 − capability) × how demanding the task is
 *
 * so a capable model fails rarely on easy work and more often on hard work, and
 * a weak model degrades faster as difficulty rises. That shape is what makes
 * cheap models win trivial tasks and lose hard ones without any tier being
 * hard-coded into the routing logic.
 */

import type { RoutingFeatures } from '../types/features.js';
import type { ModelSpec } from '../types/model.js';
import {
  PRIMARY_SKILL_BY_TASK,
  SCOPE_DIFFICULTY,
  TIER_BASELINE_CAPABILITY,
} from './static-priors.js';

/** A success estimate and the reasoning behind it. */
export interface SuccessEstimate {
  /** Probability in (0, 1). Never 0 or 1 — certainty is never claimed. */
  readonly probability: number;
  /** How well the model's declared strengths match the task, in [0, 1]. */
  readonly capabilityFit: number;
  /** How demanding the task is, in [0, 1]. */
  readonly difficulty: number;
  /** True when the model declared no prior for this task's skill. */
  readonly usedTierDefault: boolean;
}

/**
 * Weight of the language prior relative to the skill prior.
 *
 * Skill dominates: being good at debugging matters more than the language it
 * happens in, but a model weak in a language is genuinely handicapped.
 */
const LANGUAGE_WEIGHT = 0.3;

/** Difficulty contributions. They sum to 1. */
const DIFFICULTY_WEIGHTS = {
  reasoning: 0.35,
  scope: 0.25,
  repository: 0.15,
  risk: 0.1,
  ambiguity: 0.1,
  novelty: 0.05,
} as const;

/**
 * How much difficulty multiplies the base failure rate.
 *
 * At difficulty 0 a model fails at a quarter of its base rate; at difficulty 1,
 * at twice it. Chosen so a cheap model clears a rename comfortably and clearly
 * fails an architecture task.
 */
const MIN_DIFFICULTY_MULTIPLIER = 0.25;
const MAX_DIFFICULTY_MULTIPLIER = 2.0;

/** Bounds on the reported probability. Certainty is never claimed either way. */
const MIN_PROBABILITY = 0.01;
const MAX_PROBABILITY = 0.99;

/** Context pressure above this fraction of the window starts to hurt. */
const CONTEXT_PRESSURE_THRESHOLD = 0.7;

/** Predicts task success from configured priors alone. */
export class SuccessPredictor {
  /** Estimate the probability that `model` completes the task described by `features`. */
  estimate(model: ModelSpec, features: RoutingFeatures): SuccessEstimate {
    const { capabilityFit, usedTierDefault } = this.#capabilityFit(model, features);
    const difficulty = this.difficulty(features);

    const baseFailure = 1 - capabilityFit;
    const multiplier =
      MIN_DIFFICULTY_MULTIPLIER +
      (MAX_DIFFICULTY_MULTIPLIER - MIN_DIFFICULTY_MULTIPLIER) * difficulty;

    let probability = 1 - baseFailure * multiplier;

    // Running close to the context limit degrades quality well before it
    // overflows, so pressure is penalised rather than ignored.
    probability -= this.#contextPenalty(model, features);

    return {
      probability: clamp(probability, MIN_PROBABILITY, MAX_PROBABILITY),
      capabilityFit,
      difficulty,
      usedTierDefault,
    };
  }

  /**
   * How demanding the task is, in [0, 1].
   *
   * Independent of any model, so every candidate is judged against the same
   * task — which is what keeps comparisons meaningful.
   */
  difficulty(features: RoutingFeatures): number {
    const { task, repository } = features;

    const repositoryComplexity = clamp(
      // Log scale: the step from 100 to 1,000 files matters more than
      // 10,000 to 11,000.
      Math.log10(Math.max(1, repository.fileCount)) / 4 + (repository.isMonorepo ? 0.15 : 0),
      0,
      1,
    );

    const weighted =
      DIFFICULTY_WEIGHTS.reasoning * task.reasoningRequirement +
      DIFFICULTY_WEIGHTS.scope * SCOPE_DIFFICULTY[task.scope] +
      DIFFICULTY_WEIGHTS.repository * repositoryComplexity +
      DIFFICULTY_WEIGHTS.risk * task.risk +
      DIFFICULTY_WEIGHTS.ambiguity * task.ambiguity +
      DIFFICULTY_WEIGHTS.novelty * task.novelty;

    return clamp(weighted, 0, 1);
  }

  /** Blend the model's skill prior for this task with its language prior. */
  #capabilityFit(
    model: ModelSpec,
    features: RoutingFeatures,
  ): { capabilityFit: number; usedTierDefault: boolean } {
    const dimension = PRIMARY_SKILL_BY_TASK[features.task.taskType];
    const skillPrior = model.priors.skills[dimension];
    const usedTierDefault = skillPrior === undefined;
    const skill = skillPrior ?? TIER_BASELINE_CAPABILITY[model.tier];

    const language = features.repository.primaryLanguage;
    const languagePrior = language === null ? undefined : model.priors.languages[language];

    // An unknown language prior must not drag the estimate down; it is simply
    // no evidence, so the skill prior stands alone.
    if (languagePrior === undefined) {
      return { capabilityFit: clamp(skill, 0, 1), usedTierDefault };
    }

    return {
      capabilityFit: clamp(skill * (1 - LANGUAGE_WEIGHT) + languagePrior * LANGUAGE_WEIGHT, 0, 1),
      usedTierDefault,
    };
  }

  /** Penalty for operating near the model's context limit. */
  #contextPenalty(model: ModelSpec, features: RoutingFeatures): number {
    if (model.contextWindow <= 0) return 0;
    const pressure = features.context.contextRequirement / model.contextWindow;
    if (pressure <= CONTEXT_PRESSURE_THRESHOLD) return 0;
    // Ramps from 0 at the threshold to 0.15 at a completely full window.
    return Math.min(
      0.15,
      ((pressure - CONTEXT_PRESSURE_THRESHOLD) / (1 - CONTEXT_PRESSURE_THRESHOLD)) * 0.15,
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
