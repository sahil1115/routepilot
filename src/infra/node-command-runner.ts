/**
 * Node implementation of {@link CommandRunnerPort}.
 *
 * Uses `execFile` with an argument array and `shell: false`, so a repository
 * path or script name containing shell metacharacters cannot inject a command
 * (spec section 51).
 *
 * Validation commands only need an exit code and captured output — there is no
 * streaming requirement — so this is deliberately simpler than the adapters'
 * streaming process runner rather than sharing it.
 */

import { execFile } from 'node:child_process';

import type { CommandOutcome, CommandRequest, CommandRunnerPort } from '../core/ports.js';

/** Maximum bytes captured from stdout and stderr combined. */
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/** Runs validation commands as real child processes. */
export class NodeCommandRunner implements CommandRunnerPort {
  readonly #maxBuffer: number;

  constructor(maxBuffer: number = DEFAULT_MAX_BUFFER) {
    this.#maxBuffer = maxBuffer;
  }

  run(request: CommandRequest): Promise<CommandOutcome> {
    return new Promise((resolve) => {
      execFile(
        request.command,
        [...request.args],
        {
          cwd: request.cwd,
          timeout: request.timeoutMs,
          maxBuffer: this.#maxBuffer,
          windowsHide: true,
          // Never a shell: arguments stay arguments.
          shell: false,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ started: true, exitCode: 0, stdout, stderr, timedOut: false });
            return;
          }

          const failure = error as Error & {
            code?: number | string;
            killed?: boolean;
            signal?: string | null;
          };
          const timedOut = failure.killed === true || failure.signal === 'SIGTERM';

          // A string `code` (ENOENT, EINVAL) means the process never started;
          // a numeric one means it ran and exited non-zero.
          const started = typeof failure.code !== 'string';

          resolve({
            started,
            exitCode: typeof failure.code === 'number' ? failure.code : null,
            stdout,
            stderr: stderr === '' ? failure.message : stderr,
            timedOut,
          });
        },
      );
    });
  }
}
