import { describe, expect, it } from 'vitest';

import {
  allCapabilities,
  makeModel,
  makeProvider,
  noCapabilities,
} from '../../test-support/fixtures.js';
import { ModelRegistry } from './model-registry.js';
import { ProviderRegistry, RegistryError } from './provider-registry.js';

describe('ModelRegistry — registration', () => {
  it('registers a model and exposes it by id', () => {
    const registry = new ModelRegistry();
    const model = makeModel();

    registry.register(model);

    expect(registry.size).toBe(1);
    expect(registry.has('acme/fast-1')).toBe(true);
    expect(registry.get('acme/fast-1')).toEqual(model);
    expect(registry.list()).toEqual([model]);
  });

  it('accepts models supplied to the constructor', () => {
    const registry = new ModelRegistry([makeModel(), makeModel({ id: 'acme/slow-1' })]);
    expect(registry.list().map((m) => m.id)).toEqual(['acme/fast-1', 'acme/slow-1']);
  });

  it('refuses to silently overwrite a registered id', () => {
    const registry = new ModelRegistry([makeModel()]);
    expect(() => {
      registry.register(makeModel({ displayName: 'Different' }));
    }).toThrow(RegistryError);
  });

  it('replaces deliberately via upsert', () => {
    const registry = new ModelRegistry([makeModel()]);
    registry.upsert(makeModel({ displayName: 'Replaced' }));

    expect(registry.size).toBe(1);
    expect(registry.get('acme/fast-1')?.displayName).toBe('Replaced');
  });

  it('lists models in a deterministic id order regardless of insertion order', () => {
    const registry = new ModelRegistry([
      makeModel({ id: 'acme/zeta' }),
      makeModel({ id: 'acme/alpha' }),
      makeModel({ id: 'acme/middle' }),
    ]);

    expect(registry.list().map((m) => m.id)).toEqual(['acme/alpha', 'acme/middle', 'acme/zeta']);
  });

  it('lists models by provider', () => {
    const registry = new ModelRegistry([
      makeModel({ id: 'acme/one', providerId: 'acme' }),
      makeModel({ id: 'globex/one', providerId: 'globex' }),
    ]);

    expect(registry.listByProvider('globex').map((m) => m.id)).toEqual(['globex/one']);
  });
});

