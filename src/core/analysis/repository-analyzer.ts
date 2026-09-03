/**
 * Progressive repository analyzer (spec section 10).
 *
 * Three rules govern this file:
 *
 * 1. **Cheap by default.** Level 1 is one bounded walk. It is safe to run for
 *    every request, including "explain this function".
 * 2. **Never rescan unnecessarily.** One file inventory is cached and shared by
 *    all three levels. Reaching level 2 after level 1 does no filesystem work
 *    twice, and an unchanged repository does none at all.
 * 3. **Invalidate incrementally.** A one-line edit invalidates the git-derived
 *    facts, not the language breakdown of a 20,000-file repository.
 */

import {
  NullDiagnosticsPort,
  systemClock,
  type Clock,
  type DiagnosticsPort,
  type FileSystemPort,
  type GitPort,
  type GitState,
} from '../ports.js';
import type {
  AnalysisLevel,
  CacheReport,
  DeclaredDependency,
  DiagnosticFacts,
  FileInventory,
  InventoryFile,
  LanguageBreakdown,
  Level1Facts,
  Level2Facts,
  Level3Facts,
  RepositorySnapshot,
  TestFacts,
} from '../types/analysis.js';
import { AnalysisCache, type CachedAnalysis } from './cache.js';
import { computeFingerprint, diffFingerprints } from './fingerprint.js';
import {
  CI_MARKERS,
  IGNORED_DIRECTORIES,
  MONOREPO_MARKERS,
  detectFrameworks,
  detectLanguage,
  detectPackageManager,
  detectTestFrameworks,
  isSourceLanguage,
  isTestPath,
} from './languages.js';
import { estimateTokensFromBytes } from './tokens.js';
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from '../perf/concurrency.js';

/** Options for {@link RepositoryAnalyzer}. */
export interface RepositoryAnalyzerOptions {
  readonly fs: FileSystemPort;
  readonly git: GitPort;
  readonly diagnostics?: DiagnosticsPort | undefined;
  readonly clock?: Clock | undefined;
  readonly cache?: AnalysisCache | undefined;
  /**
   * Maximum files inventoried in one walk.
   *
   * A bound is what keeps level 1 cheap on a very large repository. Exceeding
   * it is reported as `truncated` rather than silently producing wrong counts.
   */
  readonly maxFiles?: number | undefined;
  /** Maximum directory depth walked. */
  readonly maxDepth?: number | undefined;
  /** Maximum bytes read per file during level 2 and 3. */
  readonly maxFileBytes?: number | undefined;
}

/** A request to analyse a repository. */
export interface AnalysisRequest {
  /** Absolute workspace root. */
  readonly root: string;
  /** How deep to go. */
  readonly level: AnalysisLevel;
  /** Files the task refers to, used to select relevant files at level 2. */
  readonly referencedFiles?: readonly string[] | undefined;
  /** The file the user is working in. */
  readonly activeFile?: string | undefined;
  /**
   * Version-control state already read by the caller.
   *
   * Reading it costs one `git` subprocess, which benchmarks put at 200-700 ms
   * — an order of magnitude more than everything else in a routing pass
   * combined. A caller that analyses the same workspace twice in one pass (as
   * `analyzeTask` does: level 1 to classify, then deeper) should read it once
   * and pass it to both, rather than paying twice for an answer that cannot
   * have changed in between.
   *
   * Absent means the analyzer reads it itself, which is correct and is what a
   * single analysis should do.
   */
  readonly gitState?: GitState | undefined;
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const RELEVANT_FILE_LIMIT = 40;

/** Analyses a workspace progressively, caching aggressively. */
export class RepositoryAnalyzer {
  readonly #fs: FileSystemPort;
  readonly #git: GitPort;
  readonly #diagnostics: DiagnosticsPort;
  readonly #clock: Clock;
  readonly #cache: AnalysisCache;
  readonly #maxFiles: number;
  readonly #maxDepth: number;
  readonly #maxFileBytes: number;

