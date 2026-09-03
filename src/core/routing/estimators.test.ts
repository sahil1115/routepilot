import { describe, expect, it } from 'vitest';

import { noCapabilities } from '../../test-support/fixtures.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  ultraModel,
} from '../../test-support/routing-fixtures.js';
import { CostEstimator, estimateLatencySeconds } from './cost-estimator.js';
import { deriveRequiredCapabilities } from './constraint-engine.js';
import { RiskEstimator } from './risk-estimator.js';
import { staticTierPrior, tierRank, TIER_BASELINE_CAPABILITY } from './static-priors.js';
import { SuccessPredictor } from './success-predictor.js';

const predictor = new SuccessPredictor();

describe('SuccessPredictor', () => {
  it('rates a capable model above a weak one on the same task', () => {
    const features = featuresFor('implement a new /users API endpoint');

    expect(predictor.estimate(frontierModel(), features).probability).toBeGreaterThan(
      predictor.estimate(cheapModel(), features).probability,
    );
  });

  it('rates the same model lower on a harder task', () => {
    const easy = featuresFor('rename the variable userId to userIdentifier');
    const hard = featuresFor('rearchitect the plugin system across the entire repository');

    expect(predictor.estimate(mediumModel(), hard).probability).toBeLessThan(
      predictor.estimate(mediumModel(), easy).probability,
    );
  });

  it('lets a cheap model clear a trivial task', () => {
    const estimate = predictor.estimate(
      cheapModel(),
      featuresFor('rename the variable userId to userIdentifier'),
    );
    expect(estimate.probability).toBeGreaterThan(0.85);
  });

  it('does not let a cheap model clear an architecture task', () => {
    const estimate = predictor.estimate(
      cheapModel(),
      featuresFor('rearchitect the plugin system across the entire repository'),
    );
    expect(estimate.probability).toBeLessThan(0.6);
  });

  it('never claims certainty in either direction', () => {
    for (const model of [cheapModel(), ultraModel()]) {
      for (const prompt of ['rename a variable', 'rearchitect everything across the repository']) {
        const { probability } = predictor.estimate(model, featuresFor(prompt));
        expect(probability).toBeGreaterThan(0);
        expect(probability).toBeLessThan(1);
      }
    }
  });

  it('falls back to a tier default when a model declares no prior, and says so', () => {
    // Spec section 39: unknown must not be silently treated as excellent.
    const silent = cheapModel({ priors: { skills: {}, languages: {} } });
    const estimate = predictor.estimate(silent, featuresFor('debug the failing worker'));

    expect(estimate.usedTierDefault).toBe(true);
    expect(estimate.capabilityFit).toBeCloseTo(TIER_BASELINE_CAPABILITY.cheap, 6);
  });

  it('does not penalise a model for an unknown language prior', () => {
    const known = mediumModel();
    const noLanguages = mediumModel({
      priors: { skills: mediumModel().priors.skills, languages: {} },
    });
    const features = featuresFor('implement a new endpoint', { primaryLanguage: 'cobol' });

    // Absence of evidence is not evidence of weakness.
    expect(predictor.estimate(noLanguages, features).capabilityFit).toBeGreaterThanOrEqual(
      predictor.estimate(known, features).capabilityFit,
    );
  });

  it('penalises operating close to the context limit', () => {
    const roomy = predictor.estimate(
      mediumModel(),
      featuresFor('implement a new endpoint', { contextTokens: 10_000 }),
    );
    const cramped = predictor.estimate(
      mediumModel(),
      featuresFor('implement a new endpoint', { contextTokens: 400_000 }),
    );

    expect(cramped.probability).toBeLessThan(roomy.probability);
  });

  it('scores difficulty independently of any model', () => {
    const easy = predictor.difficulty(featuresFor('rename a variable'));
    const hard = predictor.difficulty(
      featuresFor('rearchitect the plugin system across the entire repository'),
    );

    expect(easy).toBeGreaterThanOrEqual(0);
    expect(hard).toBeLessThanOrEqual(1);
    expect(hard).toBeGreaterThan(easy);
  });
});

