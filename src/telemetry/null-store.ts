/**
 * The telemetry store used when telemetry is disabled.
 *
 * RoutePilot must work with telemetry off (spec section 2, rule 17), so
 * "disabled" is a store that accepts everything and keeps nothing — not a null
 * reference every caller has to check. Callers write records unconditionally;
 * whether they land is a configuration decision made in one place.
 */

import type { PredictionRecord, PredictionStore } from '../core/types/calibration.js';
import type { LearnedStats, LearningStore } from '../core/types/learning.js';
import type { ShadowRecord, ShadowStore } from '../core/types/shadow.js';
import type {
  CandidateRecord,
  EscalationRecord,
  EventRecord,
  ExecutionAttemptRecord,
  OutcomeRecord,
  RequestRecord,
  RoutingRecord,
  TelemetryStatistics,
  TelemetryStore,
  UserSignalRecord,
} from '../core/types/telemetry.js';

/** Accepts every record and stores none. */
export class NullTelemetryStore
  implements TelemetryStore, LearningStore, PredictionStore, ShadowStore
{
  readonly enabled = false;

  // Parameters are declared, though unused, so callers type-check against the
  // same signatures whichever store they hold.
  recordRequest(_record: RequestRecord): void {}
  recordRouting(_record: RoutingRecord, _candidates: readonly CandidateRecord[]): void {}
  recordAttempt(_record: ExecutionAttemptRecord): void {}
  recordEvents(_records: readonly EventRecord[]): void {}
  recordEscalation(_record: EscalationRecord): void {}
  recordOutcome(_record: OutcomeRecord): void {}
  recordUserSignal(_record: UserSignalRecord): void {}

  statistics(): TelemetryStatistics {
    return {
      requests: 0,
      attempts: 0,
      outcomes: 0,
      escalations: 0,
      modelAttributableOutcomes: 0,
      totalCost: 0,
    };
  }

  recentOutcomes(_limit: number): readonly OutcomeRecord[] {
    return [];
  }

  /** Always empty: with nothing recorded there is nothing to learn from. */
  loadLearnedStats(): readonly LearnedStats[] {
    return [];
  }

  saveLearnedStats(_stats: readonly LearnedStats[]): void {}

  recordPredictions(_records: readonly PredictionRecord[]): void {}

  /**
   * Always empty.
   *
   * The safeguard reads this as "unassessed", never as "well calibrated" —
   * which is the correct reading, since with nothing recorded there is no
   * evidence either way.
   */
  loadPredictions(): readonly PredictionRecord[] {
    return [];
  }

  recordShadowDecisions(_records: readonly ShadowRecord[]): void {}

  /** Always empty: with nothing recorded there is no agreement to report. */
  loadShadowDecisions(): readonly ShadowRecord[] {
    return [];
  }

  close(): void {}
}
