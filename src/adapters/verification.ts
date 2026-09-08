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

/**
 * What is known about the run loop working end to end.
 *
 * Adapters are verified one at a time, in isolation. That leaves the seams
 * between them unverified: `RegistryExecutor` bridging the task runner to an
 * adapter, validation running against a workspace a real agent just edited, an
 * outcome derived from that, telemetry written from a real run, and learning
 * fed by it. Every component can work while the loop does not.
 *
 * Reuses {@link VerificationStatus} and {@link VerificationEvidence}, and obeys
 * the same rule: `verified` requires evidence, and a test enforces the pairing.
 */
export interface LoopVerification {
  readonly status: VerificationStatus;
  /** What the loop is, in terms of the code that runs it. */
  readonly mechanism: string;
  /** Exact command a user can run to verify it. */
  readonly howToVerify: string;
  /** Required when, and only when, status is `verified`. */
  readonly evidence?: VerificationEvidence | undefined;
  readonly limitations: readonly string[];
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
 * "Verified" means a real task ran end to end. `claude-code` and `cursor-cli`
 * both are, and as of 2026-09-04 both have also been driven through four real
 * coding tasks against a throwaway fixture repository, every assertion made
 * against the filesystem rather than the transcript. Claude Code passes all
 * four only when a permission mode is set; see its limitations.
 *
 * `direct-provider` joined them on 2026-09-06 against the Anthropic Messages
 * API. That verifies the transport and one vendor mapping; every other provider
 * still needs its own `ProviderProtocol`, and none ships.
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
      'CONFIRMED with real work, and this is the substantive result: on 2026-09-04, ' +
        'with `agents.claude-code.permissionMode` set to `acceptEdits`, all four fixture ' +
        'tasks passed against 2.1.72 -- modifying a file and running its test suite, ' +
        'creating a file, declining to fabricate a missing one, and cancelling mid-run. ' +
        'Every assertion observed the filesystem or the process, never the transcript.',
      'CONDITIONAL: that result depends on the permission mode. With none passed, the ' +
        'same suite scores 2/4. Claude Code cannot prompt for tool permission in print ' +
        'mode, so it declines every write -- confirmed by `is_error: true` on each Edit ' +
        'and Bash tool result while Read and Glob succeeded, with the model narrating ' +
        '"the system is asking for permission to edit the file". RoutePilot passes no ' +
        'permission mode by default and will not choose one for a user.',
      'The blocked case USED TO REPORT SUCCESS. Claude Code emits a tidy ' +
        '`subtype: "success"` having been refused throughout, and the adapter relayed ' +
        '`status: completed`. It now reports `failed` / ENVIRONMENT_FAILURE when tool ' +
        'calls were refused and no file changed -- an environment failure, never ' +
        'MODEL_WEAKNESS, because the model was not permitted to try (spec section 22).',
      '`bypassPermissions` also exists and grants everything. It is deliberately not ' +
        'recommended and is not a default; `acceptEdits` is the narrowest mode that ' +
        'lets a coding task do its job.',
      'NOT CONFIRMED: timeout behaviour, and failure classification from real provider ' +
        'errors.',
      'Claude Code refuses to run nested inside another Claude Code session. Clearing ' +
        'CLAUDECODE and CLAUDE_CODE_ENTRYPOINT in the child environment lifts the refusal, ' +
        'which is how the 2026-09-04 run was obtained; a plain terminal needs no workaround.',
      'The argument list is built from flags read from `claude --help` on version 2.1.72: ' +
        '--print, --output-format stream-json, --verbose, --model, --session-id.',
      'Transparent interception of Claude Code traffic is NOT implemented and is not ' +
        'claimed. This is a wrapper.',
    ],
  },
  {
    adapterId: 'cursor-cli',
    status: 'verified',
    mechanism:
      'Wraps the documented `cursor-agent` CLI: ' +
      '`cursor-agent --print --output-format stream-json --model <id>` (spec section 19). ' +
      'No undocumented traffic interception, no modification of the Cursor installation.',
    howToVerify:
      'Install the Cursor CLI (`cursor-agent`), sign in with `cursor-agent login`, then run: ' +
      'npm run verify:adapters -- cursor-cli',
    evidence: {
      date: '2026-09-03',
      toolVersion: '2026.09.02',
      note:
        'Ran real coding tasks end to end against Cursor CLI 2026.09.02 on Windows, ' +
        'Node 22.18.0, with no permission mode passed. Four tasks, each checked by ' +
        'inspecting the workspace afterwards rather than by reading the transcript: ' +
        'fixed a failing test suite so `node test.mjs` passes (60 s, tool-call events ' +
        'observed); created a new file with the requested export (27 s); asked for a ' +
        'non-existent file and did not fabricate it (19 s); cancelled mid-run and ' +
        'reported `cancelled` (3 s). Recorded from the machine-written reports at ' +
        '.routepilot/agent-tasks-cursor-cli.json and adapter-verification-cursor-cli.json.',
    },
    limitations: [
      'CONFIRMED against the real tool: availability detection, version parsing, Windows ' +
        'shim resolution, process spawning, the stream-json event schema, event ' +
        'normalisation through to a terminal `completed`, and workspace-trust handling.',
      'CONFIRMED with real work: file modification, file creation, tool use, running ' +
        'the workspace test suite, and cancellation mid-run. Checked by inspecting the ' +
        'workspace, not by trusting the transcript.',
      'NOT CONFIRMED: usage reporting — the real runs returned no usage at all, so cost ' +
        'for a Cursor run is priced from estimates rather than measurement. Also ' +
        'unconfirmed: timeout behaviour, failure classification from real provider ' +
        'errors, and escalation, which is a runner decision across two models rather ' +
        'than an adapter behaviour.',
      'On Windows the installer provides only `cursor-agent.cmd` and `.ps1`, which ' +
        '`execFile` cannot launch without a shell. The adapter resolves the `node.exe` and ' +
        '`index.js` those wrap; see `windows-shim.ts`. Without that it cannot run on ' +
        'Windows at all.',
      'The adapter passes `--trust`, which trusts the workspace the caller named. It does ' +
        'NOT pass `--force` or `--yolo`, which grant blanket command approval for the ' +
        'whole run; a test asserts they never reach the argument list.',
      'The Cursor editor launcher (`cursor`) is a different program and cannot be used ' +
        'here; the adapter says so in its setup error.',
    ],
  },
  {
    adapterId: 'direct-provider',
    status: 'verified',
    mechanism:
      'Generic HTTP transport with configurable endpoint, auth, timeout and retry ' +
      '(spec section 20). Request and response encoding is supplied per provider by a ' +
      'ProviderProtocol, so no vendor API shape is assumed. `anthropicMessagesProtocol` ' +
      'is the first concrete one: POST /v1/messages, anthropic-version 2023-06-01, ' +
      'streamed as server-sent events.',
    howToVerify:
      'Set the credential in your own shell -- never as an argument -- and run: ' +
      'npm run verify:direct',
    evidence: {
      date: '2026-09-06',
      toolVersion: 'anthropic-version 2023-06-01',
      note:
        'All four checks passed against https://api.anthropic.com on Windows, Node ' +
        '22.18.0, calling claude-opus-5. A real streamed request completed in 2156 ms ' +
        'reporting 16 input / 4 output tokens, with observed event kinds usage, ' +
        'assistant-message, completed. A missing credential was refused locally as ' +
        'ENVIRONMENT_FAILURE with nothing sent, and an unknown model came back 404 ' +
        'classified PROVIDER_FAILURE. Recorded from the machine-written report at ' +
        '.routepilot/direct-provider-verification.json, which the script refuses to ' +
        'write if it finds the credential anywhere in its own output.',
    },
    limitations: [
      'CONFIRMED against the real API: endpoint and path construction, api-key ' +
        'authentication, SSE decoding, incremental event delivery, usage reporting, ' +
        'and the classification of both a missing credential and an HTTP error.',
      'ONE PROTOCOL ONLY. `anthropicMessagesProtocol` is verified; every other ' +
        'provider still needs its own ProviderProtocol, and none ships. Verified here ' +
        'means the transport works and one vendor mapping is correct -- not that any ' +
        'other provider will work.',
      'NOT CONFIRMED: tool use, structured output, long or interrupted streams, ' +
        'cancellation mid-request, and timeout behaviour against the real endpoint. ' +
        'The verified request was a few tokens of plain text.',
      'This is not a coding agent. `agenticExecution` is false and `canHandle` ' +
        'refuses any request needing it, so a task that must edit files can never ' +
        'reach this adapter.',
      'Verification needs a real credential, so it is deliberately outside ' +
        '`npm run verify` and never runs in CI. The credential is read from the ' +
        'environment by name, never accepted as an argument, and never printed.',
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

/**
 * What is known about `routepilot run --execute` working end to end.
 *
 * Starts `unverified` and is updated only from the machine-written report at
 * `.routepilot/run-loop-verification.json`, never from expectation.
 */
export const LOOP_VERIFICATION: LoopVerification = {
  status: 'verified',
  mechanism:
    'The production path: routeTask() decides, runTask() hands that decision to ' +
    'TaskRunner, RegistryExecutor drives a real adapter, and the workspace’s own ' +
    'manifest scripts are run as validation afterwards. The outcome, telemetry ' +
    'and learning all derive from that single pass.',
  howToVerify:
    'From a terminal: npm run verify:run-loop -- --model anthropic/haiku ' +
    '--permission-mode acceptEdits',
  evidence: {
    date: '2026-09-08',
    toolVersion: 'Claude Code 2.1.72',
    note:
      'All six checks passed on Windows, Node 22.18.0, driving claude-haiku-4-5 ' +
      'through routeTask() and runTask() with --permission-mode acceptEdits. A real ' +
      'agent fixed the fixture, RoutePilot ran the workspace’s own npm test, and the ' +
      'run reported `succeeded` with testsPassed=true, taskCriteriaMet=true and ' +
      'evidence=0.5 -- one request, one attempt and one outcome in SQLite, and one ' +
      'learned observation. A workspace declaring no scripts reported `unverified` ' +
      'with taskCriteriaMet null even though the agent had done the work. Recorded ' +
      'from .routepilot/run-loop-verification.json, not from a transcript.',
  },
  limitations: [
    'FOUND BY THIS: on Windows every validation command failed to start, because ' +
      'they are all `npm run <script>` and `execFile` cannot launch `npm.cmd` without ' +
      'a shell. Every check reported "not run", so every `run --execute` reported ' +
      '`unverified` regardless of what the agent did. Fixed by ' +
      '`src/infra/npm-command.ts`; the first end-to-end run is what surfaced it.',
    'ESCALATION HAS STILL NEVER HAPPENED FOR REAL, and is now the largest gap. ' +
      '`weakness.broke-validation` requires repositoryBrokenBeforeRun !== true and ' +
      'the fixture ships a failing test, so this fixture cannot trigger a vertical ' +
      'escalation. Closing it needs a fixture that starts passing plus a model that ' +
      'reliably fails it, which is not deterministic.',
    'NOT CONFIRMED: budget enforcement across real attempts, retry and provider ' +
      'fallback against a real agent, and the loop on any platform other than ' +
      'Windows.',
    'Verified through Claude Code only. The same script accepts --adapter ' +
      'cursor-cli, which has not been run.',
  ],
};
