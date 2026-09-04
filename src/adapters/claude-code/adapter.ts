/**
 * Claude Code adapter (spec section 18).
 *
 * Integrates through Claude Code's documented non-interactive CLI surface and
 * nothing else:
 *
 *     claude -p <prompt> --output-format stream-json --verbose --model <id>
 *
 * No interception of network traffic, no modification of the installation, no
 * undocumented flags or files. The specification asks for a local gateway where
 * the environment supports one and says plainly not to invent one otherwise.
 *
 * What has been confirmed against the real CLI is recorded in
 * `src/adapters/verification.ts`. In short: four real coding tasks pass with
 * `permissionMode` set to `acceptEdits`, and two of the four fail without it,
 * because print mode cannot prompt for tool permission.
 */

import { randomUUID } from 'node:crypto';

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
import { probeExecutable, runProcess, type RunHandle } from '../process/runner.js';
import {
  normalizeClaudeEvent,
  normalizeClaudeResult,
  parseLine,
  toolResultsIn,
  toolUsesIn,
} from './events.js';

/** Options for {@link ClaudeCodeAdapter}. */
export interface ClaudeCodeAdapterOptions {
  /** Executable to invoke. Overridable so tests can drive a stub binary. */
  readonly command?: string | undefined;
  /**
   * Arguments placed before the adapter's own.
   *
   * For installs where `claude` is reached through an interpreter or wrapper —
   * and on Windows, where a `.cmd` shim cannot be spawned without a shell.
   */
  readonly commandArgs?: readonly string[] | undefined;
  /** Milliseconds before a run is abandoned. */
  readonly timeoutMs?: number | undefined;
  /** Clock, injected for deterministic event timestamps in tests. */
  readonly now?: (() => number) | undefined;
  /** Session id generator, injected for determinism in tests. */
  readonly newSessionId?: (() => string) | undefined;
  /**
   * Permission mode passed through to Claude Code.
   *
   * Left at Claude Code's own default. RoutePilot does not weaken a user's
   * permission settings on their behalf.
   */
  readonly permissionMode?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Everything Claude Code can do, as RoutePilot models capabilities. */
const CAPABILITIES: AgentCapabilities = {
  streaming: true,
  cancellation: true,
  toolUse: true,
  agenticExecution: true,
  fileEditing: true,
  terminalExecution: true,
  modelSelection: true,
  usageReporting: true,
};

/** Drives Claude Code through its documented print-mode CLI. */
/**
 * Claude Code tools that modify a file at a known path.
 *
 * `Bash` is deliberately absent: it can write anything and reports no path, so
 * treating it as a write would invent a filename, and treating its absence as
 * proof nothing changed would be equally wrong. `changedFiles` is a lower
 * bound, and the code that reads it treats it as one.
 */
const WRITING_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly capabilities = CAPABILITIES;

