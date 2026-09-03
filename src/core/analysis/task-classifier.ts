/**
 * Task classifier (spec section 9).
 *
 * Explicitly **not** keyword matching alone. Keywords are one signal among
 * several: the active file, the referenced files, the repository's working-tree
 * state and its diagnostics all shift the classification. A prompt saying "fix
 * this" means something different in a clean repository with no diagnostics than
 * it does in one with fourteen compiler errors.
 *
 * Scoring is deterministic and every point is attributable to a named rule, so
 * a classification can be explained rather than merely asserted (spec section
 * 50). There is no model here on purpose — spec section 36 puts learning in a
 * later stage, and an interpretable baseline is what a learned classifier will
 * later have to beat.
 */

import type { Diagnostic } from '../ports.js';
import type {
  ClassificationSignal,
  ScoredTaskType,
  TaskClassification,
  TaskHazard,
  TaskScope,
} from '../types/features.js';
import { TASK_TYPES, type TaskType } from '../types/task.js';
import { detectLanguage, isTestPath } from './languages.js';

/** Everything the classifier is allowed to look at. */
export interface ClassificationInput {
  /** The user's task, verbatim. */
  readonly prompt: string;
  /** Workspace-relative path of the file the user is working in. */
  readonly activeFile?: string | undefined;
  /** Files the user referenced explicitly. */
  readonly referencedFiles?: readonly string[] | undefined;
  /** Files currently modified in the working tree. */
  readonly changedFiles?: readonly string[] | undefined;
  /** Diagnostics currently reported for the workspace. */
  readonly diagnostics?: readonly Diagnostic[] | undefined;
  /** Primary language of the repository. */
  readonly primaryLanguage?: string | undefined;
  /** Total files in the repository, when known. */
  readonly repositoryFileCount?: number | undefined;
}

/** A keyword rule: patterns that support a task type. */
interface KeywordRule {
  readonly id: string;
  readonly taskType: TaskType;
  readonly weight: number;
  readonly patterns: readonly RegExp[];
}

/**
 * Keyword evidence.
 *
 * Weights are relative, not probabilities. Distinctive verbs ("refactor",
 * "migrate") weigh more than generic ones ("update"), because a generic verb
 * genuinely carries less information about intent.
 */
const KEYWORD_RULES: readonly KeywordRule[] = [
  {
    id: 'kw.explanation',
    taskType: 'explanation',
    weight: 3,
    patterns: [
      /\b(explain|what does|how does|why does|walk me through|understand|describe)\b/i,
      /\bwhat is\b/i,
    ],
  },
  {
    id: 'kw.documentation',
    taskType: 'documentation',
    weight: 3,
    patterns: [/\b(document\w*|docstring\w*|jsdoc|readme|changelog|comments?)\b/i],
  },
  {
    id: 'kw.rename',
    taskType: 'rename',
    weight: 4,
    patterns: [/\brename\b/i, /\brename .* to\b/i],
  },
  {
    id: 'kw.formatting',
    taskType: 'formatting',
    weight: 4,
    patterns: [/\b(format|reformat|prettier|indent|lint fix|style fix|whitespace)\b/i],
  },
  {
    id: 'kw.test-generation',
    taskType: 'test-generation',
    weight: 3.5,
    patterns: [
      /\b(write|add|generate|create)\b.{0,24}\b(test|tests|spec|coverage)\b/i,
      /\bunit test/i,
    ],
  },
  {
    id: 'kw.bug-fix',
    taskType: 'bug-fix',
    weight: 3,
    patterns: [/\b(fix|bug|broken|crash|error|exception|fails?|failing|regression)\b/i],
  },
  {
    id: 'kw.debugging',
    taskType: 'debugging',
    weight: 3.5,
    patterns: [
      /\b(debug|diagnose|root cause|why is .* failing|trace|reproduce|investigate the (bug|crash|failure))\b/i,
      /\b(race condition|deadlock|memory leak|flaky)\b/i,
    ],
  },
  {
    id: 'kw.feature-implementation',
    taskType: 'feature-implementation',
    weight: 3,
    patterns: [
      /\b(implement|add support for|introduce)\b/i,
      /\b(new (feature|endpoint|command|page|component))\b/i,
    ],
  },
  {
    // "add a X" is genuinely weak evidence: it is equally consistent with
    // adding a test, a doc section or a feature. It is weighted below the
    // contextual signals so that the file being edited decides which.
    id: 'kw.feature-implementation.weak',
    taskType: 'feature-implementation',
    weight: 1.5,
    patterns: [/\b(build|create|add) (a|an|the|new)\b/i],
  },
  {
    id: 'kw.refactoring',
    taskType: 'refactoring',
    weight: 4,
    patterns: [/\b(refactor|restructure|clean up|tidy|simplify|extract|decouple|deduplicate)\b/i],
  },
  {
    id: 'kw.architecture',
    taskType: 'architecture',
    weight: 4,
    patterns: [
      /\b(architect|architecture|design (the|a) system|redesign|rearchitect|module boundaries)\b/i,
    ],
  },
  {
    id: 'kw.migration',
    taskType: 'migration',
    weight: 4.5,
    patterns: [/\b(migrate|migration|upgrade .* to|port .* to|convert .* to|switch from .* to)\b/i],
  },
  {
    id: 'kw.performance-optimization',
    taskType: 'performance-optimization',
    weight: 4,
    patterns: [/\b(optimi[sz]e|performance|slow|speed up|latency|throughput|bottleneck|profil)/i],
  },
  {
    id: 'kw.security',
    taskType: 'security',
    weight: 4.5,
    patterns: [/\b(security|vulnerab|exploit|injection|xss|csrf|sanitiz)\w*/i, /\bcve-\d/i],
  },
  {
    // Naming a security-adjacent *subject* is weaker evidence than naming a
    // security *task*. "Refactor the authentication module" is a refactor of
    // auth code; "audit authentication for vulnerabilities" is security work.
    id: 'kw.security.subject',
    taskType: 'security',
    weight: 2,
    patterns: [/\b(authenticat|authoriz|permission|credential|secret|token)\w*/i],
  },
  {
    id: 'kw.investigation',
    taskType: 'investigation',
    weight: 3,
    patterns: [/\b(investigate|look into|find out|audit|survey|where is|search for|figure out)\b/i],
  },
  {
    id: 'kw.autocomplete',
    taskType: 'autocomplete',
    weight: 3,
    patterns: [/\b(complete|finish (this|the) (line|function|block)|autocomplete)\b/i],
  },
  {
    id: 'kw.simple-edit',
    taskType: 'simple-edit',
    weight: 2,
    patterns: [/\b(change|update|tweak|adjust|set|replace)\b/i],
  },
];

