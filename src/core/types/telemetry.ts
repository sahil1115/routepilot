/**
 * Telemetry records and the store interface (spec section 33).
 *
 * The core defines what is recorded and never how. `src/telemetry` implements
 * persistence; nothing in `src/core` knows SQLite exists.
 *
 * What is deliberately **not** in any record type: source code, full model
 * responses, prompts, absolute paths, secrets. Those fields do not exist, so no
 * implementation can accidentally store them. Prompts are represented by their
 * length and a stable hash, which is enough to group repeat requests without
 * retaining what was asked.
 */

import type { FailureType } from './failure.js';
import type { TaskScope } from './features.js';
import type { EscalationAction } from './escalation.js';
import type { ModelTier } from './model.js';
import type { TaskType } from './task.js';

/** A routing request, as recorded. */
export interface RequestRecord {
  readonly requestId: string;
  readonly createdAt: number;
  readonly taskType: TaskType;
  readonly scope: TaskScope;
  /**
   * The prompt is never stored. Its length and a stable hash are, which is
   * enough to notice a repeated request without retaining what it said.
   */
  readonly promptLength: number;
  readonly promptHash: string;
  readonly ambiguity: number;
  readonly risk: number;
  readonly reasoningRequirement: number;
  readonly novelty: number;
  /** Hash of the workspace root, so repositories can be grouped, not located. */
  readonly repositoryHash: string;
  readonly primaryLanguage: string | null;
  readonly fileCount: number;
  readonly isMonorepo: boolean;
  readonly analysisLevel: number;
  readonly contextRequirement: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
}

/** A routing decision, as recorded. */
export interface RoutingRecord {
  readonly requestId: string;
  readonly selectedModelId: string | null;
  readonly outcome: string;
  readonly staticTierPrior: ModelTier;
  readonly minimumSuccessProbability: number;
  readonly maxRisk: number;
  readonly requestBudget: number | null;
  readonly currency: string;
  readonly budgetExceeded: boolean;
  readonly candidateCount: number;
  readonly excludedCount: number;
  readonly decidedAt: number;
}

/** One scored candidate from a routing decision. */
export interface CandidateRecord {
  readonly requestId: string;
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly successProbability: number;
  readonly expectedTotalCost: number;
  readonly initialCost: number;
  readonly risk: number;
  readonly estimatedLatencySeconds: number;
  readonly viable: boolean;
  readonly selected: boolean;
  /** Whether the estimate rested on a tier default rather than a declared prior. */
  readonly usedTierDefault: boolean;
}

/**
 * One execution attempt, as recorded.
 *
 * Named distinctly from `AttemptRecord` in `features.ts` (a light history entry
 * for feature extraction) and `ExecutionAttempt` in `escalation.ts` (the
 * in-flight view). This is the persisted row.
 */
export interface ExecutionAttemptRecord {
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly modelId: string;
  readonly providerId: string;
  readonly adapterId: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly failureType: FailureType | null;
  /** Redacted, truncated summary. Never a transcript. */
  readonly errorSummary: string | null;
  readonly cost: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly toolCalls: number;
  readonly toolFailures: number;
  readonly filesChanged: number;
  readonly struggleScore: number;
  readonly modelAttributableStruggle: number;
}

/**
 * One normalised execution event, as recorded.
 *
 * Only the shape of what happened: the kind, the tool name, whether it worked,
 * and a workspace-relative path. No summaries, no output, no contents.
 */
export interface EventRecord {
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly sequence: number;
  readonly kind: string;
  readonly timestamp: number;
  readonly tool: string | null;
  readonly ok: boolean | null;
  readonly path: string | null;
}

/** One escalation decision, as recorded. */
export interface EscalationRecord {
  readonly requestId: string;
  readonly sequence: number;
  readonly action: EscalationAction;
  readonly fromModelId: string;
  readonly toModelId: string | null;
  readonly failureType: FailureType | null;
  readonly reason: string;
  readonly limitReached: string | null;
  readonly at: number;
}

/** The final outcome of a task, as recorded. */
export interface OutcomeRecord {
  readonly requestId: string;
  readonly syntaxValid: boolean | null;
  readonly lintPassed: boolean | null;
  readonly buildPassed: boolean | null;
  readonly testsPassed: boolean | null;
  readonly taskCriteriaMet: boolean | null;
  readonly userAccepted: boolean | null;
  readonly userCancelled: boolean;
  readonly userRePrompted: boolean;
  readonly userReverted: boolean;
  readonly manualEditRequired: boolean;
  readonly escalationCount: number;
  readonly modelsUsed: readonly string[];
  readonly totalCost: number;
  readonly currency: string;
  readonly totalLatencyMs: number;
  readonly failureType: FailureType | null;
  /** `null` when nothing was evaluated. Not zero. */
  readonly successScore: number | null;
  readonly evidence: number;
  readonly modelAttributable: boolean;
  readonly recordedAt: number;
}

/** One user signal, as recorded. */
export interface UserSignalRecord {
  readonly requestId: string;
  readonly signal: string;
  readonly at: number;
}

/** Aggregate counts, for `routepilot history` and offline evaluation. */
export interface TelemetryStatistics {
  readonly requests: number;
  readonly attempts: number;
  readonly outcomes: number;
  readonly escalations: number;
  /** Outcomes that may inform beliefs about a model. */
  readonly modelAttributableOutcomes: number;
  readonly totalCost: number;
}

/**
 * The local telemetry store.
 *
 * Every method must be safe to call when telemetry is disabled, and must never
 * throw into the routing path: a broken telemetry store is an inconvenience,
 * not a reason to fail a user's task (spec section 2, rules 16 and 17).
 */
export interface TelemetryStore {
  /** Whether this store actually persists anything. */
  readonly enabled: boolean;

  recordRequest(record: RequestRecord): void;
  recordRouting(record: RoutingRecord, candidates: readonly CandidateRecord[]): void;
  recordAttempt(record: ExecutionAttemptRecord): void;
  recordEvents(records: readonly EventRecord[]): void;
  recordEscalation(record: EscalationRecord): void;
  recordOutcome(record: OutcomeRecord): void;
  recordUserSignal(record: UserSignalRecord): void;

  /** Aggregate counts. */
  statistics(): TelemetryStatistics;
  /** Most recent outcomes, newest first. */
  recentOutcomes(limit: number): readonly OutcomeRecord[];

  close(): void;
}
