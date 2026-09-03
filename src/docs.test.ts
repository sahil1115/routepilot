/**
 * Documentation guards.
 *
 * Documentation rots more quietly than code: a broken link or a stale claim
 * fails nothing, so nobody notices until a reader is misled. These are the
 * claims worth failing a build over.
 *
 * Deliberately **not** here: prose style, heading structure, spelling. Those are
 * matters of judgement and a test that enforced them would be a nuisance rather
 * than a guard.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ADAPTER_VERIFICATION } from './adapters/verification.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every markdown file in the project, excluding build output and dependencies. */
async function markdownFiles(dir: string = root): Promise<string[]> {
  const skip = new Set(['node_modules', 'dist', 'coverage', '.git', 'out']);
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith('.md')) found.push(path);
  }

  return found;
}

const REQUIRED_DOCS = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/ROADMAP.md',
  'docs/CONFIGURATION.md',
  'docs/INTEGRATIONS.md',
  'docs/CLAUDE_CODE.md',
  'docs/CURSOR.md',
  'docs/ESCALATION.md',
  'docs/LEARNING.md',
  'docs/EVALUATION.md',
  'docs/PRIVACY.md',
  'docs/SECURITY.md',
  'docs/DEVELOPMENT.md',
];

describe('every documented file exists', () => {
  it.each(REQUIRED_DOCS)('%s', async (relativePath) => {
    const contents = await readFile(join(root, relativePath), 'utf8');
    expect(contents.length).toBeGreaterThan(200);
  });
});

describe('internal links resolve', () => {
  it('every relative markdown link points at a file that exists', async () => {
    // A broken link is the most common way documentation lies, and the easiest
    // to check.
    const files = await markdownFiles();
    expect(files.length).toBeGreaterThan(10);

    const pattern = /\[[^\]]+\]\(([^)#]+?)(?:#[^)]*)?\)/g;
    const broken: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      for (const match of contents.matchAll(pattern)) {
        const href = match[1]?.trim();
        if (href === undefined) continue;
        if (/^(https?:|mailto:)/.test(href)) continue;

        const target = normalize(resolve(dirname(file), href));
        const exists = await readFile(target).then(
          () => true,
          () => false,
        );
        if (!exists) broken.push(`${relative(root, file)} -> ${href}`);
      }
    }

    expect(broken).toEqual([]);
  });
});

describe('the documentation does not overclaim', () => {
  it('says somewhere prominent that no adapter is verified', async () => {
    // The single most important caveat in the project. If an adapter is ever
    // genuinely verified this test should be updated deliberately, not deleted
    // because it became inconvenient.
    const unverified = ADAPTER_VERIFICATION.filter(
      (entry) => entry.adapterId !== 'fake' && entry.status !== 'verified',
    );
    expect(unverified.length).toBeGreaterThan(0);

    const readme = await readFile(join(root, 'README.md'), 'utf8');
    expect(readme).toMatch(/no agent adapter has been verified/i);
  });

  it('does not describe the VS Code extension as verified in VS Code', async () => {
    const extension = await readFile(join(root, 'docs', 'EXTENSION.md'), 'utf8');
    expect(extension).toMatch(/never been run in VS Code|Never run inside/i);
  });

  it('names the unenforced budget scopes wherever budgets are described', async () => {
    // A reader who configures a monthly budget and believes it binds is worse
    // off than one who was never offered the setting.
    for (const doc of ['docs/CONFIGURATION.md', 'docs/SECURITY.md', 'README.md']) {
      const contents = await readFile(join(root, doc), 'utf8');
      expect(contents).toMatch(/not enforced|NOT enforced/);
    }
  });

  it('gives every document a limitations section', async () => {
    // The project rule: a limitation that is written down is a known
    // constraint; one that is not is a future bug.
    for (const doc of REQUIRED_DOCS) {
      if (doc === 'docs/ROADMAP.md') continue; // a status table, not a guide
      const contents = await readFile(join(root, doc), 'utf8');
      expect(contents.toLowerCase()).toMatch(/limitation|not (yet )?(built|done|implemented)/);
    }
  });
});

describe('phase 24 behaviour is documented where it changed', () => {
  it('ESCALATION.md states that escalation never lowers the bar', async () => {
    const contents = await readFile(join(root, 'docs', 'ESCALATION.md'), 'utf8');
    expect(contents).toMatch(/never lowers?\s+the bar/i);
    expect(contents).toContain('maxTotalCost');
  });

  it('CONFIGURATION.md documents the execution-time limits and the override flag', async () => {
    const contents = await readFile(join(root, 'docs', 'CONFIGURATION.md'), 'utf8');
    expect(contents).toContain('maxExecutionTimeMs');
    expect(contents).toContain('--allow-over-budget');
    // A reader who configures `ask` must not expect an interactive prompt.
    expect(contents).toMatch(/no interactive prompt/i);
  });
});