/** Phrases indicating the task spans the whole repository. */
const REPOSITORY_WIDE_PATTERNS: readonly RegExp[] = [
  /\b(across|throughout) the (entire |whole |full |complete )?(repo|repository|codebase|project|app|application|system)\b/i,
  /\b(every|all) (file|module|package|component|service)s?\b/i,
  /\b(codebase|repo|repository)-wide\b/i,
  /\beverywhere\b/i,
];

/** Phrases indicating several files are involved. */
const MULTI_FILE_PATTERNS: readonly RegExp[] = [
  /\b(multiple|several|various|many) (file|module|place|component)s?\b/i,
  /\b(and|plus) (also )?(update|change|fix)\b/i,
];

/** Phrases that raise the reasoning requirement. */
const REASONING_PATTERNS: readonly RegExp[] = [
  /\b(why|root cause|trade-?off|design|architect|concurren|distributed|race|deadlock|invariant|proof|algorithm|complexity)\w*/i,
  /\b(decide|evaluate|compare|analyz|reason)\w*/i,
];

/**
 * Phrases that make a task risky regardless of its type.
 *
 * Each carries a named {@link TaskHazard} rather than a prose label. The
 * exploration gate in Phase 13 refuses to experiment on a destructive or
 * production task, and it needs to match on the hazard itself -- a risk score
 * cannot distinguish "deletes a table" from "merely a large repository".
 */
const RISK_PATTERNS: readonly (readonly [RegExp, number, TaskHazard])[] = [
  [/\b(production|prod\b|live system)/i, 0.3, 'production'],
  // Bare "migrate" is deliberately absent here: the migration task type already
  // carries a high base risk, and counting it twice saturated the score at 1.0
  // for ordinary migrations, leaving no headroom for genuinely dangerous ones.
  [/\b(schema change|alter table|drop (table|column))\w*/i, 0.25, 'data-migration'],
  [/\b(delete|remove|drop|purge|wipe|truncate)\b/i, 0.2, 'destructive'],
  [/\b(auth|authenticat|authoriz|permission|credential|secret|token)\w*/i, 0.2, 'credentials'],
  [/\b(payment|billing|invoice|charge|transaction)\w*/i, 0.2, 'payments'],
  [/\b(security|vulnerab|exploit)\w*/i, 0.2, 'security'],
];

/** Task types that inherently demand more reasoning. */
const REASONING_BY_TASK: Partial<Record<TaskType, number>> = {
  architecture: 0.95,
  debugging: 0.8,
  migration: 0.8,
  security: 0.8,
  'performance-optimization': 0.75,
  'multi-file-refactoring': 0.7,
  investigation: 0.65,
  refactoring: 0.55,
  'feature-implementation': 0.5,
  'bug-fix': 0.5,
  'test-generation': 0.35,
  explanation: 0.3,
  documentation: 0.2,
  'simple-edit': 0.15,
  rename: 0.1,
  formatting: 0.05,
  autocomplete: 0.1,
  unknown: 0.5,
};

