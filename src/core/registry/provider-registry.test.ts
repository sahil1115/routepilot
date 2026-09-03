import { describe, expect, it } from 'vitest';

import { makeProvider } from '../../test-support/fixtures.js';
import { ProviderRegistry, RegistryError } from './provider-registry.js';

describe('ProviderRegistry', () => {
  it('registers and retrieves a provider', () => {
    const registry = new ProviderRegistry();
    const provider = makeProvider();

    registry.register(provider);

    expect(registry.size).toBe(1);
    expect(registry.has('acme')).toBe(true);
    expect(registry.get('acme')).toEqual(provider);
    expect(registry.require('acme')).toEqual(provider);
  });

  it('refuses to silently overwrite a registered id', () => {
    const registry = new ProviderRegistry([makeProvider()]);
    expect(() => {
      registry.register(makeProvider({ displayName: 'Other' }));
    }).toThrow(RegistryError);
  });

  it('replaces deliberately via upsert', () => {
    const registry = new ProviderRegistry([makeProvider()]);
    registry.upsert(makeProvider({ displayName: 'Replaced' }));

    expect(registry.size).toBe(1);
    expect(registry.get('acme')?.displayName).toBe('Replaced');
  });

  it('removes a provider and reports whether it existed', () => {
    const registry = new ProviderRegistry([makeProvider()]);

    expect(registry.remove('acme')).toBe(true);
    expect(registry.remove('acme')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('names the registered providers when an unknown id is required', () => {
    const registry = new ProviderRegistry([
      makeProvider({ id: 'acme' }),
      makeProvider({ id: 'globex' }),
    ]);

    expect(() => registry.require('initech')).toThrow(
      /Unknown provider "initech"\. Registered providers: "acme", "globex"\./,
    );
  });

  it('lists providers in a deterministic id order', () => {
    const registry = new ProviderRegistry([
      makeProvider({ id: 'zeta' }),
      makeProvider({ id: 'alpha' }),
    ]);

    expect(registry.list().map((p) => p.id)).toEqual(['alpha', 'zeta']);
  });

  it('updates availability in place', () => {
    const registry = new ProviderRegistry([makeProvider()]);

    registry.setAvailability('acme', 'unavailable');

    expect(registry.get('acme')?.availability).toBe('unavailable');
    expect(registry.get('acme')?.displayName).toBe('Acme Models');
  });

  it('refuses to set availability on an unregistered provider', () => {
    expect(() => new ProviderRegistry().setAvailability('nope', 'degraded')).toThrow(RegistryError);
  });

  it('stores no credential material, only the environment variable name', () => {
    const registry = new ProviderRegistry([makeProvider()]);
    const serialised = JSON.stringify(registry.list());

    expect(serialised).toContain('ACME_API_KEY');
    expect(serialised).not.toMatch(/sk-|secret|password/i);
  });
});
