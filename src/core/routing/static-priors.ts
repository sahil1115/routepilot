/**
 * Static cold-start priors (spec sections 13 and 35).
 *
 * Before any outcome has been observed, routing runs entirely on these tables.
 * They are priors -- informed defaults, not measurements -- kept here as data so
 * they can be read, argued with and replaced without touching routing logic.
 *
 * Section 13 gives the intended shape: simple explanation and documentation to
 * cheap models, ordinary features and debugging to medium, architecture and
 * large migrations to frontier. The router is expected to agree with that
 * table, but reaches its answer through expected cost to success rather than by
 * reading a tier out of this file.
 */

import { MODEL_TIERS, type ModelTier, type SkillDimension } from '../types/model.js';
import type { TaskScope } from '../types/features.js';
import type { TaskType } from '../types/task.js';

/**
 * Baseline success probability by tier, used when a model declares no prior
 * for the skill a task needs.
 *
 * A missing prior means "unknown", and the honest stand-in for unknown is the
 * tier's typical behaviour — not zero, and not the optimistic assumption that
 * the model is excellent at everything (spec section 39).
 */
export const TIER_BASELINE_CAPABILITY: Record<ModelTier, number> = {
  cheap: 0.62,
  medium: 0.8,
  frontier: 0.9,
  ultra: 0.93,
};

/** Ordering of tiers from least to most capable. */
export const TIER_ORDER: readonly ModelTier[] = MODEL_TIERS;

/** Numeric rank of a tier, for comparisons. */
export function tierRank(tier: ModelTier): number {
  return TIER_ORDER.indexOf(tier);
}

/**
 * The skill dimension each task type primarily exercises.
 *
 * This is what connects a classified task to a model's declared strengths.
 */
export const PRIMARY_SKILL_BY_TASK: Record<TaskType, SkillDimension> = {
  explanation: 'reasoning',
  documentation: 'documentation',
  autocomplete: 'codeGeneration',
  'simple-edit': 'codeEditing',
  rename: 'codeEditing',
  formatting: 'codeEditing',
  'test-generation': 'testGeneration',
  'bug-fix': 'debugging',
  debugging: 'debugging',
  'feature-implementation': 'codeGeneration',
  refactoring: 'refactoring',
  'multi-file-refactoring': 'multiFileReasoning',
  architecture: 'architecture',
  migration: 'multiFileReasoning',
  'performance-optimization': 'reasoning',
  security: 'reasoning',
  investigation: 'reasoning',
  unknown: 'reasoning',
};

/**
 * The tier spec section 13 suggests for each task type.
 *
 * Used for explanation and as a deterministic tie-break, never as a hard
 * constraint — the optimisation target is expected cost to success, and a
 * cheap model that reliably succeeds should win regardless of this table.
 */
const TIER_PRIOR_BY_TASK: Record<TaskType, ModelTier> = {
  explanation: 'cheap',
  documentation: 'cheap',
  autocomplete: 'cheap',
  'simple-edit': 'cheap',
  rename: 'cheap',
  formatting: 'cheap',
  'test-generation': 'cheap',
  'bug-fix': 'medium',
  debugging: 'medium',
  'feature-implementation': 'medium',
  refactoring: 'medium',
  investigation: 'medium',
  'multi-file-refactoring': 'frontier',
  architecture: 'frontier',
  security: 'frontier',
  'performance-optimization': 'frontier',
  migration: 'frontier',
  unknown: 'medium',
};

/** How much of the repository a task touches, as a difficulty contribution. */
export const SCOPE_DIFFICULTY: Record<TaskScope, number> = {
  'single-file': 0.1,
  'few-files': 0.35,
  'many-files': 0.7,
  'repository-wide': 1.0,
};

/**
 * The tier the static prior suggests, after adjusting for scope.
 *
 * Breadth raises the suggestion: a refactor of one file and a refactor of the
 * whole repository are not the same job even though they classify the same way.
 */
export function staticTierPrior(taskType: TaskType, scope: TaskScope): ModelTier {
  const base = TIER_PRIOR_BY_TASK[taskType];
  const bump = scope === 'repository-wide' ? 1 : scope === 'many-files' ? 1 : 0;
  const index = Math.min(TIER_ORDER.length - 1, tierRank(base) + bump);
  return TIER_ORDER[index] ?? base;
}
