/**
 * Repository fixtures.
 *
 * These build **real directories on disk**, not in-memory doubles. Analysis is
 * mostly filesystem behaviour — path separators, nested directories, ignored
 * folders — and an in-memory fake would let Windows-specific path bugs through
 * unnoticed.
 *
 * Excluded from the published build (see tsconfig.build.json).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  ChangedFile,
  Diagnostic,
  DiagnosticsPort,
  DirectoryEntry,
  FileStat,
  FileSystemPort,
  GitPort,
  GitState,
} from '../core/ports.js';

/** A materialised fixture repository. */
export interface FixtureRepo {
  /** Absolute path to the repository root. */
  readonly root: string;
  /** Write or overwrite a file, creating parent directories. */
  write(relativePath: string, contents: string): Promise<void>;
  /** Delete a file. */
  remove(relativePath: string): Promise<void>;
  /** Delete the whole fixture. */
  cleanup(): Promise<void>;
}

/** Create a repository from a path-to-contents map. */
export async function createRepo(files: Record<string, string>): Promise<FixtureRepo> {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-repo-'));

  const write = async (relativePath: string, contents: string): Promise<void> => {
    const absolute = join(root, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  };

  for (const [path, contents] of Object.entries(files)) {
    await write(path, contents);
  }

  return {
    root,
    write,
    remove: async (relativePath) => {
      await rm(join(root, relativePath), { force: true });
    },
    cleanup: async () => {
      // `maxRetries` is Node's documented answer to Windows EBUSY/EPERM on
      // recursive delete: a virus scanner or a lagging handle can hold a file
      // open for a moment after the process that used it has exited. Without
      // it, cleanup fails intermittently once enough test files run in
      // parallel.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

// ---------------------------------------------------------------------------
// The fixture repositories the phase requires
// ---------------------------------------------------------------------------

/** A tiny TypeScript project: a handful of files, no tests. */
export function tinyTypeScriptRepo(): Record<string, string> {
  return {
    'package.json': JSON.stringify(
      {
        name: 'tiny-ts',
        version: '1.0.0',
        dependencies: { express: '^4.19.0' },
        devDependencies: { typescript: '^5.6.0' },
      },
      null,
      2,
    ),
    'package-lock.json': '{}',
    'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
    'src/index.ts': `import { greet } from './greet.js';\n\nconsole.log(greet('world'));\n`,
    'src/greet.ts': `export function greet(name: string): string {\n  return \`hello \${name}\`;\n}\n`,
    'README.md': '# tiny-ts\n',
  };
}

/** A medium Python project with a package, tests and a framework dependency. */
export function mediumPythonRepo(): Record<string, string> {
  const files: Record<string, string> = {
    'pyproject.toml': [
      '[project]',
      'name = "medium-py"',
      'version = "0.1.0"',
      'requires-python = ">=3.11"',
      'dependencies = [',
      '  "fastapi>=0.110",',
      '  "pandas>=2.0",',
      ']',
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
    ].join('\n'),
    'requirements.txt': 'fastapi>=0.110\npandas>=2.0\npytest>=8.0\n',
    'app/__init__.py': '',
    'app/main.py': 'from .routes import router\nfrom .models import User\n',
    'app/routes.py': 'from .models import User\n\ndef router():\n    return User\n',
    'app/models.py': 'class User:\n    pass\n',
    'tests/test_main.py':
      'from app.main import router\n\ndef test_router():\n    assert router()\n',
    'tests/test_models.py': 'from app.models import User\n\ndef test_user():\n    assert User()\n',
    '.github/workflows/ci.yml': 'name: ci\non: [push]\n',
  };

  // Enough modules to be meaningfully larger than the tiny fixture.
  for (let i = 0; i < 12; i += 1) {
    files[`app/service_${String(i)}.py`] = `from .models import User\n\nVALUE = ${String(i)}\n`;
  }
  return files;
}

/** A pnpm-style monorepo with three packages. */
export function monorepoRepo(): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify(
      { name: 'monorepo-root', private: true, workspaces: ['packages/*'] },
      null,
      2,
    ),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'turbo.json': '{ "tasks": {} }',
  };

  for (const name of ['api', 'web', 'shared']) {
    files[`packages/${name}/package.json`] = JSON.stringify({ name: `@mono/${name}` }, null, 2);
    files[`packages/${name}/src/index.ts`] = `export const ${name} = '${name}';\n`;
  }
  return files;
}

/** A TypeScript project that has tests. */
export function repoWithTests(): Record<string, string> {
  return {
    'package.json': JSON.stringify(
      { name: 'tested', devDependencies: { vitest: '^4.0.0' } },
      null,
      2,
    ),
    'src/calc.ts': 'export const add = (a: number, b: number): number => a + b;\n',
    'src/calc.test.ts': "import { add } from './calc.js';\n",
    'src/util.ts': 'export const noop = (): void => undefined;\n',
    'tests/integration.spec.ts': "import { add } from '../src/calc.js';\n",
  };
}

/** The same shape of project, with no tests at all. */
export function repoWithoutTests(): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'untested' }, null, 2),
    'src/calc.ts': 'export const add = (a: number, b: number): number => a + b;\n',
    'src/util.ts': 'export const noop = (): void => undefined;\n',
  };
}

