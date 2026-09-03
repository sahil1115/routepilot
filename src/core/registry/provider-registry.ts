/**
 * Provider registry (spec section 20).
 *
 * Providers are supplied entirely by configuration. The registry stores them,
 * tracks their live availability, and never invents one.
 */

import type { Availability } from '../types/common.js';
import type { ProviderSpec } from '../types/provider.js';

/** Thrown when the registry is asked to do something impossible. */
export class RegistryError extends Error {
  override readonly name = 'RegistryError';
}

/** In-memory registry of configured providers. */
export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderSpec>();

  constructor(providers: readonly ProviderSpec[] = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  /** Number of registered providers. */
  get size(): number {
    return this.#providers.size;
  }

  /**
   * Add a provider.
   *
   * @throws RegistryError if the id is already registered. Use {@link upsert}
   * to replace deliberately — a silent overwrite would let one configuration
   * source quietly shadow another.
   */
  register(provider: ProviderSpec): void {
    if (this.#providers.has(provider.id)) {
      throw new RegistryError(
        `Provider "${provider.id}" is already registered. Use upsert() to replace it.`,
      );
    }
    this.#providers.set(provider.id, provider);
  }

  /** Add a provider, replacing any existing entry with the same id. */
  upsert(provider: ProviderSpec): void {
    this.#providers.set(provider.id, provider);
  }

  /** Remove a provider. Returns false when it was not registered. */
  remove(id: string): boolean {
    return this.#providers.delete(id);
  }

  /** Whether a provider is registered. */
  has(id: string): boolean {
    return this.#providers.has(id);
  }

  /** Look up a provider, or undefined when it is not registered. */
  get(id: string): ProviderSpec | undefined {
    return this.#providers.get(id);
  }

  /**
   * Look up a provider, failing loudly when it is absent.
   *
   * @throws RegistryError with the known ids, so the message is actionable.
   */
  require(id: string): ProviderSpec {
    const provider = this.#providers.get(id);
    if (provider === undefined) {
      throw new RegistryError(
        `Unknown provider "${id}". Registered providers: ${this.#describeKnownIds()}.`,
      );
    }
    return provider;
  }

  /** All providers, ordered by id for deterministic output. */
  list(): ProviderSpec[] {
    return [...this.#providers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Update a provider's live availability.
   *
   * @throws RegistryError when the provider is not registered.
   */
  setAvailability(id: string, availability: Availability): void {
    const provider = this.require(id);
    this.#providers.set(id, { ...provider, availability });
  }

  #describeKnownIds(): string {
    const ids = [...this.#providers.keys()].sort();
    return ids.length > 0 ? ids.map((id) => `"${id}"`).join(', ') : '(none registered)';
  }
}
