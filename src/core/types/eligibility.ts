/**
 * Eligibility types — the hard constraint filter's vocabulary (spec section 12).
 *
 * Phase 1 provides eligibility as a registry query. The full ConstraintEngine,
 * with scoring and expected-cost ranking, is Phase 3. What is fixed here is the
 * shape of the answer: eligibility always reports *why* a candidate was removed,
 * because every routing decision must be explainable (spec section 50).
 */

import type { ModelCapabilities, ModelSpec, ModelTier } from './model.js';

/** What a request needs from a model before it can be considered at all. */
export interface ModelRequirements {
  /**
   * Capabilities that must be present.
   *
   * Only `true` entries constrain. A `false` entry means "do not care", not
   * "must not have" — RoutePilot never excludes a model for being too capable.
   */
  readonly requiredCapabilities?: Readonly<Partial<ModelCapabilities>> | undefined;
  /** Input tokens the request needs to fit. */
  readonly requiredContextTokens?: number | undefined;
  /** Output tokens the request needs room for. */
  readonly requiredOutputTokens?: number | undefined;
  /** Restrict to these providers. */
  readonly providerIds?: readonly string[] | undefined;
  /** Restrict to these tiers. */
  readonly tiers?: readonly ModelTier[] | undefined;
  /** Registry ids to exclude, for example models already tried in this task. */
  readonly excludeModelIds?: readonly string[] | undefined;
  /**
   * Registry ids of models the caller has explicitly opted into.
   *
   * Models marked `requiresExplicitOptIn` are excluded unless listed here.
   */
  readonly optInModelIds?: readonly string[] | undefined;
  /**
   * Include models whose availability is `degraded`.
   *
   * Defaults to true: degraded is a scoring penalty, not a hard exclusion.
   */
  readonly allowDegraded?: boolean | undefined;
}

/** Closed set of reasons a model can be excluded by the hard filter. */
export const EXCLUSION_REASONS = [
  'EXPLICITLY_EXCLUDED',
  'PROVIDER_NOT_REGISTERED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_NOT_ALLOWED',
  'MODEL_UNAVAILABLE',
  'MODEL_DEGRADED',
  'REQUIRES_EXPLICIT_OPT_IN',
  'TIER_NOT_ALLOWED',
  'MISSING_CAPABILITY',
  'CONTEXT_WINDOW_TOO_SMALL',
  'OUTPUT_LIMIT_TOO_SMALL',
] as const;

/** A reason a model was excluded by the hard filter. */
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** A model that was removed from consideration, and why. */
export interface ModelExclusion {
  /** Registry id of the excluded model. */
  readonly modelId: string;
  /** Machine-readable reason. */
  readonly reason: ExclusionReason;
  /** Human-readable explanation, suitable for showing to a user verbatim. */
  readonly detail: string;
}

/**
 * The result of applying the hard filter.
 *
 * Both halves are returned. Discarding the exclusions would make it impossible
 * to explain why a model the user expected was not chosen.
 */
export interface EligibilityResult {
  /** Models that satisfy every hard constraint, ordered by registry id. */
  readonly eligible: readonly ModelSpec[];
  /** Models that were removed, each with a reason. */
  readonly excluded: readonly ModelExclusion[];
}