/** A project paired with {@link fakeDiagnostics} to simulate compiler errors. */
export function repoWithDiagnostics(): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'broken' }, null, 2),
    'src/index.ts':
      "import { missing } from './nowhere.js';\n\nexport const x: number = 'not a number';\n",
    'src/other.ts': 'export const y = undefinedIdentifier;\n',
  };
}

/** Diagnostics matching {@link repoWithDiagnostics}. */
export function diagnosticsForBrokenRepo(): Diagnostic[] {
  return [
    {
      path: 'src/index.ts',
      severity: 'error',
      message: "Cannot find module './nowhere.js'",
      line: 1,
      code: 'TS2307',
    },
    {
      path: 'src/index.ts',
      severity: 'error',
      message: "Type 'string' is not assignable to type 'number'",
      line: 3,
      code: 'TS2322',
    },
    {
      path: 'src/other.ts',
      severity: 'error',
      message: "Cannot find name 'undefinedIdentifier'",
      line: 1,
      code: 'TS2304',
    },
    {
      path: 'src/other.ts',
      severity: 'warning',
      message: "'y' is declared but never used",
      line: 1,
      code: 'TS6133',
    },
  ];
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A diagnostics port that reports a fixed list. */
export class FakeDiagnostics implements DiagnosticsPort {
  readonly connected = true;
  #diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[] = []) {
    this.#diagnostics = diagnostics;
  }

  set(diagnostics: readonly Diagnostic[]): void {
    this.#diagnostics = diagnostics;
  }

  getDiagnostics(): Promise<readonly Diagnostic[]> {
    return Promise.resolve(this.#diagnostics);
  }
}

/**
 * A git port whose state the test controls.
 *
 * Used for most analyzer tests so that cache-invalidation behaviour can be
 * driven precisely. `NodeGit` is exercised separately against a real
 * repository.
 */
export class FakeGit implements GitPort {
  #state: GitState;
  /** Number of times state was requested, for cost accounting. */
  calls = 0;

  constructor(state: Partial<GitState> = {}) {
    this.#state = {
      isRepository: true,
      branch: 'main',
      headCommit: 'a'.repeat(40),
      changedFiles: [],
      insertions: 0,
      deletions: 0,
      ...state,
    };
  }

  set(state: Partial<GitState>): void {
    this.#state = { ...this.#state, ...state };
  }

  /** Convenience: replace the changed-file list. */
  setChanged(changedFiles: readonly ChangedFile[]): void {
    this.#state = { ...this.#state, changedFiles };
  }

  getState(): Promise<GitState> {
    this.calls += 1;
    return Promise.resolve(this.#state);
  }
}

/** Counts of the filesystem operations performed. */
export interface FileSystemCounts {
  readDirectory: number;
  stat: number;
  readFile: number;
  /** Sum of all three. */
  total: number;
}

/**
 * Wraps a filesystem port and counts every call.
 *
 * This is what makes "the same repository is not rescanned unnecessarily" an
 * assertion rather than a claim.
 */
export class CountingFileSystem implements FileSystemPort {
  readonly #inner: FileSystemPort;
  #readDirectory = 0;
  #stat = 0;
  #readFile = 0;

  constructor(inner: FileSystemPort) {
    this.#inner = inner;
  }

  get counts(): FileSystemCounts {
    return {
      readDirectory: this.#readDirectory,
      stat: this.#stat,
      readFile: this.#readFile,
      total: this.#readDirectory + this.#stat + this.#readFile,
    };
  }

  reset(): void {
    this.#readDirectory = 0;
    this.#stat = 0;
    this.#readFile = 0;
  }

  readDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    this.#readDirectory += 1;
    return this.#inner.readDirectory(path);
  }

  stat(path: string): Promise<FileStat | null> {
    this.#stat += 1;
    return this.#inner.stat(path);
  }

  readFile(path: string): Promise<string | null> {
    this.#readFile += 1;
    return this.#inner.readFile(path);
  }
}

/** A clock the test advances by hand. */
export class FakeClock {
  #now: number;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}
