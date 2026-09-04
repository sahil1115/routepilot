/**
 * Aggregating recorded shadow decisions (spec sections 42 and 44).
 *
 * Turns a history of `(current chose A, shadow would have chosen B)` into the
 * per-policy summary a user reads.
 *
 * The summed cost delta is the total estimated difference under the estimates
 * current when each decision was made. It is not money saved and not evidence
 * that the shadow policy is better: the shadow's model never ran, and both
 * sides come from the same success probabilities, so a miscalibrated predictor
 * moves them together and the difference inherits the error.
 *
 * Only decisions where both policies selected something contribute, and
 * `comparableCount` reports how many, so a delta over three comparable
 * decisions cannot be mistaken for one over three hundred.
 */

import type { ShadowAgreement, ShadowRecord } from '../types/shadow.js';

/**
 * Summarise recorded shadow decisions, one row per policy.
 *
 * Policies are returned in first-seen order, and their divergent choices in
 * descending frequency with an id tie-break, so the report is deterministic.
 */
export function summariseAgreement(records: readonly ShadowRecord[]): ShadowAgreement[] {
  const order: string[] = [];
  const byPolicy = new Map<
    string,
    {
      count: number;
      agreements: number;
      estimatedCostDelta: number;
      comparableCount: number;
      choices: Map<string, number>;
    }
  >();

  for (const record of records) {
    let entry = byPolicy.get(record.policyId);
    if (entry === undefined) {
      entry = {
        count: 0,
        agreements: 0,
        estimatedCostDelta: 0,
        comparableCount: 0,
        choices: new Map(),
      };
      byPolicy.set(record.policyId, entry);
      order.push(record.policyId);
    }

    entry.count += 1;
    if (record.agrees) entry.agreements += 1;

    // `null` means one side selected nothing. Counting it as a zero delta would
    // silently dilute the average toward "no difference".
    if (record.estimatedCostDelta !== null) {
      entry.estimatedCostDelta += record.estimatedCostDelta;
      entry.comparableCount += 1;
    }

    // Only divergences are interesting here: a list dominated by the model both
    // policies already agree on says nothing about the alternative.
    if (!record.agrees && record.shadowModelId !== null) {
      entry.choices.set(record.shadowModelId, (entry.choices.get(record.shadowModelId) ?? 0) + 1);
    }
  }

  return order.map((policyId) => {
    // `order` is built from the map's own keys, so this is always present.
    const entry = byPolicy.get(policyId);
    if (entry === undefined) throw new Error(`missing aggregate for ${policyId}`);

    return {
      policyId,
      count: entry.count,
      agreements: entry.agreements,
      // `null` rather than 0 or 1 with nothing recorded: an unmeasured
      // agreement rate is unknown, not perfect and not total disagreement.
      agreementRate: entry.count === 0 ? null : entry.agreements / entry.count,
      estimatedCostDelta: entry.estimatedCostDelta,
      comparableCount: entry.comparableCount,
      divergentChoices: [...entry.choices.entries()]
        .map(([modelId, count]) => ({ modelId, count }))
        .sort((a, b) => b.count - a.count || a.modelId.localeCompare(b.modelId)),
    } satisfies ShadowAgreement;
  });
}
