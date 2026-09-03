/**
 * Decision explanation (spec section 50).
 *
 * Users must be able to trust the router, and trust requires being able to
 * check its reasoning. Every explanation therefore states the numbers the
 * decision actually turned on — including the ones for the models that were
 * *not* chosen, and the reason each excluded model was removed.
 *
 * Two honesty rules apply here:
 *
 * - Probabilities are labelled as estimates from priors, because that is what
 *   they are until Phase 12 supplies observations (spec section 39).
 * - When a model's estimate came from a tier default rather than a declared
 *   prior, the explanation says so, so a precise-looking number is not read as
 *   a well-grounded one.
 */

import type { ModelEvaluation, RoutingDecision } from '../types/routing.js';

/** Maximum candidates listed before the rest are summarised. */
const MAX_LISTED_CANDIDATES = 6;

/** Maximum exclusions listed before the rest are summarised. */
const MAX_LISTED_EXCLUSIONS = 8;

/** Render a decision as a list of explanation lines. */
export function explainDecision(
  decision: Omit<RoutingDecision, 'explanation' | 'exploration'>,
): string[] {
  const lines: string[] = [decision.reason];

  if (decision.overrodeExplicitRequest) {
    lines.push(
      'The explicitly requested model could not run this task, and model override is enabled, ' +
        'so a substitute was chosen.',
    );
  }

  if (decision.budgetExceeded) {
    lines.push(
      `This selection exceeds the request budget of ` +
        `${formatMoney(decision.policy.requestBudget, decision.policy.currency)}. ` +
        'It was permitted because the configured behaviour is "allow-fallback".',
    );
  }

  if (decision.evaluations.length > 0) {
    lines.push('');
    lines.push('Candidates considered (estimates from configured priors, not measurements):');
    for (const candidate of decision.evaluations.slice(0, MAX_LISTED_CANDIDATES)) {
      lines.push(describeCandidate(candidate, decision));
    }
    const remaining = decision.evaluations.length - MAX_LISTED_CANDIDATES;
    if (remaining > 0) {
      lines.push(`  … and ${String(remaining)} more eligible candidate(s).`);
    }
  }

  if (decision.excluded.length > 0) {
    lines.push('');
    lines.push('Excluded before scoring:');
    for (const exclusion of decision.excluded.slice(0, MAX_LISTED_EXCLUSIONS)) {
      lines.push(`  ${exclusion.modelId} [${exclusion.reason}] — ${exclusion.detail}`);
    }
    const remaining = decision.excluded.length - MAX_LISTED_EXCLUSIONS;
    if (remaining > 0) {
      lines.push(`  … and ${String(remaining)} more excluded model(s).`);
    }
  }

  lines.push('');
  lines.push(
    `Policy: minimum success ${percent(decision.policy.minimumSuccessProbability)}, ` +
      `maximum risk ${percent(decision.policy.maxRisk)}, ` +
      `budget ${formatMoney(decision.policy.requestBudget, decision.policy.currency)}, ` +
      `static prior for this task: ${decision.staticTierPrior} tier.`,
  );

  return lines;
}

function describeCandidate(
  candidate: ModelEvaluation,
  decision: Omit<RoutingDecision, 'explanation' | 'exploration'>,
): string {
  const marker = candidate.modelId === decision.selectedModelId ? '->' : '  ';
  const failures = describeFailedConstraints(candidate);

  const parts = [
    `${percent(candidate.successProbability)} success`,
    `${formatMoney(candidate.cost.expectedTotalToSuccess, candidate.cost.currency)} expected total`,
    `${formatMoney(candidate.cost.initial, candidate.cost.currency)} first attempt`,
    `risk ${percent(candidate.risk)}`,
  ];

  if (candidate.escalationTargetId !== null) {
    parts.push(`escalates to ${candidate.escalationTargetId}`);
  }
  if (candidate.usedTierDefault) {
    parts.push('success estimated from a tier default, not a declared prior');
  }

  const suffix = failures.length > 0 ? ` — rejected: ${failures.join(', ')}` : '';
  return `${marker} ${candidate.modelId} (${candidate.tier}): ${parts.join(', ')}${suffix}`;
}

function describeFailedConstraints(candidate: ModelEvaluation): string[] {
  const failures: string[] = [];
  if (!candidate.meetsThreshold) failures.push('below the confidence threshold');
  if (!candidate.withinRisk) failures.push('above the risk limit');
  if (!candidate.withinLatency) failures.push('above the latency limit');
  if (!candidate.withinBudget) failures.push('above the request budget');
  return failures;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatMoney(value: number | undefined, currency: string): string {
  if (value === undefined) return 'unlimited';
  return `${value.toFixed(4)} ${currency}`;
}
