/**
 * CLI test harness.
 *
 * Drives the real `run(argv, io)` entry point with captured output, against a
 * real configuration file on disk. Shared so that CLI tests in different files
 * exercise the same fixture rather than drifting apart.
 *
 * Excluded from the published build (see tsconfig.build.json).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, type CliIO } from '../cli/main.js';
import { makeConfigDocument, type ConfigDocument } from './fixtures.js';

/** The result of one captured CLI invocation. */
export interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the CLI with captured output. */
export async function invokeCli(...argv: string[]): Promise<Captured> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const io: CliIO = {
    out: (text) => outChunks.push(text),
    err: (text) => errChunks.push(text),
  };

  const code = await run(argv, io);
  return { code, stdout: outChunks.join('\n'), stderr: errChunks.join('\n') };
}

/**
 * A four-model, two-provider configuration.
 *
 * Spans tiers, capabilities and providers so that eligibility, exclusion and
 * routing all have something to work with. Priors are set so the tiers behave
 * distinguishably; vendor names are invented (see `fixtures.ts`).
 */
export function cliConfigDocument(): ConfigDocument {
  const skills = (base: number): Record<string, number> => ({
    codeGeneration: base,
    codeEditing: Math.min(1, base + 0.12),
    debugging: Math.max(0, base - 0.12),
    refactoring: Math.max(0, base - 0.1),
    architecture: Math.max(0, base - 0.25),
    reasoning: Math.max(0, base - 0.12),
    testGeneration: Math.max(0, base - 0.02),
    documentation: Math.min(1, base + 0.1),
    multiFileReasoning: Math.max(0, base - 0.2),
  });

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
        contextWindow: 200_000,
        pricing: { inputPerMillion: 0.5, outputPerMillion: 2.5 },
        priors: { skills: skills(0.74), languages: { typescript: 0.76 } },
      },
      {
        ...base,
        id: 'acme/balanced-1',
        modelId: 'balanced-1',
        displayName: 'Acme Balanced 1',
        tier: 'medium',
        contextWindow: 500_000,
        maxOutputTokens: 64_000,
        pricing: { inputPerMillion: 3, outputPerMillion: 15 },
        priors: { skills: skills(0.87), languages: { typescript: 0.87 } },
      },
      {
        ...base,
        id: 'acme/deep-1',
        modelId: 'deep-1',
        displayName: 'Acme Deep 1',
        tier: 'frontier',
        contextWindow: 1_000_000,
        pricing: { inputPerMillion: 10, outputPerMillion: 50 },
        priors: { skills: skills(0.93), languages: { typescript: 0.93 } },
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
    routing: { maxLatencySeconds: 1800 },
  });
}

/** A materialised workspace plus its configuration file. */
export interface CliWorkspace {
  readonly dir: string;
  readonly configPath: string;
  cleanup(): Promise<void>;
}

/** Create a temporary workspace containing a valid RoutePilot configuration. */
export async function createCliWorkspace(
  document: ConfigDocument = cliConfigDocument(),
): Promise<CliWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'routepilot-cli-'));
  const configPath = join(dir, 'routepilot.config.json');

  await writeFile(configPath, JSON.stringify(document), 'utf8');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'workspace' }), 'utf8');
  await writeFile(join(dir, 'index.ts'), 'export const x = 1;\n', 'utf8');

  return {
    dir,
    configPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
