/**
 * `routepilot calibration`, and how the safeguard appears to a user.
 *
 * A safeguard that fires silently is barely a safeguard: routing changes and
 * the user has no way to find out why. These tests assert the reporting, not
 * only the decision.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../config/schema.js';
import type { RoutePilotConfig } from '../config/types.js';
import { cliConfigDocument } from '../test-support/cli-harness.js';
import {
  asRecords,
  InMemoryPredictionStore,
  noSkill,
  overConfident,
  wellCalibrated,
} from '../test-support/calibration-fixtures.js';
import { InMemoryLearningStore, syntheticObservations } from '../test-support/learning-fixtures.js';
import { LearnedSuccessModel } from '../core/learning/success-model.js';
import type { LearnedStats } from '../core/types/learning.js';
import type { PredictionRecord, PredictionSource } from '../core/types/calibration.js';
import { assessAll, renderCalibration } from './calibration.js';
import { renderDecision, routeTask } from './route.js';

const TASK = 'implement a new /users API endpoint';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routepilot-calib-cli-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'w' }), 'utf8');
  await writeFile(join(dir, 'index.ts'), 'export const x = 1;\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function config(): RoutePilotConfig {
  return parseConfig({
    ...cliConfigDocument(),
    learning: { enabled: true, minimumTrainingSamples: 20 },
  });
}

/** A store holding both learned statistics and a prediction history. */
class CombinedStore {
  readonly enabled = true;
  readonly #learning: InMemoryLearningStore;
  readonly #predictions: InMemoryPredictionStore;

  constructor(predictions: readonly PredictionRecord[]) {
    this.#learning = new InMemoryLearningStore();
    const trainer = new LearnedSuccessModel(this.#learning, {
      enabled: true,
      minimumTrainingSamples: 20,
    });
    trainer.observeAll(
      syntheticObservations('acme/fast-1', 60, {
        rate: 0.95,
        taskType: 'feature-implementation',
        scope: 'few-files',
      }),
      1_000,
    );
    this.#predictions = new InMemoryPredictionStore(predictions);
  }

  loadLearnedStats(): readonly LearnedStats[] {
    return this.#learning.loadLearnedStats();
  }
  saveLearnedStats(stats: readonly LearnedStats[]): void {
    this.#learning.saveLearnedStats(stats);
  }
  loadPredictions(limit: number, source?: PredictionSource): readonly PredictionRecord[] {
    return this.#predictions.loadPredictions(limit, source);
  }
  recordPredictions(records: readonly PredictionRecord[]): void {
    this.#predictions.recordPredictions(records);
  }
}

const render = async (store?: CombinedStore): Promise<string> => {
  const result = await routeTask({
    prompt: TASK,
    root: dir,
    level: 1,
    config: config(),
    ...(store === undefined ? {} : { learningStore: store }),
  });
  return renderDecision(result);
};

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

