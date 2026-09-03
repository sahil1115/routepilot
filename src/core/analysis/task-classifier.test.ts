import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../ports.js';
import { TaskClassifier } from './task-classifier.js';

const classifier = new TaskClassifier();

const classify = (prompt: string, extra: Record<string, unknown> = {}) =>
  classifier.classify({ prompt, ...extra });

describe('TaskClassifier — prompt evidence', () => {
  it.each([
    ['explain how the auth middleware works', 'explanation'],
    ['write docstrings for the parser module', 'documentation'],
    ['rename getUserData to fetchUserProfile', 'rename'],
    ['reformat this file with prettier', 'formatting'],
    ['add unit tests for the calculator', 'test-generation'],
    ['fix the crash when the config file is missing', 'bug-fix'],
    ['debug why the worker pool deadlocks under load', 'debugging'],
    ['implement a new /health endpoint', 'feature-implementation'],
    ['migrate the codebase from webpack to vite', 'migration'],
    ['optimise the slow database query in the report page', 'performance-optimization'],
    ['audit the login flow for SQL injection vulnerabilities', 'security'],
    ['investigate where the retry logic lives', 'investigation'],
  ])('classifies %j as %s', (prompt, expected) => {
    expect(classify(prompt).taskType).toBe(expected);
  });

  it('returns unknown rather than guessing when there is no evidence', () => {
    const result = classify('hmm');

    expect(result.taskType).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.ambiguity).toBeGreaterThan(0.8);
  });
});

describe('TaskClassifier — is not keyword matching alone', () => {
  it('reads live diagnostics as evidence of a bug fix', () => {
    // The same prompt, classified differently because of repository state.
    const withoutDiagnostics = classify('sort this out');

    const errors: Diagnostic[] = Array.from({ length: 3 }, (_, i) => ({
      path: `src/a${String(i)}.ts`,
      severity: 'error' as const,
      message: 'type error',
    }));
    const withDiagnostics = classify('sort this out', { diagnostics: errors });

    expect(withoutDiagnostics.taskType).toBe('unknown');
    expect(withDiagnostics.taskType).toBe('bug-fix');
    expect(withDiagnostics.signals.map((s) => s.rule)).toContain('ctx.diagnostics');
  });

  it('treats many simultaneous errors as a systemic problem', () => {
    const errors: Diagnostic[] = Array.from({ length: 8 }, (_, i) => ({
      path: `src/a${String(i)}.ts`,
      severity: 'error' as const,
      message: 'boom',
    }));

    const result = classify('what is going on here', { diagnostics: errors });

    expect(result.signals.map((s) => s.rule)).toContain('ctx.diagnostics.many');
  });

  it('ignores warnings when deciding this is a bug fix', () => {
    const warnings: Diagnostic[] = [
      { path: 'src/a.ts', severity: 'warning', message: 'unused' },
      { path: 'src/b.ts', severity: 'warning', message: 'unused' },
    ];

    expect(
      classify('tidy this', { diagnostics: warnings }).signals.map((s) => s.rule),
    ).not.toContain('ctx.diagnostics');
  });

  it('uses the active file to bias towards test generation', () => {
    const result = classify('add a case for the empty input', {
      activeFile: 'src/parser.test.ts',
    });

    expect(result.taskType).toBe('test-generation');
    expect(result.signals.map((s) => s.rule)).toContain('ctx.active-file.test');
  });

  it('uses a markdown active file to bias towards documentation', () => {
    const result = classify('add a section about configuration', { activeFile: 'docs/setup.md' });

    expect(result.taskType).toBe('documentation');
  });

  it('uses referenced-file count as evidence of a multi-file change', () => {
    const result = classify('update these', {
      referencedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
    });

    expect(result.signals.map((s) => s.rule)).toContain('ctx.referenced-files');
  });

  it('uses a large working tree as evidence of a multi-file change', () => {
    const changedFiles = Array.from({ length: 14 }, (_, i) => `src/f${String(i)}.ts`);

    const result = classify('keep going', { changedFiles });

    expect(result.signals.map((s) => s.rule)).toContain('ctx.changed-files');
  });
});

