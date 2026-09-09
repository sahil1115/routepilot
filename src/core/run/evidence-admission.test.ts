/**
 * What a run has to show before it may teach the router.
 *
 * A defect found by review and reproduced here before it was fixed.
 *
 * `taskCriteriaMet` — "the task did what was asked", the second-heaviest
 * dimension in `DEFAULT_OUTCOME_WEIGHTS` at 0.2 — was set from the run's own
 * outcome. But `succeeded` means only "some check produced a verdict and
 * nothing failed", so the dimension restated the checks instead of adding
 * anything to them.
 *
 * That mattered because of what it did to the evidence ratio. A task planning
 * `['syntax', 'tests']` in a repository with a typecheck script and no test
 * script runs syntax alone. On its own that is 0.1 of the weight table, well
 * under the 0.25 `MINIMUM_EVIDENCE` floor, and the observation would have been
 * refused. The circular 0.2 carried it over the line — so a passing typecheck
 * taught the router that the model had done the work, at a score of 1.0.
 *
 * The floor was doing no work here: what it measured was largely a restatement
 * of itself.
 */

import { describe, expect, it } from 'vitest';

import type { EscalationLimits } from '../types/escalation.js';
import { LearnedSuccessModel } from '../learning/success-model.js';
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

type Commands = ConstructorParameters<typeof ValidationEngine>[0]['commands'];

const TYPECHECK = { command: 'npm', args: ['run', 'typecheck'] };
const TEST = { command: 'npm', args: ['run', 'test'] };

/**
 * A runner wired to a real learned model, so admission is observed rather than
 * inferred. `LearnedSuccessModel` records into a null store by default, which
 * is all this needs — the question is whether `observe` was reached at all.
 */
function runnerWith(options: {
  commands?: Commands;
  failing?: readonly string[];
  scripts?: Record<string, ScriptedRun>;
  limits?: EscalationLimits;
}) {
  const models = new ModelRegistry(LADDER);
  const learned = new LearnedSuccessModel();

  return {
    learned,
    runner: new TaskRunner({
      models,
      router: new RoutingEngine(models),
      executor: new ScriptedExecutor(options.scripts ?? {}),
      clock: steppingClock(),
      learned,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      validation: new ValidationEngine({
        runner: new ScriptedCommandRunner(options.failing ?? []),
        ...(options.commands === undefined ? {} : { commands: options.commands }),
      }),
    }),
  };
}

/** One model, one attempt, so nothing is refused for being unattributable. */
const NO_ESCALATION: EscalationLimits = {
  maxEscalationsPerTask: 0,
  maxRetriesPerModel: 0,
};

async function run(built: ReturnType<typeof runnerWith>) {
  return built.runner.run({
    requestId: 'evidence-admission',
    task: TASK,
    workspaceRoot: '/workspace',
    features: featuresFor(TASK),
    policy: policy(),
  });
}

describe('a hygiene check is not evidence the task was done', () => {
  it('learns nothing from a run only a typecheck vouched for', async () => {
    // The defect, at the boundary that matters. The run is a legitimate
    // `succeeded` -- something ran and nothing failed -- but the only thing
    // established is that the code parses, which is true of code that does
    // entirely the wrong thing.
    const built = runnerWith({ commands: { syntax: TYPECHECK } });
    const result = await run(built);

    expect(result.outcome).toBe('succeeded');
    expect(built.learned.totalObservations).toBe(0);
  });

  it('does not claim the task criteria were met', async () => {
    // Nothing in RoutePilot establishes this, so the honest value is "not
    // evaluated". `true` here was a restatement of the syntax check.
    const built = runnerWith({ commands: { syntax: TYPECHECK } });
    const result = await run(built);

    expect(result.signals?.taskCriteriaMet).toBeNull();
  });

  it('learns from a run the test suite vouched for', async () => {
    // The positive control. A rule that refused everything would pass the test
    // above while quietly ending all learning.
    const built = runnerWith({ commands: { syntax: TYPECHECK, tests: TEST } });
    const result = await run(built);

    expect(result.outcome).toBe('succeeded');
    expect(built.learned.totalObservations).toBe(1);
  });

  it('still learns from a run the test suite failed', async () => {
    // The other way to "fix" this would be to admit only passing runs, which
    // would teach the router that every model always succeeds. A substantive
    // check has to count in both directions, so the rule asks whether one
    // produced a verdict -- not whether it produced a good one.
    //
    // Escalation is pinned off. A failing run normally escalates, and a task
    // that took two models is already refused for a different and older
    // reason: there is no honest way to say whose work produced the result.
    // Left on, this would pass for that reason instead of the one it is for.
    const built = runnerWith({
      commands: { syntax: TYPECHECK, tests: TEST },
      failing: ['npm run test'],
      limits: NO_ESCALATION,
    });
    const result = await run(built);

    expect(result.outcome).not.toBe('succeeded');
    expect(built.learned.totalObservations).toBe(1);
  });

  it('learns nothing from a failed run inspected only for syntax', async () => {
    // A failed attempt that changed files gets a syntax-only sweep, by design:
    // running a full suite to explain a run that already failed is expensive.
    // That keeps the sweep cheap, and it also means the sweep cannot support
    // an observation.
    const built = runnerWith({
      scripts: { [cheapModel().id]: makesBadEdits() },
      commands: { syntax: TYPECHECK },
      failing: ['npm run typecheck'],
    });
    await run(built);

    expect(built.learned.totalObservations).toBe(0);
  });

  it('learns nothing when no check produced a verdict at all', async () => {
    // Unchanged behaviour, asserted so that tightening admission cannot
    // silently loosen this one.
    const built = runnerWith({});
    const result = await run(built);

    expect(result.outcome).toBe('unverified');
    expect(built.learned.totalObservations).toBe(0);
  });
});
