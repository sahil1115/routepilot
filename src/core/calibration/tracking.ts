/**
 * Confidence tracking: pairing what was predicted with what happened.
 *
 * A reliability diagram needs individual `(predicted, actual)` pairs, not
 * summary statistics. This turns a routing decision plus its outcome into them.
 *
 * Only the selected model is scored. A decision evaluates every candidate but
 * ran one; the others have a prediction and no outcome, and there is no honest
 * way to supply one -- assuming they would have failed manufactures evidence,
 * and assuming they would have succeeded manufactures different evidence.
 * Counterfactual scoring is shadow routing, with its own machinery (section 43).
 *
 * That leaves a real bias worth naming: the scored predictions are the ones the
 * router was confident enough to act on, so calibration is measured over a
 * selected sample (section 44). It is the right sample -- those are the
 * predictions that spent money -- but it is not accuracy across all tasks.
 */

import type { PredictionRecord, PredictionSource } from '../types/calibration.js';
import type { TaskScope } from '../types/features.js';
import type { RoutingDecision } from '../types/routing.js';
import type { TaskOutcome, TaskSuccessScore } from '../types/outcome.js';
import { MINIMUM_EVIDENCE } from '../learning/success-model.js';

/** What the caller must supply alongside a decision to score it. */
export interface TrackingContext {
  readonly requestId: string;
  readonly scope: TaskScope;
  /** When the outcome was known. Supplied, not read from a clock, so replays reproduce. */
  readonly at: number;
}

/**
 * Pair a routing decision's prediction with the outcome it produced.
 *
 * Returns `null` — meaning "this tells us nothing about prediction quality" —
 * in the same cases learning refuses an observation, and for the same reasons:
 *
 * - **Nothing was selected.** No prediction was acted on.
 * - **Nothing was evaluated.** `score === null` is unknown, not failure.
 * - **Too little evidence** to trust the score itself.
 * - **Not the model's fault.** A provider outage says nothing about whether the
 *   success probability was well calibrated (spec section 2, rule 10).
 * - **The task escalated.** More than one model ran, so the outcome cannot be
 *   attributed to the prediction made about any one of them.
 */
export function predictionFromDecision(
  decision: RoutingDecision,
  outcome: TaskOutcome,
  score: TaskSuccessScore,
  context: TrackingContext,
): PredictionRecord | null {
  const selected = decision.selectedModelId;
  if (selected === null) return null;

  if (!score.modelAttributable) return null;
  if (score.score === null) return null;
  if (score.evidence < MINIMUM_EVIDENCE) return null;
  if (outcome.escalationCount > 0) return null;
  if (outcome.modelsUsed.length !== 1) return null;

  const evaluation = decision.evaluations.find((candidate) => candidate.modelId === selected);
  if (evaluation === undefined) return null;

  // The source decides which pool this prediction is scored in. Recording a
  // prior as though it were a learned estimate would let good priors disguise
  // bad learning, which is the failure the safeguard exists to catch.
  const source: PredictionSource = evaluation.learningApplied ? 'learned' : 'prior';

  return {
    requestId: context.requestId,
    modelId: selected,
    taskType: outcome.taskType,
    scope: context.scope,
    predicted: evaluation.successProbability,
    actual: score.score,
    source,
    observations: evaluation.observations,
    at: context.at,
  };
}
