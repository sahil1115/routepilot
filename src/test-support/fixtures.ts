/**
 * Test fixtures.
 *
 * Fixtures use invented provider and model names on purpose. Tests must not
 * depend on any real vendor's naming or pricing — if they did, a price change
 * would break the suite, and the suite would quietly become a place where
 * vendor assumptions leak back into a provider-neutral core.
 *
 * Excluded from the published build (see tsconfig.build.json).
 */

import type { ModelCapabilities, ModelPriors, ModelSpec } from '../core/types/model.js';
import type { ProviderSpec } from '../core/types/provider.js';

/** All capabilities present. */
export const allCapabilities: ModelCapabilities = {
  toolUse: true,
  agenticExecution: true,
  streaming: true,
  structuredOutput: true,
  vision: true,
};

/** No capabilities present. */
export const noCapabilities: ModelCapabilities = {
  toolUse: false,
  agenticExecution: false,
  streaming: false,
  structuredOutput: false,
  vision: false,
};

const emptyPriors: ModelPriors = { skills: {}, languages: {} };

/** Build a validated provider spec, overriding any field. */
export function makeProvider(overrides: Partial<ProviderSpec> = {}): ProviderSpec {
  return {
    id: 'acme',
    displayName: 'Acme Models',
    kind: 'cloud',
    auth: { kind: 'apiKey', envVar: 'ACME_API_KEY' },
    timeoutMs: 120_000,
    retry: { maxAttempts: 3, initialDelayMs: 500, backoffMultiplier: 2, maxDelayMs: 30_000 },
    availability: 'available',
    ...overrides,
  };
}

/** Build a validated model spec, overriding any field. Defaults to a cheap, fully capable model. */
export function makeModel(overrides: Partial<ModelSpec> = {}): ModelSpec {
  const providerId = overrides.providerId ?? 'acme';
  return {
    id: `${providerId}/fast-1`,
    providerId,
    modelId: 'fast-1',
    displayName: 'Acme Fast 1',
    tier: 'cheap',
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    pricing: { inputPerMillion: 1, outputPerMillion: 5, currency: 'USD' },
    capabilities: allCapabilities,
    latency: { firstTokenSeconds: 0.5, outputTokensPerSecond: 100 },
    availability: 'available',
    priors: emptyPriors,
    ...overrides,
  };
}

/**
 * A raw configuration document, as it appears in JSON before validation.
 *
 * Deliberately loose: these fixtures exist so tests can construct *invalid*
 * documents too. `providers` and `models` are declared explicitly so they stay
 * accessible with dot notation under `noPropertyAccessFromIndexSignature`.
 */
export interface ConfigDocument {
  version: unknown;
  providers: Record<string, unknown>[];
  models: Record<string, unknown>[];
  [key: string]: unknown;
}

/** Build a raw provider entry for a configuration document. */
export function makeProviderDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'acme',
    displayName: 'Acme Models',
    kind: 'cloud',
    auth: { kind: 'apiKey', envVar: 'ACME_API_KEY' },
    ...overrides,
  };
}

/** Build a raw model entry for a configuration document. */
export function makeModelDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'acme/fast-1',
    providerId: 'acme',
    modelId: 'fast-1',
    displayName: 'Acme Fast 1',
    tier: 'cheap',
    contextWindow: 100_000,
    pricing: { inputPerMillion: 1, outputPerMillion: 5 },
    capabilities: {
      toolUse: true,
      agenticExecution: true,
      streaming: true,
      structuredOutput: true,
    },
    latency: { firstTokenSeconds: 0.5, outputTokensPerSecond: 100 },
    ...overrides,
  };
}

/** A minimal configuration document that passes validation. */
export function makeConfigDocument(overrides: Partial<ConfigDocument> = {}): ConfigDocument {
  return {
    version: 1,
    providers: [makeProviderDocument()],
    models: [makeModelDocument()],
    ...overrides,
  };
}
