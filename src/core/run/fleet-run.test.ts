/**
 * Escalation and recovery cannot escape a configured fleet (Phase 25).
 *
 * Routing choosing inside the fleet is only half the guarantee. A run that
 * fails repeatedly asks the escalation engine for another model, and a provider
 * outage asks for the same model somewhere else — both are places where a
 * stronger or alternative model could quietly appear from outside the user's
 * list.
 *
 * They cannot, because `TaskRunner` builds its eligible set from the routing
 * decision's own evaluations, which came from the restricted registry. These
 * tests hold that end to end: the assertion is which models were **actually
 * asked to run**, not what the engine intended.
 */

import { describe, expect, it } from 'vitest';

import { buildRegistries } from '../../config/registries.js';
import { parseConfig } from '../../config/schema.js';
import {
  makesBadEdits,
  providerFailure,
  ScriptedExecutor,
  steppingClock,
  succeeds,
} from '../../test-support/e2e-fixtures.js';
import { makeConfigDocument, makeModelDocument } from '../../test-support/fixtures.js';
import { featuresFor, policy } from '../../test-support/routing-fixtures.js';
import type { ModelRegistry } from '../registry/model-registry.js';
import { RoutingEngine } from '../routing/routing-engine.js';
import { TaskRunner } from './task-runner.js';

const TASK = 'implement a new /users API endpoint';

/**
 * Four models across two providers.
 *
 * `zenith/escape` is the strongest thing configured and sits on a second
 * provider, so it is the natural target for both a vertical escalation and a
 * provider fallback. It is never in the fleet.
 */
function models(): Record<string, unknown>[] {
  const strong = {
    codeGeneration: 0.97,
    codeEditing: 0.97,
    debugging: 0.97,
    refactoring: 0.97,
    architecture: 0.97,
    reasoning: 0.97,
    testGeneration: 0.97,
    documentation: 0.97,
    multiFileReasoning: 0.97,
  };

  return [
    makeModelDocument({ id: 'acme/fast-1', modelId: 'fast-1', tier: 'cheap' }),
    makeModelDocument({ id: 'acme/mid-1', modelId: 'mid-1', tier: 'medium' }),
    makeModelDocument({
      id: 'acme/strong-1',
      modelId: 'strong-1',
      tier: 'frontier',
      priors: { skills: strong, languages: { typescript: 0.97 } },
    }),
    makeModelDocument({
      id: 'zenith/escape',
      modelId: 'escape',
      providerId: 'zenith',
      tier: 'ultra',
      priors: { skills: strong, languages: { typescript: 0.99 } },
    }),
  ];
}

function registryFor(fleet?: unknown): ModelRegistry {
  return buildRegistries(
    parseConfig(
      makeConfigDocument({
        providers: [
          { id: 'acme', displayName: 'Acme', kind: 'cloud', auth: { kind: 'none' } },
          { id: 'zenith', displayName: 'Zenith', kind: 'cloud', auth: { kind: 'none' } },
        ],
        models: models(),
        ...(fleet === undefined ? {} : { fleet }),
      }),
    ),
  ).models;
}

/** Run a task with every model scripted to fail the given way. */
async function runWith(
  registry: ModelRegistry,
  script: Record<string, ReturnType<typeof makesBadEdits>>,
  fallback: ReturnType<typeof makesBadEdits>,
): Promise<{ executed: string[]; finalModelId: string | null }> {
  const executor = new ScriptedExecutor(script, fallback);
  const runner = new TaskRunner({
    models: registry,
    router: new RoutingEngine(registry),
    executor,
    clock: steppingClock(),
  });

  const result = await runner.run({
    requestId: 'fleet-run',
    task: TASK,
    workspaceRoot: '/tmp/fleet',
    features: featuresFor(TASK),
    policy: policy({ minimumSuccessProbability: 0.5 }),
  });

  return { executed: executor.executedModelIds, finalModelId: result.finalModelId };
}

const FLEET = {
  models: [
    { id: 'acme/fast-1', tier: 'cheap' as const },
    { id: 'acme/mid-1', tier: 'medium' as const },
  ],
};

const PERMITTED = ['acme/fast-1', 'acme/mid-1'];

describe('escalation stays inside the fleet', () => {
  it('never runs an out-of-fleet model, however weak the fleet proves', async () => {
    // Every permitted model damages the repository, which is the one
    // classification that justifies reaching for a stronger model. The
    // strongest models configured are both outside the fleet.
    const { executed } = await runWith(registryFor(FLEET), {}, makesBadEdits());

    expect(executed.length).toBeGreaterThan(0);
    for (const modelId of executed) expect(PERMITTED).toContain(modelId);
    expect(executed).not.toContain('acme/strong-1');
    expect(executed).not.toContain('zenith/escape');
  });

  it('does escalate to a stronger model when the fleet contains one', async () => {
    // The positive control. Without it, "never escaped the fleet" could be
    // satisfied by never escalating at all.
    const registry = registryFor({
      models: [
        { id: 'acme/fast-1', tier: 'cheap' },
        { id: 'acme/strong-1', tier: 'expensive' },
      ],
    });

    const { executed } = await runWith(
      registry,
      { 'acme/fast-1': makesBadEdits(), 'acme/strong-1': succeeds() },
      makesBadEdits(),
    );

    expect(executed).toContain('acme/strong-1');
    expect(executed).not.toContain('zenith/escape');
  });

  it('reaches the out-of-fleet model when no fleet is configured', async () => {
    // Proves the exclusion above is the fleet's doing, not an artefact of the
    // scenario: unrestricted, escalation genuinely does reach further.
    const { executed } = await runWith(registryFor(), {}, makesBadEdits());

    const reachedBeyond = executed.some((id) => !PERMITTED.includes(id));
    expect(reachedBeyond).toBe(true);
  });
});

describe('provider fallback stays inside the fleet', () => {
  it('never falls back to a provider the fleet excludes', async () => {
    // A provider outage asks for a comparable model elsewhere. `zenith/escape`
    // is the only other provider configured, and it is not permitted.
    const { executed } = await runWith(
      registryFor(FLEET),
      {},
      providerFailure('the provider is unreachable'),
    );

    for (const modelId of executed) expect(PERMITTED).toContain(modelId);
    expect(executed).not.toContain('zenith/escape');
  });

  it('stops rather than routing outside the fleet', async () => {
    // The run must end, not loop looking for an alternative it may not use.
    const { executed } = await runWith(
      registryFor({ models: [{ id: 'acme/fast-1', tier: 'cheap' }] }),
      {},
      providerFailure('the provider is unreachable'),
    );

    expect(new Set(executed)).toEqual(new Set(['acme/fast-1']));
  });
});

describe('a one-model fleet runs only that model', () => {
  it('retries the same model and never substitutes another', async () => {
    const { executed } = await runWith(
      registryFor({ models: [{ id: 'acme/mid-1', tier: 'medium' }] }),
      {},
      makesBadEdits(),
    );

    expect(new Set(executed)).toEqual(new Set(['acme/mid-1']));
  });
});
