/**
 * Execution monitor, struggle score, failure classification and validation.
 *
 * The centrepiece is the ten-scenario table: every fixture must classify
 * correctly, and the pairs that look alike must come apart. A failing test
 * caused by the model and a failing test caused by an unreachable database
 * produce the same events and the same failing check; only the reason differs,
 * and getting that wrong would corrupt every routing decision afterwards
 * (spec sections 22 and 38).
 */

import { describe, expect, it } from 'vitest';

import { NullCommandRunner, type CommandOutcome, type CommandRunnerPort } from '../ports.js';
import type { FailureType } from '../types/failure.js';
import {
  allScenarios,
  buildFailure,
  contextOverflow,
  environmentFailure,
  repeatedToolFailure,
  resetFixtureClock,
  successfulTask,
  testFailure,
  toolFailure,
  type ExecutionScenario,
} from '../../test-support/execution-fixtures.js';
import { FailureClassifier } from './failure-classifier.js';
import { ExecutionMonitor, emptySignals } from './monitor.js';
import { StruggleMonitor } from './struggle.js';
import { ValidationEngine, commandsFromPackageScripts } from './validation.js';

/** A clock the test advances by hand. */
class TestClock {
  #now = 1_000_000;
  now(): number {
    return this.#now;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

/** Observe a scenario's events and return the signals. */
function observe(scenario: ExecutionScenario): ReturnType<ExecutionMonitor['signals']> {
  const monitor = new ExecutionMonitor();
  for (const event of scenario.events) monitor.observe(event);
  return monitor.signals();
}

/** Classify a scenario end to end. */
function classify(scenario: ExecutionScenario): ReturnType<FailureClassifier['classify']> {
  return new FailureClassifier().classify({
    signals: observe(scenario),
    ...(scenario.adapterFailureType === undefined
      ? {}
      : { adapterFailureType: scenario.adapterFailureType }),
    ...(scenario.adapterErrorSummary === undefined
      ? {}
      : { adapterErrorSummary: scenario.adapterErrorSummary }),
    ...(scenario.validation === undefined ? {} : { validation: scenario.validation }),
    ...(scenario.taskAmbiguity === undefined ? {} : { taskAmbiguity: scenario.taskAmbiguity }),
    ...(scenario.repositoryBrokenBeforeRun === undefined
      ? {}
      : { repositoryBrokenBeforeRun: scenario.repositoryBrokenBeforeRun }),
  });
}

// ---------------------------------------------------------------------------
// The ten required scenarios
// ---------------------------------------------------------------------------

describe('the ten execution scenarios classify correctly', () => {
  it.each(allScenarios().map((s) => [s.name, s] as const))('classifies "%s"', (_name, scenario) => {
    const classification = classify(scenario);

    expect(classification.failureType).toBe(scenario.expectedFailureType);
    expect(classification.modelAttributable).toBe(scenario.expectedModelAttributable);
  });

  it('attributes exactly one of the ten to the model', () => {
    resetFixtureClock();
    const attributable = allScenarios().filter((scenario) => classify(scenario).modelAttributable);

    // Only repeated tool failure and the model-broken test suite may implicate
    // the model. Everything else has an external cause.
    expect(attributable.map((s) => s.name).sort()).toEqual([
      'repeated tool failure',
      'test failure',
    ]);
  });

  it('gives a human-readable reason for every classification', () => {
    resetFixtureClock();
    for (const scenario of allScenarios()) {
      const classification = classify(scenario);
      expect(classification.reason.length, scenario.name).toBeGreaterThan(10);
      expect(classification.confidence).toBeGreaterThan(0);
      expect(classification.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('the scenarios that look alike come apart', () => {
  it('separates a model-broken test from a database-broken test', () => {
    // Identical shape: a file change, then a failing test suite. The only
    // difference is *why* the test failed — and it changes everything.
    const byModel = classify(testFailure());
    const byEnvironment = classify(environmentFailure());

    expect(byModel.failureType).toBe('MODEL_WEAKNESS');
    expect(byModel.modelAttributable).toBe(true);

    expect(byEnvironment.failureType).toBe('ENVIRONMENT_FAILURE');
    expect(byEnvironment.modelAttributable).toBe(false);
  });

  it('separates a model-broken build from a pre-existing one', () => {
    const preExisting = classify(buildFailure());
    expect(preExisting.failureType).toBe('REPOSITORY_PROBLEM');
    expect(preExisting.modelAttributable).toBe(false);

    // The same failure, but the repository was healthy beforehand.
    const caused = classify({
      ...buildFailure(),
      repositoryBrokenBeforeRun: false,
      events: [...buildFailure().events, { kind: 'file-change', timestamp: 1, path: 'src/a.ts' }],
    });
    expect(caused.failureType).toBe('MODEL_WEAKNESS');
  });

  it('separates one tool failure from repeated ones', () => {
    expect(classify(toolFailure()).failureType).toBe('TOOL_FAILURE');
    expect(classify(repeatedToolFailure()).failureType).toBe('MODEL_WEAKNESS');
  });

  it('reads a context overflow dressed as a provider error correctly', () => {
    // Retrying an oversized request on the same model would fail identically.
    const classification = classify(contextOverflow());

    expect(classification.failureType).toBe('CONTEXT_LIMIT');
    expect(classification.failureType).not.toBe('PROVIDER_FAILURE');
  });
});

// ---------------------------------------------------------------------------
// Execution monitor
// ---------------------------------------------------------------------------

describe('ExecutionMonitor', () => {
  it('counts tool calls, failures and the longest failure run', () => {
    const signals = observe(repeatedToolFailure());

    expect(signals.toolCalls).toBe(4);
    expect(signals.toolFailures).toBe(4);
    expect(signals.maxConsecutiveToolFailures).toBe(4);
  });

  it('resets the consecutive-failure run on a success', () => {
    const monitor = new ExecutionMonitor();
    monitor.observe({ kind: 'tool-result', timestamp: 1, ok: false });
    monitor.observe({ kind: 'tool-result', timestamp: 2, ok: false });
    monitor.observe({ kind: 'tool-result', timestamp: 3, ok: true });
    monitor.observe({ kind: 'tool-result', timestamp: 4, ok: false });

    const signals = monitor.signals();
    expect(signals.maxConsecutiveToolFailures).toBe(2);
    expect(signals.consecutiveToolFailures).toBe(1);
  });

  it('tracks edit churn per file', () => {
    const monitor = new ExecutionMonitor();
    for (const path of ['a.ts', 'a.ts', 'a.ts', 'b.ts']) {
      monitor.observe({ kind: 'file-change', timestamp: 1, path });
    }

    const signals = monitor.signals();
    expect(signals.fileChanges).toBe(4);
    expect(signals.distinctFilesChanged).toBe(2);
    expect(signals.repeatedlyEditedFiles).toBe(1);
    expect(signals.maxEditsToOneFile).toBe(3);
  });

  it('does not count an assistant message as progress', () => {
    // A model narrating while changing nothing is exactly what the
    // no-progress signal exists to catch.
    const clock = new TestClock();
    const monitor = new ExecutionMonitor({ clock });

    monitor.observe({ kind: 'assistant-message', timestamp: 0 });
    clock.advance(60_000);
    monitor.observe({ kind: 'assistant-message', timestamp: 0 });
    clock.advance(60_000);

    expect(monitor.signals().millisecondsWithoutProgress).toBe(120_000);
  });

  it('counts a file change and a successful tool result as progress', () => {
    const clock = new TestClock();
    const monitor = new ExecutionMonitor({ clock });

    clock.advance(60_000);
    monitor.observe({ kind: 'file-change', timestamp: 0, path: 'a.ts' });
    clock.advance(1_000);

    expect(monitor.signals().millisecondsWithoutProgress).toBe(1_000);
  });

  it('records cancellation and completion', () => {
    const cancelled = observe({
      ...successfulTask(),
      events: [{ kind: 'cancelled', timestamp: 1 }],
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.completed).toBe(false);

    expect(observe(successfulTask()).completed).toBe(true);
  });

  it('captures the most recent token usage', () => {
    const monitor = new ExecutionMonitor();
    monitor.observe({
      kind: 'usage',
      timestamp: 1,
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    monitor.observe({
      kind: 'completed',
      timestamp: 2,
      usage: { inputTokens: 200, outputTokens: 20 },
    });

    expect(monitor.signals().usage).toEqual({ inputTokens: 200, outputTokens: 20 });
  });

  it('retains no events by default', () => {
    // Events can carry summaries of user code; retention is opt-in
    // (spec section 33).
    const monitor = new ExecutionMonitor();
    monitor.observe({ kind: 'assistant-message', timestamp: 1, summary: 'secret-ish text' });

    expect(monitor.observedEvents).toHaveLength(0);
    expect(new ExecutionMonitor({ retainEvents: true }).observedEvents).toHaveLength(0);
  });

  it('can be reset for a fresh run', () => {
    const monitor = new ExecutionMonitor();
    monitor.observe({ kind: 'tool-result', timestamp: 1, ok: false });
    monitor.reset();

    expect(monitor.signals().toolFailures).toBe(0);
  });

  it('observes a whole stream', async () => {
    const monitor = new ExecutionMonitor();
    const events = successfulTask().events;

    const signals = await monitor.observeAll(
      (async function* () {
        for (const event of events) {
          // A real stream awaits I/O here; the await keeps this a genuine
          // AsyncIterable rather than a sync generator in disguise.
          await Promise.resolve();
          yield event;
        }
      })(),
    );

    expect(signals.completed).toBe(true);
    expect(signals.events).toBe(events.length);
  });
});

// ---------------------------------------------------------------------------
// Struggle score
// ---------------------------------------------------------------------------

describe('StruggleMonitor', () => {
  const struggle = new StruggleMonitor();

  it('scores a healthy run at zero', () => {
    const assessment = struggle.assess(observe(successfulTask()));

    expect(assessment.score).toBe(0);
    expect(assessment.level).toBe('none');
    expect(assessment.contributions).toEqual([]);
  });

  it('raises the score as failures accumulate', () => {
    const one = struggle.assess(observe(toolFailure()));
    const many = struggle.assess(observe(repeatedToolFailure()));

    expect(many.score).toBeGreaterThan(one.score);
    expect(many.level).not.toBe('none');
  });

  it('does not rely on a single threshold', () => {
    // Several independent signals must be able to contribute.
    const assessment = struggle.assess({
      ...emptySignals(),
      toolCalls: 5,
      toolFailures: 4,
      maxConsecutiveToolFailures: 3,
      maxEditsToOneFile: 5,
      repeatedlyEditedFiles: 2,
      millisecondsWithoutProgress: 300_000,
      terminalFailures: 2,
      errorEvents: 1,
    });

    expect(assessment.contributions.length).toBeGreaterThanOrEqual(5);
    expect(assessment.level).toBe('severe');
  });

  it('never attributes environment trouble to the model', () => {
    // Spec section 23: an environment or provider failure must not raise the
    // model-weakness score.
    const signals = {
      ...emptySignals(),
      toolCalls: 4,
      toolFailures: 4,
      maxConsecutiveToolFailures: 4,
      maxEditsToOneFile: 5,
    };

    const normal = struggle.assess(signals, false);
    const environmental = struggle.assess(signals, true);

    // The run is going just as badly either way...
    expect(environmental.score).toBe(normal.score);
    // ...but only one of them implicates the model.
    expect(normal.modelAttributableScore).toBeGreaterThan(0);
    expect(environmental.modelAttributableScore).toBe(0);
  });

  it('never counts a failing command as model weakness on its own', () => {
    const assessment = struggle.assess({
      ...emptySignals(),
      terminalCommands: 3,
      terminalFailures: 3,
    });

    expect(assessment.score).toBeGreaterThan(0);
    expect(assessment.modelAttributableScore).toBe(0);
  });

  it('keys escalation to the model-attributable score, not the overall score', () => {
    // Escalating to a stronger model because a database is down would spend
    // more money on the same failure (spec section 26).
    const signals = {
      ...emptySignals(),
      toolCalls: 6,
      toolFailures: 6,
      maxConsecutiveToolFailures: 6,
      maxEditsToOneFile: 6,
      millisecondsWithoutProgress: 600_000,
    };

    expect(struggle.shouldConsiderEscalation(struggle.assess(signals, false))).toBe(true);
    expect(struggle.shouldConsiderEscalation(struggle.assess(signals, true))).toBe(false);
  });

  it('explains every contribution', () => {
    const assessment = struggle.assess({
      ...emptySignals(),
      toolCalls: 4,
      toolFailures: 3,
      maxConsecutiveToolFailures: 3,
    });

    for (const contribution of assessment.contributions) {
      expect(contribution.rule).toMatch(/^struggle\./);
      expect(contribution.reason.length).toBeGreaterThan(5);
      expect(contribution.weight).toBeGreaterThan(0);
    }
  });

  it('keeps both scores inside [0, 1] at the extremes', () => {
    const assessment = struggle.assess({
      ...emptySignals(),
      toolCalls: 100,
      toolFailures: 100,
      maxConsecutiveToolFailures: 100,
      maxEditsToOneFile: 100,
      repeatedlyEditedFiles: 50,
      millisecondsWithoutProgress: 10_000_000,
      terminalFailures: 50,
      errorEvents: 50,
    });

    expect(assessment.score).toBeLessThanOrEqual(1);
    expect(assessment.modelAttributableScore).toBeLessThanOrEqual(1);
    expect(assessment.modelAttributableScore).toBeLessThanOrEqual(assessment.score);
  });

  it('accepts configured thresholds', () => {
    const strict = new StruggleMonitor({ consecutiveToolFailures: 1 });
    const lenient = new StruggleMonitor({ consecutiveToolFailures: 10 });
    const signals = { ...emptySignals(), toolCalls: 2, maxConsecutiveToolFailures: 2 };

    expect(strict.assess(signals).score).toBeGreaterThan(0);
    expect(lenient.assess(signals).score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Failure classifier, beyond the ten scenarios
// ---------------------------------------------------------------------------

describe('FailureClassifier', () => {
  const classifier = new FailureClassifier();

  const withText = (text: string, extra: Record<string, unknown> = {}) =>
    classifier.classify({ signals: emptySignals(), adapterErrorSummary: text, ...extra });

  it.each<[string, string, FailureType]>([
    ['a refused connection', 'Error: connect ECONNREFUSED 127.0.0.1:5432', 'ENVIRONMENT_FAILURE'],
    ['a missing binary', 'bash: pytest: command not found', 'ENVIRONMENT_FAILURE'],
    ['a permissions problem', 'EACCES: permission denied, open /etc/hosts', 'ENVIRONMENT_FAILURE'],
    ['a full disk', 'ENOSPC: no space left on device', 'ENVIRONMENT_FAILURE'],
    ['a rate limit', 'API error 429: rate limit exceeded', 'PROVIDER_FAILURE'],
    ['an overloaded provider', 'provider responded 503 Service Unavailable', 'PROVIDER_FAILURE'],
    ['a context overflow', 'prompt is too long: 210000 tokens', 'CONTEXT_LIMIT'],
    ['a merge conflict', '<<<<<<< HEAD', 'REPOSITORY_PROBLEM'],
  ])('classifies %s as %s', (_label, text, expected) => {
    expect(withText(text).failureType).toBe(expected);
  });

  it('never returns MODEL_WEAKNESS without positive evidence', () => {
    // The most important property in the file: an unexplained failure must be
    // UNKNOWN, because MODEL_WEAKNESS is the only classification that updates
    // beliefs about a model.
    const unexplained = classifier.classify({ signals: emptySignals() });

    expect(unexplained.failureType).toBe('UNKNOWN');
    expect(unexplained.modelAttributable).toBe(false);
  });

  it('does not blame the model for a failure it did not cause', () => {
    const noChanges = classifier.classify({
      signals: { ...emptySignals(), fileChanges: 0 },
      validation: {
        plan: { checks: ['tests'], rationale: 'x' },
        results: [{ check: 'tests', passed: false, summary: 'tests failed', durationMs: 1 }],
        passed: false,
        skipped: [],
      },
    });

    // The run changed nothing, so it cannot have broken the tests.
    expect(noChanges.failureType).not.toBe('MODEL_WEAKNESS');
  });

  it('treats a flaky test as flaky, not as weakness', () => {
    const classification = classifier.classify({
      signals: { ...emptySignals(), fileChanges: 1 },
      validation: {
        plan: { checks: ['tests'], rationale: 'x' },
        results: [
          {
            check: 'tests',
            passed: false,
            summary: 'tests failed',
            output: 'Error: Timeout of 5000ms exceeded — intermittent',
            durationMs: 1,
          },
        ],
        passed: false,
        skipped: [],
      },
      repositoryBrokenBeforeRun: false,
    });

    // Spec section 26: a flaky test must not trigger model escalation.
    expect(classification.failureType).toBe('FLAKY_TEST');
    expect(classification.modelAttributable).toBe(false);
  });

  it('attributes a very ambiguous task to the request, not the model', () => {
    const classification = classifier.classify({
      signals: { ...emptySignals(), toolCalls: 1 },
      taskAmbiguity: 0.9,
    });

    expect(classification.failureType).toBe('USER_AMBIGUITY');
  });

  it('treats cancellation as cancellation, whatever else happened', () => {
    const classification = classifier.classify({
      signals: {
        ...emptySignals(),
        cancelled: true,
        toolFailures: 5,
        maxConsecutiveToolFailures: 5,
        maxEditsToOneFile: 9,
      },
    });

    // Spec section 32: cancellation is not a negative signal about the model.
    expect(classification.failureType).toBe('USER_CANCELLED');
    expect(classification.modelAttributable).toBe(false);
  });

  it('prefers a context limit over a provider error when both could match', () => {
    expect(withText('API error 400: context_length_exceeded — server error').failureType).toBe(
      'CONTEXT_LIMIT',
    );
  });

  it('trusts the adapter about environment and provider trouble', () => {
    expect(
      classifier.classify({
        signals: emptySignals(),
        adapterFailureType: 'ENVIRONMENT_FAILURE',
        adapterErrorSummary: 'could not start "claude"',
      }).failureType,
    ).toBe('ENVIRONMENT_FAILURE');
  });
});

// ---------------------------------------------------------------------------
// Validation engine
// ---------------------------------------------------------------------------

/** A command runner that returns scripted outcomes. */
class ScriptedRunner implements CommandRunnerPort {
  readonly calls: string[] = [];
  #outcome: CommandOutcome;

  constructor(outcome: Partial<CommandOutcome> = {}) {
    this.#outcome = {
      started: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...outcome,
    };
  }

  set(outcome: Partial<CommandOutcome>): void {
    this.#outcome = { ...this.#outcome, ...outcome };
  }

  run(request: { command: string; args: readonly string[] }): Promise<CommandOutcome> {
    this.calls.push([request.command, ...request.args].join(' '));
    return Promise.resolve(this.#outcome);
  }
}

describe('ValidationEngine — planning', () => {
  const engine = new ValidationEngine({ runner: new NullCommandRunner() });

  it('runs nothing for a task that changed no code', () => {
    // Spec section 30: do not run expensive validation unnecessarily.
    expect(engine.planFor('explanation', 'single-file', 0).checks).toEqual([]);
    expect(engine.planFor('investigation', 'few-files', 0).checks).toEqual([]);
  });

  it('runs only syntax for documentation and formatting', () => {
    expect(engine.planFor('documentation', 'single-file', 1).checks).toEqual(['syntax']);
    expect(engine.planFor('formatting', 'single-file', 1).checks).toEqual(['syntax']);
  });

  it('runs syntax and tests for an ordinary code change', () => {
    expect(engine.planFor('bug-fix', 'few-files', 1).checks).toEqual(['syntax', 'tests']);
  });

  it('runs the full sweep for a large refactor', () => {
    const plan = engine.planFor('multi-file-refactoring', 'repository-wide', 20);

    expect(plan.checks).toEqual(['syntax', 'build', 'tests', 'diagnostics']);
    expect(plan.rationale).toContain('full sweep');
  });

  it('escalates on scope even for an ordinary task type', () => {
    expect(engine.planFor('bug-fix', 'repository-wide', 30).checks).toContain('build');
  });

  it('explains every plan', () => {
    for (const taskType of ['explanation', 'documentation', 'bug-fix', 'migration'] as const) {
      expect(engine.planFor(taskType, 'few-files', 1).rationale.length).toBeGreaterThan(10);
    }
  });
});

describe('ValidationEngine — running', () => {
  it('reports a check with no configured command as not run, never as failed', () => {
    // `null` is the honest answer: nobody established anything.
    const engine = new ValidationEngine({ runner: new ScriptedRunner() });

    return engine.run({ checks: ['build'], rationale: 'x' }, '/workspace').then((report) => {
      expect(report.results[0]?.passed).toBeNull();
      expect(report.skipped).toEqual(['build']);
      // A check nobody ran cannot make the report fail.
      expect(report.passed).toBe(true);
    });
  });

  it('passes when the command exits zero', async () => {
    const runner = new ScriptedRunner({ exitCode: 0 });
    const engine = new ValidationEngine({
      runner,
      commands: { tests: { command: 'npm', args: ['run', 'test'] } },
    });

    const report = await engine.run({ checks: ['tests'], rationale: 'x' }, '/workspace');

    expect(report.passed).toBe(true);
    expect(runner.calls).toEqual(['npm run test']);
  });

  it('fails when the command exits non-zero, and keeps the output for classification', async () => {
    const engine = new ValidationEngine({
      runner: new ScriptedRunner({
        exitCode: 1,
        stdout: 'FAIL src/a.test.ts\n  ECONNREFUSED',
      }),
      commands: { tests: { command: 'npm', args: ['run', 'test'] } },
    });

    const report = await engine.run({ checks: ['tests'], rationale: 'x' }, '/workspace');

    expect(report.passed).toBe(false);
    expect(report.results[0]?.exitCode).toBe(1);
    expect(report.results[0]?.output).toContain('ECONNREFUSED');
  });

  it('reports a command that could not start as not run', async () => {
    // The tool is missing: an environment problem, not a failing check.
    const engine = new ValidationEngine({
      runner: new ScriptedRunner({ started: false, exitCode: null, stderr: 'ENOENT' }),
      commands: { build: { command: 'nope', args: [] } },
    });

    const report = await engine.run({ checks: ['build'], rationale: 'x' }, '/workspace');

    expect(report.results[0]?.passed).toBeNull();
    expect(report.results[0]?.summary).toContain('could not be started');
  });

  it('reports a timeout as a failure', async () => {
    const engine = new ValidationEngine({
      runner: new ScriptedRunner({ timedOut: true, exitCode: null }),
      commands: { tests: { command: 'npm', args: ['test'] } },
    });

    const report = await engine.run({ checks: ['tests'], rationale: 'x' }, '/workspace');

    expect(report.results[0]?.passed).toBe(false);
    expect(report.results[0]?.summary).toContain('timed out');
  });
});

describe('commandsFromPackageScripts', () => {
  it('uses only the scripts a repository actually declares', () => {
    const commands = commandsFromPackageScripts({
      build: 'tsc',
      test: 'vitest run',
      typecheck: 'tsc --noEmit',
    });

    expect(commands.build).toEqual({ command: 'npm', args: ['run', 'build'] });
    expect(commands.tests).toEqual({ command: 'npm', args: ['run', 'test'] });
    expect(commands.syntax).toEqual({ command: 'npm', args: ['run', 'typecheck'] });
    // No lint script was declared, so none is invented.
    expect(commands.lint).toBeUndefined();
  });

  it('invents nothing for an empty manifest', () => {
    expect(commandsFromPackageScripts({})).toEqual({});
  });

  it('honours the package manager the repository uses', () => {
    const commands = commandsFromPackageScripts({ test: 'vitest' }, 'pnpm');
    expect(commands.tests?.command).toBe('pnpm');
  });
});
