/**
 * Adapter verification status (spec section 2, rule 20).
 *
 * "Do not claim an integration works until it has actually been tested."
 *
 * A promise to be careful is not a mechanism. This file is the mechanism: an
 * adapter's status is data, it starts at `unverified`, and it can only become
 * `verified` by attaching **evidence** of a real run — a date, the version of
 * the tool exercised, and a note describing what was actually executed. A test
 * enforces that pairing, so `verified` cannot be set by optimism alone.
 *
 * Passing mock tests does not make an adapter verified. Mocks prove the
 * adapter handles the shapes it was told to expect; only a real run proves
 * those shapes are the ones the tool actually emits.
 */

/** How much is actually known about an adapter working. */
export const VERIFICATION_STATUSES = ['verified', 'unverified', 'unavailable'] as const;

/**
 * How much is actually known about an adapter working.
 *
 * - `verified` — a real execution against the real tool has been observed and
 *   recorded in {@link AdapterVerification.evidence}.
 * - `unverified` — implemented and covered by mock tests, but never run
 *   against the real tool. **Not the same as working.**
 * - `unavailable` — the tool is not installed here, so it cannot be verified
 *   on this machine at all.
 */
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Proof that an adapter really ran. */
export interface VerificationEvidence {
  /** ISO date of the run. */
  readonly date: string;
  /** Version of the external tool that was exercised. */
  readonly toolVersion: string;
  /** What was actually executed, in enough detail to repeat it. */
  readonly note: string;
}

/** What is known about one adapter. */
export interface AdapterVerification {
  readonly adapterId: string;
  readonly status: VerificationStatus;
  /** What the adapter is built against — the documented surface it uses. */
  readonly mechanism: string;
  /** Exact command a user can run to verify it. */
  readonly howToVerify: string;
  /** Required when, and only when, status is `verified`. */
  readonly evidence?: VerificationEvidence | undefined;
  /** Anything a user should know before relying on it. */
  readonly limitations: readonly string[];
}

/**
 * The verification table.
 *
 * `claude-code` is verified: on 2026-09-03 it executed a real task against
 * Claude Haiku 4.5 through Claude Code 2.1.72 and returned `completed`. That is
 * the first and so far only adapter to have run against a real model.
 *
 * The others are not. `cursor-cli` cannot be verified here because the tool is
 * not installed, and `direct-provider` has never been given a credential. Both
 * are implemented against documented surfaces and covered by tests that drive
 * real child processes — which proves they handle the shapes they were told to
 * expect, not that those are the shapes the tools emit.
 */
