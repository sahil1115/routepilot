/**
 * Regression tests for the "absent is not zero" bug in git state.
 *
 * `NodeGit.getState` used to substitute empty output for a *failed* sub-query:
 * `parseNumstat(numstat ?? '')` and `parseStatus(status ?? '')`. A `git status`
 * that timed out therefore produced `changedFiles: []` and `+0/-0`, which is
 * indistinguishable from a repository that was read successfully and found
 * clean. Every consumer downstream — the feature vector, the fingerprint that
 * decides whether a cached analysis may be reused, the CLI — believed it.
 *
 * The project rule is that a check which did not run is `null`, never a zero.
 * These tests hold that line at each layer it crosses.
 */

import { describe, expect, it } from 'vitest';

import type { DirectoryEntry, FileStat, FileSystemPort, GitState } from '../ports.js';

import { computeFingerprint } from './fingerprint.js';

/**
 * The smallest filesystem `computeFingerprint` will accept.
 *
 * It only ever stats manifests, and every one of these tests holds the
 * filesystem constant so that the working-tree component is the sole variable.
 */
class StubFileSystem implements FileSystemPort {
  readDirectory(): Promise<readonly DirectoryEntry[]> {
    return Promise.resolve([]);
  }

  stat(): Promise<FileStat | null> {
    return Promise.resolve(null);
  }

  readFile(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

/** A readable repository with a clean working tree. */
const CLEAN: GitState = {
  isRepository: true,
  branch: 'main',
  headCommit: 'a'.repeat(40),
  changedFiles: [],
  insertions: 0,
  deletions: 0,
};

/** The same repository, except that nothing about the tree could be read. */
const UNREADABLE: GitState = {
  ...CLEAN,
  changedFiles: null,
  insertions: null,
  deletions: null,
};

describe('an unreadable working tree is not a clean one', () => {
  it('fingerprints differently from a clean tree', async () => {
    // The bug that matters most. These two hashing to the same value means an
    // analysis cached while git was readable gets served for a repository
    // whose state is now unknown — silently, and for as long as the cache
    // lives.
    const fs = new StubFileSystem();

    const clean = await computeFingerprint('/repo', CLEAN, fs);
    const unreadable = await computeFingerprint('/repo', UNREADABLE, fs);

    expect(unreadable.workingTree).not.toBe(clean.workingTree);
  });

  it('fingerprints deterministically, so the cache is still usable', async () => {
    // The sentinel must be a constant. Making it unique per call would fix the
    // collision by breaking determinism, which is a worse trade: no decision in
    // RoutePilot is allowed to depend on the clock.
    const fs = new StubFileSystem();

    const first = await computeFingerprint('/repo', UNREADABLE, fs);
    const second = await computeFingerprint('/repo', UNREADABLE, fs);

    expect(second).toEqual(first);
  });

  it('does not collide with a tree that really does contain the sentinel', async () => {
    // The readable branch is tagged too, so a repository containing a file
    // literally named `unreadable` cannot forge the unknown state.
    const fs = new StubFileSystem();

    const forged = await computeFingerprint(
      '/repo',
      { ...CLEAN, changedFiles: [{ path: 'unreadable', change: 'modified' }] },
      fs,
    );
    const unreadable = await computeFingerprint('/repo', UNREADABLE, fs);

    expect(forged.workingTree).not.toBe(unreadable.workingTree);
  });
});

describe('GitState admits the difference at the type level', () => {
  it('allows null for every field git may fail to answer', () => {
    // A compile-time assertion as much as a runtime one: if someone narrows
    // these back to `number`, this file stops compiling, which is the point.
    const unknown: GitState = {
      isRepository: true,
      branch: null,
      headCommit: null,
      changedFiles: null,
      insertions: null,
      deletions: null,
    };

    expect(unknown.changedFiles).toBeNull();
    expect(unknown.insertions).toBeNull();
    expect(unknown.deletions).toBeNull();
  });

  it('still reports zero for a directory that is not a repository', () => {
    // Not every absence is unknown. A plain directory genuinely has no changed
    // files, and reporting that as "unreadable" would be its own overclaim.
    const notARepository: GitState = {
      isRepository: false,
      branch: null,
      headCommit: null,
      changedFiles: [],
      insertions: 0,
      deletions: 0,
    };

    expect(notARepository.changedFiles).toEqual([]);
  });
});
