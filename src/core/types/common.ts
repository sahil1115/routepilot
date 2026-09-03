/**
 * Shared primitive vocabulary for the RoutePilot domain model.
 *
 * Nothing in `src/core` may reference a specific vendor, product or model name.
 * Model identities arrive exclusively through configuration.
 */

/**
 * A score constrained to the closed interval [0, 1].
 *
 * This is a documentation alias, not a branded type — validation is enforced at
 * the configuration boundary (see `src/config/schema.ts`).
 */
export type UnitInterval = number;

/** Operational availability of a model or provider. */
export const AVAILABILITY_STATES = ['available', 'degraded', 'unavailable'] as const;

/** Operational availability of a model or provider. */
export type Availability = (typeof AVAILABILITY_STATES)[number];

/**
 * Whether an availability state permits selection at all.
 *
 * `degraded` remains selectable — it is a signal for the routing engine to
 * penalise a candidate, not a hard exclusion. Only `unavailable` is a hard
 * exclusion (spec section 12).
 */
export function isSelectable(availability: Availability): boolean {
  return availability !== 'unavailable';
}
