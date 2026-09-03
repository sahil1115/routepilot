/**
 * `routepilot calibration` (spec section 41).
 *
 * Shows whether RoutePilot's success probabilities can be believed, and — when
 * they cannot — exactly which threshold they failed and by how much.
 *
 * The reliability table is the point of the command. A single ECE figure says
 * a predictor is off by 0.12; the table says it is fine below 70% and badly
 * over-confident above 90%, which is the band routing acts on hardest. One of
 * those is actionable.
 */

import type {
  CalibrationReport,
  CalibrationVerdict,
  PredictionRecord,
  PredictionSource,
} from '../core/types/calibration.js';
import { assessCalibration } from '../core/calibration/gate.js';
import { calibrationReport, toScored } from '../core/calibration/metrics.js';
import { toCalibrationThresholds } from '../config/policy.js';
import type { RoutePilotConfig } from '../config/types.js';
import { block, count, percent, renderTable } from './format.js';

/** Calibration for one source of predictions. */
export interface SourceCalibration {
  readonly source: PredictionSource;
  readonly verdict: CalibrationVerdict;
  readonly report: CalibrationReport | null;
  readonly sampleCount: number;
}

/** What `calibration` produced. */
export interface CalibrationResult {
  readonly sources: readonly SourceCalibration[];
  readonly total: number;
}

/**
 * Assess every source of predictions.
 *
 * Learned estimates and priors are scored **separately and always both**, so a
 * user can see whether learning is actually an improvement on the configuration
 * it replaced — the comparison that matters, and one a pooled figure hides.
 */
export function assessAll(
  predictions: readonly PredictionRecord[],
  config: RoutePilotConfig,
): CalibrationResult {
  const thresholds = toCalibrationThresholds(config);

  const sources = (['learned', 'prior'] as const).map((source) => {
    const forSource = predictions.filter((record) => record.source === source);
    const scored = toScored(forSource);
    const verdict = assessCalibration(scored, thresholds);

    return {
      source,
      verdict,
      // Reported even when the verdict is `unassessed`, so a user can look at
      // the numbers that are not yet trusted rather than being told only that
      // they are not trusted.
      report: scored.length === 0 ? null : calibrationReport(scored),
      sampleCount: forSource.length,
    } satisfies SourceCalibration;
  });

  return { sources, total: predictions.length };
}

/** Render a calibration assessment for a terminal. */
export function renderCalibration(result: CalibrationResult): string {
  if (result.total === 0) {
    return [
      'No predictions have been scored yet.',
      '',
      'Calibration is measured by pairing a predicted success probability with',
      'what actually happened. That needs executed tasks, and RoutePilot has no',
      'run command yet (see docs/ROADMAP.md), so nothing has been recorded.',
      '',
      'Until then routing uses configured priors, and the safeguard reports',
      'every predictor as unassessed — which is not the same as trusting it.',
    ].join('\n');
  }

  const sections: string[] = [];

  for (const source of result.sources) {
    sections.push(renderSource(source));
  }

  return sections.join('\n\n');
}

function renderSource(source: SourceCalibration): string {
  const title = source.source === 'learned' ? 'Learned estimates' : 'Configured priors';

  if (source.sampleCount === 0) {
    return `${title}\n  No predictions recorded from this source.`;
  }

  const lines = [`${title} — ${verdictLabel(source.verdict)}`, `  ${source.verdict.reason}`];

  for (const failure of source.verdict.failures.slice(1)) {
    lines.push(`  also ${failure}`);
  }

  const parts = [lines.join('\n')];

  if (source.report !== null) {
    parts.push(renderMetrics(source.report));
    parts.push(renderReliability(source.report));
  }

  return parts.join('\n\n');
}

/** The verdict as a short label, with its consequence spelled out. */
function verdictLabel(verdict: CalibrationVerdict): string {
  switch (verdict.status) {
    case 'trusted':
      return 'TRUSTED (in use)';
    case 'distrusted':
      return 'DISTRUSTED (withdrawn, priors restored)';
    case 'unassessed':
    default:
      return verdict.mayApply ? 'NOT YET ASSESSED (permitted)' : 'NOT YET ASSESSED (blocked)';
  }
}

function renderMetrics(report: CalibrationReport): string {
  return block([
    ['predictions', count(report.count)],
    ['base rate', percent(report.baseRate)],
    ['Brier score', `${report.brierScore.toFixed(4)} (lower is better, 0 is perfect)`],
    [
      'skill vs base rate',
      report.brierSkillScore === null
        ? 'not computable — every outcome was identical'
        : `${report.brierSkillScore.toFixed(4)} (higher is better, 0 is no better than a constant)`,
    ],
    ['calibration error', `${report.expectedCalibrationError.toFixed(4)} mean`],
    ['worst bin error', report.maximumCalibrationError.toFixed(4)],
    [
      'bias',
      `${report.bias >= 0 ? '+' : ''}${report.bias.toFixed(4)} ` + `(${describeBias(report.bias)})`,
    ],
    ['resolution', `${report.resolution.toFixed(4)} (discrimination; higher is better)`],
    ['reliability', `${report.reliability.toFixed(4)} (miscalibration; lower is better)`],
  ]);
}

/**
 * Say what the sign of the bias means in operational terms.
 *
 * A signed number alone leaves the reader to work out which direction costs
 * money, and the two directions cost money in completely different ways.
 */
function describeBias(bias: number): string {
  if (Math.abs(bias) < 0.01) return 'no systematic direction';
  return bias > 0
    ? 'over-confident: spends on attempts that fail'
    : 'under-confident: escalates when it need not';
}

/** The reliability diagram, as a table. Empty bins are omitted, not shown as zeros. */
function renderReliability(report: CalibrationReport): string {
  const rows = report.bins
    .filter((bin) => bin.count > 0)
    .map((bin) => [
      `${bin.lowerBound.toFixed(1)}-${bin.upperBound.toFixed(1)}`,
      count(bin.count),
      bin.meanPrediction === null ? '-' : percent(bin.meanPrediction),
      bin.meanOutcome === null ? '-' : percent(bin.meanOutcome),
      bin.gap === null ? '-' : `${bin.gap >= 0 ? '+' : ''}${(bin.gap * 100).toFixed(1)}pp`,
    ]);

  if (rows.length === 0) return '  No populated confidence bands.';

  return `  Reliability by confidence band\n${renderTable(
    ['BAND', 'N', 'PREDICTED', 'ACTUAL', 'GAP'],
    rows,
  )}`;
}
