/**
 * The task runner (spec sections 17, 22, 27 and 31).
 *
 * Joins the pipeline every phase since 5 has been building one piece of:
 *
 * ```
 * route -> execute -> monitor -> validate -> classify -> escalate -> score
 *                        ^                                   |
 *                        +-------------- retry / handoff -----+
 * ```
 *
 * Nothing here is new machinery. Every stage is a component that already
 * existed and was already tested in isolation; this is the thing that had been
 * missing, which is why `routepilot route` could choose a model and nothing
 * could run one.
 *
 * ## What the loop guarantees
 *
 * - **A failure is classified before anything is decided about it.** Escalating
 *   on a provider outage would buy a more expensive model to solve a problem it
 *   does not have (spec section 22).
 * - **Only a model-attributable failure updates beliefs.** A database being
 *   down, a cancelled run, an ambiguous request — none of these say anything
 *   about the model, and recording them as failures would corrupt learning
 *   (architectural principle 10).
 * - **Escalation is bounded.** The engine's limits are honoured, and a run that
 *   exhausts them stops with a reason rather than climbing forever.
 * - **The next model is briefed, not handed a transcript.** The handoff is a
 *   compact summary (spec section 28).
 *
 * ## Determinism and time
 *
 * The clock is injected. Durations come from it and nothing else, so a replay
 * with a scripted clock produces identical results.
 */

import type { AgentEvent, AgentExecutionRequest } from '../types/agent.js';
import type { ExecutionSignals, ValidationReport } from '../types/execution.js';
import type { FailureType } from '../types/failure.js';
import type { ModelSpec } from '../types/model.js';
import type { ContextHandoff, ExecutionAttempt } from '../types/escalation.js';
import type { TaskOutcome, TaskSuccessScore } from '../types/outcome.js';
import type { RoutingDecision } from '../types/routing.js';
import type {
  ExecutorPort,
  RunAttempt,
  RunEscalation,
  RunOutcome,
  RunRequest,
  RunResult,
} from '../types/run.js';
import type { Clock } from '../ports.js';
import { systemClock } from '../ports.js';
import type { ModelRegistry } from '../registry/model-registry.js';
import type { RoutingEngine } from '../routing/routing-engine.js';
import type { ValidationEngine } from '../execution/validation.js';
import type { LearnedSuccessModel } from '../learning/success-model.js';
import { ExecutionMonitor } from '../execution/monitor.js';
import { FailureClassifier } from '../execution/failure-classifier.js';
import { StruggleMonitor } from '../execution/struggle.js';
import { EscalationEngine, DEFAULT_ESCALATION_LIMITS } from '../escalation/escalation-engine.js';
import type { EscalationLimits } from '../types/escalation.js';
import { OutcomeRecorder, emptyOutcome } from '../outcome/outcome-recorder.js';
import { observationFromOutcome } from '../learning/success-model.js';
import { priceModelTokens } from '../pricing.js';

/** Everything the runner needs wired in. */
export interface TaskRunnerOptions {
  readonly models: ModelRegistry;
  /**
   * Routes a request that arrives without a decision.
   *
   * Optional, because a caller that has already routed passes its decision on
   * the request and the runner must execute exactly that. A runner with no
   * router and no decision has nothing to run and says so.
   */
  readonly router?: RoutingEngine | undefined;
  readonly executor: ExecutorPort;
  /** Post-execution validation. Absent means nothing is checked. */
  readonly validation?: ValidationEngine | undefined;
  /** Where observations are recorded, when learning is on. */
  readonly learned?: LearnedSuccessModel | undefined;
  readonly limits?: EscalationLimits | undefined;
  readonly clock?: Clock | undefined;
  /**
   * Whether the repository already failed validation before the run.
   *
   * Without it a pre-broken build gets blamed on the model.
   */
  readonly repositoryBrokenBeforeRun?: boolean | undefined;
}

/** Runs one task to a conclusion. */
export class TaskRunner {
  readonly #models: ModelRegistry;
  readonly #router: RoutingEngine | undefined;
  readonly #executor: ExecutorPort;
  readonly #validation: ValidationEngine | undefined;
  readonly #learned: LearnedSuccessModel | undefined;
  readonly #limits: EscalationLimits;
  readonly #clock: Clock;
  readonly #repositoryBroken: boolean;

  readonly #classifier = new FailureClassifier();
  readonly #struggle = new StruggleMonitor();
  readonly #escalation = new EscalationEngine();
  readonly #outcomes = new OutcomeRecorder();

