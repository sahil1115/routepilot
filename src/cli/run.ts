/**
 * `routepilot run` (spec section 74).
 *
 * The command that joins the MVP spine end to end:
 *
 *   TASK -> ROUTING -> MODEL -> EXECUTION -> MONITORING -> ESCALATION -> OUTCOME
 *
 * Everything below `route` already existed and was reachable only from tests.
 * This is the production caller.
 *
 * ## Why it plans by default and executes only when told
 *
 * `run` hands a coding agent write access to a workspace. **No adapter has ever
 * been verified against its real tool**, so an accidental invocation is a real
 * risk rather than a theoretical one: a mistyped command should not be able to
 * start an agent editing a repository.
 *
 * So the default is a plan — the whole routing pass, the adapter that would be
 * used, the budget, the ceiling on spend — with nothing executed. `--execute`
 * is the deliberate act. This costs one flag and removes a class of accident
 * that cannot be undone, and it is the same reasoning that keeps exploration
 * off in production mode.
 *
 * ## What it will refuse to do
 *
 * - execute with no adapter available (with the adapter's own setup guidance)
 * - execute a decision the router declined to make
 * - commit anything, ever (principle 13)
 */

import type { AgentRegistry } from '../adapters/registry.js';
import { RegistryExecutor } from '../adapters/executor.js';
import { buildAdapters, buildableAdapterIds, type AdapterProbe } from '../adapters/build.js';
import { ADAPTER_VERIFICATION } from '../adapters/verification.js';
import { TaskRunner } from '../core/run/task-runner.js';
import { LearnedSuccessModel } from '../core/learning/success-model.js';
import { toLearningPolicy } from '../config/policy.js';
import { recordRun } from '../telemetry/recorder.js';
import type { LocalStore } from '../telemetry/open.js';
import type { RunResult } from '../core/types/run.js';
import { ValidationEngine } from '../core/execution/validation.js';
import { RoutingEngine } from '../core/routing/routing-engine.js';
import { buildRegistries } from '../config/registries.js';
import { toRoutingPolicy } from '../config/policy.js';
import type { RoutePilotConfig } from '../config/types.js';
import { NodeCommandRunner } from '../infra/node-command-runner.js';
import { block, money, renderTable } from './format.js';
import type { RouteResult } from './route.js';

/** Why a run did not execute. */
export type RunRefusal =
  'plan-only' | 'no-adapter' | 'no-model' | 'unknown-adapter' | 'nested-session';

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
 * The routing pass has already happened — `run` takes its result rather than
 * repeating it, so the model the plan names is provably the model that
 * executes.
 */
export async function runTask(options: RunCommandOptions): Promise<RunCommandResult> {
  const { route, config } = options;

  // A decision the router declined is not a failure to report as one. It is a
  // legitimate answer, and executing anyway would override it.
  if (route.decision.selectedModelId === null) {
    return { route, probes: [], run: null, refusal: 'no-model' };
  }

  const built =
    options.registry === undefined
      ? await buildAdapters(options.adapterId === undefined ? {} : { only: options.adapterId })
      : { registry: options.registry, probes: options.probes ?? [] };

  if (options.adapterId !== undefined && !buildableAdapterIds().includes(options.adapterId)) {
    return { route, probes: built.probes, run: null, refusal: 'unknown-adapter' };
  }

  if (options.execute !== true) {
    return { route, probes: built.probes, run: null, refusal: 'plan-only' };
  }

  if (built.registry.size === 0) {
    return { route, probes: built.probes, run: null, refusal: 'no-adapter' };
  }

  // Checked after the plan branch, so a plan is always available: someone
  // inside a Claude Code session can still ask what would happen, and only
  // execution is refused.
  const nested = nestedAdapterIds(options.env ?? process.env);
  const usable = built.registry.list().filter((adapter) => !nested.includes(adapter.id));
  if (usable.length === 0) {
    return { route, probes: built.probes, run: null, refusal: 'nested-session' };
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
    router: new RoutingEngine(models),
    executor: new RegistryExecutor(built.registry),
    ...(learned === undefined ? {} : { learned }),
    // No commands are configured, so every check reports "not run" rather than
    // "passed". Absent is not zero: a validation that did not happen must never
    // read as a validation that succeeded.
    validation: new ValidationEngine({ runner: new NodeCommandRunner() }),
  });

  const run = await runner.run({
    requestId: `run-${String(Date.now())}`,
    task: options.task,
    workspaceRoot: options.workspaceRoot,
    features: route.analysis.features,
    policy: toRoutingPolicy(config),
    ...(options.requestedModelId === undefined
      ? {}
      : { requestedModelId: options.requestedModelId }),
  });

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
        decision: route.decision,
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

  return { route, probes: built.probes, run, refusal: null };
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
  sections.push(outcomeSection(result.run, currency));
  sections.push(attemptsSection(result.run, currency));

  if (result.run.escalations.length > 0) sections.push(escalationSection(result.run));

  return sections.join('\n\n');
}

function planHeader(result: RunCommandResult): string {
  const { decision } = result.route;
  const selected = decision.evaluations.find((e) => e.modelId === decision.selectedModelId);

  return `Plan (nothing executed)
${block([
  ['model', decision.selectedModelId ?? 'none selected'],
  ['reason', decision.reason],
  [
    'expected total to success',
    selected === undefined
      ? 'unknown'
      : money(selected.cost.expectedTotalToSuccess, selected.cost.currency),
  ],
])}`;
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
    default:
      return '';
  }
}

function outcomeSection(run: RunResult, currency: string): string {
  const entries: [string, string][] = [
    ['status', run.outcome],
    ['model', run.finalModelId ?? 'none'],
    ['attempts', String(run.attempts.length)],
    ['total cost', money(run.totalCost, currency)],
    ['reason', run.reason],
  ];
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
