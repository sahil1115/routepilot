/**
 * Stub agent CLIs for adapter tests.
 *
 * These write **real Node scripts to disk and run them as real child
 * processes**. Mocking `child_process.spawn` would test the adapter against a
 * fiction; this way the tests exercise the actual spawn path, real stdout
 * buffering, real line splitting, real exit codes, real signals and real
 * timeouts — the parts most likely to behave differently on Windows.
 *
 * Excluded from the published build (see tsconfig.build.json).
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** How a stub CLI should behave. */
export interface StubBehaviour {
  /** Lines written to stdout, in order. */
  readonly stdout?: readonly string[] | undefined;
  /** Text written to stderr. */
  readonly stderr?: string | undefined;
  /** Exit code. Defaults to 0. */
  readonly exitCode?: number | undefined;
  /** Milliseconds to pause between stdout lines. */
  readonly delayMs?: number | undefined;
  /** Never exit, so timeout and cancellation can be tested. */
  readonly hang?: boolean | undefined;
  /** Ignore SIGTERM, to test kill escalation. */
  readonly ignoreSigterm?: boolean | undefined;
  /** Write the received argv to this file, so argument passing can be asserted. */
  readonly recordArgsTo?: string | undefined;
}

/**
 * A stub CLI on disk.
 *
 * Exposed as an executable plus an argument prefix rather than as a shim
 * script, because Node refuses to spawn `.cmd`/`.bat` files without a shell
 * (a deliberate hardening against argument-injection on Windows), and
 * RoutePilot never uses a shell.
 */
export interface StubCli {
  /** Executable to invoke: the current Node binary. */
  readonly command: string;
  /** Arguments that must precede the adapter's own. */
  readonly commandArgs: readonly string[];
  /** Path of the stub script. */
  readonly scriptPath: string;
  /** Directory holding the stub. */
  readonly dir: string;
  cleanup(): Promise<void>;
}

/**
 * Write a stub CLI.
 *
 * Returns the script path; adapters are pointed at a small launcher so they can
 * still be invoked as a single `command`.
 */
export async function createStubCli(behaviour: StubBehaviour): Promise<StubCli> {
  const dir = await mkdtemp(join(tmpdir(), 'routepilot-stub-'));
  const scriptPath = join(dir, 'stub.mjs');

  const script = `
const args = process.argv.slice(2);
const behaviour = ${JSON.stringify(behaviour)};

if (behaviour.recordArgsTo) {
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(behaviour.recordArgsTo, JSON.stringify(args), 'utf8'),
  );
}

if (behaviour.ignoreSigterm) {
  process.on('SIGTERM', () => {});
}

if (behaviour.stderr) process.stderr.write(behaviour.stderr);

const lines = behaviour.stdout ?? [];
for (const line of lines) {
  process.stdout.write(line + '\\n');
  if (behaviour.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
  }
}

if (behaviour.hang) {
  // Hold the event loop open until killed.
  setInterval(() => {}, 1000);
} else {
  process.exit(behaviour.exitCode ?? 0);
}
`;

  await writeFile(scriptPath, script, 'utf8');
  await chmod(scriptPath, 0o755).catch(() => undefined);

  return {
    command: process.execPath,
    commandArgs: [scriptPath],
    scriptPath,
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/**
 * The stub, ready to hand to an adapter.
 *
 * Kept as a separate name for readability at call sites; there is no shim to
 * build, because a shim would be a `.cmd` file that cannot be spawned without
 * a shell.
 */
export async function createStubCommand(behaviour: StubBehaviour): Promise<StubCli> {
  return createStubCli(behaviour);
}

/**
 * A run Claude Code blocked on permissions.
 *
 * Observed verbatim against Claude Code 2.1.72 on 2026-09-03 with no
 * `--permission-mode`: every `Edit` and `Bash` tool call comes back with
 * `is_error: true`, the model narrates that it is being asked for permission,
 * and the terminal event is a tidy `subtype: "success"` having changed nothing.
 */
export function claudePermissionBlockedTranscript(): string[] {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: 'a.ts' } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'The system is asking for permission.' }] },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'I identified the bug.',
      session_id: 'abc',
    }),
  ];
}

export function claudeSuccessTranscript(): string[] {
  return [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
      model: 'claude-haiku-4-5',
      tools: ['Read', 'Edit'],
    }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Looking at the file.' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false }] },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      session_id: 'abc',
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 },
    }),
  ];
}

/** A Claude Code transcript ending in a failure. */
export function claudeFailureTranscript(subtype = 'error_during_execution'): string[] {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' }),
    JSON.stringify({
      type: 'result',
      subtype,
      is_error: true,
      result: 'something went wrong',
      usage: { input_tokens: 10, output_tokens: 0 },
    }),
  ];
}

/** A plausible Cursor CLI stream-json transcript. */
export function cursorSuccessTranscript(): string[] {
  return [
    JSON.stringify({ type: 'user', text: 'do the thing' }),
    JSON.stringify({ type: 'assistant', text: 'Working on it.' }),
    JSON.stringify({ type: 'tool_call', name: 'edit_file' }),
    JSON.stringify({ type: 'tool_result', is_error: false }),
    JSON.stringify({ type: 'file_change', path: 'src/a.ts' }),
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ];
}
