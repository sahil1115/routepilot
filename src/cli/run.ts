/**
 * `routepilot run` (spec section 74).
 *
 * Joins the MVP spine end to end:
 *
 *   TASK -> ROUTING -> MODEL -> EXECUTION -> MONITORING -> ESCALATION -> OUTCOME
 *
 * Plans by default and executes only when told. `run` hands a coding agent
 * write access to a workspace, so a mistyped command must not be able to start
 * an agent editing a repository. The default prints the whole routing pass, the
 * adapter that would be used, the budget and the spending ceiling, and runs
 * nothing; `--execute` is the deliberate act.
 *
 * It refuses to execute with no adapter available (reporting the adapter's own
 * setup guidance), to execute a decision the router declined to make, to
 * execute the agent it is running inside, to exceed the request budget without
 * refusing or saying so, and to commit anything, ever (principle 13).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentRegistry } from '../adapters/registry.js';
import { RegistryExecutor } from '../adapters/executor.js';
import { buildAdapters, buildableAdapterIds, type AdapterProbe } from '../adapters/build.js';
import { ADAPTER_VERIFICATION } from '../adapters/verification.js';
import { TaskRunner } from '../core/run/task-runner.js';
import { LearnedSuccessModel } from '../core/learning/success-model.js';
import { toEscalationLimits, toLearningPolicy } from '../config/policy.js';
import { recordRun } from '../telemetry/recorder.js';
import type { LocalStore } from '../telemetry/open.js';
import type { RunResult } from '../core/types/run.js';
import {
  ValidationEngine,
  commandsFromPackageScripts,
  type ValidationCommands,
} from '../core/execution/validation.js';
import { buildRegistries } from '../config/registries.js';
import { toRoutingPolicy } from '../config/policy.js';
import type { RoutePilotConfig } from '../config/types.js';
import { NodeCommandRunner } from '../infra/node-command-runner.js';
import { block, money, renderTable } from './format.js';
import type { RouteResult } from './route.js';

/** Why a run did not execute. */
export type RunRefusal =
  | 'plan-only'
  | 'no-adapter'
  | 'no-model'
  | 'unknown-adapter'
  | 'nested-session'
  | 'budget-exceeded';

/** An overspend that was permitted, and by what. */
export interface PermittedOverspend {
  readonly modelId: string;
  /** Expected total cost to success of the selected model. */
  readonly estimate: number;
  readonly budget: number;
  readonly currency: string;
  /** Configuration said allow, or the user passed `--allow-over-budget`. */
  readonly permittedBy: 'policy' | 'flag';
}

/**
 * Adapters that cannot run inside a session of their own tool.
 *
 * Claude Code cannot be launched from within Claude Code — it crashes every
 * active session, which is a data-loss bug rather than an inconvenience.
 * `scripts/verify-adapter.mjs` has refused this since Phase 5; `run --execute`
 * reaches the same binary by a different path and needs the same guard.
 *
 * Keyed by the environment variable whose presence indicates the session.
 */
const NESTING_GUARDS: ReadonlyMap<string, string> = new Map([['claude-code', 'CLAUDECODE']]);

/** Adapter ids that must not be started from inside the current process's environment. */
export function nestedAdapterIds(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [...NESTING_GUARDS]
    .filter(([, variable]) => {
      const value = env[variable];
      return value !== undefined && value !== '';
    })
    .map(([adapterId]) => adapterId);
}

/** What `run` produced. */
export interface RunCommandResult {
  readonly route: RouteResult;
  /** Every adapter probed, available or not. */
  readonly probes: readonly AdapterProbe[];
  /** The run, or null when nothing was executed. */
  readonly run: RunResult | null;
  /** Why nothing was executed, or null when something was. */
  readonly refusal: RunRefusal | null;
  /**
   * Set when the run knowingly exceeded the request budget.
   *
   * Never silent: whenever this is non-null the rendered output names the model,
   * the estimate, the budget and what permitted it (spec section 2, rule 7).
   */
  readonly overspend: PermittedOverspend | null;
  /**
   * The configured behaviour when the budget is exceeded.
   *
   * Carried from the configuration the run consulted, not from the decision's
   * policy: the two agree in the real CLI, but the rendered refusal must name
   * the rule that was actually applied.
   */
  readonly onBudgetExceeded: RoutePilotConfig['budgets']['onExceeded'];
}

