import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { IMPLEMENTED_PHASE, PRODUCT_ID, PRODUCT_NAME, getBuildInfo } from './index.js';

describe('baseline build info', () => {
  it('exposes a stable product identity', () => {
    expect(PRODUCT_ID).toBe('routepilot');
    expect(PRODUCT_NAME).toBe('RoutePilot');
  });

  it('reports the phase actually implemented in this build', () => {
    const info = getBuildInfo();
    expect(info.implementedPhase).toBe(IMPLEMENTED_PHASE);
    expect(Number.isInteger(info.implementedPhase)).toBe(true);
  });
});

describe('toolchain baseline', () => {
  it('runs on a supported Node major version', () => {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});

describe('the implemented-phase marker stays honest', () => {
  it('matches the highest phase the roadmap marks complete', async () => {
    // This marker drifted silently three times — Phase 4, Phase 9 and Phase 15
    // each found it stale — because forgetting to bump it broke nothing. It is
    // shown to users by `routepilot status` and `--version`, so a stale value
    // is a claim about the build that is not true.
    const roadmap = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'ROADMAP.md'),
      'utf8',
    );

    const complete: number[] = [];
    for (const line of roadmap.split('\n')) {
      const match = /^\|\s*(\d+)\s*\|.*\|\s*\*\*Complete/.exec(line);
      if (match?.[1] !== undefined) complete.push(Number(match[1]));
    }

    expect(complete.length).toBeGreaterThan(0);
    expect(IMPLEMENTED_PHASE).toBe(Math.max(...complete));
  });
});
