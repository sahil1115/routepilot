#!/usr/bin/env node
/**
 * Verify the run loop end to end, against a real agent.
 *
 * The adapters are verified in isolation and the orchestration around them is
 * not: `verify-agent-tasks.mjs` calls `adapter.execute` directly, bypassing
 * `TaskRunner` entirely. So every seam between verified components has been
 * unproven — `RegistryExecutor` bridging the runner to an adapter, validation
 * running against a workspace a real agent just edited, an outcome derived from
 * that, telemetry written from a real run, and learning fed by it.
 *
 * This drives the **production** `runTask()`, the same function the CLI calls.
 * Nothing is scripted and no executor is faked.
 *
 * Usage, from a terminal:
 *
 *   npm run verify:run-loop -- --permission-mode acceptEdits
 *
 *   --adapter <id>            claude-code (default) or cursor-cli
 *   --model <id>              model id from the generated config
 *   --permission-mode <mode>  passed to the adapter; Claude Code needs
 *                             acceptEdits to write files at all
 *
 * Every assertion observes the filesystem or the SQLite database. Nothing is
 * taken from the agent's account of itself, and nothing from RoutePilot's
 * either where the database can be read instead.
 *
 * This spends real quota and lets a real agent write files. Everything it can
 * touch is a fresh directory under the system temp directory. Your repository
 * is never the workspace.
 *
 * Exit code 0 means every check passed.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function flag(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const adapterId = flag('--adapter', 'claude-code');
const modelId = flag('--model', 'anthropic/haiku-4-5');
const permissionMode = flag('--permission-mode', undefined);

const { routeTask } = await import('../dist/cli/route.js');
const { runTask } = await import('../dist/cli/run.js');
const { parseConfig } = await import('../dist/config/schema.js');
const { openTelemetryStore } = await import('../dist/telemetry/open.js');
const { createFixtureRepo, FIXTURE_DEFECT } = await import('./lib/fixture-repo.mjs');

/**
 * A configuration for the fixture workspace.
 *
 * One model, so routing is deterministic and the run cannot be attributed to a
 * choice nobody predicted. The budget is generous because this is verifying the
 * loop, not the budget -- which has its own tests.
 */
function configFor(storagePath) {
  return parseConfig({
    version: 1,
    providers: [
      { id: 'anthropic', displayName: 'Anthropic', kind: 'cloud', auth: { kind: 'none' } },
    ],
    models: [
      {
        id: modelId,
        providerId: 'anthropic',
        modelId: modelId.split('/')[1] ?? modelId,
        displayName: modelId,
        tier: 'cheap',
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
        pricing: { inputPerMillion: 1, outputPerMillion: 5 },
        capabilities: {
          toolUse: true,
          agenticExecution: true,
          streaming: true,
          structuredOutput: true,
          vision: false,
        },
        latency: { firstTokenSeconds: 1, outputTokensPerSecond: 100 },
        availability: 'available',
        priors: {
          skills: {
            codeGeneration: 0.85,
            codeEditing: 0.9,
            debugging: 0.85,
            refactoring: 0.8,
            architecture: 0.7,
            reasoning: 0.8,
            testGeneration: 0.85,
            documentation: 0.9,
            multiFileReasoning: 0.7,
          },
          languages: { javascript: 0.88, typescript: 0.88 },
        },
      },
    ],
    routing: { minimumSuccessProbability: 0.5 },
    budgets: { request: 5, currency: 'USD' },
    learning: { enabled: true, minimumTrainingSamples: 1 },
    telemetry: { enabled: true, storagePath },
    agents: {
      [adapterId]: permissionMode === undefined ? {} : { permissionMode },
    },
  });
}

const TASK =
  'The test suite in this repository fails. Fix the bug in src/calculator.mjs so that ' +
  '`node test.mjs` passes. Run it to confirm before you finish.';

/** Drive the production path exactly as `routepilot run` does. */
async function loopRun(repo, { execute, storagePath }) {
  const config = configFor(storagePath);

  const route = await routeTask({
    prompt: TASK,
    root: repo.dir,
    level: 2,
    config,
  });

  const store =
    execute && config.telemetry.enabled
      ? await openTelemetryStore({
          enabled: true,
          storagePath,
          workspaceRoot: repo.dir,
          onProblem: (message) => notes.push(message),
        })
      : undefined;

  const result = await runTask({
    route,
    config,
    workspaceRoot: repo.dir,
    task: TASK,
    execute,
    adapterId,
    ...(store === undefined ? {} : { store }),
    onProblem: (message) => notes.push(message),
  });

  return { result, store, config };
}