  constructor(options: RepositoryAnalyzerOptions) {
    this.#fs = options.fs;
    this.#git = options.git;
    this.#diagnostics = options.diagnostics ?? new NullDiagnosticsPort();
    this.#clock = options.clock ?? systemClock;
    this.#cache = options.cache ?? new AnalysisCache();
    this.#maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.#maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /** The cache, exposed so a host can clear or inspect it. */
  get cache(): AnalysisCache {
    return this.#cache;
  }

  /**
   * Analyse a repository to the requested level.
   *
   * Levels below the requested one are always available on the result, because
   * they are prerequisites. Requesting a level lower than one already cached
   * costs nothing and returns the deeper facts too — throwing away work that
   * has already been paid for would be the opposite of the goal.
   */
  async analyze(request: AnalysisRequest): Promise<RepositorySnapshot> {
    const { root } = request;

    // One git call, reused for both the fingerprint and level 1 — or none at
    // all when the caller already has the answer.
    const git = request.gitState ?? (await this.#git.getState(root));
    const fingerprint = await computeFingerprint(root, git, this.#fs);

    const cached = this.#cache.get(root);
    const diff = diffFingerprints(cached?.fingerprint, fingerprint);

    const surviving = carryForward(cached, diff);
    const reusedLevels: AnalysisLevel[] = [];
    const computedLevels: AnalysisLevel[] = [];

    const inventory = surviving.inventory ?? (await this.#buildInventory(root));
    const reusedInventory = surviving.inventory !== undefined;

    let level1 = surviving.level1;
    if (level1 === undefined) {
      level1 = await this.#buildLevel1(root, inventory, git);
      computedLevels.push(1);
    } else {
      // Git facts are cheap and always fresh; only the expensive parts are cached.
      level1 = { ...level1, git, changedFiles: git.changedFiles };
      reusedLevels.push(1);
    }

    let level2 = surviving.level2;
    if (request.level >= 2) {
      if (level2 === undefined) {
        level2 = await this.#buildLevel2(root, inventory, level1, request);
        computedLevels.push(2);
      } else {
        reusedLevels.push(2);
      }
    }

    let level3 = surviving.level3;
    if (request.level >= 3) {
      if (level3 === undefined) {
        level3 = await this.#buildLevel3(root, inventory);
        computedLevels.push(3);
      } else {
        reusedLevels.push(3);
      }
    }

    this.#cache.set(root, {
      fingerprint,
      inventory,
      level1,
      ...(level2 === undefined ? {} : { level2 }),
      ...(level3 === undefined ? {} : { level3 }),
    });

    const report: CacheReport = {
      hit: computedLevels.length === 0 && reusedInventory,
      reusedLevels,
      computedLevels,
      reusedInventory,
      invalidatedBy: computedLevels.length === 0 ? [] : diff.reasons,
    };

    return {
      root,
      level: request.level,
      level1,
      ...(level2 === undefined ? {} : { level2 }),
      ...(level3 === undefined ? {} : { level3 }),
      analyzedAt: this.#clock.now(),
      cache: report,
    };
  }

  /** One bounded, breadth-limited walk. The only place the tree is traversed. */
  async #buildInventory(root: string): Promise<FileInventory> {
    const files: InventoryFile[] = [];
    let directoriesScanned = 0;
    let truncated = false;

    const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (current.depth > this.#maxDepth) continue;

      directoriesScanned += 1;
      const entries = await this.#fs.readDirectory(current.path);

      // Two passes over the directory: queue subdirectories, collect the file
      // paths, and only then stat them. Statting inside the loop serialised the
      // whole walk — measured five times slower on this repository, and worse
      // on anything larger.
      const pending: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory) {
          if (IGNORED_DIRECTORIES.has(entry.name)) continue;
          queue.push({ path: `${current.path}/${entry.name}`, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile) continue;

        if (files.length + pending.length >= this.#maxFiles) {
          truncated = true;
          break;
        }

        pending.push(`${current.path}/${entry.name}`);
      }

      const stats = await mapWithConcurrency(pending, DEFAULT_CONCURRENCY, (absolute) =>
        this.#fs.stat(absolute),
      );

      for (const [index, absolute] of pending.entries()) {
        const relative = toRelative(root, absolute);
        files.push({
          path: relative,
          bytes: stats[index]?.size ?? 0,
          language: detectLanguage(relative),
          isTest: isTestPath(relative),
        });
      }

      if (truncated) break;
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, directoriesScanned, truncated };
  }

  async #buildLevel1(root: string, inventory: FileInventory, git: GitState): Promise<Level1Facts> {
    const languages = summariseLanguages(inventory.files);
    const rootFileNames = new Set(
      inventory.files.filter((f) => !f.path.includes('/')).map((f) => f.path),
    );

    const manifest = await this.#readRootManifest(root);
    const workspaceCount = countWorkspaceManifests(inventory.files);

    return {
      root,
      fileCount: inventory.files.length,
      totalBytes: inventory.files.reduce((sum, f) => sum + f.bytes, 0),
      truncated: inventory.truncated,
      languages,
      primaryLanguage: pickPrimaryLanguage(languages),
      packageManager: detectPackageManager(rootFileNames),
      frameworks: detectFrameworks(manifest.dependencyNames),
      isMonorepo:
        manifest.hasWorkspaces ||
        workspaceCount > 0 ||
        MONOREPO_MARKERS.some((marker) => rootFileNames.has(marker)),
      workspaceCount,
      hasContinuousIntegration: hasCiConfiguration(inventory.files),
      git,
      changedFiles: git.changedFiles,
    };
  }

