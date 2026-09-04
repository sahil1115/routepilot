/**
 * The contextual bandit (spec sections 36 and 40).
 *
 * Chooses between exploiting -- the model with the lowest expected cost to
 * success -- and exploring, deliberately taking another to learn whether it is
 * better than currently believed.
 *
 * The objective stays expected cost, not success probability. Maximising
 * probability would explore the most expensive model every time, since a
 * frontier model is always plausibly the most likely to succeed. Exploration
 * uses the same objective with an optimistic probability substituted in:
 *
 * ```
 * optimisticCost(m) = expectedCostToSuccess( initial(m), UCB(p(m)) )
 * ```
 *
 * Every candidate is scored optimistically, including the exploiting one, and
 * the lowest optimistic cost wins. The symmetry matters: comparing an
 * alternative's optimistic cost against the exploit choice's expected cost
 * starves the chosen arm, which then never runs again and freezes its estimate.
 *
 * Scoring everything alike means a model that cannot win even at its most
 * flattering is never tried, expensive models are rare targets because optimism
 * must overcome their price, and bounds tighten with evidence so exploration is
 * self-limiting rather than a permanent tax.
 *
 * Only viable candidates are considered -- exploration widens which acceptable
 * model is chosen, never what counts as acceptable. An experiment may cost at
 * most `maxCostPremium` more than exploiting and must still fit the budget;
 * risk and hazards are handled earlier by {@link assessExploration}.
 *
 * No sampling and no randomness, so routing stays deterministic (principle 9).
 */

import { DEFAULT_RECOVERY_MODEL, expectedCostToSuccess } from '../routing/expected-cost.js';
import type { ModelEvaluation } from '../types/routing.js';
import { upperConfidenceBound } from './uncertainty.js';
import type { ExplorationPolicy, ExplorationVerdict } from './exploration-gate.js';

/** What the bandit decided, and why. */
export interface ExplorationDecision {
  /** True when the choice differs from the exploiting one. */
  readonly explored: boolean;
  /** The model actually chosen. */
  readonly selectedModelId: string;
  /** The model exploitation would have chosen. Equal to the above when not exploring. */
  readonly exploitModelId: string;
  /**
   * Estimated extra cost of the experiment, or `null` when not exploring.
   *
   * An estimate under the current predictor, not a measured price.
   */
  readonly premium: number | null;
  /** One sentence explaining the decision. */
  readonly reason: string;
  /** Why exploration was refused, when it was. */
  readonly blockedBy: ExplorationVerdict['blockedBy'];
}

/** One candidate's optimistic case, exposed so a choice can be audited. */
export interface CandidateOptimism {
  readonly modelId: string;
  /** Real observations behind this model's estimate. Never a pseudo-count. */
  readonly observations: number;
  readonly expectedProbability: number;
  /** Upper confidence bound on the success probability. */
  readonly optimisticProbability: number;
  /** Expected cost if the optimistic probability turned out to be right. */
  readonly optimisticCost: number;
  /** Expected cost under the current best estimate. */
  readonly expectedCost: number;
}

/** How much evidence a model's estimate rests on, including the prior's weight. */
export interface ConcentrationLookup {
  (modelId: string): number;
}

/** Inputs to one exploration decision. */
export interface ExplorationInput {
  /** Candidates that satisfy every policy constraint. Never the full list. */
  readonly viable: readonly ModelEvaluation[];
  /** The model expected-cost routing chose. */
  readonly exploit: ModelEvaluation;
  readonly policy: ExplorationPolicy;
  readonly verdict: ExplorationVerdict;
  /** Total evidence behind each model, prior included. */
  readonly concentration: ConcentrationLookup;
  /** Request budget, when one is set. */
  readonly requestBudget?: number | undefined;
}

/**
 * Decide whether to explore, and what to explore with.
 *
 * Returns the exploiting choice unchanged whenever the gate refused, no
 * candidate is plausibly better, or the best candidate cannot be afforded.
 */
