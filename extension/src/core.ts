/**
 * Loading the RoutePilot core from a CommonJS extension.
 *
 * The core is ESM ("type": "module"); the VS Code extension host loads
 * extensions as CommonJS. A CommonJS module cannot require() an ES module, so
 * the bridge is a dynamic import() -- which Node supports from CommonJS, and
 * which TypeScript preserves under `module: Node16` rather than downlevelling
 * into a `require` that would fail at runtime.
 *
 * The core is loaded from `extension/dist/`, the extension's **own copy**,
 * populated by `npm run build:extension`. Reaching up into the repository would
 * work on a developer's machine and fail for everyone who installs the `.vsix`,
 * because a `.vsix` is a self-contained archive.
 *
 * The imports are **typed against the real build**, not against a hand-written
 * interface. An interface describing the core loosely would compile happily
 * while drifting out of step with it, and the drift would only show up as a
 * runtime failure inside an extension host that cannot be tested here -- the
 * one place a mistake is most expensive. Pointing at `dist/` means a signature
 * change in the core breaks this file at compile time instead.
 *
 * The import is lazy and cached: activation cost is charged to the user's
 * window start-up, and an extension that routes nothing until asked has no
 * business spending it.
 *
 * Each `typeof import(...)` carries an inline `resolution-mode` attribute.
 * Without it a CommonJS file cannot describe the shape of an ES module at all
 * (`TS1542`), and TypeScript does not accept the attribute through a type
 * alias. Nothing here is emitted; it only tells the compiler to resolve `dist/`
 * the way Node will at runtime.
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
