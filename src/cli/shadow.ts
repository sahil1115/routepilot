/**
 * `routepilot shadow` (spec sections 42 and 44).
 *
 * Reports how often alternative policies would have routed differently, and
 * which models they preferred when they did.
 *
 * ## The thing this report must never imply
 *
 * A negative cost figure is **not money that was left on the table**. Every
 * shadow decision names a model that was never executed, so there is no outcome
 * for it, and both sides of the comparison come from the same success
 * probabilities — a miscalibrated predictor moves them together and the
 * difference carries the error rather than exposing it.
 *
 * The report therefore never uses the word "saving", labels the figure as an
 * estimate wherever it appears, and states the limitation in full at the
 * bottom. Establishing that one policy is actually better needs outcomes for
 * both arms, which is offline policy evaluation (Phase 13).
 */

import type { ShadowAgreement, ShadowRecord } from '../core/types/shadow.js';
import { summariseAgreement } from '../core/shadow/agreement.js';
import { DEFAULT_SHADOW_POLICIES } from '../core/shadow/policies.js';
import { count, percent, renderTable } from './format.js';

/** What `shadow` produced. */
export interface ShadowReport {
  readonly policies: readonly ShadowAgreement[];
  readonly total: number;
}

/** Summarise a recorded shadow history. */
export function buildShadowReport(records: readonly ShadowRecord[]): ShadowReport {
  return { policies: summariseAgreement(records), total: records.length };
}

/** Render a shadow report for a terminal. */
export function renderShadowReport(report: ShadowReport, enabled: boolean): string {
  if (report.total === 0) {
    return renderEmpty(enabled);
  }

  const rows = report.policies.map((entry) => [
    entry.policyId,
    count(entry.count),
    entry.agreementRate === null ? '-' : percent(entry.agreementRate),
    count(entry.count - entry.agreements),
    formatDelta(entry),
  ]);

  const sections = [
    `Shadow policies over ${count(report.total)} recorded decisions`,
    renderTable(['POLICY', 'N', 'AGREED', 'DIVERGED', 'EST. COST DELTA'], rows),
  ];

  for (const entry of report.policies) {
    const divergences = describeDivergences(entry);
    if (divergences !== null) sections.push(divergences);
  }

  sections.push(CAVEAT);
  return sections.join('\n\n');
}

/** What each baseline is for, shown when there is nothing to report yet. */
function renderEmpty(enabled: boolean): string {
  const lines = enabled
    ? [
        'Shadow routing is enabled, but no decisions have been recorded yet.',
        'Run `routepilot route "<task>"` to accumulate a history.',
      ]
    : [
        'Shadow routing is disabled.',
        '',
        'Enable it with `"shadow": { "enabled": true }` in your configuration.',
        'It costs nothing to run — no shadow policy ever executes a model — and',
        'writes one row per policy per request.',
      ];

  return [
    ...lines,
    '',
    'The built-in baselines are:',
    ...DEFAULT_SHADOW_POLICIES.map((spec) => `  ${spec.id.padEnd(16)} ${spec.description}`),
  ].join('\n');
}

/**
 * The cost delta, with the number of decisions it covers.
 *
 * The count travels with the figure because a total summed over three decisions
 * and one summed over three hundred are indistinguishable otherwise.
 */
function formatDelta(entry: ShadowAgreement): string {
  if (entry.comparableCount === 0) return 'not comparable';
  const sign = entry.estimatedCostDelta >= 0 ? '+' : '';
  return `${sign}${entry.estimatedCostDelta.toFixed(4)} over ${count(entry.comparableCount)}`;
}

/** Which models a policy reached for when it disagreed. */
function describeDivergences(entry: ShadowAgreement): string | null {
  if (entry.divergentChoices.length === 0) return null;

  const choices = entry.divergentChoices
    .map((choice) => `${choice.modelId} (${count(choice.count)})`)
    .join(', ');

  return `  ${entry.policyId} preferred instead: ${choices}`;
}

const CAVEAT = [
  'These are estimates, not measurements.',
  '',
  'A shadow policy names a model that was never executed, so no outcome exists',
  'for it. Both sides of every difference come from the same success estimates,',
  'so a miscalibrated predictor shifts them together rather than being revealed.',
  'A negative figure above is not a saving that was missed — it is what the',
  'current estimates say the alternative would have cost.',
].join('\n');
