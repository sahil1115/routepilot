/**
 * The ten execution scenarios this phase must classify correctly.
 *
 * Each fixture is a plausible run: an event stream, what the adapter concluded,
 * and what validation found. The point of the set is the *contrast* — several
 * scenarios look superficially identical (a failing test) and must be
 * classified completely differently depending on why it failed.
 *
 * Excluded from the published build (see tsconfig.build.json).
 */

import type { AgentEvent } from '../core/types/agent.js';
import type { FailureType } from '../core/types/failure.js';
import type { ValidationReport } from '../core/types/execution.js';

/** One end-to-end scenario. */
export interface ExecutionScenario {
  readonly name: string;
  /** The normalised event stream the adapter produced. */
  readonly events: readonly AgentEvent[];
  /** What the adapter itself concluded, if anything. */
  readonly adapterFailureType?: FailureType | undefined;
  readonly adapterErrorSummary?: string | undefined;
  readonly validation?: ValidationReport | undefined;
  readonly taskAmbiguity?: number | undefined;
  readonly repositoryBrokenBeforeRun?: boolean | undefined;
  /** The classification this scenario must produce. */
  readonly expectedFailureType: FailureType;
  /** Whether the outcome may inform beliefs about the model. */
  readonly expectedModelAttributable: boolean;
}

/** Build a validation report with one failing check. */
function failedCheck(
  check: 'build' | 'tests' | 'lint' | 'syntax',
  summary: string,
  output: string,
): ValidationReport {
  return {
    plan: { checks: [check], rationale: 'fixture' },
    results: [{ check, passed: false, summary, output, exitCode: 1, durationMs: 100 }],
    passed: false,
    evaluated: true,
    skipped: [],
  };
}

/** Build a validation report where everything passed. */
function passingChecks(): ValidationReport {
  return {
    plan: { checks: ['syntax', 'tests'], rationale: 'fixture' },
    results: [
      { check: 'syntax', passed: true, summary: 'syntax passed', exitCode: 0, durationMs: 50 },
      { check: 'tests', passed: true, summary: 'tests passed', exitCode: 0, durationMs: 400 },
    ],
    passed: true,
    evaluated: true,
    skipped: [],
  };
}

let clock = 0;
const at = (): number => (clock += 1000);

/** Reset the fixture clock, so event timestamps are deterministic per test. */
export function resetFixtureClock(): void {
  clock = 0;
}

/** 1. A run that worked. */
export function successfulTask(): ExecutionScenario {
  return {
    name: 'successful task',
    events: [
      { kind: 'assistant-message', timestamp: at(), summary: 'reading the file' },
      { kind: 'tool-call', timestamp: at(), tool: 'Read' },
      { kind: 'tool-result', timestamp: at(), ok: true },
      { kind: 'file-change', timestamp: at(), path: 'src/a.ts' },
      { kind: 'tool-call', timestamp: at(), tool: 'Bash' },
      { kind: 'terminal-command', timestamp: at(), ok: true },
      { kind: 'completed', timestamp: at() },
    ],
    validation: passingChecks(),
    // Nothing failed; the classifier should not be asked, but if it is, it must
    // not invent a failure.
    expectedFailureType: 'UNKNOWN',
    expectedModelAttributable: false,
  };
}

/** 2. A single tool call failed, with no clearer cause. */
export function toolFailure(): ExecutionScenario {
  return {
    name: 'tool failure',
    events: [
      { kind: 'tool-call', timestamp: at(), tool: 'Edit' },
      { kind: 'tool-result', timestamp: at(), ok: false, summary: 'edit did not apply' },
      { kind: 'assistant-message', timestamp: at() },
      { kind: 'completed', timestamp: at() },
    ],
    expectedFailureType: 'TOOL_FAILURE',
    expectedModelAttributable: false,
  };
}

/** 3. The model failed the same way repeatedly — genuine model weakness. */
export function repeatedToolFailure(): ExecutionScenario {
  return {
    name: 'repeated tool failure',
    events: [
      { kind: 'tool-call', timestamp: at(), tool: 'Edit' },
      { kind: 'tool-result', timestamp: at(), ok: false, summary: 'old string not found' },
      { kind: 'tool-call', timestamp: at(), tool: 'Edit' },
      { kind: 'tool-result', timestamp: at(), ok: false, summary: 'old string not found' },
      { kind: 'tool-call', timestamp: at(), tool: 'Edit' },
      { kind: 'tool-result', timestamp: at(), ok: false, summary: 'old string not found' },
      { kind: 'tool-call', timestamp: at(), tool: 'Edit' },
      { kind: 'tool-result', timestamp: at(), ok: false, summary: 'old string not found' },
      { kind: 'error', timestamp: at(), ok: false, summary: 'giving up' },
    ],
    expectedFailureType: 'MODEL_WEAKNESS',
    expectedModelAttributable: true,
  };
}

