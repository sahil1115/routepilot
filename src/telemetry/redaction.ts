/**
 * Privacy redaction (spec sections 33 and 34).
 *
 * Everything written to the telemetry store passes through here first.
 *
 * The design assumption is that redaction *will* be needed — error messages
 * echo request headers, stack traces embed connection strings, and shell output
 * prints environment variables. So this is not a last line of defence; it is
 * the normal path, applied at the single point where data crosses into
 * persistence, so no caller has to remember.
 *
 * Two layers:
 *
 * 1. **Structural.** Whole categories are simply never stored: source code,
 *    full model responses, absolute paths, `.env` contents. Fields that could
 *    carry them are not written at all rather than written-then-scrubbed.
 * 2. **Textual.** What is stored — short summaries, error messages — is scrubbed
 *    for credential shapes.
 *
 * Redaction is lossy on purpose. When in doubt, drop it: a missing telemetry
 * field costs a little learning signal, a leaked key costs far more.
 */

/** Credential-shaped patterns, replaced wherever they appear. */
const SECRET_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  // Provider API keys.
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, label: 'ANTHROPIC_KEY' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, label: 'API_KEY' },
  { pattern: /\bAIza[A-Za-z0-9_-]{20,}/g, label: 'GOOGLE_KEY' },
  // Source-host tokens.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, label: 'GITHUB_TOKEN' },
  { pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g, label: 'GITLAB_TOKEN' },
  // Cloud credentials.
  { pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, label: 'AWS_KEY_ID' },
  // Bearer tokens and JWTs.
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, label: 'BEARER_TOKEN' },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, label: 'JWT' },
  // Private key blocks.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: 'PRIVATE_KEY',
  },
  // Connection strings with inline credentials.
  { pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi, label: 'CONNECTION_STRING' },
];

/**
 * `KEY=value` assignments where the key looks secret.
 *
 * Handled separately because only the *value* is replaced — keeping the key
 * name makes the record useful without exposing anything.
 */
const ASSIGNMENT_PATTERN =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE)[A-Za-z0-9_]*)\s*[=:]\s*(['"]?)([^\s'"]{4,})\2/gi;

/**
 * Absolute paths, which leak a user's directory layout and username.
 *
 * These turn up inside error text, not just in path fields — a stack trace or a
 * compiler message routinely embeds one. Replacing the whole path with its
 * basename keeps the useful part (which file) and drops the rest.
 *
 * Windows drive paths are matched first, because a `C:/...` path also satisfies
 * the POSIX pattern once the drive letter is consumed.
 */
const ABSOLUTE_PATH_PATTERNS: readonly RegExp[] = [
  /\b[A-Za-z]:[\\/](?:[^\s"'<>|]*[\\/])*[^\s"'<>|,;)]*/g,
  /(?<![\w.~])\/(?:[\w.@+-]+\/){2,}[\w.@+-]*/g,
];

/** The marker written in place of a removed secret. */
export const REDACTED = '[REDACTED]';

/** Maximum characters kept from any stored text. */
const MAX_TEXT = 500;

/**
 * Scrub credential shapes from text.
 *
 * Applied to every string that reaches the store.
 */
export function redact(text: string): string {
  let output = text;

  for (const { pattern, label } of SECRET_PATTERNS) {
    output = output.replace(pattern, `${REDACTED}:${label}`);
  }

  output = output.replace(ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=${REDACTED}`);
  output = stripAbsolutePaths(output);

  return output;
}

/**
 * Replace absolute paths with just their final segment.
 *
 * `/home/someone/app/src/a.ts` becomes `…/a.ts`. Which file it was stays
 * useful; where that user keeps their files does not need recording.
 */
export function stripAbsolutePaths(text: string): string {
  let output = text;
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    output = output.replace(pattern, (match) => {
      const normalised = match.replace(/\\/g, '/');
      const basename = normalised.slice(normalised.lastIndexOf('/') + 1);
      return basename === '' ? '…' : `…/${basename}`;
    });
  }
  return output;
}

/** Scrub and truncate, for a field that will be stored. */
export function redactSummary(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const scrubbed = redact(text).trim();
  if (scrubbed === '') return null;
  return scrubbed.length <= MAX_TEXT ? scrubbed : `${scrubbed.slice(0, MAX_TEXT)}…`;
}

/**
 * Make a path safe to store.
 *
 * Absolute paths leak the user's directory layout and username, so only
 * workspace-relative paths are kept. An absolute path is reduced to its
 * basename rather than dropped, because the file *name* is useful for
 * understanding churn and reveals little.
 */
export function redactPath(path: string, workspaceRoot?: string): string {
  const normalised = path.replace(/\\/g, '/');

  if (workspaceRoot !== undefined) {
    const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalised.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      return normalised.slice(root.length + 1);
    }
  }

  if (isAbsolute(normalised)) {
    return normalised.slice(normalised.lastIndexOf('/') + 1);
  }

  return normalised;
}

/**
 * A stable, non-reversible identifier for a value.
 *
 * Used where records must be *correlated* without the value being *stored* —
 * grouping outcomes by repository, for instance, without recording where that
 * repository lives on disk.
 *
 * FNV-1a: not a security primitive, and not used as one. It defends against
 * casual disclosure of a local path, not against a determined attacker with the
 * candidate set.
 */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Whether a string still looks like it contains a secret.
 *
 * Used by tests to assert nothing leaked, and available as a caller-side check.
 */
export function containsLikelySecret(text: string): boolean {
  const withoutMarkers = text.split(REDACTED).join('');
  return SECRET_PATTERNS.some(({ pattern }) => {
    // The patterns are global, so `lastIndex` must not leak between calls.
    const probe = new RegExp(pattern.source, pattern.flags.replace('g', ''));
    return probe.test(withoutMarkers);
  });
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}
