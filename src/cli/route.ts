/**
 * `routepilot route` (spec sections 48 and 50).
 *
 * Runs the whole pipeline — classify, analyse, extract features, route — and
 * shows which model was chosen and why. It selects a model but **executes
 * nothing**: the agent adapters exist (Phase 5), but no `routepilot run`
 * command wires them to the router yet.
 *
 * On rendering: the core produces a provider-neutral `explanation` array that
 * any UI can print. In a terminal, a table beats a paragraph, so the CLI
 * renders the same facts as aligned columns and keeps the core's prose
 * available behind `--explain` (and always in `--json`) rather than printing
 * both by default.
 */

import { RoutingEngine, type RoutingDecision, type RoutingPolicy } from '../core/index.js';
import { LearnedSuccessModel } from '../core/learning/success-model.js';
import type { LearningStore } from '../core/types/learning.js';
import type { CalibrationVerdict, PredictionStore } from '../core/types/calibration.js';
import { assessCalibration, NOT_ASSESSED } from '../core/calibration/gate.js';
import { resolveShadowPolicies } from '../core/shadow/policies.js';
import { ShadowRouter } from '../core/shadow/shadow-router.js';
import type { ShadowComparison, ShadowStore } from '../core/types/shadow.js';
import { toScored } from '../core/calibration/metrics.js';
import {
  toCalibrationThresholds,
  toExplorationPolicy,
  toLearningPolicy,
  toRoutingPolicy,
} from '../config/policy.js';
import type { OperationMode } from '../core/bandit/exploration-gate.js';
import { buildRegistries } from '../config/registries.js';
import type { RoutePilotConfig } from '../config/types.js';
import { analyzeTask, type AnalyzeOptions, type AnalyzeResult } from './analyze.js';
import { stageTimings, type StageTimings } from '../core/perf/timings.js';
import { block, count, duration, money, percent, renderTable } from './format.js';

/** What `route` produced. */
export interface RouteResult {
  readonly analysis: AnalyzeResult;
  readonly decision: RoutingDecision;
  /** The calibration safeguard's verdict on the learned predictor. */
  readonly calibration: CalibrationVerdict;
  /**
   * What alternative policies would have chosen.
   *
   * `null` when shadow routing is switched off. **Nothing here was executed** —
   * a shadow outcome is a model id, never a session.
   */
  readonly shadow: ShadowComparison | null;
  /** How long each stage of the routing pass took (spec section 69). */
  readonly timings: StageTimings;
}

/** Options for {@link routeTask}. */
export interface RouteOptions extends AnalyzeOptions {
  readonly config: RoutePilotConfig;
  /** A model the user pinned explicitly. */
  readonly requestedModelId?: string | undefined;
  /** Overrides applied on top of the configured policy, from CLI flags. */
  readonly policyOverrides?: Partial<RoutingPolicy> | undefined;
  /**
   * Where learned statistics are read from.
   *
   * Absent means none are: routing then runs on configured priors alone, which
   * is the default and a fully supported way to operate (spec section 2,
   * rule 16).
   */
  readonly learningStore?:
    (LearningStore & Partial<PredictionStore> & Partial<ShadowStore>) | undefined;
  /**
   * Where this task is being run.
   *
   * Absent means `production`, which suppresses exploration. A caller that has
   * not said where it is running gets the cautious reading, so forgetting this
   * can only ever prevent an experiment (spec section 40).
   */
  readonly operationMode?: OperationMode | undefined;
}

/** How many past predictions the calibration safeguard reads. */
export const CALIBRATION_WINDOW = 2_000;

/** How many past shadow decisions the agreement report reads. */
export const SHADOW_WINDOW = 5_000;

