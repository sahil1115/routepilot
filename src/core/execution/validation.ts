/**
 * Validation engine (spec section 30).
 *
 * Decides what to check after a run, and runs it.
 *
 * Two constraints shape this file:
 *
 * - **Do not run expensive validation unnecessarily.** A documentation edit does
 *   not need a full build. The plan is chosen from the task, so trivial work
 *   stays cheap — the same principle as progressive repository analysis.
 * - **Validate at meaningful boundaries.** Validation runs after execution has
 *   finished, never against partial output. Parsing a half-written file as if it
 *   were source would produce failures that say nothing about the model.
 *
 * Commands are never guessed. They come from configuration, or from the
 * repository's own manifest scripts. A check with no command is reported as
 * *not run* — `passed: null` — which is distinct from passing and from failing.
 */

import type { CommandRunnerPort } from '../ports.js';
import type { TaskScope } from '../types/features.js';
import type { TaskType } from '../types/task.js';
import type {
  ValidationCheck,
  ValidationCheckResult,
  ValidationPlan,
  ValidationReport,
} from '../types/execution.js';

/** A command to run for one check. */
export interface CheckCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Commands available for validation, by check. */
export type ValidationCommands = Partial<Record<ValidationCheck, CheckCommand>>;

/** Task types that change no code, so most checks are wasted effort. */
const NON_CODE_TASKS: ReadonlySet<TaskType> = new Set<TaskType>([
  'explanation',
  'investigation',
  'documentation',
]);

/** Task types that warrant the full sweep. */
const HEAVY_TASKS: ReadonlySet<TaskType> = new Set<TaskType>([
  'multi-file-refactoring',
  'architecture',
  'migration',
  'performance-optimization',
  'security',
]);

/** Maximum characters of command output retained for classification. */
const MAX_OUTPUT = 4_000;

/** Options for {@link ValidationEngine}. */
export interface ValidationEngineOptions {
  readonly runner: CommandRunnerPort;
  /** Commands to use. Anything absent is reported as not run. */
  readonly commands?: ValidationCommands | undefined;
  /** Milliseconds before a check is abandoned. */
  readonly timeoutMs?: number | undefined;
}

/** Plans and runs post-execution validation. */
export class ValidationEngine {
  readonly #runner: CommandRunnerPort;
  readonly #commands: ValidationCommands;
  readonly #timeoutMs: number;

  constructor(options: ValidationEngineOptions) {
    this.#runner = options.runner;
    this.#commands = options.commands ?? {};
    this.#timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  }

  /**
   * Choose what to validate.
   *
   * Scaled to the task, so a rename does not pay for a full build
   * (spec section 30).
   */
  planFor(taskType: TaskType, scope: TaskScope, changedFiles = 0): ValidationPlan {
    if (NON_CODE_TASKS.has(taskType) && changedFiles === 0) {
      return {
        checks: [],
        rationale: `${taskType} changed no code, so no validation is warranted`,
      };
    }

    if (taskType === 'documentation' || taskType === 'formatting') {
      return {
        checks: ['syntax'],
        rationale: `${taskType} cannot break behaviour, so only syntax is checked`,
      };
    }

    if (HEAVY_TASKS.has(taskType) || scope === 'repository-wide' || scope === 'many-files') {
      return {
        // `diagnostics` is deliberately absent. It has no command form — the
        // only command source, `commandsFromPackageScripts`, cannot supply one
        // — so planning it guaranteed a permanently skipped check, which made
        // every full-sweep report contain a check that could never run.
        // Diagnostics arrive through `DiagnosticsPort`, not a shell command.
        checks: ['syntax', 'build', 'tests'],
        rationale: `${taskType} at ${scope} scope can break anything, so the full sweep runs`,
      };
    }

    return {
      checks: ['syntax', 'tests'],
      rationale: `${taskType} changes code, so syntax and tests are checked`,
    };
  }

  /**
   * Run a plan.
   *
   * Runs after execution completes, never against partial output.
   */
  async run(plan: ValidationPlan, workspaceRoot: string): Promise<ValidationReport> {
    const results: ValidationCheckResult[] = [];
    const skipped: ValidationCheck[] = [];

    for (const check of plan.checks) {
      const command = this.#commands[check];

      if (command === undefined) {
        skipped.push(check);
        results.push({
          check,
          // Not run. Deliberately not `false`: nobody established anything.
          passed: null,
          summary: `no command is configured for the ${check} check, so it was not run`,
          durationMs: 0,
        });
        continue;
      }

      results.push(await this.#runCheck(check, command, workspaceRoot));
    }

    return {
      plan,
      results,
      // Checks that could not run cannot make a report pass or fail.
      passed: results.every((result) => result.passed !== false),
      // ...but a report where nothing ran must not read as a passing one. This
      // is the distinction `passed` cannot carry on its own: it answers "did
      // anything fail", and a plan of all-skipped checks answers that with
      // "no" while establishing nothing at all.
      evaluated: results.some((result) => result.passed !== null),
      skipped,
    };
  }

  /** Plan and run in one step. */
  async validate(
    taskType: TaskType,
    scope: TaskScope,
    workspaceRoot: string,
    changedFiles = 0,
  ): Promise<ValidationReport> {
    return this.run(this.planFor(taskType, scope, changedFiles), workspaceRoot);
  }

  async #runCheck(
    check: ValidationCheck,
    command: CheckCommand,
    workspaceRoot: string,
  ): Promise<ValidationCheckResult> {
    const started = Date.now();

    const outcome = await this.#runner.run({
      command: command.command,
      args: command.args,
      cwd: workspaceRoot,
      timeoutMs: this.#timeoutMs,
    });

    const durationMs = Date.now() - started;
    const output = truncate(`${outcome.stdout}\n${outcome.stderr}`.trim());

    if (outcome.timedOut) {
      return {
        check,
        passed: false,
        summary: `the ${check} check timed out`,
        durationMs,
        output,
      };
    }

    if (!outcome.started) {
      // The command could not be launched at all. That is an environment
      // problem, not a failing check, so it is reported as not run.
      return {
        check,
        passed: null,
        summary: `the ${check} command could not be started: ${outcome.stderr.trim()}`,
        durationMs,
        output,
      };
    }

    const passed = outcome.exitCode === 0;
    return {
      check,
      passed,
      summary: passed
        ? `${check} passed`
        : `${check} failed with exit code ${String(outcome.exitCode)}`,
      ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
      output,
      durationMs,
    };
  }
}

/**
 * Derive validation commands from a repository's own manifest scripts.
 *
 * Nothing is invented: a check is only configured when the repository actually
 * declares a script for it.
 */
export function commandsFromPackageScripts(
  scripts: Readonly<Record<string, string>>,
  packageManager = 'npm',
): ValidationCommands {
  const commands: ValidationCommands = {};
  const run = (script: string): CheckCommand => ({
    command: packageManager,
    args: ['run', script],
  });

  const assign = (check: ValidationCheck, candidates: readonly string[]): void => {
    const found = candidates.find((name) => typeof scripts[name] === 'string');
    if (found !== undefined) {
      Object.assign(commands, { [check]: run(found) });
    }
  };

  assign('syntax', ['typecheck', 'type-check', 'tsc']);
  assign('lint', ['lint']);
  assign('build', ['build', 'compile']);
  assign('tests', ['test', 'tests']);

  return commands;
}

function truncate(text: string): string {
  return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}…`;
}
