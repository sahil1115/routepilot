/**
 * Configuration discovery and loading.
 *
 * Where a configuration came from is part of the answer, so callers get the
 * resolved source alongside the parsed document. A router that silently picked
 * up a config from somewhere unexpected is a router nobody can debug.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigurationError } from './errors.js';
import { parseConfig } from './schema.js';
import type { RoutePilotConfig } from './types.js';

/** Environment variable that overrides configuration discovery. */
export const CONFIG_ENV_VAR = 'ROUTEPILOT_CONFIG';

/** File names searched, in order, when no path is given. */
export const CONFIG_FILE_CANDIDATES = [
  'routepilot.config.json',
  '.routepilot.json',
  'config/routepilot.json',
] as const;

/** How a configuration was located. */
export const CONFIG_SOURCE_KINDS = [
  'explicit',
  'environment',
  'discovered',
  'bundled-example',
] as const;

/** How a configuration was located. */
export type ConfigSourceKind = (typeof CONFIG_SOURCE_KINDS)[number];

/** A loaded configuration and where it came from. */
export interface LoadedConfig {
  readonly config: RoutePilotConfig;
  /** Absolute path of the file that was read. */
  readonly path: string;
  /** How that file was chosen. */
  readonly sourceKind: ConfigSourceKind;
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Explicit path. Takes precedence over everything else. */
  readonly explicitPath?: string | undefined;
  /** Directory to search. Defaults to the process working directory. */
  readonly cwd?: string | undefined;
  /** Environment to read {@link CONFIG_ENV_VAR} from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * Fall back to the bundled example configuration when nothing is found.
   *
   * Off by default. The CLI turns it on so the tool is usable before a user has
   * written a config, and always reports that it did so.
   */
  readonly allowBundledExample?: boolean | undefined;
}

/** Absolute path of the example configuration shipped with the package. */
export function bundledExampleConfigPath(): string {
  // Resolves identically from `src/config/` and the built `dist/config/`.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'config', 'routepilot.example.json');
}

/**
 * Parse a configuration file.
 *
 * @throws ConfigurationError when the file cannot be read, is not valid JSON,
 * or fails validation.
 */
export async function loadConfigFile(path: string): Promise<RoutePilotConfig> {
  const absolute = resolve(path);

  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch (error) {
    throw new ConfigurationError(
      'Could not read RoutePilot configuration',
      [
        {
          path: '',
          message: error instanceof Error ? error.message : String(error),
          hint: `Check that ${absolute} exists and is readable.`,
        },
      ],
      absolute,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigurationError(
      'RoutePilot configuration is not valid JSON',
      [
        {
          path: '',
          message: error instanceof Error ? error.message : String(error),
          hint: 'Configuration must be a JSON document. Comments and trailing commas are not allowed.',
        },
      ],
      absolute,
    );
  }

  return parseConfig(parsed, absolute);
}

/**
 * Locate and load a configuration.
 *
 * Resolution order: explicit path, then {@link CONFIG_ENV_VAR}, then the
 * candidate file names in `cwd`, then — only when permitted — the bundled
 * example.
 *
 * @throws ConfigurationError with the searched locations when nothing is found.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const explicit = options.explicitPath;
  if (explicit !== undefined) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) {
      throw new ConfigurationError(
        'RoutePilot configuration file not found',
        [{ path: '', message: `no such file: ${path}` }],
        path,
      );
    }
    return { config: await loadConfigFile(path), path, sourceKind: 'explicit' };
  }

  const fromEnv = env[CONFIG_ENV_VAR];
  if (fromEnv !== undefined && fromEnv !== '') {
    const path = resolve(cwd, fromEnv);
    if (!existsSync(path)) {
      throw new ConfigurationError(
        `${CONFIG_ENV_VAR} points at a file that does not exist`,
        [
          {
            path: '',
            message: `no such file: ${path}`,
            hint: `Unset ${CONFIG_ENV_VAR} or fix the path.`,
          },
        ],
        path,
      );
    }
    return { config: await loadConfigFile(path), path, sourceKind: 'environment' };
  }

  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const path = resolve(cwd, candidate);
    if (existsSync(path)) {
      return { config: await loadConfigFile(path), path, sourceKind: 'discovered' };
    }
  }

  if (options.allowBundledExample === true) {
    const path = bundledExampleConfigPath();
    if (existsSync(path)) {
      return { config: await loadConfigFile(path), path, sourceKind: 'bundled-example' };
    }
  }

  throw new ConfigurationError('No RoutePilot configuration found', [
    {
      path: '',
      message: `searched ${CONFIG_FILE_CANDIDATES.map((c) => resolve(cwd, c)).join(', ')}`,
      hint:
        `Create ${CONFIG_FILE_CANDIDATES[0]} in this directory, pass --config <path>, or set ` +
        `${CONFIG_ENV_VAR}. A starting point ships at ${bundledExampleConfigPath()}.`,
    },
  ]);
}