/** Analyse a task and route it. */
export async function routeTask(options: RouteOptions): Promise<RouteResult> {
  const analysis = await analyzeTask(options);
  const { models } = buildRegistries(options.config);

  const policy: RoutingPolicy = {
    ...toRoutingPolicy(options.config),
    ...options.policyOverrides,
  };

  // Learning is read-only here: `route` selects a model, it does not execute
  // one, so there is no outcome to learn from. The store is consulted, never
  // written.
  // The safeguard runs before the learned model is consulted, and scores only
  // the *learned* predictions: pooling them with priors would let good priors
  // disguise bad learning (spec section 41).
  const history = options.learningStore?.loadPredictions?.(CALIBRATION_WINDOW, 'learned') ?? [];
  const calibration =
    history.length === 0
      ? NOT_ASSESSED
      : assessCalibration(toScored(history), toCalibrationThresholds(options.config));

  const learned = new LearnedSuccessModel(
    options.learningStore,
    toLearningPolicy(options.config),
    calibration,
  );
  const exploration = toExplorationPolicy(options.config);

  const routingRequest = {
    features: analysis.features,
    policy,
    operationMode: options.operationMode ?? 'production',
    ...(options.requestedModelId === undefined
      ? {}
      : { requestedModelId: options.requestedModelId }),
  };

  // Shadow policies are evaluated by the same router that produced the live
  // decision, and produce model ids only. No adapter is reachable from here.
  const shadowPolicies = options.config.shadow.enabled
    ? resolveShadowPolicies(options.config.shadow.policies)
    : [];

  const shadow =
    shadowPolicies.length === 0
      ? null
      : new ShadowRouter(models, learned, exploration).compare({
          ...routingRequest,
          shadowPolicies,
        });

  const routingStarted = performance.now();
  const decision =
    shadow?.current ?? new RoutingEngine(models, learned, exploration).route(routingRequest);
  const routingMs = performance.now() - routingStarted;

  return {
    analysis,
    decision,
    calibration,
    shadow,
    timings: stageTimings({ ...analysis.timings, routingMs }),
  };
}

/** How to render a decision. */
export interface RenderOptions {
  /** Also print the core's provider-neutral explanation lines verbatim. */
  readonly explain?: boolean | undefined;
}

/** Render a routing decision for a terminal. */
export function renderDecision(result: RouteResult, options: RenderOptions = {}): string {
  const { decision } = result;
  const sections: string[] = [];

  sections.push(header(decision));
  sections.push(taskSection(result));
  sections.push(`Decision\n  ${decision.reason}`);

  const safeguard = calibrationSection(result.calibration);
  if (safeguard !== null) sections.push(safeguard);

  const shadowed = shadowSection(result.shadow);
  if (shadowed !== null) sections.push(shadowed);

  const experiment = explorationSection(result.decision);
  if (experiment !== null) sections.push(experiment);

  const cost = costSection(decision);
  if (cost !== null) sections.push(cost);

  const candidates = candidateSection(decision);
  if (candidates !== null) sections.push(candidates);

  const excluded = excludedSection(decision);
  if (excluded !== null) sections.push(excluded);

  sections.push(policySection(decision));

  if (options.explain === true) {
    sections.push(`Explanation (provider-neutral form)\n${indent(decision.explanation)}`);
  }

  // Kept accurate as phases land: adapters, monitoring, escalation and
  // telemetry are all built, but nothing calls them from the CLI yet.
  sections.push(
    'Nothing was executed: `routepilot route` only selects a model. ' +
      'No run command exposes the task runner yet (see docs/ROADMAP.md).',
  );

  return sections.join('\n\n');
}

function header(decision: RoutingDecision): string {
  if (decision.selectedModelId === null) {
    return `RoutePilot: no model selected (${decision.outcome})`;
  }

  const marks: string[] = [];
  if (decision.outcome === 'selected-explicit') marks.push('explicitly requested');
  if (decision.outcome === 'selected-below-threshold') marks.push('below confidence threshold');
  if (decision.budgetExceeded) marks.push('over budget');
  if (decision.overrodeExplicitRequest) marks.push('overrode request');

  const suffix = marks.length > 0 ? `  [${marks.join('; ')}]` : '';
  return `RoutePilot: ${decision.selectedModelId}${suffix}`;
}

function taskSection(result: RouteResult): string {
  const { classification } = result.analysis;
  const { level1 } = result.analysis.snapshot;
  const { context } = result.analysis.features;

  return `Task\n${block([
    ['type', `${classification.taskType} (${classification.scope})`],
    ['confidence', percent(classification.confidence)],
    ['risk', percent(classification.risk)],
    [
      'repository',
      `${level1.primaryLanguage ?? 'unknown language'}, ${count(level1.fileCount)} files${
        level1.isMonorepo ? ', monorepo' : ''
      }`,
    ],
    ['context needed', `~${count(context.contextRequirement)} tokens`],
  ])}`;
}