describe('ModelRegistry — removal', () => {
  it('removes a registered model and reports that it did', () => {
    const registry = new ModelRegistry([makeModel()]);

    expect(registry.remove('acme/fast-1')).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.has('acme/fast-1')).toBe(false);
    expect(registry.get('acme/fast-1')).toBeUndefined();
  });

  it('reports false when removing a model that was never registered', () => {
    const registry = new ModelRegistry([makeModel()]);
    expect(registry.remove('acme/never-existed')).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('excludes a removed model from eligibility', () => {
    const registry = new ModelRegistry([makeModel(), makeModel({ id: 'acme/second' })]);
    registry.remove('acme/second');

    const result = registry.findEligible();
    expect(result.eligible.map((m) => m.id)).toEqual(['acme/fast-1']);
    expect(result.excluded).toEqual([]);
  });
});

describe('ModelRegistry — lookup failure', () => {
  it('names the registered models when an unknown id is required', () => {
    const registry = new ModelRegistry([makeModel(), makeModel({ id: 'acme/second' })]);

    expect(() => registry.require('acme/typo')).toThrow(
      /Unknown model "acme\/typo"\. Registered models: "acme\/fast-1", "acme\/second"\./,
    );
  });

  it('says so plainly when nothing is registered at all', () => {
    expect(() => new ModelRegistry().require('anything')).toThrow(/\(none registered\)/);
  });
});

describe('ModelRegistry — availability', () => {
  it('excludes an unavailable model and says why', () => {
    const registry = new ModelRegistry([
      makeModel({ id: 'acme/up' }),
      makeModel({ id: 'acme/down', availability: 'unavailable' }),
    ]);

    const result = registry.findEligible();

    expect(result.eligible.map((m) => m.id)).toEqual(['acme/up']);
    expect(result.excluded).toEqual([
      {
        modelId: 'acme/down',
        reason: 'MODEL_UNAVAILABLE',
        detail: 'Model "acme/down" is marked unavailable.',
      },
    ]);
  });

  it('keeps degraded models eligible by default', () => {
    const registry = new ModelRegistry([makeModel({ availability: 'degraded' })]);
    expect(registry.findEligible().eligible.map((m) => m.id)).toEqual(['acme/fast-1']);
  });

  it('excludes degraded models when the caller opts out', () => {
    const registry = new ModelRegistry([makeModel({ availability: 'degraded' })]);

    const result = registry.findEligible({ allowDegraded: false });

    expect(result.eligible).toEqual([]);
    expect(result.excluded[0]?.reason).toBe('MODEL_DEGRADED');
  });

  it('setAvailability changes eligibility without re-registering', () => {
    const registry = new ModelRegistry([makeModel()]);
    expect(registry.findEligible().eligible).toHaveLength(1);

    registry.setAvailability('acme/fast-1', 'unavailable');

    expect(registry.findEligible().eligible).toHaveLength(0);
    expect(registry.get('acme/fast-1')?.availability).toBe('unavailable');
  });

  it('refuses to set availability on an unregistered model', () => {
    expect(() => new ModelRegistry().setAvailability('nope', 'degraded')).toThrow(RegistryError);
  });

  it('excludes every model of an unavailable provider', () => {
    const providers = new ProviderRegistry([
      makeProvider({ id: 'acme' }),
      makeProvider({ id: 'globex', availability: 'unavailable' }),
    ]);
    const registry = new ModelRegistry(
      [makeModel({ id: 'acme/one' }), makeModel({ id: 'globex/one', providerId: 'globex' })],
      providers,
    );

    const result = registry.findEligible();

    expect(result.eligible.map((m) => m.id)).toEqual(['acme/one']);
    expect(result.excluded[0]).toMatchObject({
      modelId: 'globex/one',
      reason: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('excludes a model whose provider is not registered', () => {
    const registry = new ModelRegistry(
      [makeModel({ id: 'ghost/one', providerId: 'ghost' })],
      new ProviderRegistry([makeProvider({ id: 'acme' })]),
    );

    expect(registry.findEligible().excluded[0]?.reason).toBe('PROVIDER_NOT_REGISTERED');
  });

  it('skips provider checks entirely when no provider registry is supplied', () => {
    const registry = new ModelRegistry([makeModel({ id: 'ghost/one', providerId: 'ghost' })]);
    expect(registry.findEligible().eligible).toHaveLength(1);
  });
});

describe('ModelRegistry — capability matching', () => {
  it('excludes a model missing a required capability and names the capability', () => {
    const registry = new ModelRegistry([
      makeModel({ id: 'acme/agentic', capabilities: allCapabilities }),
      makeModel({
        id: 'acme/plain',
        capabilities: { ...noCapabilities, streaming: true },
      }),
    ]);

    const result = registry.findEligible({ requiredCapabilities: { agenticExecution: true } });

    expect(result.eligible.map((m) => m.id)).toEqual(['acme/agentic']);
    expect(result.excluded[0]?.reason).toBe('MISSING_CAPABILITY');
    expect(result.excluded[0]?.detail).toContain('agenticExecution');
  });

  it('lists every missing capability, not just the first', () => {
    const registry = new ModelRegistry([makeModel({ capabilities: noCapabilities })]);

    const result = registry.findEligible({
      requiredCapabilities: { toolUse: true, agenticExecution: true, vision: true },
    });

    const detail = result.excluded[0]?.detail ?? '';
    expect(detail).toContain('toolUse');
    expect(detail).toContain('agenticExecution');
    expect(detail).toContain('vision');
    expect(detail).toContain('capabilities:');
  });

  it('treats a false requirement as "do not care", never as "must not have"', () => {
    const registry = new ModelRegistry([makeModel({ capabilities: allCapabilities })]);

    const result = registry.findEligible({ requiredCapabilities: { vision: false } });

    expect(result.eligible).toHaveLength(1);
  });

  it('never excludes a model for being more capable than required', () => {
    const registry = new ModelRegistry([makeModel({ capabilities: allCapabilities })]);
    expect(registry.findEligible({ requiredCapabilities: {} }).eligible).toHaveLength(1);
  });
});

describe('ModelRegistry — context matching', () => {
  it('excludes a model whose context window is too small', () => {
    const registry = new ModelRegistry([
      makeModel({ id: 'acme/small', contextWindow: 32_000 }),
      makeModel({ id: 'acme/large', contextWindow: 200_000 }),
    ]);

    const result = registry.findEligible({ requiredContextTokens: 48_000 });

    expect(result.eligible.map((m) => m.id)).toEqual(['acme/large']);
    expect(result.excluded[0]?.reason).toBe('CONTEXT_WINDOW_TOO_SMALL');
    expect(result.excluded[0]?.detail).toContain('32,000');
    expect(result.excluded[0]?.detail).toContain('48,000');
  });

  it('treats a context window exactly equal to the requirement as sufficient', () => {
    const registry = new ModelRegistry([makeModel({ contextWindow: 48_000 })]);
    expect(registry.findEligible({ requiredContextTokens: 48_000 }).eligible).toHaveLength(1);
  });

  it('excludes a model whose output limit is too small', () => {
    const registry = new ModelRegistry([
      makeModel({ id: 'acme/short', maxOutputTokens: 4_000 }),
      makeModel({ id: 'acme/long', maxOutputTokens: 64_000 }),
    ]);

    const result = registry.findEligible({ requiredOutputTokens: 16_000 });

    expect(result.eligible.map((m) => m.id)).toEqual(['acme/long']);
    expect(result.excluded[0]?.reason).toBe('OUTPUT_LIMIT_TOO_SMALL');
  });

  it('does not exclude on output limit when the model does not declare one', () => {
    const registry = new ModelRegistry([makeModel({ maxOutputTokens: undefined })]);
    expect(registry.findEligible({ requiredOutputTokens: 999_999 }).eligible).toHaveLength(1);
  });
});

describe('ModelRegistry — other hard constraints', () => {
  it('excludes models the caller listed explicitly', () => {
    const registry = new ModelRegistry([makeModel(), makeModel({ id: 'acme/second' })]);

    const result = registry.findEligible({ excludeModelIds: ['acme/fast-1'] });

    expect(result.eligible.map((m) => m.id)).toEqual(['acme/second']);
    expect(result.excluded[0]?.reason).toBe('EXPLICITLY_EXCLUDED');
  });

  it('restricts by provider', () => {
    const registry = new ModelRegistry([
      makeModel({ id: 'acme/one' }),
      makeModel({ id: 'globex/one', providerId: 'globex' }),
    ]);

    const result = registry.findEligible({ providerIds: ['globex'] });

    expect(result.eligible.map((m) => m.id)).toEqual(['globex/one']);
    expect(result.excluded[0]?.reason).toBe('PROVIDER_NOT_ALLOWED');
  });

  it('restricts by tier', () => {
    const registry = new ModelRegistry([
      makeModel({ id: 'acme/cheap', tier: 'cheap' }),
      makeModel({ id: 'acme/frontier', tier: 'frontier' }),
    ]);

    const result = registry.findEligible({ tiers: ['frontier'] });

    expect(result.eligible.map((m) => m.id)).toEqual(['acme/frontier']);
    expect(result.excluded[0]?.reason).toBe('TIER_NOT_ALLOWED');
  });

  it('excludes an opt-in model until it is opted into', () => {
    const model = makeModel({
      id: 'acme/preview',
      constraints: { requiresExplicitOptIn: true },
    });
    const registry = new ModelRegistry([model]);

    expect(registry.findEligible().excluded[0]?.reason).toBe('REQUIRES_EXPLICIT_OPT_IN');
    expect(registry.findEligible({ optInModelIds: ['acme/preview'] }).eligible).toHaveLength(1);
  });

  it('reports the most fundamental reason when several constraints fail at once', () => {
    // Unavailable *and* under-capable *and* too small. Availability wins,
    // because a dead model's capabilities are beside the point.
    const registry = new ModelRegistry([
      makeModel({ availability: 'unavailable', capabilities: noCapabilities, contextWindow: 10 }),
    ]);

    const result = registry.findEligible({
      requiredCapabilities: { toolUse: true },
      requiredContextTokens: 100_000,
    });

    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.reason).toBe('MODEL_UNAVAILABLE');
  });

  it('every exclusion carries a human-readable detail', () => {
    const registry = new ModelRegistry([
      makeModel({ id: 'acme/a', availability: 'unavailable' }),
      makeModel({ id: 'acme/b', contextWindow: 10 }),
      makeModel({ id: 'acme/c', capabilities: noCapabilities }),
    ]);

    const result = registry.findEligible({
      requiredContextTokens: 1_000,
      requiredCapabilities: { toolUse: true },
    });

    expect(result.excluded).toHaveLength(3);
    for (const exclusion of result.excluded) {
      expect(exclusion.detail.length).toBeGreaterThan(0);
      expect(exclusion.detail).toContain(exclusion.modelId);
    }
  });

  it('returns everything as eligible when no requirements are given', () => {
    const registry = new ModelRegistry([makeModel(), makeModel({ id: 'acme/second' })]);

    const result = registry.findEligible();

    expect(result.eligible).toHaveLength(2);
    expect(result.excluded).toHaveLength(0);
  });

  it('accounts for every model exactly once', () => {
    const registry = new ModelRegistry([
      makeModel({ id: 'acme/a' }),
      makeModel({ id: 'acme/b', availability: 'unavailable' }),
      makeModel({ id: 'acme/c', contextWindow: 5 }),
    ]);

    const result = registry.findEligible({ requiredContextTokens: 1_000 });

    expect(result.eligible.length + result.excluded.length).toBe(registry.size);
  });
});