const notes = [];
const results = [];

async function check(name, covers, run) {
  const started = Date.now();
  try {
    const outcome = await run();
    results.push({ name, covers, ...outcome, elapsed: Date.now() - started });
    console.log(`  ${name} ... ${outcome.passed ? 'PASS' : 'FAIL'} (${Date.now() - started} ms)`);
    console.log(`      ${outcome.detail}`);
  } catch (error) {
    const detail = error instanceof Error ? `${error.message}` : String(error);
    results.push({ name, covers, passed: false, detail, elapsed: Date.now() - started });
    console.log(`  ${name} ... FAIL`);
    console.log(`      ${detail}`);
  }
}

console.log('');
console.log('Verifying the run loop end to end (routeTask -> runTask -> real agent)');
console.log(`Adapter      : ${adapterId}`);
console.log(`Model        : ${modelId}`);
console.log(`Permission   : ${permissionMode ?? '(none passed)'}`);
console.log(`Defect       : ${FIXTURE_DEFECT}`);
console.log('');

const storageRoot = await mkdtemp(join(tmpdir(), 'routepilot-loop-'));
const fixtures = [];

async function fixture(options = {}) {
  const repo = await createFixtureRepo(options);
  fixtures.push(repo);
  return repo;
}

// --- 1. Plans without executing --------------------------------------------

await check('plans without touching the workspace', ['routing', 'the safe default'], async () => {
  const repo = await fixture();
  const before = await repo.read('src/calculator.mjs');

  const { result } = await loopRun(repo, {
    execute: false,
    storagePath: join(storageRoot, 'plan'),
  });
  const after = await repo.read('src/calculator.mjs');

  return {
    passed: result.run === null && before === after,
    detail:
      `selected=${result.route.decision.selectedModelId ?? 'none'}; ` +
      `run=${result.run === null ? 'not executed' : 'EXECUTED'}; ` +
      `source ${before === after ? 'unchanged' : 'CHANGED'}`,
  };
});

// --- 2-5. One real run, several claims about it ----------------------------

const storagePath = join(storageRoot, 'execute');
await mkdir(storagePath, { recursive: true });

let executed = null;

await check(
  'the full loop succeeds against a real agent',
  ['routing', 'RegistryExecutor', 'adapter', 'real edits', 'validation', 'outcome'],
  async () => {
    const repo = await fixture();
    executed = { repo, ...(await loopRun(repo, { execute: true, storagePath })) };

    const testsPass = await repo.testsPass();
    const source = (await repo.read('src/calculator.mjs')) ?? '';
    const run = executed.result.run;

    // Why each attempt failed, not just that it did. Discarding this is what
    // cost a whole verification run earlier in this project's history.
    const attempts = (run?.attempts ?? []).map(
      (attempt, index) =>
        `#${String(index + 1)} ${attempt.modelId}: ${attempt.result?.status ?? '?'}` +
        `/${attempt.failureType ?? attempt.result?.failureType ?? 'none'}` +
        `${attempt.result?.errorSummary ? ` -- ${attempt.result.errorSummary}` : ''}`,
    );

    return {
      passed: run?.outcome === 'succeeded' && testsPass,
      detail:
        `outcome=${run?.outcome ?? 'none'}; ` +
        `reason=${run?.reason ?? 'none'}; ` +
        `model=${run?.finalModelId ?? 'none'}; ` +
        `fixture tests ${testsPass ? 'pass' : 'still fail'}; ` +
        `source ${source.includes('a + b') ? 'was corrected' : 'unchanged'}; ` +
        `attempts=[${attempts.join(' | ')}]`,
    };
  },
);

await check(
  'the outcome was earned by a check that ran',
  ['validation evaluated', 'outcome scoring'],
  () => {
    // Asserted on the *recorded* signals, not an in-flight report. This is the
    // view that reaches scoring, learning and telemetry, so `testsPassed: true`
    // here means a real check produced a verdict the rest of the system then
    // acted on -- which is the claim `succeeded` rests on.
    //
    // `taskCriteriaMet` must be null even on this, the success path. It used to
    // be set to true from the run's own outcome, which made the dimension that
    // means "the task was done" a restatement of the checks -- and that
    // circular 0.2 was enough to carry a syntax-only run over the evidence
    // floor. Phase 27. The two assertions together are the point: real evidence
    // present, invented evidence absent.
    const run = executed?.result.run;
    const signals = run?.signals;

    return Promise.resolve({
      passed:
        signals?.testsPassed === true &&
        signals?.taskCriteriaMet === null &&
        (run?.score?.evidence ?? 0) > 0,
      detail:
        `testsPassed=${String(signals?.testsPassed)}; ` +
        `syntaxValid=${String(signals?.syntaxValid)}; ` +
        `taskCriteriaMet=${String(signals?.taskCriteriaMet)}; ` +
        `evidence=${String(run?.score?.evidence ?? 'none')}`,
    });
  },
);