  constructor(options: TaskRunnerOptions) {
    this.#models = options.models;
    this.#router = options.router;
    this.#executor = options.executor;
    this.#validation = options.validation;
    this.#learned = options.learned;
    this.#limits = options.limits ?? DEFAULT_ESCALATION_LIMITS;
    this.#clock = options.clock ?? systemClock;
    this.#repositoryBroken = options.repositoryBrokenBeforeRun ?? false;
  }

  /** Run one task. Never throws for a routine outcome. */
  async run(request: RunRequest): Promise<RunResult> {
    // A supplied decision is executed as-is. Routing again here would let the
    // run diverge from the plan the caller printed, and every record of the
    // run would then be attributed to a decision that never executed.
    const decision = request.decision ?? this.#route(request);

    // The router declined. It has already decided what to say, and second
    // guessing it here would mean two places choosing whether to spend money.
    if (decision.selectedModelId === null) {
      return this.#finishWithoutRunning(request, decision);
    }

    return this.#loop(request, decision, decision.selectedModelId);
  }

  #route(request: RunRequest): RoutingDecision {
    if (this.#router === undefined) {
      throw new Error(
        'TaskRunner was given neither a routing decision nor a router; there is nothing to run.',
      );
    }
    return this.#router.route({
      features: request.features,
      policy: request.policy,
      ...(request.requestedModelId === undefined
        ? {}
        : { requestedModelId: request.requestedModelId }),
      ...(request.requiredCapabilities === undefined
        ? {}
        : { requiredCapabilities: request.requiredCapabilities }),
    });
  }

  /** Attempt, classify, escalate, repeat. */
  async #loop(
    request: RunRequest,
    decision: RoutingDecision,
    firstModelId: string,
  ): Promise<RunResult> {
    const attempts: RunAttempt[] = [];
    const escalations: RunEscalation[] = [];
    const startedAt = this.#clock.now();

    let modelId: string | null = firstModelId;
    let handoff: ContextHandoff | null = null;
    let viaEscalation = false;
    let totalCost = 0;
    // Carried out of the loop so a *failed* run still records what was checked.
    // Reporting a run whose tests demonstrably failed as "not evaluated" would
    // be the same absent-is-not-zero mistake in reverse: the evidence exists.
    let lastValidation: ValidationReport | undefined;

    while (modelId !== null) {
      const model = this.#models.get(modelId);
      if (model === undefined) {
        return this.#finish(request, decision, attempts, escalations, totalCost, {
          outcome: 'failed',
          reason: `Model "${modelId}" is no longer configured.`,
        });
      }

      const attempt = await this.#attempt(request, model, handoff, viaEscalation, attempts.length);
      attempts.push(attempt.record);
      totalCost += attempt.record.cost;
      lastValidation = attempt.validation ?? lastValidation;

      if (attempt.record.succeeded) {
        return this.#finish(request, decision, attempts, escalations, totalCost, {
          outcome: 'succeeded',
          reason: `"${model.id}" completed the task.`,
          validation: attempt.validation,
        });
      }

      // A cancelled run is a decision by the user, not a failure of anything.
      // It ends the run immediately and teaches nothing (spec section 32).
      if (attempt.record.failureType === 'USER_CANCELLED') {
        return this.#finish(request, decision, attempts, escalations, totalCost, {
          outcome: 'cancelled',
          reason: 'The user cancelled the run.',
          validation: lastValidation,
        });
      }

      const next = this.#escalation.decide({
        originalTask: request.task,
        repositoryRoot: request.workspaceRoot,
        branch: request.branch ?? null,
        features: request.features,
        currentModel: model,
        attempts: attempts.map(toExecutionAttempt),
        classification: attempt.classification,
        struggle: attempt.struggle,
        limits: this.#limits,
        totalCost,
        elapsedMs: this.#clock.now() - startedAt,
        eligibleModels: this.#eligible(decision),
      });

      // The budget is applied *before* the next attempt, not after. The engine
      // stops once spend has reached the cap; on its own that permits one more
      // attempt that lands over it, and across retries and escalations a request
      // budget would then bound nothing. Projecting the next attempt closes
      // that gap without touching the engine's own rules.
      const unaffordable = this.#unaffordable(next.targetModelId, totalCost, request);
      if (unaffordable !== null) {
        escalations.push({
          action: 'stop',
          fromModelId: model.id,
          toModelId: next.targetModelId,
          failureType: attempt.classification.failureType,
          reason: unaffordable,
          modelAttributable: next.modelAttributable,
          limitReached: 'cost',
        });
        return this.#finish(request, decision, attempts, escalations, totalCost, {
          outcome: 'stopped',
          reason: unaffordable,
          validation: lastValidation,
        });
      }

      escalations.push({
        action: next.action,
        fromModelId: model.id,
        toModelId: next.targetModelId,
        failureType: attempt.classification.failureType,
        reason: next.reason,
        modelAttributable: next.modelAttributable,
        limitReached: next.limitReached,
      });

      switch (next.action) {
        case 'retry':
          modelId = model.id;
          handoff = next.handoff;
          viaEscalation = false;
          break;

        case 'escalate-vertical':
        case 'escalate-horizontal':
        case 'provider-fallback':
          modelId = next.targetModelId;
          handoff = next.handoff;
          viaEscalation = true;
          break;

        case 'ask-user':
          return this.#finish(request, decision, attempts, escalations, totalCost, {
            outcome: 'needs-clarification',
            reason: next.reason,
            question: next.question ?? null,
            validation: lastValidation,
          });

        case 'stop':
        default:
          return this.#finish(request, decision, attempts, escalations, totalCost, {
            outcome: 'stopped',
            reason: next.reason,
            validation: lastValidation,
          });
      }
    }

    return this.#finish(request, decision, attempts, escalations, totalCost, {
      outcome: 'stopped',
      reason: 'No further model was available.',
      validation: lastValidation,
    });
  }

  /** One execution, monitored, validated and classified. */
  async #attempt(
    request: RunRequest,
    model: ModelSpec,
    handoff: ContextHandoff | null,
    viaEscalation: boolean,
    index: number,
  ): Promise<{
    record: RunAttempt;
    classification: ReturnType<FailureClassifier['classify']>;
    struggle: ReturnType<StruggleMonitor['assess']>;
    validation: ValidationReport | undefined;
  }> {
    const startedAt = this.#clock.now();

    const executionRequest: AgentExecutionRequest = {
      requestId: request.requestId,
      prompt: request.task,
      workspaceRoot: request.workspaceRoot,
      taskType: request.features.task.taskType,
      requiredCapabilities: request.requiredCapabilities ?? {},
      estimatedContextTokens: request.features.context.contextRequirement,
      // A briefing, never a transcript (spec section 28).
      ...(handoff === null ? {} : { priorAttemptSummary: summarise(handoff) }),
    };

    const outcome = await this.#executor.execute(executionRequest, model);
    const signals = observeAll(outcome.events, this.#clock);

    // Validation only runs when the agent actually finished. Building a
    // workspace an agent abandoned half-way tells you about the abandonment,
    // not about the model.
    const validation =
      outcome.result.status === 'completed' ? await this.#validate(request, outcome) : undefined;

    const succeeded = outcome.result.status === 'completed' && (validation?.passed ?? true);

    const classification = this.#classifier.classify({
      signals,
      ...(outcome.result.failureType === undefined
        ? {}
        : { adapterFailureType: outcome.result.failureType }),
      ...(outcome.result.errorSummary === undefined
        ? {}
        : { adapterErrorSummary: outcome.result.errorSummary }),
      ...(validation === undefined ? {} : { validation }),
      taskAmbiguity: request.features.task.ambiguity,
      repositoryBrokenBeforeRun: this.#repositoryBroken,
    });

    const durationMs = this.#clock.now() - startedAt;
    const struggle = this.#struggle.assess(signals);

    return {
      record: {
        index,
        modelId: model.id,
        tier: model.tier,
        succeeded,
        failureType: succeeded ? null : classification.failureType,
        failureReason: succeeded ? null : classification.reason,
        cost: this.#cost(model, outcome, request),
        durationMs,
        changedFiles: outcome.result.changedFiles,
        failedChecks: failedChecks(validation),
        viaEscalation,
        handoff,
        adapterId: outcome.adapterId,
        toolCalls: signals.toolCalls,
        toolFailures: signals.toolFailures,
        struggleScore: struggle.score,
        modelAttributableStruggle: struggle.modelAttributableScore,
      },
      classification,
      struggle,
      validation,
    };
  }

  /** Run post-execution validation, when an engine is configured. */
  async #validate(
    request: RunRequest,
    outcome: Awaited<ReturnType<ExecutorPort['execute']>>,
  ): Promise<ValidationReport | undefined> {
    if (this.#validation === undefined) return undefined;

    const plan = this.#validation.planFor(
      request.features.task.taskType,
      request.features.task.scope,
      outcome.result.changedFiles.length,
    );
    if (plan.checks.length === 0) return undefined;

    return this.#validation.run(plan, request.workspaceRoot);
  }

  /**
   * What the attempt cost.
   *
   * Reported usage is preferred over the estimate: an estimate is what the
   * router expected to spend and an actual is what was spent, and only the
   * second belongs in a total shown to a user.
   */
  #cost(
    model: ModelSpec,
    outcome: Awaited<ReturnType<ExecutorPort['execute']>>,
    request: RunRequest,
  ): number {
    const usage = outcome.result.usage;
    if (usage !== undefined) {
      return priceModelTokens(model, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: usage.cachedInputTokens }),
      }).totalCost;
    }

    return this.#estimate(model, request);
  }

  /** What one attempt on this model is expected to cost, before it runs. */
  #estimate(model: ModelSpec, request: RunRequest): number {
    return priceModelTokens(model, {
      inputTokens: request.features.context.estimatedInputTokens,
      outputTokens: request.features.context.estimatedOutputTokens,
    }).totalCost;
  }

  /**
   * Why the next attempt cannot be afforded, or null when it can.
   *
   * Only a total-cost limit is projected. Time cannot be estimated for an
   * attempt that has not started, and the engine already counts escalations
   * and retries exactly.
   */
  #unaffordable(
    targetModelId: string | null,
    totalCost: number,
    request: RunRequest,
  ): string | null {
    const cap = this.#limits.maxTotalCost;
    if (cap === undefined || targetModelId === null) return null;

    const target = this.#models.get(targetModelId);
    if (target === undefined) return null;

    const next = this.#estimate(target, request);
    const projected = totalCost + next;
    if (projected <= cap) return null;

    return (
      `Stopping rather than running "${target.id}": it is expected to cost ${next.toFixed(4)}, ` +
      `which would bring the total to ${projected.toFixed(4)} against a limit of ${cap.toFixed(4)}.`
    );
  }

  /**
   * Models escalation may move to, in the order the router ranked them.
   *
   * Only candidates the router marked viable. Escalation widens which
   * *acceptable* model runs next; it never lowers the bar, which is the same
   * rule exploration was held to in Phase 13. Without this filter a vertical
   * move could land on a model the router had marked over budget, below the
   * confidence threshold or too slow, simply because it was evaluated.
   */
  #eligible(decision: RoutingDecision): ModelSpec[] {
    return decision.evaluations
      .filter((candidate) => candidate.viable)
      .map((candidate) => this.#models.get(candidate.modelId))
      .filter((model): model is ModelSpec => model !== undefined);
  }

  /** The router selected nothing. */
  #finishWithoutRunning(request: RunRequest, decision: RoutingDecision): RunResult {
    const outcome: RunOutcome =
      decision.outcome === 'ask-user' ? 'needs-clarification' : 'no-model';

    return {
      requestId: request.requestId,
      outcome,
      decision,
      signals: null,
      attempts: [],
      escalations: [],
      finalModelId: null,
      totalCost: 0,
      // Nothing ran, so nothing was evaluated. `null`, not a zero score.
      score: null,
      question: outcome === 'needs-clarification' ? decision.reason : null,
      reason: decision.reason,
    };
  }

  /** Score, record and return. */
  #finish(
    request: RunRequest,
    decision: RoutingDecision,
    attempts: readonly RunAttempt[],
    escalations: readonly RunEscalation[],
    totalCost: number,
    end: {
      outcome: RunOutcome;
      reason: string;
      question?: string | null;
      validation?: ValidationReport | undefined;
    },
  ): RunResult {
    const last = attempts[attempts.length - 1];
    const taskOutcome = this.#toTaskOutcome(request, attempts, totalCost, end);
    const score = this.#outcomes.score(taskOutcome);

    this.#learn(taskOutcome, score);

    return {
      requestId: request.requestId,
      outcome: end.outcome,
      decision,
      attempts,
      escalations,
      finalModelId: last?.modelId ?? null,
      totalCost,
      score,
      signals: taskOutcome,
      question: end.question ?? null,
      reason: end.reason,
    };
  }

  /** Build the outcome record the score is computed from. */
  #toTaskOutcome(
    request: RunRequest,
    attempts: readonly RunAttempt[],
    totalCost: number,
    end: { outcome: RunOutcome; validation?: ValidationReport | undefined },
  ): TaskOutcome {
    const checks = checkResults(end.validation);
    const succeeded = end.outcome === 'succeeded';

    return emptyOutcome(request.requestId, {
      taskType: request.features.task.taskType,
      scope: request.features.task.scope,
      // Only what was actually checked. Everything else stays `null`, which
      // means "not evaluated" and contributes nothing to the score.
      syntaxValid: checks.syntax,
      lintPassed: checks.lint,
      buildPassed: checks.build,
      testsPassed: checks.tests,
      taskCriteriaMet: succeeded ? true : end.outcome === 'failed' ? false : null,
      userCancelled: end.outcome === 'cancelled',
      escalationCount: attempts.filter((attempt) => attempt.viaEscalation).length,
      modelsUsed: [...new Set(attempts.map((attempt) => attempt.modelId))],
      totalCost,
      currency: request.policy.currency,
      totalLatencyMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
      failureType: attempts[attempts.length - 1]?.failureType ?? null,
    });
  }

  /**
   * Record an observation, when there is an honest one to record.
   *
   * `observationFromOutcome` refuses anything that teaches nothing about a
   * single model — a cancelled run, an unevaluated one, a provider outage, or a
   * task that took more than one model to finish.
   */
  #learn(outcome: TaskOutcome, score: TaskSuccessScore): void {
    if (this.#learned === undefined) return;

    const observation = observationFromOutcome(outcome, score);
    if (observation === null) return;

    this.#learned.observe(observation, this.#clock.now());
  }
}

