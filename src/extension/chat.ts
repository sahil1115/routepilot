/**
 * The `@routepilot` chat participant's replies (spec section 49).
 *
 * Pure: builds the Markdown a participant would stream back. The shell binds it
 * to the editor's chat API and adds nothing.
 *
 * ## What this participant is, and what it deliberately is not
 *
 * It **explains routing**. Ask it about a task and it says which model it would
 * choose, what that is estimated to cost, and why.
 *
 * It does **not** answer coding questions, and it must not look as though it
 * might. RoutePilot's job is to choose which agent should do the work; a chat
 * participant that started doing the work itself would be a different product,
 * and one that appeared to try and then failed would be worse than one that
 * never offered. So an unrecognised request gets a short, honest capability
 * list rather than a best effort.
 *
 * Nothing here executes a model. The reply describes a routing decision, in the
 * same sense that `routepilot route` does.
 */

import type { RoutingDecision } from '../core/types/routing.js';
import { redact } from '../telemetry/redaction.js';
import { COMMANDS, explanationMarkdown, shortName } from './presenter.js';

/** What the user asked the participant to do. */
export const CHAT_INTENTS = ['route', 'explain', 'help'] as const;

/** What the user asked the participant to do. */
export type ChatIntent = (typeof CHAT_INTENTS)[number];

/** One reply from the participant. */
export interface ChatReply {
  readonly intent: ChatIntent;
  /** Markdown to stream back. Redacted. */
  readonly markdown: string;
  /** Follow-up buttons the shell may offer, in order. */
  readonly followUps: readonly { readonly label: string; readonly command: string }[];
}

/**
 * Classify a chat prompt.
 *
 * Deliberately conservative: only an explicit ask for an explanation counts as
 * `explain`, and anything that does not look like a task description falls back
 * to `help` rather than being routed. Guessing wrong here means charging a user
 * for an analysis they did not ask for.
 */
export function classifyChatPrompt(prompt: string): ChatIntent {
  const trimmed = prompt.trim();
  if (trimmed === '') return 'help';

  if (/^\/?(help|what can you do|commands?)\b/i.test(trimmed)) return 'help';
  if (/^\/?(explain|why|which model)\b/i.test(trimmed)) return 'explain';

  // A bare word or two is more likely a greeting than a task worth analysing.
  return trimmed.split(/\s+/).length >= 3 ? 'route' : 'help';
}

/** The reply for a routing request. */
export function routeReply(task: string, decision: RoutingDecision): ChatReply {
  const selected =
    decision.selectedModelId === null
      ? undefined
      : decision.evaluations.find((entry) => entry.modelId === decision.selectedModelId);

  if (selected === undefined) {
    return {
      intent: 'route',
      markdown: [
        `**No model selected** for _${redact(task)}_.`,
        '',
        redact(decision.reason),
        '',
        'Nothing was executed.',
      ].join('\n'),
      followUps: [{ label: 'Open settings', command: COMMANDS.settings }],
    };
  }

  const markdown = [
    `**${shortName(selected.modelId)}** would handle _${redact(task)}_.`,
    '',
    `- Model: \`${selected.modelId}\` (${selected.tier})`,
    `- Estimated success: ${(selected.successProbability * 100).toFixed(0)}%` +
      (selected.learningApplied
        ? ` — learned from ${String(selected.observations)} recorded runs`
        : ' — configured prior, not a measurement'),
    `- Expected total cost: ${selected.cost.expectedTotalToSuccess.toFixed(4)} ${selected.cost.currency}`,
    `- First attempt: ${selected.cost.initial.toFixed(4)} ${selected.cost.currency}`,
    ...(selected.escalationTargetId === null
      ? []
      : [
          `- If it fails (${(selected.cost.failureProbability * 100).toFixed(0)}%), escalates to \`${selected.escalationTargetId}\``,
        ]),
    ...(decision.exploration.explored
      ? [
          '',
          `> **Experiment.** Chose this over \`${String(decision.exploration.exploitModelId)}\` to learn whether it is better than currently believed.`,
        ]
      : []),
    '',
    '_Nothing has been executed. RoutePilot chooses a model; it does not run one._',
  ].join('\n');

  return {
    intent: 'route',
    markdown: redact(markdown),
    followUps: [
      { label: 'Full explanation', command: COMMANDS.explain },
      { label: 'Recent history', command: COMMANDS.history },
    ],
  };
}

/** The reply for an explanation request. */
export function explainReply(decision: RoutingDecision): ChatReply {
  return {
    intent: 'explain',
    markdown: explanationMarkdown(decision),
    followUps: [{ label: 'Recent history', command: COMMANDS.history }],
  };
}

/** The reply when there is nothing to explain yet. */
export function nothingToExplainReply(): ChatReply {
  return {
    intent: 'explain',
    markdown: [
      'No routing decision has been made in this session yet.',
      '',
      'Describe a task and I will say which model would handle it.',
    ].join('\n'),
    followUps: [{ label: 'Route a task', command: COMMANDS.route }],
  };
}

/**
 * The capability reply.
 *
 * States the boundary plainly. A participant that leaves people guessing
 * whether it will write their code will be asked to, and then disappoint.
 */
export function helpReply(): ChatReply {
  return {
    intent: 'help',
    markdown: [
      '**RoutePilot** chooses which coding model should handle a task, and explains why.',
      '',
      'Ask me things like:',
      '',
      '- `add pagination to the users endpoint` — which model would handle it, and what it would cost',
      '- `explain` — the full reasoning behind the last decision',
      '',
      'I do **not** write code or run tasks. I pick the model and show my working;',
      'the coding agent you already use does the rest.',
    ].join('\n'),
    followUps: [
      { label: 'Route a task', command: COMMANDS.route },
      { label: 'Open settings', command: COMMANDS.settings },
    ],
  };
}