  async #buildLevel2(
    root: string,
    inventory: FileInventory,
    level1: Level1Facts,
    request: AnalysisRequest,
  ): Promise<Level2Facts> {
    const manifest = await this.#readRootManifest(root);
    const relevantFiles = selectRelevantFiles(inventory, level1, request);
    const testFiles = inventory.files.filter((f) => f.isTest);
    const sourceFiles = inventory.files.filter(
      (f) => f.language !== null && isSourceLanguage(f.language),
    );

    const tests: TestFacts = {
      hasTests: testFiles.length > 0,
      testFileCount: testFiles.length,
      testFileRatio: sourceFiles.length === 0 ? 0 : testFiles.length / sourceFiles.length,
      frameworks: detectTestFrameworks(manifest.dependencyNames),
    };

    const diagnostics = await this.#collectDiagnostics(root);

    const estimatedContextTokens = relevantFiles.reduce(
      (sum, file) => sum + estimateTokensFromBytes(Math.min(file.bytes, this.#maxFileBytes)),
      0,
    );

    return {
      relevantFiles,
      dependencies: manifest.dependencies,
      dependencyCount: manifest.dependencies.length,
      tests,
      diagnostics,
      estimatedContextTokens,
      affectedModules: deriveAffectedModules((level1.changedFiles ?? []).map((c) => c.path)),
    };
  }

  /**
   * Build an approximate import graph.
   *
   * Reads only source files, only up to a byte cap, and resolves relative
   * imports only. See {@link Level3Facts} for why this is labelled approximate.
   */
  async #buildLevel3(root: string, inventory: FileInventory): Promise<Level3Facts> {
    const sourceFiles = inventory.files.filter(
      (f) => f.language !== null && isSourceLanguage(f.language) && f.bytes <= this.#maxFileBytes,
    );
    const known = new Set(sourceFiles.map((f) => f.path));

    const edges: { from: string; to: string }[] = [];
    const fanOut = new Map<string, number>();
    const fanIn = new Map<string, number>();

    // Read concurrently, then walk the results in order. Sequential reads
    // measured four times slower on this repository and the gap widens with
    // size; keeping the *walk* ordered means the import graph does not depend
    // on which read happened to finish first.
    const contentsByFile = await mapWithConcurrency(sourceFiles, DEFAULT_CONCURRENCY, (file) =>
      this.#fs.readFile(`${root}/${file.path}`),
    );

    for (const [index, file] of sourceFiles.entries()) {
      const contents = contentsByFile[index];
      if (contents === null || contents === undefined) continue;

      for (const specifier of extractRelativeImports(contents)) {
        const target = resolveRelativeImport(file.path, specifier, known);
        if (target === null || target === file.path) continue;
        edges.push({ from: file.path, to: target });
        fanOut.set(file.path, (fanOut.get(file.path) ?? 0) + 1);
        fanIn.set(target, (fanIn.get(target) ?? 0) + 1);
      }
    }

    const fanOutValues = [...fanOut.values()];
    const connected = new Set<string>([...fanOut.keys(), ...fanIn.keys()]);

    return {
      approximate: true,
      edges,
      maxFanOut: fanOutValues.length === 0 ? 0 : Math.max(...fanOutValues),
      maxFanIn: fanIn.size === 0 ? 0 : Math.max(...fanIn.values()),
      averageFanOut:
        fanOutValues.length === 0
          ? 0
          : fanOutValues.reduce((a, b) => a + b, 0) / fanOutValues.length,
      isolatedFileCount: sourceFiles.filter((f) => !connected.has(f.path)).length,
    };
  }

  async #collectDiagnostics(root: string): Promise<DiagnosticFacts> {
    if (!this.#diagnostics.connected) {
      // Not observed. Reported as such rather than as "no problems found".
      return {
        observed: false,
        errorCount: 0,
        warningCount: 0,
        affectedFiles: [],
        diagnostics: [],
      };
    }

    const diagnostics = await this.#diagnostics.getDiagnostics(root);
    return {
      observed: true,
      errorCount: diagnostics.filter((d) => d.severity === 'error').length,
      warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
      affectedFiles: [...new Set(diagnostics.map((d) => d.path))].sort(),
      diagnostics,
    };
  }