await check('the run reached the telemetry database', ['recording'], () => {
  const store = executed?.store;
  if (store === undefined) return Promise.resolve({ passed: false, detail: 'no store was opened' });

  const stats = store.statistics();
  const recent = store.recentOutcomes(1)[0];

  return Promise.resolve({
    passed: stats.requests > 0 && stats.attempts > 0 && stats.outcomes > 0,
    detail:
      `requests=${stats.requests}; attempts=${stats.attempts}; outcomes=${stats.outcomes}; ` +
      `lastOutcomeModels=${(recent?.modelsUsed ?? []).join(',') || 'none'}`,
  });
});

await check('the outcome became a learned observation', ['learning'], () => {
  const store = executed?.store;
  if (store === undefined) return Promise.resolve({ passed: false, detail: 'no store was opened' });

  const stats = store.loadLearnedStats();
  const total = stats.reduce((sum, entry) => sum + entry.observations, 0);

  return Promise.resolve({
    passed: total > 0,
    detail:
      `buckets=${stats.length}; observations=${total}; ` +
      `models=${[...new Set(stats.map((entry) => entry.modelId))].join(',') || 'none'}`,
  });
});

await check('the prediction was scored against the outcome', ['calibration'], () => {
  const store = executed?.store;
  if (store === undefined) return Promise.resolve({ passed: false, detail: 'no store was opened' });

  // Phase 11 built both halves of this and nothing called either, so
  // `loadPredictions` came back empty on every real run for six phases and the
  // calibration safeguard could never reach a verdict. The unit tests all
  // passed throughout; only driving the production path shows a missing call.
  const records = store.loadPredictions(10);
  const first = records[0];

  return Promise.resolve({
    passed: records.length > 0 && first?.predicted !== undefined && first?.actual !== undefined,
    detail:
      `predictions=${records.length}; ` +
      `model=${first?.modelId ?? 'none'}; ` +
      `predicted=${String(first?.predicted)}; actual=${String(first?.actual)}; ` +
      `source=${first?.source ?? 'none'}`,
  });
});

// --- 7. The honesty path ----------------------------------------------------

await check(
  'reports unverified when the workspace declares no checks',
  ['validation honesty', 'the unverified outcome'],
  async () => {
    // The agent still does the work; RoutePilot simply cannot confirm it, and
    // must say so rather than take the agent's word.
    const repo = await fixture({ withoutTestScript: true });
    const { result } = await loopRun(repo, {
      execute: true,
      storagePath: join(storageRoot, 'unverified'),
    });

    const run = result.run;
    const testsPass = await repo.testsPass();

    return {
      passed: run?.outcome === 'unverified' && run?.signals?.taskCriteriaMet === null,
      detail:
        `outcome=${run?.outcome ?? 'none'}; ` +
        `taskCriteriaMet=${String(run?.signals?.taskCriteriaMet)}; ` +
        `the agent ${testsPass ? 'did' : 'did not'} actually fix it`,
    };
  },
);

// --- Report -----------------------------------------------------------------

executed?.store?.close?.();

const passed = results.every((entry) => entry.passed);

console.log('');
console.log(
  `  ${results.filter((entry) => entry.passed).length}/${results.length} check(s) passed`,
);

const report = {
  subject: 'run-loop',
  ranAt: new Date().toISOString(),
  adapterId,
  modelId,
  permissionMode: permissionMode ?? null,
  platform: `${process.platform} node ${process.versions.node}`,
  passed,
  notes,
  results,
};

await mkdir(join(root, '.routepilot'), { recursive: true });
const reportPath = join(root, '.routepilot', 'run-loop-verification.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

// Cleanup after the report, so a locked directory cannot lose a result.
await Promise.all(fixtures.map((repo) => repo.cleanup()));
await rm(storageRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(
  () => undefined,
);

console.log('');
console.log(`Report written to ${reportPath}`);
console.log('');

process.exit(passed ? 0 : 1);
