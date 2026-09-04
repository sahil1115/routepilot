/**
 * Failure classification (spec section 22).
 *
 * The most consequential judgement in RoutePilot. Escalation reads it to decide
 * whether a stronger model would help or whether more context, a retry or a
 * question is the answer (section 26); learning reads it to decide whether an
 * outcome says anything about a model at all (sections 22 and 38).
 *
 * Two rules. Environmental causes win: checks run in order of how conclusively
 * they explain the failure, so a test that failed because the database was
 * unreachable is `ENVIRONMENT_FAILURE` and the enquiry stops. And
 * `MODEL_WEAKNESS` requires positive evidence and is never a default -- it is
 * the only classification that updates beliefs about a model, so it must be
 * earned by repeated model-caused failures, edit churn, or validation the
 * model's own changes broke. Anything unexplained is `UNKNOWN`.
 */

import type { FailureType } from '../types/failure.js';
import { isModelAttributable } from '../types/failure.js';
import type {
  ClassificationEvidence,
  ExecutionSignals,
  FailureClassification,
} from '../types/execution.js';

/** Text patterns that identify a cause. Matched against error and check output. */
interface PatternRule {
  readonly failureType: FailureType;
  readonly rule: string;
  readonly reason: string;
  readonly patterns: readonly RegExp[];
}

/**
 * Context-limit signatures.
 *
 * Checked before anything else textual: a context overflow often surfaces
 * *as* a provider error, and misreading it as a provider outage would trigger
 * a pointless retry on the same oversized request.
 */
const CONTEXT_PATTERNS: readonly RegExp[] = [
  /context[ _-]?(length|window|limit)/i,
  /(maximum|max)[ _-]?(context|tokens)/i,
  /too many tokens/i,
  /prompt is too long/i,
  /exceeds? the (context|token) limit/i,
  /context_length_exceeded/i,
  /input length and `max_tokens` exceed/i,
];

/**
 * Environment signatures.
 *
 * Deliberately broad. Misclassifying an environment failure as model weakness
 * corrupts learning permanently; misclassifying the reverse merely costs one
 * missed escalation.
 */
const ENVIRONMENT_PATTERNS: readonly RegExp[] = [
  /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EADDRINUSE|EACCES|EPERM|ENOSPC|EMFILE/,
  /connection (refused|reset|failed)/i,
  /could not connect|unable to connect|cannot connect/i,
  /(database|postgres|mysql|redis|mongo)\w*.{0,40}(unavailable|not running|refused|down)/i,
  /permission denied/i,
  /command not found|is not recognized as an internal or external command/i,
  /no such file or directory.{0,40}(node|python|java|go|cargo|docker)/i,
  /docker (daemon|desktop).{0,30}(not running|unavailable)/i,
  /out of memory|heap out of memory|OOM/i,
  /no space left on device/i,
  /network is unreachable|dns lookup failed/i,
  /could not start "/i,
];

/** Provider-side signatures. */
const PROVIDER_PATTERNS: readonly RegExp[] = [
  /\b(429|500|502|503|504)\b/,
  /rate[ _-]?limit/i,
  /overloaded|capacity|server error|service unavailable|bad gateway/i,
  /upstream (error|timeout)/i,
  /provider responded/i,
  /api (error|failure)/i,
  /authentication (failed|error)|invalid api key|unauthorized|401|403/i,
];

/** Signatures that the repository itself is broken, independent of the run. */
const REPOSITORY_PATTERNS: readonly RegExp[] = [
  /cannot find module '(?!\.)/i,
  /unmet peer dependency|dependency resolution failed/i,
  /merge conflict|<<<<<<< HEAD/,
  /corrupt(ed)? (repository|index|lockfile)/i,
];

/**
 * Signatures of a *run* exceeding its time limit.
 *
 * Deliberately narrow. A bare "timeout" appears in ordinary test output and
 * must not be mistaken for the run itself being cut short.
 */
const RUN_TIMEOUT_PATTERNS: readonly RegExp[] = [
  /did not finish within/i,
  /(run|execution|session|request) timed out/i,
  /exceeded (the )?(time|execution) limit/i,
  /ETIMEDOUT/,
];

/** Signatures of a flaky, rather than genuinely failing, test. */
const FLAKY_PATTERNS: readonly RegExp[] = [
  /flaky|intermittent/i,
  /timeout of \d+ ?ms exceeded/i,
  /test (timed out|timeout)/i,
  /retry(ing)? (the )?test/i,
];

const PATTERN_RULES: readonly PatternRule[] = [
  {
    failureType: 'ENVIRONMENT_FAILURE',
    rule: 'text.environment',
    reason: 'the error names an environment or infrastructure problem',
    patterns: ENVIRONMENT_PATTERNS,
  },
  {
    failureType: 'PROVIDER_FAILURE',
    rule: 'text.provider',
    reason: 'the error names a provider-side problem',
    patterns: PROVIDER_PATTERNS,
  },
  {
    failureType: 'REPOSITORY_PROBLEM',
    rule: 'text.repository',
    reason: 'the error names a pre-existing repository problem',
    patterns: REPOSITORY_PATTERNS,
  },
];

