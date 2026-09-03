import { describe, expect, it } from 'vitest';

import type { ModelSpec } from '../core/types/model.js';
import type { ProviderSpec } from '../core/types/provider.js';
import {
  makeConfigDocument,
  makeModelDocument,
  makeProviderDocument,
} from '../test-support/fixtures.js';
import { ConfigurationError } from './errors.js';
import { parseConfig } from './schema.js';
import type { routePilotConfigSchema } from './schema.js';
import type { RoutePilotConfig } from './types.js';

/**
 * Compile-time conformance: the schema must produce exactly the hand-written
 * domain types. If a schema field drifts from its interface this fails at
 * typecheck, rather than at runtime in production.
 */
type SchemaOutput = ReturnType<typeof routePilotConfigSchema.parse>;
type AssertExtends<A extends B, B> = A;
export type _ConfigConforms = AssertExtends<SchemaOutput, RoutePilotConfig>;
export type _ModelConforms = AssertExtends<SchemaOutput['models'][number], ModelSpec>;
export type _ProviderConforms = AssertExtends<SchemaOutput['providers'][number], ProviderSpec>;

/** Assert the document is rejected, and return the error for inspection. */
function expectRejected(document: unknown): ConfigurationError {
  try {
    parseConfig(document);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return error as ConfigurationError;
  }
  throw new Error('expected the configuration to be rejected, but it was accepted');
}

/** Paths of every reported issue. */
function paths(error: ConfigurationError): string[] {
  return error.issues.map((issue) => issue.path);
}

/** A config whose single model carries the given overrides. */
function withModel(overrides: Record<string, unknown>): unknown {
  return makeConfigDocument({ models: [makeModelDocument(overrides)] });
}

/** A config whose single provider carries the given overrides. */
function withProvider(overrides: Record<string, unknown>): unknown {
  return makeConfigDocument({ providers: [makeProviderDocument(overrides)] });
}

describe('parseConfig — valid documents', () => {
  it('accepts a minimal document and fills in safe defaults', () => {
    const config = parseConfig(makeConfigDocument());

    expect(config.version).toBe(1);
    expect(config.models).toHaveLength(1);
    expect(config.providers).toHaveLength(1);

    // Defaults must be the safe ones (spec sections 35 and 40).
    expect(config.learning.enabled).toBe(false);
    expect(config.learning.exploration.enabled).toBe(false);
    expect(config.routing.modelOverrideEnabled).toBe(false);
    expect(config.telemetry.enabled).toBe(true);
    expect(config.telemetry.privacyMode).toBe('strict');
    expect(config.budgets.onExceeded).toBe('ask');
  });

  it('accepts a document with only a version', () => {
    const config = parseConfig({ version: 1 });

    expect(config.models).toEqual([]);
    expect(config.providers).toEqual([]);
    expect(config.routing.minimumSuccessProbability).toBe(0.85);
  });

  it('defaults model availability to available and priors to empty', () => {
    const model = parseConfig(makeConfigDocument()).models[0];

    expect(model?.availability).toBe('available');
    expect(model?.priors.skills).toEqual({});
    expect(model?.priors.languages).toEqual({});
  });

  it('defaults provider timeout and retry policy', () => {
    const provider = parseConfig(makeConfigDocument()).providers[0];

    expect(provider?.timeoutMs).toBeGreaterThan(0);
    expect(provider?.retry.maxAttempts).toBeGreaterThan(0);
    expect(provider?.availability).toBe('available');
  });

  it('gives a model nowhere to carry a fabricated sample count', () => {
    // Spec section 39: no fabricated confidence. A configured prior is a
    // judgement, and it must not be able to dress itself up as evidence by
    // shipping a count alongside.
    const config = parseConfig(makeConfigDocument());
    const declared = JSON.stringify({ models: config.models, providers: config.providers });

    expect(declared).not.toMatch(/sample|observ|trainingcount|evidence|confidence/i);
  });

  it('names every observation-shaped setting as a threshold, never as data', () => {
    // Broader than the check above and deliberately so. Policy settings *may*
    // mention observations — `minimumObservations` is a gate — but a bare
    // `observations` key anywhere in a configuration would be a count the user
    // asserted rather than something RoutePilot measured.
    const config = parseConfig(makeConfigDocument());
    const offenders: string[] = [];

    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (/observ|sample/i.test(key) && !/^minimum/.test(key)) {
          offenders.push(`${path}.${key}`);
        }
        walk(child, `${path}.${key}`);
      }
    };

    walk(config, 'config');
    expect(offenders).toEqual([]);
  });

  it('accepts partial skill priors without demanding every dimension', () => {
    const config = parseConfig(
      withModel({ priors: { skills: { debugging: 0.9 }, languages: { typescript: 0.8 } } }),
    );

    expect(config.models[0]?.priors.skills).toEqual({ debugging: 0.9 });
    expect(config.models[0]?.priors.languages).toEqual({ typescript: 0.8 });
  });
});

