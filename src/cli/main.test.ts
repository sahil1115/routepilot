/**
 * CLI acceptance tests.
 *
 * Phase 1's acceptance criterion is that a CLI or test can list models and
 * determine eligibility. These tests exercise that through the real CLI entry
 * point, against a real configuration file on disk.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  makeConfigDocument,
  makeModelDocument,
  type ConfigDocument,
} from '../test-support/fixtures.js';
import { EXIT_ERROR, EXIT_NO_MODEL, EXIT_OK, EXIT_USAGE, run, type CliIO } from './main.js';

let dir: string;
let configPath: string;

/** A four-model configuration spanning tiers, capabilities and availability. */
function fourModelConfig(): ConfigDocument {
  const base = {
    providerId: 'acme',
    latency: { firstTokenSeconds: 0.5, outputTokensPerSecond: 100 },
    capabilities: {
      toolUse: true,
      agenticExecution: true,
      streaming: true,
      structuredOutput: true,
    },
  };

  return makeConfigDocument({
    providers: [
      {
        id: 'acme',
        displayName: 'Acme',
        kind: 'cloud',
        auth: { kind: 'apiKey', envVar: 'ACME_KEY' },
      },
      { id: 'globex', displayName: 'Globex', kind: 'local', auth: { kind: 'none' } },
    ],
    models: [
      {
        ...base,
        id: 'acme/fast-1',
        modelId: 'fast-1',
        displayName: 'Acme Fast 1',
        tier: 'cheap',
        contextWindow: 32_000,
        pricing: { inputPerMillion: 1, outputPerMillion: 5 },
      },
      {
        ...base,
        id: 'acme/balanced-1',
        modelId: 'balanced-1',
        displayName: 'Acme Balanced 1',
        tier: 'medium',
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
        pricing: { inputPerMillion: 3, outputPerMillion: 15 },
      },
      {
        ...base,
        id: 'acme/deep-1',
        modelId: 'deep-1',
        displayName: 'Acme Deep 1',
        tier: 'frontier',
        contextWindow: 500_000,
        pricing: { inputPerMillion: 10, outputPerMillion: 50 },
      },
      {
        ...base,
        id: 'globex/text-only',
        providerId: 'globex',
        modelId: 'text-only',
        displayName: 'Globex Text Only',
        tier: 'cheap',
        contextWindow: 8_000,
        capabilities: {
          toolUse: false,
          agenticExecution: false,
          streaming: true,
          structuredOutput: false,
        },
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
      },
    ],
  });
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function invoke(...argv: string[]): Promise<Captured> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const io: CliIO = {
    out: (text) => outChunks.push(text),
    err: (text) => errChunks.push(text),
  };

  const code = await run(argv, io);
  return { code, stdout: outChunks.join('\n'), stderr: errChunks.join('\n') };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routepilot-cli-'));
  configPath = join(dir, 'routepilot.config.json');
  await writeFile(configPath, JSON.stringify(fourModelConfig()), 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('routepilot help', () => {
  it('prints usage by default', async () => {
    const result = await invoke();

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('routepilot models');
  });

  it('names the commands that do not exist yet rather than pretending', async () => {
    const result = await invoke('help');
    expect(result.stdout).toContain('Not yet available');
    // A reason, not a phase number: the phase a command is waiting for changes
    // as phases land, and pinning one here kept a stale explanation alive.
    expect(result.stdout).toContain('history');
    expect(result.stdout).toContain('telemetry store');
  });

  it('lists run as a real command now that it has one', async () => {
    // `run` moved out of the not-yet list in Phase 21. It is listed as usable
    // and its caveat is carried in the default behaviour — it plans unless
    // asked to execute — rather than by withholding the command.
    const result = await invoke('help');
    expect(result.stdout).toContain('routepilot run');
    expect(result.stdout).toContain('--execute');
  });

  it('prints the version for a bare --version, not the usage text', async () => {
    // `command` defaults to `help` when no positional is given, so the help
    // branch used to swallow `--version` and print the entire usage block.
    const result = await invoke('--version');

    expect(result.stdout).toMatch(/^RoutePilot \d+\.\d+\.\d+ \(implemented phase \d+\)$/);
    expect(result.stdout).not.toContain('Usage:');
  });

  it('prints the same version for the version subcommand', async () => {
    const flag = await invoke('--version');
    const subcommand = await invoke('version');

    expect(subcommand.stdout).toBe(flag.stdout);
  });

  it('rejects an unknown command with a usage exit code', async () => {
    const result = await invoke('teleport');

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('Unknown command "teleport"');
  });
});

describe('routepilot models — listing', () => {
  it('lists every configured model', async () => {
    const result = await invoke('models', '--config', configPath);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Configured models (4)');
    expect(result.stdout).toContain('acme/fast-1');
    expect(result.stdout).toContain('acme/balanced-1');
    expect(result.stdout).toContain('acme/deep-1');
    expect(result.stdout).toContain('globex/text-only');
  });

  it('shows tier, context, price and capabilities', async () => {
    const result = await invoke('models', '--config', configPath);

    expect(result.stdout).toContain('TIER');
    expect(result.stdout).toContain('frontier');
    expect(result.stdout).toContain('500,000');
    expect(result.stdout).toContain('10.00/50.00 USD');
    expect(result.stdout).toContain('agenticExecution');
  });

  it('emits machine-readable JSON on request', async () => {
    const result = await invoke('models', '--config', configPath, '--json');
    const parsed = JSON.parse(result.stdout) as {
      eligible: { id: string }[];
      excluded: unknown[];
      filtered: boolean;
    };

    expect(parsed.filtered).toBe(false);
    expect(parsed.eligible.map((m) => m.id)).toEqual([
      'acme/balanced-1',
      'acme/deep-1',
      'acme/fast-1',
      'globex/text-only',
    ]);
    expect(parsed.excluded).toEqual([]);
  });

  it('lists gated models in an unfiltered inventory, marked as gated', async () => {
    // Regression: an unfiltered listing once ran the eligibility filter, so an
    // opt-in-required model vanished from the table while still being counted
    // in the heading.
    const gatedPath = join(dir, 'gated.json');
    const document = fourModelConfig();
    const models = document.models;
    models.push(
      makeModelDocument({
        id: 'acme/preview-1',
        modelId: 'preview-1',
        displayName: 'Acme Preview 1',
        tier: 'ultra',
        constraints: { requiresExplicitOptIn: true },
      }),
    );
    await writeFile(gatedPath, JSON.stringify(document), 'utf8');

    const result = await invoke('models', '--config', gatedPath);

    expect(result.stdout).toContain('Configured models (5)');
    expect(result.stdout).toContain('acme/preview-1');
    expect(result.stdout).toContain('(opt-in)');

    // The rows and the heading must agree.
    const rowCount = result.stdout
      .split('\n')
      .filter((line) => line.includes('acme/') || line.includes('globex/')).length;
    expect(rowCount).toBe(5);
  });

  it('still excludes a gated model once a filter is applied', async () => {
    const gatedPath = join(dir, 'gated2.json');
    const document = fourModelConfig();
    const models = document.models;
    models.push(
      makeModelDocument({
        id: 'acme/preview-2',
        modelId: 'preview-2',
        displayName: 'Acme Preview 2',
        tier: 'ultra',
        constraints: { requiresExplicitOptIn: true },
      }),
    );
    await writeFile(gatedPath, JSON.stringify(document), 'utf8');

    const result = await invoke('models', '--config', gatedPath, '--tier', 'ultra', '--json');
    const parsed = JSON.parse(result.stdout) as {
      eligible: { id: string }[];
      excluded: { modelId: string; reason: string }[];
    };

    expect(parsed.eligible).toEqual([]);
    expect(parsed.excluded).toContainEqual(
      expect.objectContaining({ modelId: 'acme/preview-2', reason: 'REQUIRES_EXPLICIT_OPT_IN' }),
    );

    const opted = await invoke(
      'models',
      '--config',
      gatedPath,
      '--tier',
      'ultra',
      '--opt-in',
      'acme/preview-2',
      '--json',
    );
    const optedParsed = JSON.parse(opted.stdout) as { eligible: { id: string }[] };
    expect(optedParsed.eligible.map((m) => m.id)).toEqual(['acme/preview-2']);
  });
});

describe('routepilot models — eligibility', () => {
  it('filters by required context window', async () => {
    const result = await invoke('models', '--config', configPath, '--context', '100000', '--json');
    const parsed = JSON.parse(result.stdout) as {
      eligible: { id: string }[];
      excluded: { modelId: string; reason: string }[];
    };

    expect(parsed.eligible.map((m) => m.id)).toEqual(['acme/balanced-1', 'acme/deep-1']);
    expect(parsed.excluded.map((e) => e.reason)).toEqual([
      'CONTEXT_WINDOW_TOO_SMALL',
      'CONTEXT_WINDOW_TOO_SMALL',
    ]);
  });

  it('filters by required capability', async () => {
    const result = await invoke(
      'models',
      '--config',
      configPath,
      '--require',
      'agenticExecution',
      '--json',
    );
    const parsed = JSON.parse(result.stdout) as {
      eligible: { id: string }[];
      excluded: { modelId: string; reason: string }[];
    };

    expect(parsed.eligible.map((m) => m.id)).not.toContain('globex/text-only');
    expect(parsed.excluded).toEqual([
      expect.objectContaining({ modelId: 'globex/text-only', reason: 'MISSING_CAPABILITY' }),
    ]);
  });

  it('accepts kebab-case capability names', async () => {
    const kebab = await invoke('models', '--config', configPath, '--require', 'tool-use', '--json');
    const camel = await invoke('models', '--config', configPath, '--require', 'toolUse', '--json');

    expect(kebab.stdout).toBe(camel.stdout);
  });

  it('accepts comma-separated and repeated filters', async () => {
    const commas = await invoke(
      'models',
      '--config',
      configPath,
      '--tier',
      'cheap,medium',
      '--json',
    );
    const repeated = await invoke(
      'models',
      '--config',
      configPath,
      '--tier',
      'cheap',
      '--tier',
      'medium',
      '--json',
    );

    expect(commas.stdout).toBe(repeated.stdout);
    const parsed = JSON.parse(commas.stdout) as { eligible: { id: string }[] };
    expect(parsed.eligible.map((m) => m.id)).toEqual([
      'acme/balanced-1',
      'acme/fast-1',
      'globex/text-only',
    ]);
  });

  it('filters by provider', async () => {
    const result = await invoke('models', '--config', configPath, '--provider', 'globex', '--json');
    const parsed = JSON.parse(result.stdout) as { eligible: { id: string }[] };

    expect(parsed.eligible.map((m) => m.id)).toEqual(['globex/text-only']);
  });

  it('combines filters conjunctively', async () => {
    const result = await invoke(
      'models',
      '--config',
      configPath,
      '--context',
      '100000',
      '--tier',
      'medium',
      '--json',
    );
    const parsed = JSON.parse(result.stdout) as { eligible: { id: string }[] };

    expect(parsed.eligible.map((m) => m.id)).toEqual(['acme/balanced-1']);
  });

  it('explains why each model was excluded', async () => {
    const result = await invoke('models', '--config', configPath, '--context', '100000');

    expect(result.stdout).toContain('Excluded (2)');
    expect(result.stdout).toContain('[CONTEXT_WINDOW_TOO_SMALL]');
    expect(result.stdout).toContain('32,000');
    expect(result.stdout).toContain('100,000');
  });

  it('omits the exclusion list when asked for eligible models only', async () => {
    const result = await invoke(
      'models',
      '--config',
      configPath,
      '--context',
      '100000',
      '--eligible-only',
    );

    expect(result.stdout).toContain('Eligible models (2 of 4)');
    expect(result.stdout).not.toContain('Excluded');
  });

  it('says plainly when nothing is eligible', async () => {
    const result = await invoke('models', '--config', configPath, '--context', '10000000');

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('No model satisfies these requirements.');
  });

  it('rejects an unknown capability with a usage error listing the valid ones', async () => {
    const result = await invoke('models', '--config', configPath, '--require', 'telepathy');

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('unknown capability "telepathy"');
    expect(result.stderr).toContain('agenticExecution');
  });

  it('rejects an unknown tier', async () => {
    const result = await invoke('models', '--config', configPath, '--tier', 'gigantic');

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('unknown tier "gigantic"');
  });

  it('rejects a non-numeric context value', async () => {
    const result = await invoke('models', '--config', configPath, '--context', 'lots');

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('--context must be a non-negative integer');
  });

  it('rejects a value flag with no value', async () => {
    const result = await invoke('models', '--config');

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('--config requires a value');
  });
});

describe('routepilot providers', () => {
  it('lists providers with their auth source but never a secret', async () => {
    const result = await invoke('providers', '--config', configPath);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('acme');
    expect(result.stdout).toContain('globex');
    expect(result.stdout).toContain('apiKey via $ACME_KEY');
    expect(result.stdout).toContain('none');
  });
});

describe('routepilot config validate', () => {
  it('confirms a valid configuration and summarises it', async () => {
    const result = await invoke('config', 'validate', '--config', configPath);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Configuration is valid');
    expect(result.stdout).toContain('providers: 2');
    expect(result.stdout).toContain('models:    4');
    expect(result.stdout).toContain('learning:  disabled');
    expect(result.stdout).toContain('telemetry: enabled (privacy: strict)');
  });

  it('reports an invalid configuration with paths and a failure exit code', async () => {
    const badPath = join(dir, 'bad.json');
    await writeFile(
      badPath,
      JSON.stringify({ version: 1, providers: [], models: [{ id: 'x' }] }),
      'utf8',
    );

    const result = await invoke('config', 'validate', '--config', badPath);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.stderr).toContain('Invalid RoutePilot configuration');
    expect(result.stderr).toContain('models[0]');
  });

  it('reports a missing configuration file rather than inventing one', async () => {
    const result = await invoke('config', 'validate', '--config', join(dir, 'ghost.json'));

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.stderr).toContain('not found');
  });

  it('rejects an unknown subcommand', async () => {
    const result = await invoke('config', 'reticulate', '--config', configPath);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('Unknown subcommand');
  });
});

