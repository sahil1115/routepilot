/**
 * Finding the Cursor CLI on Windows.
 *
 * The installer puts `cursor-agent.cmd` and `cursor-agent.ps1` on PATH and no
 * `.exe` at all. Node's `execFile` cannot launch a `.cmd` without a shell —
 * it returns `EINVAL` — and `docs/SECURITY.md` forbids `shell: true`, because a
 * shell re-parses arguments and this project spawns processes with values that
 * came from a user's prompt.
 *
 * So the adapter's default of `cursor-agent` cannot work on Windows at all.
 * Measured on 2026-09-03 against Cursor CLI 2026.09.02-c22c1a3:
 *
 *     cursor-agent.cmd   (what the installer puts on PATH)  -> EINVAL
 *     node.exe index.js  (what the shim ultimately runs)    -> 2026.09.02-c22c1a3
 *
 * The `.cmd` runs the `.ps1`, and the `.ps1` runs
 * `<version>\node.exe <version>\index.js`. Both of those are real files that
 * `execFile` can spawn, so this resolves them directly and reaches the same CLI
 * by a route the security policy allows.
 *
 * This is a workaround for a packaging decision on one platform, and it is
 * confined to this file so that it stays visible as one. If Cursor ships a real
 * executable, delete this.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** How the CLI should actually be invoked. */
export interface ResolvedCommand {
  readonly command: string;
  /** Arguments placed before the adapter's own. */
  readonly commandArgs: readonly string[];
  /** Why this resolution was chosen, for the status detail. */
  readonly via: 'path' | 'windows-shim';
}

/** Options for {@link resolveCursorCommand}. Injected in tests. */
export interface ResolveOptions {
  readonly platform?: string | undefined;
  readonly localAppData?: string | undefined;
  /** Existence check, so the resolver can be tested without a Cursor install. */
  readonly exists?: ((path: string) => boolean) | undefined;
  /** Directory listing, likewise. */
  readonly list?: ((path: string) => readonly string[]) | undefined;
}

/**
 * Resolve how to run the Cursor CLI.
 *
 * Returns the command unchanged unless every one of these holds: the platform
 * is Windows, the caller did not name its own command, and a shim install with
 * both `node.exe` and `index.js` is present. Anything else is left alone —
 * a caller that passed an explicit path meant it.
 */
export function resolveCursorCommand(
  command: string,
  commandArgs: readonly string[],
  options: ResolveOptions = {},
): ResolvedCommand {
  const unchanged: ResolvedCommand = { command, commandArgs, via: 'path' };

  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return unchanged;

  // An explicit path is a decision, not a hint. Only the default is rewritten.
  if (command !== 'cursor-agent') return unchanged;
  if (commandArgs.length > 0) return unchanged;

  const localAppData = options.localAppData ?? process.env['LOCALAPPDATA'];
  if (localAppData === undefined || localAppData === '') return unchanged;

  const exists = options.exists ?? existsSync;
  const list =
    options.list ??
    ((path: string): readonly string[] => {
      try {
        return readdirSync(path).filter((entry) => {
          try {
            return statSync(join(path, entry)).isDirectory();
          } catch {
            return false;
          }
        });
      } catch {
        return [];
      }
    });

  // Everything below touches the filesystem, and a locked, roaming or
  // half-removed directory must not throw out of a constructor. Failing to
  // resolve is a supported outcome -- the adapter then reports "not found" with
  // setup guidance, which is a better error than a stack trace.
  try {
    return resolveFromDisk(localAppData, exists, list) ?? unchanged;
  } catch {
    return unchanged;
  }
}

function resolveFromDisk(
  localAppData: string,
  exists: (path: string) => boolean,
  list: (path: string) => readonly string[],
): ResolvedCommand | null {
  const versionsDir = join(localAppData, 'cursor-agent', 'versions');
  if (!exists(versionsDir)) return null;

  // Newest last by name. Cursor's directories are dated
  // (`2026.09.02-c22c1a3`), so a lexicographic sort is chronological, and
  // picking deterministically matters more than picking cleverly.
  const candidates = [...list(versionsDir)].sort();

  for (const version of candidates.reverse()) {
    const node = join(versionsDir, version, 'node.exe');
    const entry = join(versionsDir, version, 'index.js');
    if (exists(node) && exists(entry)) {
      return { command: node, commandArgs: [entry], via: 'windows-shim' };
    }
  }

  return null;
}