export function decideExploration(input: ExplorationInput): ExplorationDecision {
  const { exploit, verdict, policy } = input;

  const exploitOnly = (reason: string): ExplorationDecision => ({
    explored: false,
    selectedModelId: exploit.modelId,
    exploitModelId: exploit.modelId,
    premium: null,
    reason,
    blockedBy: verdict.blockedBy,
  });

  if (!verdict.allowed) return exploitOnly(`exploiting: ${verdict.reason}`);

  const budgetCeiling = Math.min(
    exploit.cost.expectedTotalToSuccess * (1 + policy.maxCostPremium),
    input.requestBudget ?? Number.POSITIVE_INFINITY,
  );

  // Ranked by optimistic cost, every candidate scored on the same terms. The
  // budget filter applies to the *expected* cost, because that is what the
  // attempt is actually likely to cost — optimism decides what is worth
  // trying, never what is affordable.
  const chosen = rankCandidates(input).find(
    (candidate) => candidate.modelId === exploit.modelId || candidate.expectedCost <= budgetCeiling,
  );

  if (chosen === undefined || chosen.modelId === exploit.modelId) {
    return exploitOnly('exploiting: no candidate is plausibly cheaper within the budget');
  }

  const premium = chosen.expectedCost - exploit.cost.expectedTotalToSuccess;

  return {
    explored: true,
    selectedModelId: chosen.modelId,
    exploitModelId: exploit.modelId,
    premium,
    reason:
      `exploring "${chosen.modelId}": ${String(chosen.observations)} observations leave enough doubt ` +
      `that it could cost as little as ${chosen.optimisticCost.toFixed(4)} against ` +
      `${exploit.cost.expectedTotalToSuccess.toFixed(4)} for "${exploit.modelId}"`,
    blockedBy: null,
  };
}

/**
 * Every viable candidate's optimistic case, most promising first.
 *
 * Sorted by optimistic cost with a model-id tie-break, so the ranking is a
 * total order and cannot depend on registration order.
 */
export function rankCandidates(input: ExplorationInput): CandidateOptimism[] {
  return input.viable
    .map((candidate) => optimismFor(candidate, input))
    .sort(
      (a, b) =>
        a.optimisticCost - b.optimisticCost ||
        b.optimisticProbability - a.optimisticProbability ||
        a.modelId.localeCompare(b.modelId),
    );
}

/** The optimistic case for one candidate. */
function optimismFor(candidate: ModelEvaluation, input: ExplorationInput): CandidateOptimism {
  const optimisticProbability = upperConfidenceBound(
    {
      probability: candidate.successProbability,
      concentration: input.concentration(candidate.modelId),
    },
    input.policy.optimism,
  );

  // Re-priced through the shared expected-cost model rather than a local
  // approximation, so an optimistic cost and an expected cost are the same
  // arithmetic with different probabilities and remain comparable.
  const optimistic = expectedCostToSuccess({
    initial: candidate.cost.initial,
    successProbability: optimisticProbability,
    escalationTargetCost: escalationTargetCost(candidate),
  });

  return {
    modelId: candidate.modelId,
    observations: candidate.observations,
    expectedProbability: candidate.successProbability,
    optimisticProbability,
    optimisticCost: optimistic.expectedTotalToSuccess,
    expectedCost: candidate.cost.expectedTotalToSuccess,
  };
}

/**
 * Recover the escalation target's cost from an existing projection.
 *
 * The projection already carries `escalation = target x (1 + overhead)`, so the
 * target cost is that divided back out. Reusing it keeps the optimistic
 * calculation anchored to the same escalation graph the live estimate used,
 * rather than silently assuming a different one.
 */
function escalationTargetCost(candidate: ModelEvaluation): number | null {
  if (candidate.escalationTargetId === null) return null;
  const { escalation, retry } = candidate.cost;
  // A candidate with no stronger model has `escalation === retry`; guard so a
  // degenerate projection cannot produce a nonsense target.
  if (escalation === retry) return null;
  // The shared constant, not a repeated literal: a local 1.2 here would drift
  // silently the moment the recovery model changed.
  return escalation / (1 + DEFAULT_RECOVERY_MODEL.handoffOverhead);
}
