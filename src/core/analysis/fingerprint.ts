/**
 * Repository fingerprinting — cheap change detection (spec section 10).
 *
 * The cache is only worth having if checking it is far cheaper than the work it
 * avoids. A fingerprint therefore reads git state and a handful of manifest
 * stats, and never walks the tree.
 *
 * It is split into independent components so invalidation can be *partial*.
 * Editing one line of one tracked file should not throw away the language
 * breakdown of a 20,000-file repository; it should invalidate the git-derived
 * facts and nothing else.
 */

import type { ChangedFile, FileSystemPort, GitState } from '../ports.js';
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from '../perf/concurrency.js';

/** Manifest files whose modification changes what we believe about the project. */
const MANIFEST_FILES: readonly string[] = [
  'package.json',
  'pnpm-workspace.yaml',
  'lerna.json',
  'turbo.json',
  'nx.json',
  'rush.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
];

/**
 * A cheap, component-wise summary of repository state.
 *
 * Each field is compared independently; see {@link diffFingerprints}.
 */
export interface RepositoryFingerprint {
  /** HEAD commit SHA, or null outside a repository or on an empty one. */
  readonly headCommit: string | null;
  /** Current branch, or null. */
  readonly branch: string | null;
  /**
   * Signature of which files are modified.
   *
   * Content-independent: it records paths and change kinds, not contents.
   */
  readonly workingTree: string;
  /**
   * Signature of the *set* of files, derived from additions, deletions and
   * untracked entries.
   *
   * Separate from {@link workingTree} because a modification to an existing
   * file leaves the file set unchanged, and the expensive inventory therefore
   * remains valid.
   */
  readonly fileSet: string;
  /** Signature of manifest sizes and modification times. */
  readonly manifests: string;
}

/** What changed between two fingerprints. */
export interface FingerprintDiff {
  readonly unchanged: boolean;
  readonly headChanged: boolean;
  /** Files were added, deleted or newly untracked. The inventory is stale. */
  readonly fileSetChanged: boolean;
  /** Existing files were modified. Git-derived facts are stale. */
  readonly workingTreeChanged: boolean;
  /** A manifest changed. Dependency and framework facts are stale. */
  readonly manifestsChanged: boolean;
  /** Human-readable reasons, for the cache report. */
  readonly reasons: readonly string[];
}

/** Change kinds that alter which files exist. */
const FILE_SET_CHANGES: ReadonlySet<string> = new Set(['added', 'deleted', 'renamed', 'untracked']);

/**
 * Compute a fingerprint.
 *
 * Costs one git call (already made by the analyzer) plus one `stat` per
 * manifest file — a bounded, small number of syscalls regardless of repository
 * size.
 */
export async function computeFingerprint(
  root: string,
  git: GitState,
  fs: FileSystemPort,
): Promise<RepositoryFingerprint> {
  const changed = [...(git.changedFiles ?? [])].sort((a, b) => a.path.localeCompare(b.path));

  // Statted concurrently. This runs on **every** analysis, including one that
  // will hit the cache, so it is the one piece of I/O a warm request cannot
  // avoid. `mapWithConcurrency` preserves order, which matters: the parts feed
  // a hash, and a hash that depended on disk timing would invalidate the cache
  // at random.
  const manifestStats = await mapWithConcurrency(MANIFEST_FILES, DEFAULT_CONCURRENCY, (name) =>
    fs.stat(joinPath(root, name)),
  );

  const manifestParts = MANIFEST_FILES.map((name, index) => {
    const stat = manifestStats[index];
    return stat === null || stat === undefined
      ? null
      : `${name}:${String(stat.size)}:${String(stat.mtimeMs)}`;
  }).filter((part): part is string => part !== null);

  return {
    headCommit: git.headCommit,
    branch: git.branch,
    // Both branches are tagged, so an unreadable working tree can never hash
    // to the same value as a genuinely clean one. Untagged, both would hash
    // the empty string, and an analysis cached from a readable clean tree
    // would be reused for a tree nobody could look at.
    //
    // The sentinel is a constant rather than something unique per call,
    // because determinism is not negotiable: two consecutive unreadable
    // states do reuse the cache, which is the price of never letting the
    // clock into a decision.
    workingTree: hash(
      git.changedFiles === null
        ? 'unreadable'
        : `files|${changed.map((f) => `${f.path}:${f.change}`).join('|')}`,
    ),
    fileSet: hash(fileSetSignature(changed)),
    manifests: hash(manifestParts.join('|')),
  };
}

/** Compare two fingerprints component by component. */
export function diffFingerprints(
  previous: RepositoryFingerprint | undefined,
  current: RepositoryFingerprint,
): FingerprintDiff {
  if (previous === undefined) {
    return {
      unchanged: false,
      headChanged: true,
      fileSetChanged: true,
      workingTreeChanged: true,
      manifestsChanged: true,
      reasons: ['no cached analysis'],
    };
  }

  const reasons: string[] = [];

  const headChanged =
    previous.headCommit !== current.headCommit || previous.branch !== current.branch;
  if (headChanged) reasons.push('git HEAD or branch changed');

  const fileSetChanged = previous.fileSet !== current.fileSet;
  if (fileSetChanged) reasons.push('files were added, removed or renamed');

  const workingTreeChanged = previous.workingTree !== current.workingTree;
  if (workingTreeChanged && !fileSetChanged) reasons.push('tracked files were modified');

  const manifestsChanged = previous.manifests !== current.manifests;
  if (manifestsChanged) reasons.push('a manifest file changed');

  return {
    unchanged: !headChanged && !fileSetChanged && !workingTreeChanged && !manifestsChanged,
    headChanged,
    // A new commit can change any file, so the inventory must be rebuilt.
    fileSetChanged: fileSetChanged || headChanged,
    workingTreeChanged: workingTreeChanged || headChanged,
    manifestsChanged: manifestsChanged || headChanged,
    reasons,
  };
}

/** Signature of which files exist, ignoring pure modifications. */
function fileSetSignature(changed: readonly ChangedFile[]): string {
  return changed
    .filter((file) => FILE_SET_CHANGES.has(file.change))
    .map((file) => `${file.path}:${file.change}`)
    .join('|');
}

/**
 * A small non-cryptographic hash (FNV-1a, 32-bit).
 *
 * Used only to compare a value against its own previous version. It is not a
 * security boundary, and it hashes paths and stat metadata — never file
 * contents, so nothing sensitive is retained (spec section 33).
 */
function hash(input: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

/** Join a root and a relative path with forward slashes. */
function joinPath(root: string, relative: string): string {
  const trimmed = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root;
  return `${trimmed}/${relative}`;
}
