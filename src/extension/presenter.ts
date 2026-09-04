/**
 * Turning a routing result into what the editor shows (spec section 49).
 *
 * Pure -- no `vscode` import, no I/O, no clock -- so all of it is testable,
 * which matters because the extension host cannot be driven from this suite and
 * anything living inside it would ship unverified.
 *
 * Redaction is applied here rather than at display. Every string these
 * functions return can reach a tooltip, panel, notification or output channel,
 * and a configuration error can quote a file's contents while a provider
 * failure can quote a request header. Redacting at construction means a new
 * call site in the shell cannot forget (sections 34 and 51).
 */

import type { RoutingDecision } from '../core/types/routing.js';
import type { OutcomeRecord } from '../core/types/telemetry.js';
import { redact } from '../telemetry/redaction.js';
import type {
  CostIndicator,
  EscalationIndicator,
  ExtensionPhase,
  HistoryRow,
  IndicatorSeverity,
  ModelIndicator,
  RoutingView,
  StatusBarModel,
} from './types.js';

/** Command ids the extension contributes. Shared so the shell cannot mistype one. */
export const COMMANDS = {
  route: 'routepilot.route',
  explain: 'routepilot.explain',
  history: 'routepilot.history',
  cancel: 'routepilot.cancel',
  settings: 'routepilot.openSettings',
} as const;

/**
 * Escalation is flagged above this failure probability.
 *
 * At one in four, a second and dearer attempt is likely enough that a user
 * deciding whether to start would want to know.
 */
export const ESCALATION_LIKELY_ABOVE = 0.25;

/** What the extension is doing, and what came back. */
export type ExtensionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'analysing'; readonly task: string }
  | { readonly kind: 'routed'; readonly decision: RoutingDecision; readonly task: string }
  | { readonly kind: 'cancelled'; readonly task: string }
  | { readonly kind: 'failed'; readonly message: string };

/** Build everything the editor shows from one state. */
export function present(state: ExtensionState): RoutingView {
  switch (state.kind) {
    case 'routed':
      return presentDecision(state.decision);
    case 'analysing':
      return simpleView('analysing', {
        text: '$(sync~spin) RoutePilot: analysing…',
        tooltip: `Analysing "${redact(truncate(state.task, 80))}".\n\nClick to cancel.`,
        command: COMMANDS.cancel,
        severity: 'active',
        busy: true,
      });
    case 'cancelled':
      return simpleView('cancelled', {
        text: '$(circle-slash) RoutePilot: cancelled',
        tooltip: 'The last routing request was cancelled.',
        command: COMMANDS.route,
        severity: 'neutral',
        busy: false,
      });
    case 'failed':
      // The message is redacted here even though it is redacted again by the
      // caller in some paths. Redacting twice is harmless; redacting nowhere
      // is a leak.
      return simpleView('failed', {
        text: '$(error) RoutePilot',
        tooltip: `RoutePilot could not route this task.\n\n${redact(state.message)}`,
        command: COMMANDS.route,
        severity: 'error',
        busy: false,
      });
    case 'idle':
    default:
      return simpleView('idle', {
        text: '$(rocket) RoutePilot',
        tooltip: 'RoutePilot is ready. Click to route a task.',
        command: COMMANDS.route,
        severity: 'neutral',
        busy: false,
      });
  }
}

/** The full view for a completed decision. */
function presentDecision(decision: RoutingDecision): RoutingView {
  const selected =
    decision.selectedModelId === null
      ? undefined
      : decision.evaluations.find((entry) => entry.modelId === decision.selectedModelId);

  const model = selected === undefined ? null : modelIndicator(selected);
  const cost = selected === undefined ? null : costIndicator(selected, decision);
  const escalation = selected === undefined ? null : escalationIndicator(selected);

  return {
    phase: 'routed',
    statusBar: statusBar(decision, model, cost, escalation),
    model,
    cost,
    escalation,
    explanation: explanationMarkdown(decision),
    summary: redact(decision.reason),
  };
}

