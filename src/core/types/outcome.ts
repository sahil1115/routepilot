/**
 * Outcome model (spec sections 31 and 32).
 *
 * The rule that shapes this file: **a successful API response does not mean the
 * task succeeded.** An agent can return cleanly having written code that does
 * not compile, or that compiles and fails its tests, or that passes tests and
 * does the wrong thing. So an outcome is multi-dimensional, and every dimension
 * has three states — passed, failed, and *not evaluated*.
 *
 * `null` is load-bearing everywhere here. A check that was never run must not
 * count as a pass (it would inflate the score) or as a failure (it would
 * slander the model). It contributes nothing, and the score reports how much
 * evidence actually backed it.
 */

import type { FailureType } from './failure.js';
import type { TaskScope } from './features.js';
import type { TaskType } from './task.js';

/**
 * Implicit signals from the user (spec section 32).
 *
 * These are observations, not verdicts. The specification warns explicitly
 * against reading cancellation as model failure — a user may cancel because
 * they changed their mind, got interrupted, or realised the task was wrong.
 */
export const USER_SIGNALS = [
  'accepted',
  'cancelled',
  're-prompted',
  'reverted',
  'manually-edited',
  'immediate-retry',
  'follow-up-correction',
] as const;

/** An implicit signal from the user. */
export type UserSignal = (typeof USER_SIGNALS)[number];

/**
 * Signals that indicate the result was not good enough.
 *
 * `cancelled` is deliberately absent. Reverting or hand-editing the result says
 * the work was wrong; stopping it says nothing reliable at all.
 */
export const NEGATIVE_USER_SIGNALS: ReadonlySet<UserSignal> = new Set<UserSignal>([
  'reverted',
  're-prompted',
  'manually-edited',
  'follow-up-correction',
]);

/** What a task actually achieved (spec section 31). */
export interface TaskOutcome {
  readonly requestId: string;
  readonly taskType: TaskType;
  readonly scope: TaskScope;

  /** Validation dimensions. `null` means the check was not run. */
  readonly syntaxValid: boolean | null;
  readonly lintPassed: boolean | null;
  readonly buildPassed: boolean | null;
  readonly testsPassed: boolean | null;
  /**
   * Whether the task's own criteria were met.
   *
   * Distinct from "the tests passed": code can be green and still not do what
   * was asked. `null` until something or someone judges it.
   */
  readonly taskCriteriaMet: boolean | null;

  /** User signals. `userAccepted` is `null` until the user says either way. */
  readonly userAccepted: boolean | null;
  readonly userCancelled: boolean;
  readonly userRePrompted: boolean;
  readonly userReverted: boolean;
  readonly manualEditRequired: boolean;

  readonly escalationCount: number;
  readonly modelsUsed: readonly string[];
  readonly totalCost: number;
  readonly currency: string;
  readonly totalLatencyMs: number;
  readonly failureType: FailureType | null;
}

/** The computed judgement on an outcome. */
export interface TaskSuccessScore {
  /**
   * Score in [0, 1], or `null` when nothing was evaluated.
   *
   * `null` is not zero. A task nobody checked has an unknown outcome, and
   * recording it as a failure would corrupt learning.
   */
  readonly score: number | null;
  /**
   * How much of the possible evidence was actually available, in [0, 1].
   *
   * A score of 0.9 backed by 0.2 of the evidence is a much weaker claim than
   * the same score backed by 1.0, and consumers need to be able to tell.
   */
  readonly evidence: number;
  /** Per-dimension contributions, for explanation. */
  readonly contributions: readonly OutcomeContribution[];
  /** Whether this outcome may inform beliefs about the model. */
  readonly modelAttributable: boolean;
}

/** One dimension's contribution to the score. */
export interface OutcomeContribution {
  readonly dimension: string;
  readonly weight: number;
  readonly passed: boolean;
  readonly reason: string;
}
