/**
 * The editor-facing layer (spec section 49).
 *
 * Everything exported here is **pure**: no `vscode` import, no I/O, no clock.
 * The VS Code shell in `extension/` binds these values to widgets and does
 * nothing else, which keeps the part that cannot be tested from a test runner
 * small enough to describe honestly (spec section 2, rule 20).
 */

export {
  COMMANDS,
  ESCALATION_LIKELY_ABOVE,
  explanationMarkdown,
  historyRows,
  present,
  shortName,
  type ExtensionState,
} from './presenter.js';

export {
  resolveSettings,
  type ConfiguredLimits,
  type EditorOverrides,
  type EditorSettings,
} from './settings.js';

export {
  CHAT_INTENTS,
  classifyChatPrompt,
  explainReply,
  helpReply,
  nothingToExplainReply,
  routeReply,
  type ChatIntent,
  type ChatReply,
} from './chat.js';

export type {
  CostIndicator,
  EscalationIndicator,
  ExtensionPhase,
  HistoryRow,
  IndicatorSeverity,
  ModelIndicator,
  RoutingView,
  StatusBarModel,
} from './types.js';
