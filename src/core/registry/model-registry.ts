/**
 * Model registry and hard eligibility filter (spec sections 7 and 12).
 *
 * Models come entirely from configuration. This registry stores them, tracks
 * live availability, and answers the one question the router must ask before it
 * scores anything: which models could possibly execute this request, and for
 * every model that could not, why.
 */

import type { Availability } from '../types/common.js';
import type {
  EligibilityResult,
  ExclusionReason,
  ModelExclusion,
  ModelRequirements,
} from '../types/eligibility.js';
import { MODEL_CAPABILITY_KEYS, type ModelCapabilities, type ModelSpec } from '../types/model.js';
import { RegistryError } from './provider-registry.js';
import type { ProviderRegistry } from './provider-registry.js';

/** In-memory registry of configured models. */
export class ModelRegistry {
  readonly #models = new Map<string, ModelSpec>();
  readonly #providers: ProviderRegistry | undefined;

  /**
   * @param models Initial models.
   * @param providers Provider registry used to resolve provider availability.
   *   When omitted, provider-level checks are skipped and models are judged on
   *   their own availability alone.
   */
  constructor(models: readonly ModelSpec[] = [], providers?: ProviderRegistry) {
    this.#providers = providers;
    for (const model of models) {
      this.register(model);
    }
  }

  /** Number of registered models. */
  get size(): number {
    return this.#models.size;
  }

  /**
   * Add a model.
   *
   * @throws RegistryError if the id is already registered. Use {@link upsert}
   * to replace deliberately.
   */
  register(model: ModelSpec): void {
    if (this.#models.has(model.id)) {
      throw new RegistryError(
        `Model "${model.id}" is already registered. Use upsert() to replace it.`,
      );
    }
    this.#models.set(model.id, model);
  }

  /** Add a model, replacing any existing entry with the same id. */
  upsert(model: ModelSpec): void {
    this.#models.set(model.id, model);
  }

  /** Remove a model. Returns false when it was not registered. */
  remove(id: string): boolean {
    return this.#models.delete(id);
  }

  /** Whether a model is registered. */
  has(id: string): boolean {
    return this.#models.has(id);
  }

  /** Look up a model, or undefined when it is not registered. */
  get(id: string): ModelSpec | undefined {
    return this.#models.get(id);
  }

  /**
   * Look up a model, failing loudly when it is absent.
   *
   * Used when a user pins a model explicitly: an unavailable explicit choice
   * must be reported clearly, never silently swapped (spec section 12).
   *
   * @throws RegistryError with the known ids, so the message is actionable.
   */
  require(id: string): ModelSpec {
    const model = this.#models.get(id);
    if (model === undefined) {
      throw new RegistryError(
        `Unknown model "${id}". Registered models: ${this.#describeKnownIds()}.`,
      );
    }
    return model;
  }

