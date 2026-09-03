/**
 * Outcome scoring (spec sections 31 and 32).
 *
 * Turns everything observed about a task into a `TaskSuccessScore`.
 *
 * Two rules do the real work:
 *
 * 1. **Only evaluated dimensions count.** Weights are renormalised over the
 *    dimensions that were actually checked, and `evidence` reports how much of
 *    the possible evidence that was. A task nobody validated scores `null`, not
 *    zero — recording an unexamined task as a failure would poison learning.
 * 2. **Cancellation is not failure.** Spec section 32 is explicit: do not treat
 *    a user pressing stop as a negative signal about the model. A cancelled
 *    task is *unevaluated*, and its outcome is excluded from anything that
 *    could update beliefs about a model.
 */

import { isModelAttributable } from '../types/failure.js';
import type {
  OutcomeContribution,
  TaskOutcome,
  TaskSuccessScore,
  UserSignal,
} from '../types/outcome.js';
import { NEGATIVE_USER_SIGNALS } from '../types/outcome.js';

/** Relative weight of each outcome dimension. */
export interface OutcomeWeights {
  readonly syntax: number;
  readonly lint: number;
  readonly build: number;
  readonly tests: number;
  readonly taskCriteria: number;
  readonly userAccepted: number;
}

/**
 * Default weights.
 *
 * Tests and task criteria dominate, because they are the two things that
 * actually indicate the work was done. Lint is worth little: a lint failure is
 * a nuisance, not a broken task.
 */
export const DEFAULT_OUTCOME_WEIGHTS: OutcomeWeights = {
  syntax: 0.1,
  lint: 0.05,
  build: 0.2,
  tests: 0.3,
  taskCriteria: 0.2,
  userAccepted: 0.15,
};

/** Penalty applied per negative user signal, before clamping. */
const NEGATIVE_SIGNAL_PENALTY = 0.15;

/** Scores task outcomes. */
export class OutcomeRecorder {
  readonly #weights: OutcomeWeights;

  constructor(weights: Partial<OutcomeWeights> = {}) {
    this.#weights = { ...DEFAULT_OUTCOME_WEIGHTS, ...weights };
  }

  /** Score an outcome. */
  score(outcome: TaskOutcome): TaskSuccessScore {
    const dimensions: [string, boolean | null, number, string][] = [
      ['syntax', outcome.syntaxValid, this.#weights.syntax, 'the code parses'],
      ['lint', outcome.lintPassed, this.#weights.lint, 'lint is clean'],
      ['build', outcome.buildPassed, this.#weights.build, 'the project builds'],
      ['tests', outcome.testsPassed, this.#weights.tests, 'the tests pass'],
      [
        'taskCriteria',
        outcome.taskCriteriaMet,
        this.#weights.taskCriteria,
        'the task did what was asked',
      ],
      [
        'userAccepted',
        outcome.userAccepted,
        this.#weights.userAccepted,
        'the user accepted the result',
      ],
    ];

    const contributions: OutcomeContribution[] = [];
    let earned = 0;
    let evaluatedWeight = 0;
    let totalWeight = 0;

    for (const [dimension, passed, weight, reason] of dimensions) {
      totalWeight += weight;
      // A dimension nobody checked contributes nothing, in either direction.
      if (passed === null) continue;

      evaluatedWeight += weight;
      if (passed) earned += weight;
      contributions.push({ dimension, weight, passed, reason });
    }

    if (evaluatedWeight === 0) {
      // Nothing was checked. That is an unknown outcome, not a bad one.
      return {
        score: null,
        evidence: 0,
        contributions: [],
        modelAttributable: false,
      };
    }

    const base = earned / evaluatedWeight;
    const penalty = this.#negativeSignalPenalty(outcome);

    return {
      score: clamp(base - penalty),
      evidence: totalWeight === 0 ? 0 : evaluatedWeight / totalWeight,
      contributions,
      modelAttributable: this.#isModelAttributable(outcome),
    };
  }

  /**
   * Penalty for signals that the result was not good enough.
   *
   * Reverting, re-prompting or hand-editing all say the work missed. Cancelling
   * does not, and is excluded (spec section 32).
   */
  #negativeSignalPenalty(outcome: TaskOutcome): number {
    let count = 0;
    if (outcome.userReverted) count += 1;
    if (outcome.userRePrompted) count += 1;
    if (outcome.manualEditRequired) count += 1;
    return count * NEGATIVE_SIGNAL_PENALTY;
  }

  /**
   * Whether this outcome may update beliefs about the model.
   *
   * Deliberately narrow. A cancelled task tells us nothing. A task that failed
   * because a provider was down or a database was unreachable tells us nothing
   * about the model either (spec sections 22 and 38).
   */
  #isModelAttributable(outcome: TaskOutcome): boolean {
    if (outcome.userCancelled) return false;
    if (outcome.failureType === null) return true;
    return isModelAttributable(outcome.failureType);
  }

  /** Which signals a set of observations represents. */
  static signalsFrom(outcome: TaskOutcome): UserSignal[] {
    const signals: UserSignal[] = [];
    if (outcome.userAccepted === true) signals.push('accepted');
    if (outcome.userCancelled) signals.push('cancelled');
    if (outcome.userRePrompted) signals.push('re-prompted');
    if (outcome.userReverted) signals.push('reverted');
    if (outcome.manualEditRequired) signals.push('manually-edited');
    return signals;
  }

  /** Whether a signal indicates the result missed. */
  static isNegative(signal: UserSignal): boolean {
    return NEGATIVE_USER_SIGNALS.has(signal);
  }
}

/** A blank outcome, so callers fill in only what they actually know. */
export function emptyOutcome(requestId: string, overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    requestId,
    taskType: 'unknown',
    scope: 'single-file',
    syntaxValid: null,
    lintPassed: null,
    buildPassed: null,
    testsPassed: null,
    taskCriteriaMet: null,
    userAccepted: null,
    userCancelled: false,
    userRePrompted: false,
    userReverted: false,
    manualEditRequired: false,
    escalationCount: 0,
    modelsUsed: [],
    totalCost: 0,
    currency: 'USD',
    totalLatencyMs: 0,
    failureType: null,
    ...overrides,
  };
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
