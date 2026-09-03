/**
 * Provider-neutral agent adapter interface (spec section 17).
 *
 * The router must never know how a particular coding agent works internally.
 * Everything an agent can do reaches the core through this interface, and every
 * event an agent emits is normalised into the shapes below before the core sees
 * it (spec section 19).
 *
 * This module defines interfaces only. No adapter is implemented in Phase 1.
 */

import type { FailureType } from './failure.js';
import type { ModelSpec } from './model.js';
import type { TaskType } from './task.js';

/** What an agent integration is able to do. */
export interface AgentCapabilities {
  /** Emits incremental events during execution. */
  readonly streaming: boolean;
  /** Supports cancelling an in-flight session. */
  readonly cancellation: boolean;
  /** Can call tools. */
  readonly toolUse: boolean;
  /** Can drive a multi-step agentic loop. */
  readonly agenticExecution: boolean;
  /** Can modify files in the workspace. */
  readonly fileEditing: boolean;
  /** Can run terminal commands. */
  readonly terminalExecution: boolean;
  /** Accepts an explicit model selection from the router. */
  readonly modelSelection: boolean;
  /** Reports token usage, enabling actual-cost accounting. */
  readonly usageReporting: boolean;
}

/** A request the router asks an adapter to execute. */
export interface AgentExecutionRequest {
  /** Correlation id, stable across retries and escalations of one task. */
  readonly requestId: string;
  /** The user's task. */
  readonly prompt: string;
  /** Absolute path to the workspace the agent may act on. */
  readonly workspaceRoot: string;
  /** Classified task category. */
  readonly taskType: TaskType;
  /** Capabilities this request genuinely needs. */
  readonly requiredCapabilities: Readonly<Partial<AgentCapabilities>>;
  /** Estimated input context in tokens, when known. */
  readonly estimatedContextTokens?: number;
  /**
   * Compact handoff from a previous attempt, when this is an escalation.
   *
   * Populated by the ContextHandoffBuilder in Phase 9. Typed as an opaque
   * string here so adapters can be written before that phase lands.
   */
  readonly priorAttemptSummary?: string;
}

/** Whether an adapter can serve a request, and why not if it cannot. */
export interface AgentSupportDecision {
  /** True when the adapter can execute the request. */
  readonly supported: boolean;
  /** Human-readable reason, required when `supported` is false. */
  readonly reason?: string;
}

/** Normalised event kinds every adapter maps its native output onto. */
export const AGENT_EVENT_KINDS = [
  'user-message',
  'assistant-message',
  'tool-call',
  'tool-result',
  'file-change',
  'terminal-command',
  'usage',
  'error',
  'completed',
  'cancelled',
] as const;

/** A normalised event kind. */
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/** Token usage reported by an agent or provider. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens served from a provider-side cache, when reported. */
  readonly cachedInputTokens?: number;
}

/**
 * A normalised execution event.
 *
 * `detail` is deliberately narrow. Full transcripts and file contents are not
 * carried through the core, because the core must not become a place where
 * source code accumulates (spec section 33).
 */
export interface AgentEvent {
  readonly kind: AgentEventKind;
  /** Milliseconds since the Unix epoch. */
  readonly timestamp: number;
  /** Short human-readable summary. Must not contain secrets or file contents. */
  readonly summary?: string;
  /** Workspace-relative path, for file and terminal events. */
  readonly path?: string;
  /** Tool name, for tool events. */
  readonly tool?: string;
  /** Whether a tool call or command succeeded. */
  readonly ok?: boolean;
  /** Token usage, for `usage` events. */
  readonly usage?: TokenUsage;
}

/** Terminal status of an execution. */
export const AGENT_RESULT_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/** Terminal status of an execution. */
export type AgentResultStatus = (typeof AGENT_RESULT_STATUSES)[number];

/**
 * The normalised outcome of one execution.
 *
 * Note that `completed` means the agent finished its run, not that the task
 * succeeded. Task success is a separate, multi-dimensional judgement made by
 * the validation engine and outcome model in Phase 10 (spec section 31).
 */
export interface AgentResult {
  readonly status: AgentResultStatus;
  /** Token usage, when the adapter can report it. */
  readonly usage?: TokenUsage;
  /** Workspace-relative paths the agent modified. */
  readonly changedFiles: readonly string[];
  /** Classification of the failure, when `status` is not `completed`. */
  readonly failureType?: FailureType;
  /** Redacted, human-readable error summary. */
  readonly errorSummary?: string;
}

/** A running execution. */
export interface AgentSession {
  /** Unique id used to cancel this session. */
  readonly id: string;
  /** Id of the adapter that owns the session. */
  readonly adapterId: string;
  /** Registry id of the model being used. */
  readonly modelId: string;
  /** Normalised event stream. */
  readonly events: AsyncIterable<AgentEvent>;
  /** Resolves when the session reaches a terminal state. */
  readonly result: Promise<AgentResult>;
}

/** Operational health of an adapter and its underlying tooling. */
export interface AgentStatus {
  /** Whether the adapter is usable right now. */
  readonly available: boolean;
  /** Version of the underlying agent binary or service, when detectable. */
  readonly version?: string;
  /**
   * Actionable setup guidance when unavailable.
   *
   * Required when `available` is false — a missing CLI must produce a message
   * that tells the user how to fix it (spec section 19).
   */
  readonly detail?: string;
}

/**
 * A coding agent or provider integration.
 *
 * Implementations live in `src/adapters`. The core depends on this interface
 * and never on a concrete adapter.
 */
export interface AgentAdapter {
  /** Unique adapter id. */
  readonly id: string;
  /** Human-readable name. */
  readonly displayName: string;
  /** What this adapter can do. */
  readonly capabilities: AgentCapabilities;

  /** Whether this adapter can serve the request, with a reason when it cannot. */
  canHandle(request: AgentExecutionRequest): AgentSupportDecision;

  /** Begin executing the request with the given model. */
  execute(request: AgentExecutionRequest, model: ModelSpec): Promise<AgentSession>;

  /** Cancel a running session. Must be safe to call on an already-finished session. */
  cancel(sessionId: string): Promise<void>;

  /** Report operational health, including actionable setup guidance. */
  getStatus(): Promise<AgentStatus>;

  /** Map a native event onto {@link AgentEvent}. Returns null for events the core ignores. */
  normalizeEvent(raw: unknown): AgentEvent | null;

  /** Map a native completion payload onto {@link AgentResult}. */
  normalizeResult(raw: unknown): AgentResult;
}
