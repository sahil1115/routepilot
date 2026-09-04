/**
 * Struggle score (spec section 23).
 *
 * How badly a run is going, from several weighted signals rather than one
 * threshold, because any single signal is ambiguous: two tool failures might be
 * a wrong path or a flaky filesystem, five minutes of silence might be deep
 * work or a stuck loop. Only the combination is informative.
 *
 * Reported twice, and the split is the point. `score` is how badly the run is
 * going whatever the cause, useful for progress and for deciding to stop.
 * `modelAttributableScore` is how much of that implicates the model, and is the
 * only number escalation and learning may use -- an environment or provider
 * failure must not raise it, or it would poison every later decision
 * (sections 23 and 38).
 */

import type {
  ExecutionSignals,
  StruggleAssessment,
  StruggleContribution,
  StruggleLevel,
} from '../types/execution.js';

/** Tunable thresholds (spec section 47 exposes these as configuration). */
export interface StruggleThresholds {
  /** Consecutive tool failures at which struggle begins. */
  readonly consecutiveToolFailures: number;
  /** Edits to a single file that count as churn. */
  readonly editsToOneFile: number;
  /** Milliseconds without progress that count as stalled. */
  readonly noProgressMs: number;
  /** Tool-failure rate at which struggle begins, in [0, 1]. */
  readonly toolFailureRate: number;
  /** Score at or above which escalation is worth considering. */
  readonly escalationThreshold: number;
}

/** Defaults chosen so a healthy run scores near zero. */
export const DEFAULT_STRUGGLE_THRESHOLDS: StruggleThresholds = {
  consecutiveToolFailures: 2,
  editsToOneFile: 3,
  noProgressMs: 120_000,
  toolFailureRate: 0.4,
  escalationThreshold: 0.5,
};

/** Weights per signal. They are relative, not probabilities. */
const WEIGHTS = {
  consecutiveToolFailures: 0.3,
  toolFailureRate: 0.2,
  editChurn: 0.2,
  noProgress: 0.15,
  terminalFailures: 0.1,
  errorEvents: 0.05,
} as const;

/** Scores how badly a run is going, and how much of that is the model's doing. */
export class StruggleMonitor {
  readonly #thresholds: StruggleThresholds;

  constructor(thresholds: Partial<StruggleThresholds> = {}) {
    this.#thresholds = { ...DEFAULT_STRUGGLE_THRESHOLDS, ...thresholds };
  }

  /**
   * Assess struggle.
   *
   * @param signals What the monitor observed.
   * @param environmentImplicated
   *   True when the run's trouble is known to come from the environment, the
   *   provider or the user. When set, contributions stop counting towards the
   *   model-attributable score — the run is still going badly, but not because
   *   of the model.
   */
  assess(signals: ExecutionSignals, environmentImplicated = false): StruggleAssessment {
    const contributions: StruggleContribution[] = [];
    const t = this.#thresholds;

    // --- Consecutive tool failures ----------------------------------------
    if (signals.maxConsecutiveToolFailures >= t.consecutiveToolFailures) {
      const excess = signals.maxConsecutiveToolFailures - t.consecutiveToolFailures + 1;
      contributions.push({
        rule: 'struggle.consecutive-tool-failures',
        weight: scale(excess, 3) * WEIGHTS.consecutiveToolFailures,
        reason: `${String(signals.maxConsecutiveToolFailures)} tool calls failed in a row`,
        modelAttributable: !environmentImplicated,
      });
    }

    // --- Overall tool failure rate ----------------------------------------
    if (signals.toolCalls > 0) {
      const rate = signals.toolFailures / signals.toolCalls;
      if (rate >= t.toolFailureRate) {
        contributions.push({
          rule: 'struggle.tool-failure-rate',
          weight: rate * WEIGHTS.toolFailureRate,
          reason: `${percent(rate)} of tool calls failed`,
          modelAttributable: !environmentImplicated,
        });
      }
    }

    // --- Edit churn --------------------------------------------------------
    if (signals.maxEditsToOneFile >= t.editsToOneFile) {
      contributions.push({
        rule: 'struggle.edit-churn',
        weight: scale(signals.maxEditsToOneFile - t.editsToOneFile + 1, 4) * WEIGHTS.editChurn,
        reason:
          `one file was edited ${String(signals.maxEditsToOneFile)} times` +
          (signals.repeatedlyEditedFiles > 1
            ? `; ${String(signals.repeatedlyEditedFiles)} files were edited repeatedly`
            : ''),
        // Rewriting the same file over and over is the model changing its mind.
        modelAttributable: !environmentImplicated,
      });
    }

    // --- No measurable progress -------------------------------------------
    if (signals.millisecondsWithoutProgress >= t.noProgressMs) {
      contributions.push({
        rule: 'struggle.no-progress',
        weight: scale(signals.millisecondsWithoutProgress / t.noProgressMs, 3) * WEIGHTS.noProgress,
        reason: `no observable progress for ${formatDuration(signals.millisecondsWithoutProgress)}`,
        modelAttributable: !environmentImplicated,
      });
    }

    // --- Failing commands --------------------------------------------------
    if (signals.terminalFailures > 0) {
      contributions.push({
        rule: 'struggle.terminal-failures',
        weight: scale(signals.terminalFailures, 3) * WEIGHTS.terminalFailures,
        reason: `${String(signals.terminalFailures)} terminal command(s) failed`,
        // A failing command is often the environment, so this never implicates
        // the model on its own.
        modelAttributable: false,
      });
    }

    // --- Reported errors ---------------------------------------------------
    if (signals.errorEvents > 0) {
      contributions.push({
        rule: 'struggle.error-events',
        weight: scale(signals.errorEvents, 3) * WEIGHTS.errorEvents,
        reason: `${String(signals.errorEvents)} error event(s) were reported`,
        modelAttributable: false,
      });
    }

    const score = clamp(contributions.reduce((sum, c) => sum + c.weight, 0));
    const modelAttributableScore = clamp(
      contributions.filter((c) => c.modelAttributable).reduce((sum, c) => sum + c.weight, 0),
    );

    return {
      score,
      modelAttributableScore,
      level: levelFor(score),
      contributions,
    };
  }

  /**
   * Whether escalation is worth considering.
   *
   * Deliberately keyed to the **model-attributable** score. Escalating to a
   * stronger model because a database is down would spend more money on the
   * same failure (spec section 26).
   */
  shouldConsiderEscalation(assessment: StruggleAssessment): boolean {
    return assessment.modelAttributableScore >= this.#thresholds.escalationThreshold;
  }

  /** The thresholds in force. */
  get thresholds(): StruggleThresholds {
    return this.#thresholds;
  }
}

function levelFor(score: number): StruggleLevel {
  if (score >= 0.6) return 'severe';
  if (score >= 0.35) return 'moderate';
  if (score > 0) return 'mild';
  return 'none';
}

/** Saturating ramp: 1 unit over the threshold is partial, `full` units is 1. */
function scale(value: number, full: number): number {
  return clamp(value / full);
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.round(seconds / 60))}m`;
}
