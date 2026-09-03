/**
 * Phase 4 acceptance: RoutePilot operates without VS Code.
 *
 * Everything a user needs — routing a task, seeing the decision, the
 * explanation, the estimated cost and the candidate models, and getting a
 * clear answer when configuration is broken, nothing is eligible, or the
 * budget will not stretch — has to be reachable from a terminal alone.
 *
 * These tests drive the real `run(argv, io)` entry point against a real
 * configuration file on disk.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cliConfigDocument,
  createCliWorkspace,
  invokeCli,
  type CliWorkspace,
} from '../test-support/cli-harness.js';
import { EXIT_ERROR, EXIT_NO_MODEL, EXIT_OK, EXIT_USAGE } from './exit-codes.js';

let workspace: CliWorkspace;

beforeEach(async () => {
  workspace = await createCliWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

/** Invoke against the fixture workspace and configuration. */
const cli = (...argv: string[]) =>
  invokeCli(...argv, '--root', workspace.dir, '--config', workspace.configPath);

describe('acceptance — a task can be routed from the terminal', () => {
  it('routes a task and names the selected model', async () => {
    const result = await cli('route', 'implement a new /users API endpoint');

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/^RoutePilot: acme\//);
  });

  it('needs nothing but a config file and a workspace', async () => {
    // No editor, no extension host, no provider credential.
    const previous = process.env['ACME_KEY'];
    delete process.env['ACME_KEY'];
    try {
      const result = await cli('route', 'rename a variable');
      expect(result.code).toBe(EXIT_OK);
    } finally {
      if (previous !== undefined) process.env['ACME_KEY'] = previous;
    }
  });
});

describe('display — the routing decision', () => {
  it('states the task, the decision and the reason', async () => {
    const result = await cli('route', 'implement a new /users API endpoint');

    expect(result.stdout).toContain('Task');
    expect(result.stdout).toContain('Decision');
    expect(result.stdout).toContain('cheapest path to success');
  });

  it('marks a decision that is unusual in some way', async () => {
    const explicit = await cli('route', 'rename a variable', '--model', 'acme/deep-1');
    expect(explicit.stdout).toContain('[explicitly requested]');
  });
});

describe('display — the explanation', () => {
  it('prints the provider-neutral explanation on request', async () => {
    const result = await cli('route', 'rename a variable', '--explain');

    expect(result.stdout).toContain('provider-neutral form');
    expect(result.stdout).toContain('Policy:');
  });

  it('omits it by default, since the tables already say the same thing', async () => {
    const result = await cli('route', 'rename a variable');
    expect(result.stdout).not.toContain('provider-neutral form');
  });

  it('always includes it in JSON, for other front ends', async () => {
    const result = await cli('route', 'rename a variable', '--json');
    const parsed = JSON.parse(result.stdout) as { decision: { explanation: string[] } };

    expect(parsed.decision.explanation.length).toBeGreaterThan(0);
  });
});

describe('display — the estimated cost', () => {
  it('shows first attempt, expected total, retry and escalation', async () => {
    const result = await cli('route', 'implement a new /users API endpoint');

    expect(result.stdout).toContain('Estimated cost');
    expect(result.stdout).toContain('first attempt');
    expect(result.stdout).toContain('expected total to success');
    expect(result.stdout).toContain('if it fails, one retry');
    expect(result.stdout).toContain('if it escalates');
    expect(result.stdout).toContain('estimated latency');
  });

  it('labels the figures as estimates, never as measurements', async () => {
    const result = await cli('route', 'implement a new endpoint');
    expect(result.stdout).toContain('from configured priors — not a measurement');
  });

  it('shows budget headroom when a budget is set', async () => {
    const result = await cli('route', 'rename a variable', '--budget', '10');

    expect(result.stdout).toContain('request budget');
    expect(result.stdout).toContain('used');
  });

  it('says "unlimited" rather than implying a budget of zero', async () => {
    const result = await cli('route', 'rename a variable');
    expect(result.stdout).toContain('unlimited');
  });
});

describe('display — the candidate models', () => {
  it('tabulates every candidate with success, cost and risk', async () => {
    const result = await cli('route', 'implement a new /users API endpoint');

    for (const column of ['MODEL', 'TIER', 'SUCCESS', 'EXPECTED', 'FIRST', 'RISK', 'STATUS']) {
      expect(result.stdout).toContain(column);
    }
    expect(result.stdout).toContain('SELECTED');
  });

  it('says why each unselected candidate lost', async () => {
    const result = await cli('route', 'implement a new /users API endpoint');
    expect(result.stdout).toMatch(/below confidence|over budget|too slow|over risk limit|eligible/);
  });

  it('lists models excluded before scoring, with the reason', async () => {
    const result = await cli('route', 'implement a new /users API endpoint');

    expect(result.stdout).toContain('Excluded before scoring');
    expect(result.stdout).toContain('MISSING_CAPABILITY');
    expect(result.stdout).toContain('globex/text-only');
  });

  it('shows the policy that was in force', async () => {
    const result = await cli('route', 'rename a variable');

    expect(result.stdout).toContain('minimum success');
    expect(result.stdout).toContain('maximum risk');
    expect(result.stdout).toContain('static tier prior');
  });
});

