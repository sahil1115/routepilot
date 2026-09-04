/**
 * Editor-facing view models (spec section 49).
 *
 * The thinking part of the VS Code extension. Everything here is pure: no
 * `vscode` import, no I/O, no clock. The shell binds these shapes to widgets
 * and does nothing else.
 *
 * That split is not tidiness. An extension host cannot be driven from a test
 * runner here, so logic living inside it would ship unverified; keeping the
 * shell to wiring makes the untested surface small enough to describe honestly
 * (rule 20).
 *
 * Two rules hold throughout. Nothing user-facing may carry a secret -- every
 * string that can reach a tooltip, panel or output channel is redacted at
 * construction rather than at display, so a new call site cannot forget
 * (sections 34 and 51). And nothing here blocks: these are values computed from
 * a result that has already arrived.
 */

import type { ModelTier } from '../core/types/model.js';

/** Severity of what the status bar is showing. */
export const INDICATOR_SEVERITIES = ['neutral', 'active', 'warning', 'error'] as const;

/** Severity of what the status bar is showing. */
export type IndicatorSeverity = (typeof INDICATOR_SEVERITIES)[number];

/** What the extension is currently doing. */
export const EXTENSION_PHASES = ['idle', 'analysing', 'routed', 'cancelled', 'failed'] as const;

/** What the extension is currently doing. */
export type ExtensionPhase = (typeof EXTENSION_PHASES)[number];

/** The status bar item's contents. */
export interface StatusBarModel {
  /**
   * Text including any VS Code codicon, for example `$(rocket) sonnet-5`.
   *
   * Kept short: a status bar entry competes for a few dozen pixels, so the
   * detail belongs in the tooltip.
   */
  readonly text: string;
  /** Markdown tooltip. Redacted. */
  readonly tooltip: string;
  /** Command id to run when clicked, or `null` when the item is inert. */
  readonly command: string | null;
  readonly severity: IndicatorSeverity;
  /** True while work is in flight, so the shell can spin the icon. */
  readonly busy: boolean;
}

/** The model indicator: which model was chosen, and how confident that is. */
export interface ModelIndicator {
  readonly modelId: string;
  /** The bare model name, without its provider prefix. */
  readonly shortName: string;
  readonly tier: ModelTier;
  readonly successProbability: number;
  /** Real observations behind the estimate. Zero is a normal, honest answer. */
  readonly observations: number;
  /** True when learned data moved the estimate. */
  readonly learned: boolean;
}

/** The cost indicator. Every figure is an estimate, and says so. */
export interface CostIndicator {
  readonly initial: number;
  readonly expectedTotal: number;
  readonly currency: string;
  /** Fraction of the request budget the expected total consumes, or `null` when unlimited. */
  readonly budgetFraction: number | null;
  /** True when the selection is known to exceed the budget. */
  readonly overBudget: boolean;
}

/** The escalation indicator: what happens if the first attempt fails. */
export interface EscalationIndicator {
  /** The model this one would escalate to, or `null` when it is the strongest. */
  readonly targetModelId: string | null;
  /** Estimated cost of that escalation. */
  readonly estimatedCost: number | null;
  /** Estimated probability the first attempt fails, in [0, 1]. */
  readonly failureProbability: number;
  /**
   * Whether escalation is likely enough to be worth flagging.
   *
   * A one-in-three chance of needing a second, dearer attempt changes how a
   * user feels about starting, so it is surfaced rather than buried.
   */
  readonly likely: boolean;
}

/** One row of the history view. */
export interface HistoryRow {
  readonly requestId: string;
  readonly taskType: string;
  readonly modelsUsed: readonly string[];
  readonly cost: number;
  readonly currency: string;
  /** Multi-dimensional success score, or `null` when nothing was evaluated. */
  readonly successScore: number | null;
  readonly escalations: number;
  /** Human-readable outcome label. */
  readonly outcome: string;
  readonly recordedAt: number;
}

/** Everything the editor shows about one routing decision. */
export interface RoutingView {
  readonly phase: ExtensionPhase;
  readonly statusBar: StatusBarModel;
  /** `null` when nothing was selected. */
  readonly model: ModelIndicator | null;
  readonly cost: CostIndicator | null;
  readonly escalation: EscalationIndicator | null;
  /** Markdown explanation, ready to render in a panel. Redacted. */
  readonly explanation: string;
  /** Short one-line summary, suitable for a notification. Redacted. */
  readonly summary: string;
}