/** The model indicator. */
function modelIndicator(selected: RoutingDecision['evaluations'][number]): ModelIndicator {
  return {
    modelId: selected.modelId,
    shortName: shortName(selected.modelId),
    tier: selected.tier,
    successProbability: selected.successProbability,
    observations: selected.observations,
    learned: selected.learningApplied,
  };
}

/** The cost indicator. */
function costIndicator(
  selected: RoutingDecision['evaluations'][number],
  decision: RoutingDecision,
): CostIndicator {
  const budget = decision.policy.requestBudget;

  return {
    initial: selected.cost.initial,
    expectedTotal: selected.cost.expectedTotalToSuccess,
    currency: selected.cost.currency,
    // `null` rather than 0 when unlimited: a zero fraction would render as a
    // full budget bar sitting at empty, which reads as a limit that exists.
    budgetFraction:
      budget === undefined || budget <= 0 ? null : selected.cost.expectedTotalToSuccess / budget,
    overBudget: decision.budgetExceeded || !selected.withinBudget,
  };
}

/** The escalation indicator. */
function escalationIndicator(
  selected: RoutingDecision['evaluations'][number],
): EscalationIndicator {
  const failureProbability = selected.cost.failureProbability;

  return {
    targetModelId: selected.escalationTargetId,
    // `null`, not zero, when there is nothing to escalate to. Zero would read
    // as "escalation is free".
    estimatedCost: selected.escalationTargetId === null ? null : selected.cost.escalation,
    failureProbability,
    likely: selected.escalationTargetId !== null && failureProbability > ESCALATION_LIKELY_ABOVE,
  };
}

/** The status bar entry for a completed decision. */
function statusBar(
  decision: RoutingDecision,
  model: ModelIndicator | null,
  cost: CostIndicator | null,
  escalation: EscalationIndicator | null,
): StatusBarModel {
  if (model === null || cost === null) {
    return {
      text: '$(circle-slash) RoutePilot: no model',
      tooltip: `No model was selected.\n\n${redact(decision.reason)}`,
      command: COMMANDS.explain,
      severity: 'warning',
      busy: false,
    };
  }

  // Warning rather than neutral when money or a likely escalation is at stake,
  // so the colour carries information instead of being decoration.
  const severity: IndicatorSeverity =
    cost.overBudget || decision.exploration.explored ? 'warning' : 'neutral';

  const marks = [
    decision.exploration.explored ? '$(beaker)' : '',
    escalation?.likely === true ? '$(arrow-up)' : '',
  ]
    .filter((mark) => mark !== '')
    .join('');

  return {
    text: `$(rocket) ${model.shortName} · ${money(cost.expectedTotal, cost.currency)}${marks === '' ? '' : ` ${marks}`}`,
    tooltip: tooltipMarkdown(decision, model, cost, escalation),
    command: COMMANDS.explain,
    severity,
    busy: false,
  };
}

/** The status bar tooltip: the whole decision in a few lines. */
function tooltipMarkdown(
  decision: RoutingDecision,
  model: ModelIndicator,
  cost: CostIndicator,
  escalation: EscalationIndicator | null,
): string {
  const lines = [
    `**${model.modelId}** · ${model.tier}`,
    '',
    `Estimated success: ${percent(model.successProbability)}` +
      (model.learned
        ? ` (learned from ${String(model.observations)} runs)`
        : ' (configured prior)'),
    `Expected total cost: ${money(cost.expectedTotal, cost.currency)}`,
    `First attempt: ${money(cost.initial, cost.currency)}`,
  ];

  if (cost.budgetFraction !== null) {
    lines.push(`Budget used: ${percent(cost.budgetFraction)}`);
  }
  if (cost.overBudget) {
    lines.push('', '**Over budget.**');
  }

  if (escalation?.targetModelId != null) {
    lines.push(
      '',
      `If it fails (${percent(escalation.failureProbability)}), escalates to ` +
        `**${escalation.targetModelId}**` +
        (escalation.estimatedCost === null
          ? ''
          : ` at about ${money(escalation.estimatedCost, cost.currency)}`),
    );
  }

  if (decision.exploration.explored) {
    lines.push(
      '',
      `**Experiment.** Chose this over *${String(decision.exploration.exploitModelId)}* to learn ` +
        'whether it is better than currently believed.',
    );
  }

  lines.push('', '_Estimates from configured priors and recorded outcomes, not measurements._');
  lines.push('Click for the full explanation.');

  return redact(lines.join('\n'));
}

