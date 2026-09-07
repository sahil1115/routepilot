/**
 * Routing over a user-configured fleet (Phase 25).
 *
 * The fleet is applied once, in `buildRegistries`, by restricting the model
 * registry. These tests hold the consequence that matters: every later stage —
 * the constraint filter, expected-cost ranking, and the bandit — draws from
 * that registry, so a model outside the fleet is unreachable rather than merely
 * unlikely.
 *
 * The registry is built through the real configuration path, not hand-assembled,
 * so a change that let a model past validation would fail here too.
 */

import { describe, expect, it } from 'vitest';

import { buildRegistries } from '../../config/registries.js';
import { parseConfig } from '../../config/schema.js';
import { makeConfigDocument, makeModelDocument } from '../../test-support/fixtures.js';
import {
  InMemoryLearningStore,
  syntheticObservations,
} from '../../test-support/learning-fixtures.js';
import { featuresFor, policy } from '../../test-support/routing-fixtures.js';
import type { ExplorationPolicy } from '../bandit/exploration-gate.js';
import { LearnedSuccessModel } from '../learning/success-model.js';
import type { ModelRegistry } from '../registry/model-registry.js';
import type { RoutingDecision } from '../types/routing.js';
import { MIGRATIONS } from '../../telemetry/schema.js';
import { RoutingEngine } from './routing-engine.js';

const TASK = 'implement a new /users API endpoint';

const OPEN: ExplorationPolicy = {
  enabled: true,
  minimumObservations: 5,
  maxRisk: 0.9,
  maxCostPremium: 0.5,
  optimism: 1.5,
};

/**
 * Four models. `acme/bargain` is deliberately the cheapest and the strongest,
 * so if anything could escape a fleet it would pick this one.
 */
function models(): Record<string, unknown>[] {
  const strong = {
    codeGeneration: 0.95,
    codeEditing: 0.95,
    debugging: 0.95,
    refactoring: 0.95,
    architecture: 0.95,
    reasoning: 0.95,
    testGeneration: 0.95,
    documentation: 0.95,
    multiFileReasoning: 0.95,
  };

  return [
    makeModelDocument({ id: 'acme/fast-1', modelId: 'fast-1', tier: 'cheap' }),
    makeModelDocument({ id: 'acme/mid-1', modelId: 'mid-1', tier: 'medium' }),
    makeModelDocument({ id: 'acme/slow-1', modelId: 'slow-1', tier: 'frontier' }),
    makeModelDocument({
      id: 'acme/bargain',
      modelId: 'bargain',
      tier: 'frontier',
      // Cheaper per token AND more likely to succeed than anything in the
      // fleet, so expected cost would always prefer it if it were reachable.
      pricing: { inputPerMillion: 0.01, outputPerMillion: 0.05 },
      priors: { skills: strong, languages: { typescript: 0.99 } },
    }),
  ];
}

function registryFor(fleet?: unknown): ModelRegistry {
  return buildRegistries(
    parseConfig(
      makeConfigDocument({ models: models(), ...(fleet === undefined ? {} : { fleet }) }),
    ),
  ).models;
}

function route(
  registry: ModelRegistry,
  learned = new LearnedSuccessModel(),
  exploration: ExplorationPolicy | undefined = undefined,
): RoutingDecision {
  const engine =
    exploration === undefined
      ? new RoutingEngine(registry, learned)
      : new RoutingEngine(registry, learned, exploration);

  return engine.route({
    features: featuresFor(TASK),
    policy: policy({ minimumSuccessProbability: 0.5 }),
    operationMode: 'normal',
  });
}

/** A learned model with enough observations to unlock the bandit. */
function trained(modelId: string, n = 20): LearnedSuccessModel {
  const store = new InMemoryLearningStore();
  const learningPolicy = { enabled: true, minimumTrainingSamples: 5 };
  new LearnedSuccessModel(store, learningPolicy).observeAll(
    syntheticObservations(modelId, n, {
      rate: 0.9,
      taskType: 'feature-implementation',
      scope: 'few-files',
    }),
    1_000,
  );
  return new LearnedSuccessModel(store, learningPolicy);
}

