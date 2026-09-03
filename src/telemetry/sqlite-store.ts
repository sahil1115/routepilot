/**
 * SQLite telemetry store (spec sections 33 and 34).
 *
 * Local-first: a file on the user's own disk, never a network call. Nothing
 * here reaches out anywhere.
 *
 * Three behaviours matter more than the SQL:
 *
 * 1. **Telemetry never breaks routing.** Every write is wrapped so that a
 *    failed insert, a locked database or a full disk degrades to "nothing was
 *    recorded" rather than failing the user's task (spec section 2, rule 17).
 * 2. **A corrupt database is recoverable without help.** If the file cannot be
 *    opened, it is moved aside and a fresh one started, with the quarantined
 *    path reported. Losing history is bad; refusing to run because history is
 *    unreadable is worse.
 * 3. **Redaction happens here, at the boundary.** Callers do not have to
 *    remember.
 *
 * `node:sqlite` is used rather than a native dependency. It is currently an
 * experimental Node API, so it is imported lazily — a build with telemetry
 * disabled never loads it and never prints its experimental warning. The whole
 * surface sits behind `TelemetryStore`, so replacing it later touches this file
 * only.
 */

import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  ExecutionAttemptRecord,
  CandidateRecord,
  EscalationRecord,
  EventRecord,
  OutcomeRecord,
  RequestRecord,
  RoutingRecord,
  TelemetryStatistics,
  TelemetryStore,
  UserSignalRecord,
} from '../core/types/telemetry.js';
import type {
  PredictionRecord,
  PredictionSource,
  PredictionStore,
} from '../core/types/calibration.js';
import type { LearnedStats, LearningStore } from '../core/types/learning.js';
import type { ShadowRecord, ShadowStore } from '../core/types/shadow.js';
import type { TaskScope } from '../core/types/features.js';
import type { TaskType } from '../core/types/task.js';
import { redactPath, redactSummary } from './redaction.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './schema.js';

/**
 * Tables `statistics()` may count.
 *
 * A closed union, not `string`: the name is interpolated into SQL because an
 * identifier cannot be a bound parameter, and the type is what guarantees only
 * these four values can ever get there.
 */
type CountableTable = 'requests' | 'attempts' | 'outcomes' | 'escalations';

/** The minimal slice of `node:sqlite` this store uses. */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

/** Options for {@link SqliteTelemetryStore}. */
/** Loads the `node:sqlite` binding. Injected so the missing case is testable. */
export type SqliteLoader = () => Promise<{ DatabaseSync: new (path: string) => unknown }>;

/**
 * The Node release that first shipped `node:sqlite`.
 *
 * Below this the module does not exist and the import throws
 * `ERR_UNKNOWN_BUILTIN_MODULE`. RoutePilot still runs — telemetry is optional
 * by design (spec section 2, rule 17) — but the reason has to be legible, and
 * "No such built-in module: node:sqlite" is not.
 */
export const SQLITE_MINIMUM_NODE = '22.5.0';

/** Raised when the runtime has no `node:sqlite`, with the version that does. */
export class SqliteUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `This build of Node has no "node:sqlite" module, so telemetry cannot be stored. ` +
        `It requires Node ${SQLITE_MINIMUM_NODE} or newer; this is Node ${process.versions.node}. ` +
        `Routing, analysis and escalation are unaffected and continue to work.`,
    );
    this.name = 'SqliteUnavailableError';
    this.cause = cause;
  }
}

export interface SqliteStoreOptions {
  /** Directory holding the database file. */
  readonly directory: string;
  /** File name. */
  readonly fileName?: string | undefined;
  /** Workspace root, so absolute paths can be made relative before storage. */
  readonly workspaceRoot?: string | undefined;
  /** Called when something is quarantined or a write fails. */
  readonly onProblem?: ((message: string) => void) | undefined;
  /**
   * How the `node:sqlite` binding is obtained.
   *
   * Injected only by tests. Without it the absence of the module could not be
   * exercised on a machine that has it, and the graceful degradation would be
   * true by accident rather than by test.
   */
  readonly loadSqlite?: SqliteLoader | undefined;
}

/** What happened when the store opened. */
export interface OpenReport {
  readonly path: string;
  /** Schema version before migrations ran. */
  readonly previousVersion: number;
  readonly currentVersion: number;
  readonly migrationsApplied: number;
  /** Where a corrupt database was moved, if one was. */
  readonly quarantinedTo: string | null;
}