  /** Read declared dependencies from whichever root manifest exists. */
  async #readRootManifest(root: string): Promise<ManifestFacts> {
    const packageJson = await this.#fs.readFile(`${root}/package.json`);
    if (packageJson !== null) return parsePackageJson(packageJson);

    const pyproject = await this.#fs.readFile(`${root}/pyproject.toml`);
    if (pyproject !== null) return parsePyproject(pyproject);

    const requirements = await this.#fs.readFile(`${root}/requirements.txt`);
    if (requirements !== null) return parseRequirements(requirements);

    return { dependencies: [], dependencyNames: [], hasWorkspaces: false };
  }
}

/** Dependency facts extracted from a manifest. */
interface ManifestFacts {
  readonly dependencies: readonly DeclaredDependency[];
  readonly dependencyNames: readonly string[];
  readonly hasWorkspaces: boolean;
}

/** Decide which cached layers survive a fingerprint change. */
function carryForward(
  cached: CachedAnalysis | undefined,
  diff: ReturnType<typeof diffFingerprints>,
): {
  inventory?: FileInventory | undefined;
  level1?: Level1Facts | undefined;
  level2?: Level2Facts | undefined;
  level3?: Level3Facts | undefined;
} {
  if (cached === undefined) return {};
  if (diff.unchanged) {
    return {
      inventory: cached.inventory,
      level1: cached.level1,
      level2: cached.level2,
      level3: cached.level3,
    };
  }

  // The file set changed: everything derived from the tree is stale.
  if (diff.fileSetChanged) return {};

  // Only modifications to existing files, or manifest edits. The inventory —
  // the expensive artefact — is still correct, because no file appeared or
  // disappeared.
  const level1 = diff.manifestsChanged ? undefined : cached.level1;

  return {
    inventory: cached.inventory,
    level1,
    // Level 2 covers dependencies and file contents, both potentially stale.
    level2: undefined,
    // The import graph depends on file contents, which just changed.
    level3: undefined,
  };
}

function summariseLanguages(files: readonly InventoryFile[]): LanguageBreakdown[] {
  const counts = new Map<string, { fileCount: number; bytes: number }>();

  for (const file of files) {
    if (file.language === null) continue;
    const entry = counts.get(file.language) ?? { fileCount: 0, bytes: 0 };
    entry.fileCount += 1;
    entry.bytes += file.bytes;
    counts.set(file.language, entry);
  }

  const totalBytes = [...counts.values()].reduce((sum, entry) => sum + entry.bytes, 0);

  return [...counts.entries()]
    .map(([language, entry]) => ({
      language,
      fileCount: entry.fileCount,
      bytes: entry.bytes,
      share: totalBytes === 0 ? 0 : entry.bytes / totalBytes,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.language.localeCompare(b.language));
}

/** The largest source language wins; configuration and docs cannot. */
function pickPrimaryLanguage(languages: readonly LanguageBreakdown[]): string | null {
  return languages.find((entry) => isSourceLanguage(entry.language))?.language ?? null;
}

function countWorkspaceManifests(files: readonly InventoryFile[]): number {
  return files.filter((file) => {
    if (!file.path.endsWith('/package.json')) return false;
    const depth = file.path.split('/').length;
    // packages/foo/package.json — nested, but not buried arbitrarily deep.
    return depth >= 2 && depth <= 4;
  }).length;
}

function hasCiConfiguration(files: readonly InventoryFile[]): boolean {
  return files.some((file) => CI_MARKERS.some((marker) => file.path.startsWith(marker)));
}

/**
 * Choose the files worth putting in front of a model.
 *
 * Explicitly referenced files come first, then the active file, then changed
 * files, then the largest source files. Bounded, because "relevant" must not
 * mean "everything".
 */
function selectRelevantFiles(
  inventory: FileInventory,
  level1: Level1Facts,
  request: AnalysisRequest,
): InventoryFile[] {
  const byPath = new Map(inventory.files.map((file) => [file.path, file]));
  const selected = new Map<string, InventoryFile>();

  const take = (path: string): void => {
    const file = byPath.get(normalise(path));
    if (file !== undefined && !selected.has(file.path)) selected.set(file.path, file);
  };

  for (const path of request.referencedFiles ?? []) take(path);
  if (request.activeFile !== undefined) take(request.activeFile);
  for (const changed of level1.changedFiles ?? []) take(changed.path);

  if (selected.size < RELEVANT_FILE_LIMIT) {
    const remaining = inventory.files
      .filter(
        (file) =>
          !selected.has(file.path) &&
          file.language !== null &&
          isSourceLanguage(file.language) &&
          !file.isTest,
      )
      .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

    for (const file of remaining) {
      if (selected.size >= RELEVANT_FILE_LIMIT) break;
      selected.set(file.path, file);
    }
  }

  return [...selected.values()].slice(0, RELEVANT_FILE_LIMIT);
}

/** Top-level directories the changed files touch. */
function deriveAffectedModules(changedPaths: readonly string[]): string[] {
  const modules = new Set<string>();
  for (const path of changedPaths) {
    const slash = path.indexOf('/');
    modules.add(slash === -1 ? '.' : path.slice(0, slash));
  }
  return [...modules].sort();
}

function parsePackageJson(contents: string): ManifestFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // A malformed manifest is a repository problem, not an analyzer crash.
    return { dependencies: [], dependencyNames: [], hasWorkspaces: false };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { dependencies: [], dependencyNames: [], hasWorkspaces: false };
  }

  const record = parsed as Record<string, unknown>;
  const dependencies: DeclaredDependency[] = [];

  for (const [key, development] of [
    ['dependencies', false],
    ['devDependencies', true],
    ['peerDependencies', false],
  ] as const) {
    const section = record[key];
    if (typeof section !== 'object' || section === null) continue;
    for (const [name, version] of Object.entries(section as Record<string, unknown>)) {
      dependencies.push({
        name,
        development,
        ...(typeof version === 'string' ? { version } : {}),
      });
    }
  }

  return {
    dependencies,
    dependencyNames: dependencies.map((d) => d.name),
    hasWorkspaces: record['workspaces'] !== undefined,
  };
}

