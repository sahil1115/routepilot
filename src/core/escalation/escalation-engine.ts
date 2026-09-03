/**
 * Escalation engine (spec sections 24, 26 and 27).
 *
 * Decides what to do after a failed attempt. The governing idea, stated in the
 * specification and worth repeating here: **escalation is a graph, not a
 * ladder.** `cheap -> medium -> expensive` is the wrong default, because most
 * failures are not "the model was too weak":
 *
 * | Why it failed | What actually helps |
 * | --- | --- |
 * | The provider was down | Retry, or another provider |
 * | The database was down | Retry once the environment is fixed |
 * | The test was flaky | Retry — never a stronger model |
 * | The request was ambiguous | Ask the user |
 * | The context overflowed | A bigger window, not a cleverer model |
 * | The user cancelled | Stop |
 * | The model kept getting it wrong | *Now* a stronger model |
 *
 * Escalating on any of the first six would spend more money reproducing the
 * same failure. So the failure classification drives the decision, and only
 * `MODEL_WEAKNESS` — the single classification that may implicate a model —
 * leads to a vertical escalation.
 *
 * Limits are checked before anything else, so a task can never loop forever
 * (spec section 27).
 */

import { PRIMARY_SKILL_BY_TASK, tierRank } from '../routing/static-priors.js';
import { SuccessPredictor } from '../routing/success-predictor.js';
import type { FailureClassification, StruggleAssessment } from '../types/execution.js';
import type { RoutingFeatures } from '../types/features.js';
import type { ModelSpec } from '../types/model.js';
import type {
  ContextHandoff,
  EscalationAction,
  EscalationDecision,
  EscalationLimit,
  EscalationLimits,
  ExecutionAttempt,
} from '../types/escalation.js';
import { ContextHandoffBuilder, handoffIsUseful } from './handoff.js';

/** Everything the engine may look at. */
export interface EscalationContext {
  /** The user's task, verbatim, for the handoff. */
  readonly originalTask: string;
  readonly repositoryRoot: string;
  readonly branch: string | null;
  readonly features: RoutingFeatures;
  /** The model that just ran. */
  readonly currentModel: ModelSpec;
  /** Every attempt so far, oldest first. The last one is the failure at hand. */
  readonly attempts: readonly ExecutionAttempt[];
  /** Why the last attempt failed. */
  readonly classification: FailureClassification;
  /** How badly the run was going. */
  readonly struggle?: StruggleAssessment | undefined;
  readonly limits: EscalationLimits;
  /** Spend across every attempt so far. */
  readonly totalCost: number;
  /** Wall-clock time across every attempt so far. */
  readonly elapsedMs: number;
  /** Models still permitted by the hard filter. */
  readonly eligibleModels: readonly ModelSpec[];
}

/** Sensible defaults. */
export const DEFAULT_ESCALATION_LIMITS: EscalationLimits = {
  maxEscalationsPerTask: 2,
  maxRetriesPerModel: 1,
};

/**
 * How much better at this task a same-tier model must be before a horizontal
 * move is worth making.
 *
 * Set high enough that a marginal difference in priors does not cause a
 * pointless sideways hop.
 */
const HORIZONTAL_SKILL_MARGIN = 0.1;

/**
 * Decides what to do after a failed attempt.
 *
 * Takes no registry: candidates arrive on the context as
 * {@link EscalationContext.eligibleModels}, already filtered by the caller's
 * hard constraints. That keeps the engine a pure function of its input, and
 * guarantees escalation can never reach for a model the constraint filter had
 * already ruled out.
 */
export class EscalationEngine {
  readonly #predictor = new SuccessPredictor();
  readonly #handoffs = new ContextHandoffBuilder();

