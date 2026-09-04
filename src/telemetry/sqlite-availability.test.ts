/**
 * Telemetry degrades when `node:sqlite` is absent.
 *
 * `node:sqlite` arrived in Node 22.5. RoutePilot declares `engines.node >=20.11`
 * because everything except telemetry works below that, and the VS Code
 * extension host shipped Node 20 through VS Code 1.95 -- so a missing module is
 * a state real users will be in.
 *
 * `openTelemetryStore` already wrapped the import in a try/catch, but nothing
 * exercised that path, so it held by accident rather than by test, and the
 * message a user saw named neither cause nor remedy.
 *
 * These tests hold both properties: the run continues, and the reason is
 * legible. The loader is injected because the failure cannot otherwise be
 * reproduced on a machine that has the module.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NullTelemetryStore } from './null-store.js';
import { openTelemetryStore } from './open.js';
import {
  SQLITE_MINIMUM_NODE,
  SqliteTelemetryStore,
  SqliteUnavailableError,
  type SqliteLoader,
} from './sqlite-store.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10 })),
  );
});

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'routepilot-sqlite-'));
  dirs.push(dir);
  return dir;
}

/** Exactly what Node throws on a release without the module. */
const missing: SqliteLoader = () => {
  const error = new Error('No such built-in module: node:sqlite') as Error & { code: string };
  error.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
  return Promise.reject(error);
};

describe('a runtime without node:sqlite', () => {
  it('degrades to a store that records nothing, rather than throwing', async () => {
    const problems: string[] = [];
    const store = await openTelemetryStore({
      enabled: true,
      storagePath: await directory(),
      loadSqlite: missing,
      onProblem: (message) => problems.push(message),
    });

    expect(store).toBeInstanceOf(NullTelemetryStore);
    expect(store.enabled).toBe(false);
    expect(problems).toHaveLength(1);
  });

  it('names the Node version required and the one in use', async () => {
    // The whole point of the change. A user on Node 20 has to be able to tell
    // what to do about it without reading the source.
    const problems: string[] = [];
    await openTelemetryStore({
      enabled: true,
      storagePath: await directory(),
      loadSqlite: missing,
      onProblem: (message) => problems.push(message),
    });

    const [message = ''] = problems;
    expect(message).toContain(SQLITE_MINIMUM_NODE);
    expect(message).toContain(process.versions.node);
    // And says what still works, so the warning is not read as a failure.
    expect(message).toMatch(/routing[^.]*unaffected/i);
  });

  it('is still usable: every write is a no-op and every read is empty', async () => {
    // Principle 17. A caller must not need to know which store it received.
    const store = await openTelemetryStore({
      enabled: true,
      storagePath: await directory(),
      loadSqlite: missing,
    });

    expect(() => {
      store.recordOutcome({
        requestId: 'r1',
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
        successScore: null,
        evidence: 0,
        modelAttributable: false,
        recordedAt: 0,
      });
    }).not.toThrow();

    expect(store.recentOutcomes(10)).toEqual([]);
    expect(store.recentRouting(10)).toEqual([]);
    expect(store.statistics().outcomes).toBe(0);
    store.close();
  });

  it('raises a typed error from the store itself, so callers can tell it apart', async () => {
    // `openTelemetryStore` swallows this deliberately. A caller that opens the
    // store directly should still be able to distinguish "no module" from
    // "corrupt file", which are different problems with different answers.
    await expect(
      SqliteTelemetryStore.open({ directory: await directory(), loadSqlite: missing }),
    ).rejects.toBeInstanceOf(SqliteUnavailableError);
  });

  it('keeps the generic wording for any other failure', async () => {
    // A missing module explains itself; anything else must not be mislabelled
    // as a Node version problem.
    const problems: string[] = [];
    await openTelemetryStore({
      enabled: true,
      storagePath: await directory(),
      loadSqlite: () => Promise.reject(new Error('disk on fire')),
      onProblem: (message) => problems.push(message),
    });

    const [message = ''] = problems;
    expect(message).toContain('disk on fire');
    expect(message).not.toContain(SQLITE_MINIMUM_NODE);
  });
});

describe('on a runtime that has node:sqlite', () => {
  it('opens a real store, so the injection has not disabled anything', async () => {
    // Guards the guard: without this, a loader wired wrongly would make every
    // test above pass while telemetry never worked at all.
    const store = await openTelemetryStore({ enabled: true, storagePath: await directory() });

    expect(store).not.toBeInstanceOf(NullTelemetryStore);
    expect(store.enabled).toBe(true);
    store.close();
  });
});