/** Options for {@link FailureClassifier}. */
export interface FailureClassifierOptions {
  /** Ambiguity at or above which a failure is attributed to an unclear request. */
  readonly ambiguityThreshold?: number | undefined;
  /** Consecutive tool failures needed before model weakness is considered. */
  readonly modelWeaknessToolFailures?: number | undefined;
  /** Edits to one file needed before churn counts as evidence. */
  readonly modelWeaknessEditChurn?: number | undefined;
}

const DEFAULTS = {
  ambiguityThreshold: 0.7,
  modelWeaknessToolFailures: 3,
  modelWeaknessEditChurn: 4,
};

/**
 * Options with every default applied.
 *
 * Declared explicitly rather than as `Required<FailureClassifierOptions>`,
 * because the option fields carry an explicit `| undefined` that `Required`
 * does not strip.
 */
interface ResolvedOptions {
  readonly ambiguityThreshold: number;
  readonly modelWeaknessToolFailures: number;
  readonly modelWeaknessEditChurn: number;
}

/** Classifies why a run failed. */
export class FailureClassifier {
  readonly #options: ResolvedOptions;

  constructor(options: FailureClassifierOptions = {}) {
    this.#options = {
      ambiguityThreshold: options.ambiguityThreshold ?? DEFAULTS.ambiguityThreshold,
      modelWeaknessToolFailures:
        options.modelWeaknessToolFailures ?? DEFAULTS.modelWeaknessToolFailures,
      modelWeaknessEditChurn: options.modelWeaknessEditChurn ?? DEFAULTS.modelWeaknessEditChurn,
    };
  }

  /** Classify a failure from everything observed. */
  classify(evidence: ClassificationEvidence): FailureClassification {
    const { signals } = evidence;
    const text = gatherText(evidence);

    // 1. The user stopped it. Nothing else needs explaining, and this must
    //    never be read as a negative signal about the model (spec section 32).
    if (signals.cancelled || evidence.adapterFailureType === 'USER_CANCELLED') {
      return build('USER_CANCELLED', 1, 'the user cancelled the run', ['signal.cancelled']);
    }

    // 2. Budget. Explicit and unambiguous.
    if (evidence.adapterFailureType === 'BUDGET_EXCEEDED' || /budget/i.test(text)) {
      return build('BUDGET_EXCEEDED', 0.95, 'the run stopped because a budget was exhausted', [
        'signal.budget',
      ]);
    }

    // 3. Context overflow, checked before provider errors because it commonly
    //    arrives dressed as one. Retrying the same oversized request would fail
    //    identically; the answer is compaction or a larger window
    //    (spec section 26).
    if (evidence.adapterFailureType === 'CONTEXT_LIMIT' || matches(text, CONTEXT_PATTERNS)) {
      return build('CONTEXT_LIMIT', 0.9, 'the request exceeded the model context window', [
        'text.context-limit',
      ]);
    }

    // 4. Timeout — but only a *run* timeout.
    //
    //    Matching "timeout" anywhere would misread "Timeout of 5000ms exceeded"
    //    from a single slow unit test as the whole run timing out. Test
    //    frameworks print that constantly, and the two call for opposite
    //    responses: a run timeout means try something faster, a slow test means
    //    look at the test.
    if (evidence.adapterFailureType === 'TIMEOUT' || matches(text, RUN_TIMEOUT_PATTERNS)) {
      return build('TIMEOUT', 0.85, 'the run did not finish within its time limit', [
        'signal.timeout',
      ]);
    }

    // 5. Whatever the adapter already established about environment or
    //    provider trouble is authoritative — it was closer to the failure.
    if (
      evidence.adapterFailureType === 'ENVIRONMENT_FAILURE' ||
      evidence.adapterFailureType === 'PROVIDER_FAILURE'
    ) {
      return build(
        evidence.adapterFailureType,
        0.9,
        evidence.adapterFailureType === 'ENVIRONMENT_FAILURE'
          ? 'the agent could not run in this environment'
          : 'the provider failed to serve the request',
        ['adapter.reported'],
      );
    }

    // 6. Textual signatures, in order of how conclusively they explain things.
    for (const rule of PATTERN_RULES) {
      if (matches(text, rule.patterns)) {
        return build(rule.failureType, 0.8, rule.reason, [rule.rule]);
      }
    }

    // 7. A repository that was already failing validation before the run
    //    cannot have been broken by it.
    if (evidence.repositoryBrokenBeforeRun === true && validationFailed(evidence)) {
      return build(
        'REPOSITORY_PROBLEM',
        0.85,
        'validation was already failing before the run, so the run did not cause it',
        ['signal.pre-existing-failure'],
      );
    }

    // 8. Flaky tests must not trigger escalation (spec section 26).
    if (validationCheckFailed(evidence, 'tests') && matches(text, FLAKY_PATTERNS)) {
      return build('FLAKY_TEST', 0.7, 'the failing test looks flaky rather than broken', [
        'text.flaky',
      ]);
    }

    // 9. An unclear request is the user's to resolve, not a stronger model's.
    if (
      evidence.taskAmbiguity !== undefined &&
      evidence.taskAmbiguity >= this.#options.ambiguityThreshold
    ) {
      return build(
        'USER_AMBIGUITY',
        0.65,
        `the task was highly ambiguous (${percent(evidence.taskAmbiguity)}), so the request itself is the likeliest problem`,
        ['signal.ambiguity'],
      );
    }

    // 10. Model weakness — only with positive evidence.
    const weakness = this.#modelWeaknessEvidence(signals, evidence);
    if (weakness.length > 0) {
      return build(
        'MODEL_WEAKNESS',
        weakness.length >= 2 ? 0.75 : 0.6,
        `the model repeatedly failed to make progress: ${weakness.map((w) => w.reason).join('; ')}`,
        weakness.map((w) => w.rule),
      );
    }

    // 11. A tool failed and nothing above explains why.
    if (signals.toolFailures > 0 || signals.terminalFailures > 0) {
      return build(
        'TOOL_FAILURE',
        0.5,
        'a tool or command failed, with no clearer cause identified',
        ['signal.tool-failure'],
      );
    }

    // 12. Validation failed but nothing indicates why.
    if (validationFailed(evidence)) {
      return build('UNKNOWN', 0.4, 'validation failed, but the cause could not be identified', [
        'signal.validation-failed',
      ]);
    }

    // 13. Honestly unknown. Better than a guess that would corrupt learning.
    return build('UNKNOWN', 0.3, 'the run failed for reasons that could not be identified', []);
  }

  /**
   * Positive evidence that the *model* is the problem.
   *
   * Every item here describes the model doing something ineffective, not the
   * world being uncooperative.
   */
  #modelWeaknessEvidence(
    signals: ExecutionSignals,
    evidence: ClassificationEvidence,
  ): { rule: string; reason: string }[] {
    const found: { rule: string; reason: string }[] = [];

    if (signals.maxConsecutiveToolFailures >= this.#options.modelWeaknessToolFailures) {
      found.push({
        rule: 'weakness.consecutive-tool-failures',
        reason: `${String(signals.maxConsecutiveToolFailures)} consecutive tool failures`,
      });
    }

    if (signals.maxEditsToOneFile >= this.#options.modelWeaknessEditChurn) {
      found.push({
        rule: 'weakness.edit-churn',
        reason: `one file rewritten ${String(signals.maxEditsToOneFile)} times`,
      });
    }

    // The run changed code and the change does not build, pass tests or even
    // parse, and the repository was fine beforehand. That is the model's doing.
    //
    // `syntax` was added in Phase 25 alongside post-failure validation: a failed
    // attempt now gets a syntax-only check, and without syntax here that
    // evidence would have had no rule to feed. `changedFiles` is consulted
    // beside `signals.fileChanges` because the two disagree when an agent
    // reports edits it never emitted events for.
    const changed = signals.fileChanges > 0 || (evidence.changedFiles?.length ?? 0) > 0;

    if (
      changed &&
      evidence.repositoryBrokenBeforeRun !== true &&
      (validationCheckFailed(evidence, 'build') ||
        validationCheckFailed(evidence, 'tests') ||
        validationCheckFailed(evidence, 'syntax'))
    ) {
      found.push({
        rule: 'weakness.broke-validation',
        reason: 'the changes it made fail validation that was passing before',
      });
    }

    return found;
  }
}

/** Assemble every piece of text worth pattern-matching. */
function gatherText(evidence: ClassificationEvidence): string {
  const parts: string[] = [];
  if (evidence.adapterErrorSummary !== undefined) parts.push(evidence.adapterErrorSummary);

  for (const result of evidence.validation?.results ?? []) {
    if (result.passed === false) {
      parts.push(result.summary);
      if (result.output !== undefined) parts.push(result.output);
    }
  }

  return parts.join('\n');
}

function validationFailed(evidence: ClassificationEvidence): boolean {
  return evidence.validation?.results.some((result) => result.passed === false) === true;
}

function validationCheckFailed(
  evidence: ClassificationEvidence,
  check: 'build' | 'tests' | 'lint' | 'syntax' | 'diagnostics',
): boolean {
  return (
    evidence.validation?.results.some(
      (result) => result.check === check && result.passed === false,
    ) === true
  );
}

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function build(
  failureType: FailureType,
  confidence: number,
  reason: string,
  signals: readonly string[],
): FailureClassification {
  return {
    failureType,
    confidence,
    reason,
    signals,
    modelAttributable: isModelAttributable(failureType),
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}
