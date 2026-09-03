/**
 * Telemetry schema and migrations.
 *
 * Migrations are an ordered list, applied in sequence, tracked by SQLite's own
 * `user_version` pragma. Two properties matter:
 *
 * - **Forward-only and idempotent.** Applying the list to a fresh database and
 *   to a database at any earlier version must reach the same place.
 * - **Never destructive on upgrade.** A migration may add tables, columns and
 *   indexes. It may not drop a user's recorded history to make a schema tidier.
 *
 * Every text column here holds either an enumerated value, a hash, or an
 * already-redacted summary. No column is intended to hold a prompt, a model
 * response, source code, or an absolute path — the record types in
 * `src/core/types/telemetry.ts` do not carry those fields in the first place.
 */

/** One forward migration. */
export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly statements: readonly string[];
}

/**
 * The migration list.
 *
 * Append only. Editing a released migration would leave existing databases in a
 * state no version number describes.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'initial schema: requests, routing, attempts, events, escalations, outcomes',
    statements: [
      `CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        prompt_length INTEGER NOT NULL,
        prompt_hash TEXT NOT NULL,
        ambiguity REAL NOT NULL,
        risk REAL NOT NULL,
        reasoning_requirement REAL NOT NULL,
        novelty REAL NOT NULL,
        repository_hash TEXT NOT NULL,
        primary_language TEXT,
        file_count INTEGER NOT NULL,
        is_monorepo INTEGER NOT NULL,
        analysis_level INTEGER NOT NULL,
        context_requirement INTEGER NOT NULL,
        estimated_input_tokens INTEGER NOT NULL,
        estimated_output_tokens INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS routing_decisions (
        request_id TEXT PRIMARY KEY,
        selected_model_id TEXT,
        outcome TEXT NOT NULL,
        static_tier_prior TEXT NOT NULL,
        minimum_success_probability REAL NOT NULL,
        max_risk REAL NOT NULL,
        request_budget REAL,
        currency TEXT NOT NULL,
        budget_exceeded INTEGER NOT NULL,
        candidate_count INTEGER NOT NULL,
        excluded_count INTEGER NOT NULL,
        decided_at INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS routing_candidates (
        request_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        success_probability REAL NOT NULL,
        expected_total_cost REAL NOT NULL,
        initial_cost REAL NOT NULL,
        risk REAL NOT NULL,
        estimated_latency_seconds REAL NOT NULL,
        viable INTEGER NOT NULL,
        selected INTEGER NOT NULL,
        used_tier_default INTEGER NOT NULL,
        PRIMARY KEY (request_id, model_id)
      )`,

      `CREATE TABLE IF NOT EXISTS attempts (
        request_id TEXT NOT NULL,
        attempt_index INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        failure_type TEXT,
        error_summary TEXT,
        cost REAL NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        tool_calls INTEGER NOT NULL,
        tool_failures INTEGER NOT NULL,
        files_changed INTEGER NOT NULL,
        struggle_score REAL NOT NULL,
        model_attributable_struggle REAL NOT NULL,
        PRIMARY KEY (request_id, attempt_index)
      )`,

      `CREATE TABLE IF NOT EXISTS execution_events (
        request_id TEXT NOT NULL,
        attempt_index INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tool TEXT,
        ok INTEGER,
        path TEXT,
        PRIMARY KEY (request_id, attempt_index, sequence)
      )`,

      `CREATE TABLE IF NOT EXISTS escalations (
        request_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        action TEXT NOT NULL,
        from_model_id TEXT NOT NULL,
        to_model_id TEXT,
        failure_type TEXT,
        reason TEXT NOT NULL,
        limit_reached TEXT,
        at INTEGER NOT NULL,
        PRIMARY KEY (request_id, sequence)
      )`,

      `CREATE TABLE IF NOT EXISTS outcomes (
        request_id TEXT PRIMARY KEY,
        syntax_valid INTEGER,
        lint_passed INTEGER,
        build_passed INTEGER,
        tests_passed INTEGER,
        task_criteria_met INTEGER,
        user_accepted INTEGER,
        user_cancelled INTEGER NOT NULL,
        user_reprompted INTEGER NOT NULL,
        user_reverted INTEGER NOT NULL,
        manual_edit_required INTEGER NOT NULL,
        escalation_count INTEGER NOT NULL,
        models_used TEXT NOT NULL,
        total_cost REAL NOT NULL,
        currency TEXT NOT NULL,
        total_latency_ms INTEGER NOT NULL,
        failure_type TEXT,
        success_score REAL,
        evidence REAL NOT NULL,
        model_attributable INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS user_signals (
        request_id TEXT NOT NULL,
        signal TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (request_id, signal, at)
      )`,

      `CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_attempts_model ON attempts (model_id)`,
      `CREATE INDEX IF NOT EXISTS idx_outcomes_recorded ON outcomes (recorded_at)`,
    ],
  },
  {
    version: 2,
    description: 'index outcomes by model attribution, for learning queries',
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_outcomes_attributable
         ON outcomes (model_attributable, recorded_at)`,
    ],
  },
  {
    version: 3,
    description: 'learned success statistics (Phase 10)',
    statements: [
      // Stored at the finest granularity only. Coarser views are summed at read
      // time, so one observation is never counted twice and no aggregate can
      // drift out of step with its parts.
      //
      // `observations` is an integer count of real admitted outcomes. Prior
      // pseudo-counts exist only inside the shrinkage arithmetic and are never
      // written here (spec section 2, rule 11).
      `CREATE TABLE IF NOT EXISTS learned_success (
        model_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        observations INTEGER NOT NULL,
        success_mass REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (model_id, task_type, scope)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_learned_model ON learned_success (model_id)`,
    ],
  },
  {
    version: 4,
    description: 'prediction/outcome pairs for calibration (Phase 11)',
    statements: [
      // One row per prediction actually made, paired with what happened. This
      // is append-only history: unlike `learned_success`, which is a running
      // summary, calibration needs the individual pairs or the reliability
      // diagram cannot be rebuilt.
      //
      // `source` separates priors from learned estimates. Pooling them would
      // let well-calibrated priors disguise badly calibrated learned
      // predictions, which is the failure the safeguard exists to catch.
      `CREATE TABLE IF NOT EXISTS predictions (
        request_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        predicted REAL NOT NULL,
        actual REAL NOT NULL,
        source TEXT NOT NULL,
        observations INTEGER NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (request_id, model_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_predictions_source ON predictions (source, at)`,
    ],
  },
  {
    version: 5,
    description: 'shadow policy decisions (Phase 12)',
    statements: [
      // What an alternative policy *would* have chosen. Nothing in this table
      // was ever executed: `shadow_model_id` names a model that was evaluated
      // and not run, which is the whole point of shadow routing.
      //
      // The cost delta is an estimate under the estimates current at the time,
      // never a measured saving — see `src/core/shadow/agreement.ts`.
      `CREATE TABLE IF NOT EXISTS shadow_decisions (
        request_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        current_model_id TEXT,
        shadow_model_id TEXT,
        agrees INTEGER NOT NULL,
        estimated_cost_delta REAL,
        success_probability_delta REAL,
        at INTEGER NOT NULL,
        PRIMARY KEY (request_id, policy_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_shadow_policy ON shadow_decisions (policy_id, at)`,
    ],
  },
  {
    version: 6,
    description: 'language in the learned-success key (Phase 25)',
    statements: [
      // The static predictor already scores a model differently per language
      // via `ModelSpec.priors.languages`, so a model strong in TypeScript and
      // weak in Rust is separated before any evidence exists. The learned
      // posterior did not separate them: it pooled both into one bucket and
      // shrank the language-aware prior toward a language-blind rate, so
      // learning washed out the one dimension static routing had right.
      //
      // SQLite cannot add a column to a primary key, so the table is rebuilt.
      // Existing rows keep their evidence under 'unknown', which is where a
      // language-blind observation honestly belongs; attributing it to a
      // language nobody recorded would be inventing data.
      `ALTER TABLE learned_success RENAME TO learned_success_v5`,
      `CREATE TABLE learned_success (
        model_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        language TEXT NOT NULL,
        observations INTEGER NOT NULL,
        success_mass REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (model_id, task_type, scope, language)
      )`,
      `INSERT INTO learned_success
         (model_id, task_type, scope, language, observations, success_mass, updated_at)
       SELECT model_id, task_type, scope, 'unknown', observations, success_mass, updated_at
       FROM learned_success_v5`,
      `DROP TABLE learned_success_v5`,
      `CREATE INDEX IF NOT EXISTS idx_learned_model ON learned_success (model_id)`,
    ],
  },
];

/** The schema version this build expects. */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