/**
 * The calibration safeguard, shown only when it has something to say.
 *
 * A withdrawn predictor is not a footnote: routing has silently reverted to
 * configured priors, and a user comparing today's decision with yesterday's
 * deserves to know why it changed. A trusted or merely unassessed predictor
 * says nothing here -- `routepilot calibration` is where the detail lives.
 */
function calibrationSection(verdict: CalibrationVerdict): string | null {
  if (verdict.mayApply) return null;

  const lines = [
    `  Learned predictions are not being used: ${verdict.reason}.`,
    '  Routing has fallen back to the configured priors.',
    ...verdict.failures.slice(1).map((failure) => `    - also ${failure}`),
    '  Run `routepilot calibration` for the full reliability breakdown.',
  ];

  return `Calibration safeguard\n${lines.join('\n')}`;
}

/**
 * What alternative policies would have chosen.
 *
 * Shown only when at least one disagrees. Listing three policies that all
 * picked the same model is noise, and the interesting fact -- that nothing
 * disagreed -- is better read from `routepilot shadow` over a history than from
 * a single request.
 *
 * The estimated difference is labelled as an estimate every time it appears.
 * Both sides come from the same success probabilities, and the shadow's model
 * was never run, so a negative number is not a saving that was missed.
 */
function shadowSection(comparison: ShadowComparison | null): string | null {
  if (comparison === null) return null;

  const divergent = comparison.shadows.filter((entry) => !entry.agrees);
  if (divergent.length === 0) return null;

  const rows = divergent.map((entry) => [
    entry.policyId,
    entry.selectedModelId ?? '(would stop)',
    entry.estimatedCostDelta === null
      ? '-'
      : `${entry.estimatedCostDelta >= 0 ? '+' : ''}${entry.estimatedCostDelta.toFixed(4)}`,
    entry.description,
  ]);

  return (
    `Shadow policies (evaluated, not executed)\n${renderTable(
      ['POLICY', 'WOULD CHOOSE', 'EST. COST', 'RULE'],
      rows,
    )}\n  Estimated differences only. The shadow models were not run, so no\n` +
    `  outcome exists for them and these are not measured savings.`
  );
}

/**
 * The experiment, when there was one.
 *
 * Shown only when the bandit actually substituted a model. A user who is
 * charged more than the safe option must be told that a deliberate experiment
 * is why, and what it would otherwise have chosen -- an unexplained
 * substitution reads as a bug.
 *
 * Silence when exploitation happened is intentional: `routepilot status` says
 * whether exploration is on at all, and a banner on every ordinary run would
 * train the reader to ignore this one.
 */
function explorationSection(decision: RoutingDecision): string | null {
  const { exploration } = decision;
  if (!exploration.explored) return null;

  const premium =
    exploration.premium === null
      ? 'unknown'
      : `${exploration.premium >= 0 ? '+' : ''}${exploration.premium.toFixed(4)}`;

  return [
    'Exploring (deliberate experiment)',
    `  Chose "${String(decision.selectedModelId)}" over "${String(exploration.exploitModelId)}" to`,
    '  learn whether it is better than currently believed.',
    `  Estimated extra cost: ${premium}. Every safety limit still applied.`,
    '  Disable with `"exploration": { "enabled": false }` in your configuration.',
  ].join('\n');
}

/**
 * The estimated cost of the selected path.
 *
 * Shown as its own block because cost is the thing RoutePilot exists to
 * manage, and burying it inside a candidate row makes it easy to miss.
 */
function costSection(decision: RoutingDecision): string | null {
  const selected = decision.evaluations.find((e) => e.modelId === decision.selectedModelId);
  if (selected === undefined) return null;

  const { cost, escalationTargetId } = selected;
  const entries: [string, string][] = [
    ['first attempt', money(cost.initial, cost.currency)],
    ['expected total to success', money(cost.expectedTotalToSuccess, cost.currency)],
    ['if it fails, one retry', money(cost.retry, cost.currency)],
    [
      'if it escalates',
      escalationTargetId === null
        ? `${money(cost.escalation, cost.currency)} (nothing stronger available)`
        : `${money(cost.escalation, cost.currency)} via ${escalationTargetId}`,
    ],
    ['estimated latency', duration(selected.estimatedLatencySeconds)],
  ];

  const budget = decision.policy.requestBudget;
  if (budget !== undefined) {
    const share = budget === 0 ? 1 : cost.expectedTotalToSuccess / budget;
    entries.push([
      'request budget',
      `${money(budget, decision.policy.currency)} (${percent(Math.min(share, 9.99))} used)`,
    ]);
  }

  // The provenance label has to track reality: once observations are informing
  // the success probability, calling the figure a pure prior would understate
  // it, and calling it a measurement would overstate it. Say which it is.
  const basis = selected.learningApplied
    ? `from ${count(selected.observations)} observed runs, shrunk toward configured priors`
    : 'from configured priors — not a measurement';

  return `Estimated cost (${basis})
${block(entries)}`;
}

