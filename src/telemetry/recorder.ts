/**
 * Recording a completed run (spec section 75).
 *
 * Produces the records section 75 requires -- models used, execution path,
 * actual cost, latency, validation result, failure types, escalation, user
 * outcome -- from a real run. The record types already existed; nothing
 * produced them, and the store was written to only by its own tests.
 *
 * Deliberately not recorded: the prompt, the diff, model output, file contents,
 * credentials. A prompt contributes its length and a stable hash, enough to
 * notice the same request twice but not to reconstruct it; a workspace
 * contributes a hash, so repositories can be grouped but not located. Error
 * summaries pass through {@link redactSummary}.
 *
 * That is the privacy contract in `docs/PRIVACY.md`, enforced here because this
 * is the only place a real task reaches the database.
 */

import type { RunResult } from '../core/types/run.js';
import type { RoutingFeatures } from '../core/types/features.js';
import type {
  CandidateRecord,
  ExecutionAttemptRecord,
  OutcomeRecord,
  RequestRecord,
  RoutingRecord,
  TelemetryStore,
} from '../core/types/telemetry.js';

import { redactSummary, stableHash } from './redaction.js';

/** Everything needed to record one run. */
export interface RecordRunInput {
  readonly store: TelemetryStore;
  readonly requestId: string;
  /** Hashed, never stored. */
  readonly prompt: string;
  /** Hashed, never stored. */
  readonly workspaceRoot: string;
  readonly features: RoutingFeatures;
  /**
   * The run, which carries the decision it actually executed.
   *
   * There is deliberately no separate `decision` input. Until Phase 24 the CLI
   * recorded the decision it had *printed* while the runner routed again on
   * its own, so with learning or exploration in play the record could name a
   * model the run never used. The only decision worth recording is the one on
   * the run.
   */
  readonly run: RunResult;
  /** Injected so a recorded timestamp is testable. */
  readonly now?: number | undefined;
}

/**
 * Record a completed run.
 *
 * Best-effort by design: telemetry must never be able to fail a task that
 * already succeeded. A store that throws is reported through `onProblem` at the
 * call site and the run's own result stands.
 */
export function recordRun(input: RecordRunInput): void {
  const { store, requestId, run } = input;
  const at = input.now ?? Date.now();

  store.recordRequest(requestRecord(input, at));
  store.recordRouting(routingRecord(input, at), candidateRecords(input));

  for (const attempt of run.attempts) store.recordAttempt(attemptRecord(input, attempt, at));

  // Events are deliberately not recorded. The monitor consumes them as they
  // stream past and they are not retained, so recording them would mean keeping
  // a transcript this project has said since Phase 8 it does not keep. Section
  // 75 asks for the execution *path*, which the attempts and escalations carry.

  run.escalations.forEach((escalation, index) => {
    store.recordEscalation({
      requestId,
      sequence: index,
      action: escalation.action,
      fromModelId: escalation.fromModelId,
      toModelId: escalation.toModelId,
      failureType: escalation.failureType,
      reason: redactSummary(escalation.reason) ?? '',
      limitReached: escalation.limitReached,
      at,
    });
  });

  store.recordOutcome(outcomeRecord(input, at));
}

function requestRecord(input: RecordRunInput, at: number): RequestRecord {
  const { task, repository, context } = input.features;

  return {
    requestId: input.requestId,
    createdAt: at,
    taskType: task.taskType,
    scope: input.features.task.scope,
    // Length and hash, never the text.
    promptLength: input.prompt.length,
    promptHash: stableHash(input.prompt),
    ambiguity: task.ambiguity,
    risk: task.risk,
    reasoningRequirement: task.reasoningRequirement,
    novelty: task.novelty,
    repositoryHash: stableHash(input.workspaceRoot),
    primaryLanguage: repository.primaryLanguage,
    fileCount: repository.fileCount,
    isMonorepo: repository.isMonorepo,
    analysisLevel: input.features.analysisLevel,
    contextRequirement: context.contextRequirement,
    estimatedInputTokens: context.estimatedInputTokens,
    estimatedOutputTokens: context.estimatedOutputTokens,
  };
}