/** Records telemetry to a local SQLite file. */
export class SqliteTelemetryStore
  implements TelemetryStore, LearningStore, PredictionStore, ShadowStore
{
  readonly enabled = true;

  readonly #db: SqliteDatabase;
  readonly #path: string;
  readonly #workspaceRoot: string | undefined;
  readonly #onProblem: (message: string) => void;
  readonly report: OpenReport;

  private constructor(
    db: SqliteDatabase,
    path: string,
    report: OpenReport,
    options: SqliteStoreOptions,
  ) {
    this.#db = db;
    this.#path = path;
    this.#workspaceRoot = options.workspaceRoot;
    this.#onProblem = options.onProblem ?? (() => undefined);
    this.report = report;
  }

  /** Absolute path of the database file. */
  get path(): string {
    return this.#path;
  }

  /**
   * Open a store, migrating or recovering as needed.
   *
   * Never throws for a corrupt file: it is quarantined and a fresh database
   * takes its place.
   */
  static async open(options: SqliteStoreOptions): Promise<SqliteTelemetryStore> {
    // Loaded lazily so a disabled-telemetry build never touches the
    // experimental API, nor prints its warning.
    //
    // `node:sqlite` arrived in Node 22.5. RoutePilot declares Node >= 20.11
    // because everything except telemetry works there, so this import failing
    // is a supported state rather than a fault — it is translated into an
    // error that names the requirement, and the caller degrades to a
    // NullTelemetryStore.
    let DatabaseSync: new (path: string) => unknown;
    try {
      ({ DatabaseSync } = await (options.loadSqlite ?? loadNodeSqlite)());
    } catch (error) {
      // Only the module genuinely being absent becomes a version message.
      // Relabelling every load failure would tell someone whose disk is full
      // to upgrade Node, which is worse than saying nothing.
      if (isMissingModule(error)) throw new SqliteUnavailableError(error);
      throw error;
    }

    const path = join(options.directory, options.fileName ?? 'routepilot.sqlite');
    mkdirSync(dirname(path), { recursive: true });

    const openAt = (): { db: SqliteDatabase; previousVersion: number; applied: number } => {
      const db = new DatabaseSync(path) as SqliteDatabase;
      try {
        // SQLite opens lazily, so constructing the handle proves nothing.
        // Reading the schema is what actually touches the file header and
        // surfaces "file is not a database".
        db.prepare('SELECT count(*) FROM sqlite_master').get();
        const previousVersion = readVersion(db);
        return { db, previousVersion, applied: migrate(db, previousVersion) };
      } catch (error) {
        // Close before anything tries to move the file: on Windows an open
        // handle makes the rename fail with EBUSY.
        try {
          db.close();
        } catch {
          // Already unusable; nothing to salvage.
        }
        throw error;
      }
    };

    let opened: ReturnType<typeof openAt>;
    let quarantinedTo: string | null = null;

    try {
      opened = openAt();
    } catch (error) {
      quarantinedTo = quarantine(path);
      options.onProblem?.(
        `The telemetry database could not be opened and was moved to ${quarantinedTo ?? 'nowhere'}; ` +
          `a fresh one was created. History is lost, but routing is unaffected. ` +
          `Cause: ${describe(error)}`,
      );
      // A second failure is genuine: let it propagate so the caller can fall
      // back to a no-op store rather than pretending to record.
      opened = openAt();
    }

    const report: OpenReport = {
      path,
      previousVersion: opened.previousVersion,
      currentVersion: CURRENT_SCHEMA_VERSION,
      migrationsApplied: opened.applied,
      quarantinedTo,
    };

    return new SqliteTelemetryStore(opened.db, path, report, options);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  recordRequest(record: RequestRecord): void {
    this.#write('request', () => {
      this.#db
        .prepare(
          `INSERT OR REPLACE INTO requests VALUES
           (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.requestId,
          record.createdAt,
          record.taskType,
          record.scope,
          record.promptLength,
          record.promptHash,
          record.ambiguity,
          record.risk,
          record.reasoningRequirement,
          record.novelty,
          record.repositoryHash,
          record.primaryLanguage,
          record.fileCount,
          bool(record.isMonorepo),
          record.analysisLevel,
          record.contextRequirement,
          record.estimatedInputTokens,
          record.estimatedOutputTokens,
        );
    });
  }

  recordRouting(record: RoutingRecord, candidates: readonly CandidateRecord[]): void {
    this.#write('routing', () => {
      this.#db
        .prepare(`INSERT OR REPLACE INTO routing_decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          record.requestId,
          record.selectedModelId,
          record.outcome,
          record.staticTierPrior,
          record.minimumSuccessProbability,
          record.maxRisk,
          record.requestBudget,
          record.currency,
          bool(record.budgetExceeded),
          record.candidateCount,
          record.excludedCount,
          record.decidedAt,
        );

      const statement = this.#db.prepare(
        `INSERT OR REPLACE INTO routing_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const candidate of candidates) {
        statement.run(
          candidate.requestId,
          candidate.modelId,
          candidate.tier,
          candidate.successProbability,
          candidate.expectedTotalCost,
          candidate.initialCost,
          candidate.risk,
          candidate.estimatedLatencySeconds,
          bool(candidate.viable),
          bool(candidate.selected),
          bool(candidate.usedTierDefault),
        );
      }
    });
  }

  recordAttempt(record: ExecutionAttemptRecord): void {
    this.#write('attempt', () => {
      this.#db
        .prepare(`INSERT OR REPLACE INTO attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          record.requestId,
          record.attemptIndex,
          record.modelId,
          record.providerId,
          record.adapterId,
          record.startedAt,
          record.durationMs,
          record.status,
          record.failureType,
          // Redacted at the boundary, so no caller has to remember.
          redactSummary(record.errorSummary),
          record.cost,
          record.inputTokens,
          record.outputTokens,
          record.cachedInputTokens,
          record.toolCalls,
          record.toolFailures,
          record.filesChanged,
          record.struggleScore,
          record.modelAttributableStruggle,
        );
    });
  }

  recordEvents(records: readonly EventRecord[]): void {
    if (records.length === 0) return;
    this.#write('events', () => {
      const statement = this.#db.prepare(
        `INSERT OR REPLACE INTO execution_events VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const record of records) {
        statement.run(
          record.requestId,
          record.attemptIndex,
          record.sequence,
          record.kind,
          record.timestamp,
          record.tool,
          record.ok === null ? null : bool(record.ok),
          record.path === null ? null : redactPath(record.path, this.#workspaceRoot),
        );
      }
    });
  }

  recordEscalation(record: EscalationRecord): void {
    this.#write('escalation', () => {
      this.#db
        .prepare(`INSERT OR REPLACE INTO escalations VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(
          record.requestId,
          record.sequence,
          record.action,
          record.fromModelId,
          record.toModelId,
          record.failureType,
          redactSummary(record.reason) ?? '',
          record.limitReached,
          record.at,
        );
    });
  }

  recordOutcome(record: OutcomeRecord): void {
    this.#write('outcome', () => {
      this.#db
        .prepare(
          `INSERT OR REPLACE INTO outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.requestId,
          nullableBool(record.syntaxValid),
          nullableBool(record.lintPassed),
          nullableBool(record.buildPassed),
          nullableBool(record.testsPassed),
          nullableBool(record.taskCriteriaMet),
          nullableBool(record.userAccepted),
          bool(record.userCancelled),
          bool(record.userRePrompted),
          bool(record.userReverted),
          bool(record.manualEditRequired),
          record.escalationCount,
          JSON.stringify(record.modelsUsed),
          record.totalCost,
          record.currency,
          record.totalLatencyMs,
          record.failureType,
          record.successScore,
          record.evidence,
          bool(record.modelAttributable),
          record.recordedAt,
        );
    });
  }

  recordUserSignal(record: UserSignalRecord): void {
    this.#write('user signal', () => {
      this.#db
        .prepare(`INSERT OR REPLACE INTO user_signals VALUES (?,?,?)`)
        .run(record.requestId, record.signal, record.at);
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  statistics(): TelemetryStatistics {
    // The table name is interpolated, because SQLite cannot parameterise an
    // identifier. It is therefore restricted to a literal union rather than
    // `string`: every call site is checked at compile time, so no caller can
    // reach this with a value that came from outside. Safe by construction
    // rather than by everyone remembering (spec section 51).
    const count = (table: CountableTable): number => {
      const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
        { n: number } | undefined;
      return row?.n ?? 0;
    };

    const attributable = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM outcomes WHERE model_attributable = 1`)
      .get() as { n: number } | undefined;

    const cost = this.#db.prepare(`SELECT SUM(total_cost) AS c FROM outcomes`).get() as
      { c: number | null } | undefined;

    return {
      requests: count('requests'),
      attempts: count('attempts'),
      outcomes: count('outcomes'),
      escalations: count('escalations'),
      modelAttributableOutcomes: attributable?.n ?? 0,
      totalCost: cost?.c ?? 0,
    };
  }

  recentRouting(limit: number): readonly RoutingRecord[] {
    const rows = this.#db
      .prepare(`SELECT * FROM routing_decisions ORDER BY decided_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];

    return rows.map(toRoutingRecord);
  }

  recentOutcomes(limit: number): readonly OutcomeRecord[] {
    const rows = this.#db
      .prepare(`SELECT * FROM outcomes ORDER BY recorded_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];

    return rows.map(toOutcomeRecord);
  }

  // ---- Learned statistics (Phase 10) --------------------------------------

  /**
   * Load every learned bucket.
   *
   * A read failure yields an empty list rather than throwing: with no learned
   * data the router falls back to configured priors, which is a working system
   * (spec section 2, rules 16 and 17).
   */
  loadLearnedStats(): readonly LearnedStats[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT model_id, task_type, scope, observations, success_mass, updated_at
             FROM learned_success
            ORDER BY model_id, task_type, scope`,
        )
        .all() as Record<string, unknown>[];

      return rows.map((row) => ({
        modelId: String(row['model_id']),
        taskType: String(row['task_type']) as TaskType,
        scope: String(row['scope']) as TaskScope,
        observations: Number(row['observations']),
        successMass: Number(row['success_mass']),
        updatedAt: Number(row['updated_at']),
      }));
    } catch (error) {
      this.#onProblem(`Could not load learned statistics: ${describe(error)}`);
      return [];
    }
  }

  /**
   * Insert or replace learned buckets.
   *
   * The caller holds authoritative in-memory counts, so replacing a row is
   * correct and idempotent — re-saving the same snapshot cannot inflate a
   * count, which is what makes a crashed run safe to repeat.
   */
  saveLearnedStats(stats: readonly LearnedStats[]): void {
    if (stats.length === 0) return;

    this.#write('learned statistics', () => {
      const statement = this.#db.prepare(
        `INSERT INTO learned_success
           (model_id, task_type, scope, observations, success_mass, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (model_id, task_type, scope) DO UPDATE SET
           observations = excluded.observations,
           success_mass = excluded.success_mass,
           updated_at   = excluded.updated_at`,
      );

      for (const entry of stats) {
        statement.run(
          entry.modelId,
          entry.taskType,
          entry.scope,
          entry.observations,
          entry.successMass,
          entry.updatedAt,
        );
      }
    });
  }

  // ---- Predictions and calibration (Phase 11) -----------------------------

  /**
   * Append prediction/outcome pairs.
   *
   * Keyed by request and model, so replaying the same request cannot inflate
   * the history that calibration is measured over.
   */
  recordPredictions(records: readonly PredictionRecord[]): void {
    if (records.length === 0) return;

    this.#write('predictions', () => {
      const statement = this.#db.prepare(
        `INSERT INTO predictions
           (request_id, model_id, task_type, scope, predicted, actual, source, observations, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (request_id, model_id) DO UPDATE SET
           predicted    = excluded.predicted,
           actual       = excluded.actual,
           source       = excluded.source,
           observations = excluded.observations,
           at           = excluded.at`,
      );

      for (const record of records) {
        statement.run(
          record.requestId,
          record.modelId,
          record.taskType,
          record.scope,
          record.predicted,
          record.actual,
          record.source,
          record.observations,
          record.at,
        );
      }
    });
  }

  /**
   * Load recent predictions, newest first.
   *
   * A read failure yields an empty list, which the safeguard reads as
   * "unassessed" — the conservative outcome, since it cannot then claim a
   * predictor is well calibrated.
   */
  loadPredictions(limit: number, source?: PredictionSource): readonly PredictionRecord[] {
    try {
      const rows = (
        source === undefined
          ? this.#db
              .prepare(`SELECT * FROM predictions ORDER BY at DESC, request_id DESC LIMIT ?`)
              .all(limit)
          : this.#db
              .prepare(
                `SELECT * FROM predictions WHERE source = ? ORDER BY at DESC, request_id DESC LIMIT ?`,
              )
              .all(source, limit)
      ) as Record<string, unknown>[];

      return rows.map((row) => ({
        requestId: String(row['request_id']),
        modelId: String(row['model_id']),
        taskType: String(row['task_type']) as TaskType,
        scope: String(row['scope']) as TaskScope,
        predicted: Number(row['predicted']),
        actual: Number(row['actual']),
        source: String(row['source']) as PredictionSource,
        observations: Number(row['observations']),
        at: Number(row['at']),
      }));
    } catch (error) {
      this.#onProblem(`Could not load predictions: ${describe(error)}`);
      return [];
    }
  }

  // ---- Shadow decisions (Phase 12) ----------------------------------------

  /**
   * Record what alternative policies would have chosen.
   *
   * Keyed by request and policy, so re-evaluating a request replaces its shadow
   * row rather than inflating the agreement statistics.
   */
  recordShadowDecisions(records: readonly ShadowRecord[]): void {
    if (records.length === 0) return;

    this.#write('shadow decisions', () => {
      const statement = this.#db.prepare(
        `INSERT INTO shadow_decisions
           (request_id, policy_id, current_model_id, shadow_model_id, agrees,
            estimated_cost_delta, success_probability_delta, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (request_id, policy_id) DO UPDATE SET
           current_model_id          = excluded.current_model_id,
           shadow_model_id           = excluded.shadow_model_id,
           agrees                    = excluded.agrees,
           estimated_cost_delta      = excluded.estimated_cost_delta,
           success_probability_delta = excluded.success_probability_delta,
           at                        = excluded.at`,
      );

      for (const record of records) {
        statement.run(
          record.requestId,
          record.policyId,
          record.currentModelId,
          record.shadowModelId,
          record.agrees ? 1 : 0,
          record.estimatedCostDelta,
          record.successProbabilityDelta,
          record.at,
        );
      }
    });
  }

  /** Load recent shadow decisions, newest first. Empty on any read failure. */
  loadShadowDecisions(limit: number, policyId?: string): readonly ShadowRecord[] {
    try {
      const rows = (
        policyId === undefined
          ? this.#db
              .prepare(`SELECT * FROM shadow_decisions ORDER BY at DESC, request_id DESC LIMIT ?`)
              .all(limit)
          : this.#db
              .prepare(
                `SELECT * FROM shadow_decisions WHERE policy_id = ?
                  ORDER BY at DESC, request_id DESC LIMIT ?`,
              )
              .all(policyId, limit)
      ) as Record<string, unknown>[];

      return rows.map((row) => ({
        requestId: String(row['request_id']),
        policyId: String(row['policy_id']),
        currentModelId: nullableString(row['current_model_id']),
        shadowModelId: nullableString(row['shadow_model_id']),
        agrees: toBool(row['agrees']),
        estimatedCostDelta: nullableNumber(row['estimated_cost_delta']),
        successProbabilityDelta: nullableNumber(row['success_probability_delta']),
        at: Number(row['at']),
      }));
    } catch (error) {
      this.#onProblem(`Could not load shadow decisions: ${describe(error)}`);
      return [];
    }
  }

  close(): void {
    try {
      this.#db.close();
    } catch {
      // Closing a database that is already gone is not worth reporting.
    }
  }

  /**
   * Run a write atomically, swallowing any failure.
   *
   * Telemetry is an observer. A locked database, a full disk or a schema
   * mismatch must never propagate into the routing path.
   *
   * The transaction is not only for tidiness. Several writes here are
   * multi-row — a routing decision plus its candidates, a batch of learned
   * buckets, a batch of predictions — and without one, a failure halfway
   * through leaves a decision with some of its candidates, which is worse than
   * recording nothing. It is also dramatically faster: SQLite commits every
   * unwrapped statement separately, so a 250-row batch paid for 250 commits.
   */
  #write(what: string, body: () => void): void {
    let open = false;
    try {
      this.#db.exec('BEGIN');
      open = true;
      body();
      this.#db.exec('COMMIT');
      open = false;
    } catch (error) {
      if (open) {
        try {
          this.#db.exec('ROLLBACK');
        } catch {
          // A rollback that itself fails must not mask the original cause.
        }
      }
      this.#onProblem(`Could not record ${what}: ${describe(error)}`);
    }
  }
}

/** Move an unreadable database aside, returning where it went. */
function quarantine(path: string): string | null {
  if (!existsSync(path)) return null;
  const target = `${path}.corrupt-${String(Date.now())}`;
  try {
    renameSync(path, target);
    return target;
  } catch {
    return null;
  }
}

/** Apply every migration newer than `from`. Returns how many ran. */
function migrate(db: SqliteDatabase, from: number): number {
  let applied = 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    for (const statement of migration.statements) db.exec(statement);
    db.exec(`PRAGMA user_version = ${String(migration.version)}`);
    applied += 1;
  }

  return applied;
}

function readVersion(db: SqliteDatabase): number {
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return row?.user_version ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The real binding.
 *
 * A named function rather than an inline import so the injected form and the
 * production form have the same shape, and so the specifier appears exactly
 * once in the file.
 */
/** Whether an import failure means the module does not exist on this runtime. */
function isMissingModule(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return (
    code === 'ERR_UNKNOWN_BUILTIN_MODULE' ||
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'MODULE_NOT_FOUND'
  );
}

const loadNodeSqlite: SqliteLoader = () => import('node:sqlite');

function toRoutingRecord(row: Record<string, unknown>): RoutingRecord {
  return {
    requestId: String(row['request_id']),
    selectedModelId: typeof row['selected_model_id'] === 'string' ? row['selected_model_id'] : null,
    outcome: String(row['outcome']),
    staticTierPrior: row['static_tier_prior'] as RoutingRecord['staticTierPrior'],
    minimumSuccessProbability: Number(row['minimum_success_probability']),
    maxRisk: Number(row['max_risk']),
    requestBudget: row['request_budget'] === null ? null : Number(row['request_budget']),
    currency: String(row['currency']),
    budgetExceeded: row['budget_exceeded'] === 1,
    candidateCount: Number(row['candidate_count']),
    excludedCount: Number(row['excluded_count']),
    decidedAt: Number(row['decided_at']),
  };
}

function toOutcomeRecord(row: Record<string, unknown>): OutcomeRecord {
  return {
    requestId: String(row['request_id']),
    syntaxValid: fromNullableBool(row['syntax_valid']),
    lintPassed: fromNullableBool(row['lint_passed']),
    buildPassed: fromNullableBool(row['build_passed']),
    testsPassed: fromNullableBool(row['tests_passed']),
    taskCriteriaMet: fromNullableBool(row['task_criteria_met']),
    userAccepted: fromNullableBool(row['user_accepted']),
    userCancelled: row['user_cancelled'] === 1,
    userRePrompted: row['user_reprompted'] === 1,
    userReverted: row['user_reverted'] === 1,
    manualEditRequired: row['manual_edit_required'] === 1,
    escalationCount: Number(row['escalation_count']),
    modelsUsed: parseModelList(row['models_used']),
    totalCost: Number(row['total_cost']),
    currency: String(row['currency']),
    totalLatencyMs: Number(row['total_latency_ms']),
    failureType: (row['failure_type'] ?? null) as OutcomeRecord['failureType'],
    successScore: row['success_score'] === null ? null : Number(row['success_score']),
    evidence: Number(row['evidence']),
    modelAttributable: row['model_attributable'] === 1,
    recordedAt: Number(row['recorded_at']),
  };
}

/** Parse the stored model list, tolerating anything unexpected. */
function parseModelList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // A malformed row is not worth failing a read over.
    return [];
  }
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

function nullableBool(value: boolean | null): number | null {
  return value === null ? null : bool(value);
}

function fromNullableBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return value === 1;
}

/** Read a stored integer flag back as a boolean. */
function toBool(value: unknown): boolean {
  return value === 1;
}

/**
 * Read a nullable text column.
 *
 * `null` survives the round trip rather than becoming the string "null" — the
 * difference between "no model was selected" and a model literally named null.
 */
function nullableString(value: unknown): string | null {
  // Narrowed rather than coerced: a text column yields a string, and anything
  // else means the row is not the shape this code believes it is. Coercing
  // would turn that into "[object Object]" and hide the problem in the data.
  return typeof value === 'string' ? value : null;
}

/** Read a nullable numeric column, keeping `null` distinct from zero. */
function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