/** Baseline risk by task type. */
const RISK_BY_TASK: Partial<Record<TaskType, number>> = {
  migration: 0.7,
  architecture: 0.6,
  security: 0.6,
  'multi-file-refactoring': 0.5,
  'performance-optimization': 0.4,
  refactoring: 0.35,
  'feature-implementation': 0.3,
  debugging: 0.25,
  'bug-fix': 0.25,
  'test-generation': 0.15,
  'simple-edit': 0.1,
  rename: 0.15,
  investigation: 0.05,
  explanation: 0.0,
  documentation: 0.05,
  formatting: 0.05,
  autocomplete: 0.05,
  unknown: 0.3,
};

/** Classifies a task from the prompt and its surrounding context. */
export class TaskClassifier {
  /** Classify a task. Always returns an answer; `unknown` when evidence is absent. */
  classify(input: ClassificationInput): TaskClassification {
    const signals: ClassificationSignal[] = [];
    const scores = new Map<TaskType, number>();

    const add = (taskType: TaskType, weight: number, rule: string, reason: string): void => {
      if (weight <= 0) return;
      scores.set(taskType, (scores.get(taskType) ?? 0) + weight);
      signals.push({ rule, taskType, weight, reason });
    };

    this.#applyKeywordRules(input.prompt, add);
    this.#applyContextRules(input, add);

    const ranked = rank(scores);
    const top = ranked[0];
    const totalScore = [...scores.values()].reduce((sum, value) => sum + value, 0);

    const scope = this.#estimateScope(input, top?.taskType ?? 'unknown');
    const taskType = promoteForScope(top?.taskType ?? 'unknown', scope);

    const confidence = computeConfidence(ranked, totalScore);
    const ambiguity = computeAmbiguity(ranked, totalScore, input.prompt);

    return {
      taskType,
      confidence,
      ambiguity,
      alternatives: ranked.slice(1, 4),
      signals,
      scope,
      reasoningRequirement: this.#reasoningRequirement(input.prompt, taskType),
      ...this.#risk(input, taskType, scope),
    };
  }

  #applyKeywordRules(
    prompt: string,
    add: (t: TaskType, w: number, rule: string, reason: string) => void,
  ): void {
    for (const rule of KEYWORD_RULES) {
      const matched = rule.patterns.find((pattern) => pattern.test(prompt));
      if (matched !== undefined) {
        add(rule.taskType, rule.weight, rule.id, `prompt matches ${String(matched)}`);
      }
    }
  }

  /**
   * Evidence from everything other than the prompt's words.
   *
   * This is what separates the classifier from keyword matching.
   */
  #applyContextRules(
    input: ClassificationInput,
    add: (t: TaskType, w: number, rule: string, reason: string) => void,
  ): void {
    const errorCount = (input.diagnostics ?? []).filter((d) => d.severity === 'error').length;
    if (errorCount > 0) {
      // Live compiler errors make "fix this" mean bug-fix, not simple-edit.
      const weight = Math.min(3, 1 + errorCount * 0.25);
      add(
        'bug-fix',
        weight,
        'ctx.diagnostics',
        `${String(errorCount)} error diagnostic(s) reported`,
      );
      if (errorCount >= 5) {
        add(
          'debugging',
          1.5,
          'ctx.diagnostics.many',
          `${String(errorCount)} errors suggest a systemic problem`,
        );
      }
    }

    if (input.activeFile !== undefined) {
      if (isTestPath(input.activeFile)) {
        add(
          'test-generation',
          2.5,
          'ctx.active-file.test',
          `active file "${input.activeFile}" is a test`,
        );
      }
      const language = detectLanguage(input.activeFile);
      if (language === 'markdown') {
        add(
          'documentation',
          2.5,
          'ctx.active-file.markdown',
          `active file "${input.activeFile}" is documentation`,
        );
      }
    }

    const referenced = input.referencedFiles ?? [];
    if (referenced.length >= 3) {
      add(
        'multi-file-refactoring',
        1.5,
        'ctx.referenced-files',
        `${String(referenced.length)} files referenced explicitly`,
      );
    }

    const changed = input.changedFiles ?? [];
    if (changed.length >= 10) {
      add(
        'multi-file-refactoring',
        1,
        'ctx.changed-files',
        `${String(changed.length)} files already modified in the working tree`,
      );
    }
  }

  #estimateScope(input: ClassificationInput, taskType: TaskType): TaskScope {
    if (REPOSITORY_WIDE_PATTERNS.some((p) => p.test(input.prompt))) return 'repository-wide';

    const referenced = input.referencedFiles?.length ?? 0;
    if (referenced >= 5) return 'many-files';
    if (referenced >= 2) return 'few-files';

    if (MULTI_FILE_PATTERNS.some((p) => p.test(input.prompt))) return 'few-files';

    if (taskType === 'architecture' || taskType === 'migration') return 'repository-wide';
    if (taskType === 'multi-file-refactoring') return 'many-files';
    if (taskType === 'explanation' || taskType === 'documentation') {
      return referenced === 1 || input.activeFile !== undefined ? 'single-file' : 'few-files';
    }
    if (taskType === 'rename') {
      // A rename is one edit conceptually but touches its call sites. Without
      // an explicit "across the repository", assume it is contained — treating
      // every rename as repository-scale would push trivial work to expensive
      // models, which is precisely what RoutePilot exists to prevent.
      return 'few-files';
    }

    return referenced === 1 || input.activeFile !== undefined ? 'single-file' : 'few-files';
  }

  #reasoningRequirement(prompt: string, taskType: TaskType): number {
    const base = REASONING_BY_TASK[taskType] ?? 0.5;
    const matches = REASONING_PATTERNS.filter((p) => p.test(prompt)).length;
    return clamp(base + matches * 0.1);
  }

  /**
   * Task risk, together with the named hazards that produced it.
   *
   * Both are returned from one pass so they cannot disagree: a hazard is
   * present in the list exactly when it contributed to the score.
   */
  #risk(
    input: ClassificationInput,
    taskType: TaskType,
    scope: TaskScope,
  ): { risk: number; hazards: TaskHazard[] } {
    let risk = RISK_BY_TASK[taskType] ?? 0.3;
    const hazards: TaskHazard[] = [];

    for (const [pattern, increment, hazard] of RISK_PATTERNS) {
      if (!pattern.test(input.prompt)) continue;
      risk += increment;
      hazards.push(hazard);
    }

    if (scope === 'repository-wide') risk += 0.15;
    else if (scope === 'many-files') risk += 0.08;

    // A repository with no version control cannot be rolled back easily.
    if (input.changedFiles !== undefined && input.changedFiles.length > 20) risk += 0.05;

    return { risk: clamp(risk), hazards };
  }
}

