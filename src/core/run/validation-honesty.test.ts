/**
 * A run is not a success because nothing contradicted it.
 *
 * Two defects, found by review and reproduced here before they were fixed.
 *
 * 1. `ValidationReport.passed` answers "did anything fail". A plan whose checks
 *    were all skipped answers that with "no", so an unvalidated run read as a
 *    passing one — and production configured no commands at all, which made
 *    that *every* run. A user was told `succeeded` on the agent's own word.
 *
 * 2. Validation ran only when the agent reported `completed`, so a failed
 *    attempt reached the classifier with no validation evidence whatever. The
 *    `weakness.broke-validation` rule was therefore unreachable on the one path
 *    it exists for, and a model that left the workspace broken looked exactly
 *    like a provider outage.
 */

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../registry/model-registry.js';
import { RoutingEngine } from '../routing/routing-engine.js';
import { ValidationEngine } from '../execution/validation.js';
import {
  makesBadEdits,
  ScriptedCommandRunner,
  ScriptedExecutor,
  steppingClock,
  type ScriptedRun,
} from '../../test-support/e2e-fixtures.js';
import {
  cheapModel,
  featuresFor,
  mediumModel,
  policy,
} from '../../test-support/routing-fixtures.js';
import { TaskRunner } from './task-runner.js';

const TASK = 'Rename this variable.';
const LADDER = [cheapModel(), mediumModel()];

/** Commands the engine will be given, if any. */
type Commands = ConstructorParameters<typeof ValidationEngine>[0]['commands'];

function runnerWith(options: {
  commands?: Commands;
  failing?: readonly string[];
  scripts?: Record<string, ScriptedRun>;
  withEngine?: boolean;
}) {
  const models = new ModelRegistry(LADDER);
  const executor = new ScriptedExecutor(options.scripts ?? {});

  return {
    executor,
    runner: new TaskRunner({
      models,
      router: new RoutingEngine(models),
      executor,
      clock: steppingClock(),
      ...(options.withEngine === false
        ? {}
        : {
            validation: new ValidationEngine({
              runner: new ScriptedCommandRunner(options.failing ?? []),
              ...(options.commands === undefined ? {} : { commands: options.commands }),
            }),
          }),
    }),
  };
}

async function run(built: ReturnType<typeof runnerWith>) {
  return built.runner.run({
    requestId: 'validation-honesty',
    task: TASK,
    workspaceRoot: '/workspace',
    features: featuresFor(TASK),
    policy: policy(),
  });
}

describe('a run nobody validated is not a success', () => {
  it('reports `unverified` when checks were planned and none produced a verdict', async () => {
    // The production case exactly: an engine is wired, the task warrants
    // checks, and no command is configured for any of them.
    const result = await run(runnerWith({}));

    expect(result.outcome).toBe('unverified');
    expect(result.reason).toMatch(/nothing verified it/i);
  });

  it('does not record a task criterion nobody checked', async () => {
    // The claim must not reach scoring, learning or calibration either. This is
    // the same "absent is not zero" rule the rest of the outcome already keeps.
    const result = await run(runnerWith({}));

    expect(result.signals?.taskCriteriaMet).toBeNull();
    expect(result.score?.score ?? null).toBeNull();
  });

  it('does not escalate merely because nothing could be checked', async () => {
    // The tempting over-correction. An unverified run is not a failed one:
    // escalating here would buy a more expensive model on the absence of
    // evidence rather than on evidence of a problem.
    const built = runnerWith({});
    const result = await run(built);

    expect(result.escalations).toEqual([]);
    expect(built.executor.executedModelIds).toHaveLength(1);
  });

  it('reports `succeeded` once a check actually passes', async () => {
    const result = await run(
      runnerWith({ commands: { tests: { command: 'npm', args: ['run', 'test'] } } }),
    );

    expect(result.outcome).toBe('succeeded');
    expect(result.signals?.taskCriteriaMet).toBe(true);
  });

  it('still reports `succeeded` when no validation engine is wired at all', async () => {
    // A caller that constructs a runner without validation has opted out, the
    // way a caller can opt out of telemetry. That is different from checks
    // being planned and silently skipped, and must not be conflated with it.
    const result = await run(runnerWith({ withEngine: false }));

    expect(result.outcome).toBe('succeeded');
  });

  it('marks a report evaluated only when a check produced a verdict', async () => {
    const engine = new ValidationEngine({ runner: new ScriptedCommandRunner([]) });
    const skipped = await engine.run({ checks: ['tests'], rationale: 'x' }, '/workspace');

    // Both are true, and only together do they mean anything.
    expect(skipped.passed).toBe(true);
    expect(skipped.evaluated).toBe(false);
  });
});

describe('a failed run that changed files is inspected', () => {
  it('validates after failure, so damage can be told from an outage', async () => {
    // `makesBadEdits` reports changed files and then fails validation. Before
    // this, a failed attempt got no validation at all and the classifier saw a
    // single adapter string.
    const built = runnerWith({
      scripts: { [cheapModel().id]: makesBadEdits() },
      commands: { syntax: { command: 'npm', args: ['run', 'typecheck'] } },
      failing: ['npm run typecheck'],
    });

    const result = await run(built);
    const failed = result.attempts.find((attempt) => !attempt.succeeded);

    expect(failed).toBeDefined();
    expect(failed?.failedChecks).toContain('syntax');
  });

  it('does not run the test suite on a failed attempt', async () => {
    // The check has to stay cheap. Running a full suite to explain a run that
    // already failed spends minutes and money for a question syntax answers.
    const built = runnerWith({
      scripts: { [cheapModel().id]: makesBadEdits() },
      commands: {
        syntax: { command: 'npm', args: ['run', 'typecheck'] },
        tests: { command: 'npm', args: ['run', 'test'] },
      },
      failing: ['npm run typecheck'],
    });

    const result = await run(built);
    const failed = result.attempts.find((attempt) => !attempt.succeeded);

    expect(failed?.failedChecks).toContain('syntax');
    expect(failed?.failedChecks).not.toContain('tests');
  });
});
