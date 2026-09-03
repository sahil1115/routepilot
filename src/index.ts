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
export const IMPLEMENTED_PHASE = 23 as const;

/** Describes what this build actually contains. */
export interface BuildInfo {
  readonly productId: typeof PRODUCT_ID;
  readonly productName: typeof PRODUCT_NAME;
  readonly implementedPhase: number;
}

/** Returns a factual description of the current build. */
export function getBuildInfo(): BuildInfo {
  return {
    productId: PRODUCT_ID,
    productName: PRODUCT_NAME,
    implementedPhase: IMPLEMENTED_PHASE,
  };
}