describe('TaskClassifier — scope', () => {
  it('detects repository-wide phrasing', () => {
    expect(classify('rename the User type across the repository').scope).toBe('repository-wide');
    expect(classify('update the license header in every file').scope).toBe('repository-wide');
  });

  it('scales scope with the number of referenced files', () => {
    expect(classify('update this', { referencedFiles: ['a.ts'] }).scope).toBe('single-file');
    expect(classify('update this', { referencedFiles: ['a.ts', 'b.ts'] }).scope).toBe('few-files');
    expect(
      classify('update this', {
        referencedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      }).scope,
    ).toBe('many-files');
  });

  it('treats architecture and migration as repository-wide by nature', () => {
    expect(classify('rearchitect the plugin system').scope).toBe('repository-wide');
    expect(classify('migrate from moment to date-fns').scope).toBe('repository-wide');
  });

  it('promotes a wide refactor to multi-file-refactoring', () => {
    const narrow = classify('refactor this function', { referencedFiles: ['a.ts'] });
    const wide = classify('refactor the auth layer across the codebase');

    expect(narrow.taskType).toBe('refactoring');
    expect(wide.taskType).toBe('multi-file-refactoring');
  });

  it('treats a contained rename as a few-file job, not a repository-scale one', () => {
    expect(classify('rename getUser to loadUser').scope).toBe('few-files');
  });

  it('still widens a rename that says it is repository-wide', () => {
    expect(classify('rename getUser to loadUser across the repository').scope).toBe(
      'repository-wide',
    );
  });

  it('reads a security subject as weaker evidence than a security task', () => {
    // "Refactor the auth module" is a refactor; "audit auth for vulnerabilities"
    // is security work. Conflating them routes ordinary refactors as if they
    // were security audits.
    expect(classify('refactor the authentication module').taskType).toBe('refactoring');
    expect(classify('audit the authentication flow for vulnerabilities').taskType).toBe('security');
  });
});

describe('TaskClassifier — confidence and ambiguity', () => {
  it('is more confident about a specific prompt than a vague one', () => {
    const specific = classify('migrate the build from webpack to vite across the repository');
    const vague = classify('change it');

    expect(specific.confidence).toBeGreaterThan(vague.confidence);
    expect(specific.ambiguity).toBeLessThan(vague.ambiguity);
  });

  it('reports high ambiguity when two task types tie', () => {
    // "fix" and "refactor" pull in different directions.
    const result = classify('fix and refactor');

    expect(result.ambiguity).toBeGreaterThan(0.5);
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  it('keeps confidence and ambiguity inside [0, 1] for every fixture prompt', () => {
    const prompts = [
      '',
      'x',
      'fix',
      'refactor the entire codebase and migrate to a new architecture urgently',
      'a'.repeat(5000),
    ];

    for (const prompt of prompts) {
      const result = classify(prompt);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.ambiguity).toBeGreaterThanOrEqual(0);
      expect(result.ambiguity).toBeLessThanOrEqual(1);
    }
  });

  it('ranks alternatives below the winner', () => {
    const result = classify('refactor the code to fix the slow query');

    for (const alternative of result.alternatives) {
      expect(alternative.taskType).not.toBe(result.taskType);
    }
  });
});

describe('TaskClassifier — explainability', () => {
  it('attributes every classification to named rules', () => {
    const result = classify('migrate the auth module to the new session API');

    expect(result.signals.length).toBeGreaterThan(0);
    for (const signal of result.signals) {
      expect(signal.rule).toMatch(/^(kw|ctx)\./);
      expect(signal.reason.length).toBeGreaterThan(0);
      expect(signal.weight).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    const input = {
      prompt: 'refactor the parser and add tests',
      activeFile: 'src/parser.ts',
      referencedFiles: ['src/parser.ts', 'src/lexer.ts'],
    };

    expect(classifier.classify(input)).toEqual(classifier.classify(input));
  });
});

describe('TaskClassifier — reasoning and risk', () => {
  it('demands more reasoning for architecture than for formatting', () => {
    expect(classify('design the new module boundaries').reasoningRequirement).toBeGreaterThan(
      classify('reformat this file').reasoningRequirement,
    );
  });

  it('raises reasoning when the prompt asks why', () => {
    const plain = classify('fix the test');
    const reasoned = classify('fix the test and explain why the race condition happens');

    expect(reasoned.reasoningRequirement).toBeGreaterThan(plain.reasoningRequirement);
  });

  it('scores a production migration as riskier than an explanation', () => {
    const risky = classify('migrate the production database schema');
    const safe = classify('explain what this function does');

    expect(risky.risk).toBeGreaterThan(0.7);
    expect(safe.risk).toBeLessThan(0.2);
  });

  it.each([
    ['drop the legacy users table', 'destructive verb'],
    ['rotate the API credentials', 'auth or secrets'],
    ['fix the billing charge calculation', 'payments'],
  ])('raises risk for %j', (prompt) => {
    expect(classify(prompt).risk).toBeGreaterThan(classify('explain this').risk);
  });

  it('keeps risk and reasoning inside [0, 1] even when every rule fires', () => {
    const result = classify(
      'urgently migrate the production payment authentication schema, delete the old security tables across the entire repository',
    );

    expect(result.risk).toBeLessThanOrEqual(1);
    expect(result.risk).toBeGreaterThan(0.9);
    expect(result.reasoningRequirement).toBeLessThanOrEqual(1);
  });
});

describe('TaskClassifier — risk calibration', () => {
  it('leaves headroom above an ordinary migration for a dangerous one', () => {
    // Risk must discriminate, not saturate. A test-framework migration and a
    // production schema migration are not equally dangerous.
    const ordinary = classify('migrate the entire codebase from vitest to jest');
    const dangerous = classify('migrate the production payment database schema');

    expect(ordinary.risk).toBeGreaterThan(0.5);
    expect(ordinary.risk).toBeLessThan(1);
    expect(dangerous.risk).toBeGreaterThan(ordinary.risk);
  });
});
