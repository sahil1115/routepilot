/**
 * Cursor CLI adapter (spec section 19).
 *
 * Integrates through the documented `cursor-agent` CLI:
 *
 *     cursor-agent --print --output-format stream-json --model <id> <prompt>
 *
 * Explicitly not done, and not claimed:
 *
 * - No interception of Cursor's network traffic.
 * - No modification of the Cursor installation or its internal files.
 *
 * `cursor-agent` is **not installed on this machine**, so this adapter has
 * never been run against the real tool. It is marked `unavailable` in
 * `src/adapters/verification.ts`, and its event normalisation is written from
 * the shapes the specification names rather than from captured output — so it
 * ignores anything it does not recognise instead of guessing.
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
import { normalizeCursorEvent, normalizeCursorResult, parseLine } from './events.js';
import { resolveCursorCommand, type ResolveOptions } from './windows-shim.js';

/** Options for {@link CursorCliAdapter}. */
export interface CursorCliAdapterOptions {
  /** How to resolve the CLI. Injected in tests; see `windows-shim.ts`. */
  readonly resolve?: ResolveOptions | undefined;
  readonly command?: string | undefined;
  /** Arguments placed before the adapter's own. See the Claude Code adapter. */
  readonly commandArgs?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly newSessionId?: (() => string) | undefined;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const CAPABILITIES: AgentCapabilities = {
  streaming: true,
  cancellation: true,
  toolUse: true,
  agenticExecution: true,
  fileEditing: true,
  terminalExecution: true,
  modelSelection: true,
  // Cursor's CLI is not documented to report token usage, so RoutePilot does
  // not claim it can. Actual-cost accounting will be unavailable through this
  // adapter until proven otherwise.
  usageReporting: false,
};

/** Drives Cursor's agent through its documented CLI. */
export class CursorCliAdapter implements AgentAdapter {
  readonly id = 'cursor-cli';
  readonly displayName = 'Cursor CLI';
  readonly capabilities = CAPABILITIES;

  readonly #command: string;
  readonly #commandArgs: readonly string[];
  readonly #resolvedVia: 'path' | 'windows-shim';
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #newSessionId: () => string;
  readonly #sessions = new Map<string, RunHandle>();

  constructor(options: CursorCliAdapterOptions = {}) {
    // On Windows the installer puts only `cursor-agent.cmd` on PATH, which
    // `execFile` cannot launch without a shell -- and a shell is forbidden.
    // The resolver finds the real `node.exe` and `index.js` the shim runs.
    // Everywhere else, and whenever a caller names its own command, this
    // returns what it was given.
    const resolved = resolveCursorCommand(
      options.command ?? 'cursor-agent',
      options.commandArgs ?? [],
      options.resolve ?? {},
    );
    this.#command = resolved.command;
    this.#commandArgs = resolved.commandArgs;
    this.#resolvedVia = resolved.via;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#newSessionId = options.newSessionId ?? (() => randomUUID());
  }

  canHandle(request: AgentExecutionRequest): AgentSupportDecision {
    for (const [capability, needed] of Object.entries(request.requiredCapabilities)) {
      if (needed !== true) continue;
      if (this.capabilities[capability as keyof AgentCapabilities]) continue;
      return { supported: false, reason: `the Cursor CLI cannot provide "${capability}"` };
    }
    if (request.workspaceRoot.trim() === '') {
      return { supported: false, reason: 'a workspace root is required' };
    }
    return { supported: true };
  }

  /**
   * Report availability with an actionable setup error when absent
   * (spec section 19).
   */
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
          `The Cursor CLI was not found (tried "${this.#command}"). ` +
          `Install it from https://cursor.com/cli and ensure "cursor-agent" is on PATH, ` +
          `or point the adapter at its full path. ` +
          (process.platform === 'win32' && this.#resolvedVia === 'path'
            ? 'On Windows the installer provides only cursor-agent.cmd, which cannot be ' +
              'launched without a shell; RoutePilot looks for the node.exe and index.js it ' +
              'wraps under %LOCALAPPDATA%\\cursor-agent\\versions and found neither. '
            : '') +
          `Note: the "cursor" editor launcher is a different program and cannot be used here. ` +
          `Underlying error: ${probe.detail || 'not available'}`,
      };
    }

    const version = /(\d+\.\d+\.\d+)/.exec(probe.output)?.[1];
    return { available: true, ...(version === undefined ? {} : { version }) };
  }

  execute(request: AgentExecutionRequest, model: ModelSpec): Promise<AgentSession> {
    const sessionId = this.#newSessionId();
    const handle = runProcess({
      command: this.#command,
      args: [
        ...this.#commandArgs,
        '--print',
        '--output-format',
        'stream-json',
        '--model',
        model.modelId,
        request.prompt,
      ],
      cwd: request.workspaceRoot,
      timeoutMs: this.#timeoutMs,
    });

    this.#sessions.set(sessionId, handle);

    let terminal: unknown = null;
    const changedFiles = new Set<string>();

    const source = async function* (this: CursorCliAdapter): AsyncGenerator<AgentEvent> {
      for await (const line of handle.lines) {
        const parsed = parseLine(line);
        if (parsed === null) continue;
        if (isTerminal(parsed)) terminal = parsed;

        const event = normalizeCursorEvent(parsed, this.#now());
        if (event === null) continue;
        if (event.path !== undefined) changedFiles.add(event.path);
        yield event;
      }
    }.call(this);

    const [forCaller, forResult] = teeEvents(source);

    const result = (async (): Promise<AgentResult> => {
      for await (const event of forResult) {
        void event;
      }
      const outcome = await handle.result;
      this.#sessions.delete(sessionId);

      const files = [...changedFiles].sort();

      switch (outcome.outcome) {
        case 'cancelled':
          return {
            status: 'cancelled',
            changedFiles: files,
            failureType: 'USER_CANCELLED',
            errorSummary: 'the run was cancelled',
          };
        case 'timed-out':
          return {
            status: 'failed',
            changedFiles: files,
            failureType: 'TIMEOUT',
            errorSummary: `the Cursor CLI did not finish within ${String(this.#timeoutMs)}ms`,
          };
        case 'spawn-failed':
          return {
            status: 'failed',
            changedFiles: files,
            failureType: 'ENVIRONMENT_FAILURE',
            errorSummary: `could not start "${this.#command}": ${outcome.stderr.trim()}`,
          };
        default:
          break;
      }

      if (terminal !== null) return normalizeCursorResult(terminal, files);

      return {
        status: 'failed',
        changedFiles: files,
        failureType: outcome.exitCode === 0 ? 'UNKNOWN' : 'PROVIDER_FAILURE',
        errorSummary:
          outcome.stderr.trim() ||
          `the Cursor CLI exited with code ${String(outcome.exitCode)} and produced no result`,
      };
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
    return normalizeCursorEvent(raw, this.#now());
  }

  normalizeResult(raw: unknown): AgentResult {
    return normalizeCursorResult(raw, []);
  }
}

function isTerminal(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as Record<string, unknown>)['type'];
  return type === 'result' || type === 'error';
}

/** Split one async iterable into two independent ones. */
function teeEvents<T>(source: AsyncIterable<T>): [AsyncIterable<T>, AsyncIterable<T>] {
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
