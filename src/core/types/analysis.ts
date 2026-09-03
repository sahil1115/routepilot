/**
 * Progressive repository analysis types (spec section 10).
 *
 * Analysis has three levels, and the level is chosen by what the task actually
 * needs. Expensive analysis is never run for a request that does not require it.
 *
 * The levels are cumulative and share one cached file inventory, so reaching
 * level 2 after level 1 does no filesystem work twice.
 */

import type { ChangedFile, Diagnostic, GitState } from '../ports.js';

/**
 * Depth of repository analysis.
 *
 * - **1 — cheap metadata.** One bounded directory walk plus manifest and git
 *   reads. Safe to run for every request.
 * - **2 — targeted.** Reads a selected subset of files, gathers dependencies,
 *   test presence and diagnostics, and estimates context. Run when the task
 *   spans more than a trivial edit.
 * - **3 — deep.** Builds an import graph to measure dependency fan-out. Run
 *   only when scope or uncertainty justifies it.
 */
export const ANALYSIS_LEVELS = [1, 2, 3] as const;

/** Depth of repository analysis. */
export type AnalysisLevel = (typeof ANALYSIS_LEVELS)[number];

/** One file seen during the inventory walk. */
export interface InventoryFile {
  /** Workspace-relative path, using forward slashes. */
  readonly path: string;
  readonly bytes: number;
  /** Detected language id, or null when the extension is unrecognised. */
  readonly language: string | null;
  /** Whether the path matches a test-file convention. */
  readonly isTest: boolean;
}

/**
 * The result of one bounded directory walk.
 *
 * Cached and shared by every analysis level. This is the artefact that makes
 * "do not rescan" achievable: levels 2 and 3 query it rather than touching the
 * filesystem again.
 */
export interface FileInventory {
  readonly files: readonly InventoryFile[];
  /** Directories visited, for cost accounting. */
  readonly directoriesScanned: number;
  /**
   * Whether the walk hit its file cap and stopped early.
   *
   * A truncated inventory is reported as truncated. Level 1 must stay cheap on
   * a huge repository, and it is better to say the count is a lower bound than
   * to spend a minute walking `node_modules`.
   */
  readonly truncated: boolean;
}

/** Share of the repository written in one language. */
export interface LanguageBreakdown {
  readonly language: string;
  readonly fileCount: number;
  readonly bytes: number;
  /** Share of counted bytes, in [0, 1]. */
  readonly share: number;
}

/** Level 1 — cheap metadata, safe for every request. */
export interface Level1Facts {
  /** Absolute workspace root. */
  readonly root: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** True when {@link FileInventory.truncated}; counts are then lower bounds. */
  readonly truncated: boolean;
  readonly languages: readonly LanguageBreakdown[];
  readonly primaryLanguage: string | null;
  readonly packageManager: string | null;
  /** Detected frameworks, from manifest dependencies. Ordered, may be empty. */
  readonly frameworks: readonly string[];
  readonly isMonorepo: boolean;
  /** Number of nested workspace manifests found. */
  readonly workspaceCount: number;
  readonly hasContinuousIntegration: boolean;
  readonly git: GitState;
  /** Mirrors `git.changedFiles`: null when the status query could not be read. */
  readonly changedFiles: readonly ChangedFile[] | null;
}

/** A dependency declared by a manifest. */
export interface DeclaredDependency {
  readonly name: string;
  /** Declared version range, when the manifest states one. */
  readonly version?: string | undefined;
  readonly development: boolean;
}

/** What is known about the repository's tests. */
export interface TestFacts {
  readonly hasTests: boolean;
  readonly testFileCount: number;
  /** Test files as a share of source files, in [0, 1]. */
  readonly testFileRatio: number;
  /** Detected test frameworks, from manifest dependencies. */
  readonly frameworks: readonly string[];
}

/**
 * What is known about diagnostics.
 *
 * `observed` distinguishes "a diagnostics source reported no problems" from
 * "no diagnostics source is connected". Treating the second as the first would
 * let the router conclude a broken repository is healthy.
 */
export interface DiagnosticFacts {
  readonly observed: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  /** Distinct files carrying at least one diagnostic. */
  readonly affectedFiles: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Level 2 — targeted analysis, run when the task needs more than metadata. */
export interface Level2Facts {
  /** Files judged relevant to the task, most relevant first. */
  readonly relevantFiles: readonly InventoryFile[];
  readonly dependencies: readonly DeclaredDependency[];
  /** Direct dependency count, a cheap proxy for project surface area. */
  readonly dependencyCount: number;
  readonly tests: TestFacts;
  readonly diagnostics: DiagnosticFacts;
  /** Estimated tokens needed to give a model the relevant files. */
  readonly estimatedContextTokens: number;
  /** Modules (top-level directories) the changed files touch. */
  readonly affectedModules: readonly string[];
}

/** An edge in the approximate import graph. */
export interface ImportEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * Level 3 — deep analysis.
 *
 * The import graph is built by scanning import and require statements
 * textually. That is an **approximation**, not an AST or a language server: it
 * resolves relative imports only, and it will miss dynamic and generated ones.
 * It is labelled `approximate` so no consumer mistakes it for ground truth.
 * Swapping in Tree-sitter or LSP later changes this implementation, not this
 * interface.
 */
export interface Level3Facts {
  readonly approximate: true;
  readonly edges: readonly ImportEdge[];
  /** Files that import the most other files. */
  readonly maxFanOut: number;
  /** Files most depended upon — changing these is riskiest. */
  readonly maxFanIn: number;
  /** Mean outgoing edges per file that has any. */
  readonly averageFanOut: number;
  /** Files with no resolved imports either way. */
  readonly isolatedFileCount: number;
}

/** The accumulated result of analysing a repository. */
export interface RepositorySnapshot {
  readonly root: string;
  /** Highest level actually computed. */
  readonly level: AnalysisLevel;
  readonly level1: Level1Facts;
  readonly level2?: Level2Facts | undefined;
  readonly level3?: Level3Facts | undefined;
  /** Milliseconds since the epoch at which this snapshot was produced. */
  readonly analyzedAt: number;
  /** How much of this snapshot was served from cache. */
  readonly cache: CacheReport;
}

/**
 * What the cache did for one analysis call.
 *
 * Exposed so the "do not rescan" requirement is observable in production, not
 * only in tests.
 */
export interface CacheReport {
  /** True when nothing had to be recomputed. */
  readonly hit: boolean;
  /** Levels served from cache. */
  readonly reusedLevels: readonly AnalysisLevel[];
  /** Levels recomputed. */
  readonly computedLevels: readonly AnalysisLevel[];
  /** Whether the cached file inventory was reused. */
  readonly reusedInventory: boolean;
  /** Why anything was invalidated. Empty on a clean hit. */
  readonly invalidatedBy: readonly string[];
}
