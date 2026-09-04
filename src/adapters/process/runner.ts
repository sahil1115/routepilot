/**
 * Safe child-process execution for agent CLIs.
 *
 * Every adapter that shells out goes through here, so the security and
 * lifecycle rules are implemented once.
 *
 * No shell, ever: `spawn` is called with an argument array and `shell: false`,
 * so a prompt containing `;`, `&&`, backticks or quotes passes through as one
 * argument and cannot inject a command (section 51). That matters most here,
 * because the prompt is arbitrary user text.
 *
 * Every run is bounded by a timeout and a hard output cap, so an agent that
 * hangs or floods stdout cannot take the router with it; cancellable, reporting
 * cancellation rather than failure; and streaming, exposing stdout as an async
 * iterable of lines so events arrive as they happen.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** How a run finished. */
export const RUN_OUTCOMES = ['exited', 'timed-out', 'cancelled', 'spawn-failed'] as const;

/** How a run finished. */
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** The terminal state of a process run. */
export interface RunResult {
  readonly outcome: RunOutcome;
  /** Process exit code, when it exited normally. */
  readonly exitCode: number | null;
  /** Signal that killed the process, when one did. */
  readonly signal: string | null;
  /** Captured stderr, truncated to the output cap. */
  readonly stderr: string;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** True when stdout or stderr hit the output cap and was truncated. */
  readonly truncated: boolean;
}

/** Options for {@link runProcess}. */
export interface RunOptions {
  /** Executable name or path. Never a command line. */
  readonly command: string;
  /** Arguments, passed through verbatim as separate argv entries. */
  readonly args: readonly string[];
  /** Working directory. */
  readonly cwd: string;
  /** Milliseconds before the process is killed. */
  readonly timeoutMs: number;
  /** Environment for the child. Defaults to the parent's. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Maximum bytes captured from each of stdout and stderr. */
  readonly maxOutputBytes?: number | undefined;
  /** Text written to the child's stdin, if any. */
  readonly stdin?: string | undefined;
}

/** A running child process. */
export interface RunHandle {
  /** stdout, yielded one line at a time as it arrives. */
  readonly lines: AsyncIterable<string>;
  /** Resolves once the process has terminated and stdout is drained. */
  readonly result: Promise<RunResult>;
  /** Stop the process. Safe to call repeatedly and after termination. */
  cancel(): void;
}

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Start a process and stream its stdout.
 *
 * Never throws for a failing command: a missing executable produces a
 * `spawn-failed` result, because "the tool is not installed" is a routine
 * situation that deserves an actionable message rather than a stack trace.
 */
export function runProcess(options: RunOptions): RunHandle {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  const queue = new LineQueue();
  let stderr = '';
  let stderrBytes = 0;
  let truncated = false;
  let settled = false;
  let cancelled = false;
  let timedOut = false;

  let child: ChildProcessWithoutNullStreams | null = null;
  let resolveResult: (result: RunResult) => void = () => undefined;
  const result = new Promise<RunResult>((resolve) => {
    resolveResult = resolve;
  });

  const finish = (outcome: RunOutcome, exitCode: number | null, signal: string | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    queue.close();
    resolveResult({
      outcome,
      exitCode,
      signal,
      stderr,
      durationMs: Date.now() - startedAt,
      truncated,
    });
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  // A pending timer must not hold the process open on its own.
  timer.unref?.();

  function kill(): void {
    if (child === null || child.killed) return;
    child.kill('SIGTERM');
    // If it ignores SIGTERM, escalate. Unref'd so it cannot delay exit.
    const escalation = setTimeout(() => {
      if (child !== null && !child.killed) child.kill('SIGKILL');
    }, 2_000);
    escalation.unref?.();
  }

  try {
    child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      // Never a shell: arguments stay arguments, whatever they contain.
      shell: false,
      windowsHide: true,
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    stderr = error instanceof Error ? error.message : String(error);
    finish('spawn-failed', null, null);
    return { lines: queue, result, cancel: () => undefined };
  }

  const process_ = child;

  process_.on('error', (error: Error) => {
    // ENOENT and friends arrive here rather than as a throw.
    stderr = stderr === '' ? error.message : `${stderr}\n${error.message}`;
    finish('spawn-failed', null, null);
  });

  process_.stdout.setEncoding('utf8');
  process_.stdout.on('data', (chunk: string) => {
    if (queue.bytes + chunk.length > maxOutputBytes) {
      truncated = true;
      kill();
      return;
    }
    queue.push(chunk);
  });

  process_.stderr.setEncoding('utf8');
  process_.stderr.on('data', (chunk: string) => {
    if (stderrBytes + chunk.length > maxOutputBytes) {
      truncated = true;
      return;
    }
    stderrBytes += chunk.length;
    stderr += chunk;
  });

  process_.on('close', (code, signal) => {
    if (cancelled) finish('cancelled', code, signal);
    else if (timedOut) finish('timed-out', code, signal);
    else finish('exited', code, signal);
  });

  if (options.stdin !== undefined) {
    process_.stdin.end(options.stdin);
  } else {
    // Close stdin so a child waiting on input does not hang forever.
    process_.stdin.end();
  }

  return {
    lines: queue,
    result,
    cancel: () => {
      if (settled) return;
      cancelled = true;
      kill();
    },
  };
}

/**
 * Buffers incoming text and yields complete lines.
 *
 * A hand-rolled queue rather than `readline` because it has to be closeable
 * from the outside (on timeout or cancellation) and has to report how many
 * bytes it is holding, for the output cap.
 */
class LineQueue implements AsyncIterable<string> {
  #buffer = '';
  #pending: string[] = [];
  #closed = false;
  #notify: (() => void) | null = null;
  bytes = 0;

  push(chunk: string): void {
    if (this.#closed) return;
    this.bytes += chunk.length;
    this.#buffer += chunk;

    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== '') this.#pending.push(line);
      newline = this.#buffer.indexOf('\n');
    }

    this.#wake();
  }

  close(): void {
    if (this.#closed) return;
    // A final line without a trailing newline is still a line.
    const remainder = this.#buffer.trim();
    if (remainder !== '') this.#pending.push(remainder);
    this.#buffer = '';
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    const notify = this.#notify;
    this.#notify = null;
    notify?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      while (this.#pending.length > 0) {
        yield this.#pending.shift() as string;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#notify = resolve;
      });
    }
  }
}

/**
 * Whether an executable can be started at all.
 *
 * Implemented by running it rather than by searching `PATH`, because `PATH`
 * resolution differs across platforms and shells, and the only question that
 * matters is whether *this* process can launch *that* command.
 */
export async function probeExecutable(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 10_000,
): Promise<{ available: boolean; output: string; detail: string }> {
  const handle = runProcess({ command, args, cwd, timeoutMs });

  const collected: string[] = [];
  for await (const line of handle.lines) collected.push(line);
  const outcome = await handle.result;

  const output = collected.join('\n').trim();

  if (outcome.outcome === 'spawn-failed') {
    return { available: false, output: '', detail: outcome.stderr };
  }
  if (outcome.outcome === 'timed-out') {
    return { available: false, output, detail: `timed out after ${String(timeoutMs)}ms` };
  }
  if (outcome.exitCode !== 0) {
    return {
      available: false,
      output,
      detail: `exited with code ${String(outcome.exitCode)}: ${outcome.stderr.trim()}`,
    };
  }

  return { available: true, output, detail: '' };
}
