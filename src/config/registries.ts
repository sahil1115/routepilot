/**
 * Bridge from a validated configuration to the core registries.
 *
 * This is the only place that turns configuration into runtime objects. The
 * core registries know nothing about files, schemas or discovery — they are
 * handed already-valid specs.
 */

import { ModelRegistry, ProviderRegistry } from '../core/registry/index.js';
import type { RoutePilotConfig } from './types.js';

/** The registries built from one configuration document. */
export interface Registries {
  readonly providers: ProviderRegistry;
  readonly models: ModelRegistry;
}

/**
 * Build the provider and model registries from a validated configuration.
 *
 * Duplicate ids and unknown provider references are already rejected by
 * validation, so registration here cannot fail on a config that came through
 * {@link import('./schema.js').parseConfig}.
 */
export function buildRegistries(config: RoutePilotConfig): Registries {
  const providers = new ProviderRegistry(config.providers);
  const models = new ModelRegistry(config.models, providers);
  return { providers, models };
}
