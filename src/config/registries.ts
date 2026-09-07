/**
 * Bridge from a validated configuration to the core registries.
 *
 * This is the only place that turns configuration into runtime objects. The
 * core registries know nothing about files, schemas or discovery — they are
 * handed already-valid specs.
 *
 * It is also where a configured fleet is applied (Phase 25), and applying it
 * here is the whole implementation. Every stage downstream — the constraint
 * filter, expected-cost ranking, the bandit, retries, escalation and provider
 * fallback — draws its candidates from this registry, so restricting it once
 * restricts all of them. Nothing else needs to know a fleet exists, and no code
 * path can reach a model the user did not permit.
 */

import { ModelRegistry, ProviderRegistry } from '../core/registry/index.js';
import type { FleetTier, ModelSpec } from '../core/types/model.js';
import type { RoutePilotConfig } from './types.js';

/** What a configured fleet did to the model registry. */
export interface FleetSummary {
  /** Fleet tier by model id, for explanation and display. */
  readonly tiers: ReadonlyMap<string, FleetTier>;
  /** Configured models the fleet excluded. */
  readonly excludedCount: number;
  /** Fleet entries that matched no configured model. Never fatal. */
  readonly warnings: readonly string[];
}

/** The registries built from one configuration document. */
export interface Registries {
  readonly providers: ProviderRegistry;
  readonly models: ModelRegistry;
  /**
   * The fleet that was applied, or `null` when none is configured.
   *
   * `null` and an empty fleet are not the same thing and must not be conflated:
   * no fleet means every model is routable, and the schema rejects a fleet that
   * names nothing.
   */
  readonly fleet: FleetSummary | null;
}

/**
 * Build the provider and model registries from a validated configuration.
 *
 * Duplicate ids and unknown provider references are already rejected by
 * validation, so registration here cannot fail on a config that came through
 * {@link import('./schema.js').parseConfig}. A fleet naming no known model is
 * rejected there too, so this never produces an empty registry from a non-empty
 * one — an unresolvable fleet fails loudly rather than silently routing outside
 * itself.
 */
export function buildRegistries(config: RoutePilotConfig): Registries {
  const providers = new ProviderRegistry(config.providers);

  if (config.fleet === undefined) {
    return { providers, models: new ModelRegistry(config.models, providers), fleet: null };
  }

  const tiers = new Map<string, FleetTier>();
  const warnings: string[] = [];
  const permitted: ModelSpec[] = [];

  for (const entry of config.fleet.models) {
    // Either identifier matches, so a user need not repeat the provider prefix.
    // A `modelId` shared by two providers puts both in the fleet, which is what
    // keeps provider fallback inside it rather than dead-ending.
    const matches = config.models.filter(
      (model) => model.id === entry.id || model.modelId === entry.id,
    );

    if (matches.length === 0) {
      const known = config.models.map((model) => model.id).sort();
      warnings.push(
        `fleet model "${entry.id}" matches no configured model and was ignored` +
          (known.length > 0 ? ` (known: ${known.join(', ')})` : ''),
      );
      continue;
    }

    for (const model of matches) {
      if (tiers.has(model.id)) continue;
      tiers.set(model.id, entry.tier);
      permitted.push({ ...model, fleetTier: entry.tier });
    }
  }

  return {
    providers,
    models: new ModelRegistry(permitted, providers),
    fleet: {
      tiers,
      excludedCount: config.models.length - permitted.length,
      warnings,
    },
  };
}