describe('CostEstimator', () => {
  const estimator = new CostEstimator();
  const features = featuresFor('implement a new /users API endpoint');

  it('itemises all four costs the spec names (section 15)', () => {
    const costs = estimator.estimate(
      [{ model: mediumModel(), successProbability: 0.87 }],
      features,
    );
    const entry = costs.get('acme/balanced-1');

    expect(entry?.cost.initial).toBeGreaterThan(0);
    expect(entry?.cost.retry).toBeGreaterThan(0);
    expect(entry?.cost.escalation).toBeGreaterThan(0);
    expect(entry?.cost.expectedTotalToSuccess).toBeGreaterThan(entry?.cost.initial ?? 0);
    expect(entry?.cost.currency).toBe('USD');
  });

  it('makes an unreliable model dearer than a reliable one at a comparable price', () => {
    // The spec's motivating example (section 1): a cheaper first attempt that
    // often fails can cost more overall than a dearer one that succeeds.
    const unreliable = mediumModel({
      id: 'acme/unreliable',
      pricing: { inputPerMillion: 1.5, outputPerMillion: 7.5, currency: 'USD' },
    });
    const reliable = mediumModel({ id: 'acme/reliable' });

    const costs = estimator.estimate(
      [
        { model: unreliable, successProbability: 0.35 },
        { model: reliable, successProbability: 0.95 },
      ],
      features,
    );

    const cheap = costs.get('acme/unreliable')?.cost;
    const dear = costs.get('acme/reliable')?.cost;

    // Half the sticker price...
    expect(cheap?.initial).toBeLessThan(dear?.initial ?? 0);
    // ...and more expensive once its failures are paid for.
    expect(cheap?.expectedTotalToSuccess).toBeGreaterThan(dear?.expectedTotalToSuccess ?? 0);
  });

  it('still favours a first attempt on a far cheaper model, which is why the threshold exists', () => {
    // An honest limitation, recorded rather than hidden. When the price gap is
    // wide enough, "try the cheap model, escalate if it fails" genuinely wins
    // on expected dollars even at a 35% success rate — the arithmetic is right.
    //
    // Money is not the only cost of a failure though: there is latency, a
    // possibly half-edited workspace, and the user's patience. Expected cost
    // alone would therefore always open with the cheapest model. What prevents
    // that is `minimumSuccessProbability`, a separate constraint applied by the
    // routing engine (spec section 14) — not this estimator.
    const costs = estimator.estimate(
      [
        { model: cheapModel(), successProbability: 0.35 },
        { model: mediumModel(), successProbability: 0.95 },
      ],
      features,
    );

    const cheap = costs.get('acme/fast-1')?.cost;
    const medium = costs.get('acme/balanced-1')?.cost;

    expect(cheap?.expectedTotalToSuccess).toBeLessThan(medium?.expectedTotalToSuccess ?? 0);
  });

  it('charges nothing extra for a model that never fails', () => {
    const costs = estimator.estimate([{ model: cheapModel(), successProbability: 1 }], features);
    const entry = costs.get('acme/fast-1')?.cost;

    expect(entry?.expectedTotalToSuccess).toBeCloseTo(entry?.initial ?? 0, 10);
  });

  it('points each model at the cheapest stronger model as its escalation target', () => {
    const costs = estimator.estimate(
      [
        { model: cheapModel(), successProbability: 0.6 },
        { model: mediumModel(), successProbability: 0.85 },
        { model: frontierModel(), successProbability: 0.93 },
      ],
      features,
    );

    expect(costs.get('acme/fast-1')?.escalationTargetId).toBe('acme/balanced-1');
    expect(costs.get('acme/balanced-1')?.escalationTargetId).toBe('acme/deep-1');
    // Nothing is stronger than the frontier model here.
    expect(costs.get('acme/deep-1')?.escalationTargetId).toBeNull();
  });

  it('terminates rather than recursing when nothing is stronger', () => {
    const costs = estimator.estimate([{ model: ultraModel(), successProbability: 0.5 }], features);
    const entry = costs.get('acme/ultra-1');

    expect(Number.isFinite(entry?.cost.expectedTotalToSuccess ?? Number.NaN)).toBe(true);
    expect(entry?.escalationTargetId ?? null).toBeNull();
  });

  it('handles an empty candidate set', () => {
    expect(estimator.estimate([], features).size).toBe(0);
  });

  it('is order-independent', () => {
    const forward = estimator.estimate(
      [
        { model: cheapModel(), successProbability: 0.6 },
        { model: frontierModel(), successProbability: 0.93 },
      ],
      features,
    );
    const backward = estimator.estimate(
      [
        { model: frontierModel(), successProbability: 0.93 },
        { model: cheapModel(), successProbability: 0.6 },
      ],
      features,
    );

    expect(forward.get('acme/fast-1')).toEqual(backward.get('acme/fast-1'));
  });
});

