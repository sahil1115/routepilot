/**
 * Running a task end to end (spec sections 17, 22, 27 and 31).
 *
 * Phases 5 to 14 each built one stage of a pipeline — adapters, an execution
 * monitor, a failure taxonomy, an escalation graph, an outcome model, a
 * telemetry store, a learning engine — and every one of those phases ended with
 * the same note: nothing joins them together. These are the types for the piece
 * that does.
 *
 * ## Why the executor is a port
 *
 * `src/core` may not import `src/adapters`, which is enforced by an
 * architectural test. That is not bureaucracy here: it is what stops the
 * orchestrator from knowing which coding agent is running, and it means the
 * whole pipeline can be driven by a scripted executor in a test without a
 * process being spawned.
 */

import type { AgentEvent, AgentExecutionRequest, AgentResult } from './agent.js';
import type { FailureType } from './failure.js';
import type { RoutingFeatures } from './features.js';
import type { ModelSpec } from './model.js';
import type { ContextHandoff, EscalationAction } from './escalation.js';
import type { RoutingDecision, RoutingPolicy } from './routing.js';
import type { TaskOutcome, TaskSuccessScore } from './outcome.js';

/** What an executor reports back about one execution. */
export interface ExecutorOutcome {
  readonly result: AgentResult;
  /** The adapter that produced the result, or `null` if none could run. */
  readonly adapterId: string | null;
  /**
   * Normalised events observed during the run.
   *
   * Required rather than optional: the execution monitor's whole job is to
   * watch these, and an executor that discards them silently disables struggle
   * detection and half the failure taxonomy.
   */
  readonly events: readonly AgentEvent[];
  /** Adapter-level attempts, including retries and fallbacks. */
  readonly adapterAttempts: number;
}

/**
 * Something that can run a request against a model.
 *
 * Implemented in `src/adapters` over the agent registry, and by scripted fakes
 * in tests. The runner never learns which.
 */
export interface ExecutorPort {
  execute(request: AgentExecutionRequest, model: ModelSpec): Promise<ExecutorOutcome>;
}

/** One attempt made while running a task. */
export interface RunAttempt {
  readonly index: number;
  readonly modelId: string;
  readonly tier: ModelSpec['tier'];
  readonly succeeded: boolean;
  readonly failureType: FailureType | null;
  /** Why it failed, in one line. Redacted. */
  readonly failureReason: string | null;
  readonly cost: number;
  readonly durationMs: number;
  readonly changedFiles: readonly string[];
  /** Validation checks that failed on this attempt. */
  readonly failedChecks: readonly string[];
  /** True when this attempt was reached by escalating from an earlier one. */
  readonly viaEscalation: boolean;
  /** The briefing this attempt was given, when it was handed one. */
  readonly handoff: ContextHandoff | null;
  /** Which adapter ran it, or null when none could. */
  readonly adapterId: string | null;
  /**
   * Execution shape, from the monitor's own signals.
   *
   * Carried out rather than recomputed: these are counted once while the events
   * stream past, and the events themselves are not retained. A recorder handed
   * only the attempt would otherwise have to write zeros here, which is
   * indistinguishable from a model that used no tools at all.
   */
  readonly toolCalls: number;
  readonly toolFailures: number;
  /** Struggle score in [0, 1], and the part of it attributable to the model. */
  readonly struggleScore: number;
  readonly modelAttributableStruggle: number;
}

/** One escalation step taken while running a task. */
export interface RunEscalation {
  readonly action: EscalationAction;
  readonly fromModelId: string;
  readonly toModelId: string | null;
  readonly failureType: FailureType | null;
  readonly reason: string;
  /** Whether the failure may inform beliefs about the model. */
  readonly modelAttributable: boolean;
}

/** How a run finished. */
export const RUN_OUTCOMES = [
  'succeeded',
  'failed',
  'stopped',
  'cancelled',
  'needs-clarification',
  'no-model',
] as const;

/** How a run finished. */
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** A request to run one task. */
export interface RunRequest {
  /** Correlation id, stable across every attempt and escalation. */
  readonly requestId: string;
  readonly task: string;
  readonly workspaceRoot: string;
  readonly features: RoutingFeatures;
  readonly policy: RoutingPolicy;
  /** A model the user pinned. Honoured, and never explored away from. */
  readonly requestedModelId?: string | undefined;
  readonly branch?: string | null | undefined;
  /** Capabilities this request genuinely needs. */
  readonly requiredCapabilities?: AgentExecutionRequest['requiredCapabilities'] | undefined;
}

/** Everything one run produced. */
export interface RunResult {
  readonly requestId: string;
  readonly outcome: RunOutcome;
  /** The initial routing decision. */
  readonly decision: RoutingDecision;
  readonly attempts: readonly RunAttempt[];
  readonly escalations: readonly RunEscalation[];
  /** The model that produced the final result, or `null` if none ran. */
  readonly finalModelId: string | null;
  readonly totalCost: number;
  /**
   * The multi-dimensional score, or `null` when nothing was evaluated.
   *
   * `null` is not zero: a task nobody validated has an unknown result.
   */
  readonly score: TaskSuccessScore | null;
  /**
   * The signals the score was computed from.
   *
   * Carried out rather than discarded because they are what section 75 asks to
   * be recorded — the per-dimension validation result, the user signals, the
   * models used. The score alone collapses all of that into one number, and a
   * recorder given only the number would have to invent the rest.
   *
   * `null` when nothing ran — the router declined, or the task needs a
   * question answered first. There are no signals from an execution that never
   * happened, and an empty set of them would read as a clean sweep of failures.
   */
  readonly signals: TaskOutcome | null;
  /** A question for the user, when the outcome is `needs-clarification`. */
  readonly question: string | null;
  /** One-line summary. Redacted. */
  readonly reason: string;
}