function parsePyproject(contents: string): ManifestFacts {
  // Deliberately not a TOML parser: dependency *names* are all that is needed,
  // and adding a TOML dependency for this would not be justified.
  const dependencies: DeclaredDependency[] = [];
  for (const match of contents.matchAll(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[=>~<]{1,2}/gm)) {
    const name = match[1];
    if (name !== undefined && !RESERVED_TOML_KEYS.has(name.toLowerCase())) {
      dependencies.push({ name, development: false });
    }
  }
  return {
    dependencies,
    dependencyNames: dependencies.map((d) => d.name),
    hasWorkspaces: /\[tool\.(uv\.)?workspace\]/.test(contents),
  };
}

const RESERVED_TOML_KEYS: ReadonlySet<string> = new Set([
  'name',
  'version',
  'description',
  'readme',
  'requires-python',
  'license',
  'authors',
  'classifiers',
  'keywords',
  'dependencies',
  'requires',
  'build-backend',
]);

function parseRequirements(contents: string): ManifestFacts {
  const dependencies: DeclaredDependency[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    const match = /^([A-Za-z0-9_.-]+)/.exec(trimmed);
    if (match?.[1] !== undefined) dependencies.push({ name: match[1], development: false });
  }
  return {
    dependencies,
    dependencyNames: dependencies.map((d) => d.name),
    hasWorkspaces: false,
  };
}

/** Import specifiers that start with `.`, across the common syntaxes. */
function extractRelativeImports(contents: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+['"](\.[^'"]*)['"]/g,
    /\bimport\s+['"](\.[^'"]*)['"]/g,
    /\brequire\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g,
    /\bimport\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g,
    /^\s*from\s+(\.[A-Za-z0-9_.]*)\s+import\b/gm,
  ];

  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** Resolve a relative specifier against the known file set. */
function resolveRelativeImport(
  fromPath: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | null {
  const fromDirectory = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';

  // Python-style `from .module import x`.
  const base =
    specifier.startsWith('./') || specifier.startsWith('../')
      ? normalisePath(`${fromDirectory}/${specifier}`)
      : normalisePath(`${fromDirectory}/${specifier.replace(/^\.+/, '').replace(/\./g, '/')}`);

  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.py`,
    `${base}/index.ts`,
    `${base}/index.js`,
    `${base}/__init__.py`,
  ];

  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/** Collapse `.` and `..` segments. */
function normalisePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function toRelative(root: string, absolute: string): string {
  const normalisedRoot = normalise(root).replace(/\/$/, '');
  const normalisedAbsolute = normalise(absolute);
  return normalisedAbsolute.startsWith(`${normalisedRoot}/`)
    ? normalisedAbsolute.slice(normalisedRoot.length + 1)
    : normalisedAbsolute;
}
