/**
 * Ports the core depends on for the outside world.
 *
 * The core defines these interfaces; `src/infra` implements them against Node.
 * The indirection earns its place twice over. Repository analysis must not
 * rescan the same repository unnecessarily, and a port makes filesystem access
 * countable, so that requirement can be asserted rather than assumed. And
 * diagnostics come from an editor or language server, so a port lets the
 * analyzer be written and tested without the core learning anything about
 * VS Code.
 */

/** One entry in a directory listing. */
export interface DirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

/** Metadata for a single file. */
export interface FileStat {
  readonly size: number;
  /** Modification time in milliseconds since the Unix epoch. */
  readonly mtimeMs: number;
}

/**
 * Read-only filesystem access.
 *
 * Read-only on purpose: analysis observes a workspace, it never modifies one.
 */
export interface FileSystemPort {
  /** List a directory. Returns an empty array when the path is unreadable. */
  readDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  /** Stat a path. Returns null when it does not exist or is unreadable. */
  stat(path: string): Promise<FileStat | null>;
  /** Read a UTF-8 file. Returns null when it does not exist or is unreadable. */
  readFile(path: string): Promise<string | null>;
}

/** How a file changed relative to the last commit. */
export const CHANGE_KINDS = ['added', 'modified', 'deleted', 'renamed', 'untracked'] as const;

/** How a file changed relative to the last commit. */
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** One changed file. */
export interface ChangedFile {
  /** Workspace-relative path, using forward slashes. */
  readonly path: string;
  readonly change: ChangeKind;
}

/**
 * Version-control state of a workspace.
 *
 * A workspace that is not a repository is a normal, supported case — it yields
 * `isRepository: false` and no change information, not an error.
 */
export interface GitState {
  readonly isRepository: boolean;
  readonly branch: string | null;
  /** Commit SHA of HEAD, or null on an empty repository. */
  readonly headCommit: string | null;
  /**
   * Files changed in the working tree, or null if the status query failed.
   *
   * Null and `[]` are different facts: `[]` is a clean tree that was actually
   * looked at, null is a tree nobody could read. Reporting the second as the
   * first would tell a caller a repository is clean on the strength of a
   * timeout.
   */
  readonly changedFiles: readonly ChangedFile[] | null;
  /** Lines added across the tracked working tree, or null if not countable. */
  readonly insertions: number | null;
  /** Lines removed across the tracked working tree, or null if not countable. */
  readonly deletions: number | null;
}

/** Version-control queries. */
export interface GitPort {
  /** Read the current state of the workspace at `root`. */
  getState(root: string): Promise<GitState>;
}

/** Severity of a reported diagnostic. */
export const DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'information', 'hint'] as const;

/** Severity of a reported diagnostic. */
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

/** One diagnostic reported by a compiler, linter or language server. */
export interface Diagnostic {
  /** Workspace-relative path, using forward slashes. */
  readonly path: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** 1-indexed line number, when known. */
  readonly line?: number | undefined;
  /** Rule or error code, when known. */
  readonly code?: string | undefined;
}

/**
 * A source of diagnostics.
 *
 * The default implementation reports none. RoutePilot must not claim to know
 * about compiler errors when nothing has told it about any — an empty result
 * from {@link NullDiagnosticsPort} means "not observed", and the analyzer
 * records that distinction rather than treating it as "no errors exist".
 */
export interface DiagnosticsPort {
  getDiagnostics(root: string): Promise<readonly Diagnostic[]>;
  /** Whether this port is actually connected to a diagnostic source. */
  readonly connected: boolean;
}

/** A diagnostics port that knows nothing, and says so. */
export class NullDiagnosticsPort implements DiagnosticsPort {
  readonly connected = false;

  getDiagnostics(): Promise<readonly Diagnostic[]> {
    return Promise.resolve([]);
  }
}

/** A command the validation engine wants run. */
export interface CommandRequest {
  /** Executable name or path. Never a command line. */
  readonly command: string;
  /** Arguments, passed as separate argv entries. */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

/** The outcome of running one command. */
export interface CommandOutcome {
  /**
   * Whether the process started at all.
   *
   * A command that could not be launched is an environment problem, not a
   * failing check, and the two must not be confused.
   */
  readonly started: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Runs validation commands (build, test, lint).
 *
 * A port because the core must not spawn processes itself, and because tests
 * need to script command outcomes without touching a real toolchain.
 * Implementations must never use a shell (spec section 51).
 */
export interface CommandRunnerPort {
  run(request: CommandRequest): Promise<CommandOutcome>;
}

/** A command runner that runs nothing and says so. */
export class NullCommandRunner implements CommandRunnerPort {
  run(): Promise<CommandOutcome> {
    return Promise.resolve({
      started: false,
      exitCode: null,
      stdout: '',
      stderr: 'no command runner is configured',
      timedOut: false,
    });
  }
}

/** Time source, injected so cache-age behaviour is testable. */
export interface Clock {
  now(): number;
}

/** The real clock. */
export const systemClock: Clock = { now: () => Date.now() };
