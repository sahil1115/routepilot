/**
 * Configuration document shape (spec section 47).
 *
 * Optional fields are declared `?: T | undefined` because the validated
 * configuration is produced by a schema, and a schema-parsed optional is
 * genuinely "present and undefined or absent". Declaring it that way keeps
 * `exactOptionalPropertyTypes` honest instead of forcing casts at the boundary.
 */

import type { ModelSpec } from '../core/types/model.js';
import type { ProviderSpec } from '../core/types/provider.js';

/** What the router is allowed to do, and the thresholds it must respect. */
export interface RoutingConfig {
  /** A model is only selectable when its estimated success probability meets this. */
  readonly minimumSuccessProbability: number;
  /** Upper bound on estimated task risk, in [0, 1]. */
  readonly maxRisk: number;
  /** Upper bound on estimated wall-clock time for one attempt. */
  readonly maxLatencySeconds: number;
  /** Hard cap on escalations for a single task (spec section 27). */
  readonly maxEscalationsPerTask: number;
  /** Hard cap on retries against one model. */
  readonly maxRetriesPerModel: number;
  /**
   * Whether the router may override a model the user selected explicitly.
   *
   * Defaults to false. An explicit choice is a decision, not a hint
   * (spec section 2, rule 8).
   */
  readonly modelOverrideEnabled: boolean;
  /** Provider used when nothing else constrains the choice. */
  readonly defaultProviderId?: string | undefined;
  /** Provider used when the default is unavailable. */
  readonly fallbackProviderId?: string | undefined;
}

/** What RoutePilot does when a request cannot be served inside budget. */
export const BUDGET_EXCEEDED_BEHAVIOURS = ['ask', 'stop', 'allow-fallback'] as const;

/** What RoutePilot does when a request cannot be served inside budget. */
export type BudgetExceededBehaviour = (typeof BUDGET_EXCEEDED_BEHAVIOURS)[number];

/**
 * Spending limits (spec section 16).
 *
 * All amounts are in {@link BudgetConfig.currency}. An absent limit means
 * "not limited at this scope", never "zero".
 */
export interface BudgetConfig {
  /** ISO 4217 currency code. Every model's pricing must use this currency. */
  readonly currency: string;
  /** Limit for a single request. */
  readonly request?: number | undefined;
  /** Limit for one session. */
  readonly session?: number | undefined;
  /** Limit per calendar day. */
  readonly daily?: number | undefined;
  /** Limit per calendar month. */
  readonly monthly?: number | undefined;
  /** Behaviour when no eligible model fits the budget. Never "exceed silently". */
  readonly onExceeded: BudgetExceededBehaviour;
}

/** Learning configuration (spec sections 35, 36 and 40). */
export interface LearningConfig {
  /**
   * Whether learned routing may influence decisions.
   *
   * Defaults to false. The system must be fully usable with learning off, and
   * learned routing must not be trusted before enough data exists.
   */
  readonly enabled: boolean;
  /**
   * Safe exploration settings (spec section 40).
   *
   * Replaces the former `explorationEnabled` boolean, which was validated and
   * displayed for several phases while being read by nothing. An old
   * configuration carrying that key now fails validation, which is the honest
   * outcome: a user who set it was not getting exploration, and should find
   * that out rather than continue believing otherwise.
   */
  readonly exploration: ExplorationSettings;
  /**
   * Observations required before a learned estimate may be used at all.
   *
   * Below this, static priors are used and learned routing stays disabled.
   */
  readonly minimumTrainingSamples: number;
  /** Limits a learned predictor must satisfy to keep influencing routing. */
  readonly calibration: CalibrationConfig;
}

/**
 * The calibration safeguard (spec section 41).
 *
 * Learning being *on* and learning being *believable* are separate questions.
 * These settings answer the second: a predictor whose probabilities have been
 * measured and found wrong is withdrawn, however much data stands behind it.
 */
export interface CalibrationConfig {
  /** Predictions needed before calibration can be judged at all. */
  readonly minimumSamples: number;
  /** Largest tolerable expected calibration error, in [0, 1]. */
  readonly maxExpectedCalibrationError: number;
  /** Largest tolerable single-bin error, in [0, 1]. */
  readonly maxCalibrationError: number;
  /** Smallest acceptable improvement over always predicting the base rate. */
  readonly minimumBrierSkillScore: number;
  /**
   * Whether a predictor must be *proved* calibrated before it may be used.
   *
   * False by default. True is the conservative setting, and it means an
   * unassessed predictor is blocked as well as a bad one.
   */
  readonly requireCalibration: boolean;
}

/**
 * Shadow routing (spec sections 42 and 43).
 *
 * Evaluating alternative policies costs nothing to run — no shadow policy ever
 * executes a model — but it does write a row per policy per request, so it is
 * off until asked for.
 */
export interface ShadowConfig {
  /** Whether alternative policies are evaluated and recorded alongside routing. */
  readonly enabled: boolean;
  /**
   * Which built-in baselines to compare against.
   *
   * Unknown ids are rejected at validation rather than silently ignored: a
   * typo that quietly disables a comparison would leave a user believing they
   * were measuring something they were not.
   */
  readonly policies: readonly string[];
}

/**
 * When the contextual bandit may experiment (spec section 40).
 *
 * Exploration means deliberately not taking the model currently believed best,
 * to learn whether another is better. Every field here narrows when that is
 * allowed; none of them can authorise it on a task the safety gate refuses.
 */
export interface ExplorationSettings {
  /** Whether exploration may ever occur. Off by default. */
  readonly enabled: boolean;
  /** Observations required before any experiment is permitted. */
  readonly minimumObservations: number;
  /** Task risk above which exploration is refused, in [0, 1]. */
  readonly maxRisk: number;
  /**
   * How much more than the safe choice an experiment may cost, as a fraction.
   *
   * The price of information, capped. Zero disables exploration entirely.
   */
  readonly maxCostPremium: number;
  /** Standard deviations of benefit of the doubt given to an uncertain model. */
  readonly optimism: number;
}

/** How much detail telemetry may retain. */
export const PRIVACY_MODES = ['strict', 'debug'] as const;

/**
 * How much detail telemetry may retain.
 *
 * `strict` is the default and stores metadata, features and outcomes only.
 * `debug` retains more and must be an explicit, informed user choice.
 */
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

/** Local telemetry configuration (spec sections 33 and 34). */
export interface TelemetryConfig {
  /** Whether outcomes are recorded at all. The system works with this off. */
  readonly enabled: boolean;
  /** Retention detail level. */
  readonly privacyMode: PrivacyMode;
  /** Directory for the local store. Defaults to a per-user location. */
  readonly storagePath?: string | undefined;
}

/** A complete, validated RoutePilot configuration. */
export interface RoutePilotConfig {
  /** Schema version. Bumped only on a breaking configuration change. */
  readonly version: 1;
  /** Providers available to the router. */
  readonly providers: readonly ProviderSpec[];
  /** Models available to the router. */
  readonly models: readonly ModelSpec[];
  readonly routing: RoutingConfig;
  readonly budgets: BudgetConfig;
  readonly learning: LearningConfig;
  readonly shadow: ShadowConfig;
  readonly telemetry: TelemetryConfig;
}
