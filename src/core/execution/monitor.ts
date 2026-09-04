/**
 * Execution monitor (spec section 21).
 *
 * Consumes the normalised {@link AgentEvent} stream and accumulates what
 * happened. It observes; it does not judge. Why a run went badly is the failure
 * classifier's job, and whether to escalate is the escalation engine's.
 *
 * The one judgement made here is what counts as progress: a successful tool
 * result, a file change, or a completed terminal command. Assistant messages do
 * not count -- a model narrating at length while changing nothing is exactly
 * what "time without progress" exists to detect.
 */

import { systemClock, type Clock } from '../ports.js';
import type { AgentEvent, TokenUsage } from '../types/agent.js';
import type { ExecutionSignals, ObservedEvent } from '../types/execution.js';

/** Options for {@link ExecutionMonitor}. */
export interface ExecutionMonitorOptions {
  /** Clock, injected so tests are deterministic. */
  readonly clock?: Clock | undefined;
  /** Keep the observed events, for debugging. Off by default (spec section 33). */
  readonly retainEvents?: boolean | undefined;
}

/** Accumulates observations from one execution. */
export class ExecutionMonitor {
  readonly #clock: Clock;
  readonly #retainEvents: boolean;
  readonly #observed: ObservedEvent[] = [];

  readonly #editsPerFile = new Map<string, number>();

  #startedAt: number;
  #lastProgressAt: number;
  #lastEventAt: number;

  #events = 0;
  #assistantMessages = 0;
  #toolCalls = 0;
  #toolFailures = 0;
  #consecutiveToolFailures = 0;
  #maxConsecutiveToolFailures = 0;
  #terminalCommands = 0;
  #terminalFailures = 0;
  #fileChanges = 0;
  #errorEvents = 0;
  #cancelled = false;
  #completed = false;
  #usage: TokenUsage | null = null;

  constructor(options: ExecutionMonitorOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#retainEvents = options.retainEvents ?? false;

    const now = this.#clock.now();
    this.#startedAt = now;
    this.#lastProgressAt = now;
    this.#lastEventAt = now;
  }

  /** Events observed, when retention is enabled. */
  get observedEvents(): readonly ObservedEvent[] {
    return this.#observed;
  }

  /** Reset to observe a fresh run. */
  reset(): void {
    const now = this.#clock.now();
    this.#startedAt = now;
    this.#lastProgressAt = now;
    this.#lastEventAt = now;

    this.#observed.length = 0;
    this.#editsPerFile.clear();

    this.#events = 0;
    this.#assistantMessages = 0;
    this.#toolCalls = 0;
    this.#toolFailures = 0;
    this.#consecutiveToolFailures = 0;
    this.#maxConsecutiveToolFailures = 0;
    this.#terminalCommands = 0;
    this.#terminalFailures = 0;
    this.#fileChanges = 0;
    this.#errorEvents = 0;
    this.#cancelled = false;
    this.#completed = false;
    this.#usage = null;
  }

  /** Observe one event. */
  observe(event: AgentEvent): void {
    const now = this.#clock.now();
    this.#events += 1;
    this.#lastEventAt = now;

    if (this.#retainEvents) this.#observed.push({ event, observedAt: now });
    if (event.usage !== undefined) this.#usage = event.usage;

    switch (event.kind) {
      case 'assistant-message':
        this.#assistantMessages += 1;
        break;

      case 'tool-call':
        this.#toolCalls += 1;
        break;

      case 'tool-result':
        if (event.ok === false) {
          this.#toolFailures += 1;
          this.#consecutiveToolFailures += 1;
          this.#maxConsecutiveToolFailures = Math.max(
            this.#maxConsecutiveToolFailures,
            this.#consecutiveToolFailures,
          );
        } else {
          // A successful tool call both breaks the failure run and is progress.
          this.#consecutiveToolFailures = 0;
          this.#lastProgressAt = now;
        }
        break;

      case 'terminal-command':
        this.#terminalCommands += 1;
        if (event.ok === false) this.#terminalFailures += 1;
        else this.#lastProgressAt = now;
        break;

      case 'file-change':
        this.#fileChanges += 1;
        this.#lastProgressAt = now;
        if (event.path !== undefined) {
          this.#editsPerFile.set(event.path, (this.#editsPerFile.get(event.path) ?? 0) + 1);
        }
        break;

      case 'error':
        this.#errorEvents += 1;
        break;

      case 'cancelled':
        this.#cancelled = true;
        break;

      case 'completed':
        this.#completed = true;
        this.#lastProgressAt = now;
        break;

      case 'user-message':
      case 'usage':
      default:
        break;
    }
  }

  /** Observe an entire stream, to completion. */
  async observeAll(events: AsyncIterable<AgentEvent>): Promise<ExecutionSignals> {
    for await (const event of events) this.observe(event);
    return this.signals();
  }

  /** A snapshot of everything observed so far. */
  signals(): ExecutionSignals {
    const now = this.#clock.now();
    const edits = [...this.#editsPerFile.values()];

    return {
      events: this.#events,
      assistantMessages: this.#assistantMessages,

      toolCalls: this.#toolCalls,
      toolFailures: this.#toolFailures,
      maxConsecutiveToolFailures: this.#maxConsecutiveToolFailures,
      consecutiveToolFailures: this.#consecutiveToolFailures,

      terminalCommands: this.#terminalCommands,
      terminalFailures: this.#terminalFailures,

      fileChanges: this.#fileChanges,
      distinctFilesChanged: this.#editsPerFile.size,
      repeatedlyEditedFiles: edits.filter((count) => count > 1).length,
      maxEditsToOneFile: edits.length === 0 ? 0 : Math.max(...edits),

      errorEvents: this.#errorEvents,
      cancelled: this.#cancelled,
      completed: this.#completed,

      millisecondsWithoutProgress: Math.max(0, now - this.#lastProgressAt),
      durationMs: Math.max(0, Math.max(now, this.#lastEventAt) - this.#startedAt),

      usage: this.#usage,
    };
  }
}

/** Signals for a run that produced nothing. Useful as a baseline in tests. */
export function emptySignals(): ExecutionSignals {
  return {
    events: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolFailures: 0,
    maxConsecutiveToolFailures: 0,
    consecutiveToolFailures: 0,
    terminalCommands: 0,
    terminalFailures: 0,
    fileChanges: 0,
    distinctFilesChanged: 0,
    repeatedlyEditedFiles: 0,
    maxEditsToOneFile: 0,
    errorEvents: 0,
    cancelled: false,
    completed: false,
    millisecondsWithoutProgress: 0,
    durationMs: 0,
    usage: null,
  };
}
