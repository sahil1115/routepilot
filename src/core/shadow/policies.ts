/**
 * The built-in shadow policies (spec section 42).
 *
 * Section 42 names the comparison set directly: current, candidate,
 * cheapest-first and strongest-first. Three of those are here as standing
 * baselines; "candidate" is whatever a user configures, and is supplied rather
 * than built in.
 *
 * The two naive baselines are the point. RoutePilot's entire justification is
 * that expected-cost routing beats the obvious alternatives, and a claim like
 * that should be measured continuously rather than asserted once in a README.
 * If `cheapest-first` agrees with the live policy 98% of the time, the
 * expected-cost machinery is not earning its keep on this workload and the
 * shadow report will say so.
 */

import type { ShadowPolicySpec } from '../types/shadow.js';

/**
 * Always pick the lowest first-attempt price among viable candidates.
 *
 * The policy most people would write by hand, and the one RoutePilot claims to
 * beat. Divergence from the live policy is where that claim lives.
 */
export const CHEAPEST_FIRST: ShadowPolicySpec = {
  id: 'cheapest-first',
  description: 'Lowest first-attempt price among viable candidates',
  rule: 'cheapest-first',
  learning: 'inherit',
};

/**
 * Always pick the most capable tier among viable candidates.
 *
 * Never wrong about quality, frequently ruinous about cost. The upper bound on
 * spending, and a useful check that the live policy is not quietly converging
 * on it.
 */
export const STRONGEST_FIRST: ShadowPolicySpec = {
  id: 'strongest-first',
  description: 'Highest tier among viable candidates',
  rule: 'strongest-first',
  learning: 'inherit',
};

/**
 * The live selection rule, with learning switched off.
 *
 * Isolates one question: **is learning changing any decisions?** Same limits,
 * same rule, only the success estimates differ. When this agrees with the live
 * policy every time, learning is running and influencing nothing, which is
 * worth knowing before trusting it with anything.
 */
export const PRIORS_ONLY: ShadowPolicySpec = {
  id: 'priors-only',
  description: 'Expected-cost routing on configured priors, ignoring what was learned',
  rule: 'expected-cost',
  learning: 'disabled',
};

/** The standing baselines, in a deterministic order. */
export const DEFAULT_SHADOW_POLICIES: readonly ShadowPolicySpec[] = [
  PRIORS_ONLY,
  CHEAPEST_FIRST,
  STRONGEST_FIRST,
];

/** Ids of the built-in baselines, for configuration validation. */
export const SHADOW_POLICY_IDS = ['priors-only', 'cheapest-first', 'strongest-first'] as const;

/** A built-in baseline id. */
export type ShadowPolicyId = (typeof SHADOW_POLICY_IDS)[number];

/**
 * Resolve configured policy ids to their specifications.
 *
 * Unknown ids cannot reach here — the configuration schema rejects them — so
 * an id that fails to resolve is a programming error, not user input, and is
 * dropped rather than substituted with something the user did not ask for.
 */
export function resolveShadowPolicies(ids: readonly string[]): ShadowPolicySpec[] {
  const byId = new Map(DEFAULT_SHADOW_POLICIES.map((spec) => [spec.id, spec]));
  return ids
    .map((id) => byId.get(id))
    .filter((spec): spec is ShadowPolicySpec => spec !== undefined);
}