/** 4. The model's own change broke a previously passing test suite. */
export function testFailure(): ExecutionScenario {
  return {
    name: 'test failure',
    events: [
      { kind: 'tool-call', timestamp: at(), tool: 'Edit' },
      { kind: 'tool-result', timestamp: at(), ok: true },
      { kind: 'file-change', timestamp: at(), path: 'src/parser.ts' },
      { kind: 'completed', timestamp: at() },
    ],
    validation: failedCheck(
      'tests',
      'tests failed with exit code 1',
      'FAIL src/parser.test.ts\n  expected 3 to be 4\n\n1 failed, 42 passed',
    ),
    repositoryBrokenBeforeRun: false,
    expectedFailureType: 'MODEL_WEAKNESS',
    expectedModelAttributable: true,
  };
}

/** 5. The build broke, and it was already broken before the run started. */
export function buildFailure(): ExecutionScenario {
  return {
    name: 'build failure (pre-existing)',
    events: [
      { kind: 'tool-call', timestamp: at(), tool: 'Read' },
      { kind: 'tool-result', timestamp: at(), ok: true },
      { kind: 'completed', timestamp: at() },
    ],
    validation: failedCheck(
      'build',
      'build failed with exit code 2',
      'error TS2304: Cannot find name "LegacyThing"',
    ),
    // The repository was already failing before the run touched anything.
    repositoryBrokenBeforeRun: true,
    expectedFailureType: 'REPOSITORY_PROBLEM',
    expectedModelAttributable: false,
  };
}

/** 6. The provider was overloaded. */
export function providerFailure(): ExecutionScenario {
  return {
    name: 'provider failure',
    events: [
      { kind: 'assistant-message', timestamp: at() },
      { kind: 'error', timestamp: at(), ok: false, summary: 'provider responded 503' },
    ],
    adapterFailureType: 'PROVIDER_FAILURE',
    adapterErrorSummary: 'provider responded 503 Service Unavailable',
    expectedFailureType: 'PROVIDER_FAILURE',
    expectedModelAttributable: false,
  };
}

/** 7. The run exceeded its time limit. */
export function timeout(): ExecutionScenario {
  return {
    name: 'timeout',
    events: [
      { kind: 'assistant-message', timestamp: at() },
      { kind: 'tool-call', timestamp: at(), tool: 'Bash' },
    ],
    adapterFailureType: 'TIMEOUT',
    adapterErrorSummary: 'the agent did not finish within 1800000ms',
    expectedFailureType: 'TIMEOUT',
    expectedModelAttributable: false,
  };
}

/** 8. The user pressed cancel. */
export function userCancellation(): ExecutionScenario {
  return {
    name: 'user cancellation',
    events: [
      { kind: 'assistant-message', timestamp: at() },
      { kind: 'tool-call', timestamp: at(), tool: 'Edit' },
      { kind: 'cancelled', timestamp: at(), summary: 'the run was cancelled' },
    ],
    adapterFailureType: 'USER_CANCELLED',
    expectedFailureType: 'USER_CANCELLED',
    expectedModelAttributable: false,
  };
}

/**
 * 9. The request overflowed the context window.
 *
 * Written to arrive dressed as a provider error, because that is how it
 * usually surfaces — and misreading it would trigger a pointless retry.
 */
export function contextOverflow(): ExecutionScenario {
  return {
    name: 'context overflow',
    events: [
      { kind: 'assistant-message', timestamp: at() },
      { kind: 'error', timestamp: at(), ok: false, summary: 'request failed' },
    ],
    adapterErrorSummary:
      'API error 400: input length and `max_tokens` exceed context limit: 210000 + 8192 > 200000',
    expectedFailureType: 'CONTEXT_LIMIT',
    expectedModelAttributable: false,
  };
}

/**
 * 10. A test failed because the database was unreachable.
 *
 * The scenario spec section 22 names explicitly. It looks exactly like the test
 * failure in fixture 4 — same event shape, same failing check — and must be
 * classified completely differently.
 */
export function environmentFailure(): ExecutionScenario {
  return {
    name: 'environment failure',
    events: [
      { kind: 'tool-call', timestamp: at(), tool: 'Edit' },
      { kind: 'tool-result', timestamp: at(), ok: true },
      { kind: 'file-change', timestamp: at(), path: 'src/repo.ts' },
      { kind: 'terminal-command', timestamp: at(), ok: false },
      { kind: 'completed', timestamp: at() },
    ],
    validation: failedCheck(
      'tests',
      'tests failed with exit code 1',
      'FAIL src/repo.test.ts\n  Error: connect ECONNREFUSED 127.0.0.1:5432\n  at Connection.connect',
    ),
    repositoryBrokenBeforeRun: false,
    expectedFailureType: 'ENVIRONMENT_FAILURE',
    expectedModelAttributable: false,
  };
}

/** All ten scenarios, in the order the phase lists them. */
export function allScenarios(): ExecutionScenario[] {
  resetFixtureClock();
  return [
    successfulTask(),
    toolFailure(),
    repeatedToolFailure(),
    testFailure(),
    buildFailure(),
    providerFailure(),
    timeout(),
    userCancellation(),
    contextOverflow(),
    environmentFailure(),
  ];
}
