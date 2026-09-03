/**
 * Architectural guard: the core must stay provider-neutral.
 *
 * Spec section 2 makes this non-negotiable, and section 7 forbids hard-coding
 * model names. A rule nobody enforces is a rule that erodes, so it is a test.
 * If this fails, the fix is to move the vendor-specific detail into
 * configuration or an adapter — not to add a term to the allow-list.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const coreDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(coreDir, '..');

/** Vendor, product and model names that must not appear in the core. */
const FORBIDDEN_TERMS = [
  'anthropic',
  'openai',
  'claude',
  'haiku',
  'sonnet',
  'opus',
  'fable',
  'mythos',
  'gpt-',
  'gemini',
  'llama',
  'mistral',
  'cohere',
  'ollama',
  'cursor',
  'copilot',
  'bedrock',
  'vertex',
];

/** Whether `target` sits inside `root`. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..';
}

async function collectFiles(dir: string, filter: (path: string) => boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full, filter)));
    } else if (filter(full)) {
      files.push(full);
    }
  }

  return files;
}

const isSource = (path: string): boolean =>
  path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts');

describe('core is provider-neutral', () => {
  it('names no vendor, product or model anywhere under src/core', async () => {
    const files = await collectFiles(coreDir, isSource);
    expect(files.length).toBeGreaterThan(0);

    const offences: string[] = [];

    for (const file of files) {
      const contents = (await readFile(file, 'utf8')).toLowerCase();
      for (const term of FORBIDDEN_TERMS) {
        if (contents.includes(term)) {
          offences.push(`${relative(srcDir, file)} contains "${term}"`);
        }
      }
    }

    expect(offences).toEqual([]);
  });

  it('does not import outward from core into any dependent layer', async () => {
    // Resolved rather than pattern-matched. A regex over the specifier cannot
    // tell `../learning/` in `core/routing/` (which stays inside core) from
    // `../../learning/` in the same file (which would not), and guessing wrong
    // in either direction makes the guard worse than useless.
    const files = await collectFiles(coreDir, isSource);
    expect(files.length).toBeGreaterThan(0);

    const relativeImport = /from\s+['"](\.[^'"]*)['"]/g;
    const offences: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      for (const match of contents.matchAll(relativeImport)) {
        const specifier = match[1];
        if (specifier === undefined) continue;

        const target = resolve(dirname(file), specifier);
        if (!isInside(coreDir, target)) {
          offences.push(`${relative(srcDir, file)} imports ${specifier}`);
        }
      }
    }

    expect(offences).toEqual([]);
  });
});