describe('parseConfig — malformed documents', () => {
  it.each([
    ['a string', 'not a config'],
    ['null', null],
    ['a number', 42],
    ['an array', []],
  ])('rejects %s', (_label, document) => {
    expect(() => parseConfig(document)).toThrow(ConfigurationError);
  });

  it('rejects a missing version', () => {
    expect(paths(expectRejected({ providers: [], models: [] }))).toContain('version');
  });

  it('rejects an unsupported version', () => {
    expect(paths(expectRejected({ version: 2 }))).toContain('version');
  });

  it('reports every problem, not only the first', () => {
    const error = expectRejected({
      version: 1,
      routing: { minimumSuccessProbability: 5, maxRisk: -1 },
    });

    expect(error.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('reports the path of the offending field', () => {
    expect(paths(expectRejected(withModel({ contextWindow: -5 })))).toContain(
      'models[0].contextWindow',
    );
  });
});

describe('parseConfig — credential safety', () => {
  it('rejects an inline credential and points at auth.envVar', () => {
    const error = expectRejected(withProvider({ apiKey: 'sk-ant-not-a-real-key' }));
    const issue = error.issues.find((i) => i.path === 'providers[0]');

    expect(issue?.message).toContain('apiKey');
    expect(issue?.hint).toContain('auth.envVar');
    expect(issue?.hint).toContain('never stores credentials');
  });

  it('never echoes the credential value back in the error', () => {
    // The error is printed to a terminal and may be pasted into an issue
    // tracker. Naming the offending key is necessary; repeating its value
    // would leak the secret the rule exists to protect (spec section 51).
    const secret = 'sk-ant-super-secret-value-12345';
    const error = expectRejected(withProvider({ apiKey: secret }));

    expect(error.message).not.toContain(secret);
    for (const issue of error.issues) {
      expect(issue.message).not.toContain(secret);
      expect(issue.hint ?? '').not.toContain(secret);
    }
  });

  it.each(['secret', 'token', 'password', 'credentials', 'bearerToken'])(
    'flags a "%s" key as a credential mistake',
    (key) => {
      const error = expectRejected(withProvider({ [key]: 'value' }));
      expect(error.issues[0]?.hint).toContain('auth.envVar');
    },
  );

  it('rejects an envVar that looks like a credential value rather than a name', () => {
    const error = expectRejected(
      withProvider({ auth: { kind: 'apiKey', envVar: 'sk-ant-api03-actual-secret' } }),
    );

    expect(paths(error)).toContain('providers[0].auth.envVar');
  });

  it('requires an envVar for every scheme except "none"', () => {
    const error = expectRejected(withProvider({ auth: { kind: 'apiKey' } }));
    expect(error.issues[0]?.message).toContain('requires envVar');
  });

  it('allows a provider that needs no authentication', () => {
    expect(() => parseConfig(withProvider({ auth: { kind: 'none' } }))).not.toThrow();
  });

  it('rejects unknown keys anywhere, so a typo never passes silently', () => {
    const error = expectRejected({ version: 1, modles: [] });
    expect(error.issues[0]?.message).toContain('modles');
  });
});

describe('parseConfig — cross-field rules', () => {
  it('rejects a model referencing an unknown provider and names the known ones', () => {
    const error = expectRejected(withModel({ providerId: 'ghost', id: 'ghost/fast-1' }));
    const issue = error.issues.find((i) => i.path === 'models[0].providerId');

    expect(issue?.message).toContain('unknown provider "ghost"');
    expect(issue?.hint).toContain('acme');
  });

  it('rejects a model id that does not carry its provider prefix', () => {
    const error = expectRejected(withModel({ id: 'wrong-prefix/fast-1' }));
    expect(error.issues.some((i) => i.message.includes('provider prefix'))).toBe(true);
  });

  it('rejects duplicate model ids rather than letting one shadow the other', () => {
    const error = expectRejected(
      makeConfigDocument({ models: [makeModelDocument(), makeModelDocument()] }),
    );

    expect(error.issues.some((i) => i.message.includes('duplicate model id'))).toBe(true);
  });

  it('rejects duplicate provider ids', () => {
    const error = expectRejected(
      makeConfigDocument({ providers: [makeProviderDocument(), makeProviderDocument()] }),
    );

    expect(error.issues.some((i) => i.message.includes('duplicate provider id'))).toBe(true);
  });

  it('rejects a routing default that names an unknown provider', () => {
    const error = expectRejected(
      makeConfigDocument({ routing: { defaultProviderId: 'nonexistent' } }),
    );

    expect(paths(error)).toContain('routing.defaultProviderId');
  });

  it('rejects a routing fallback that names an unknown provider', () => {
    const error = expectRejected(
      makeConfigDocument({ routing: { fallbackProviderId: 'nonexistent' } }),
    );

    expect(paths(error)).toContain('routing.fallbackProviderId');
  });

  it('rejects prices in a currency the budget cannot be compared against', () => {
    const document = makeConfigDocument({
      budgets: { currency: 'USD' },
      models: [
        makeModelDocument({
          pricing: { inputPerMillion: 1, outputPerMillion: 5, currency: 'EUR' },
        }),
      ],
    });

    const error = expectRejected(document);
    const issue = error.issues.find((i) => i.path === 'models[0].pricing.currency');

    expect(issue?.message).toContain('EUR');
    expect(issue?.hint).toContain('single');
  });

  it('rejects a request budget larger than the session budget', () => {
    const error = expectRejected(makeConfigDocument({ budgets: { request: 50, session: 10 } }));
    expect(paths(error)).toContain('budgets.request');
  });

  it('rejects a daily budget larger than the monthly budget', () => {
    const error = expectRejected(makeConfigDocument({ budgets: { daily: 500, monthly: 100 } }));
    expect(paths(error)).toContain('budgets.daily');
  });

  it('accepts budgets that are absent at some scopes', () => {
    expect(() => parseConfig(makeConfigDocument({ budgets: { monthly: 100 } }))).not.toThrow();
  });

  it('rejects enabling learning with nothing to learn about', () => {
    const error = expectRejected({ version: 1, learning: { enabled: true } });
    expect(paths(error)).toContain('learning.enabled');
  });

  it('rejects a maxOutputTokens larger than the context window', () => {
    const error = expectRejected(withModel({ contextWindow: 100_000, maxOutputTokens: 500_000 }));
    expect(paths(error)).toContain('models[0].maxOutputTokens');
  });
});

describe('parseConfig — value ranges', () => {
  it.each([
    ['minimumSuccessProbability above 1', { minimumSuccessProbability: 1.5 }],
    ['minimumSuccessProbability below 0', { minimumSuccessProbability: -0.1 }],
    ['maxRisk above 1', { maxRisk: 2 }],
    ['negative maxLatencySeconds', { maxLatencySeconds: -1 }],
    ['fractional maxEscalationsPerTask', { maxEscalationsPerTask: 1.5 }],
    ['negative maxRetriesPerModel', { maxRetriesPerModel: -1 }],
  ])('rejects %s', (_label, routing) => {
    expect(() => parseConfig(makeConfigDocument({ routing }))).toThrow(ConfigurationError);
  });

  it('rejects a skill prior outside [0, 1]', () => {
    expect(() => parseConfig(withModel({ priors: { skills: { debugging: 1.4 } } }))).toThrow(
      ConfigurationError,
    );
  });

  it('rejects an unknown skill dimension', () => {
    expect(() => parseConfig(withModel({ priors: { skills: { telepathy: 0.9 } } }))).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a language prior outside [0, 1]', () => {
    expect(() => parseConfig(withModel({ priors: { languages: { rust: 3 } } }))).toThrow(
      ConfigurationError,
    );
  });

  it('rejects negative pricing', () => {
    const error = expectRejected(
      withModel({ pricing: { inputPerMillion: -1, outputPerMillion: 5 } }),
    );

    expect(paths(error)).toContain('models[0].pricing.inputPerMillion');
  });

  it('accepts zero pricing, which is how a free local model is expressed', () => {
    expect(() =>
      parseConfig(withModel({ pricing: { inputPerMillion: 0, outputPerMillion: 0 } })),
    ).not.toThrow();
  });

  it('rejects a zero or negative context window', () => {
    expect(paths(expectRejected(withModel({ contextWindow: 0 })))).toContain(
      'models[0].contextWindow',
    );
  });

  it('rejects a malformed currency code', () => {
    const error = expectRejected(makeConfigDocument({ budgets: { currency: 'dollars' } }));
    expect(paths(error)).toContain('budgets.currency');
  });

  it('rejects a malformed verifiedAt date', () => {
    const error = expectRejected(
      withModel({
        pricing: { inputPerMillion: 1, outputPerMillion: 5, verifiedAt: 'last Tuesday' },
      }),
    );

    expect(paths(error)).toContain('models[0].pricing.verifiedAt');
  });

  it('rejects a malformed provider endpoint', () => {
    const error = expectRejected(withProvider({ endpoint: 'not a url' }));
    expect(paths(error)).toContain('providers[0].endpoint');
  });

  it('rejects an id that is not a safe identifier', () => {
    expect(paths(expectRejected(withProvider({ id: 'Has Spaces' })))).toContain('providers[0].id');
  });
});

describe('ConfigurationError formatting', () => {
  it('renders every issue with its path and hint', () => {
    const error = new ConfigurationError(
      'Invalid RoutePilot configuration',
      [
        { path: 'models[0].providerId', message: 'unknown provider "ghost"', hint: 'Known: acme.' },
        { path: 'budgets.currency', message: 'must be a 3-letter ISO 4217 code' },
      ],
      '/tmp/routepilot.config.json',
    );

    expect(error.message).toContain('/tmp/routepilot.config.json');
    expect(error.message).toContain('models[0].providerId: unknown provider "ghost"');
    expect(error.message).toContain('hint: Known: acme.');
    expect(error.message).toContain('budgets.currency');
    expect(error.name).toBe('ConfigurationError');
  });

  it('labels a root-level issue readably', () => {
    const error = new ConfigurationError('bad', [{ path: '', message: 'not an object' }]);
    expect(error.message).toContain('(root): not an object');
  });
});
