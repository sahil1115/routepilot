/**
 * Node implementation of {@link GitPort}.
 *
 * Security (spec section 51): every invocation uses `execFile` with an argument
 * array and `shell: false`. No command string is assembled, so a repository
 * path containing shell metacharacters cannot inject anything. Argument lists
 * are constant; only the working directory varies, passed as `cwd`.
 *
 * The analyzed root is frequently not the repository root -- a package inside a
 * monorepo, or a developer who ran `git init` in their home directory, which
 * silently makes every temporary directory part of a repository containing the
 * whole user profile. Both are handled the same way: status and diff are
 * restricted to the analyzed subtree with a `-- .` pathspec, and the paths git
 * reports (always relative to the repository root) are rebased onto the
 * analyzed root. Without this, analysing a small folder can walk an enormous
 * tree and report unrelated changes.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ChangedFile, ChangeKind, GitPort, GitState } from '../core/ports.js';

const run = promisify(execFile);

/** A workspace that is not a repository, or where git is unavailable. */
const NOT_A_REPOSITORY: GitState = {
  isRepository: false,
  branch: null,
  headCommit: null,
  // Empty rather than null: a directory that is not a repository genuinely has
  // no changed files, which is a known fact rather than an unreadable one.
  changedFiles: [],
  insertions: 0,
  deletions: 0,
};

/** Maps `git status --porcelain` status letters onto change kinds. */
const STATUS_CODES: ReadonlyMap<string, ChangeKind> = new Map<string, ChangeKind>([
  ['A', 'added'],
  ['M', 'modified'],
  ['D', 'deleted'],
  ['R', 'renamed'],
  ['C', 'added'],
  ['U', 'modified'],
  ['T', 'modified'],
]);

/** Options for {@link NodeGit}. */
export interface NodeGitOptions {
  /**
   * Milliseconds before a git call is abandoned.
   *
   * Kept short. A pathological repository must degrade to "no change
   * information" quickly rather than stall every routing decision.
   */
  readonly timeoutMs?: number | undefined;
  /** Maximum bytes captured from git's stdout. */
  readonly maxBuffer?: number | undefined;
}

/** Reads real git state via the `git` executable. */
export class NodeGit implements GitPort {
  readonly #timeoutMs: number;
  readonly #maxBuffer: number;

  constructor(options: NodeGitOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  }

  async getState(root: string): Promise<GitState> {
    const toplevel = await this.#git(root, ['rev-parse', '--show-toplevel']);
    if (toplevel === null) return NOT_A_REPOSITORY;

    const repositoryRoot = toplevel.trim();
    if (repositoryRoot === '') return NOT_A_REPOSITORY;

    // The subtree being analysed, relative to the repository root.
    const prefix = relativePrefix(repositoryRoot, root);

    const [branch, head, status, numstat] = await Promise.all([
      // `symbolic-ref` also works on an unborn branch — a repository with no
      // commits yet still has a branch name, and reporting it as "detached"
      // would be wrong.
      this.#git(root, ['symbolic-ref', '--short', 'HEAD']),
      this.#git(root, ['rev-parse', 'HEAD']),
      // `-- .` restricts the walk to the analysed subtree.
      this.#git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.']),
      this.#git(root, ['diff', '--numstat', '--', '.']),
    ]);

    // `?? null` rather than `?? ''`, deliberately. Substituting empty output
    // for a failed query would turn "we could not look" into "we looked and
    // found nothing" — a clean tree and zero churn, both invented. Only the
    // query actually running is allowed to produce a number.
    const churn = numstat === null ? null : parseNumstat(numstat);

    // Individual command failures degrade to "unknown", not to "not a
    // repository" — the repository plainly exists, we just could not read part
    // of its state.
    return {
      isRepository: true,
      branch: branch === null ? null : branch.trim() || null,
      // A genuinely detached HEAD yields null above, which is correct.
      // An empty repository has no HEAD; `rev-parse HEAD` fails, which is fine.
      headCommit: head === null ? null : head.trim() || null,
      changedFiles: status === null ? null : rebase(parseStatus(status), prefix),
      insertions: churn === null ? null : churn.insertions,
      deletions: churn === null ? null : churn.deletions,
    };
  }

  /** Run one git command. Returns null on any failure, including timeout. */
  async #git(cwd: string, args: readonly string[]): Promise<string | null> {
    try {
      const { stdout } = await run('git', [...args], {
        cwd,
        timeout: this.#timeoutMs,
        maxBuffer: this.#maxBuffer,
        windowsHide: true,
        // Never a shell: arguments stay arguments.
        shell: false,
      });
      return stdout;
    } catch {
      return null;
    }
  }
}

/** Parse `git status --porcelain=v1` output. Paths stay repository-relative. */
export function parseStatus(output: string): ChangedFile[] {
  const changed: ChangedFile[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) continue;

    const code = line.slice(0, 2);
    let path = line.slice(3).trim();

    if (code === '??') {
      changed.push({ path: normalise(path), change: 'untracked' });
      continue;
    }

    // Renames appear as "old -> new"; the new path is what matters.
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);

    const indexStatus = code[0] ?? ' ';
    const workTreeStatus = code[1] ?? ' ';
    const letter = workTreeStatus !== ' ' ? workTreeStatus : indexStatus;
    const change = STATUS_CODES.get(letter);
    if (change === undefined) continue;

    changed.push({ path: normalise(path), change });
  }

  return changed;
}

/** Parse `git diff --numstat` output into total insertions and deletions. */
export function parseNumstat(output: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;

  for (const line of output.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    // Binary files report "-"; they contribute no line counts.
    const added = Number(parts[0]);
    const removed = Number(parts[1]);
    if (Number.isFinite(added)) insertions += added;
    if (Number.isFinite(removed)) deletions += removed;
  }

  return { insertions, deletions };
}

/**
 * The analysed root's path relative to the repository root.
 *
 * Empty when they are the same directory. Comparison is case-insensitive
 * because Windows paths are.
 */
export function relativePrefix(repositoryRoot: string, analyzedRoot: string): string {
  const repository = trimSlash(normalise(repositoryRoot));
  const analyzed = trimSlash(normalise(analyzedRoot));

  if (repository.toLowerCase() === analyzed.toLowerCase()) return '';
  if (analyzed.toLowerCase().startsWith(`${repository.toLowerCase()}/`)) {
    return analyzed.slice(repository.length + 1);
  }
  // Unrelated paths: treat as the repository root and let filtering decide.
  return '';
}

/**
 * Rebase repository-relative paths onto the analysed root, dropping anything
 * outside it.
 */
export function rebase(changed: readonly ChangedFile[], prefix: string): ChangedFile[] {
  if (prefix === '') return [...changed];

  const lowerPrefix = `${prefix.toLowerCase()}/`;
  const rebased: ChangedFile[] = [];

  for (const file of changed) {
    const lower = file.path.toLowerCase();
    if (!lower.startsWith(lowerPrefix)) continue;
    rebased.push({ path: file.path.slice(lowerPrefix.length), change: file.change });
  }

  return rebased;
}

/** Strip the quoting git applies to paths with unusual characters. */
function normalise(path: string): string {
  const unquoted = path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
  return unquoted.replace(/\\/g, '/');
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, '');
}