/** Promote a task type when the scope makes it a bigger job than its name suggests. */
function promoteForScope(taskType: TaskType, scope: TaskScope): TaskType {
  if (taskType === 'refactoring' && (scope === 'many-files' || scope === 'repository-wide')) {
    return 'multi-file-refactoring';
  }
  return taskType;
}

function rank(scores: ReadonlyMap<TaskType, number>): ScoredTaskType[] {
  return [...scores.entries()]
    .map(([taskType, score]) => ({ taskType, score }))
    .sort((a, b) => b.score - a.score || a.taskType.localeCompare(b.taskType));
}

/**
 * Accumulated weight at which more evidence stops adding confidence.
 *
 * Roughly "one strong, distinctive keyword plus corroboration".
 */
const EVIDENCE_SATURATION = 5;

/**
 * Confidence in [0, 1].
 *
 * Two things must hold before a classification deserves confidence: the winner
 * has to be clearly ahead of the runner-up, *and* there has to be enough
 * evidence to be worth trusting at all.
 *
 * The obvious formula — the winner's share of total evidence — is actively
 * wrong. It scores a two-word prompt matching one weak keyword at 1.0, while a
 * detailed prompt that fired several rules scores lower for having supplied
 * more information. Evidence strength is what separates those two cases.
 */
function computeConfidence(ranked: readonly ScoredTaskType[], _total: number): number {
  const top = ranked[0];
  if (top === undefined || top.score <= 0) return 0;

  const second = ranked[1];
  const margin = second === undefined ? 1 : clamp((top.score - second.score) / top.score);
  const evidenceStrength = clamp(top.score / EVIDENCE_SATURATION);

  return clamp(evidenceStrength * (0.5 + 0.5 * margin));
}

/**
 * Ambiguity in [0, 1].
 *
 * High when the top two candidates are close, and high when there is barely any
 * evidence at all — a two-word prompt is ambiguous even if one keyword matched.
 */
function computeAmbiguity(
  ranked: readonly ScoredTaskType[],
  total: number,
  prompt: string,
): number {
  if (ranked.length === 0) return 1;

  const top = ranked[0];
  const second = ranked[1];
  if (top === undefined) return 1;

  const closeness = second === undefined ? 0 : clamp(second.score / top.score);
  const evidenceThinness = clamp(1 - total / 8);
  const brevity = clamp(1 - prompt.trim().split(/\s+/).length / 12);

  return clamp(0.5 * closeness + 0.3 * evidenceThinness + 0.2 * brevity);
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Exposed for tests that assert the vocabulary stays in sync. */
export const CLASSIFIABLE_TASK_TYPES: readonly TaskType[] = TASK_TYPES;