describe('a configured fleet is a hard boundary on routing', () => {
  it('never selects a model outside the fleet', () => {
    const decision = route(
      registryFor({
        models: [
          { id: 'acme/fast-1', tier: 'cheap' },
          { id: 'acme/mid-1', tier: 'medium' },
          { id: 'acme/slow-1', tier: 'expensive' },
        ],
      }),
    );

    expect(decision.selectedModelId).not.toBe('acme/bargain');
    expect(['acme/fast-1', 'acme/mid-1', 'acme/slow-1']).toContain(decision.selectedModelId);
  });

  it('cannot select a cheaper, stronger model that the fleet excludes', () => {
    // The decisive case. `acme/bargain` wins outright on expected cost, so if
    // the fleet were a preference rather than a boundary it would be chosen.
    const withoutFleet = route(registryFor());
    expect(withoutFleet.selectedModelId).toBe('acme/bargain');

    const withFleet = route(
      registryFor({
        models: [
          { id: 'acme/fast-1', tier: 'cheap' },
          { id: 'acme/mid-1', tier: 'medium' },
          { id: 'acme/slow-1', tier: 'expensive' },
        ],
      }),
    );
    expect(withFleet.selectedModelId).not.toBe('acme/bargain');
  });

  it('never scores an out-of-fleet model at all', () => {
    // Not merely unselected: expected-cost ranking never saw it, so it cannot
    // appear as a candidate, an exclusion, or an escalation target.
    const decision = route(
      registryFor({
        models: [
          { id: 'acme/fast-1', tier: 'cheap' },
          { id: 'acme/mid-1', tier: 'medium' },
        ],
      }),
    );

    const mentioned = [
      ...decision.evaluations.map((evaluation) => evaluation.modelId),
      ...decision.excluded.map((exclusion) => exclusion.modelId),
      ...decision.evaluations.map((evaluation) => evaluation.escalationTargetId),
    ];

    expect(mentioned).not.toContain('acme/bargain');
    expect(mentioned).not.toContain('acme/slow-1');
  });

  it('refuses an explicitly requested model outside the fleet', () => {
    // An explicit request is a decision, but the fleet is the user's decision
    // too, and it is the one that says what may run at all.
    const decision = new RoutingEngine(
      registryFor({ models: [{ id: 'acme/fast-1', tier: 'cheap' }] }),
    ).route({
      features: featuresFor(TASK),
      policy: policy({ minimumSuccessProbability: 0.5, modelOverrideEnabled: true }),
      requestedModelId: 'acme/bargain',
      operationMode: 'normal',
    });

    expect(decision.selectedModelId).not.toBe('acme/bargain');
  });
});

describe('a one-model fleet is deterministic', () => {
  const single = { models: [{ id: 'acme/mid-1', tier: 'medium' as const }] };

  it('selects that model', () => {
    const decision = route(registryFor(single));
    expect(decision.selectedModelId).toBe('acme/mid-1');
  });

  it('does not explore, even with the bandit switched on and trained', () => {
    // Exploring would mean claiming an experiment took place when there was no
    // alternative to run.
    const decision = route(registryFor(single), trained('acme/mid-1'), OPEN);

    expect(decision.exploration.explored).toBe(false);
    expect(decision.exploration.reason).toContain('only one model is eligible');
  });

  it('is stable across repeated routes', () => {
    const registry = registryFor(single);
    const first = route(registry, trained('acme/mid-1'), OPEN);
    const second = route(registry, trained('acme/mid-1'), OPEN);

    expect(first.selectedModelId).toBe(second.selectedModelId);
  });
});

