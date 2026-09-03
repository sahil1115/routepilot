/**
 * Choosing a telemetry store from configuration.
 *
 * One place decides whether telemetry is on, so no caller has to. When it is
 * off — or when opening the database fails for any reason — a
 * {@link NullTelemetryStore} is returned and RoutePilot carries on. Telemetry
 * is an observer; it is never a reason to fail a user's task
 * (spec section 2, rule 17).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PredictionStore } from '../core/types/calibration.js';
import type { ShadowStore } from '../core/types/shadow.js';
import type { LearningStore } from '../core/types/learning.js';
import type { TelemetryStore } from '../core/types/telemetry.js';
import { NullTelemetryStore } from './null-store.js';
import { SqliteTelemetryStore } from './sqlite-store.js';

/** Options for {@link openTelemetryStore}. */
export interface OpenTelemetryOptions {
  readonly enabled: boolean;
  /** Directory for the database. Defaults to `~/.routepilot`. */
  readonly storagePath?: string | undefined;
  /** Workspace root, so absolute paths are made relative before storage. */
  readonly workspaceRoot?: string | undefined;
  /** Called when telemetry degrades, so the user can be told. */
  readonly onProblem?: ((message: string) => void) | undefined;
}

/** The default location: a dot-directory in the user's home. */
export function defaultStorageDirectory(): string {
  return join(homedir(), '.routepilot');
}

/**
 * The local store, which serves both telemetry and learning.
 *
 * One file, one set of privacy guarantees, one corruption fallback. Learning
 * without recorded outcomes would have nothing to learn from, so splitting them
 * would only mean two ways for the same thing to be switched off.
 */
export type LocalStore = TelemetryStore & LearningStore & PredictionStore & ShadowStore;

/** Open the configured store, falling back to a no-op store on any problem. */
export async function openTelemetryStore(options: OpenTelemetryOptions): Promise<LocalStore> {
  if (!options.enabled) return new NullTelemetryStore();

  try {
    return await SqliteTelemetryStore.open({
      directory: options.storagePath ?? defaultStorageDirectory(),
      ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
      ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
    });
  } catch (error) {
    options.onProblem?.(
      `Telemetry could not be started, so nothing will be recorded. ` +
        `Routing is unaffected. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new NullTelemetryStore();
  }
}