  /** Decide the next step. */
  decide(context: EscalationContext): EscalationDecision {
    const last = context.attempts[context.attempts.length - 1];

    // Nothing to do if it worked.
    if (last?.succeeded === true) {
      return this.#build(context, {
        action: 'none',
        target: null,
        reason: 'The attempt succeeded, so no escalation is needed.',
      });
    }

    // Limits first, always. A task must never loop (spec section 27).
    const limit = this.#limitReached(context);
    if (limit !== null) {
      return this.#build(context, {
        action: 'stop',
        target: null,
        reason: this.#describeLimit(limit, context),
        limitReached: limit,
      });
    }

    return this.#byFailureType(context);
  }

  /** The rules of spec section 26, one branch per failure type. */
  #byFailureType(context: EscalationContext): EscalationDecision {
    const { failureType } = context.classification;

    switch (failureType) {
      // --- Stop outright ---------------------------------------------------
      case 'USER_CANCELLED':
        return this.#build(context, {
          action: 'stop',
          target: null,
          reason: 'The user cancelled the run, so nothing further is attempted.',
        });

      case 'BUDGET_EXCEEDED':
        return this.#build(context, {
          action: 'stop',
          target: null,
          reason: 'The budget is exhausted; stopping safely rather than spending more.',
          limitReached: 'cost',
        });

      // --- Ask the user ----------------------------------------------------
      case 'USER_AMBIGUITY':
      case 'BAD_SPECIFICATION':
        return this.#build(context, {
          action: 'ask-user',
          target: null,
          reason:
            'The request itself is the problem, not the model. A stronger model would ' +
            'produce a better answer to the wrong question.',
          question:
            'The task was too ambiguous to act on confidently. Could you say which files ' +
            'or behaviour you want changed, and what the result should look like?',
        });

      case 'REPOSITORY_PROBLEM':
        return this.#build(context, {
          action: 'ask-user',
          target: null,
          reason:
            'The repository is in a state no model can work around — this needs a person, ' +
            'not a more capable model.',
          question:
            'The repository appears to be broken independently of this task (for example a ' +
            'merge conflict or unresolved dependencies). Could you fix that first?',
        });

      // --- More context, same model ---------------------------------------
      case 'MISSING_CONTEXT':
        return this.#retryOr(context, 'improve-context', {
          reason:
            'The model was not given enough context. Supplying more is cheaper and more ' +
            'likely to work than moving to a stronger model.',
        });

      // --- A bigger window, not a cleverer model ---------------------------
      case 'CONTEXT_LIMIT': {
        const larger = this.#findLargerContext(context);
        if (larger === null) {
          return this.#build(context, {
            action: 'stop',
            target: null,
            reason:
              'The request exceeds the context window and no configured model has a larger ' +
              'one. Compacting the context is the remaining option.',
            limitReached: 'no-candidates',
          });
        }
        return this.#build(context, {
          action: 'escalate-vertical',
          target: larger,
          reason:
            `The request overflowed ${context.currentModel.id}'s context window, so it moves ` +
            `to ${larger.id}, which has a larger one.`,
        });
      }

      // --- Transient: retry, then a different provider ---------------------
      case 'PROVIDER_FAILURE': {
        if (this.#retriesLeft(context)) {
          return this.#build(context, {
            action: 'retry',
            target: context.currentModel.id,
            reason:
              'The provider failed. That says nothing about the model, so the same model is ' +
              'retried before anything else is changed.',
          });
        }
        const fallback = this.#findOtherProvider(context);
        if (fallback === null) {
          return this.#build(context, {
            action: 'stop',
            target: null,
            reason:
              'The provider keeps failing and no comparable model is available from another ' +
              'provider.',
            limitReached: 'no-candidates',
          });
        }
        return this.#build(context, {
          action: 'provider-fallback',
          target: fallback,
          reason:
            `Provider "${context.currentModel.providerId}" keeps failing, so the task moves to ` +
            `${fallback.id} on "${fallback.providerId}". The model class is unchanged.`,
        });
      }

      // --- Environment: retry, never escalate ------------------------------
      case 'ENVIRONMENT_FAILURE':
        return this.#retryOr(context, 'stop', {
          reason:
            'The environment failed, not the model. Escalating would spend more money ' +
            'reproducing the same failure; the environment needs fixing.',
          stopReason:
            'The environment keeps failing and retries are exhausted. This needs fixing ' +
            'outside RoutePilot — a stronger model cannot help.',
        });

      case 'FLAKY_TEST':
        return this.#retryOr(context, 'stop', {
          reason:
            'The failing test looks flaky. A retry is the right response; escalating the ' +
            'model would be spending money on test noise.',
          stopReason: 'The test keeps failing and retries are exhausted.',
        });

      case 'TOOL_FAILURE':
        return this.#retryOr(context, 'escalate-horizontal', {
          reason: 'A tool failed with no clearer cause; the same model is retried once.',
        });

      case 'TIMEOUT':
        return this.#retryOr(context, 'escalate-horizontal', {
          reason: 'The run timed out; it is retried once before the model is changed.',
        });

      // --- The one case that really is the model ---------------------------
      case 'MODEL_WEAKNESS':
        return this.#escalateForWeakness(context);

      case 'UNKNOWN':
      default:
        // Unexplained. If the model was visibly struggling, treat it as
        // weakness; otherwise retry once, then stop. Never guess upward.
        if ((context.struggle?.modelAttributableScore ?? 0) >= 0.5) {
          return this.#escalateForWeakness(context);
        }
        return this.#retryOr(context, 'stop', {
          reason: 'The failure could not be explained; the same model is retried once.',
          stopReason:
            'The failure could not be explained and retries are exhausted. Stopping rather ' +
            'than spending more on a problem nobody has identified.',
        });
    }
  }

  /**
   * Move to a better model because this one is not up to the task.
   *
   * Prefers a **horizontal** move when a similarly-priced model is markedly
   * better at this particular kind of work — spending more is not the only way
   * to do better (spec section 24).
   */
  #escalateForWeakness(context: EscalationContext): EscalationDecision {
    const horizontal = this.#findHorizontal(context);
    if (horizontal !== null) {
      return this.#build(context, {
        action: 'escalate-horizontal',
        target: horizontal,
        reason:
          `${horizontal.id} is markedly stronger at ${PRIMARY_SKILL_BY_TASK[context.features.task.taskType]} ` +
          `at a similar tier, so the task moves sideways rather than up.`,
      });
    }

    const vertical = this.#findVertical(context);
    if (vertical !== null) {
      return this.#build(context, {
        action: 'escalate-vertical',
        target: vertical,
        reason:
          `${context.currentModel.id} repeatedly failed to make progress, so the task ` +
          `escalates to ${vertical.id}.`,
      });
    }

    // Nothing stronger is left. This is the case spec section 26 names
    // explicitly: do not endlessly escalate.
    return this.#build(context, {
      action: 'stop',
      target: null,
      reason:
        `${context.currentModel.id} is the strongest suitable model available and it still ` +
        `failed. There is nothing to escalate to, so the task stops with a diagnostic ` +
        `summary rather than looping.`,
      limitReached: 'no-candidates',
    });
  }

  /** Retry if retries remain, otherwise fall through to another action. */
  #retryOr(
    context: EscalationContext,
    fallbackAction: EscalationAction,
    options: { reason: string; stopReason?: string },
  ): EscalationDecision {
    if (this.#retriesLeft(context)) {
      return this.#build(context, {
        action: 'retry',
        target: context.currentModel.id,
        reason: options.reason,
      });
    }

    if (fallbackAction === 'stop') {
      return this.#build(context, {
        action: 'stop',
        target: null,
        reason: options.stopReason ?? 'Retries are exhausted.',
        limitReached: 'retries',
      });
    }

    if (fallbackAction === 'improve-context') {
      return this.#build(context, {
        action: 'improve-context',
        target: context.currentModel.id,
        reason: options.reason,
      });
    }

    // Horizontal, or vertical if no sideways move exists.
    return this.#escalateForWeakness(context);
  }

  // -------------------------------------------------------------------------
  // Candidate selection
  // -------------------------------------------------------------------------

  /** Models still worth considering: eligible, not already tried. */
  #candidates(context: EscalationContext): ModelSpec[] {
    const tried = new Set(context.attempts.map((attempt) => attempt.modelId));
    return context.eligibleModels
      .filter((model) => !tried.has(model.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The cheapest model with a materially higher chance of success. */
  #findVertical(context: EscalationContext): ModelSpec | null {
    const current = this.#predictor.estimate(context.currentModel, context.features).probability;

    const better = this.#candidates(context)
      .map((model) => ({
        model,
        probability: this.#predictor.estimate(model, context.features).probability,
      }))
      .filter((entry) => entry.probability > current + 0.02);

    if (better.length === 0) return null;

    // Among genuinely better models, take the cheapest. Escalation should not
    // reach for the most expensive option available.
    better.sort(
      (a, b) =>
        a.model.pricing.outputPerMillion - b.model.pricing.outputPerMillion ||
        b.probability - a.probability ||
        a.model.id.localeCompare(b.model.id),
    );

    return better[0]?.model ?? null;
  }

  /**
   * A similarly-priced model that is markedly better at *this* kind of work.
   *
   * The point of horizontal escalation: a model can be excellent at TypeScript
   * debugging and mediocre at Rust architecture, so "better" is task-specific
   * rather than a single ranking (spec sections 8 and 24).
   */
  #findHorizontal(context: EscalationContext): ModelSpec | null {
    const skill = PRIMARY_SKILL_BY_TASK[context.features.task.taskType];
    const currentSkill = context.currentModel.priors.skills[skill];
    if (currentSkill === undefined) return null;

    const currentRank = tierRank(context.currentModel.tier);

    const better = this.#candidates(context)
      .filter((model) => Math.abs(tierRank(model.tier) - currentRank) <= 0)
      .map((model) => ({ model, skill: model.priors.skills[skill] }))
      .filter(
        (entry): entry is { model: ModelSpec; skill: number } =>
          entry.skill !== undefined && entry.skill >= currentSkill + HORIZONTAL_SKILL_MARGIN,
      );

    if (better.length === 0) return null;

    better.sort((a, b) => b.skill - a.skill || a.model.id.localeCompare(b.model.id));
    return better[0]?.model ?? null;
  }

  /** A comparable model from a different provider. */
  #findOtherProvider(context: EscalationContext): ModelSpec | null {
    const currentRank = tierRank(context.currentModel.tier);

    const alternatives = this.#candidates(context)
      .filter((model) => model.providerId !== context.currentModel.providerId)
      // Prefer the same class of model; a provider outage is no reason to
      // change how capable — or how expensive — the model is.
      .sort(
        (a, b) =>
          Math.abs(tierRank(a.tier) - currentRank) - Math.abs(tierRank(b.tier) - currentRank) ||
          a.id.localeCompare(b.id),
      );

    return alternatives[0] ?? null;
  }

  /** A model whose context window can actually hold the request. */
  #findLargerContext(context: EscalationContext): ModelSpec | null {
    const needed = context.features.context.contextRequirement;

    const larger = this.#candidates(context)
      .filter((model) => model.contextWindow > context.currentModel.contextWindow)
      .filter((model) => model.contextWindow >= needed)
      .sort(
        (a, b) =>
          // The smallest window that fits, so the cheapest adequate option wins.
          a.contextWindow - b.contextWindow || a.id.localeCompare(b.id),
      );

    return larger[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Limits
  // -------------------------------------------------------------------------

  #retriesLeft(context: EscalationContext): boolean {
    const onThisModel = context.attempts.filter(
      (attempt) => attempt.modelId === context.currentModel.id,
    ).length;
    // The first attempt is not a retry.
    return onThisModel - 1 < context.limits.maxRetriesPerModel;
  }

  #limitReached(context: EscalationContext): EscalationLimit | null {
    const { limits } = context;

    if (limits.maxTotalCost !== undefined && context.totalCost >= limits.maxTotalCost) {
      return 'cost';
    }
    if (limits.maxExecutionTimeMs !== undefined && context.elapsedMs >= limits.maxExecutionTimeMs) {
      return 'time';
    }

    // An escalation is a move to a *different* model, so count distinct models
    // rather than attempts.
    const distinctModels = new Set(context.attempts.map((attempt) => attempt.modelId)).size;
    if (distinctModels - 1 >= limits.maxEscalationsPerTask) return 'escalations';

    return null;
  }

  #describeLimit(limit: EscalationLimit, context: EscalationContext): string {
    switch (limit) {
      case 'cost':
        return `Total spend (${context.totalCost.toFixed(4)}) reached the limit for this task; stopping.`;
      case 'time':
        return `Elapsed time reached the limit for this task; stopping.`;
      case 'escalations':
        return (
          `This task has already used its ${String(context.limits.maxEscalationsPerTask)} ` +
          `permitted escalation(s); stopping rather than looping.`
        );
      case 'retries':
        return 'Retries are exhausted; stopping.';
      case 'no-candidates':
      default:
        return 'No further candidate is available; stopping.';
    }
  }

  // -------------------------------------------------------------------------
  // Assembly
  // -------------------------------------------------------------------------

  #build(
    context: EscalationContext,
    parts: {
      action: EscalationAction;
      target: ModelSpec | string | null;
      reason: string;
      limitReached?: EscalationLimit;
      question?: string;
    },
  ): EscalationDecision {
    const targetModelId =
      typeof parts.target === 'string' ? parts.target : (parts.target?.id ?? null);

    const movesToAnotherModel =
      parts.action === 'escalate-vertical' ||
      parts.action === 'escalate-horizontal' ||
      parts.action === 'provider-fallback';

    const handoff: ContextHandoff | null =
      movesToAnotherModel && handoffIsUseful(context.classification.failureType)
        ? this.#handoffs.build({
            originalTask: context.originalTask,
            repositoryRoot: context.repositoryRoot,
            branch: context.branch,
            attempts: context.attempts,
            escalationReason: parts.reason,
          })
        : null;

    return {
      action: parts.action,
      targetModelId,
      reason: parts.reason,
      explanation: this.#explain(context, parts.action, targetModelId, parts.reason),
      handoff,
      limitReached: parts.limitReached ?? null,
      ...(parts.question === undefined ? {} : { question: parts.question }),
      modelAttributable: context.classification.modelAttributable,
    };
  }

  #explain(
    context: EscalationContext,
    action: EscalationAction,
    targetModelId: string | null,
    reason: string,
  ): string[] {
    const lines = [reason, ''];

    lines.push(
      `Failure: ${context.classification.failureType} ` +
        `(${percent(context.classification.confidence)} confidence) — ${context.classification.reason}`,
    );

    if (!context.classification.modelAttributable) {
      lines.push(
        'This failure does not implicate the model, so it will not inform routing or learning.',
      );
    }

    if (context.struggle !== undefined) {
      lines.push(
        `Struggle: ${percent(context.struggle.score)} overall, ` +
          `${percent(context.struggle.modelAttributableScore)} attributable to the model.`,
      );
    }

    lines.push('');
    lines.push(`Attempts so far: ${String(context.attempts.length)}`);
    for (const attempt of context.attempts) {
      lines.push(
        `  ${attempt.modelId}: ${attempt.succeeded ? 'succeeded' : `failed (${attempt.failureType ?? 'UNKNOWN'})`}`,
      );
    }

    lines.push('');
    lines.push(`Action: ${action}${targetModelId === null ? '' : ` -> ${targetModelId}`}`);
    lines.push(
      `Limits: ${String(context.limits.maxEscalationsPerTask)} escalation(s), ` +
        `${String(context.limits.maxRetriesPerModel)} retry per model` +
        (context.limits.maxTotalCost === undefined
          ? ''
          : `, ${context.limits.maxTotalCost.toFixed(4)} total cost`),
    );

    return lines;
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}
