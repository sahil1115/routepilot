/**
 * Config to escalation limits (Phase 24).
 *
 * `maxEscalationsPerTask` and `maxRetriesPerModel` were validated by the schema
 * from Phase 2 onward and converted by nothing, so the runner used built-in
 * defaults that happened to equal the example configuration. This is the test
 * that would have noticed.
 */

import { describe, expect, it } from 'vitest';

import type { EscalationLimits } from '../core/types/escalation.js';
import { toEscalationLimits } from './policy.js';
import { parseConfig } from './schema.js';

/**
 * Compile-time conformance, in the style of `schema.test.ts`.
 *
 * Every field of `EscalationLimits` must be one the mapper knows about. Adding
 * a fifth limit to the core type without teaching `toEscalationLimits` about it
 * makes `Missing` non-empty, and this file stops compiling.
 */
const MAPPED = [
  'maxEscalationsPerTask',
  'maxRetriesPerModel',
  'maxTotalCost',
  'maxExecutionTimeMs',
] as const satisfies readonly (keyof EscalationLimits)[];

type Missing = Exclude<keyof EscalationLimits, (typeof MAPPED)[number]>;
const everyLimitIsMapped: Missing extends never ? true : false = true;

describe('toEscalationLimits', () => {
  it('maps every field of EscalationLimits', () => {
    expect(everyLimitIsMapped).toBe(true);
    expect(MAPPED).toHaveLength(4);
  });

  it('round-trips every field from configuration', () => {
    const config = parseConfig({
      version: 1,
      routing: { maxEscalationsPerTask: 3, maxRetriesPerModel: 2, maxExecutionTimeMs: 120_000 },
      budgets: { request: 0.75 },
    });

    expect(toEscalationLimits(config)).toEqual({
      maxEscalationsPerTask: 3,
      maxRetriesPerModel: 2,
      maxTotalCost: 0.75,
      maxExecutionTimeMs: 120_000,
    } satisfies EscalationLimits);
  });

  it('omits an unset budget and an unset time limit rather than writing zero', () => {
    // Absent means unlimited at this scope. A zero here would stop every run
    // before its first attempt, and an explicit `undefined` key would fail
    // `exactOptionalPropertyTypes`.
    const limits = toEscalationLimits(parseConfig({ version: 1 }));

    expect(limits).toEqual({ maxEscalationsPerTask: 2, maxRetriesPerModel: 1 });
    expect('maxTotalCost' in limits).toBe(false);
    expect('maxExecutionTimeMs' in limits).toBe(false);
  });

  it('maps the request budget, and no other scope, to the total-cost cap', () => {
    // Session, daily and monthly are still unenforced. The mapper must not
    // quietly promote one of them into the per-run cap, where it would be
    // wrong by an order of magnitude.
    const config = parseConfig({
      version: 1,
      budgets: { request: 0.5, session: 10, daily: 25, monthly: 300 },
    });

    expect(toEscalationLimits(config).maxTotalCost).toBe(0.5);
  });
});
