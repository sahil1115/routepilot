/**
 * Confidence tracking: pairing what was predicted with what happened.
 *
 * Calibration cannot be measured from summary statistics — a reliability
 * diagram needs the individual `(predicted, actual)` pairs. This module turns a
 * routing decision plus its outcome into exactly those pairs.
 *
 * ## Only the selected model is scored
 *
 * A decision evaluates every candidate, but only one was run. The others have a
 * prediction and **no outcome**, and there is no honest way to supply one:
 * assuming the unrun candidates would have failed would manufacture evidence,
 * and assuming they would have succeeded would manufacture different evidence.
 * Counterfactual scoring of unrun candidates is shadow routing, which is
 * Phase 13's job and needs its own machinery (spec section 43).
 *
 * This leaves a real bias in the data, and it is worth naming: the predictions
 * that get scored are the ones the router was confident enough to act on, so
 * calibration is measured over a **selected sample**, not a random one
 * (spec section 44). It is still the right sample to measure — those are the
 * predictions that spent money — but it is not a measure of the predictor's
 * accuracy across all tasks, and nothing here should be read as one.
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
