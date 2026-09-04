/**
 * Loading the RoutePilot core from a CommonJS extension.
 *
 * The core is ESM; the VS Code extension host loads extensions as CommonJS, and
 * CommonJS cannot require() an ES module. The bridge is a dynamic import(),
 * which TypeScript preserves under `module: Node16` rather than downlevelling
 * into a `require` that would fail at runtime.
 *
 * The core is loaded from `extension/dist/`, the extension's own copy, built by
 * `npm run build:extension`. Reaching up into the repository would work on a
 * developer machine and fail for anyone installing the `.vsix`, which is a
 * self-contained archive.
 *
 * The imports are typed against that real build rather than a hand-written
 * interface, which would compile happily while drifting out of step and surface
 * only as a runtime failure inside an extension host. Pointing at `dist/` turns
 * a core signature change into a compile error here.
 *
 * The import is lazy and cached, so activation costs the user's window
 * start-up nothing until something is actually routed.
 *
 * Each `typeof import(...)` carries an inline `resolution-mode` attribute:
 * without it a CommonJS file cannot describe an ES module at all (TS1542), and
 * TypeScript does not accept the attribute through a type alias.
 */

/** The core modules this extension uses, as they actually are. */
export type RoutePilotCore = {
  readonly config: typeof import('../dist/config/load.js', {
    with: { 'resolution-mode': 'import' },
  });
  readonly route: typeof import('../dist/cli/route.js', { with: { 'resolution-mode': 'import' } });
  readonly view: typeof import('../dist/extension/index.js', {
    with: { 'resolution-mode': 'import' },
  });
  readonly analyze: typeof import('../dist/cli/analyze.js', {
    with: { 'resolution-mode': 'import' },
  });
  readonly classifier: typeof import('../dist/core/analysis/task-classifier.js', {
    with: { 'resolution-mode': 'import' },
  });
  readonly analyzer: typeof import('../dist/core/analysis/repository-analyzer.js', {
    with: { 'resolution-mode': 'import' },
  });
  readonly fs: typeof import('../dist/infra/node-filesystem.js', {
    with: { 'resolution-mode': 'import' },
  });
  readonly git: typeof import('../dist/infra/node-git.js', {
    with: { 'resolution-mode': 'import' },
  });
  readonly telemetry: typeof import('../dist/telemetry/open.js', {
    with: { 'resolution-mode': 'import' },
  });
};

let cached: Promise<RoutePilotCore> | undefined;

/**
 * Load the core, once.
 *
 * A missing build is reported as a plain message rather than a
 * module-resolution stack trace, because "run npm run build" is the useful
 * thing to say.
 */
export async function loadCore(): Promise<RoutePilotCore> {
  cached ??= (async (): Promise<RoutePilotCore> => {
    try {
      const [config, route, view, analyze, classifier, analyzer, fs, git, telemetry] =
        await Promise.all([
          import('../dist/config/load.js'),
          import('../dist/cli/route.js'),
          import('../dist/extension/index.js'),
          import('../dist/cli/analyze.js'),
          import('../dist/core/analysis/task-classifier.js'),
          import('../dist/core/analysis/repository-analyzer.js'),
          import('../dist/infra/node-filesystem.js'),
          import('../dist/infra/node-git.js'),
          import('../dist/telemetry/open.js'),
        ]);

      return { config, route, view, analyze, classifier, analyzer, fs, git, telemetry };
    } catch (error) {
      // Cleared so a later attempt can succeed once the build exists, rather
      // than caching the failure for the lifetime of the window.
      cached = undefined;
      throw new Error(
        'RoutePilot could not load its core. Run "npm run build" in the RoutePilot ' +
          `repository and reload the window. Cause: ${describe(error)}`,
      );
    }
  })();

  return cached;
}

/** Reset the cache. Used by tests of the shell. */
export function resetCoreCache(): void {
  cached = undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
