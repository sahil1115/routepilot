import { describe, expect, it } from 'vitest';

import { AVAILABILITY_STATES, isSelectable } from './common.js';
import {
  FAILURE_TYPES,
  MODEL_ATTRIBUTABLE_FAILURE_TYPES,
  isFailureType,
  isModelAttributable,
} from './failure.js';
import { MODEL_CAPABILITY_KEYS, MODEL_TIERS, SKILL_DIMENSIONS } from './model.js';
import { TASK_TYPES, isTaskType } from './task.js';

describe('availability', () => {
  it('treats degraded as selectable and unavailable as not', () => {
    // Degraded is a scoring penalty for the routing engine, not a hard
    // exclusion — a slow provider is still better than no provider.
    expect(isSelectable('available')).toBe(true);
    expect(isSelectable('degraded')).toBe(true);
    expect(isSelectable('unavailable')).toBe(false);
  });

  it('has no duplicate states', () => {
    expect(new Set(AVAILABILITY_STATES).size).toBe(AVAILABILITY_STATES.length);
  });
});

describe('failure taxonomy', () => {
  it('covers every classification the spec requires (section 22)', () => {
    for (const required of [
      'MODEL_WEAKNESS',
      'MISSING_CONTEXT',
      'BAD_SPECIFICATION',
      'USER_AMBIGUITY',
      'REPOSITORY_PROBLEM',
      'ENVIRONMENT_FAILURE',
      'PROVIDER_FAILURE',
      'TOOL_FAILURE',
      'FLAKY_TEST',
      'TIMEOUT',
      'CONTEXT_LIMIT',
      'BUDGET_EXCEEDED',
      'USER_CANCELLED',
      'UNKNOWN',
    ]) {
      expect(FAILURE_TYPES).toContain(required);
    }
  });

  it('attributes only MODEL_WEAKNESS to the model', () => {
    // This is the invariant that keeps learning honest. A database being down,
    // a provider outage, a flaky test or a user pressing cancel says nothing
    // about whether a model is capable (spec sections 22 and 38).
    expect(isModelAttributable('MODEL_WEAKNESS')).toBe(true);

    for (const failure of FAILURE_TYPES) {
      if (failure === 'MODEL_WEAKNESS') continue;
      expect(isModelAttributable(failure), `${failure} must not blame the model`).toBe(false);
    }
  });

  it.each([
    'ENVIRONMENT_FAILURE',
    'PROVIDER_FAILURE',
    'FLAKY_TEST',
    'USER_CANCELLED',
    'BUDGET_EXCEEDED',
    'USER_AMBIGUITY',
  ] as const)('never attributes %s to the model', (failure) => {
    expect(MODEL_ATTRIBUTABLE_FAILURE_TYPES.has(failure)).toBe(false);
  });

  it('recognises its own members and rejects anything else', () => {
    expect(isFailureType('TIMEOUT')).toBe(true);
    expect(isFailureType('model_weakness')).toBe(false);
    expect(isFailureType('NOT_A_FAILURE')).toBe(false);
  });

  it('has no duplicate types', () => {
    expect(new Set(FAILURE_TYPES).size).toBe(FAILURE_TYPES.length);
  });
});

describe('task vocabulary', () => {
  it('covers the categories the spec requires (section 9)', () => {
    for (const required of [
      'explanation',
      'documentation',
      'autocomplete',
      'simple-edit',
      'rename',
      'formatting',
      'test-generation',
      'bug-fix',
      'debugging',
      'feature-implementation',
      'refactoring',
      'multi-file-refactoring',
      'architecture',
      'migration',
      'performance-optimization',
      'security',
      'investigation',
      'unknown',
    ]) {
      expect(TASK_TYPES).toContain(required);
    }
  });

  it('recognises its own members and rejects anything else', () => {
    expect(isTaskType('debugging')).toBe(true);
    expect(isTaskType('Debugging')).toBe(false);
    expect(isTaskType('brew-coffee')).toBe(false);
  });

  it('has no duplicate types', () => {
    expect(new Set(TASK_TYPES).size).toBe(TASK_TYPES.length);
  });
});

describe('model vocabulary', () => {
  it('orders tiers from cheapest to most capable', () => {
    expect(MODEL_TIERS).toEqual(['cheap', 'medium', 'frontier', 'ultra']);
  });

  it('covers the graded capability dimensions the spec requires (section 8)', () => {
    for (const required of [
      'codeGeneration',
      'codeEditing',
      'debugging',
      'refactoring',
      'architecture',
      'reasoning',
      'testGeneration',
      'documentation',
      'multiFileReasoning',
    ]) {
      expect(SKILL_DIMENSIONS).toContain(required);
    }
  });

  it('keeps hard capabilities separate from graded skills', () => {
    // A boolean fact about a model (can it call tools) must never be conflated
    // with a judgement about quality (how good is it at debugging).
    const overlap = MODEL_CAPABILITY_KEYS.filter((key) =>
      (SKILL_DIMENSIONS as readonly string[]).includes(key),
    );
    expect(overlap).toEqual([]);
  });

  it('has no duplicates in either vocabulary', () => {
    expect(new Set(MODEL_TIERS).size).toBe(MODEL_TIERS.length);
    expect(new Set(SKILL_DIMENSIONS).size).toBe(SKILL_DIMENSIONS.length);
    expect(new Set(MODEL_CAPABILITY_KEYS).size).toBe(MODEL_CAPABILITY_KEYS.length);
  });
});
