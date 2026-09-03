/**
 * Escalation types (spec sections 24, 26, 27 and 28).
 *
 * Escalation is a **graph**, not a ladder. The specification is explicit that
 * `cheap -> medium -> expensive` is the wrong model: the right response to a
 * failure depends on *why* it failed, and most reasons are not "the model was
 * too weak". A provider outage calls for a retry or a different provider; an
 * ambiguous request calls for a question to the user; a context overflow calls
 * for a bigger window, not a cleverer model.
 */

import type { FailureType } from './failure.js';
import type { ModelTier } from './model.js';

/** What to do after a failed attempt. */
export const ESCALATION_ACTIONS = [
  'none',
  'retry',
  'improve-context',
  'escalate-vertical',
  'escalate-horizontal',
  'provider-fallback',
  'ask-user',
  'stop',
] as const;

/**
 * What to do after a failed attempt.
 *
 * - `none` — the attempt succeeded.
 * - `retry` — same model, same provider. For transient trouble.
 * - `improve-context` — same model, more context. The model was not the problem;
 *   what it was given was.
 * - `escalate-vertical` — a more capable model (spec section 24).
 * - `escalate-horizontal` — a differently-capable model at similar cost, when
 *   another model is markedly better at *this* kind of work.
 * - `provider-fallback` — the same class of model from a different provider.
 * - `ask-user` — the problem is the request, not the attempt.
 * - `stop` — a limit was reached, or nothing is left to try.
 */
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

/** Hard caps on how far a task may go (spec section 27). */
export interface EscalationLimits {
  /** Escalations to a different model allowed per task. */
  readonly maxEscalationsPerTask: number;
  /** Retries allowed against any one model. */
  readonly maxRetriesPerModel: number;
  /** Total spend allowed across every attempt. */
  readonly maxTotalCost?: number | undefined;
  /** Wall-clock time allowed across every attempt. */
  readonly maxExecutionTimeMs?: number | undefined;
}

/** Which limit stopped a task. */
export const ESCALATION_LIMITS = [
  'escalations',
  'retries',
  'cost',
  'time',
  'no-candidates',
] as const;

/** Which limit stopped a task. */
export type EscalationLimit = (typeof ESCALATION_LIMITS)[number];

/** One attempt at a task. */
export interface ExecutionAttempt {
  readonly modelId: string;
  readonly providerId: string;
  readonly tier: ModelTier;
  readonly succeeded: boolean;
  readonly failureType?: FailureType | undefined;
  /** Why it failed, in one line. */
  readonly failureReason?: string | undefined;
  /** Spend on this attempt. */
  readonly cost: number;
  readonly durationMs: number;
  /** Workspace-relative paths this attempt modified. */
  readonly changedFiles: readonly string[];
  /** Workspace-relative paths this attempt read. */
  readonly inspectedFiles?: readonly string[] | undefined;
  /** Short descriptions of what it tried, so the next model need not repeat them. */
  readonly approaches?: readonly string[] | undefined;
  /** Validation checks that failed. */
  readonly failedChecks?: readonly string[] | undefined;
}

/**
 * The compact briefing handed to the next model (spec section 28).
 *
 * Deliberately a summary, not a transcript. The specification says plainly not
 * to send unnecessary full transcripts: they cost money, crowd out the actual
 * task, and re-expose the previous model's dead ends as if they were context
 * worth continuing from.
 */
export interface ContextHandoff {
  /** The user's task, unchanged. */
  readonly originalTask: string;
  readonly repositoryRoot: string;
  readonly branch: string | null;
  /** Instruction to the receiving model, in plain language. */
  readonly instruction: string;
  /** What the previous attempts changed, so the workspace state is understood. */
  readonly filesChanged: readonly string[];
  /** What they read, so the same ground need not be covered again. */
  readonly filesInspected: readonly string[];
  /** Validation checks known to be failing. */
  readonly failingChecks: readonly string[];
  /** Approaches already tried, so they are not repeated blindly. */
  readonly approachesTried: readonly string[];
  /** One line per previous attempt. */
  readonly previousAttempts: readonly string[];
  /** The model that failed most recently. */
  readonly previousModelId: string | null;
  readonly failureType: FailureType | null;
  /** Why the task is being handed over. */
  readonly escalationReason: string;
  /** Anything else worth knowing. */
  readonly observations: readonly string[];
}

/** The decision about what to do next. */
export interface EscalationDecision {
  readonly action: EscalationAction;
  /** The model to use next, when the action names one. */
  readonly targetModelId: string | null;
  /** One-line summary. */
  readonly reason: string;
  /** Full justification, one point per line (spec section 50). */
  readonly explanation: readonly string[];
  /** The briefing for the next model, when one is being handed the task. */
  readonly handoff: ContextHandoff | null;
  /** Which limit stopped the task, when `action` is `stop`. */
  readonly limitReached: EscalationLimit | null;
  /** A question for the user, when `action` is `ask-user`. */
  readonly question?: string | undefined;
  /** True when the failure may inform beliefs about the model. */
  readonly modelAttributable: boolean;
}
