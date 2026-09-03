/**
 * Configuration errors (spec section 47).
 *
 * Invalid configuration must produce an actionable error: what is wrong, where,
 * and what a valid value looks like. A stack trace pointing into a validation
 * library is not actionable.
 */

/** One problem found in a configuration document. */
export interface ConfigurationIssue {
  /** Dotted path to the offending value, for example `models[2].pricing.inputPerMillion`. */
  readonly path: string;
  /** What is wrong. */
  readonly message: string;
  /** How to fix it, when a concrete fix can be named. */
  readonly hint?: string;
}

/** Thrown when configuration cannot be loaded or is invalid. */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';

  /** Every problem found, not just the first. */
  readonly issues: readonly ConfigurationIssue[];

  /** Path of the configuration file, when the error came from a file. */
  readonly source: string | undefined;

  constructor(summary: string, issues: readonly ConfigurationIssue[] = [], source?: string) {
    super(formatMessage(summary, issues, source));
    this.issues = issues;
    this.source = source;
  }
}

function formatMessage(
  summary: string,
  issues: readonly ConfigurationIssue[],
  source: string | undefined,
): string {
  const lines: string[] = [source === undefined ? summary : `${summary} (${source})`];

  for (const issue of issues) {
    const location = issue.path === '' ? '(root)' : issue.path;
    lines.push(`  - ${location}: ${issue.message}`);
    if (issue.hint !== undefined) {
      lines.push(`    hint: ${issue.hint}`);
    }
  }

  return lines.join('\n');
}
