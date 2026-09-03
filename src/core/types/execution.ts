/**
 * Execution observation types (spec sections 21, 22, 23 and 30).
 *
 * The through-line: **an interruption is not a verdict on the model.** A
 * database being down, a provider outage, a flaky test, a context overflow and
 * a user pressing cancel all end a run, and none of them says anything about
 * whether the model was capable. These types keep those distinctions
 * structurally, so later phases cannot collapse them by accident.
 */

import type { AgentEvent, TokenUsage } from './agent.js';
import type { FailureType } from './failure.js';

/** What was observed while a run executed (spec section 21). */
export interface ExecutionSignals {
  readonly events: number;
  readonly assistantMessages: number;

  readonly toolCalls: number;
  readonly toolFailures: number;
  /** Longest run of back-to-back failing tool calls. */
  readonly maxConsecutiveToolFailures: number;
  /** Failing tool calls at the moment observation stopped. */
  readonly consecutiveToolFailures: number;

  readonly terminalCommands: number;
  readonly terminalFailures: number;

  readonly fileChanges: number;
  readonly distinctFilesChanged: number;
  /** Files edited more than once — a proxy for churn. */
  readonly repeatedlyEditedFiles: number;
  readonly maxEditsToOneFile: number;

  readonly errorEvents: number;
  readonly cancelled: boolean;
  readonly completed: boolean;

  /**
   * Milliseconds since the last observable progress.
   *
   * Progress means a successful tool result, a file change or a completed
   * command — not merely another assistant message. A model narrating without
   * changing anything is precisely the case this is meant to catch.
   */
  readonly millisecondsWithoutProgress: number;
  /** Total wall-clock duration observed. */
  readonly durationMs: number;

  readonly usage: TokenUsage | null;
}

/** How severe an episode of struggle is. */
export const STRUGGLE_LEVELS = ['none', 'mild', 'moderate', 'severe'] as const;

/** How severe an episode of struggle is. */
export type StruggleLevel = (typeof STRUGGLE_LEVELS)[number];

/** One named signal that contributed to a struggle score. */
export interface StruggleContribution {
  /** Stable rule id. */
  readonly rule: string;
  /** Weight contributed, in [0, 1]. */
  readonly weight: number;
  /** Human-readable justification. */
  readonly reason: string;
  /**
   * Whether this contribution implicates the *model*.
   *
   * Environment and provider trouble raise overall struggle — the run really is
   * going badly — but must never raise the model-attributable score, because
   * only that score may inform escalation or learning
   * (spec sections 22, 23 and 38).
   */
  readonly modelAttributable: boolean;
}

/** The result of scoring struggle (spec section 23). */
export interface StruggleAssessment {
  /** Overall struggle in [0, 1]: how badly the run is going, whatever the cause. */
  readonly score: number;
  /**
   * Struggle in [0, 1] attributable to the model.
   *
   * This is the number escalation and learning may use. It excludes everything
   * caused by the environment, the provider or the user.
   */
  readonly modelAttributableScore: number;
  readonly level: StruggleLevel;
  readonly contributions: readonly StruggleContribution[];
}

/** A check the validation engine can run (spec section 30). */
export const VALIDATION_CHECKS = ['syntax', 'lint', 'build', 'tests', 'diagnostics'] as const;

/** A check the validation engine can run. */
export type ValidationCheck = (typeof VALIDATION_CHECKS)[number];

/** What validation to run, and why. */
export interface ValidationPlan {
  readonly checks: readonly ValidationCheck[];
  /** Why this plan was chosen, for explanation. */
  readonly rationale: string;
}

/** The outcome of one check. */
export interface ValidationCheckResult {
  readonly check: ValidationCheck;
  /**
   * Whether the check passed.
   *
   * `null` means the check could not be run — no command was configured, or the
   * tool was missing. Not the same as passing, and not the same as failing.
   */
  readonly passed: boolean | null;
  /** Short, redacted summary of what happened. */
  readonly summary: string;
  /** Exit code, when a command was run. */
  readonly exitCode?: number | undefined;
  /** Captured output, truncated. Used for classification, never stored raw. */
  readonly output?: string | undefined;
  readonly durationMs: number;
}

/** The result of running a validation plan. */
export interface ValidationReport {
  readonly plan: ValidationPlan;
  readonly results: readonly ValidationCheckResult[];
  /**
   * True when every check that ran passed. Checks that could not run do not
   * count — so this is `true` for a report where **nothing ran at all**.
   *
   * Read it together with {@link ValidationReport.evaluated}. On its own it
   * answers "did anything fail", which is not the same question as "did
   * anything pass", and treating it as the second is how an unvalidated run
   * came to be reported as a success.
   */
  readonly passed: boolean;
  /**
   * Whether any check actually produced a verdict.
   *
   * False when the plan was empty, or when every check was skipped because no
   * command was configured or the tool could not be started. A caller deciding
   * whether a task succeeded must require this; `passed` alone cannot
   * distinguish "everything passed" from "nothing was checked".
   */
  readonly evaluated: boolean;
  /** Checks that could not be run at all. */
  readonly skipped: readonly ValidationCheck[];
}

/** Everything the failure classifier is allowed to look at. */
export interface ClassificationEvidence {
  readonly signals: ExecutionSignals;
  /** The adapter's own view of how the run ended. */
  readonly adapterFailureType?: FailureType | undefined;
  readonly adapterErrorSummary?: string | undefined;
  /** Validation run after execution, when any was run. */
  readonly validation?: ValidationReport | undefined;
  /**
   * Files the agent reported changing.
   *
   * Self-reported by the agent's event stream, not observed on disk, so it is
   * evidence about intent rather than proof of damage. It is still the
   * difference between "the model edited eleven files and left the build
   * broken" and "the provider returned 503 before anything happened" — and
   * without it a failed run is classified from a single adapter string.
   */
  readonly changedFiles?: readonly string[] | undefined;
  /** How ambiguous the task was, in [0, 1] (from the classifier). */
  readonly taskAmbiguity?: number | undefined;
  /**
   * Whether the repository already failed validation *before* the run.
   *
   * Without this, a pre-broken build gets blamed on the model.
   */
  readonly repositoryBrokenBeforeRun?: boolean | undefined;
}

/** A classified failure, with its reasoning (spec section 22). */
export interface FailureClassification {
  readonly failureType: FailureType;
  /** Confidence in the classification, in [0, 1]. */
  readonly confidence: number;
  /** Why this classification was chosen. */
  readonly reason: string;
  /** Every rule that fired, best first. */
  readonly signals: readonly string[];
  /**
   * Whether this failure may update beliefs about the model's ability.
   *
   * True only for `MODEL_WEAKNESS`. Mirrors
   * {@link import('./failure.js').isModelAttributable} so consumers cannot
   * forget to check.
   */
  readonly modelAttributable: boolean;
}

/** A normalised event with the moment it was observed. */
export interface ObservedEvent {
  readonly event: AgentEvent;
  readonly observedAt: number;
}
