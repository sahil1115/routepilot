/**
 * The npm resolver, and the defect it exists for.
 *
 * Found by the first end-to-end run of the loop (Phase 26): the agent fixed the
 * fixture, its tests passed, and RoutePilot reported `unverified` anyway —
 * because `execFile('npm', ...)` with `shell: false` cannot launch `npm.cmd` on
 * Windows, so every derived check reported "not run".
 *
 * Nothing caught it because every other test injects a fake command runner, and
 * the real-agent script drove adapters directly rather than the loop.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { commandsFromPackageScripts } from '../core/execution/validation.js';
import { resolveNpmCommand } from './npm-command.js';

const WINDOWS_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const WINDOWS_NPM = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

describe('resolving a spawnable npm', () => {
  it('leaves npm alone off Windows', () => {
    // Everywhere else `npm` is a script `execFile` can launch, and rewriting it
    // would swap a working command for a guess about the install layout.
    const resolved = resolveNpmCommand('linux', '/usr/bin/node', () => true);

    expect(resolved).toEqual({ command: 'npm', args: [] });
  });

  it('runs npm through Node on Windows', () => {
    const resolved = resolveNpmCommand('win32', WINDOWS_NODE, (path) => path === WINDOWS_NPM);

    expect(resolved.command).toBe(WINDOWS_NODE);
    expect(resolved.args).toEqual([WINDOWS_NPM]);
  });

  it('finds npm under a Unix-style prefix too', () => {
    // `join` normalises the `bin/../lib` hop away, so the candidate this has to
    // match is the resolved path, not the literal one written here.
    const prefixed = join('C:', 'tools', 'node', 'bin', 'node.exe');
    const cli = join('C:', 'tools', 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const resolved = resolveNpmCommand('win32', prefixed, (path) => path === cli);

    expect(resolved.args).toEqual([cli]);
  });

  it('falls back to plain npm rather than throwing when nothing is found', () => {
    // A missing entry point must not fail the run. The check then reports that
    // it could not start, which is honest and recoverable.
    const resolved = resolveNpmCommand('win32', WINDOWS_NODE, () => false);

    expect(resolved).toEqual({ command: 'npm', args: [] });
  });

  it('resolves to something that exists on this machine', () => {
    // The only assertion here that touches reality. On Windows it must find a
    // real entry point, or validation is inert and the run reports
    // `unverified` no matter what the agent did.
    const resolved = resolveNpmCommand();

    if (process.platform === 'win32') {
      expect(resolved.command).toBe(process.execPath);
      expect(resolved.args).toHaveLength(1);
    } else {
      expect(resolved.command).toBe('npm');
    }
  });
});

describe('derived validation commands are spawnable', () => {
  it('places the resolved arguments before "run <script>"', () => {
    const commands = commandsFromPackageScripts(
      { test: 'node test.mjs', build: 'tsc' },
      { command: WINDOWS_NODE, args: [WINDOWS_NPM] },
    );

    expect(commands.tests).toEqual({
      command: WINDOWS_NODE,
      args: [WINDOWS_NPM, 'run', 'test'],
    });
    expect(commands.build?.args).toEqual([WINDOWS_NPM, 'run', 'build']);
  });

  it('still accepts a plain package manager name', () => {
    // The existing callers pass a string, and must keep working unchanged.
    const commands = commandsFromPackageScripts({ test: 'vitest' }, 'pnpm');

    expect(commands.tests).toEqual({ command: 'pnpm', args: ['run', 'test'] });
  });

  it('defaults to npm when nothing is given', () => {
    expect(commandsFromPackageScripts({ test: 'vitest' }).tests).toEqual({
      command: 'npm',
      args: ['run', 'test'],
    });
  });
});
