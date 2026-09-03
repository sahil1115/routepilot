/**
 * `routepilot status`.
 *
 * Status is how a user answers "is RoutePilot ready to work here, and what can
 * it actually do?" without spending anything. Two things it must get right:
 * never claim a capability that does not exist, and never print a credential.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliWorkspace, invokeCli, type CliWorkspace } from '../test-support/cli-harness.js';
import { EXIT_ERROR, EXIT_OK } from './exit-codes.js';
import { CAPABILITIES } from './status.js';

let workspace: CliWorkspace;

beforeEach(async () => {
  workspace = await createCliWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

const status = (...argv: string[]) =>
  invokeCli('status', '--config', workspace.configPath, ...argv);

/** Run with `ACME_KEY` forced to a known state, then restore it. */
async function withCredential<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const previous = process.env['ACME_KEY'];
  if (value === undefined) delete process.env['ACME_KEY'];
  else process.env['ACME_KEY'] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env['ACME_KEY'];
    else process.env['ACME_KEY'] = previous;
  }
}

describe('status — what it reports', () => {
  it('reports configuration, providers, policy, budgets and capabilities', async () => {
    const result = await status();

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('implemented phase');
    expect(result.stdout).toContain('Configuration');
    expect(result.stdout).toContain('Providers');
    expect(result.stdout).toContain('Routing policy');
    expect(result.stdout).toContain('Budgets and features');
    expect(result.stdout).toContain('Capabilities');
  });

  it('counts the configured providers and models', async () => {
    const result = await status();

    expect(result.stdout).toMatch(/providers:\s+2/);
    expect(result.stdout).toMatch(/models:\s+4/);
  });

  it('reports that learning and exploration are off by default', async () => {
    // Spec sections 35 and 40: both must default to disabled.
    const result = await status();

    expect(result.stdout).toMatch(/learning:\s+disabled/);
    expect(result.stdout).toMatch(/exploration:\s+disabled/);
    expect(result.stdout).toMatch(/telemetry:\s+enabled \(privacy: strict\)/);
  });
});

describe('status — capability honesty', () => {
  it('marks unimplemented commands as unavailable, with a reason', async () => {
    const result = await status();

    expect(result.stdout).toMatch(/history\s+not yet\s+\S/);
    expect(result.stdout).toMatch(/evaluate\s+not yet\s+\S/);
  });

  it('marks implemented commands as available', async () => {
    const result = await status();

    expect(result.stdout).toMatch(/route\s+available/);
    expect(result.stdout).toMatch(/analyze\s+available/);
  });

  it('keeps the capability table in step with what the CLI actually dispatches', async () => {
    // A capability marked available must not fall through to "unknown command".
    for (const capability of CAPABILITIES.filter((c) => c.available)) {
      const result = await invokeCli(
        capability.command,
        capability.command === 'config' ? 'validate' : 'x',
        '--config',
        workspace.configPath,
        '--root',
        workspace.dir,
      );
      expect(result.stderr, `${capability.command} should be dispatched`).not.toContain(
        'Unknown command',
      );
    }
  });

  it('every unavailable capability explains what it is waiting for', () => {
    // Deliberately not a match on "Phase N". An earlier version of this test
    // required one, which quietly enforced a stale reason: `run` was still
    // described as "needs agent adapters — Phase 5" long after the adapters
    // were built and the real gap had become "nothing drives them". What must
    // hold is that the reason is specific, not that it cites a phase number.
    for (const capability of CAPABILITIES.filter((entry) => !entry.available)) {
      expect(capability.detail.length).toBeGreaterThan(20);
      expect(capability.detail).not.toMatch(/^(not implemented|unavailable|todo)\.?$/i);
    }
  });
});

describe('status — credentials', () => {
  it('reports a present credential without printing its value', async () => {
    const secret = 'sk-super-secret-value-do-not-print';

    const result = await withCredential(secret, () => status());

    expect(result.stdout).toContain('ACME_KEY');
    expect(result.stdout).toContain('set');
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it('flags a missing credential loudly', async () => {
    const result = await withCredential(undefined, () => status());

    expect(result.stdout).toContain('NOT SET');
    expect(result.stdout).toContain('Routing and analysis still work');
  });

  it('treats an empty string as missing, not as present', async () => {
    const result = await withCredential('', () => status());
    expect(result.stdout).toContain('NOT SET');
  });

  it('says "not required" for a provider that needs no credential', async () => {
    const result = await status();
    expect(result.stdout).toContain('not required');
  });

  it('never prints a credential in JSON either', async () => {
    const secret = 'sk-json-secret-value';

    const result = await withCredential(secret, () => status('--json'));
    const parsed = JSON.parse(result.stdout) as {
      providers: { credentialVariable: string | null; credentialPresent: boolean }[];
    };

    expect(result.stdout).not.toContain(secret);
    const acme = parsed.providers.find((p) => p.credentialVariable === 'ACME_KEY');
    expect(acme?.credentialPresent).toBe(true);
  });
});

describe('status — JSON form', () => {
  it('is parseable and carries the same facts', async () => {
    const result = await status('--json');
    const parsed = JSON.parse(result.stdout) as {
      implementedPhase: number;
      configuration: { valid: boolean; models: number; providers: number; source: string };
      policy: { minimumSuccessProbability: number; currency: string };
      capabilities: { command: string; available: boolean }[];
    };

    expect(parsed.implementedPhase).toBeGreaterThanOrEqual(4);
    expect(parsed.configuration.valid).toBe(true);
    expect(parsed.configuration.models).toBe(4);
    expect(parsed.configuration.providers).toBe(2);
    expect(parsed.configuration.source).toBe('explicit');
    expect(parsed.policy.currency).toBe('USD');
    expect(parsed.capabilities.find((c) => c.command === 'run')?.available).toBe(true);
    expect(parsed.capabilities.find((c) => c.command === 'route')?.available).toBe(true);
  });
});

describe('status — invalid configuration', () => {
  it('reports the problem rather than rendering a broken status page', async () => {
    const badPath = join(workspace.dir, 'bad-status.json');
    await writeFile(badPath, JSON.stringify({ version: 1, models: 'nope' }), 'utf8');

    const result = await invokeCli('status', '--config', badPath);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.stderr).toContain('Invalid RoutePilot configuration');
    expect(result.stdout).toBe('');
  });
});

describe('commands that later phases will deliver', () => {
  it.each([
    ['history', 'telemetry store'],
    ['evaluate', 'policy evaluation'],
  ])('answers "%s" with what it needs, not "unknown command"', async (command, needs) => {
    const result = await invokeCli(command, '--config', workspace.configPath);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.stderr).toContain('not available yet');
    expect(result.stderr).toContain(needs);
    expect(result.stderr).not.toContain('Unknown command');
  });

  it('points at status for the full picture', async () => {
    const result = await invokeCli('history');
    expect(result.stderr).toContain('routepilot status');
  });
});