describe('bundled example fallback', () => {
  it('announces on stderr that it fell back, and still works', async () => {
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      await rm(configPath);
      const result = await invoke('models');

      expect(result.code).toBe(EXIT_OK);
      expect(result.stderr).toContain('no configuration found, using the bundled example');
      expect(result.stdout).toContain('Configured models');
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe('routepilot analyze', () => {
  it('classifies a task and reports what it understood', async () => {
    const result = await invoke('analyze', 'fix the failing parser test', '--root', dir);

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('Task');
    expect(result.stdout).toContain('type:');
    expect(result.stdout).toContain('Why');
    expect(result.stdout).toContain('Repository');
    expect(result.stdout).toContain('Context estimate');
  });

  it('says plainly that it selected no model', async () => {
    const result = await invoke('analyze', 'refactor everything', '--root', dir);
    expect(result.stdout).toContain('No model selected');
  });

  it('emits JSON with classification, features and repository facts', async () => {
    const result = await invoke('analyze', 'add unit tests', '--root', dir, '--json');
    const parsed = JSON.parse(result.stdout) as {
      classification: { taskType: string; signals: unknown[] };
      features: { task: unknown; repository: unknown; context: unknown; history: unknown };
      repository: { level: number; cache: unknown };
    };

    expect(parsed.classification.taskType).toBe('test-generation');
    expect(parsed.classification.signals.length).toBeGreaterThan(0);
    expect(parsed.features.task).toBeDefined();
    expect(parsed.features.repository).toBeDefined();
    expect(parsed.features.context).toBeDefined();
    expect(parsed.repository.level).toBeGreaterThanOrEqual(1);
  });

  it('chooses a deeper analysis level for a repository-wide task', async () => {
    const shallow = await invoke('analyze', 'explain this file', '--root', dir, '--json');
    const deep = await invoke(
      'analyze',
      'migrate the whole codebase to a new architecture',
      '--root',
      dir,
      '--json',
    );

    const shallowLevel = (JSON.parse(shallow.stdout) as { repository: { level: number } })
      .repository.level;
    const deepLevel = (JSON.parse(deep.stdout) as { repository: { level: number } }).repository
      .level;

    expect(deepLevel).toBeGreaterThan(shallowLevel);
  });

  it('honours an explicit level', async () => {
    const result = await invoke('analyze', 'explain this', '--root', dir, '--level', '3', '--json');
    const parsed = JSON.parse(result.stdout) as { repository: { level: number } };

    expect(parsed.repository.level).toBe(3);
  });

  it('rejects an invalid level', async () => {
    const result = await invoke('analyze', 'explain this', '--root', dir, '--level', '9');

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('--level must be 1, 2 or 3');
  });

  it('requires a task', async () => {
    const result = await invoke('analyze', '--root', dir);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('analyze requires a task');
  });
});

describe('routepilot route', () => {
  it('selects a model and explains why', async () => {
    const result = await invoke(
      'route',
      'rename the variable userId to userIdentifier',
      '--root',
      dir,
      '--config',
      configPath,
    );

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('RoutePilot: acme/');
    expect(result.stdout).toContain('Candidates (');
    expect(result.stdout).toContain('Estimated cost');
    expect(result.stdout).toContain('Policy');
  });

  it('says plainly that it executed nothing', async () => {
    const result = await invoke('route', 'add a feature', '--root', dir, '--config', configPath);
    expect(result.stdout).toContain('Nothing was executed');
  });

  it('honours an explicit model', async () => {
    const result = await invoke(
      'route',
      'rename a variable',
      '--root',
      dir,
      '--config',
      configPath,
      '--model',
      'acme/deep-1',
      '--json',
    );
    const parsed = JSON.parse(result.stdout) as {
      decision: { selectedModelId: string; outcome: string };
    };

    expect(parsed.decision.selectedModelId).toBe('acme/deep-1');
    expect(parsed.decision.outcome).toBe('selected-explicit');
  });

  it('reports an unknown explicit model with a failure exit code', async () => {
    const result = await invoke(
      'route',
      'rename a variable',
      '--root',
      dir,
      '--config',
      configPath,
      '--model',
      'nope/nope',
    );

    // An unknown model id is a mistake to fix, not a routing decline.
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.stdout).toContain('not configured');
  });

  it('stops safely on an impossible budget rather than overspending', async () => {
    const result = await invoke(
      'route',
      'implement a new endpoint',
      '--root',
      dir,
      '--config',
      configPath,
      '--budget',
      '0',
    );

    // The router worked and declined; that is not the same as an error.
    expect(result.code).toBe(EXIT_NO_MODEL);
    expect(result.stdout).toContain('no model selected');
    expect(result.stdout).toContain('budget');
  });

  it('lists every excluded model with its reason', async () => {
    const result = await invoke(
      'route',
      'implement a new endpoint',
      '--root',
      dir,
      '--config',
      configPath,
      '--json',
    );
    const parsed = JSON.parse(result.stdout) as {
      decision: { excluded: { modelId: string; reason: string; detail: string }[] };
    };

    for (const exclusion of parsed.decision.excluded) {
      expect(exclusion.reason.length).toBeGreaterThan(0);
      expect(exclusion.detail).toContain(exclusion.modelId);
    }
  });

  it('is deterministic across separate process-level invocations', async () => {
    const first = await invoke(
      'route',
      'implement a new /users endpoint',
      '--root',
      dir,
      '--config',
      configPath,
      '--json',
    );
    const second = await invoke(
      'route',
      'implement a new /users endpoint',
      '--root',
      dir,
      '--config',
      configPath,
      '--json',
    );

    expect(second.stdout).toBe(first.stdout);
  });

  it('rejects a nonsensical min-success value', async () => {
    const result = await invoke(
      'route',
      'rename a variable',
      '--root',
      dir,
      '--config',
      configPath,
      '--min-success',
      '5',
    );

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('--min-success must be between 0 and 1');
  });

  it('requires a task', async () => {
    const result = await invoke('route', '--root', dir, '--config', configPath);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('route requires a task');
  });
});

describe('routepilot run — flags', () => {
  it('rejects --allow-over-budget without --execute as a usage error', async () => {
    // The flag only affects execution. Accepting it on a plan would let
    // someone believe they had authorised an overspend when nothing was run.
    const result = await invoke('run', 'rename a variable', '--allow-over-budget');

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('--execute');
  });
});