describe('the bandit operates inside the fleet', () => {
  const three = {
    models: [
      { id: 'acme/fast-1', tier: 'cheap' as const },
      { id: 'acme/mid-1', tier: 'medium' as const },
      { id: 'acme/slow-1', tier: 'expensive' as const },
    ],
  };

  it('keeps both the exploit and the explored choice inside the fleet', () => {
    const decision = route(registryFor(three), trained('acme/fast-1'), OPEN);
    const permitted = ['acme/fast-1', 'acme/mid-1', 'acme/slow-1'];

    expect(permitted).toContain(decision.selectedModelId);
    if (decision.exploration.exploitModelId !== null) {
      expect(permitted).toContain(decision.exploration.exploitModelId);
    }
  });

  it('may still explore when more than one model is eligible', () => {
    // The positive control for the one-model rule: it must suppress exploration
    // only where there is genuinely nothing to explore.
    const decision = route(registryFor(three), trained('acme/fast-1'), OPEN);

    expect(decision.exploration.reason).not.toContain('only one model is eligible');
  });
});

describe('no fleet preserves existing behaviour', () => {
  it('routes over every configured model', () => {
    const decision = route(registryFor());

    expect(decision.evaluations.map((evaluation) => evaluation.modelId).sort()).toEqual([
      'acme/bargain',
      'acme/fast-1',
      'acme/mid-1',
      'acme/slow-1',
    ]);
  });

  it('attaches no fleet tier to any evaluation', () => {
    for (const evaluation of route(registryFor()).evaluations) {
      expect(evaluation.fleetTier).toBeUndefined();
    }
  });
});

describe('the fleet tier is reported but never used to choose', () => {
  it('carries the user tier onto each evaluation', () => {
    const decision = route(
      registryFor({
        models: [
          { id: 'acme/fast-1', tier: 'cheap' },
          { id: 'acme/slow-1', tier: 'expensive' },
        ],
      }),
    );

    const byId = new Map(decision.evaluations.map((e) => [e.modelId, e.fleetTier]));
    expect(byId.get('acme/fast-1')).toBe('cheap');
    expect(byId.get('acme/slow-1')).toBe('expensive');
  });

  it('names the tier in the explanation', () => {
    const decision = route(registryFor({ models: [{ id: 'acme/fast-1', tier: 'cheap' }] }));
    expect(decision.explanation.join('\n')).toContain('fleet: cheap');
  });

  it('does not let the label change the choice', () => {
    // Same two models, opposite labels. If the tier ordered anything, the
    // selection would move with it.
    const asWritten = route(
      registryFor({
        models: [
          { id: 'acme/fast-1', tier: 'cheap' },
          { id: 'acme/slow-1', tier: 'expensive' },
        ],
      }),
    );
    const inverted = route(
      registryFor({
        models: [
          { id: 'acme/fast-1', tier: 'expensive' },
          { id: 'acme/slow-1', tier: 'cheap' },
        ],
      }),
    );

    expect(asWritten.selectedModelId).toBe(inverted.selectedModelId);
  });
});

describe('the fleet tier reaches telemetry only as far as the schema allows', () => {
  it('is absent from the persisted schema, which is documented not accidental', () => {
    // Phase 25 deliberately adds no SQLite migration, so `routing_decisions`
    // and `candidates` have nowhere to put a fleet tier. Stating the limitation
    // as a fact about the code, not only in prose: if a later phase adds the
    // column, this fails and the documentation must be revisited with it.
    expect(JSON.stringify(MIGRATIONS)).not.toContain('fleet_tier');
  });

  it('is carried on the decision instead, which the recorder receives', () => {
    // Not persisted is not the same as unavailable: anything consuming a
    // RunResult -- the CLI, the extension, a future migration -- can read it.
    const decision = route(registryFor({ models: [{ id: 'acme/fast-1', tier: 'cheap' }] }));

    expect(decision.evaluations[0]?.fleetTier).toBe('cheap');
  });
});
