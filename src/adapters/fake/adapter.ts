/**
 * Scriptable in-process adapter.
 *
 * Exists so that everything downstream of an adapter — the registry, retry,
 * fallback, and eventually the execution monitor and escalation engine — can be
 * tested deterministically without a child process, a network call or a
 * credential.
 *
 * It is the one adapter marked `verified`, because it has no external tool to
 * be wrong about: it *is* the implementation under test.
 */

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentExecutionRequest,
  AgentResult,
  AgentSession,
  AgentStatus,
  AgentSupportDecision,
} from '../../core/types/agent.js';
import type { ModelSpec } from '../../core/types/model.js';

/** How a scripted run behaves. */
export interface FakeScript {
  /** Events to emit, in order. */
  readonly events?: readonly AgentEvent[] | undefined;
  /** The terminal result. Defaults to a bare success. */
  readonly result?: AgentResult | undefined;
  /** Milliseconds to wait between events, so cancellation has a window. */
  readonly delayMs?: number | undefined;
  /** Throw from `execute` rather than returning a session. */
  readonly throwOnExecute?: Error | undefined;
  /** Report unavailable from `getStatus`. */
  readonly unavailable?: string | undefined;
  /** Fail this many times before succeeding, for retry tests. */
  readonly failuresBeforeSuccess?: number | undefined;
}

/** Options for {@link FakeAgentAdapter}. */
export interface FakeAdapterOptions {
  readonly id?: string | undefined;
  readonly displayName?: string | undefined;
  readonly capabilities?: Partial<AgentCapabilities> | undefined;
  readonly script?: FakeScript | undefined;
}

const FULL_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  cancellation: true,
  toolUse: true,
  agenticExecution: true,
  fileEditing: true,
  terminalExecution: true,
  modelSelection: true,
  usageReporting: true,
};

/** A deterministic, scriptable agent adapter. */
export class FakeAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;

  /** Every request this adapter was asked to execute, in order. */
  readonly executions: { request: AgentExecutionRequest; model: ModelSpec }[] = [];
  /** Session ids that were cancelled. */
  readonly cancelled: string[] = [];

  #script: FakeScript;
  #sessionCounter = 0;
  #attempts = 0;
  readonly #cancelledSessions = new Set<string>();

  constructor(options: FakeAdapterOptions = {}) {
    this.id = options.id ?? 'fake';
    this.displayName = options.displayName ?? 'Fake Agent';
    this.capabilities = { ...FULL_CAPABILITIES, ...options.capabilities };
    this.#script = options.script ?? {};
  }

  /** Replace the script between runs. */
  setScript(script: FakeScript): void {
    this.#script = script;
  }

  /** How many times `execute` has been called. */
  get attempts(): number {
    return this.#attempts;
  }

  canHandle(request: AgentExecutionRequest): AgentSupportDecision {
    for (const [capability, needed] of Object.entries(request.requiredCapabilities)) {
      if (needed !== true) continue;
      if (this.capabilities[capability as keyof AgentCapabilities]) continue;
      return { supported: false, reason: `this adapter cannot provide "${capability}"` };
    }
    return { supported: true };
  }

  getStatus(): Promise<AgentStatus> {
    if (this.#script.unavailable !== undefined) {
      return Promise.resolve({ available: false, detail: this.#script.unavailable });
    }
    return Promise.resolve({ available: true, version: '0.0.0-fake' });
  }

  execute(request: AgentExecutionRequest, model: ModelSpec): Promise<AgentSession> {
    this.#attempts += 1;
    this.executions.push({ request, model });

    if (this.#script.throwOnExecute !== undefined) {
      return Promise.reject(this.#script.throwOnExecute);
    }

    const sessionId = `fake-session-${String((this.#sessionCounter += 1))}`;
    const script = this.#script;
    const cancelledSessions = this.#cancelledSessions;

    // Fail the first N attempts, so retry behaviour can be exercised.
    const shouldFail =
      script.failuresBeforeSuccess !== undefined && this.#attempts <= script.failuresBeforeSuccess;

    const events = script.events ?? [];
    const delayMs = script.delayMs ?? 0;

    const stream: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        for (const event of events) {
          if (cancelledSessions.has(sessionId)) return;
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          yield event;
        }
      },
    };

    const result = (async (): Promise<AgentResult> => {
      for await (const event of stream) {
        void event;
      }

      if (cancelledSessions.has(sessionId)) {
        return {
          status: 'cancelled',
          changedFiles: [],
          failureType: 'USER_CANCELLED',
          errorSummary: 'the run was cancelled',
        };
      }

      if (shouldFail) {
        return {
          status: 'failed',
          changedFiles: [],
          failureType: 'PROVIDER_FAILURE',
          errorSummary: `scripted failure ${String(this.#attempts)}`,
        };
      }

      return script.result ?? { status: 'completed', changedFiles: [] };
    })();

    return Promise.resolve({
      id: sessionId,
      adapterId: this.id,
      modelId: model.id,
      events: stream,
      result,
    });
  }

  cancel(sessionId: string): Promise<void> {
    this.#cancelledSessions.add(sessionId);
    this.cancelled.push(sessionId);
    return Promise.resolve();
  }

  normalizeEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const kind = record['kind'];
    if (typeof kind !== 'string') return null;
    return { kind: kind as AgentEvent['kind'], timestamp: 0 };
  }

  normalizeResult(raw: unknown): AgentResult {
    const ok = typeof raw === 'object' && raw !== null && (raw as { ok?: unknown }).ok === true;
    return ok
      ? { status: 'completed', changedFiles: [] }
      : { status: 'failed', changedFiles: [], failureType: 'UNKNOWN' };
  }
}