  /** All models, ordered by id for deterministic output. */
  list(): ModelSpec[] {
    return [...this.#models.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** All models served by one provider, ordered by id. */
  listByProvider(providerId: string): ModelSpec[] {
    return this.list().filter((model) => model.providerId === providerId);
  }

  /**
   * Update a model's live availability.
   *
   * @throws RegistryError when the model is not registered.
   */
  setAvailability(id: string, availability: Availability): void {
    const model = this.require(id);
    this.#models.set(id, { ...model, availability });
  }

  /**
   * Apply the hard constraint filter.
   *
   * Constraints are checked in a fixed order so that a model excluded for
   * several reasons always reports the same, most fundamental one. A model that
   * cannot possibly execute the request is never returned as eligible.
   */
  findEligible(requirements: ModelRequirements = {}): EligibilityResult {
    const eligible: ModelSpec[] = [];
    const excluded: ModelExclusion[] = [];

    for (const model of this.list()) {
      const exclusion = this.#excludeReason(model, requirements);
      if (exclusion === undefined) {
        eligible.push(model);
      } else {
        excluded.push(exclusion);
      }
    }

    return { eligible, excluded };
  }

  /** Returns the exclusion for a model, or undefined when it is eligible. */
  #excludeReason(model: ModelSpec, req: ModelRequirements): ModelExclusion | undefined {
    const exclude = (reason: ExclusionReason, detail: string): ModelExclusion => ({
      modelId: model.id,
      reason,
      detail,
    });

    if (req.excludeModelIds?.includes(model.id) === true) {
      return exclude('EXPLICITLY_EXCLUDED', `Model "${model.id}" was excluded by the caller.`);
    }

    // Provider-level checks come first: a model on a dead provider is dead
    // regardless of how capable it is.
    if (this.#providers !== undefined) {
      const provider = this.#providers.get(model.providerId);
      if (provider === undefined) {
        return exclude(
          'PROVIDER_NOT_REGISTERED',
          `Provider "${model.providerId}" is not registered, so "${model.id}" cannot be used.`,
        );
      }
      if (provider.availability === 'unavailable') {
        return exclude(
          'PROVIDER_UNAVAILABLE',
          `Provider "${provider.id}" is unavailable, so "${model.id}" cannot be used.`,
        );
      }
    }

    if (req.providerIds !== undefined && !req.providerIds.includes(model.providerId)) {
      return exclude(
        'PROVIDER_NOT_ALLOWED',
        `Provider "${model.providerId}" is not in the allowed set (${formatList(req.providerIds)}).`,
      );
    }

    if (model.availability === 'unavailable') {
      return exclude('MODEL_UNAVAILABLE', `Model "${model.id}" is marked unavailable.`);
    }

    if (model.availability === 'degraded' && req.allowDegraded === false) {
      return exclude(
        'MODEL_DEGRADED',
        `Model "${model.id}" is degraded and degraded models were not permitted for this request.`,
      );
    }

    if (
      model.constraints?.requiresExplicitOptIn === true &&
      req.optInModelIds?.includes(model.id) !== true
    ) {
      return exclude(
        'REQUIRES_EXPLICIT_OPT_IN',
        `Model "${model.id}" requires explicit opt-in and was not opted into for this request.`,
      );
    }

    if (req.tiers !== undefined && !req.tiers.includes(model.tier)) {
      return exclude(
        'TIER_NOT_ALLOWED',
        `Model "${model.id}" is tier "${model.tier}", which is not in the allowed set (${formatList(req.tiers)}).`,
      );
    }

    const missing = missingCapabilities(model.capabilities, req.requiredCapabilities);
    if (missing.length > 0) {
      return exclude(
        'MISSING_CAPABILITY',
        `Model "${model.id}" lacks required ${missing.length === 1 ? 'capability' : 'capabilities'}: ${formatList(missing)}.`,
      );
    }

    if (
      req.requiredContextTokens !== undefined &&
      model.contextWindow < req.requiredContextTokens
    ) {
      return exclude(
        'CONTEXT_WINDOW_TOO_SMALL',
        `Model "${model.id}" has a ${formatTokens(model.contextWindow)}-token context window, ` +
          `below the ${formatTokens(req.requiredContextTokens)} tokens this request needs.`,
      );
    }

    if (req.requiredOutputTokens !== undefined && model.maxOutputTokens !== undefined) {
      if (model.maxOutputTokens < req.requiredOutputTokens) {
        return exclude(
          'OUTPUT_LIMIT_TOO_SMALL',
          `Model "${model.id}" caps output at ${formatTokens(model.maxOutputTokens)} tokens, ` +
            `below the ${formatTokens(req.requiredOutputTokens)} tokens this request needs.`,
        );
      }
    }

    return undefined;
  }

  #describeKnownIds(): string {
    const ids = [...this.#models.keys()].sort();
    return ids.length > 0 ? ids.map((id) => `"${id}"`).join(', ') : '(none registered)';
  }
}

/**
 * Capability keys the model is missing.
 *
 * Only `true` requirements constrain. A `false` requirement means "do not
 * care" — RoutePilot never rejects a model for being more capable than asked.
 */
function missingCapabilities(
  actual: ModelCapabilities,
  required: Readonly<Partial<ModelCapabilities>> | undefined,
): string[] {
  if (required === undefined) return [];
  return MODEL_CAPABILITY_KEYS.filter((key) => required[key] === true && !actual[key]);
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '(empty)';
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}
