/**
 * Fixtures for the end-to-end scenarios (spec section 68).
 *
 * A scripted executor and a workspace builder, so a whole run — route, execute,
 * monitor, validate, classify, escalate, score — can be driven without a
 * process being spawned or a network reached.
 *
 * The executor is scripted **per model**, which is what makes escalation
 * scenarios expressible: "the cheap model makes bad edits and the tests fail;
 * the stronger model succeeds" is two entries in a map.
 *
 * Excluded from the published build (see tsconfig.build.json).
 */

import type { AgentEvent, AgentResult } from '../core/types/agent.js';
import type { ModelSpec } from '../core/types/model.js';
import type { ExecutorOutcome, ExecutorPort } from '../core/types/run.js';
import type { CommandOutcome, CommandRequest, CommandRunnerPort } from '../core/ports.js';
import type { AgentExecutionRequest } from '../core/types/agent.js';

/** What one model does when it is asked to run. */
export interface ScriptedRun {
  readonly result: AgentResult;
  /** Events the monitor will see. */
  readonly events?: readonly AgentEvent[] | undefined;
  /** Adapter-level attempts, so retry and fallback can be observed. */
  readonly adapterAttempts?: number | undefined;
  readonly adapterId?: string | undefined;
  /**
   * Called after this model runs, before validation.
   *
   * How a scenario expresses "the cheap model leaves the tests failing and the
   * stronger one fixes them": the command runner's state is changed by whoever
   * just ran. Without it every attempt would face identical validation and no
   * escalation could ever be seen to succeed.
   */
  readonly afterExecute?: (() => void) | undefined;
}

/** One recorded call into the executor. */
export interface ExecutorCall {
  readonly modelId: string;
  readonly request: AgentExecutionRequest;
}

/**
 * An executor scripted per model.
 *
 * Records every call, so a scenario can assert not only what happened but
 * **which models were asked to run** — the difference between escalating and
 * merely intending to.
 */
export class ScriptedExecutor implements ExecutorPort {
  readonly calls: ExecutorCall[] = [];
  readonly #scripts: Map<string, ScriptedRun>;
  readonly #fallback: ScriptedRun;

  constructor(scripts: Record<string, ScriptedRun>, fallback: ScriptedRun = succeeds()) {
    this.#scripts = new Map(Object.entries(scripts));
    this.#fallback = fallback;
  }

  execute(request: AgentExecutionRequest, model: ModelSpec): Promise<ExecutorOutcome> {
    this.calls.push({ modelId: model.id, request });

    const script = this.#scripts.get(model.id) ?? this.#fallback;
    script.afterExecute?.();

    return Promise.resolve({
      result: script.result,
      adapterId: script.adapterId ?? 'scripted',
      events: script.events ?? [],
      adapterAttempts: script.adapterAttempts ?? 1,
    });
  }

  /** Model ids that were actually asked to run, in order. */
  get executedModelIds(): string[] {
    return this.calls.map((call) => call.modelId);
  }

  /** The briefing a given model received, if any. */
  handoffFor(modelId: string): string | undefined {
    return this.calls.find((call) => call.modelId === modelId)?.request.priorAttemptSummary;
  }
}

// ---------------------------------------------------------------------------
// Scripted runs
// ---------------------------------------------------------------------------

/** A clean completion. */
export function succeeds(changedFiles: readonly string[] = ['src/a.ts']): ScriptedRun {
  return {
    result: {
      status: 'completed',
      changedFiles,
      usage: { inputTokens: 20_000, outputTokens: 2_000 },
    },
    events: [
      event('assistant-message', { summary: 'planning' }),
      event('file-change', { path: changedFiles[0] ?? 'src/a.ts' }),
      event('completed'),
    ],
  };
}

/**
 * A run that finishes but leaves the workspace broken.
 *
 * The agent reports success; the tests disagree. This is the case a status code
 * alone cannot detect, and the reason validation exists (spec section 31).
 */
export function makesBadEdits(): ScriptedRun {
  return {
    result: {
      status: 'completed',
      changedFiles: ['src/auth/session.ts', 'src/auth/token.ts'],
      usage: { inputTokens: 30_000, outputTokens: 4_000 },
    },
    events: [
      event('assistant-message', { summary: 'editing' }),
      event('file-change', { path: 'src/auth/session.ts' }),
      event('file-change', { path: 'src/auth/session.ts' }),
      event('file-change', { path: 'src/auth/session.ts' }),
      event('file-change', { path: 'src/auth/session.ts' }),
      event('tool-call', { tool: 'edit', ok: false }),
      event('tool-result', { tool: 'edit', ok: false }),
      event('tool-call', { tool: 'edit', ok: false }),
      event('tool-result', { tool: 'edit', ok: false }),
      event('tool-call', { tool: 'edit', ok: false }),
      event('tool-result', { tool: 'edit', ok: false }),
      event('completed'),
    ],
  };
}

/** A failure the model had nothing to do with. */
export function environmentFailure(summary: string): ScriptedRun {
  return {
    result: {
      status: 'failed',
      changedFiles: [],
      failureType: 'ENVIRONMENT_FAILURE',
      errorSummary: summary,
      usage: { inputTokens: 5_000, outputTokens: 200 },
    },
    events: [event('tool-call', { tool: 'bash', ok: false }), event('error', { summary })],
  };
}

/** A provider that could not be reached. */
export function providerFailure(summary: string, adapterAttempts = 3): ScriptedRun {
  return {
    result: {
      status: 'failed',
      changedFiles: [],
      failureType: 'PROVIDER_FAILURE',
      errorSummary: summary,
    },
    events: [event('error', { summary })],
    adapterAttempts,
  };
}

/** The user stopped it. */
export function cancelled(): ScriptedRun {
  return {
    result: {
      status: 'cancelled',
      changedFiles: ['src/a.ts'],
      failureType: 'USER_CANCELLED',
      errorSummary: 'cancelled by the user',
      usage: { inputTokens: 8_000, outputTokens: 500 },
    },
    events: [event('assistant-message', { summary: 'working' }), event('cancelled')],
  };
}

/** Build a normalised event. */
export function event(
  kind: AgentEvent['kind'],
  extra: Omit<Partial<AgentEvent>, 'kind'> = {},
): AgentEvent {
  return { kind, timestamp: 0, ...extra };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A command runner scripted per check.
 *
 * Keyed by the command name so a scenario can say "tests fail, build passes"
 * without knowing how the validation engine spells its plan.
 */
export class ScriptedCommandRunner implements CommandRunnerPort {
  readonly requests: CommandRequest[] = [];
  #failing: Set<string>;

  constructor(failing: readonly string[] = []) {
    this.#failing = new Set(failing);
  }

  /** Change what fails between runs, so an escalation can be seen to fix it. */
  setFailing(failing: readonly string[]): void {
    this.#failing = new Set(failing);
  }

  run(request: CommandRequest): Promise<CommandOutcome> {
    this.requests.push(request);
    const label = [request.command, ...request.args].join(' ');
    const fails = [...this.#failing].some((entry) => label.includes(entry));

    return Promise.resolve({
      started: true,
      exitCode: fails ? 1 : 0,
      stdout: fails ? '' : 'ok',
      stderr: fails ? '2 tests failed' : '',
      timedOut: false,
    });
  }
}

/** A clock that advances a fixed amount on every read. */
export function steppingClock(stepMs = 1_000, start = 1_700_000_000_000): { now: () => number } {
  let current = start;
  return {
    now: () => {
      const value = current;
      current += stepMs;
      return value;
    },
  };
}
