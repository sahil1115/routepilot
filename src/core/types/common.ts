/**
 * Shared primitive vocabulary for the RoutePilot domain model.
 *
 * Nothing in `src/core` may reference a specific vendor, product or model name.
 * Model identities arrive exclusively through configuration.
 */

/**
 * A score in [0, 1]. A documentation alias, not a branded type; validation
 * happens at the configuration boundary (`src/config/schema.ts`).
 */
export type UnitInterval = number;

/** Operational availability of a model or provider. */
export const AVAILABILITY_STATES = ['available', 'degraded', 'unavailable'] as const;

/** Operational availability of a model or provider. */
export type Availability = (typeof AVAILABILITY_STATES)[number];

/**
 * Whether an availability state permits selection. `degraded` stays selectable
 * and is penalised by the routing engine; only `unavailable` excludes
 * (spec section 12).
 */
export function isSelectable(availability: Availability): boolean {
  return availability !== 'unavailable';
}
