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
  it('names which adapters are still unverified, rather than implying all are', async () => {
    // This guard used to assert the README said *no* adapter was verified. On
    // 2026-09-03 the Claude Code adapter ran against a real model, so the claim
    // changed -- deliberately, and only after a machine-written report existed.
    // What it must never do is round "one of three" up to "verified".
    const unverified = ADAPTER_VERIFICATION.filter(
      (entry) => entry.adapterId !== 'fake' && entry.status !== 'verified',
    );
    expect(unverified.length).toBeGreaterThan(0);

    const readme = await readFile(join(root, 'README.md'), 'utf8');
    for (const entry of unverified) {
      expect(readme.toLowerCase()).toContain(entry.adapterId.split('-')[0]);
    }
    expect(readme).toMatch(/unverified/i);
  });

  it('records how the VS Code extension was verified, and against which version', async () => {
    // This guard used to assert the opposite -- that the docs still said the
    // extension had never been run in VS Code. Phase 26 ran it in a real host,
    // so the guard now holds the replacement claim to the same standard: a
    // version and a way to reproduce it, not an adjective.
    const extension = await readFile(join(root, 'docs', 'EXTENSION.md'), 'utf8');
    // `[\s>]` rather than `\s`: the claim wraps across a markdown
    // blockquote, so a `>` sits between the words.
    expect(extension).toMatch(/real VS Code extension[\s>]+host/i);
    expect(extension).toMatch(/VS Code 1\.\d+/);
    expect(extension).toContain('npm run verify:vscode');
  });

  it('records how the verified adapter was verified, with a date and a version', async () => {
    // Evidence, not an adjective -- the same standard the extension claim is
    // held to. `adapters.test.ts` already requires the evidence object; this
    // requires the README to say what it was.
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    expect(readme).toMatch(/2\.1\.72|Claude Haiku 4\.5/);
    expect(readme).toMatch(/\d{4}-\d{2}-\d{2}/);
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

describe('the adapter docs and the verification table cannot drift apart', () => {
  // They did. v0.3.0 flipped `claude-code` to `verified` and left
  // `docs/CLAUDE_CODE.md` saying "Execution has never been run" -- the code and
  // the page a user actually reads disagreeing about the one claim this project
  // is most careful about. Nothing caught it, because every guard here checked
  // wording rather than agreement.
  const PAGES: Readonly<Record<string, string>> = {
    'claude-code': 'docs/CLAUDE_CODE.md',
    'cursor-cli': 'docs/CURSOR.md',
  };

  it.each(Object.entries(PAGES))('%s agrees with its page', async (adapterId, page) => {
    const entry = ADAPTER_VERIFICATION.find((candidate) => candidate.adapterId === adapterId);
    expect(entry, `no verification entry for ${adapterId}`).toBeDefined();

    const contents = (await readFile(join(root, page), 'utf8')).toLowerCase();
    const claimsUnrun = /execution has never been run|status:\s*\*\*unverified/.test(contents);

    if (entry?.status === 'verified') {
      expect(claimsUnrun, `${page} still says execution has never been run`).toBe(false);
      // A verified adapter must show the version it was verified against, so
      // the claim stays checkable rather than becoming an adjective.
      expect(
        entry?.evidence?.toolVersion,
        'a verified adapter must record a version',
      ).toBeDefined();
      expect(contents).toContain((entry?.evidence?.toolVersion ?? '').toLowerCase());
    } else {
      expect(claimsUnrun, `${page} should say execution is unverified`).toBe(true);
    }
  });

  it('records that tool permission is still unaddressed for Claude Code', async () => {
    // The limitation most likely to matter for a real coding task, and the one
    // that lived only in a source comment until Phase 25.
    const contents = await readFile(join(root, 'docs', 'CLAUDE_CODE.md'), 'utf8');
    expect(contents).toMatch(/permission-mode/);
    expect(contents).toMatch(/cannot prompt/i);
  });
});
