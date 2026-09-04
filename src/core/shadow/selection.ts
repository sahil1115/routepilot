/**
 * Selection rules (spec section 42).
 *
 * A routing policy is the limits a candidate must satisfy plus the rule for
 * choosing among those that do. The limits live in `RoutingPolicy`; this file
 * holds the rules.
 *
 * `expected-cost` is what production uses. The other two are baselines, and
 * they earn their place as the obvious alternatives a sceptic would propose: if
 * RoutePilot cannot beat "always use the cheap model" or "always use the best
 * model", the expected-cost apparatus is unjustified complexity.
 *
 * Every rule chooses only among viable candidates. One that ignored the budget
 * or the confidence threshold would produce shadow decisions RoutePilot could
 * never execute, making the comparison meaningless.
 */

import type { ModelEvaluation } from '../types/routing.js';
import type { SelectionRule } from '../types/shadow.js';
import { tierRank } from '../routing/static-priors.js';

/**
 * Apply a selection rule to a decision's candidates.
 *
 * Returns `null` when nothing is viable — a policy that would have stopped.
 * That is a real outcome, not a failure, and must not be papered over by
 * relaxing the rule until something qualifies.
 */
export function selectBy(
  rule: SelectionRule,
  evaluations: readonly ModelEvaluation[],
): ModelEvaluation | null {
  const viable = evaluations.filter((candidate) => candidate.viable);
  if (viable.length === 0) return null;

  // Every comparator ends in a model-id tie-break, so the result does not
  // depend on registration order.
  const sorted = [...viable].sort(comparatorFor(rule));
  return sorted[0] ?? null;
}

function comparatorFor(rule: SelectionRule): (a: ModelEvaluation, b: ModelEvaluation) => number {
  switch (rule) {
    case 'cheapest-first':
      // The naive policy: lowest sticker price wins. This is the one RoutePilot
      // exists to beat, so it is the most important baseline to keep honest.
      return (a, b) =>
        a.cost.initial - b.cost.initial ||
        b.successProbability - a.successProbability ||
        a.modelId.localeCompare(b.modelId);

    case 'strongest-first':
      // The other naive policy: always reach for the best model. Never wrong on
      // quality, frequently ruinous on cost.
      return (a, b) =>
        tierRank(b.tier) - tierRank(a.tier) ||
        b.successProbability - a.successProbability ||
        a.cost.expectedTotalToSuccess - b.cost.expectedTotalToSuccess ||
        a.modelId.localeCompare(b.modelId);

    case 'expected-cost':
    default:
      return (a, b) =>
        a.cost.expectedTotalToSuccess - b.cost.expectedTotalToSuccess ||
        b.successProbability - a.successProbability ||
        a.cost.initial - b.cost.initial ||
        a.modelId.localeCompare(b.modelId);
  }
}
