/**
 * The MVP spine (spec section 73).
 *
 *   TASK -> ROUTING -> MODEL -> EXECUTION -> MONITORING -> ESCALATION -> OUTCOME
 *
 * Section 73 says the MVP must prove that arrow first, and must not *begin*
 * with complex ML, contextual bandits, multi-model ensembles, cloud analytics,
 * distributed infrastructure, team dashboards, complicated AST indexing, or a
 * full dependency graph for every repository.
 *
 * RoutePilot arrived at that instruction with most of the "later phases"
 * already built — learning in Phase 10, calibration in 11, shadow routing in
 * 12, a contextual bandit in 13. So the question this file answers is not "were
 * they built too early", which cannot be un-answered now. It is the question
 * that still has consequences:
 *
 *   **Does the spine still work when every one of them is switched off?**
 *
 * If it does, the advanced machinery is an addition to a working core rather
 * than load-bearing. If it does not, the core was never small, whatever the
 * roadmap says. Principles 16 and 17 make the same demand — the system must
 * still work if learning is disabled, and if telemetry is disabled.
 *
 * Nothing here is stubbed except the coding agent and the shell, the two edges
 * RoutePilot does not own.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../core/registry/model-registry.js';
import { RoutingEngine } from '../core/routing/routing-engine.js';
import { TaskRunner } from '../core/run/task-runner.js';
import { ValidationEngine } from '../core/execution/validation.js';
import {
  makesBadEdits,
  ScriptedCommandRunner,
  ScriptedExecutor,
  steppingClock,
  succeeds,
  type ScriptedRun,
} from '../test-support/e2e-fixtures.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  policy,
} from '../test-support/routing-fixtures.js';

const LADDER = [cheapModel(), mediumModel(), frontierModel()];

/**
 * The whole product, with everything section 73 warns against left out.
 *
 * Note what is *absent* from this construction, because the absences are the
 * assertion: no `learned` model, so `RoutingEngine` uses configured priors
 * only; no `LearnedSuccessModel` on the runner, so nothing trains; no
 * `ShadowRouter`; no `Explorer` and no bandit; no telemetry store, so nothing
 * is written anywhere; no network client of any kind.
 */
function minimalCore(scripts: Record<string, ScriptedRun> = {}, failingChecks: string[] = []) {
  const models = new ModelRegistry(LADDER);
  const executor = new ScriptedExecutor(scripts);

  const runner = new TaskRunner({
    models,
    router: new RoutingEngine(models),
    executor,
    validation: new ValidationEngine({
      runner: new ScriptedCommandRunner(failingChecks),
      commands: {
        tests: { command: 'npm', args: ['run', 'test'] },
        build: { command: 'npm', args: ['run', 'build'] },
        lint: { command: 'npm', args: ['run', 'lint'] },
      },
    }),
    clock: steppingClock(),
  });

  return { runner, executor, models };
}

async function runTask(
  task: string,
  scripts: Record<string, ScriptedRun> = {},
  failing: string[] = [],
) {
  const { runner, executor } = minimalCore(scripts, failing);
  const result = await runner.run({
    requestId: 'mvp-spine',
    task,
    workspaceRoot: '/workspace',
    features: featuresFor(task),
    policy: policy(),
  });
  return { result, executor };
}

describe('the spine runs end to end with every later-phase feature disabled', () => {
  it('carries a task all the way to an outcome', async () => {
    const { result } = await runTask('Rename this variable.');

    // Each link in the section 73 arrow, in order, asserted on one result.
    expect(result.decision).toBeDefined(); //            TASK -> ROUTING
    expect(result.decision.selectedModelId).toBeTruthy(); //     -> MODEL
    expect(result.attempts.length).toBeGreaterThan(0); //        -> EXECUTION
    expect(result.attempts[0]?.failedChecks).toBeDefined(); //   -> MONITORING
    expect(result.outcome).toBe('succeeded'); //                 -> OUTCOME
  });

  it('escalates without any learned data', async () => {
    // ESCALATION is the one link that could plausibly have come to depend on
    // the learning layer, since both reason about failure probability. It must
    // not: escalation is driven by the failure taxonomy and the configured
    // ladder, and priors alone have to be enough.
    const { result, executor } = await runTask(
      'Rename this variable.',
      { 'cheap-1': makesBadEdits() },
      ['npm run test'],
    );

    expect(executor.executedModelIds.length).toBeGreaterThan(1);
    expect(result.escalations.length).toBeGreaterThan(0);
  });

  it('is deterministic: identical inputs give a byte-identical decision', async () => {
    // Section 73 asks for deterministic, and principle 9 forbids random
    // selection of an expensive model. With the bandit switched off there is no
    // sampling anywhere, so this is exact equality rather than a tolerance.
    const first = await runTask('Add a standard REST endpoint.');
    const second = await runTask('Add a standard REST endpoint.');

    expect(JSON.stringify(second.result.decision)).toBe(JSON.stringify(first.result.decision));
  });
});

