/**
 * Guards on the bytes of the source itself.
 *
 * These exist because of a real incident. A NUL byte was written into
 * `src/core/analysis/fingerprint.ts` — as part of a string literal intended to
 * read `'\u0000unreadable'`, where the escape was resolved one layer too early
 * by the tooling that wrote the file. TypeScript compiled it. ESLint passed it.
 * Prettier reformatted around it. `grep` reported the file as binary, which was
 * the only signal anything was wrong, and only because someone happened to run
 * `grep` on it.
 *
 * A stray control character is not a style question. It survives review because
 * it is invisible in every editor and diff, it changes program behaviour if it
 * lands inside a literal, and no other check in this project looks for it.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Directories that are generated, vendored, or otherwise not ours to police. */
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git', 'out', '.vscode-test']);

/** Extensions whose bytes this project is responsible for. */
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md'];

async function sourceFiles(dir: string = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(path);
    }
  }

  return found;
}

/**
 * Control characters that must never appear literally in source.
 *
 * Tab, line feed and carriage return are excluded: they are ordinary
 * whitespace and Prettier already governs them. Everything else in the C0
 * range, plus DEL, is either a mistake or an attempt to hide something.
 */
// The control characters below are the subject of the check, not an accident
// in it, so the rule that normally forbids them is the wrong rule here. The
// disable must be the last comment before the code: a directive followed by
// another comment line applies to the comment.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

describe('source files contain no stray control characters', () => {
  it('finds a substantial number of files to check', async () => {
    // A guard on the guard: a walk that silently matched nothing would pass
    // this suite for ever while checking precisely zero bytes.
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no control character in any source file', async () => {
    const files = await sourceFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      const match = FORBIDDEN.exec(contents);
      if (match === null) continue;

      // Report the location, because the character is invisible and searching
      // for it by hand is exactly the problem this test removes.
      const index = match.index;
      const line = contents.slice(0, index).split('\n').length;
      const code = contents.charCodeAt(index).toString(16).padStart(4, '0');
      offenders.push(`${relative(root, file)}:${String(line)} contains U+${code.toUpperCase()}`);
    }

    expect(offenders).toEqual([]);
  });

  it('detects the exact byte that caused the incident', () => {
    // Proves the pattern would have caught the original bug, rather than
    // passing because nothing anywhere is wrong.
    expect(FORBIDDEN.test(`? '${String.fromCharCode(0)}unreadable-working-tree'`)).toBe(true);
    expect(FORBIDDEN.test("? 'unreadable'")).toBe(false);
  });

  it('permits ordinary whitespace and non-ASCII prose', () => {
    // The project's comments use em dashes and typographic punctuation
    // throughout. A rule that banned those would be reverted within a day.
    expect(FORBIDDEN.test('tab\there\nnewline\r\n')).toBe(false);
    expect(FORBIDDEN.test('a decision — not a workaround')).toBe(false);
  });
});
