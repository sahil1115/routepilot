/**
 * Failure taxonomy (spec section 22).
 *
 * The classifier that assigns these is Phase 8. This module defines only the
 * closed vocabulary and the single invariant that matters most: which failures
 * are permitted to update beliefs about a model's ability.
 */

/** Closed set of failure classifications. */
export const FAILURE_TYPES = [
  'MODEL_WEAKNESS',
  'MISSING_CONTEXT',
  'BAD_SPECIFICATION',
  'USER_AMBIGUITY',
  'REPOSITORY_PROBLEM',
  'ENVIRONMENT_FAILURE',
  'PROVIDER_FAILURE',
  'TOOL_FAILURE',
  'FLAKY_TEST',
  'TIMEOUT',
  'CONTEXT_LIMIT',
  'BUDGET_EXCEEDED',
  'USER_CANCELLED',
  'UNKNOWN',
] as const;

/** A failure classification. */
export type FailureType = (typeof FAILURE_TYPES)[number];

/**
 * The only failure types that may update a model's quality estimate.
 *
 * A database being down, a provider outage, a flaky test or a user pressing
 * cancel says nothing about whether a model is capable. Attributing those to
 * the model is the single most damaging thing a learning router can do, so the
 * permitted set is defined here as data rather than being re-derived by each
 * consumer (spec sections 22 and 38).
 */
export const MODEL_ATTRIBUTABLE_FAILURE_TYPES: ReadonlySet<FailureType> = new Set<FailureType>([
  'MODEL_WEAKNESS',
]);

/** Whether a failure may be used as evidence about model ability. */
export function isModelAttributable(failure: FailureType): boolean {
  return MODEL_ATTRIBUTABLE_FAILURE_TYPES.has(failure);
}

/** Runtime membership test for {@link FailureType}. */
export function isFailureType(value: string): value is FailureType {
  return (FAILURE_TYPES as readonly string[]).includes(value);
}
