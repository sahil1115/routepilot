/**
 * `routepilot shadow`, and how a divergence appears in a routing decision.
 *
 * The report's job is to be useful without overclaiming. Most of these tests
 * are about the second half of that: a shadow comparison is evidence that two
 * policies disagree, and nothing more, so the report must not read as though a
 * saving had been measured.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../config/schema.js';
import type { RoutePilotConfig } from '../config/types.js';
import type { ShadowRecord } from '../core/types/shadow.js';
import { cliConfigDocument } from '../test-support/cli-harness.js';
import { renderDecision, routeTask } from './route.js';
import { buildShadowReport, renderShadowReport } from './shadow.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routepilot-shadow-cli-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'w' }), 'utf8');
  await writeFile(join(dir, 'index.ts'), 'export const x = 1;\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function config(shadow: Partial<RoutePilotConfig['shadow']> = {}): RoutePilotConfig {
  return parseConfig({
    ...cliConfigDocument(),
    shadow: { enabled: true, policies: ['strongest-first'], ...shadow },
  });
}

const record = (overrides: Partial<ShadowRecord> = {}): ShadowRecord => ({
  requestId: 'req-1',
  policyId: 'strongest-first',
  currentModelId: 'acme/fast-1',
  shadowModelId: 'acme/deep-1',
  agrees: false,
  estimatedCostDelta: 0.42,
  successProbabilityDelta: 0.08,
  at: 1_000,
  ...overrides,
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

describe('renderShadowReport', () => {
  it('explains what the baselines are when nothing is recorded', () => {
    const output = renderShadowReport(buildShadowReport([]), true);

    expect(output).toContain('no decisions have been recorded');
    expect(output).toContain('cheapest-first');
    expect(output).toContain('strongest-first');
  });

  it('says how to switch shadow routing on when it is off', () => {
    const output = renderShadowReport(buildShadowReport([]), false);

    expect(output).toContain('Shadow routing is disabled');
    expect(output).toContain('costs nothing to run');
  });

  it('reports agreement rate and divergence count', () => {
    const records = Array.from({ length: 10 }, (_unused, index) =>
      record({ requestId: `r${String(index)}`, agrees: index < 6 }),
    );
    const output = renderShadowReport(buildShadowReport(records), true);

    expect(output).toContain('60%');
    expect(output).toContain('10 recorded decisions');
  });

  it('names the models a policy preferred when it disagreed', () => {
    const output = renderShadowReport(buildShadowReport([record()]), true);
    expect(output).toContain('preferred instead: acme/deep-1');
  });

  it('carries the comparable count alongside the cost figure', () => {
    // A total over three decisions and one over three hundred are otherwise
    // indistinguishable.
    const output = renderShadowReport(
      buildShadowReport([record(), record({ requestId: 'r2' })]),
      true,
    );
    expect(output).toContain('over 2');
  });

  it('says "not comparable" rather than showing a zero delta', () => {
    // Every decision had one side select nothing. Printing +0.0000 would read
    // as "the policies cost the same", which is not what happened.
    const output = renderShadowReport(
      buildShadowReport([record({ estimatedCostDelta: null })]),
      true,
    );

    expect(output).toContain('not comparable');
  });

  it('never calls the difference a saving anywhere it reports a figure', () => {
    // The word appears once, in the caveat, denying the reading. It must not
    // appear in the part of the report that carries the numbers.
    const output = renderShadowReport(
      buildShadowReport([record({ estimatedCostDelta: -0.5 })]),
      true,
    );
    const body = output.slice(0, output.indexOf('These are estimates')).toLowerCase();

    expect(body).not.toContain('saving');
    expect(body).not.toContain('saved');
    expect(body).toContain('est. cost delta');
    // And the caveat rules the reading out explicitly.
    expect(output).toContain('not a saving that was missed');
  });

  it('states the limitation in full', () => {
    // The report is read by someone deciding whether to change policy. It has
    // to say what it cannot support.
    const output = renderShadowReport(buildShadowReport([record()]), true);

    expect(output).toContain('estimates, not measurements');
    expect(output).toContain('never executed');
    expect(output).toContain('no outcome exists');
  });
});

// ---------------------------------------------------------------------------
// The divergence in a routing decision
// ---------------------------------------------------------------------------

describe('shadow policies in a routing decision', () => {
  const route = (cfg: RoutePilotConfig) =>
    routeTask({
      prompt: 'implement a new /users API endpoint',
      root: dir,
      level: 1,
      config: cfg,
      policyOverrides: { minimumSuccessProbability: 0.5 },
    });

  it('evaluates nothing when shadow routing is disabled', async () => {
    const result = await route(config({ enabled: false }));
    expect(result.shadow).toBeNull();
  });

  it('evaluates the configured policies when enabled', async () => {
    const result = await route(config());

    expect(result.shadow).not.toBeNull();
    expect(result.shadow?.shadows.map((entry) => entry.policyId)).toEqual(['strongest-first']);
  });

  it('shows a divergence, labelled as not executed', async () => {
    const output = renderDecision(await route(config()));

    expect(output).toContain('Shadow policies (evaluated, not executed)');
    expect(output).toContain('WOULD CHOOSE');
    expect(output).toContain('not measured savings');
  });

  it('says nothing when every shadow agrees', async () => {
    // Three rows all naming the selected model is noise; the interesting fact
    // is better read from a history than a single request.
    const output = renderDecision(await route(config({ policies: ['cheapest-first'] })));

    expect(output).not.toContain('Shadow policies');
  });

  it('leaves the live decision identical either way', async () => {
    const withShadow = await route(config());
    const without = await route(config({ enabled: false }));

    expect(withShadow.decision).toEqual(without.decision);
  });

  it('never reports a shadow model as selected', async () => {
    // The one thing that would be catastrophic: a shadow choice leaking into
    // the decision that gets executed.
    const result = await route(config());
    const divergent = result.shadow?.shadows.filter((entry) => !entry.agrees) ?? [];

    expect(divergent.length).toBeGreaterThan(0);
    for (const entry of divergent) {
      expect(result.decision.selectedModelId).not.toBe(entry.selectedModelId);
    }
  });
});

describe('configuration', () => {
  it('rejects an unknown policy id rather than silently dropping it', () => {
    // A typo that quietly disabled a comparison would leave a user believing
    // they were measuring something they were not.
    expect(() =>
      parseConfig({ ...cliConfigDocument(), shadow: { enabled: true, policies: ['cheapest'] } }),
    ).toThrow();
  });

  it('defaults to disabled with every baseline listed', () => {
    const parsed = parseConfig(cliConfigDocument());

    expect(parsed.shadow.enabled).toBe(false);
    expect(parsed.shadow.policies).toEqual(['priors-only', 'cheapest-first', 'strongest-first']);
  });
});
