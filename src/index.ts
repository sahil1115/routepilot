/**
 * RoutePilot — "Choose the cheapest path to success."
 *
 * Public entry point. Exposes the domain model, the registries, the
 * configuration layer, repository analysis and the routing engine. Agent
 * adapters, the execution monitor, telemetry and learning arrive in later
 * phases — see docs/ROADMAP.md.
 */

export * from './core/index.js';
export * from './config/index.js';

/** Stable package identifier used by adapters, CLI and telemetry records. */
export const PRODUCT_ID = 'routepilot' as const;

/** Human-readable product name. */
export const PRODUCT_NAME = 'RoutePilot' as const;

/** Product tagline. */
export const TAGLINE = 'Choose the cheapest path to success.' as const;

/**
 * Released version of this build.
 *
 * Kept in step with `package.json` by a test, rather than read from it at
 * runtime: the published bundle does not ship its manifest, and a version that
 * silently became "unknown" in the artefact people actually install would be
 * worse than one that cannot drift.
 *
 * 0.x rather than 1.0.0 deliberately. The routing pipeline is complete and
 * tested, but no agent adapter has been verified against its real tool, so
 * nothing here has run against a real model. A major version would claim a
 * stability this has not earned.
 */
export const VERSION = '0.2.2' as const;

/**
 * Implementation phase actually present in this build.
 *
 * A factual marker of what has been implemented and validated, not a roadmap
 * aspiration. Bumped only when a phase is complete and its gates pass.
 *
 * Kept honest by a test rather than by discipline: it silently drifted three
 * times across earlier phases, because nothing failed when it was forgotten.
 * `index.test.ts` now checks it against the highest phase `docs/ROADMAP.md`
 * marks complete.
 */
export const IMPLEMENTED_PHASE = 24 as const;

/** Describes what this build actually contains. */
export interface BuildInfo {
  readonly productId: typeof PRODUCT_ID;
  readonly productName: typeof PRODUCT_NAME;
  readonly version: string;
  readonly implementedPhase: number;
}

/** Returns a factual description of the current build. */
export function getBuildInfo(): BuildInfo {
  return {
    productId: PRODUCT_ID,
    productName: PRODUCT_NAME,
    version: VERSION,
    implementedPhase: IMPLEMENTED_PHASE,
  };
}
