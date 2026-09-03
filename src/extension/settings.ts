/**
 * VS Code settings, and what they are allowed to change (spec section 49).
 *
 * Pure: takes whatever the editor read out of `settings.json` and produces
 * validated overrides. The shell passes values in; nothing here touches the
 * editor.
 *
 * ## Settings narrow, they never widen
 *
 * A workspace `.vscode/settings.json` is a file in a repository. It can arrive
 * through a clone, a branch, or a pull request from someone the user has never
 * met, and VS Code applies it without ceremony. So the editor is allowed to
 * make RoutePilot *more* careful and never less:
 *
 * - A budget may be lowered, never raised above the configured limit.
 * - A confidence threshold may be raised, never lowered.
 * - Exploration may be switched off, never on.
 * - The operation mode may be made stricter, never relaxed.
 *
 * Without that asymmetry, opening an untrusted repository would be enough to
 * turn on experiments and remove a spending cap, which is precisely the shape
 * of problem spec section 40 exists to prevent.
 */

import type { OperationMode } from '../core/bandit/exploration-gate.js';
import type { RoutingPolicy } from '../core/types/routing.js';

/** Raw values as read from the editor's configuration. All optional. */
export interface EditorSettings {
  readonly requestBudget?: number | undefined;
  readonly minimumSuccessProbability?: number | undefined;
  readonly explorationEnabled?: boolean | undefined;
  readonly operationMode?: string | undefined;
  /** Analysis depth, 1 to 3. */
  readonly analysisLevel?: number | undefined;
  readonly showStatusBar?: boolean | undefined;
}

/** What the editor's settings are allowed to change about a request. */
export interface EditorOverrides {
  readonly policyOverrides: Partial<RoutingPolicy>;
  readonly operationMode: OperationMode;
  readonly explorationAllowed: boolean;
  readonly analysisLevel: 1 | 2 | 3 | undefined;
  readonly showStatusBar: boolean;
  /**
   * Settings that were ignored, with the reason.
   *
   * Surfaced rather than silently dropped: a user who set a budget of 50 and
   * got 10 deserves to know the file did not win, not to wonder why the
   * numbers disagree.
   */
  readonly ignored: readonly string[];
}

/** The configured limits an editor setting may not exceed. */
export interface ConfiguredLimits {
  readonly requestBudget: number | undefined;
  readonly minimumSuccessProbability: number;
  readonly explorationEnabled: boolean;
  readonly operationMode: OperationMode;
}

/** Modes ordered from most permissive to most restrictive. */
const MODE_STRICTNESS: Record<OperationMode, number> = {
  normal: 0,
  production: 1,
  critical: 2,
};

/**
 * Resolve editor settings against the configured limits.
 *
 * Anything invalid or widening is dropped and reported in `ignored`.
 */
export function resolveSettings(
  settings: EditorSettings,
  limits: ConfiguredLimits,
): EditorOverrides {
  const ignored: string[] = [];
  // Built with explicit keys rather than an index signature: under
  // `exactOptionalPropertyTypes` an absent override and one set to `undefined`
  // are different things, and only the first is what "the editor said nothing"
  // means.
  let budgetOverride: number | undefined;
  let thresholdOverride: number | undefined;

  // ---- Budget: may only be lowered -----------------------------------------
  const budget = settings.requestBudget;
  if (budget !== undefined) {
    if (!Number.isFinite(budget) || budget < 0) {
      ignored.push('routepilot.requestBudget: not a non-negative number');
    } else if (limits.requestBudget !== undefined && budget > limits.requestBudget) {
      ignored.push(
        `routepilot.requestBudget: ${String(budget)} is above the configured limit of ${String(limits.requestBudget)}`,
      );
    } else {
      budgetOverride = budget;
    }
  }

  // ---- Confidence: may only be raised --------------------------------------
  const threshold = settings.minimumSuccessProbability;
  if (threshold !== undefined) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      ignored.push('routepilot.minimumSuccessProbability: not a probability in [0, 1]');
    } else if (threshold < limits.minimumSuccessProbability) {
      ignored.push(
        `routepilot.minimumSuccessProbability: ${String(threshold)} is below the configured ${String(limits.minimumSuccessProbability)}`,
      );
    } else {
      thresholdOverride = threshold;
    }
  }

  // ---- Exploration: may only be switched off -------------------------------
  let explorationAllowed = limits.explorationEnabled;
  if (settings.explorationEnabled === true && !limits.explorationEnabled) {
    ignored.push('routepilot.exploration.enabled: exploration is disabled in the configuration');
  } else if (settings.explorationEnabled === false) {
    explorationAllowed = false;
  }

  // ---- Mode: may only become stricter --------------------------------------
  const { mode, ignoredReason } = resolveMode(settings.operationMode, limits.operationMode);
  if (ignoredReason !== null) ignored.push(ignoredReason);

  return {
    policyOverrides: {
      ...(budgetOverride === undefined ? {} : { requestBudget: budgetOverride }),
      ...(thresholdOverride === undefined ? {} : { minimumSuccessProbability: thresholdOverride }),
    },
    operationMode: mode,
    explorationAllowed,
    analysisLevel: resolveLevel(settings.analysisLevel, ignored),
    // Defaults to shown: a router that silently picks models without a visible
    // indicator is one whose decisions nobody notices.
    showStatusBar: settings.showStatusBar !== false,
    ignored,
  };
}

function resolveMode(
  requested: string | undefined,
  configured: OperationMode,
): { mode: OperationMode; ignoredReason: string | null } {
  if (requested === undefined) return { mode: configured, ignoredReason: null };

  if (!(requested in MODE_STRICTNESS)) {
    return {
      mode: configured,
      ignoredReason: `routepilot.operationMode: unknown mode "${requested}"`,
    };
  }

  const mode = requested as OperationMode;
  if (MODE_STRICTNESS[mode] < MODE_STRICTNESS[configured]) {
    return {
      mode: configured,
      ignoredReason: `routepilot.operationMode: "${requested}" is less strict than the configured "${configured}"`,
    };
  }

  return { mode, ignoredReason: null };
}

function resolveLevel(level: number | undefined, ignored: string[]): 1 | 2 | 3 | undefined {
  if (level === undefined) return undefined;
  if (level === 1 || level === 2 || level === 3) return level;

  ignored.push('routepilot.analysisLevel: must be 1, 2 or 3');
  return undefined;
}
