/**
 * Resolving the Cursor CLI on Windows.
 *
 * Measured against a real install on 2026-09-03 (Cursor CLI
 * 2026.09.02-c22c1a3): spawning `cursor-agent.cmd` with `shell: false` returns
 * `EINVAL`, while `node.exe index.js` returns the version. The adapter's
 * default was therefore unusable on Windows, and nothing caught it because
 * every test drove a stub process by an explicit path.
 *
 * The filesystem is injected, so these run identically on every platform.
 */

import { describe, expect, it } from 'vitest';

import { resolveCursorCommand, type ResolveOptions } from './windows-shim.js';

const LOCAL = 'C:\\Users\\dev\\AppData\\Local';
const VERSIONS = `${LOCAL}\\cursor-agent\\versions`;

/** A Windows machine with the given version directories installed. */
function windows(versions: readonly string[], files: readonly string[] = []): ResolveOptions {
  const present = new Set<string>([
    ...(versions.length > 0 ? [VERSIONS] : []),
    ...versions.flatMap((version) => [
      `${VERSIONS}\\${version}\\node.exe`,
      `${VERSIONS}\\${version}\\index.js`,
    ]),
    ...files,
  ]);

  return {
    platform: 'win32',
    localAppData: LOCAL,
    exists: (path) => present.has(path),
    list: () => versions,
  };
}

describe('on Windows, the default resolves to the binary the shim wraps', () => {
  it('rewrites `cursor-agent` to node.exe plus index.js', () => {
    const resolved = resolveCursorCommand('cursor-agent', [], windows(['2026.09.02-c22c1a3']));

    expect(resolved.via).toBe('windows-shim');
    expect(resolved.command).toBe(`${VERSIONS}\\2026.09.02-c22c1a3\\node.exe`);
    expect(resolved.commandArgs).toEqual([`${VERSIONS}\\2026.09.02-c22c1a3\\index.js`]);
  });

  it('picks the newest version, deterministically', () => {
    // Cursor's directories are dated, so a lexicographic sort is chronological.
    // Deterministic matters more than clever: two runs must choose the same
    // one, and the order `readdir` returns is not guaranteed.
    const resolved = resolveCursorCommand(
      'cursor-agent',
      [],
      windows(['2026.08.01-aaa', '2026.09.02-c22c1a3', '2026.07.15-zzz']),
    );

    expect(resolved.command).toContain('2026.09.02-c22c1a3');
  });

  it('skips a version directory that is missing either file', () => {
    // A half-written or partially removed install must not be selected: it
    // would fail at spawn time with a worse message than "not found".
    const broken: ResolveOptions = {
      platform: 'win32',
      localAppData: LOCAL,
      list: () => ['2026.09.02-broken', '2026.08.01-good'],
      exists: (path) =>
        path === VERSIONS ||
        path.startsWith(`${VERSIONS}\\2026.08.01-good\\`) ||
        path === `${VERSIONS}\\2026.09.02-broken\\node.exe`,
    };

    expect(resolveCursorCommand('cursor-agent', [], broken).command).toContain('2026.08.01-good');
  });
});

describe('it leaves everything else alone', () => {
  it('does not touch a command the caller named explicitly', () => {
    // An explicit path is a decision, not a hint. Silently redirecting it would
    // make a user's own choice unobservable.
    const resolved = resolveCursorCommand(
      'D:\\tools\\cursor-agent.exe',
      [],
      windows(['2026.09.02-c22c1a3']),
    );

    expect(resolved.via).toBe('path');
    expect(resolved.command).toBe('D:\\tools\\cursor-agent.exe');
  });

  it('does not touch the default when the caller supplied leading arguments', () => {
    const resolved = resolveCursorCommand('cursor-agent', ['--flag'], windows(['2026.09.02-x']));

    expect(resolved.via).toBe('path');
    expect(resolved.commandArgs).toEqual(['--flag']);
  });

  it('leaves non-Windows platforms untouched', () => {
    // Every other platform ships a real executable, so PATH is correct there
    // and second-guessing it would be a regression.
    const resolved = resolveCursorCommand('cursor-agent', [], {
      platform: 'linux',
      localAppData: LOCAL,
      exists: () => true,
      list: () => ['2026.09.02-c22c1a3'],
    });

    expect(resolved.via).toBe('path');
    expect(resolved.command).toBe('cursor-agent');
  });

  it('falls back to the plain command when Cursor is not installed', () => {
    // The resulting "not found" message is the right outcome: the adapter
    // reports it with setup guidance rather than resolving to nothing.
    const resolved = resolveCursorCommand('cursor-agent', [], windows([]));

    expect(resolved.via).toBe('path');
    expect(resolved.command).toBe('cursor-agent');
  });

  it('falls back when LOCALAPPDATA is unset', () => {
    const resolved = resolveCursorCommand('cursor-agent', [], {
      platform: 'win32',
      localAppData: '',
      exists: () => true,
      list: () => ['2026.09.02-x'],
    });

    expect(resolved.via).toBe('path');
  });

  it('survives a filesystem that throws', () => {
    // A locked or vanished directory is not a reason to fail construction.
    const resolved = resolveCursorCommand('cursor-agent', [], {
      platform: 'win32',
      localAppData: LOCAL,
      exists: () => {
        throw new Error('EPERM');
      },
    });

    expect(resolved.via).toBe('path');
  });
});
