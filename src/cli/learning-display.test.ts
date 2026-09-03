/**
 * How learning is presented to a user.
 *
 * A learned probability that cannot be distinguished from a configured one is
 * worse than no learning at all: it looks like evidence and is not. These tests
 * run the real `routeTask` and `renderDecision`, so what they assert is what a
 * user actually sees.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LearnedSuccessModel } from '../core/learning/success-model.js';
import { parseConfig } from '../config/schema.js';
import type { RoutePilotConfig } from '../config/types.js';
import { cliConfigDocument } from '../test-support/cli-harness.js';
import { InMemoryLearningStore, syntheticObservations } from '../test-support/learning-fixtures.js';
import { renderDecision, routeTask } from './route.js';

const TASK = 'implement a new /users API endpoint';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routepilot-learndisplay-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'w' }), 'utf8');
  await writeFile(join(dir, 'index.ts'), 'export const x = 1;\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function configWith(learning: Partial<RoutePilotConfig['learning']> = {}): RoutePilotConfig {
  return parseConfig({
    ...cliConfigDocument(),
    learning: { enabled: true, minimumTrainingSamples: 20, ...learning },
  });
}

/** A store where the cheap model has been observed doing well. */
function trainedStore(count = 60): InMemoryLearningStore {
  const store = new InMemoryLearningStore();
  const model = new LearnedSuccessModel(store, { enabled: true, minimumTrainingSamples: 20 });
  model.observeAll(
    syntheticObservations('acme/fast-1', count, {
      rate: 0.95,
      taskType: 'feature-implementation',
      scope: 'few-files',
    }),
    1_000,
  );
  return store;
}

const render = async (config: RoutePilotConfig, store?: InMemoryLearningStore): Promise<string> => {
  const result = await routeTask({
    prompt: TASK,
    root: dir,
    level: 1,
    config,
    ...(store === undefined ? {} : { learningStore: store }),
  });
  return renderDecision(result);
};

describe('with nothing observed', () => {
  it('shows no learning column at all', async () => {
    // A column of zeros on every run teaches the reader to skip it.
    const output = await render(configWith());
    expect(output).not.toContain('LEARNED FROM');
  });

  it('still calls the estimate a prior', async () => {
    const output = await render(configWith());
    expect(output).toContain('from configured priors');
    expect(output).toContain('not a measurement');
  });
});

describe('with observations', () => {
  it('shows how many runs stand behind each estimate', async () => {
    const output = await render(configWith(), trainedStore());

    expect(output).toContain('LEARNED FROM');
    expect(output).toContain('60 runs');
  });

  it('says "no data" for a model nothing has been observed about', async () => {
    // Not "0 runs", which reads like a measured zero, and certainly not blank.
    const output = await render(configWith(), trainedStore());
    expect(output).toContain('no data');
  });

  it('stops calling the figure a pure prior once evidence informs it', async () => {
    const output = await render(configWith(), trainedStore());

    expect(output).toContain('shrunk toward configured priors');
    expect(output).not.toContain('not a measurement');
  });
});

describe('when observations exist but are not being used', () => {
  it('marks them as unused and shows the prior that is still in force', async () => {
    // The dangerous case: a count next to an unchanged probability would look
    // like the number had been learned. It says otherwise, explicitly.
    const output = await render(configWith({ minimumTrainingSamples: 500 }), trainedStore());

    expect(output).toContain('60 runs (prior:');
    expect(output).toContain('from configured priors');
  });

  it('shows nothing learned when learning is switched off', async () => {
    const output = await render(configWith({ enabled: false }), trainedStore());

    expect(output).toContain('60 runs (prior:');
    expect(output).toContain('not a measurement');
  });
});

describe('the decision itself', () => {
  it('changes once the cheap model has proved itself', async () => {
    const before = await routeTask({ prompt: TASK, root: dir, level: 1, config: configWith() });
    const after = await routeTask({
      prompt: TASK,
      root: dir,
      level: 1,
      config: configWith(),
      learningStore: trainedStore(),
    });

    expect(before.decision.selectedModelId).toBe('acme/balanced-1');
    expect(after.decision.selectedModelId).toBe('acme/fast-1');
  });
});