/**
 * The briefing, as a single string for the adapter.
 *
 * `AgentExecutionRequest.priorAttemptSummary` is deliberately a string: the
 * adapter interface must not learn RoutePilot's internal handoff shape. This is
 * the one place the structure is flattened, and it stays a **summary** — file
 * names, failing checks and approaches already tried, never a transcript
 * (spec section 28).
 */
function summarise(handoff: ContextHandoff): string {
  const lines = [handoff.instruction];

  if (handoff.previousAttempts.length > 0) {
    lines.push('', 'Previous attempts:', ...handoff.previousAttempts.map((line) => `- ${line}`));
  }
  if (handoff.filesChanged.length > 0) {
    lines.push('', `Already changed: ${handoff.filesChanged.join(', ')}`);
  }
  if (handoff.failingChecks.length > 0) {
    lines.push(`Failing checks: ${handoff.failingChecks.join(', ')}`);
  }
  if (handoff.approachesTried.length > 0) {
    lines.push('', 'Already tried:', ...handoff.approachesTried.map((line) => `- ${line}`));
  }

  return lines.join('\n');
}

/** Feed every event through a fresh monitor. */
function observeAll(events: readonly AgentEvent[], clock: Clock): ExecutionSignals {
  const monitor = new ExecutionMonitor({ clock });
  for (const event of events) monitor.observe(event);
  return monitor.signals();
}