function candidateSection(decision: RoutingDecision): string | null {
  if (decision.evaluations.length === 0) return null;

  // The observations column appears only when something has actually been
  // observed. A column of zeros on every run would train the reader to ignore
  // it, and it is the number that matters most when it is not zero.
  const anyObservations = decision.evaluations.some((candidate) => candidate.observations > 0);

  const rows = decision.evaluations.map((candidate) => [
    candidate.modelId === decision.selectedModelId ? '->' : '',
    candidate.modelId,
    candidate.tier,
    percent(candidate.successProbability),
    ...(anyObservations ? [learnedCell(candidate)] : []),
    money(candidate.cost.expectedTotalToSuccess, candidate.cost.currency).replace(/ \w+$/, ''),
    money(candidate.cost.initial, candidate.cost.currency).replace(/ \w+$/, ''),
    percent(candidate.risk),
    candidateStatus(candidate, decision),
  ]);

  const currency = decision.evaluations[0]?.cost.currency ?? '';

  return `Candidates (${String(decision.evaluations.length)}, costs in ${currency})\n${renderTable(
    [
      '',
      'MODEL',
      'TIER',
      'SUCCESS',
      ...(anyObservations ? ['LEARNED FROM'] : []),
      'EXPECTED',
      'FIRST',
      'RISK',
      'STATUS',
    ],
    rows,
  )}`;
}

/**
 * How much real evidence stands behind a candidate's success estimate.
 *
 * Says plainly when observations exist but are not being used, because a count
 * shown next to an unchanged probability would otherwise look like the number
 * had been learned when it had not (spec section 2, rule 11).
 */
function learnedCell(candidate: RoutingDecision['evaluations'][number]): string {
  if (candidate.observations === 0) return 'no data';
  const runs = `${count(candidate.observations)} ${candidate.observations === 1 ? 'run' : 'runs'}`;
  return candidate.learningApplied
    ? runs
    : `${runs} (prior: ${percent(candidate.staticSuccessProbability)})`;
}

function candidateStatus(
  candidate: RoutingDecision['evaluations'][number],
  decision: RoutingDecision,
): string {
  if (candidate.modelId === decision.selectedModelId) return 'SELECTED';

  const failures: string[] = [];
  if (!candidate.meetsThreshold) failures.push('below confidence');
  if (!candidate.withinRisk) failures.push('over risk limit');
  if (!candidate.withinLatency) failures.push('too slow');
  if (!candidate.withinBudget) failures.push('over budget');

  if (failures.length > 0) return failures.join(', ');
  return candidate.usedTierDefault ? 'eligible (tier default)' : 'eligible';
}

function excludedSection(decision: RoutingDecision): string | null {
  if (decision.excluded.length === 0) return null;

  const rows = decision.excluded.map((exclusion) => [
    exclusion.modelId,
    exclusion.reason,
    exclusion.detail,
  ]);

  return `Excluded before scoring (${String(decision.excluded.length)})\n${renderTable(
    ['MODEL', 'REASON', 'DETAIL'],
    rows,
  )}`;
}

function policySection(decision: RoutingDecision): string {
  const { policy } = decision;

  return `Policy\n${block([
    ['minimum success', percent(policy.minimumSuccessProbability)],
    ['maximum risk', percent(policy.maxRisk)],
    ['maximum latency', duration(policy.maxLatencySeconds)],
    ['request budget', money(policy.requestBudget, policy.currency)],
    ['if over budget', policy.onBudgetExceeded],
    ['model override', policy.modelOverrideEnabled ? 'enabled' : 'disabled'],
    ['static tier prior', `${decision.staticTierPrior} (spec section 13)`],
  ])}`;
}

function indent(lines: readonly string[]): string {
  return lines.map((line) => (line === '' ? '' : `  ${line}`)).join('\n');
}
