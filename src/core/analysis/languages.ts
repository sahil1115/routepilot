/**
 * Language, framework, package-manager and test detection tables.
 *
 * These are lookup tables, not logic. They are data so they can be extended
 * without touching the analyzer, and so the analyzer stays readable.
 */

/** Extension (without dot) to language id. */
const EXTENSION_LANGUAGES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    pyi: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    scala: 'scala',
    cs: 'csharp',
    fs: 'fsharp',
    php: 'php',
    swift: 'swift',
    m: 'objective-c',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    ps1: 'powershell',
    sql: 'sql',
    html: 'html',
    css: 'css',
    scss: 'css',
    less: 'css',
    vue: 'vue',
    svelte: 'svelte',
    dart: 'dart',
    ex: 'elixir',
    exs: 'elixir',
    erl: 'erlang',
    hs: 'haskell',
    lua: 'lua',
    r: 'r',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    mdx: 'markdown',
  }),
);

/**
 * Languages that count as source when picking a primary language.
 *
 * Configuration and documentation are inventoried but must not win: a
 * TypeScript repository with a large `docs/` folder is still a TypeScript
 * repository.
 */
const NON_SOURCE_LANGUAGES: ReadonlySet<string> = new Set([
  'json',
  'yaml',
  'toml',
  'markdown',
  'html',
  'css',
]);

/** Directories never worth walking. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.idea',
  '.vscode',
  'Pods',
  '.terraform',
]);

/** Lockfile or manifest to package manager. */
const PACKAGE_MANAGER_MARKERS: readonly (readonly [string, string])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['poetry.lock', 'poetry'],
  ['uv.lock', 'uv'],
  ['Pipfile.lock', 'pipenv'],
  ['requirements.txt', 'pip'],
  ['Cargo.lock', 'cargo'],
  ['go.sum', 'go'],
  ['Gemfile.lock', 'bundler'],
  ['composer.lock', 'composer'],
  ['pom.xml', 'maven'],
  ['build.gradle', 'gradle'],
  ['build.gradle.kts', 'gradle'],
];

/** Files that mark a monorepo. */
export const MONOREPO_MARKERS: readonly string[] = [
  'pnpm-workspace.yaml',
  'lerna.json',
  'turbo.json',
  'nx.json',
  'rush.json',
];

/** Directories that hold continuous-integration configuration. */
export const CI_MARKERS: readonly string[] = [
  '.github/workflows',
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  'Jenkinsfile',
  '.travis.yml',
  'buildkite.yml',
];

/** Dependency name to framework id. Matched against declared dependencies. */
const FRAMEWORK_DEPENDENCIES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    react: 'react',
    'react-dom': 'react',
    next: 'nextjs',
    vue: 'vue',
    nuxt: 'nuxt',
    svelte: 'svelte',
    '@angular/core': 'angular',
    express: 'express',
    fastify: 'fastify',
    '@nestjs/core': 'nestjs',
    koa: 'koa',
    django: 'django',
    flask: 'flask',
    fastapi: 'fastapi',
    'apache-airflow': 'airflow',
    pandas: 'pandas',
    numpy: 'numpy',
    torch: 'pytorch',
    tensorflow: 'tensorflow',
    rails: 'rails',
    sinatra: 'sinatra',
    gin: 'gin',
    actix: 'actix',
    axum: 'axum',
    'spring-boot': 'spring',
  }),
);

/** Dependency name to test framework id. */
const TEST_FRAMEWORK_DEPENDENCIES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    vitest: 'vitest',
    jest: 'jest',
    mocha: 'mocha',
    jasmine: 'jasmine',
    ava: 'ava',
    tap: 'tap',
    '@playwright/test': 'playwright',
    cypress: 'cypress',
    pytest: 'pytest',
    nose2: 'nose2',
    unittest2: 'unittest',
    rspec: 'rspec',
    minitest: 'minitest',
    phpunit: 'phpunit',
    junit: 'junit',
  }),
);

/** Path patterns that mark a test file. */
const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)tests?\//i,
  /(^|\/)__tests__\//,
  /(^|\/)spec\//i,
  /\.test\.[a-z]+$/i,
  /\.spec\.[a-z]+$/i,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.[a-z]+$/i,
  /Test[s]?\.(java|kt|cs)$/,
];

/** Detect a language from a file path. Returns null when unrecognised. */
export function detectLanguage(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXTENSION_LANGUAGES.get(base.slice(dot + 1).toLowerCase()) ?? null;
}

/** Whether a language counts towards choosing the repository's primary language. */
export function isSourceLanguage(language: string): boolean {
  return !NON_SOURCE_LANGUAGES.has(language);
}

/** Whether a path looks like a test file. */
export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** Package manager implied by a set of root file names, or null. */
export function detectPackageManager(rootFileNames: ReadonlySet<string>): string | null {
  for (const [marker, manager] of PACKAGE_MANAGER_MARKERS) {
    if (rootFileNames.has(marker)) return manager;
  }
  return null;
}

/** Frameworks implied by declared dependency names, ordered and deduplicated. */
export function detectFrameworks(dependencyNames: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of dependencyNames) {
    const framework = FRAMEWORK_DEPENDENCIES.get(name.toLowerCase());
    if (framework !== undefined) found.add(framework);
  }
  return [...found].sort();
}

/** Test frameworks implied by declared dependency names. */
export function detectTestFrameworks(dependencyNames: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of dependencyNames) {
    const framework = TEST_FRAMEWORK_DEPENDENCIES.get(name.toLowerCase());
    if (framework !== undefined) found.add(framework);
  }
  return [...found].sort();
}
