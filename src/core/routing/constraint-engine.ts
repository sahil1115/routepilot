/**
 * Hard constraint filter (spec section 12).
 *
 * Runs before any scoring. Its job is to guarantee that an impossible model is
 * never selected — not to prefer one model over another. Scoring happens
 * afterwards, on survivors only.
 *
 * The registry already implements the mechanics of exclusion. What this adds is
 * the step before it: deciding what a task actually *requires*, so that a model
 * without tools is excluded from a task that must edit files, and is not
 * excluded from one that merely explains code.
 */

import type { ModelRegistry } from '../registry/model-registry.js';
import type { EligibilityResult, ModelRequirements } from '../types/eligibility.js';
import type { ModelCapabilities } from '../types/model.js';
import type { RoutingFeatures } from '../types/features.js';
import type { TaskType } from '../types/task.js';

/**
 * Task types that only read a workspace.
 *
 * They need tools to look at files, but never drive an agentic edit loop.
 */
const READ_ONLY_TASKS: ReadonlySet<TaskType> = new Set<TaskType>(['explanation', 'investigation']);

/**
 * Task types that need neither tools nor agentic execution.
 *
 * A single-shot completion is a plain generation request.
 */
const SELF_CONTAINED_TASKS: ReadonlySet<TaskType> = new Set<TaskType>(['autocomplete']);

/**
 * The capabilities a task genuinely requires.
 *
 * Deliberately minimal. Over-requiring capabilities silently narrows the
 * candidate set and pushes work towards expensive models for no reason, which
 * is exactly the failure mode RoutePilot exists to avoid.
 */
export function deriveRequiredCapabilities(taskType: TaskType): Partial<ModelCapabilities> {
  if (SELF_CONTAINED_TASKS.has(taskType)) return {};
  if (READ_ONLY_TASKS.has(taskType)) return { toolUse: true };
  // Everything else modifies the workspace, which needs both.
  return { toolUse: true, agenticExecution: true };
}

/** Inputs to the hard filter beyond the task itself. */
export interface ConstraintOptions {
  /** Capabilities the caller insists on, merged over the derived ones. */
  readonly requiredCapabilities?: Readonly<Partial<ModelCapabilities>> | undefined;
  /** Models already tried, or otherwise ruled out by the caller. */
  readonly excludeModelIds?: readonly string[] | undefined;
  /** Models the caller has explicitly opted into. */
  readonly optInModelIds?: readonly string[] | undefined;
  /** Restrict to these providers. */
  readonly providerIds?: readonly string[] | undefined;
  /** Whether degraded models remain eligible. Defaults to true. */
  readonly allowDegraded?: boolean | undefined;
}

/** Applies the hard constraints for a request. */
export class ConstraintEngine {
  readonly #models: ModelRegistry;

  constructor(models: ModelRegistry) {
    this.#models = models;
  }

  /** Build the requirements a request imposes on a model. */
  buildRequirements(features: RoutingFeatures, options: ConstraintOptions = {}): ModelRequirements {
    const requiredCapabilities: Partial<ModelCapabilities> = {
      ...deriveRequiredCapabilities(features.task.taskType),
      ...options.requiredCapabilities,
    };

    return {
      requiredCapabilities,
      // The context requirement already carries a safety margin, so a model
      // that only just fits is treated as not fitting.
      requiredContextTokens: features.context.contextRequirement,
      requiredOutputTokens: features.context.estimatedOutputTokens,
      ...(options.excludeModelIds === undefined
        ? {}
        : { excludeModelIds: options.excludeModelIds }),
      ...(options.optInModelIds === undefined ? {} : { optInModelIds: options.optInModelIds }),
      ...(options.providerIds === undefined ? {} : { providerIds: options.providerIds }),
      ...(options.allowDegraded === undefined ? {} : { allowDegraded: options.allowDegraded }),
    };
  }

  /** Apply the hard filter, returning survivors and reasoned exclusions. */
  filter(features: RoutingFeatures, options: ConstraintOptions = {}): EligibilityResult {
    return this.#models.findEligible(this.buildRequirements(features, options));
  }
}