/** Names of the checks that failed. */
function failedChecks(validation: ValidationReport | undefined): string[] {
  if (validation === undefined) return [];
  return validation.results
    .filter((result) => result.passed === false)
    .map((result) => result.check);
}

/** Per-dimension results, with `null` for anything that did not run. */
function checkResults(validation: ValidationReport | undefined): {
  syntax: boolean | null;
  lint: boolean | null;
  build: boolean | null;
  tests: boolean | null;
} {
  const find = (check: string): boolean | null =>
    validation?.results.find((result) => result.check === check)?.passed ?? null;

  return {
    syntax: find('syntax'),
    lint: find('lint'),
    build: find('build'),
    tests: find('tests'),
  };
}

/** Narrow a run attempt to what the escalation engine consumes. */
function toExecutionAttempt(attempt: RunAttempt): ExecutionAttempt {
  return {
    modelId: attempt.modelId,
    // The escalation engine reads the tier and the model id; the provider is
    // carried for reporting and is not used to choose.
    providerId: attempt.modelId.split('/')[0] ?? '',
    tier: attempt.tier,
    succeeded: attempt.succeeded,
    ...(attempt.failureType === null ? {} : { failureType: attempt.failureType }),
    ...(attempt.failureReason === null ? {} : { failureReason: attempt.failureReason }),
    cost: attempt.cost,
    durationMs: attempt.durationMs,
    changedFiles: attempt.changedFiles,
    failedChecks: attempt.failedChecks,
  };
}

/** Re-exported so callers need one import for the run types. */
export type { FailureType };