  readonly #command: string;
  readonly #commandArgs: readonly string[];
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #newSessionId: () => string;
  readonly #permissionMode: string | undefined;
  readonly #sessions = new Map<string, RunHandle>();

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.#command = options.command ?? 'claude';
    this.#commandArgs = options.commandArgs ?? [];
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#newSessionId = options.newSessionId ?? (() => randomUUID());
    this.#permissionMode = options.permissionMode;
  }

  canHandle(request: AgentExecutionRequest): AgentSupportDecision {
    const required = request.requiredCapabilities;

    for (const [capability, needed] of Object.entries(required)) {
      if (needed !== true) continue;
      if (this.capabilities[capability as keyof AgentCapabilities]) continue;
      return { supported: false, reason: `Claude Code cannot provide "${capability}"` };
    }

    if (request.workspaceRoot.trim() === '') {
      return { supported: false, reason: 'a workspace root is required' };
    }

    return { supported: true };
  }

  async getStatus(): Promise<AgentStatus> {
    const probe = await probeExecutable(
      this.#command,
      [...this.#commandArgs, '--version'],
      process.cwd(),
    );

    if (!probe.available) {
      return {
        available: false,
        detail:
          `Claude Code was not found (tried "${this.#command}"). ` +
          `Install it from https://claude.com/claude-code, or set the adapter's ` +
          `command to its full path.${shimHint(this.#command, probe.detail)} ` +
          `Underlying error: ${probe.detail || 'not available'}`,
      };
    }

    // `claude --version` prints e.g. "2.1.72 (Claude Code)".
    const version = /(\d+\.\d+\.\d+)/.exec(probe.output)?.[1];

    return {
      available: true,
      ...(version === undefined ? {} : { version }),
    };
  }

  execute(request: AgentExecutionRequest, model: ModelSpec): Promise<AgentSession> {
    const sessionId = this.#newSessionId();
    const handle = runProcess({
      command: this.#command,
      args: this.#buildArgs(request, model, sessionId),
      cwd: request.workspaceRoot,
      timeoutMs: this.#timeoutMs,
    });

    this.#sessions.set(sessionId, handle);

    // The terminal `result` event is both the last event and the source of the
    // AgentResult, so it is captured while streaming rather than re-read.
    let terminal: unknown = null;
    const changedFiles = new Set<string>();
    // Refused tool calls are counted, not just streamed. `ok` was already
    // extracted from `tool_result.is_error` and had no consumer, so a run that
    // Claude Code blocked on permissions reached the caller as `completed` with
    // nothing to say it had been prevented from doing any work.
    let refusedToolCalls = 0;
    // A tool call announces its path before its result says whether it was
    // allowed, and Claude Code issues calls in parallel -- two were observed
    // announced before either answered. So paths are held by tool-use id and
    // committed only when that id's own result comes back successful; a refused
    // edit must not count as a changed file.
    const pendingWrites = new Map<string, string>();

    const source = async function* (this: ClaudeCodeAdapter): AsyncGenerator<AgentEvent> {
      for await (const line of handle.lines) {
        const parsed = parseLine(line);
        if (parsed === null) continue;

        if (isResultEvent(parsed)) terminal = parsed;

        // Correlation reads the raw event, not the normalised one:
        // `normalizeClaudeEvent` yields at most one event per message and
        // returns null for some, so counting through it would undercount.
        for (const use of toolUsesIn(parsed)) {
          if (use.path !== null && use.name !== null && WRITING_TOOLS.has(use.name)) {
            pendingWrites.set(use.id, use.path);
          }
        }
        for (const outcome of toolResultsIn(parsed)) {
          if (!outcome.ok) refusedToolCalls += 1;
          const path = pendingWrites.get(outcome.id);
          if (outcome.ok && path !== undefined) changedFiles.add(path);
          pendingWrites.delete(outcome.id);
        }

        const event = normalizeClaudeEvent(parsed, this.#now());
        if (event === null) continue;
        yield event;
      }
    }.call(this);

    // The caller iterates events for display while the adapter iterates them to
    // reach the terminal state. A single iterator would let whichever consumed
    // first starve the other, so the stream is split.
    const [forCaller, forResult] = tee(source);

    const result = (async (): Promise<AgentResult> => {
      // Draining guarantees the process reaches a terminal state even if the
      // caller never touches its branch.
      for await (const event of forResult) {
        void event;
      }

      const outcome = await handle.result;
      this.#sessions.delete(sessionId);
      return this.#toResult(outcome, terminal, [...changedFiles].sort(), refusedToolCalls);
    })();

    return Promise.resolve({
      id: sessionId,
      adapterId: this.id,
      modelId: model.id,
      events: forCaller,
      result,
    });
  }

  cancel(sessionId: string): Promise<void> {
    this.#sessions.get(sessionId)?.cancel();
    return Promise.resolve();
  }

  normalizeEvent(raw: unknown): AgentEvent | null {
    return normalizeClaudeEvent(raw, this.#now());
  }

  normalizeResult(raw: unknown): AgentResult {
    return normalizeClaudeResult(raw, []);
  }

  /**
   * Build the argument list.
   *
   * Every value is a separate argv entry. The prompt is never interpolated
   * into a command string, so its contents cannot be interpreted as shell
   * syntax (spec section 51).
   */
  #buildArgs(request: AgentExecutionRequest, model: ModelSpec, sessionId: string): string[] {
    const args = [
      ...this.#commandArgs,
      '--print',
      request.prompt,
      '--output-format',
      'stream-json',
      // stream-json requires verbose in print mode.
      '--verbose',
      '--model',
      model.modelId,
      '--session-id',
      sessionId,
    ];

    if (this.#permissionMode !== undefined) {
      args.push('--permission-mode', this.#permissionMode);
    }

    return args;
  }

  /** Turn a process outcome plus the terminal event into an AgentResult. */
  #toResult(
    outcome: Awaited<RunHandle['result']>,
    terminal: unknown,
    changedFiles: readonly string[],
    refusedToolCalls: number,
  ): AgentResult {
    switch (outcome.outcome) {
      case 'cancelled':
        return {
          status: 'cancelled',
          changedFiles,
          failureType: 'USER_CANCELLED',
          errorSummary: 'the run was cancelled',
        };

      case 'timed-out':
        return {
          status: 'failed',
          changedFiles,
          failureType: 'TIMEOUT',
          errorSummary: `Claude Code did not finish within ${String(this.#timeoutMs)}ms`,
        };

      case 'spawn-failed':
        return {
          status: 'failed',
          changedFiles,
          // The tool could not be started: an environment problem, never a
          // judgement about the model (spec section 22).
          failureType: 'ENVIRONMENT_FAILURE',
          errorSummary: `could not start "${this.#command}": ${outcome.stderr.trim()}`,
        };

      case 'exited':
      default:
        break;
    }

    if (terminal !== null) {
      const normalized = normalizeClaudeResult(terminal, changedFiles);

      // A run that finished having had every tool call refused and changed
      // nothing did not succeed -- Claude Code cannot prompt for permission in
      // print mode, so it reports a tidy completion having been blocked
      // throughout. Calling that a completed run tells the user their task
      // succeeded; calling it MODEL_WEAKNESS would blame the model for the
      // configuration. It is an environment failure (spec section 22).
      if (normalized.status === 'completed' && refusedToolCalls > 0 && changedFiles.length === 0) {
        return {
          ...normalized,
          status: 'failed',
          failureType: 'ENVIRONMENT_FAILURE',
          errorSummary:
            `Claude Code refused ${String(refusedToolCalls)} tool call(s) and changed no files. ` +
            (this.#permissionMode === undefined
              ? 'No --permission-mode was set, and in print mode Claude Code cannot prompt, ' +
                'so tools that write are declined. Set agents."claude-code".permissionMode ' +
                '(for example "acceptEdits") to allow edits.'
              : `The permission mode "${this.#permissionMode}" did not permit the tools this ` +
                'task needed.'),
        };
      }

      return normalized;
    }

    // Exited without a terminal event: the process failed before producing one.
    return {
      status: 'failed',
      changedFiles,
      failureType: outcome.exitCode === 0 ? 'UNKNOWN' : 'PROVIDER_FAILURE',
      errorSummary:
        outcome.stderr.trim() ||
        `Claude Code exited with code ${String(outcome.exitCode)} and produced no result event`,
    };
  }
}

/**
 * Extra guidance for the Windows `.cmd` shim problem.
 *
 * npm global installs on Windows create a `.cmd` shim, and Node refuses to
 * spawn one without a shell — deliberate hardening against argument injection.
 * RoutePilot never uses a shell, so the fix is to point at the real executable
 * (or supply `commandArgs`), not to weaken the spawn.
 */
function shimHint(command: string, detail: string): string {
  if (!detail.includes('EINVAL')) return '';
  return (
    ` It looks like "${command}" is a .cmd or .bat shim. Node cannot start one without a shell, ` +
    `and RoutePilot never uses a shell (spec section 51). Point the adapter at the real ` +
    `executable, or set commandArgs to run it via its interpreter.`
  );
}

function isResultEvent(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['type'] === 'result'
  );
}

/**
 * Split one async iterable into two independent ones.
 *
 * The caller consumes events for display while the adapter consumes them to
 * build the result. Without this, whichever consumed first would starve the
 * other.
 */
function tee<T>(source: AsyncIterable<T>): [AsyncIterable<T>, AsyncIterable<T>] {
  const buffers: T[][] = [[], []];
  const wakers: ((() => void) | null)[] = [null, null];
  let done = false;
  let pumping = false;

  const wake = (index: number): void => {
    const waker = wakers[index];
    wakers[index] = null;
    waker?.();
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    for await (const value of source) {
      buffers[0]?.push(value);
      buffers[1]?.push(value);
      wake(0);
      wake(1);
    }
    done = true;
    wake(0);
    wake(1);
  };

  const branch = (index: number): AsyncIterable<T> => ({
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      void pump();
      for (;;) {
        const buffer = buffers[index] as T[];
        while (buffer.length > 0) yield buffer.shift() as T;
        if (done) return;
        await new Promise<void>((resolve) => {
          wakers[index] = resolve;
        });
      }
    },
  });

  return [branch(0), branch(1)];
}
