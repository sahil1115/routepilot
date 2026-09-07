/**
 * The fleet is applied where configuration becomes runtime objects.
 *
 * That single point is the whole enforcement mechanism (Phase 25): routing,
 * expected-cost ranking, the bandit, retries, escalation and provider fallback
 * all draw candidates from this registry, so a model absent here is
 * unreachable everywhere. These tests hold that chokepoint.
 */

import { describe, expect, it } from 'vitest';

import { makeConfigDocument, makeModelDocument } from '../test-support/fixtures.js';
import { buildRegistries } from './registries.js';
import { parseConfig } from './schema.js';

/** Three models, so a fleet can name some and exclude others. */
function threeModels(): Record<string, unknown>[] {
  return [
    makeModelDocument({ id: 'acme/fast-1', modelId: 'fast-1' }),
    makeModelDocument({ id: 'acme/mid-1', modelId: 'mid-1' }),
    makeModelDocument({ id: 'acme/slow-1', modelId: 'slow-1' }),
  ];
}

function configWith(fleet?: unknown) {
  return parseConfig(
    makeConfigDocument({ models: threeModels(), ...(fleet === undefined ? {} : { fleet }) }),
  );
}

describe('buildRegistries and the configured fleet', () => {
  it('registers every model when no fleet is configured', () => {
    const registries = buildRegistries(configWith());

    expect(registries.models.size).toBe(3);
    expect(registries.fleet).toBeNull();
  });

  it('attaches no fleet tier when no fleet is configured', () => {
    // Absent must stay absent, so nothing downstream can read a label that was
    // never written.
    const registries = buildRegistries(configWith());

    for (const model of registries.models.list()) {
      expect(model.fleetTier).toBeUndefined();
    }
  });

  it('registers only the models a fleet names', () => {
    const registries = buildRegistries(
      configWith({
        models: [
          { id: 'acme/fast-1', tier: 'cheap' },
          { id: 'acme/mid-1', tier: 'medium' },
        ],
      }),
    );

    expect(registries.models.list().map((model) => model.id)).toEqual([
      'acme/fast-1',
      'acme/mid-1',
    ]);
    expect(registries.models.has('acme/slow-1')).toBe(false);
    expect(registries.fleet?.excludedCount).toBe(1);
  });

  it('records the user tier on each permitted model', () => {
    const registries = buildRegistries(
      configWith({
        models: [
          { id: 'acme/fast-1', tier: 'cheap' },
          { id: 'acme/slow-1', tier: 'expensive' },
        ],
      }),
    );

    expect(registries.models.require('acme/fast-1').fleetTier).toBe('cheap');
    expect(registries.models.require('acme/slow-1').fleetTier).toBe('expensive');
    expect(registries.fleet?.tiers.get('acme/fast-1')).toBe('cheap');
  });

  it('does not mutate the configured specs', () => {
    // The tier is attached to a copy. A shared spec would leak the label into
    // any other registry built from the same configuration.
    const config = configWith({ models: [{ id: 'acme/fast-1', tier: 'cheap' }] });
    buildRegistries(config);

    expect(config.models.find((model) => model.id === 'acme/fast-1')?.fleetTier).toBeUndefined();
  });

  it('matches a model by its provider-native modelId', () => {
    const registries = buildRegistries(configWith({ models: [{ id: 'mid-1', tier: 'medium' }] }));

    expect(registries.models.list().map((model) => model.id)).toEqual(['acme/mid-1']);
  });

  it('warns about an unknown model without excluding the rest', () => {
    // One mistyped line must not make a fleet unusable.
    const registries = buildRegistries(
      configWith({
        models: [
          { id: 'acme/fast-1', tier: 'cheap' },
          { id: 'ghost/nothing', tier: 'expensive' },
        ],
      }),
    );

    expect(registries.models.list().map((model) => model.id)).toEqual(['acme/fast-1']);
    expect(registries.fleet?.warnings).toHaveLength(1);
    expect(registries.fleet?.warnings[0]).toContain('ghost/nothing');
    expect(registries.fleet?.warnings[0]).toContain('acme/fast-1');
  });

  it('does not warn when every entry resolves', () => {
    // The positive control: a warning list that is never empty would be noise.
    const registries = buildRegistries(
      configWith({ models: [{ id: 'acme/fast-1', tier: 'cheap' }] }),
    );

    expect(registries.fleet?.warnings).toEqual([]);
  });

  it('includes every provider offering a shared modelId', () => {
    // Which is what keeps provider fallback inside the fleet: naming the model
    // string permits it wherever it is served from.
    const config = parseConfig(
      makeConfigDocument({
        providers: [
          { id: 'acme', displayName: 'Acme', kind: 'cloud', auth: { kind: 'none' } },
          { id: 'zenith', displayName: 'Zenith', kind: 'cloud', auth: { kind: 'none' } },
        ],
        models: [
          makeModelDocument({ id: 'acme/shared', modelId: 'shared', providerId: 'acme' }),
          makeModelDocument({ id: 'zenith/shared', modelId: 'shared', providerId: 'zenith' }),
        ],
        fleet: { models: [{ id: 'shared', tier: 'medium' }] },
      }),
    );

    const registries = buildRegistries(config);
    expect(
      registries.models
        .list()
        .map((model) => model.id)
        .sort(),
    ).toEqual(['acme/shared', 'zenith/shared']);
  });

  it('keeps a one-model fleet to exactly that model', () => {
    const registries = buildRegistries(
      configWith({ models: [{ id: 'acme/mid-1', tier: 'medium' }] }),
    );

    expect(registries.models.size).toBe(1);
    expect(registries.models.list()[0]?.id).toBe('acme/mid-1');
  });
});