/** Options for {@link runTask}. */
export interface RunCommandOptions {
  readonly route: RouteResult;
  readonly config: RoutePilotConfig;
  readonly workspaceRoot: string;
  /** The task text, carried from the caller rather than recovered from the analysis. */
  readonly task: string;
  /** A model the user pinned. Honoured, never explored away from. */
  readonly requestedModelId?: string | undefined;
  /** Actually execute. Absent or false produces a plan and runs nothing. */
  readonly execute?: boolean | undefined;
  /**
   * Run an explicitly requested model past the request budget.
   *
   * Only consulted when `budgets.onExceeded` is `ask`. A policy of `stop` is
   * the configuration saying no, and a command-line flag does not outrank it.
   */
  readonly allowOverBudget?: boolean | undefined;
  /** Restrict to one adapter id. */
  readonly adapterId?: string | undefined;
  /** Injected for tests, so no process is ever spawned in the suite. */
  readonly registry?: AgentRegistry | undefined;
  readonly probes?: readonly AdapterProbe[] | undefined;
  /** Environment consulted for nesting guards. Injected for tests. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * Where the run is recorded, and where learning reads and writes.
   *
   * Absent means nothing is recorded, which is a supported way to operate
   * (principle 17) — not a degraded one.
   */
  readonly store?: LocalStore | undefined;
  /** Reported problems that must not fail the run. */
  readonly onProblem?: ((message: string) => void) | undefined;
}

/**
 * Run one task to a conclusion, or explain why it will not.
 *
 * The routing pass has already happened, and its decision is handed to the
 * runner to execute as-is -- the runner routes nothing. That is what makes the
 * model the plan names, by construction, the model that runs. A runner that
 * re-routed could name a different model than the plan once learning or
 * exploration was in play.
 */
