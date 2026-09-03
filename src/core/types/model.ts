/**
 * ModelSpec and supporting types (spec sections 7 and 8).
 *
 * Models are configuration-driven. No vendor, product or model name may appear
 * in this file or anywhere else under `src/core`.
 */

import type { Availability, UnitInterval } from './common.js';

/** Coarse capability/price band, used for cold-start priors and reporting. */
export const MODEL_TIERS = ['cheap', 'medium', 'frontier', 'ultra'] as const;

/** Coarse capability/price band. */
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Graded capability dimensions (spec section 8).
 *
 * These are quality dimensions scored in [0, 1], distinct from the hard boolean
 * capabilities below. `toolUse` and `longContext` appear only as booleans
 * because they are binary facts about a model, not qualities.
 */
export const SKILL_DIMENSIONS = [
  'codeGeneration',
  'codeEditing',
  'debugging',
  'refactoring',
  'architecture',
  'reasoning',
  'testGeneration',
  'documentation',
  'multiFileReasoning',
] as const;

/** A graded capability dimension. */
export type SkillDimension = (typeof SKILL_DIMENSIONS)[number];

/**
 * Hard, binary model capabilities.
 *
 * These drive exclusion, not scoring: a task requiring agentic execution can
 * never be routed to a model that cannot perform it (spec section 12).
 */
export interface ModelCapabilities {
  /** Model can call tools/functions. */
  readonly toolUse: boolean;
  /** Model can drive a multi-step agentic loop. */
  readonly agenticExecution: boolean;
  /** Model supports streaming responses. */
  readonly streaming: boolean;
  /** Model supports schema-constrained output. */
  readonly structuredOutput: boolean;
  /** Model accepts image input. */
  readonly vision: boolean;
}

/** The capability keys, for iteration and validation. */
export const MODEL_CAPABILITY_KEYS = [
  'toolUse',
  'agenticExecution',
  'streaming',
  'structuredOutput',
  'vision',
] as const satisfies readonly (keyof ModelCapabilities)[];

/**
 * Token pricing for a model.
 *
 * Prices are per one million tokens, in {@link ModelPricing.currency}.
 */
export interface ModelPricing {
  /** Cost per 1,000,000 input tokens. */
  readonly inputPerMillion: number;
  /** Cost per 1,000,000 output tokens. */
  readonly outputPerMillion: number;
  /**
   * Cost per 1,000,000 input tokens served from a provider-side cache.
   *
   * When absent, cached input is billed at the full input rate — RoutePilot
   * does not assume a discount it has not been told about.
   */
  readonly cachedInputPerMillion?: number | undefined;
  /** ISO 4217 currency code. */
  readonly currency: string;
  /**
   * ISO 8601 date on which these prices were last verified against the
   * provider.
   *
   * Pricing goes stale. A cost-optimising router that silently reasons from
   * year-old numbers is worse than one that admits it does not know, so the
   * date travels with the price.
   */
  readonly verifiedAt?: string | undefined;
}

/**
 * Latency profile used to estimate wall-clock time.
 *
 * These are priors from configuration, superseded by observation once the
 * telemetry store exists (Phase 11).
 */
export interface LatencyProfile {
  /** Typical seconds until the first output token. */
  readonly firstTokenSeconds: number;
  /** Typical sustained output token throughput. */
  readonly outputTokensPerSecond: number;
}

/**
 * Prior beliefs about a model's ability.
 *
 * **These are priors, not measurements.** They come from configuration and
 * express what the operator believes before any outcome has been observed. They
 * are held in their own object, structurally separate from observed data, so
 * that nothing can mistake a configured guess for evidence (spec section 39).
 *
 * Observed outcomes and sample counts live in the telemetry store (Phase 11),
 * never here. There is deliberately no `sampleCount` field on a `ModelSpec`.
 */
export interface ModelPriors {
  /** Prior skill estimates in [0, 1]. Absent dimensions are unknown, not zero. */
  readonly skills: Readonly<Partial<Record<SkillDimension, UnitInterval>>>;
  /**
   * Prior per-language estimates in [0, 1], keyed by lowercase language id
   * (for example `typescript`, `python`). Absent languages are unknown.
   */
  readonly languages: Readonly<Record<string, UnitInterval>>;
}

/** Operational limits and gating for a model (spec section 7). */
export interface OperationalConstraints {
  /** Maximum in-flight requests RoutePilot should issue to this model. */
  readonly maxConcurrentRequests?: number | undefined;
  /** Provider-side request rate limit, if known. */
  readonly requestsPerMinute?: number | undefined;
  /**
   * When true, the model is excluded unless the caller opts in explicitly.
   *
   * For preview, experimental or otherwise restricted models that must never
   * be selected by accident.
   */
  readonly requiresExplicitOptIn?: boolean | undefined;
  /** Free-text operator note surfaced in explanations. */
  readonly notes?: string | undefined;
}

/**
 * A model RoutePilot can route to.
 *
 * Every field originates from configuration. The registry never invents a
 * model, and core code never refers to one by name.
 */
export interface ModelSpec {
  /**
   * Unique registry key, of the form `<providerId>/<something>`.
   *
   * The provider prefix is validated so that a model can always be traced to
   * its provider from the id alone.
   */
  readonly id: string;
  /** Id of the provider that serves this model. Must exist in the provider registry. */
  readonly providerId: string;
  /**
   * The provider-native model identifier sent on the wire.
   *
   * Kept separate from {@link ModelSpec.id} so the registry key stays stable
   * even when a provider renames or version-suffixes its model string.
   */
  readonly modelId: string;
  /** Human-readable name for UI and explanations. */
  readonly displayName: string;
  /** Coarse capability/price band. */
  readonly tier: ModelTier;
  /** Maximum input context in tokens. */
  readonly contextWindow: number;
  /** Maximum output tokens per response, when known. */
  readonly maxOutputTokens?: number | undefined;
  /** Token pricing. */
  readonly pricing: ModelPricing;
  /** Hard boolean capabilities. */
  readonly capabilities: ModelCapabilities;
  /** Latency priors. */
  readonly latency: LatencyProfile;
  /** Current operational availability. */
  readonly availability: Availability;
  /** Prior beliefs about ability — never measurements. */
  readonly priors: ModelPriors;
  /** Operational limits and gating. */
  readonly constraints?: OperationalConstraints | undefined;
  /** Free-form labels for operator filtering. */
  readonly tags?: readonly string[] | undefined;
}