function routingRecord(input: RecordRunInput, at: number): RoutingRecord {
  const { decision } = input.run;
  const { policy } = decision;

  return {
    requestId: input.requestId,
    selectedModelId: decision.selectedModelId,
    outcome: decision.outcome,
    staticTierPrior: decision.staticTierPrior,
    minimumSuccessProbability: policy.minimumSuccessProbability,
    maxRisk: policy.maxRisk,
    requestBudget: policy.requestBudget ?? null,
    currency: policy.currency,
    budgetExceeded: decision.excluded.some((entry) => entry.reason.includes('budget')),
    candidateCount: decision.evaluations.length,
    excludedCount: decision.excluded.length,
    decidedAt: at,
  };
}

function candidateRecords(input: RecordRunInput): readonly CandidateRecord[] {
  return input.run.decision.evaluations.map((evaluation) => ({
    requestId: input.requestId,
    modelId: evaluation.modelId,
    tier: evaluation.tier,
    successProbability: evaluation.successProbability,
    expectedTotalCost: evaluation.cost.expectedTotalToSuccess,
    initialCost: evaluation.cost.initial,
    risk: evaluation.risk,
    estimatedLatencySeconds: evaluation.estimatedLatencySeconds,
    viable: evaluation.viable,
    selected: evaluation.modelId === input.run.decision.selectedModelId,
    usedTierDefault: evaluation.usedTierDefault,
  }));
}

function attemptRecord(
  input: RecordRunInput,
  attempt: RunResult['attempts'][number],
  at: number,
): ExecutionAttemptRecord {
  return {
    requestId: input.requestId,
    attemptIndex: attempt.index,
    modelId: attempt.modelId,
    // Resolved from the model id's provider prefix, which the config schema
    // guarantees is present.
    providerId: attempt.modelId.split('/')[0] ?? 'unknown',
    adapterId: attempt.adapterId ?? 'unknown',
    startedAt: at,
    durationMs: attempt.durationMs,
    status: attempt.succeeded ? 'completed' : 'failed',
    failureType: attempt.failureType,
    errorSummary: redactSummary(attempt.failureReason),
    cost: attempt.cost,
    // Absent, not zero: the adapters do not report token usage yet, and a zero
    // here would be indistinguishable from a genuinely free call.
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    toolCalls: attempt.toolCalls,
    toolFailures: attempt.toolFailures,
    filesChanged: attempt.changedFiles.length,
    struggleScore: attempt.struggleScore,
    modelAttributableStruggle: attempt.modelAttributableStruggle,
  };
}

function outcomeRecord(input: RecordRunInput, at: number): OutcomeRecord {
  const { run } = input;
  const score = run.score;
  const signals = run.signals;

  return {
    requestId: input.requestId,
    // Straight from the signals the score was computed from. Null means the
    // check did not run, which is not the same as failing it.
    syntaxValid: signals?.syntaxValid ?? null,
    lintPassed: signals?.lintPassed ?? null,
    buildPassed: signals?.buildPassed ?? null,
    testsPassed: signals?.testsPassed ?? null,
    taskCriteriaMet: signals?.taskCriteriaMet ?? null,
    // Nothing has asked the user, so nothing is claimed. `userAccepted` is a
    // signal a later `routepilot feedback` would supply; inferring it from a
    // green build would be inventing consent.
    userAccepted: signals?.userAccepted ?? null,
    userCancelled: run.outcome === 'cancelled',
    userRePrompted: signals?.userRePrompted ?? false,
    userReverted: signals?.userReverted ?? false,
    manualEditRequired: signals?.manualEditRequired ?? false,
    escalationCount: run.escalations.length,
    modelsUsed: run.attempts.map((attempt) => attempt.modelId),
    totalCost: run.totalCost,
    currency: input.run.decision.policy.currency,
    totalLatencyMs: run.attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
    failureType: run.attempts.at(-1)?.failureType ?? null,
    successScore: score?.score ?? null,
    evidence: score?.evidence ?? 0,
    modelAttributable: run.attempts.some(
      (attempt) => !attempt.succeeded && attempt.failureType !== null,
    ),
    recordedAt: at,
  };
}