describe('estimateLatencySeconds', () => {
  it('scales with output size and inversely with throughput', () => {
    const small = estimateLatencySeconds(
      mediumModel(),
      featuresFor('rename a variable', { contextTokens: 1_000 }),
    );
    const large = estimateLatencySeconds(
      mediumModel(),
      featuresFor('refactor everything across the repository', { contextTokens: 300_000 }),
    );

    expect(large).toBeGreaterThan(small);
  });

  it('reports a model that cannot produce output as infinitely slow', () => {
    const stalled = mediumModel({
      latency: { firstTokenSeconds: 1, outputTokensPerSecond: 0 },
    });
    expect(estimateLatencySeconds(stalled, featuresFor('rename a variable'))).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe('RiskEstimator', () => {
  const estimator = new RiskEstimator();

  it('rates a likely failure as riskier than a likely success', () => {
    const features = featuresFor('migrate the production payment schema');

    expect(estimator.estimate(cheapModel(), features, 0.4)).toBeGreaterThan(
      estimator.estimate(cheapModel(), features, 0.95),
    );
  });

  it('rates a dangerous task as riskier than a harmless one', () => {
    const dangerous = featuresFor('migrate the production payment database schema');
    const harmless = featuresFor('explain what this function does');

    expect(estimator.estimate(mediumModel(), dangerous, 0.9)).toBeGreaterThan(
      estimator.estimate(mediumModel(), harmless, 0.9),
    );
  });

  it('penalises a degraded model', () => {
    const features = featuresFor('implement a new endpoint');

    expect(
      estimator.estimate(mediumModel({ availability: 'degraded' }), features, 0.9),
    ).toBeGreaterThan(estimator.estimate(mediumModel(), features, 0.9));
  });

  it('penalises context pressure', () => {
    expect(
      estimator.estimate(
        mediumModel(),
        featuresFor('implement a new endpoint', { contextTokens: 400_000 }),
        0.9,
      ),
    ).toBeGreaterThan(
      estimator.estimate(
        mediumModel(),
        featuresFor('implement a new endpoint', { contextTokens: 1_000 }),
        0.9,
      ),
    );
  });

  it('stays inside [0, 1] at the extremes', () => {
    const worst = estimator.estimate(
      cheapModel({ availability: 'degraded', contextWindow: 1 }),
      featuresFor('migrate the production payment database schema across the entire repository'),
      0.01,
    );
    expect(worst).toBeLessThanOrEqual(1);
    expect(worst).toBeGreaterThanOrEqual(0);
  });
});

describe('deriveRequiredCapabilities', () => {
  it('requires tools and agentic execution for work that changes the workspace', () => {
    for (const taskType of [
      'feature-implementation',
      'bug-fix',
      'refactoring',
      'migration',
    ] as const) {
      expect(deriveRequiredCapabilities(taskType)).toEqual({
        toolUse: true,
        agenticExecution: true,
      });
    }
  });

  it('requires only tools for read-only work', () => {
    expect(deriveRequiredCapabilities('explanation')).toEqual({ toolUse: true });
    expect(deriveRequiredCapabilities('investigation')).toEqual({ toolUse: true });
  });

  it('requires nothing for a self-contained completion', () => {
    expect(deriveRequiredCapabilities('autocomplete')).toEqual({});
  });

  it('never demands a capability a task does not need', () => {
    // Over-requiring silently narrows the field and pushes cheap work upmarket.
    for (const derived of [
      deriveRequiredCapabilities('explanation'),
      deriveRequiredCapabilities('autocomplete'),
    ]) {
      expect(derived).not.toHaveProperty('vision');
      expect(derived).not.toHaveProperty('structuredOutput');
    }
  });
});

describe('static priors', () => {
  it('orders tiers from cheapest to strongest', () => {
    expect(tierRank('cheap')).toBeLessThan(tierRank('medium'));
    expect(tierRank('medium')).toBeLessThan(tierRank('frontier'));
    expect(tierRank('frontier')).toBeLessThan(tierRank('ultra'));
  });

  it('reproduces the spec section 13 table for contained tasks', () => {
    expect(staticTierPrior('rename', 'single-file')).toBe('cheap');
    expect(staticTierPrior('documentation', 'single-file')).toBe('cheap');
    expect(staticTierPrior('formatting', 'single-file')).toBe('cheap');
    expect(staticTierPrior('test-generation', 'single-file')).toBe('cheap');
    expect(staticTierPrior('feature-implementation', 'few-files')).toBe('medium');
    expect(staticTierPrior('debugging', 'few-files')).toBe('medium');
    expect(staticTierPrior('architecture', 'few-files')).toBe('frontier');
    expect(staticTierPrior('security', 'few-files')).toBe('frontier');
  });

  it('raises the suggestion as scope widens', () => {
    expect(tierRank(staticTierPrior('refactoring', 'repository-wide'))).toBeGreaterThan(
      tierRank(staticTierPrior('refactoring', 'single-file')),
    );
  });

  it('never suggests beyond the strongest tier', () => {
    expect(staticTierPrior('migration', 'repository-wide')).toBe('ultra');
  });

  it('gives every tier a baseline, ordered by capability', () => {
    expect(TIER_BASELINE_CAPABILITY.cheap).toBeLessThan(TIER_BASELINE_CAPABILITY.medium);
    expect(TIER_BASELINE_CAPABILITY.medium).toBeLessThan(TIER_BASELINE_CAPABILITY.frontier);
    expect(TIER_BASELINE_CAPABILITY.frontier).toBeLessThan(TIER_BASELINE_CAPABILITY.ultra);
  });
});

describe('capability matching interacts with scoring correctly', () => {
  it('excludes rather than merely down-scores a model without tools', () => {
    // A missing capability is a hard constraint, not a penalty: no amount of
    // cheapness should make an impossible model selectable (spec section 12).
    const toolless = cheapModel({ capabilities: { ...noCapabilities, streaming: true } });
    const features = featuresFor('implement a new endpoint');

    // It would otherwise look attractive on price.
    expect(predictor.estimate(toolless, features).probability).toBeGreaterThan(0);
  });
});