describe('failure — invalid configuration', () => {
  it('reports every problem with its path and exits with an error', async () => {
    const badPath = join(workspace.dir, 'bad.json');
    await writeFile(
      badPath,
      JSON.stringify({ version: 1, providers: [], models: [{ id: 'x' }] }),
      'utf8',
    );

    const result = await invokeCli('route', 'rename a variable', '--config', badPath);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.stderr).toContain('Invalid RoutePilot configuration');
    expect(result.stderr).toContain('models[0]');
  });

  it('reports a missing configuration file rather than inventing one', async () => {
    const result = await invokeCli('route', 'rename a variable', '--config', 'no-such-file.json');

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.stderr).toContain('not found');
  });

  it('reports malformed JSON distinctly from invalid configuration', async () => {
    const badPath = join(workspace.dir, 'broken.json');
    await writeFile(badPath, '{ not json ]', 'utf8');

    const result = await invokeCli('status', '--config', badPath);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.stderr).toContain('not valid JSON');
  });

  it('never echoes a credential pasted into configuration', async () => {
    const secret = 'sk-should-never-be-printed-12345';
    const badPath = join(workspace.dir, 'leaky.json');
    const document = cliConfigDocument();
    document.providers[0] = { ...document.providers[0], apiKey: secret };
    await writeFile(badPath, JSON.stringify(document), 'utf8');

    const result = await invokeCli('status', '--config', badPath);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.stderr).toContain('auth.envVar');
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });
});

describe('failure — no eligible model', () => {
  it('reports it clearly and exits 3, not 1', async () => {
    // Nothing configured can hold a million tokens of context.
    const result = await cli('route', 'refactor everything', '--level', '3', '--min-success', '1');

    expect(result.code).toBe(EXIT_NO_MODEL);
    expect(result.stdout).toContain('no model selected');
  });

  it('still shows why each candidate was rejected', async () => {
    const result = await cli('route', 'implement a new endpoint', '--min-success', '1');

    expect(result.stdout).toContain('no model selected');
    expect(result.stdout).toContain('below confidence');
  });

  it('reports an empty model set without pretending to route', async () => {
    const emptyPath = join(workspace.dir, 'empty.json');
    await writeFile(emptyPath, JSON.stringify({ version: 1 }), 'utf8');

    const result = await invokeCli(
      'route',
      'rename a variable',
      '--root',
      workspace.dir,
      '--config',
      emptyPath,
    );

    expect(result.code).toBe(EXIT_NO_MODEL);
    expect(result.stdout).toContain('no model selected');
  });
});

describe('failure — budget', () => {
  it('stops safely rather than overspending', async () => {
    const result = await cli('route', 'implement a new /users API endpoint', '--budget', '0');

    expect(result.code).toBe(EXIT_NO_MODEL);
    expect(result.stdout).toContain('no model selected');
    expect(result.stdout).toContain('budget');
  });

  it('names the amount it would have spent', async () => {
    const result = await cli('route', 'implement a new /users API endpoint', '--budget', '0');
    expect(result.stdout).toMatch(/\d+\.\d{4} USD/);
  });

  it('routes normally when the budget is generous', async () => {
    const result = await cli('route', 'implement a new /users API endpoint', '--budget', '100');

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/^RoutePilot: acme\//);
  });

  it('rejects a negative budget as a usage error', async () => {
    const result = await cli('route', 'rename a variable', '--budget', '-5');

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('non-negative');
  });
});

describe('the CLI is scriptable', () => {
  it('emits parseable JSON for every read-only command', async () => {
    for (const argv of [['models'], ['providers'], ['status'], ['analyze', 'rename a variable']]) {
      const result = await cli(...argv, '--json');
      expect(() => {
        JSON.parse(result.stdout);
      }).not.toThrow();
    }
  });

  it('keeps notices on stderr so stdout stays parseable', async () => {
    // The bundled-example fallback prints a notice; it must not corrupt JSON.
    const result = await invokeCli('models', '--json');

    expect(() => {
      JSON.parse(result.stdout);
    }).not.toThrow();
    expect(result.stderr).toContain('bundled example');
  });

  it('produces identical output for identical input', async () => {
    const first = await cli('route', 'implement a new endpoint', '--json');
    const second = await cli('route', 'implement a new endpoint', '--json');

    expect(second.stdout).toBe(first.stdout);
    expect(second.code).toBe(first.code);
  });
});