describe('none of the things section 73 warns against are load-bearing', () => {
  it('runs no ensemble: one model at a time, sequentially', async () => {
    // A multi-model ensemble would show up here as two models executing for a
    // single attempt. Escalation runs models in sequence, which is a different
    // thing, so the check is on attempts rather than on the total count.
    const { result, executor } = await runTask(
      'Refactor authentication across the repository.',
      { 'cheap-1': makesBadEdits(), 'medium-1': makesBadEdits() },
      ['npm run test'],
    );

    expect(executor.executedModelIds.length).toBe(result.attempts.length);
    // No model is asked to run twice for the same attempt.
    expect(new Set(executor.executedModelIds).size).toBe(executor.executedModelIds.length);
  });

  it('writes nothing anywhere: no telemetry store is even constructed', async () => {
    // Principle 17. `minimalCore` passes no store, and the run has to complete
    // regardless — the absence of a place to record outcomes is a supported
    // configuration, not a degraded one.
    const { result } = await runTask('Rename this variable.', { 'cheap-1': succeeds() });

    expect(result.outcome).toBe('succeeded');
  });

  it('needs no repository analysis at all to route', () => {
    // Progressive analysis exists, but routing must not *require* it. A feature
    // vector with nothing repository-shaped in it still produces a decision —
    // which is what keeps "complicated AST indexing" and "full dependency
    // graph" off the critical path rather than merely off by default.
    const models = new ModelRegistry(LADDER);
    const decision = new RoutingEngine(models).route({
      features: featuresFor('Rename this variable.'),
      policy: policy(),
    });

    expect(decision.selectedModelId).toBeTruthy();
    expect(decision.evaluations.length).toBe(LADDER.length);
  });
});

describe('the later-phase features are off unless asked for', () => {
  it('routes from priors, not from observations, when no learned model is supplied', () => {
    // The distinction that matters for "no fake training counts" (principle 11)
    // and for section 73: a router given no learned model must not invent one.
    const models = new ModelRegistry(LADDER);
    const decision = new RoutingEngine(models).route({
      features: featuresFor('Add a standard REST endpoint.'),
      policy: policy(),
    });

    for (const evaluation of decision.evaluations) {
      // No learned model was supplied, so nothing may claim to have applied
      // learning, and every observation count must be a real zero rather than
      // a prior dressed up as data.
      expect(evaluation.learningApplied).toBe(false);
      expect(evaluation.observations).toBe(0);
      expect(evaluation.successProbability).toBe(evaluation.staticSuccessProbability);
    }
  });
});

describe('the section 73 exclusion list, checked against the tree', () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  it('depends on exactly one package at runtime', async () => {
    // "Distributed infrastructure" and "cloud analytics" do not arrive as a
    // design decision; they arrive as dependencies. Counting them is a cheaper
    // and more honest check than searching for their names.
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['zod']);
  });

  it('parses no ASTs and builds no dependency graph', async () => {
    // Section 73 names both. RoutePilot's analysis is textual and progressive
    // by design — `docs/ARCHITECTURE.md` says so, and this is what keeps that
    // claim from quietly expiring.
    const offenders: string[] = [];

    for (const [label, pattern] of [
      ['an AST parser', /require\(['"]@babel|from '(acorn|tree-sitter|@babel)/],
      ['a TypeScript program', /ts\.createProgram|createSourceFile/],
      ['a dependency graph', /\b(dependencyGraph|importGraph|transitiveDeps)\b/],
    ] as const) {
      for (const file of await sourceFiles(join(root, 'src'))) {
        if (file.endsWith('.test.ts')) continue;
        if (pattern.test(await readFile(file, 'utf8'))) offenders.push(`${label} in ${file}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('would actually catch each of those things', () => {
    // A positive control. Every guard above passes today, and a guard that
    // passes is indistinguishable from a guard whose pattern is broken --
    // this phase has already produced two of those. So each pattern is shown
    // rejecting a sample of exactly what it exists to reject.
    expect(
      /\b(dependencyGraph|importGraph|transitiveDeps)\b/.test('const g = dependencyGraph;'),
    ).toBe(true);
    expect(/ts\.createProgram|createSourceFile/.test('ts.createProgram(files)')).toBe(true);
    expect(/\bfetch\(|createServer|node:http\b/.test('await fetch(url)')).toBe(true);

    // And not rejecting ordinary code that merely reads similarly.
    expect(/\b(dependencyGraph|importGraph|transitiveDeps)\b/.test('dependencyCount')).toBe(false);
    expect(/\bfetch\(|createServer|node:http\b/.test('prefetchCount')).toBe(false);
  });

  it('has no server, no dashboard and no outbound network call in the core', async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(join(root, 'src', 'core'))) {
      const contents = await readFile(file, 'utf8');
      // `fetch` is the one that would matter: a core that can call out is a
      // core that can leak source code, which principle 14 forbids outright.
      if (/\bfetch\(|createServer|node:http\b/.test(contents)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});

/** Every TypeScript file under a directory. */
async function sourceFiles(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }

  return found;
}
