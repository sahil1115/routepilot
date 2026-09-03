/**
 * Telemetry: persistence, reload, migration, corruption fallback, redaction,
 * and the guarantee that nothing secret is ever stored.
 *
 * The two properties worth stating plainly, because everything else follows
 * from them: **telemetry must never break routing**, and **it must never store
 * a secret**. The tests below try to violate both.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OutcomeRecorder, emptyOutcome } from '../core/outcome/outcome-recorder.js';
import type {
  CandidateRecord,
  EscalationRecord,
  ExecutionAttemptRecord,
  OutcomeRecord,
  RequestRecord,
  RoutingRecord,
} from '../core/types/telemetry.js';
import { assessCalibration } from '../core/calibration/gate.js';
import { calibrationReport, toScored } from '../core/calibration/metrics.js';
import { asRecords, overConfident, wellCalibrated } from '../test-support/calibration-fixtures.js';
import type { LearnedStats } from '../core/types/learning.js';
import type { ShadowRecord } from '../core/types/shadow.js';
import { summariseAgreement } from '../core/shadow/agreement.js';
import { LearnedSuccessModel } from '../core/learning/success-model.js';
import { syntheticObservations } from '../test-support/learning-fixtures.js';
import { NullTelemetryStore } from './null-store.js';
import { openTelemetryStore } from './open.js';
import {
  REDACTED,
  containsLikelySecret,
  redact,
  redactPath,
  redactSummary,
  stableHash,
} from './redaction.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './schema.js';
import { SqliteTelemetryStore } from './sqlite-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routepilot-telemetry-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const open = (options: Record<string, unknown> = {}): Promise<SqliteTelemetryStore> =>
  SqliteTelemetryStore.open({ directory: dir, ...options });

// --- Fixtures --------------------------------------------------------------

function request(id = 'req-1'): RequestRecord {
  return {
    requestId: id,
    createdAt: 1_700_000_000_000,
    taskType: 'bug-fix',
    scope: 'few-files',
    promptLength: 42,
    promptHash: stableHash('fix the parser'),
    ambiguity: 0.3,
    risk: 0.25,
    reasoningRequirement: 0.5,
    novelty: 1,
    repositoryHash: stableHash('/workspace'),
    primaryLanguage: 'typescript',
    fileCount: 120,
    isMonorepo: false,
    analysisLevel: 2,
    contextRequirement: 24_000,
    estimatedInputTokens: 20_000,
    estimatedOutputTokens: 4_000,
  };
}

function routing(id = 'req-1'): RoutingRecord {
  return {
    requestId: id,
    selectedModelId: 'acme/balanced-1',
    outcome: 'selected',
    staticTierPrior: 'medium',
    minimumSuccessProbability: 0.85,
    maxRisk: 0.6,
    requestBudget: 1,
    currency: 'USD',
    budgetExceeded: false,
    candidateCount: 3,
    excludedCount: 1,
    decidedAt: 1_700_000_000_100,
  };
}

function candidate(modelId: string, selected: boolean, id = 'req-1'): CandidateRecord {
  return {
    requestId: id,
    modelId,
    tier: 'medium',
    successProbability: 0.88,
    expectedTotalCost: 0.03,
    initialCost: 0.02,
    risk: 0.16,
    estimatedLatencySeconds: 13,
    viable: true,
    selected,
    usedTierDefault: false,
  };
}

function attempt(overrides: Partial<ExecutionAttemptRecord> = {}): ExecutionAttemptRecord {
  return {
    requestId: 'req-1',
    attemptIndex: 0,
    modelId: 'acme/balanced-1',
    providerId: 'acme',
    adapterId: 'fake',
    startedAt: 1_700_000_000_200,
    durationMs: 12_000,
    status: 'failed',
    failureType: 'TOOL_FAILURE',
    errorSummary: 'edit did not apply',
    cost: 0.021,
    inputTokens: 20_000,
    outputTokens: 3_800,
    cachedInputTokens: null,
    toolCalls: 4,
    toolFailures: 1,
    filesChanged: 2,
    struggleScore: 0.2,
    modelAttributableStruggle: 0.1,
    ...overrides,
  };
}

function outcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    requestId: 'req-1',
    syntaxValid: true,
    lintPassed: null,
    buildPassed: true,
    testsPassed: false,
    taskCriteriaMet: null,
    userAccepted: null,
    userCancelled: false,
    userRePrompted: false,
    userReverted: false,
    manualEditRequired: false,
    escalationCount: 1,
    modelsUsed: ['acme/fast-1', 'acme/balanced-1'],
    totalCost: 0.043,
    currency: 'USD',
    totalLatencyMs: 25_000,
    failureType: 'MODEL_WEAKNESS',
    successScore: 0.5,
    evidence: 0.6,
    modelAttributable: true,
    recordedAt: 1_700_000_001_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('records everything the phase requires', async () => {
    const store = await open();

    store.recordRequest(request());
    store.recordRouting(routing(), [
      candidate('acme/fast-1', false),
      candidate('acme/balanced-1', true),
    ]);
    store.recordAttempt(attempt());
    store.recordEvents([
      {
        requestId: 'req-1',
        attemptIndex: 0,
        sequence: 0,
        kind: 'tool-call',
        timestamp: 1,
        tool: 'Edit',
        ok: null,
        path: null,
      },
      {
        requestId: 'req-1',
        attemptIndex: 0,
        sequence: 1,
        kind: 'file-change',
        timestamp: 2,
        tool: null,
        ok: true,
        path: 'src/a.ts',
      },
    ]);
    store.recordEscalation({
      requestId: 'req-1',
      sequence: 0,
      action: 'escalate-vertical',
      fromModelId: 'acme/fast-1',
      toModelId: 'acme/balanced-1',
      failureType: 'MODEL_WEAKNESS',
      reason: 'repeated failures',
      limitReached: null,
      at: 3,
    } satisfies EscalationRecord);
    store.recordOutcome(outcome());
    store.recordUserSignal({ requestId: 'req-1', signal: 'reverted', at: 4 });

    const stats = store.statistics();
    expect(stats.requests).toBe(1);
    expect(stats.attempts).toBe(1);
    expect(stats.outcomes).toBe(1);
    expect(stats.escalations).toBe(1);
    expect(stats.modelAttributableOutcomes).toBe(1);
    expect(stats.totalCost).toBeCloseTo(0.043, 6);

    store.close();
  });

  it('creates the database file on disk', async () => {
    const store = await open();
    store.recordRequest(request());
    store.close();

    expect(existsSync(store.path)).toBe(true);
  });

  it('records cost, latency, failure type and escalation on the outcome', async () => {
    const store = await open();
    store.recordOutcome(outcome());

    const [recorded] = store.recentOutcomes(1);
    expect(recorded?.totalCost).toBeCloseTo(0.043, 6);
    expect(recorded?.totalLatencyMs).toBe(25_000);
    expect(recorded?.failureType).toBe('MODEL_WEAKNESS');
    expect(recorded?.escalationCount).toBe(1);
    expect(recorded?.modelsUsed).toEqual(['acme/fast-1', 'acme/balanced-1']);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

describe('reload', () => {
  it('reads back what a previous session wrote', async () => {
    const first = await open();
    first.recordRequest(request());
    first.recordOutcome(outcome());
    first.close();

    const second = await open();
    expect(second.statistics().requests).toBe(1);
    expect(second.recentOutcomes(10)).toHaveLength(1);
    second.close();
  });

  it('round-trips every field of an outcome unchanged', async () => {
    const first = await open();
    const original = outcome();
    first.recordOutcome(original);
    first.close();

    const second = await open();
    const [reloaded] = second.recentOutcomes(1);
    second.close();

    expect(reloaded).toEqual(original);
  });

  it('preserves the difference between false and not-evaluated', async () => {
    // `null` must survive the round trip. Reading it back as `false` would turn
    // "nobody checked" into "it failed".
    const first = await open();
    first.recordOutcome(outcome({ lintPassed: null, testsPassed: false, successScore: null }));
    first.close();

    const second = await open();
    const [reloaded] = second.recentOutcomes(1);
    second.close();

    expect(reloaded?.lintPassed).toBeNull();
    expect(reloaded?.testsPassed).toBe(false);
    expect(reloaded?.successScore).toBeNull();
  });

  it('returns outcomes newest first', async () => {
    const store = await open();
    store.recordOutcome(outcome({ requestId: 'a', recordedAt: 100 }));
    store.recordOutcome(outcome({ requestId: 'b', recordedAt: 300 }));
    store.recordOutcome(outcome({ requestId: 'c', recordedAt: 200 }));

    expect(store.recentOutcomes(10).map((o) => o.requestId)).toEqual(['b', 'c', 'a']);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('migration', () => {
  it('applies every migration to a fresh database', async () => {
    const store = await open();

    expect(store.report.previousVersion).toBe(0);
    expect(store.report.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.report.migrationsApplied).toBe(MIGRATIONS.length);

    store.close();
  });

  it('applies nothing on reopening an up-to-date database', async () => {
    (await open()).close();
    const second = await open();

    expect(second.report.previousVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(second.report.migrationsApplied).toBe(0);

    second.close();
  });

  it('upgrades a database left at an older version, keeping its data', async () => {
    const first = await open();
    first.recordOutcome(outcome());
    // Rewind the recorded version, as if written by an older build.
    const db = new (await import('node:sqlite')).DatabaseSync(first.path);
    db.exec('PRAGMA user_version = 1');
    db.close();
    first.close();

    const second = await open();

    expect(second.report.previousVersion).toBe(1);
    expect(second.report.migrationsApplied).toBe(MIGRATIONS.length - 1);
    expect(second.report.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
    // The upgrade must not discard history.
    expect(second.recentOutcomes(10)).toHaveLength(1);

    second.close();
  });

  it('has strictly increasing, gap-free migration versions', () => {
    MIGRATIONS.forEach((migration, index) => {
      expect(migration.version).toBe(index + 1);
      expect(migration.description.length).toBeGreaterThan(5);
      expect(migration.statements.length).toBeGreaterThan(0);
    });
  });

  it('is idempotent: every migration can be applied twice', async () => {
    const store = await open();
    const db = new (await import('node:sqlite')).DatabaseSync(store.path);

    // Re-running the statements must not throw; they are all IF NOT EXISTS.
    for (const migration of MIGRATIONS) {
      for (const statement of migration.statements) {
        expect(() => {
          db.exec(statement);
        }).not.toThrow();
      }
    }

    db.close();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Corruption fallback
// ---------------------------------------------------------------------------

describe('corruption fallback', () => {
  it('quarantines an unreadable database and carries on', async () => {
    const path = join(dir, 'routepilot.sqlite');
    await writeFile(path, 'this is definitely not a sqlite database', 'utf8');

    const problems: string[] = [];
    const store = await open({ onProblem: (m: string) => problems.push(m) });

    // A fresh, working database took its place.
    store.recordOutcome(outcome());
    expect(store.statistics().outcomes).toBe(1);

    expect(store.report.quarantinedTo).not.toBeNull();
    expect(problems.join('\n')).toContain('moved to');
    expect(problems.join('\n')).toContain('routing is unaffected');

    // The damaged file was preserved rather than deleted.
    expect(readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);

    store.close();
  });

  it('never lets a failed write escape into the caller', async () => {
    const problems: string[] = [];
    const store = await open({ onProblem: (m: string) => problems.push(m) });
    store.close();

    // Writing after close would throw from the driver; it must be swallowed.
    expect(() => {
      store.recordOutcome(outcome());
    }).not.toThrow();
    expect(problems.length).toBeGreaterThan(0);
  });

  it('degrades to a no-op store when the database cannot be opened at all', async () => {
    // A path that cannot be a directory: the file at that path is not one.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x', 'utf8');

    const problems: string[] = [];
    const store = await openTelemetryStore({
      enabled: true,
      storagePath: join(blocker, 'nested'),
      onProblem: (m) => problems.push(m),
    });

    expect(store.enabled).toBe(false);
    expect(problems.join('\n')).toContain('Routing is unaffected');
    // Still usable: every method is safe to call.
    expect(() => {
      store.recordOutcome(outcome());
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Redaction and secrets
// ---------------------------------------------------------------------------

describe('privacy redaction', () => {
  const secrets = [
    'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG',
    'sk-proj-1234567890abcdefghijklmnop',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    'AKIAIOSFODNN7EXAMPLE',
    'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'postgres://admin:hunter2@db.internal:5432/app',
  ];

  it.each(secrets)('removes %s', (secret) => {
    const scrubbed = redact(`error while calling API with ${secret} at line 3`);

    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain(REDACTED);
  });

  it('removes a PEM private key block', () => {
    const key =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----';

    expect(redact(`config contained ${key}`)).not.toContain('MIIEowIBAAKCAQEA1234');
  });

  it('keeps the variable name but removes the value in an assignment', () => {
    // The name is useful for debugging; the value never is.
    const scrubbed = redact('ANTHROPIC_API_KEY=abcd1234efgh5678');

    expect(scrubbed).toContain('ANTHROPIC_API_KEY');
    expect(scrubbed).not.toContain('abcd1234efgh5678');
  });

  it.each([
    ['DATABASE_PASSWORD=hunter2xyz', 'hunter2xyz'],
    ['my_secret: topsecretvalue', 'topsecretvalue'],
    ['AUTH_TOKEN = "bearer-ish-value-123"', 'bearer-ish-value-123'],
  ])('removes the value from %s', (line, value) => {
    expect(redact(line)).not.toContain(value);
  });

  it('leaves ordinary text alone', () => {
    const text = 'tests failed: expected 3 to be 4 in src/parser.test.ts';
    expect(redact(text)).toBe(text);
  });

  it('truncates long summaries', () => {
    expect((redactSummary('x'.repeat(2_000)) ?? '').length).toBeLessThan(520);
  });

  it('reduces an absolute path to a relative one', () => {
    // Absolute paths leak the user's directory layout and username.
    expect(
      redactPath('C:/Users/someone/projects/app/src/a.ts', 'C:/Users/someone/projects/app'),
    ).toBe('src/a.ts');
    expect(redactPath('/home/someone/app/src/a.ts', '/home/someone/app')).toBe('src/a.ts');
  });

  it('reduces an unrelated absolute path to its basename', () => {
    expect(redactPath('/home/someone/secrets/.env')).toBe('.env');
    expect(redactPath('C:/Users/someone/secret.key')).toBe('secret.key');
  });

  it('hashes stably and irreversibly enough for grouping', () => {
    expect(stableHash('/workspace')).toBe(stableHash('/workspace'));
    expect(stableHash('/workspace')).not.toBe(stableHash('/other'));
    expect(stableHash('/workspace')).not.toContain('workspace');
  });

  it('detects a leaked secret, for use as an assertion', () => {
    expect(containsLikelySecret('sk-ant-api03-AAAABBBBCCCCDDDDEEEE')).toBe(true);
    expect(containsLikelySecret('nothing to see here')).toBe(false);
    expect(containsLikelySecret(redact('sk-ant-api03-AAAABBBBCCCCDDDDEEEE'))).toBe(false);
  });
});

describe('no secrets are stored', () => {
  it('scrubs a credential that reaches an attempt summary', async () => {
    const store = await open();
    const secret = 'sk-ant-api03-SUPERSECRETVALUE12345';

    store.recordAttempt(
      attempt({ errorSummary: `request failed with x-api-key: ${secret} (401)` }),
    );
    store.close();

    const bytes = await readFile(join(dir, 'routepilot.sqlite'), 'utf8').catch(() =>
      readFile(join(dir, 'routepilot.sqlite'), 'latin1'),
    );

    // The decisive assertion: the secret is not in the file on disk.
    expect(bytes).not.toContain(secret);
    expect(bytes).toContain(REDACTED);
  });

  it('stores no absolute path from an event', async () => {
    const store = await open({ workspaceRoot: '/home/someone/app' });
    store.recordEvents([
      {
        requestId: 'req-1',
        attemptIndex: 0,
        sequence: 0,
        kind: 'file-change',
        timestamp: 1,
        tool: null,
        ok: true,
        path: '/home/someone/app/src/a.ts',
      },
    ]);
    store.close();

    const bytes = await readFile(join(dir, 'routepilot.sqlite'), 'latin1');
    expect(bytes).not.toContain('/home/someone');
    expect(bytes).toContain('src/a.ts');
  });

  it('has no field anywhere for a prompt or a model response', () => {
    // Structural, not a scrubbing rule: the record types simply have no such
    // field, so no implementation can store one by mistake.
    const record = request();
    expect(Object.keys(record)).not.toContain('prompt');
    expect(Object.keys(record)).not.toContain('response');
    expect(Object.keys(record)).toContain('promptHash');
    expect(Object.keys(record)).toContain('promptLength');
  });

  it('stores a hash of the workspace root, not the root itself', async () => {
    const store = await open();
    store.recordRequest(request());
    store.close();

    const bytes = await readFile(join(dir, 'routepilot.sqlite'), 'latin1');
    expect(bytes).not.toContain('/workspace');
    expect(bytes).toContain(stableHash('/workspace'));
  });
});

// ---------------------------------------------------------------------------
// Disabling telemetry
// ---------------------------------------------------------------------------

describe('telemetry can be disabled', () => {
  it('returns a store that keeps nothing', async () => {
    const store = await openTelemetryStore({ enabled: false, storagePath: dir });

    expect(store.enabled).toBe(false);
    store.recordRequest(request());
    store.recordOutcome(outcome());

    expect(store.statistics().requests).toBe(0);
    expect(store.recentOutcomes(10)).toEqual([]);
  });

  it('writes no file at all when disabled', async () => {
    const store = await openTelemetryStore({ enabled: false, storagePath: dir });
    store.recordRequest(request());
    store.close();

    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('accepts every call without throwing', () => {
    const store = new NullTelemetryStore();

    expect(() => {
      store.recordRequest(request());
      store.recordRouting(routing(), [candidate('acme/fast-1', true)]);
      store.recordAttempt(attempt());
      store.recordEvents([]);
      store.recordEscalation({
        requestId: 'r',
        sequence: 0,
        action: 'retry',
        fromModelId: 'a',
        toModelId: null,
        failureType: null,
        reason: 'x',
        limitReached: null,
        at: 0,
      });
      store.recordOutcome(outcome());
      store.recordUserSignal({ requestId: 'r', signal: 'accepted', at: 0 });
      store.close();
    }).not.toThrow();
  });

  it('never loads the sqlite driver when disabled', async () => {
    // node:sqlite is experimental and warns on import, so a disabled build
    // must not touch it. A NullTelemetryStore proves the lazy import was not
    // reached.
    const store = await openTelemetryStore({ enabled: false });
    expect(store).toBeInstanceOf(NullTelemetryStore);
  });
});

// ---------------------------------------------------------------------------
// Outcome scoring
// ---------------------------------------------------------------------------

describe('OutcomeRecorder', () => {
  const recorder = new OutcomeRecorder();

  it('scores a fully passing outcome at 1', () => {
    const score = recorder.score(
      emptyOutcome('r', {
        syntaxValid: true,
        lintPassed: true,
        buildPassed: true,
        testsPassed: true,
        taskCriteriaMet: true,
        userAccepted: true,
      }),
    );

    expect(score.score).toBe(1);
    expect(score.evidence).toBe(1);
  });

  it('returns null, not zero, when nothing was evaluated', () => {
    // A task nobody checked has an unknown outcome. Recording it as a failure
    // would corrupt learning.
    const score = recorder.score(emptyOutcome('r'));

    expect(score.score).toBeNull();
    expect(score.evidence).toBe(0);
  });

  it('reports how much evidence backed the score', () => {
    const thin = recorder.score(emptyOutcome('r', { syntaxValid: true }));
    const thick = recorder.score(
      emptyOutcome('r', {
        syntaxValid: true,
        buildPassed: true,
        testsPassed: true,
        taskCriteriaMet: true,
      }),
    );

    expect(thin.score).toBe(1);
    expect(thick.score).toBe(1);
    // Same score, very different confidence in it.
    expect(thin.evidence).toBeLessThan(thick.evidence);
  });

  it('does not let an unevaluated dimension count as a pass', () => {
    const passing = recorder.score(emptyOutcome('r', { testsPassed: true }));
    const failing = recorder.score(emptyOutcome('r', { testsPassed: false }));

    expect(passing.score).toBe(1);
    expect(failing.score).toBe(0);
  });

  it('weights tests and task criteria above lint', () => {
    const lintOnly = recorder.score(
      emptyOutcome('r', { lintPassed: false, testsPassed: true, buildPassed: true }),
    );
    const testsOnly = recorder.score(
      emptyOutcome('r', { lintPassed: true, testsPassed: false, buildPassed: true }),
    );

    expect(lintOnly.score).toBeGreaterThan(testsOnly.score ?? 1);
  });

  it('penalises a reverted or hand-edited result', () => {
    const clean = recorder.score(emptyOutcome('r', { testsPassed: true }));
    const reverted = recorder.score(emptyOutcome('r', { testsPassed: true, userReverted: true }));

    expect(reverted.score).toBeLessThan(clean.score ?? 1);
  });

  it('does not treat cancellation as failure', () => {
    // Spec section 32: a user pressing stop is not a negative signal about the
    // model. They may have changed their mind or been interrupted.
    const cancelled = recorder.score(emptyOutcome('r', { testsPassed: true, userCancelled: true }));
    const notCancelled = recorder.score(emptyOutcome('r', { testsPassed: true }));

    expect(cancelled.score).toBe(notCancelled.score);
    // But it is excluded from anything that could update model beliefs.
    expect(cancelled.modelAttributable).toBe(false);
  });

  it('excludes environment failures from model attribution', () => {
    expect(
      recorder.score(emptyOutcome('r', { testsPassed: false, failureType: 'ENVIRONMENT_FAILURE' }))
        .modelAttributable,
    ).toBe(false);

    expect(
      recorder.score(emptyOutcome('r', { testsPassed: false, failureType: 'MODEL_WEAKNESS' }))
        .modelAttributable,
    ).toBe(true);
  });

  it('explains each contributing dimension', () => {
    const score = recorder.score(emptyOutcome('r', { testsPassed: false, buildPassed: true }));

    expect(score.contributions).toHaveLength(2);
    for (const contribution of score.contributions) {
      expect(contribution.reason.length).toBeGreaterThan(5);
      expect(contribution.weight).toBeGreaterThan(0);
    }
  });

  it('lists the user signals an outcome represents', () => {
    const signals = OutcomeRecorder.signalsFrom(
      emptyOutcome('r', { userReverted: true, userCancelled: true, userAccepted: true }),
    );

    expect(signals).toContain('reverted');
    expect(signals).toContain('cancelled');
    expect(signals).toContain('accepted');
  });

  it('classifies which signals are negative', () => {
    expect(OutcomeRecorder.isNegative('reverted')).toBe(true);
    expect(OutcomeRecorder.isNegative('re-prompted')).toBe(true);
    // Cancellation is not evidence of a bad result.
    expect(OutcomeRecorder.isNegative('cancelled')).toBe(false);
    expect(OutcomeRecorder.isNegative('accepted')).toBe(false);
  });

  it('keeps the score inside [0, 1] under heavy penalties', () => {
    const score = recorder.score(
      emptyOutcome('r', {
        testsPassed: false,
        buildPassed: false,
        userReverted: true,
        userRePrompted: true,
        manualEditRequired: true,
      }),
    );

    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(1);
  });
});

describe('absolute paths never reach storage', () => {
  it('strips an absolute path embedded in error text', () => {
    // Found by running the store for real: `redactPath` guards path *fields*,
    // but a stack trace or compiler message embeds a path inside prose, and
    // that text was reaching disk intact.
    const scrubbed = redact('failed at /home/someone/app/src/a.ts line 3');

    expect(scrubbed).not.toContain('/home/someone');
    expect(scrubbed).toContain('a.ts');
  });

  it('strips a Windows absolute path from error text', () => {
    const scrubbed = redact('ENOENT: C:\\Users\\someone\\projects\\app\\src\\a.ts not found');

    expect(scrubbed).not.toContain('Users');
    expect(scrubbed).not.toContain('someone');
    expect(scrubbed).toContain('a.ts');
  });

  it('leaves relative paths alone', () => {
    expect(redact('failed in src/parser.ts')).toContain('src/parser.ts');
    expect(redact('see ./docs/README.md')).toContain('docs/README.md');
  });

  it('does not mangle ordinary prose containing a slash', () => {
    expect(redact('either and/or is fine')).toBe('either and/or is fine');
  });

  it('keeps no absolute path in the database file', async () => {
    const store = await open({ workspaceRoot: '/home/someone/app' });
    store.recordAttempt(
      attempt({ errorSummary: 'auth failed at /home/someone/app/src/a.ts (401)' }),
    );
    store.close();

    const bytes = await readFile(join(dir, 'routepilot.sqlite'), 'latin1');
    expect(bytes).not.toContain('/home/someone');
    expect(bytes).toContain('a.ts');
  });
});

// ---------------------------------------------------------------------------
// Learned statistics (Phase 10)
// ---------------------------------------------------------------------------

describe('learned statistics persistence', () => {
  const stats = (overrides: Partial<LearnedStats> = {}): LearnedStats => ({
    modelId: 'acme/one',
    taskType: 'feature-implementation',
    scope: 'few-files',
    language: 'unknown',
    observations: 30,
    successMass: 21,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  });

  it('persists and reloads a bucket unchanged', async () => {
    const first = await open();
    first.saveLearnedStats([stats()]);
    first.close();

    const second = await open();
    expect(second.loadLearnedStats()).toEqual([stats()]);
    second.close();
  });

  it('survives a full model round trip through a real database file', async () => {
    // The end-to-end requirement: train, close, reopen, and get the same
    // estimate. Everything else in this phase is theory until this passes.
    const first = await open();
    const trainer = new LearnedSuccessModel(first, { enabled: true, minimumTrainingSamples: 20 });
    trainer.observeAll(syntheticObservations('acme/one', 40, { rate: 0.25 }), 1_700_000_000_000);
    const before = trainer.estimate(0.9, {
      modelId: 'acme/one',
      taskType: 'feature-implementation',
      scope: 'few-files',
      language: 'unknown',
    });
    first.close();

    const second = await open();
    const reloaded = new LearnedSuccessModel(second, {
      enabled: true,
      minimumTrainingSamples: 20,
    });
    const after = reloaded.estimate(0.9, {
      modelId: 'acme/one',
      taskType: 'feature-implementation',
      scope: 'few-files',
      language: 'unknown',
    });
    second.close();

    expect(after).toEqual(before);
    expect(after.observations).toBe(40);
  });

  it('replaces a bucket rather than accumulating duplicates', async () => {
    const store = await open();
    store.saveLearnedStats([stats({ observations: 10, successMass: 4 })]);
    store.saveLearnedStats([stats({ observations: 20, successMass: 9 })]);

    const rows = store.loadLearnedStats();
    store.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.observations).toBe(20);
  });

  it('keeps buckets separate across models, task types and scopes', async () => {
    const store = await open();
    store.saveLearnedStats([
      stats(),
      stats({ modelId: 'acme/two' }),
      stats({ taskType: 'bug-fix' }),
      stats({ scope: 'many-files' }),
    ]);

    const rows = store.loadLearnedStats();
    store.close();

    expect(rows).toHaveLength(4);
  });

  it('returns a stable order, so a reload is deterministic', async () => {
    const store = await open();
    store.saveLearnedStats([
      stats({ modelId: 'acme/z' }),
      stats({ modelId: 'acme/a' }),
      stats({ modelId: 'acme/m' }),
    ]);

    const ids = store.loadLearnedStats().map((row) => row.modelId);
    store.close();

    expect(ids).toEqual(['acme/a', 'acme/m', 'acme/z']);
  });

  it('is created by a migration, so an existing database gains it on upgrade', async () => {
    // Phase 8 databases have no learned_success table. Opening one with this
    // build must add it without touching the recorded history.
    const store = await open();
    store.recordRequest(request());
    store.close();

    const upgraded = await open();
    upgraded.saveLearnedStats([stats()]);
    const rows = upgraded.loadLearnedStats();
    const counts = upgraded.statistics();
    upgraded.close();

    expect(rows).toHaveLength(1);
    expect(counts.requests).toBe(1);
  });

  it('stores no prompt, path or source text', async () => {
    // The table holds a model id, two enumerated values and three numbers.
    // There is nowhere for user content to hide, and this asserts it against
    // the bytes on disk rather than against the schema.
    const store = await open();
    store.saveLearnedStats([stats()]);
    store.close();

    const bytes = await readFile(join(dir, 'routepilot.sqlite'), 'latin1');
    const table = bytes.slice(bytes.indexOf('learned_success'));
    expect(table).not.toMatch(/[A-Za-z]:\\/);
    expect(table).not.toContain('/home/');
  });

  it('reports empty rather than throwing when learning has never run', async () => {
    const store = await open();
    expect(store.loadLearnedStats()).toEqual([]);
    store.close();
  });

  it('is empty and harmless on the null store', () => {
    // Telemetry off means learning has nothing to read and nothing to write,
    // and neither is an error (spec section 2, rules 16 and 17).
    const store = new NullTelemetryStore();
    store.saveLearnedStats([stats()]);

    expect(store.loadLearnedStats()).toEqual([]);
    expect(
      new LearnedSuccessModel(store, { enabled: true, minimumTrainingSamples: 1 })
        .totalObservations,
    ).toBe(0);
  });

  it('does not fail a save when the database has been closed underneath it', async () => {
    // A write failure must be swallowed: learning is an observer, exactly as
    // telemetry is.
    const problems: string[] = [];
    const store = await open({ onProblem: (m: string) => problems.push(m) });
    store.close();

    expect(() => {
      store.saveLearnedStats([stats()]);
    }).not.toThrow();
    expect(problems.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Predictions and calibration (Phase 11)
// ---------------------------------------------------------------------------

describe('prediction persistence', () => {
  it('persists and reloads a prediction unchanged', async () => {
    const records = asRecords(overConfident(5));
    const first = await open();
    first.recordPredictions(records);
    first.close();

    const second = await open();
    const loaded = second.loadPredictions(100);
    second.close();

    expect(loaded).toHaveLength(5);
    expect([...loaded].sort((a, b) => a.requestId.localeCompare(b.requestId))).toEqual(records);
  });

  it('rebuilds the same calibration report after a reload', async () => {
    // The end-to-end requirement: metrics computed from a real database file
    // must match metrics computed in memory, or none of this is measurable.
    const records = asRecords(wellCalibrated());
    const before = calibrationReport(toScored(records));

    const store = await open();
    store.recordPredictions(records);
    const after = calibrationReport(toScored(store.loadPredictions(1000)));
    store.close();

    // Compared to a tolerance, not for exact equality: the store returns rows
    // newest-first, so the sums accumulate in a different order and floating
    // point addition is not associative. The differences are around 1e-16,
    // fifteen orders of magnitude below the smallest gate threshold.
    expect(after.count).toBe(before.count);
    expect(after.brierScore).toBeCloseTo(before.brierScore, 12);
    expect(after.expectedCalibrationError).toBeCloseTo(before.expectedCalibrationError, 12);
    expect(after.maximumCalibrationError).toBeCloseTo(before.maximumCalibrationError, 12);
    expect(after.resolution).toBeCloseTo(before.resolution, 12);
    expect(after.brierSkillScore ?? 0).toBeCloseTo(before.brierSkillScore ?? 0, 12);
    expect(after.bins.map((bin) => bin.count)).toEqual(before.bins.map((bin) => bin.count));
  });

  it('separates learned predictions from priors', async () => {
    // Pooling them would let good priors disguise bad learning, which is the
    // failure the safeguard exists to catch.
    const store = await open();
    store.recordPredictions([
      ...asRecords(wellCalibrated(), { source: 'prior' }),
      ...asRecords(overConfident(60), { source: 'learned' }).map((record, index) => ({
        ...record,
        requestId: `learned-${String(index)}`,
      })),
    ]);

    const learned = store.loadPredictions(1000, 'learned');
    const priors = store.loadPredictions(1000, 'prior');
    store.close();

    expect(learned).toHaveLength(60);
    expect(priors).toHaveLength(250);
    expect(assessCalibration(toScored(learned)).status).toBe('distrusted');
    expect(assessCalibration(toScored(priors)).status).toBe('trusted');
  });

  it('replaces a repeated request rather than counting it twice', async () => {
    const [record] = asRecords(overConfident(5));
    if (record === undefined) throw new Error('fixture');

    const store = await open();
    store.recordPredictions([record]);
    store.recordPredictions([{ ...record, actual: 0 }]);

    const loaded = store.loadPredictions(100);
    store.close();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.actual).toBe(0);
  });

  it('returns the newest first, and honours the limit', async () => {
    const store = await open();
    store.recordPredictions(asRecords(overConfident(10)));

    const loaded = store.loadPredictions(3);
    store.close();

    expect(loaded).toHaveLength(3);
    expect(loaded[0]?.at).toBeGreaterThan(loaded[2]?.at ?? 0);
  });

  it('is created by a migration, leaving earlier history intact', async () => {
    const store = await open();
    store.recordRequest(request());
    store.close();

    const upgraded = await open();
    upgraded.recordPredictions(asRecords(overConfident(5)));
    const loaded = upgraded.loadPredictions(10);
    const counts = upgraded.statistics();
    upgraded.close();

    expect(loaded).toHaveLength(5);
    expect(counts.requests).toBe(1);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
  });

  it('stores no prompt, path or source text', async () => {
    const store = await open();
    store.recordPredictions(asRecords(overConfident(5)));
    store.close();

    const bytes = await readFile(join(dir, 'routepilot.sqlite'), 'latin1');
    const table = bytes.slice(bytes.indexOf('predictions'));
    expect(table).not.toMatch(/[A-Za-z]:\\/);
    expect(table).not.toContain('/home/');
  });

  it('reports empty rather than throwing when nothing has been predicted', async () => {
    const store = await open();
    expect(store.loadPredictions(100)).toEqual([]);
    store.close();
  });

  it('reads an empty history as unassessed, never as well calibrated', async () => {
    // The conservative direction. A store that returns nothing must not let a
    // predictor claim it has been checked.
    const store = await open();
    const verdict = assessCalibration(toScored(store.loadPredictions(1000)));
    store.close();

    expect(verdict.status).toBe('unassessed');
    expect(verdict.report).toBeNull();
  });

  it('is empty and harmless on the null store', () => {
    const store = new NullTelemetryStore();
    store.recordPredictions(asRecords(overConfident(5)));

    expect(store.loadPredictions()).toEqual([]);
  });

  it('swallows a write against a closed database', async () => {
    const problems: string[] = [];
    const store = await open({ onProblem: (m: string) => problems.push(m) });
    store.close();

    expect(() => {
      store.recordPredictions(asRecords(overConfident(5)));
    }).not.toThrow();
    expect(problems.length).toBeGreaterThan(0);
  });

  it('returns an empty list rather than throwing on a failed read', async () => {
    const problems: string[] = [];
    const store = await open({ onProblem: (m: string) => problems.push(m) });
    store.close();

    expect(store.loadPredictions(10)).toEqual([]);
    expect(problems.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Shadow decisions (Phase 12)
// ---------------------------------------------------------------------------

describe('shadow decision persistence', () => {
  const shadowRecord = (overrides: Partial<ShadowRecord> = {}): ShadowRecord => ({
    requestId: 'req-1',
    policyId: 'cheapest-first',
    currentModelId: 'acme/balanced-1',
    shadowModelId: 'acme/fast-1',
    agrees: false,
    estimatedCostDelta: -0.05,
    successProbabilityDelta: -0.12,
    at: 1_700_000_000_000,
    ...overrides,
  });

  it('persists and reloads a decision unchanged', async () => {
    const first = await open();
    first.recordShadowDecisions([shadowRecord()]);
    first.close();

    const second = await open();
    const loaded = second.loadShadowDecisions(100);
    second.close();

    expect(loaded).toEqual([shadowRecord()]);
  });

  it('keeps null distinct from zero for a policy that would have stopped', async () => {
    // A stopped policy has no cost. Storing null as 0 would make "do nothing"
    // look like the cheapest policy on offer.
    const store = await open();
    store.recordShadowDecisions([
      shadowRecord({
        requestId: 'stopped',
        shadowModelId: null,
        estimatedCostDelta: null,
        successProbabilityDelta: null,
      }),
    ]);

    const loaded = store.loadShadowDecisions(10);
    store.close();

    expect(loaded[0]?.shadowModelId).toBeNull();
    expect(loaded[0]?.estimatedCostDelta).toBeNull();
    expect(loaded[0]?.successProbabilityDelta).toBeNull();
  });

  it('keeps a null current model distinct too', async () => {
    const store = await open();
    store.recordShadowDecisions([shadowRecord({ currentModelId: null })]);

    const loaded = store.loadShadowDecisions(10);
    store.close();

    expect(loaded[0]?.currentModelId).toBeNull();
  });

  it('round-trips the agreement flag as a boolean', async () => {
    const store = await open();
    store.recordShadowDecisions([
      shadowRecord({ requestId: 'a', agrees: true }),
      shadowRecord({ requestId: 'b', agrees: false }),
    ]);

    const loaded = store.loadShadowDecisions(10);
    store.close();

    expect(loaded.map((row) => row.agrees).sort()).toEqual([false, true]);
  });

  it('replaces a re-evaluated request rather than inflating agreement', async () => {
    const store = await open();
    store.recordShadowDecisions([shadowRecord({ agrees: false })]);
    store.recordShadowDecisions([shadowRecord({ agrees: true, shadowModelId: 'acme/balanced-1' })]);

    const loaded = store.loadShadowDecisions(10);
    store.close();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.agrees).toBe(true);
  });

  it('keeps policies separate for the same request', async () => {
    const store = await open();
    store.recordShadowDecisions([
      shadowRecord({ policyId: 'cheapest-first' }),
      shadowRecord({ policyId: 'strongest-first', shadowModelId: 'acme/deep-1' }),
    ]);

    const loaded = store.loadShadowDecisions(10);
    store.close();

    expect(loaded).toHaveLength(2);
  });

  it('filters by policy', async () => {
    const store = await open();
    store.recordShadowDecisions([
      shadowRecord({ requestId: 'a', policyId: 'cheapest-first' }),
      shadowRecord({ requestId: 'b', policyId: 'strongest-first' }),
      shadowRecord({ requestId: 'c', policyId: 'strongest-first' }),
    ]);

    const strongest = store.loadShadowDecisions(10, 'strongest-first');
    store.close();

    expect(strongest).toHaveLength(2);
    expect(strongest.every((row) => row.policyId === 'strongest-first')).toBe(true);
  });

  it('rebuilds the same agreement summary after a reload', async () => {
    const records = Array.from({ length: 10 }, (_unused, index) =>
      shadowRecord({
        requestId: `req-${String(index)}`,
        agrees: index < 6,
        shadowModelId: index < 6 ? 'acme/balanced-1' : 'acme/fast-1',
        estimatedCostDelta: index < 6 ? 0 : -0.05,
      }),
    );
    const before = summariseAgreement(records);

    const store = await open();
    store.recordShadowDecisions(records);
    const after = summariseAgreement([...store.loadShadowDecisions(100)].reverse());
    store.close();

    expect(after[0]?.agreementRate).toBeCloseTo(before[0]?.agreementRate ?? 0, 12);
    expect(after[0]?.estimatedCostDelta).toBeCloseTo(before[0]?.estimatedCostDelta ?? 0, 12);
    expect(after[0]?.divergentChoices).toEqual(before[0]?.divergentChoices);
  });

  it('is created by a migration, leaving earlier history intact', async () => {
    const store = await open();
    store.recordRequest(request());
    store.close();

    const upgraded = await open();
    upgraded.recordShadowDecisions([shadowRecord()]);
    const loaded = upgraded.loadShadowDecisions(10);
    const counts = upgraded.statistics();
    upgraded.close();

    expect(loaded).toHaveLength(1);
    expect(counts.requests).toBe(1);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
  });

  it('stores no prompt, path or source text', async () => {
    const store = await open();
    store.recordShadowDecisions([shadowRecord()]);
    store.close();

    const bytes = await readFile(join(dir, 'routepilot.sqlite'), 'latin1');
    const table = bytes.slice(bytes.indexOf('shadow_decisions'));
    expect(table).not.toMatch(/[A-Za-z]:\\/);
    expect(table).not.toContain('/home/');
  });

  it('is empty and harmless on the null store', () => {
    const store = new NullTelemetryStore();
    store.recordShadowDecisions([shadowRecord()]);

    expect(store.loadShadowDecisions()).toEqual([]);
  });

  it('swallows a write against a closed database', async () => {
    const problems: string[] = [];
    const store = await open({ onProblem: (m: string) => problems.push(m) });
    store.close();

    expect(() => {
      store.recordShadowDecisions([shadowRecord()]);
    }).not.toThrow();
    expect(problems.length).toBeGreaterThan(0);
  });

  it('returns an empty list rather than throwing on a failed read', async () => {
    const problems: string[] = [];
    const store = await open({ onProblem: (m: string) => problems.push(m) });
    store.close();

    expect(store.loadShadowDecisions(10)).toEqual([]);
    expect(problems.length).toBeGreaterThan(0);
  });
});
