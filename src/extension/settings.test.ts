/**
 * Editor settings, and the rule that they may only narrow.
 *
 * A workspace `.vscode/settings.json` is a file in a repository. It arrives
 * through clones, branches and pull requests, and VS Code applies it without
 * asking. So the tests that matter here are the ones proving a hostile file
 * cannot raise a budget, lower a confidence threshold, switch exploration on,
 * or relax the operation mode.
 */

import { describe, expect, it } from 'vitest';

import type { ConfiguredLimits, EditorSettings } from './settings.js';
import { resolveSettings } from './settings.js';

const LIMITS: ConfiguredLimits = {
  requestBudget: 1,
  minimumSuccessProbability: 0.85,
  explorationEnabled: false,
  operationMode: 'production',
};

const resolve = (settings: EditorSettings, limits: Partial<ConfiguredLimits> = {}) =>
  resolveSettings(settings, { ...LIMITS, ...limits });

describe('with no settings at all', () => {
  it('falls back to the configuration', () => {
    const resolved = resolve({});

    expect(resolved.policyOverrides).toEqual({});
    expect(resolved.operationMode).toBe('production');
    expect(resolved.explorationAllowed).toBe(false);
    expect(resolved.ignored).toEqual([]);
  });

  it('shows the status bar by default', () => {
    // A router that silently picks models without a visible indicator is one
    // whose decisions nobody notices.
    expect(resolve({}).showStatusBar).toBe(true);
  });
});

describe('the budget may only be lowered', () => {
  it('accepts a lower budget', () => {
    expect(resolve({ requestBudget: 0.25 }).policyOverrides.requestBudget).toBe(0.25);
  });

  it('refuses a higher one, and says so', () => {
    const resolved = resolve({ requestBudget: 50 });

    expect(resolved.policyOverrides.requestBudget).toBeUndefined();
    expect(resolved.ignored[0]).toContain('above the configured limit');
  });

  it('accepts any budget when the configuration sets no limit', () => {
    // Nothing to widen past: an absent limit is not a limit of zero.
    expect(
      resolve({ requestBudget: 50 }, { requestBudget: undefined }).policyOverrides.requestBudget,
    ).toBe(50);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', (requestBudget) => {
    const resolved = resolve({ requestBudget });

    expect(resolved.policyOverrides.requestBudget).toBeUndefined();
    expect(resolved.ignored).toHaveLength(1);
  });
});

describe('the confidence threshold may only be raised', () => {
  it('accepts a stricter threshold', () => {
    expect(
      resolve({ minimumSuccessProbability: 0.95 }).policyOverrides.minimumSuccessProbability,
    ).toBe(0.95);
  });

  it('refuses a looser one', () => {
    const resolved = resolve({ minimumSuccessProbability: 0.2 });

    expect(resolved.policyOverrides.minimumSuccessProbability).toBeUndefined();
    expect(resolved.ignored[0]).toContain('below the configured');
  });

  it.each([-0.1, 1.5, Number.NaN])('refuses %s as not a probability', (value) => {
    expect(resolve({ minimumSuccessProbability: value }).ignored).toHaveLength(1);
  });
});

describe('exploration may only be switched off', () => {
  it('refuses to switch it on when the configuration has it off', () => {
    // The setting that would most obviously be abused: an untrusted repository
    // turning on experiments.
    const resolved = resolve({ explorationEnabled: true });

    expect(resolved.explorationAllowed).toBe(false);
    expect(resolved.ignored[0]).toContain('disabled in the configuration');
  });

  it('switches it off when the configuration has it on', () => {
    const resolved = resolve({ explorationEnabled: false }, { explorationEnabled: true });

    expect(resolved.explorationAllowed).toBe(false);
    expect(resolved.ignored).toEqual([]);
  });

  it('leaves it on when the configuration allows and the editor is silent', () => {
    expect(resolve({}, { explorationEnabled: true }).explorationAllowed).toBe(true);
  });
});

describe('the operation mode may only become stricter', () => {
  it('accepts a stricter mode', () => {
    expect(resolve({ operationMode: 'critical' }).operationMode).toBe('critical');
  });

  it('refuses a laxer one', () => {
    // The one direction that would *permit* experiments.
    const resolved = resolve({ operationMode: 'normal' });

    expect(resolved.operationMode).toBe('production');
    expect(resolved.ignored[0]).toContain('less strict');
  });

  it('allows normal when the configuration is already normal', () => {
    expect(resolve({ operationMode: 'normal' }, { operationMode: 'normal' }).operationMode).toBe(
      'normal',
    );
  });

  it('refuses an unknown mode rather than guessing', () => {
    const resolved = resolve({ operationMode: 'prodution' });

    expect(resolved.operationMode).toBe('production');
    expect(resolved.ignored[0]).toContain('unknown mode');
  });
});

describe('analysis level', () => {
  it.each([1, 2, 3] as const)('accepts level %s', (level) => {
    expect(resolve({ analysisLevel: level }).analysisLevel).toBe(level);
  });

  it.each([0, 4, 2.5])('refuses %s', (analysisLevel) => {
    const resolved = resolve({ analysisLevel });

    expect(resolved.analysisLevel).toBeUndefined();
    expect(resolved.ignored[0]).toContain('must be 1, 2 or 3');
  });
});

describe('ignored settings are reported, not silently dropped', () => {
  it('lists every one', () => {
    // A user who set a budget of 50 and got 1 deserves to know the file did not
    // win, rather than wondering why the numbers disagree.
    const resolved = resolve({
      requestBudget: 50,
      minimumSuccessProbability: 0.1,
      explorationEnabled: true,
      operationMode: 'normal',
      analysisLevel: 9,
    });

    expect(resolved.ignored).toHaveLength(5);
    for (const entry of resolved.ignored) {
      expect(entry).toMatch(/^routepilot\./);
    }
  });

  it('names the setting key, so it can be found and fixed', () => {
    expect(resolve({ requestBudget: 50 }).ignored[0]).toContain('routepilot.requestBudget');
  });
});

describe('a hostile workspace file changes nothing dangerous', () => {
  it('cannot widen any limit at once', () => {
    const hostile: EditorSettings = {
      requestBudget: 1_000_000,
      minimumSuccessProbability: 0,
      explorationEnabled: true,
      operationMode: 'normal',
    };

    const resolved = resolve(hostile);

    expect(resolved.policyOverrides).toEqual({});
    expect(resolved.explorationAllowed).toBe(false);
    expect(resolved.operationMode).toBe('production');
    expect(resolved.ignored).toHaveLength(4);
  });
});