export const ADAPTER_VERIFICATION: readonly AdapterVerification[] = [
  {
    adapterId: 'claude-code',
    status: 'verified',
    mechanism:
      'Wraps the documented `claude` CLI in non-interactive print mode: ' +
      '`claude -p <prompt> --output-format stream-json --verbose --model <id>`. ' +
      'No interception, no modification of Claude Code internals (spec section 18).',
    howToVerify:
      'In a normal terminal (not inside a Claude Code session), run: ' +
      'npm run verify:adapters -- claude-code',
    evidence: {
      date: '2026-09-03',
      toolVersion: '2.1.72',
      note:
        'Ran a trivial task end to end against Claude Haiku 4.5 ' +
        '(claude-haiku-4-5-20251001) on Windows, Node 22.18.0. Result: completed in ' +
        '3352 ms, no failure type, usage reported as 10 input / 40 output / 0 cached ' +
        'tokens. Observed event kinds in order: assistant-message, assistant-message, ' +
        'assistant-message, completed. Recorded from the machine-written report at ' +
        '.routepilot/adapter-verification-claude-code.json, not from a transcript.',
    },
    limitations: [
      'CONFIRMED against the real tool: availability detection, version parsing, ' +
        'process spawning, the stream-json event schema, event normalisation through to a ' +
        'terminal `completed`, and usage reporting.',
      'NOT CONFIRMED: cancellation, timeout behaviour, failure classification from real ' +
        'errors, and any task that requires tool use. The verification prompt is ' +
        'deliberately trivial and forbids tools, so it exercises the transport and the ' +
        'event schema rather than the agent doing real work.',
      'Tool permission is unaddressed: the adapter passes no `permissionMode`, and in ' +
        'print mode Claude Code cannot prompt. A task that needs to edit files may ' +
        'therefore still fail, and that has not been tried.',
      'Claude Code refuses to run nested inside another Claude Code session, so execution ' +
        'cannot be verified from an agent session — it must be run from a plain terminal.',
      'The argument list is built from flags read from `claude --help` on version 2.1.72: ' +
        '--print, --output-format stream-json, --verbose, --model, --session-id.',
      'Transparent interception of Claude Code traffic is NOT implemented and is not ' +
        'claimed. This is a wrapper.',
    ],
  },
  {
    adapterId: 'cursor-cli',
    status: 'unavailable',
    mechanism:
      'Wraps the documented `cursor-agent` CLI: ' +
      '`cursor-agent --print --output-format stream-json --model <id>` (spec section 19). ' +
      'No undocumented traffic interception, no modification of the Cursor installation.',
    howToVerify:
      'Install the Cursor CLI (`cursor-agent`), then run: ' +
      'npm run verify:adapters -- cursor-cli',
    limitations: [
      '`cursor-agent` is not installed on this machine, so nothing about this adapter has ' +
        'been confirmed against the real tool — not even availability detection.',
      'The event schema is built from the shapes named in the specification. It has not ' +
        'been confirmed against real output, so both snake_case and camelCase key styles ' +
        'are accepted and unrecognised events are ignored.',
      'The Cursor editor launcher (`cursor`) is a different program and cannot be used ' +
        'here; the adapter says so in its setup error.',
    ],
  },
  {
    adapterId: 'direct-provider',
    status: 'unverified',
    mechanism:
      'Generic HTTP transport with configurable endpoint, auth, timeout and retry ' +
      '(spec section 20). Request and response encoding is supplied per provider by a ' +
      'ProviderProtocol, so no vendor API shape is assumed.',
    howToVerify:
      'Supply a concrete ProviderProtocol and credentials, then run: ' +
      'npm run verify:adapters -- direct-provider',
    limitations: [
      'No concrete provider protocol ships yet. The transport, retry, timeout, ' +
        'cancellation and credential redaction are implemented and tested; the ' +
        'request/response mapping for any specific provider is not, because inventing ' +
        'one would be guessing at an API.',
    ],
  },
  {
    adapterId: 'fake',
    status: 'verified',
    mechanism: 'In-process scriptable adapter used for deterministic testing.',
    howToVerify: 'Covered by the adapter contract suite; it has no external dependency.',
    evidence: {
      date: '2026-09-01',
      toolVersion: 'in-process',
      note:
        'Exercised by the shared adapter contract suite and by end-to-end CLI tests. ' +
        'It has no external tool to be wrong about — it IS the implementation under test.',
    },
    limitations: ['Not a real agent. For testing only; never routes real work.'],
  },
];

/** Look up what is known about an adapter. */
export function verificationFor(adapterId: string): AdapterVerification | undefined {
  return ADAPTER_VERIFICATION.find((entry) => entry.adapterId === adapterId);
}

/**
 * Whether an adapter may be described as supported.
 *
 * Used by the CLI so that user-facing text cannot overstate what is known.
 */
export function isSupported(adapterId: string): boolean {
  const entry = verificationFor(adapterId);
  return entry?.status === 'verified' && entry.evidence !== undefined;
}

/** One-line summary suitable for a status table. */
export function describeVerification(entry: AdapterVerification): string {
  switch (entry.status) {
    case 'verified':
      return `verified ${entry.evidence?.date ?? ''} against ${entry.evidence?.toolVersion ?? 'unknown'}`.trim();
    case 'unavailable':
      return 'tool not installed here — never run';
    case 'unverified':
    default:
      return 'implemented, never run against the real tool';
  }
}