/**
 * The routing explanation, as Markdown.
 *
 * Built from the core's own provider-neutral `explanation` lines rather than
 * re-deriving anything, so the editor and the CLI can never disagree about why
 * a model was chosen.
 */
export function explanationMarkdown(decision: RoutingDecision): string {
  const sections: string[] = ['# RoutePilot decision', '', redact(decision.reason), ''];

  sections.push('## Why', '');
  for (const line of decision.explanation) {
    sections.push(redact(line));
  }

  sections.push('', '## Candidates', '');
  if (decision.evaluations.length === 0) {
    sections.push('_No model satisfied the hard constraints for this task._');
  } else {
    sections.push('| Model | Tier | Success | Expected | First | Status |');
    sections.push('| --- | --- | --- | --- | --- | --- |');
    for (const candidate of decision.evaluations) {
      const status =
        candidate.modelId === decision.selectedModelId
          ? '**selected**'
          : candidate.viable
            ? 'eligible'
            : 'not viable';
      sections.push(
        `| \`${candidate.modelId}\` | ${candidate.tier} | ${percent(candidate.successProbability)} ` +
          `| ${candidate.cost.expectedTotalToSuccess.toFixed(4)} | ${candidate.cost.initial.toFixed(4)} | ${status} |`,
      );
    }
  }

  if (decision.excluded.length > 0) {
    sections.push('', '## Excluded before scoring', '');
    for (const exclusion of decision.excluded) {
      sections.push(`- \`${exclusion.modelId}\` — ${redact(exclusion.detail)}`);
    }
  }

  if (decision.exploration.explored) {
    sections.push(
      '',
      '## Experiment',
      '',
      redact(decision.exploration.reason),
      '',
      'Every safety limit still applied. Disable with `routepilot.exploration.enabled`.',
    );
  }

  sections.push(
    '',
    '---',
    '',
    '_Costs are estimates from configured priors and recorded outcomes. ' +
      'They are not measurements, and nothing has been executed._',
  );

  return sections.join('\n');
}

/** Build the history view from recorded outcomes. */
export function historyRows(outcomes: readonly OutcomeRecord[]): HistoryRow[] {
  return outcomes.map((outcome) => ({
    requestId: outcome.requestId,
    // The record does not carry a task type, and inventing one would be worse
    // than admitting it. The request id is the honest key.
    taskType: 'recorded task',
    modelsUsed: outcome.modelsUsed,
    cost: outcome.totalCost,
    currency: outcome.currency,
    successScore: outcome.successScore,
    escalations: outcome.escalationCount,
    outcome: describeOutcome(outcome),
    recordedAt: outcome.recordedAt,
  }));
}

/**
 * A one-phrase verdict for a recorded outcome.
 *
 * `null` scores read as "not evaluated", never as failure — a task nobody
 * checked has an unknown result, and calling it a failure in a history panel
 * would misrepresent the model (spec section 31).
 */
function describeOutcome(outcome: OutcomeRecord): string {
  if (outcome.userCancelled) return 'cancelled';
  if (outcome.successScore === null) return 'not evaluated';
  if (outcome.successScore >= 0.9) return 'succeeded';
  if (outcome.successScore >= 0.5) return 'partial';
  return 'failed';
}

/** A view with no decision behind it. */
function simpleView(phase: ExtensionPhase, statusBarModel: StatusBarModel): RoutingView {
  return {
    phase,
    statusBar: statusBarModel,
    model: null,
    cost: null,
    escalation: null,
    explanation: `# RoutePilot\n\n${statusBarModel.tooltip}`,
    summary: statusBarModel.tooltip.split('\n')[0] ?? '',
  };
}

/** The bare model name, so a status bar entry is not mostly provider prefix. */
export function shortName(modelId: string): string {
  const slash = modelId.lastIndexOf('/');
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

function money(value: number, currency: string): string {
  return `${value.toFixed(4)} ${currency}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