describe('renderCalibration', () => {
  it('explains the empty state instead of showing zeros', () => {
    // Zeros would read as a perfectly calibrated predictor. The honest report
    // is that nothing has been measured.
    const output = renderCalibration(assessAll([], config()));

    expect(output).toContain('No predictions have been scored');
    expect(output).not.toContain('Brier score');
  });

  it('scores learned estimates and priors separately', () => {
    // Pooling them would let good priors disguise bad learning.
    const result = assessAll(
      [
        ...asRecords(wellCalibrated(), { source: 'prior' }),
        ...asRecords(overConfident(), { source: 'learned' }).map((record, index) => ({
          ...record,
          requestId: `l-${String(index)}`,
        })),
      ],
      config(),
    );

    const learned = result.sources.find((source) => source.source === 'learned');
    const priors = result.sources.find((source) => source.source === 'prior');

    expect(learned?.verdict.status).toBe('distrusted');
    expect(priors?.verdict.status).toBe('trusted');
  });

  it('shows the reliability diagram as a table', () => {
    const output = renderCalibration(assessAll(asRecords(wellCalibrated()), config()));

    expect(output).toContain('Reliability by confidence band');
    expect(output).toContain('PREDICTED');
    expect(output).toContain('ACTUAL');
    // Four populated bands from the fixture's four prediction levels.
    expect(output).toContain('0.2-0.3');
    expect(output).toContain('0.9-1.0');
  });

  it('omits empty bands rather than printing rows of zeros', () => {
    const output = renderCalibration(assessAll(asRecords(overConfident()), config()));

    expect(output).toContain('0.9-1.0');
    expect(output).not.toContain('0.0-0.1');
  });

  it('says what the sign of the bias means operationally', () => {
    const output = renderCalibration(assessAll(asRecords(overConfident()), config()));
    expect(output).toContain('over-confident: spends on attempts that fail');
  });

  it('labels a withdrawn predictor with its consequence', () => {
    const output = renderCalibration(assessAll(asRecords(overConfident()), config()));

    expect(output).toContain('DISTRUSTED (withdrawn, priors restored)');
    expect(output).toContain('expected calibration error');
  });

  it('labels a trusted predictor as in use', () => {
    const output = renderCalibration(assessAll(asRecords(wellCalibrated()), config()));
    expect(output).toContain('TRUSTED (in use)');
  });

  it('reports the metrics of an unassessed predictor rather than withholding them', () => {
    // Not yet trusted is not a reason to hide the numbers — a user deciding
    // whether to keep going needs to see them.
    const output = renderCalibration(assessAll(asRecords(overConfident(10)), config()));

    expect(output).toContain('NOT YET ASSESSED');
    expect(output).toContain('Brier score');
  });

  it('names the useless predictor for what it is', () => {
    const output = renderCalibration(assessAll(asRecords(noSkill()), config()));

    expect(output).toContain('DISTRUSTED');
    expect(output).toContain('base rate');
    expect(output).toContain('resolution');
  });
});

// ---------------------------------------------------------------------------
// The safeguard in `routepilot route`
// ---------------------------------------------------------------------------

describe('the safeguard in a routing decision', () => {
  it('says nothing when the predictor is trusted', () => {
    // A banner on every healthy run is noise, and noise gets ignored.
    const store = new CombinedStore(asRecords(wellCalibrated()));
    return render(store).then((output) => {
      expect(output).not.toContain('Calibration safeguard');
    });
  });

  it('says nothing when there is no prediction history at all', async () => {
    expect(await render(new CombinedStore([]))).not.toContain('Calibration safeguard');
  });

  it('warns, and explains, when the predictor is withdrawn', async () => {
    const output = await render(new CombinedStore(asRecords(overConfident())));

    expect(output).toContain('Calibration safeguard');
    expect(output).toContain('fallen back to the configured priors');
    expect(output).toContain('routepilot calibration');
  });

  it('lists every breached threshold, not only the first', async () => {
    const output = await render(new CombinedStore(asRecords(overConfident())));
    expect(output).toContain('also');
  });

  it('changes the selected model back to the static choice', async () => {
    const trusted = await routeTask({
      prompt: TASK,
      root: dir,
      level: 1,
      config: config(),
      learningStore: new CombinedStore(asRecords(wellCalibrated())),
    });
    const distrusted = await routeTask({
      prompt: TASK,
      root: dir,
      level: 1,
      config: config(),
      learningStore: new CombinedStore(asRecords(overConfident())),
    });

    expect(trusted.decision.selectedModelId).toBe('acme/fast-1');
    expect(distrusted.decision.selectedModelId).toBe('acme/balanced-1');
    expect(trusted.calibration.status).toBe('trusted');
    expect(distrusted.calibration.status).toBe('distrusted');
  });

  it('still shows the observations it is declining to use', async () => {
    // Disbelieved, not hidden.
    const output = await render(new CombinedStore(asRecords(overConfident())));
    expect(output).toContain('60 runs (prior:');
  });
});
