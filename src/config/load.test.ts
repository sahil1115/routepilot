import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeConfigDocument } from '../test-support/fixtures.js';
import { ConfigurationError } from './errors.js';
import { bundledExampleConfigPath, CONFIG_ENV_VAR, loadConfig, loadConfigFile } from './load.js';
import { buildRegistries } from './registries.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routepilot-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function write(name: string, content: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

describe('loadConfigFile', () => {
  it('loads and validates a configuration file', async () => {
    const path = await write('routepilot.config.json', makeConfigDocument());
    const config = await loadConfigFile(path);

    expect(config.models).toHaveLength(1);
  });

  it('reports an unreadable file with the path', async () => {
    const missing = join(dir, 'nope.json');
    await expect(loadConfigFile(missing)).rejects.toThrow(ConfigurationError);
    await expect(loadConfigFile(missing)).rejects.toThrow(/nope\.json/);
  });

  it('reports invalid JSON distinctly from invalid configuration', async () => {
    const path = await write('routepilot.config.json', '{ not json ]');

    await expect(loadConfigFile(path)).rejects.toThrow(/not valid JSON/);
  });

  it('surfaces validation issues from a file with the file as the source', async () => {
    const path = await write('routepilot.config.json', { version: 1, models: 'nope' });

    await expect(loadConfigFile(path)).rejects.toThrow(/Invalid RoutePilot configuration/);
    await expect(loadConfigFile(path)).rejects.toThrow(/routepilot\.config\.json/);
  });
});

describe('loadConfig — discovery', () => {
  it('prefers an explicit path over everything else', async () => {
    await write('routepilot.config.json', makeConfigDocument());
    const explicit = await write('other.json', makeConfigDocument({ budgets: { monthly: 42 } }));

    const loaded = await loadConfig({ explicitPath: explicit, cwd: dir, env: {} });

    expect(loaded.sourceKind).toBe('explicit');
    expect(loaded.config.budgets.monthly).toBe(42);
  });

  it('fails loudly when an explicit path does not exist', async () => {
    await expect(
      loadConfig({ explicitPath: join(dir, 'ghost.json'), cwd: dir, env: {} }),
    ).rejects.toThrow(/not found/);
  });

  it('reads the path named by the environment variable', async () => {
    const path = await write('from-env.json', makeConfigDocument({ budgets: { monthly: 7 } }));

    const loaded = await loadConfig({ cwd: dir, env: { [CONFIG_ENV_VAR]: path } });

    expect(loaded.sourceKind).toBe('environment');
    expect(loaded.config.budgets.monthly).toBe(7);
  });

  it('fails loudly when the environment variable points at nothing', async () => {
    await expect(
      loadConfig({ cwd: dir, env: { [CONFIG_ENV_VAR]: join(dir, 'ghost.json') } }),
    ).rejects.toThrow(new RegExp(CONFIG_ENV_VAR));
  });

  it('discovers routepilot.config.json in the working directory', async () => {
    await write('routepilot.config.json', makeConfigDocument());

    const loaded = await loadConfig({ cwd: dir, env: {} });

    expect(loaded.sourceKind).toBe('discovered');
    expect(loaded.path).toBe(join(dir, 'routepilot.config.json'));
  });

  it('falls back through the candidate file names in order', async () => {
    await mkdir(join(dir, 'config'), { recursive: true });
    await write(join('config', 'routepilot.json'), makeConfigDocument());

    const loaded = await loadConfig({ cwd: dir, env: {} });

    expect(loaded.sourceKind).toBe('discovered');
    expect(loaded.path).toBe(join(dir, 'config', 'routepilot.json'));
  });

  it('lists where it looked when nothing is found', async () => {
    await expect(loadConfig({ cwd: dir, env: {} })).rejects.toThrow(
      /No RoutePilot configuration found/,
    );
    await expect(loadConfig({ cwd: dir, env: {} })).rejects.toThrow(/routepilot\.config\.json/);
  });

  it('does not use the bundled example unless explicitly permitted', async () => {
    await expect(loadConfig({ cwd: dir, env: {} })).rejects.toThrow(ConfigurationError);

    const loaded = await loadConfig({ cwd: dir, env: {}, allowBundledExample: true });
    expect(loaded.sourceKind).toBe('bundled-example');
  });
});

describe('bundled example configuration', () => {
  it('ships with the package', () => {
    expect(existsSync(bundledExampleConfigPath())).toBe(true);
  });

  it('is valid against the schema', async () => {
    const config = await loadConfigFile(bundledExampleConfigPath());

    expect(config.providers.length).toBeGreaterThan(0);
    expect(config.models.length).toBeGreaterThan(0);
  });

  it('ships with learning and exploration off', async () => {
    const config = await loadConfigFile(bundledExampleConfigPath());

    expect(config.learning.enabled).toBe(false);
    expect(config.learning.exploration.enabled).toBe(false);
    expect(config.routing.modelOverrideEnabled).toBe(false);
  });

  it('contains no credential material', async () => {
    const config = await loadConfigFile(bundledExampleConfigPath());
    const serialised = JSON.stringify(config);

    expect(serialised).not.toMatch(/sk-[a-z0-9-]{8,}/i);
    for (const provider of config.providers) {
      if (provider.auth.kind !== 'none') {
        expect(provider.auth.envVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it('dates every price so staleness is visible', async () => {
    const config = await loadConfigFile(bundledExampleConfigPath());

    for (const model of config.models) {
      expect(model.pricing.verifiedAt, `${model.id} must date its pricing`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    }
  });

  it('builds working registries', async () => {
    const config = await loadConfigFile(bundledExampleConfigPath());
    const { models, providers } = buildRegistries(config);

    expect(models.size).toBe(config.models.length);
    expect(providers.size).toBe(config.providers.length);

    // Every model resolves to a registered provider.
    for (const model of models.list()) {
      expect(providers.has(model.providerId)).toBe(true);
    }
  });
});

describe('buildRegistries', () => {
  it('wires the model registry to the provider registry', async () => {
    const path = await write(
      'routepilot.config.json',
      makeConfigDocument({
        providers: [
          {
            id: 'acme',
            displayName: 'Acme',
            kind: 'cloud',
            auth: { kind: 'none' },
            availability: 'unavailable',
          },
        ],
      }),
    );
    const config = await loadConfigFile(path);
    const { models } = buildRegistries(config);

    // The model is available; its provider is not. Provider availability must win.
    const result = models.findEligible();
    expect(result.eligible).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe('PROVIDER_UNAVAILABLE');
  });
});
