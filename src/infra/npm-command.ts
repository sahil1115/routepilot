/**
 * Finding a spawnable `npm` on Windows.
 *
 * Validation commands are derived from a workspace's own manifest scripts, so
 * every one of them is `npm run <script>`. On Windows npm is `npm.cmd`, and
 * Node's `execFile` refuses to launch a `.cmd` without a shell — deliberate
 * hardening against argument injection — while `docs/SECURITY.md` forbids
 * `shell: true` because this project spawns processes with values that came
 * from a user's prompt.
 *
 * The consequence was not a degraded check but a silent, total one: every
 * validation command failed to start, every check reported "not run", and so
 * **every `routepilot run --execute` on Windows reported `unverified`
 * regardless of what the agent had actually done.** The engine that exists to
 * stop RoutePilot trusting an agent's own word could not run at all on this
 * platform. Nothing caught it because every unit test injects a fake command
 * runner, and the real-agent script drove adapters directly, never the loop.
 *
 * npm ships a plain JavaScript entry point next to the Node binary that runs
 * it, so this resolves that and runs it with `process.execPath`. Same idea as
 * `src/adapters/cursor/windows-shim.ts`, for the same reason, and confined to
 * one file so it stays visible as a platform workaround rather than spreading.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A command that can be spawned without a shell. */
export interface SpawnableCommand {
  readonly command: string;
  /** Arguments placed before the caller's own. Empty on most platforms. */
  readonly args: readonly string[];
}

/**
 * Where npm's JavaScript entry point sits relative to the Node binary.
 *
 * Two layouts cover the installers in practice: Windows keeps npm beside
 * `node.exe`, while Unix-style prefixes keep it under `lib/`.
 */
function candidates(nodeDirectory: string): string[] {
  return [
    join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}

/**
 * The way to run npm on this machine, or plain `npm` when no shim is needed.
 *
 * Only Windows is special-cased. Everywhere else `npm` is an executable script
 * that `execFile` can launch directly, and rewriting it would replace a working
 * command with a guess about the installation layout.
 *
 * If no entry point is found the plain command is returned rather than
 * throwing. The check then reports that it could not start — which is honest,
 * and better than failing the run over a validation command.
 */
export function resolveNpmCommand(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
): SpawnableCommand {
  if (platform !== 'win32') return { command: 'npm', args: [] };

  for (const candidate of candidates(dirname(execPath))) {
    if (exists(candidate)) return { command: execPath, args: [candidate] };
  }

  return { command: 'npm', args: [] };
}
