/**
 * RoutePilot's provider-neutral core.
 *
 * Nothing under `src/core` may import from `src/adapters`, `src/cli`,
 * `src/config`, `src/extension`, `src/infra`, `src/telemetry` or
 * `src/learning`. Those layers depend inward on this one. That rule is what
 * keeps the router provider-neutral (spec section 2).
 */

export * from './types/index.js';
export * from './registry/index.js';
export * from './analysis/index.js';
export * from './routing/index.js';
export * from './execution/index.js';
export * from './escalation/index.js';
export * from './outcome/index.js';
export * from './pricing.js';
export * from './ports.js';