export async function runTask(options: RunCommandOptions): Promise<RunCommandResult> {
  const { route, config } = options;
  const refuse = (refusal: RunRefusal, probes: readonly AdapterProbe[] = []): RunCommandResult => ({
    route,
    probes,
    run: null,
    refusal,
    overspend: null,
    onBudgetExceeded: config.budgets.onExceeded,
  });

  // A decision the router declined is not a failure to report as one. It is a
  // legitimate answer, and executing anyway would override it.
  if (route.decision.selectedModelId === null) return refuse('no-model');

  const built =
    options.registry === undefined
      ? await buildAdapters({
          // A structural copy: `AgentsConfig` names its two adapters as
          // required keys, while `buildAdapters` takes any adapter id. Spreading
          // keeps the config type closed -- a typo'd adapter section is still a
          // schema error -- without forcing the builder to know the names.
          agents: { ...config.agents },
          ...(options.adapterId === undefined ? {} : { only: options.adapterId }),
        })
      : { registry: options.registry, probes: options.probes ?? [] };

  if (options.adapterId !== undefined && !buildableAdapterIds().includes(options.adapterId)) {
    return refuse('unknown-adapter', built.probes);
  }

  if (options.execute !== true) return refuse('plan-only', built.probes);

  if (built.registry.size === 0) return refuse('no-adapter', built.probes);

  // Checked after the plan branch, so a plan is always available: someone
  // inside a Claude Code session can still ask what would happen, and only
  // execution is refused.
  const nested = nestedAdapterIds(options.env ?? process.env);
  const usable = built.registry.list().filter((adapter) => !nested.includes(adapter.id));
  if (usable.length === 0) return refuse('nested-session', built.probes);

  // A selection that knowingly exceeds the request budget is only ever an
  // explicitly requested model (the router never picks one past the budget on
  // its own). What happens next is the configured behaviour, and never
  // nothing: `stop` and `ask` refuse, `allow-fallback` executes and says so.
  const overspend = overspendOf(route.decision, options);
  if (route.decision.budgetExceeded && overspend === null) {
    return refuse('budget-exceeded', built.probes);
  }

  const { models } = buildRegistries(config);

  // Learning is handed to the runner only when it is switched on. Absent, the
  // runner records no observations at all — the difference between "learning is
  // off" and "learning is on with nothing to say" has to stay visible.
  const learned =
    config.learning.enabled && options.store !== undefined
      ? new LearnedSuccessModel(options.store, toLearningPolicy(config))
      : undefined;

  const runner = new TaskRunner({
    models,
    // No router: the decision below is executed as-is.
    executor: new RegistryExecutor(built.registry),
    // Every limit the configuration states, including the request budget as a
    // cap on total spend across retries and escalations. Without these the
    // runner used built-in defaults and the budget bounded selection only.
    limits: toEscalationLimits(config),
    ...(learned === undefined ? {} : { learned }),
    // Checks are derived from the workspace's own manifest scripts. Nothing is
    // invented: a check is configured only where the repository declares a
    // script for it, and a repository that declares none is validated by
    // nothing and reports `unverified` rather than `succeeded`.
    validation: new ValidationEngine({
      runner: new NodeCommandRunner(),
      commands: await validationCommands(options.workspaceRoot, options.onProblem),
    }),
  });

  const run = await runner.run({
    requestId: `run-${String(Date.now())}`,
    task: options.task,
    workspaceRoot: options.workspaceRoot,
    features: route.analysis.features,
    policy: toRoutingPolicy(config),
    decision: route.decision,
    // The permission decided above, handed to the runner explicitly. The runner
    // refuses an over-budget decision on its own, so this is where the CLI's
    // `budgets.onExceeded` ruling actually takes effect rather than being
    // assumed by both sides.
    allowOverBudget: overspend !== null,
    ...(options.requestedModelId === undefined
      ? {}
      : { requestedModelId: options.requestedModelId }),
  });

  // The invariant this command exists to keep. It is the same object, not an
  // equal one: the runner was handed the plan's decision and must not have
  // replaced it. A violation is a programming error, so it throws.
  if (run.decision !== route.decision) {
    throw new Error('run executed a decision other than the one it was given');
  }

  // Section 75's final step. Recording is best-effort and deliberately after
  // the run: telemetry must never be able to fail a task that already
  // succeeded, so a store that throws costs a warning and nothing else.
  if (options.store !== undefined) {
    try {
      recordRun({
        store: options.store,
        requestId: run.requestId,
        prompt: options.task,
        workspaceRoot: options.workspaceRoot,
        features: route.analysis.features,
        run,
      });
    } catch (error) {
      options.onProblem?.(
        `the run finished but could not be recorded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    route,
    probes: built.probes,
    run,
    refusal: null,
    overspend,
    onBudgetExceeded: config.budgets.onExceeded,
  };
}

/**
 * Validation commands the workspace itself declares.
 *
 * `commandsFromPackageScripts` has existed and been tested since Phase 6 with
 * no production caller, so every real run planned checks and ran none — and a
 * report where nothing ran used to read as a pass. Reading the manifest is what
 * turns that honesty fix into an actual check.
 *
 * A missing or unreadable manifest is not an error: the run proceeds and
 * reports `unverified`, which is the truth about it.
 */
async function validationCommands(
  workspaceRoot: string,
  onProblem?: (message: string) => void,
): Promise<ValidationCommands> {
  try {
    const raw = await readFile(join(workspaceRoot, 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as { scripts?: Record<string, string> };
    const commands = commandsFromPackageScripts(manifest.scripts ?? {});

    if (Object.keys(commands).length === 0) {
      onProblem?.(
        'this workspace declares no test, build or typecheck script, so the run ' +
          'cannot be validated and will report "unverified".',
      );
    }
    return commands;
  } catch {
    // No manifest, or not JSON. Nothing to derive; say so rather than guess.
    onProblem?.(
      'no readable package.json in this workspace, so the run cannot be ' +
        'validated and will report "unverified".',
    );
    return {};
  }
}

/**
 * The permitted overspend, or null when the run is either within budget or
 * must be refused.
 */
function overspendOf(
  decision: RouteResult['decision'],
  options: RunCommandOptions,
): PermittedOverspend | null {
  if (!decision.budgetExceeded || decision.selectedModelId === null) return null;
  const budget = decision.policy.requestBudget;
  if (budget === undefined) return null;

  const behaviour = options.config.budgets.onExceeded;
  const permittedBy: PermittedOverspend['permittedBy'] | null =
    behaviour === 'allow-fallback'
      ? 'policy'
      : behaviour === 'ask' && options.allowOverBudget === true
        ? 'flag'
        : null;
  if (permittedBy === null) return null;

  const selected = decision.evaluations.find((e) => e.modelId === decision.selectedModelId);
  return {
    modelId: decision.selectedModelId,
    estimate: selected?.cost.expectedTotalToSuccess ?? Number.NaN,
    budget,
    currency: decision.policy.currency,
    permittedBy,
  };
}

/** Name the model, the estimate and the budget, for any message about an overspend. */
function describeOverBudget(result: RunCommandResult): string {
  const { decision } = result.route;
  const selected = decision.evaluations.find((e) => e.modelId === decision.selectedModelId);
  const currency = decision.policy.currency;
  const estimate =
    selected === undefined
      ? 'an unknown amount'
      : money(selected.cost.expectedTotalToSuccess, currency);
  const budget = money(decision.policy.requestBudget, currency);
  return `"${decision.selectedModelId ?? 'none'}" is expected to cost ${estimate} against a request budget of ${budget}`;
}

/** Render what `run` did, or what it would have done. */
export function renderRun(result: RunCommandResult): string {
  const sections: string[] = [];

  if (result.run === null) {
    sections.push(planHeader(result));
    const adapters = adapterSection(result.probes);
    if (adapters !== null) sections.push(adapters);
    sections.push(refusalSection(result));
    return sections.join('\n\n');
  }

  const currency = currencyFor(result);
  sections.push(outcomeSection(result.run, currency, result.overspend));
  sections.push(attemptsSection(result.run, currency));

  if (result.run.escalations.length > 0) sections.push(escalationSection(result.run));

  return sections.join('\n\n');
}

function planHeader(result: RunCommandResult): string {
  const { decision } = result.route;
  const selected = decision.evaluations.find((e) => e.modelId === decision.selectedModelId);

  const entries: [string, string][] = [
    ['model', decision.selectedModelId ?? 'none selected'],
    ['reason', decision.reason],
    [
      'expected total to success',
      selected === undefined
        ? 'unknown'
        : money(selected.cost.expectedTotalToSuccess, selected.cost.currency),
    ],
  ];
  // The plan shows the marker; only execution has to decide what to do about it.
  if (decision.budgetExceeded)
    entries.push(['budget', `over budget: ${describeOverBudget(result)}`]);

  return `Plan (nothing executed)
${block(entries)}`;
}

function adapterSection(probes: readonly AdapterProbe[]): string | null {
  if (probes.length === 0) return null;

  // Availability and verification are different questions and both are shown.
  // An adapter can be installed and answering version probes while never having
  // executed a single task through RoutePilot, which is true of every one of
  // them today.
  const verified = new Map(ADAPTER_VERIFICATION.map((entry) => [entry.adapterId, entry.status]));

  return renderTable(
    ['adapter', 'available', 'verified', 'detail'],
    probes.map((probe) => [
      probe.adapter.id,
      probe.status.available ? 'yes' : 'no',
      verified.get(probe.adapter.id) ?? 'unknown',
      probe.status.detail ?? probe.status.version ?? '',
    ]),
  );
}

function refusalSection(result: RunCommandResult): string {
  switch (result.refusal) {
    case 'plan-only':
      return [
        'Not executed',
        '  This was a plan. Pass --execute to actually run the agent.',
        '',
        '  No adapter has been verified against its real tool, so RoutePilot',
        '  will not start one without being asked explicitly.',
      ].join('\n');
    case 'no-adapter':
      return [
        'Cannot execute',
        '  No coding agent is available.',
        ...result.probes
          .filter((probe) => !probe.status.available)
          .map(
            (probe) => `    ${probe.adapter.displayName}: ${probe.status.detail ?? 'unavailable'}`,
          ),
      ].join('\n');
    case 'unknown-adapter':
      return `Cannot execute
  Unknown adapter. Known ids: ${buildableAdapterIds().join(', ')}`;
    case 'nested-session':
      return [
        'Cannot execute',
        '  This looks like a session of the very agent RoutePilot would start.',
        '  Running it nested inside itself crashes every active session, so',
        '  RoutePilot will not do it. Run this from a plain terminal.',
      ].join('\n');
    case 'no-model':
      return [
        'Cannot execute',
        '  The router declined to select a model.',
        `  ${result.route.decision.reason}`,
      ].join('\n');
    case 'budget-exceeded':
      return [
        'Cannot execute: over budget',
        `  ${describeOverBudget(result)}.`,
        ...(result.onBudgetExceeded === 'ask'
          ? [
              '',
              '  budgets.onExceeded is "ask". To run it anyway, pass --allow-over-budget',
              '  together with --execute.',
            ]
          : [
              '',
              '  budgets.onExceeded is "stop", so this cannot be overridden from the command line.',
            ]),
      ].join('\n');
    default:
      return '';
  }
}

function outcomeSection(
  run: RunResult,
  currency: string,
  overspend: PermittedOverspend | null,
): string {
  const entries: [string, string][] = [
    ['status', run.outcome],
    ['model', run.finalModelId ?? 'none'],
    ['attempts', String(run.attempts.length)],
    ['total cost', money(run.totalCost, currency)],
    ['reason', run.reason],
  ];
  // An overspend is printed, never implied. This line is the difference between
  // exceeding a budget and exceeding it silently.
  if (overspend !== null) {
    entries.push([
      'over budget',
      `"${overspend.modelId}" was expected to cost ${money(overspend.estimate, overspend.currency)} ` +
        `against a request budget of ${money(overspend.budget, overspend.currency)}; executed because ` +
        (overspend.permittedBy === 'policy'
          ? 'budgets.onExceeded is "allow-fallback"'
          : '--allow-over-budget was passed'),
    ]);
  }
  // Only present when the run stopped to ask something (spec section 30).
  if (run.question !== null) entries.push(['question', run.question]);

  return `Outcome
${block(entries)}`;
}

function attemptsSection(run: RunResult, currency: string): string {
  return renderTable(
    ['#', 'model', 'result', 'failure', 'cost'],
    run.attempts.map((attempt) => [
      String(attempt.index + 1),
      attempt.modelId,
      attempt.succeeded ? 'ok' : 'failed',
      attempt.failureType ?? '',
      money(attempt.cost, currency),
    ]),
  );
}

function escalationSection(run: RunResult): string {
  return renderTable(
    ['from', 'to', 'action', 'why'],
    run.escalations.map((step) => [
      step.fromModelId,
      step.toModelId ?? '',
      step.action,
      step.reason,
    ]),
  );
}

/**
 * The currency the decision was priced in.
 *
 * Taken from the evaluation rather than assumed, so a configuration priced in
 * anything other than USD does not get its numbers relabelled.
 */
function currencyFor(result: RunCommandResult): string {
  const selected = result.route.decision.evaluations.find(
    (evaluation) => evaluation.modelId === result.route.decision.selectedModelId,
  );
  return selected?.cost.currency ?? 'USD';
}
