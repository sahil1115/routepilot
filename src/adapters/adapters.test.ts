/**
 * Adapter tests, driven by real child processes.
 *
 * Covers the behaviours the phase names: streaming, tool calls, errors,
 * cancellation, timeout, provider unavailable, model unavailable, retry and
 * fallback.
 *
 * These use stub CLIs written to disk and executed for real, so the spawn path,
 * stdout buffering, line splitting, exit codes, signals and timeouts are all
 * genuinely exercised. **That still does not make an adapter verified** — see
 * `verification.ts`. Mocks prove an adapter handles the shapes it was told to
 * expect; only a real run proves those are the shapes the tool emits.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEvent, AgentExecutionRequest } from '../core/types/agent.js';
import { makeModel } from '../test-support/fixtures.js';
import {
  claudeFailureTranscript,
  claudeSuccessTranscript,
  createStubCommand,
  cursorSuccessTranscript,
  type StubCli,
} from '../test-support/stub-cli.js';
import { ClaudeCodeAdapter } from './claude-code/adapter.js';
import { CursorCliAdapter } from './cursor/adapter.js';
import { DirectProviderAdapter, type FetchLike, type ProviderProtocol } from './direct/adapter.js';
import { FakeAgentAdapter } from './fake/adapter.js';
import { AgentRegistry } from './registry.js';
import { runProcess } from './process/runner.js';
import { ADAPTER_VERIFICATION, isSupported, verificationFor } from './verification.js';

const stubs: StubCli[] = [];

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.cleanup()));
});

async function stub(behaviour: Parameters<typeof createStubCommand>[0]): Promise<StubCli> {
  const created = await createStubCommand(behaviour);
  stubs.push(created);
  return created;
}

const model = makeModel({ modelId: 'test-model-1' });

function request(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    requestId: 'req-1',
    prompt: 'add a test for the parser',
    workspaceRoot: process.cwd(),
    taskType: 'test-generation',
    requiredCapabilities: { toolUse: true, agenticExecution: true },
    ...overrides,
  };
}

/** Collect every event a session emits. */
async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

describe('process runner', () => {
  it('streams stdout line by line as it arrives', async () => {
    const cli = await stub({ stdout: ['one', 'two', 'three'] });

    const handle = runProcess({
      command: cli.command,
      args: [...cli.commandArgs],
      cwd: cli.dir,
      timeoutMs: 30_000,
    });

    const lines: string[] = [];
    for await (const line of handle.lines) lines.push(line);
    const result = await handle.result;

    expect(lines).toEqual(['one', 'two', 'three']);
    expect(result.outcome).toBe('exited');
    expect(result.exitCode).toBe(0);
  });

  it('reports a non-zero exit code and captures stderr', async () => {
    const cli = await stub({ stderr: 'boom', exitCode: 3 });

    const handle = runProcess({
      command: cli.command,
      args: [...cli.commandArgs],
      cwd: cli.dir,
      timeoutMs: 30_000,
    });
    for await (const line of handle.lines) void line;
    const result = await handle.result;

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('times out a hanging process rather than waiting forever', async () => {
    const cli = await stub({ stdout: ['started'], hang: true });

    const handle = runProcess({
      command: cli.command,
      args: [...cli.commandArgs],
      cwd: cli.dir,
      timeoutMs: 400,
    });
    for await (const line of handle.lines) void line;
    const result = await handle.result;

    expect(result.outcome).toBe('timed-out');
  });

  it('cancels a running process on request', async () => {
    const cli = await stub({ stdout: ['started'], hang: true });

    const handle = runProcess({
      command: cli.command,
      args: [...cli.commandArgs],
      cwd: cli.dir,
      timeoutMs: 30_000,
    });
    setTimeout(() => {
      handle.cancel();
    }, 200);

    for await (const line of handle.lines) void line;
    const result = await handle.result;

    expect(result.outcome).toBe('cancelled');
  });

  it('reports a missing executable instead of throwing', async () => {
    const handle = runProcess({
      command: 'routepilot-definitely-not-a-real-command',
      args: [],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    for await (const line of handle.lines) void line;
    const result = await handle.result;

    expect(result.outcome).toBe('spawn-failed');
  });

  it('passes arguments through verbatim, without a shell', async () => {
    // The decisive security property: a prompt full of shell metacharacters
    // must arrive as one argument, not as a command (spec section 51).
    const recorded = join(process.cwd(), 'node_modules', '.routepilot-verbatim.json');
    const recording = await stub({ stdout: [], recordArgsTo: recorded });

    const dangerous = 'fix; rm -rf / && echo `whoami` $(id) "quoted"';
    const handle = runProcess({
      command: recording.command,
      args: [...recording.commandArgs, '--prompt', dangerous],
      cwd: recording.dir,
      timeoutMs: 30_000,
    });
    for await (const line of handle.lines) void line;
    await handle.result;

    const args = JSON.parse(await readFile(recorded, 'utf8')) as string[];
    expect(args).toEqual(['--prompt', dangerous]);
  });
});

// ---------------------------------------------------------------------------
// Claude Code adapter
// ---------------------------------------------------------------------------

describe('Claude Code adapter', () => {
  it('streams normalised events, including tool calls', async () => {
    const cli = await stub({ stdout: claudeSuccessTranscript() });
    const adapter = new ClaudeCodeAdapter({
      command: cli.command,
      commandArgs: cli.commandArgs,
      now: () => 1,
    });

    const session = await adapter.execute(request({ workspaceRoot: cli.dir }), model);
    const events = await collect(session.events);

    expect(events.map((e) => e.kind)).toEqual([
      'assistant-message',
      'assistant-message',
      'tool-call',
      'tool-result',
      'completed',
    ]);
    expect(events.find((e) => e.kind === 'tool-call')?.tool).toBe('Read');
    expect(events.find((e) => e.kind === 'tool-result')?.ok).toBe(true);
  });

  it('reports success with token usage', async () => {
    const cli = await stub({ stdout: claudeSuccessTranscript() });
    const adapter = new ClaudeCodeAdapter({ command: cli.command, commandArgs: cli.commandArgs });

    const session = await adapter.execute(request({ workspaceRoot: cli.dir }), model);
    const result = await session.result;

    expect(result.status).toBe('completed');
    expect(result.usage?.inputTokens).toBe(1200);
    expect(result.usage?.outputTokens).toBe(340);
    expect(result.usage?.cachedInputTokens).toBe(800);
  });

  it('reports a failure result without blaming the model', async () => {
    const cli = await stub({ stdout: claudeFailureTranscript() });
    const adapter = new ClaudeCodeAdapter({ command: cli.command, commandArgs: cli.commandArgs });

    const session = await adapter.execute(request({ workspaceRoot: cli.dir }), model);
    const result = await session.result;

    expect(result.status).toBe('failed');
    // A tool error is not evidence about the model (spec section 22).
    expect(result.failureType).toBe('TOOL_FAILURE');
    expect(result.failureType).not.toBe('MODEL_WEAKNESS');
  });

  it('classifies a budget failure as BUDGET_EXCEEDED', async () => {
    const cli = await stub({ stdout: claudeFailureTranscript('error_max_budget') });
    const adapter = new ClaudeCodeAdapter({ command: cli.command, commandArgs: cli.commandArgs });

    const session = await adapter.execute(request({ workspaceRoot: cli.dir }), model);
    expect((await session.result).failureType).toBe('BUDGET_EXCEEDED');
  });

  it('times out and classifies it as TIMEOUT', async () => {
    const cli = await stub({ stdout: ['{"type":"system","subtype":"init"}'], hang: true });
    const adapter = new ClaudeCodeAdapter({
      command: cli.command,
      commandArgs: cli.commandArgs,
      timeoutMs: 400,
    });

    const session = await adapter.execute(request({ workspaceRoot: cli.dir }), model);
    const result = await session.result;

    expect(result.status).toBe('failed');
    expect(result.failureType).toBe('TIMEOUT');
  });

  it('cancels a run and reports USER_CANCELLED, not a failure', async () => {
    const cli = await stub({ stdout: ['{"type":"system","subtype":"init"}'], hang: true });
    const adapter = new ClaudeCodeAdapter({
      command: cli.command,
      commandArgs: cli.commandArgs,
      timeoutMs: 30_000,
    });

    const session = await adapter.execute(request({ workspaceRoot: cli.dir }), model);
    setTimeout(() => void adapter.cancel(session.id), 200);
    const result = await session.result;

    expect(result.status).toBe('cancelled');
    expect(result.failureType).toBe('USER_CANCELLED');
  });

  it('reports an actionable setup error when the CLI is missing', async () => {
    const adapter = new ClaudeCodeAdapter({ command: 'routepilot-no-such-claude' });
    const status = await adapter.getStatus();

    expect(status.available).toBe(false);
    expect(status.detail).toContain('was not found');
    expect(status.detail).toContain('claude.com/claude-code');
  });

  it('classifies a missing binary as ENVIRONMENT_FAILURE, never model weakness', async () => {
    const adapter = new ClaudeCodeAdapter({ command: 'routepilot-no-such-claude' });

    const session = await adapter.execute(request(), model);
    const result = await session.result;

    expect(result.failureType).toBe('ENVIRONMENT_FAILURE');
  });

  it('passes the provider-native model id and documented flags', async () => {
    const recorded = join(process.cwd(), 'node_modules', '.routepilot-args.json');
    const recording = await stub({ stdout: [], recordArgsTo: recorded });
    const adapter = new ClaudeCodeAdapter({
      command: recording.command,
      commandArgs: recording.commandArgs,
      newSessionId: () => '11111111-2222-3333-4444-555555555555',
    });

    const session = await adapter.execute(request({ workspaceRoot: recording.dir }), model);
    await session.result;

    const args = JSON.parse(await readFile(recorded, 'utf8')) as string[];
    expect(args).toContain('--print');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args[args.indexOf('--model') + 1]).toBe('test-model-1');
    expect(args[args.indexOf('--session-id') + 1]).toBe('11111111-2222-3333-4444-555555555555');
    // The prompt is one argument, never spliced into a command string.
    expect(args).toContain('add a test for the parser');
  });

  it('declines a request needing a capability it lacks', () => {
    const adapter = new ClaudeCodeAdapter();
    const decision = adapter.canHandle(request({ workspaceRoot: '' }));

    expect(decision.supported).toBe(false);
    expect(decision.reason).toContain('workspace root');
  });

  it('ignores unrecognised events rather than guessing', () => {
    const adapter = new ClaudeCodeAdapter({ now: () => 0 });

    expect(adapter.normalizeEvent({ type: 'something_new' })).toBeNull();
    expect(adapter.normalizeEvent('not an object')).toBeNull();
    expect(adapter.normalizeEvent(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cursor CLI adapter
// ---------------------------------------------------------------------------

describe('Cursor CLI adapter', () => {
  it('streams normalised events including file changes', async () => {
    const cli = await stub({ stdout: cursorSuccessTranscript() });
    const adapter = new CursorCliAdapter({
      command: cli.command,
      commandArgs: cli.commandArgs,
      now: () => 1,
    });

    const session = await adapter.execute(request({ workspaceRoot: cli.dir }), model);
    const events = await collect(session.events);

    expect(events.map((e) => e.kind)).toEqual([
      'user-message',
      'assistant-message',
      'tool-call',
      'tool-result',
      'file-change',
      'completed',
    ]);
    expect(events.find((e) => e.kind === 'file-change')?.path).toBe('src/a.ts');
  });

  it('records changed files on the result', async () => {
    const cli = await stub({ stdout: cursorSuccessTranscript() });
    const adapter = new CursorCliAdapter({ command: cli.command, commandArgs: cli.commandArgs });

    const session = await adapter.execute(request({ workspaceRoot: cli.dir }), model);
    const result = await session.result;

    expect(result.status).toBe('completed');
    expect(result.changedFiles).toEqual(['src/a.ts']);
  });

  it('returns an actionable setup error when cursor-agent is absent', async () => {
    // Spec section 19: an unavailable CLI must produce actionable guidance.
    const adapter = new CursorCliAdapter({ command: 'routepilot-no-such-cursor-agent' });
    const status = await adapter.getStatus();

    expect(status.available).toBe(false);
    expect(status.detail).toContain('cursor.com/cli');
    expect(status.detail).toContain('cursor-agent');
    // The editor launcher is a common confusion worth naming.
    expect(status.detail).toContain('editor launcher');
  });

  it('does not claim usage reporting it cannot do', () => {
    const adapter = new CursorCliAdapter();
    expect(adapter.capabilities.usageReporting).toBe(false);
  });

  it('accepts both snake_case and camelCase error flags', () => {
    const adapter = new CursorCliAdapter({ now: () => 0 });

    expect(adapter.normalizeEvent({ type: 'tool_result', is_error: true })?.ok).toBe(false);
    expect(adapter.normalizeEvent({ type: 'tool_result', isError: true })?.ok).toBe(false);
    expect(adapter.normalizeEvent({ type: 'tool_result' })?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Direct provider adapter
// ---------------------------------------------------------------------------

describe('direct provider adapter', () => {
  const provider = {
    id: 'acme',
    displayName: 'Acme',
    kind: 'cloud' as const,
    endpoint: 'https://api.example.invalid',
    auth: { kind: 'apiKey' as const, envVar: 'ACME_TEST_KEY' },
    timeoutMs: 5_000,
    retry: { maxAttempts: 2, initialDelayMs: 1, backoffMultiplier: 2, maxDelayMs: 10 },
    availability: 'available' as const,
  };

  const protocol: ProviderProtocol = {
    id: 'test',
    encodeRequest: (req) => ({
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: req.prompt }),
    }),
    decodeEvent: (chunk) =>
      chunk.startsWith('event:') ? { kind: 'assistant-message', timestamp: 0 } : null,
    decodeResult: (chunks) => ({
      status: chunks.length > 0 ? 'completed' : 'failed',
      changedFiles: [],
    }),
  };

  const okFetch: FetchLike = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('event: one\nevent: two\n'),
    });

  it('reports unavailable when the credential variable is unset, naming it', async () => {
    const adapter = new DirectProviderAdapter({ provider, protocol, env: {}, fetch: okFetch });
    const status = await adapter.getStatus();

    expect(status.available).toBe(false);
    expect(status.detail).toContain('ACME_TEST_KEY');
    expect(status.detail).toContain('not set');
  });

  it('reports unavailable when the provider is marked unavailable', async () => {
    const adapter = new DirectProviderAdapter({
      provider: { ...provider, availability: 'unavailable' },
      protocol,
      env: { ACME_TEST_KEY: 'secret' },
      fetch: okFetch,
    });

    expect((await adapter.getStatus()).available).toBe(false);
  });

  it('streams decoded events and reports success', async () => {
    const adapter = new DirectProviderAdapter({
      provider,
      protocol,
      env: { ACME_TEST_KEY: 'secret' },
      fetch: okFetch,
    });

    const session = await adapter.execute(request({ requiredCapabilities: {} }), model);
    const events = await collect(session.events);

    expect(events).toHaveLength(2);
    expect((await session.result).status).toBe('completed');
  });

  it('sends the credential as a header and never in the body', async () => {
    let seenHeaders: Record<string, string> = {};
    const capturing: FetchLike = (_url, init) => {
      seenHeaders = init.headers;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('event: one\n'),
      });
    };

    const adapter = new DirectProviderAdapter({
      provider,
      protocol,
      env: { ACME_TEST_KEY: 'super-secret' },
      fetch: capturing,
    });

    const session = await adapter.execute(request({ requiredCapabilities: {} }), model);
    await session.result;

    expect(seenHeaders['x-api-key']).toBe('super-secret');
  });

  it('redacts the credential from any error it surfaces', async () => {
    const leaking: FetchLike = () =>
      Promise.reject(new Error('connection failed with key super-secret in the message'));

    const adapter = new DirectProviderAdapter({
      provider,
      protocol,
      env: { ACME_TEST_KEY: 'super-secret' },
      fetch: leaking,
    });

    const session = await adapter.execute(request({ requiredCapabilities: {} }), model);
    const result = await session.result;

    expect(result.status).toBe('failed');
    expect(result.errorSummary).not.toContain('super-secret');
    expect(result.errorSummary).toContain('[redacted]');
  });

  it('classifies an HTTP error as PROVIDER_FAILURE', async () => {
    const failing: FetchLike = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: () => Promise.resolve(''),
      });

    const adapter = new DirectProviderAdapter({
      provider,
      protocol,
      env: { ACME_TEST_KEY: 'secret' },
      fetch: failing,
    });

    const session = await adapter.execute(request({ requiredCapabilities: {} }), model);
    const result = await session.result;

    expect(result.failureType).toBe('PROVIDER_FAILURE');
    expect(result.errorSummary).toContain('503');
  });

  it('refuses work that needs an agent loop', () => {
    const adapter = new DirectProviderAdapter({
      provider,
      protocol,
      env: { ACME_TEST_KEY: 'secret' },
      fetch: okFetch,
    });

    const decision = adapter.canHandle(
      request({ requiredCapabilities: { agenticExecution: true } }),
    );

    expect(decision.supported).toBe(false);
    expect(decision.reason).toContain('coding agent');
  });
});

// ---------------------------------------------------------------------------
// Registry: selection, retry, fallback
// ---------------------------------------------------------------------------

describe('agent registry', () => {
  it('selects the only available adapter', async () => {
    const fake = new FakeAgentAdapter();
    const registry = new AgentRegistry([fake]);

    const selection = await registry.select(request());
    expect(selection.adapter?.id).toBe('fake');
  });

  it('honours a preferred adapter', async () => {
    const a = new FakeAgentAdapter({ id: 'alpha' });
    const b = new FakeAgentAdapter({ id: 'beta' });
    const registry = new AgentRegistry([a, b]);

    const selection = await registry.select(request(), { preferredAdapterId: 'beta' });
    expect(selection.adapter?.id).toBe('beta');
  });

  it('falls back when the preferred adapter is unavailable, and says why', async () => {
    const broken = new FakeAgentAdapter({
      id: 'broken',
      script: { unavailable: 'the tool is not installed' },
    });
    const working = new FakeAgentAdapter({ id: 'working' });
    const registry = new AgentRegistry([broken, working]);

    const selection = await registry.select(request(), { preferredAdapterId: 'broken' });

    expect(selection.adapter?.id).toBe('working');
    expect(selection.rejected).toContainEqual({
      adapterId: 'broken',
      reason: 'the tool is not installed',
    });
  });

  it('falls back when an adapter cannot provide a required capability', async () => {
    // Ids chosen so the limited adapter sorts first and is genuinely tried.
    const limited = new FakeAgentAdapter({
      id: 'a-limited',
      capabilities: { agenticExecution: false },
    });
    const full = new FakeAgentAdapter({ id: 'b-full' });
    const registry = new AgentRegistry([limited, full]);

    const selection = await registry.select(request());

    expect(selection.adapter?.id).toBe('b-full');
    expect(selection.rejected[0]?.reason).toContain('agenticExecution');
  });

  it('reports an environment failure when nothing can run, never model weakness', async () => {
    const broken = new FakeAgentAdapter({ id: 'broken', script: { unavailable: 'missing' } });
    const registry = new AgentRegistry([broken]);

    const outcome = await registry.execute(request(), model);

    expect(outcome.result.status).toBe('failed');
    expect(outcome.result.failureType).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.result.failureType).not.toBe('MODEL_WEAKNESS');
    expect(outcome.adapterId).toBeNull();
    expect(outcome.result.errorSummary).toContain('broken: missing');
  });

  it('retries a transient failure and succeeds', async () => {
    const flaky = new FakeAgentAdapter({ id: 'flaky', script: { failuresBeforeSuccess: 1 } });
    const registry = new AgentRegistry([flaky]);

    const outcome = await registry.execute(request(), model, {
      retry: { maxAttempts: 3, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
      sleep: () => Promise.resolve(),
    });

    expect(outcome.result.status).toBe('completed');
    expect(outcome.attempts).toHaveLength(2);
    expect(flaky.attempts).toBe(2);
  });

  it('stops retrying at the attempt limit', async () => {
    const broken = new FakeAgentAdapter({ id: 'broken', script: { failuresBeforeSuccess: 99 } });
    const registry = new AgentRegistry([broken]);

    const outcome = await registry.execute(request(), model, {
      retry: { maxAttempts: 3, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
      sleep: () => Promise.resolve(),
    });

    expect(outcome.result.status).toBe('failed');
    expect(outcome.attempts).toHaveLength(3);
  });

  it('does not retry a failure that a retry cannot fix', async () => {
    const adapter = new FakeAgentAdapter({
      id: 'weak',
      script: {
        result: {
          status: 'failed',
          changedFiles: [],
          failureType: 'MODEL_WEAKNESS',
          errorSummary: 'wrong approach',
        },
      },
    });
    const registry = new AgentRegistry([adapter]);

    const outcome = await registry.execute(request(), model, {
      retry: { maxAttempts: 5, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
      sleep: () => Promise.resolve(),
    });

    // Running the same model again will not fix model weakness; that is
    // escalation's job (Phase 9), not retry's.
    expect(outcome.attempts).toHaveLength(1);
  });

  it('converts a thrown adapter error into a classified failure', async () => {
    const throwing = new FakeAgentAdapter({
      id: 'throwing',
      script: { throwOnExecute: new Error('socket hang up') },
    });
    const registry = new AgentRegistry([throwing]);

    const outcome = await registry.execute(request(), model, {
      retry: { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
    });

    expect(outcome.result.failureType).toBe('PROVIDER_FAILURE');
    expect(outcome.result.errorSummary).toContain('socket hang up');
  });

  it('does not retry a cancellation', async () => {
    const adapter = new FakeAgentAdapter({
      id: 'cancelled',
      script: {
        result: { status: 'cancelled', changedFiles: [], failureType: 'USER_CANCELLED' },
      },
    });
    const registry = new AgentRegistry([adapter]);

    const outcome = await registry.execute(request(), model, {
      retry: { maxAttempts: 5, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
      sleep: () => Promise.resolve(),
    });

    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.result.status).toBe('cancelled');
  });

  it('refuses to silently replace a registered adapter', () => {
    const registry = new AgentRegistry([new FakeAgentAdapter({ id: 'x' })]);
    expect(() => {
      registry.register(new FakeAgentAdapter({ id: 'x' }));
    }).toThrow(/already registered/);
  });

  it('lists adapters in deterministic order', () => {
    const registry = new AgentRegistry([
      new FakeAgentAdapter({ id: 'zeta' }),
      new FakeAgentAdapter({ id: 'alpha' }),
    ]);
    expect(registry.list().map((a) => a.id)).toEqual(['alpha', 'zeta']);
  });
});

// ---------------------------------------------------------------------------
// Honesty about what is verified
// ---------------------------------------------------------------------------

describe('verification honesty (spec section 2, rule 20)', () => {
  it('marks every external-tool adapter as not verified', () => {
    for (const id of ['claude-code', 'cursor-cli', 'direct-provider']) {
      expect(isSupported(id), `${id} must not claim to be supported`).toBe(false);
    }
  });

  it('requires evidence before an adapter may be called verified', () => {
    for (const entry of ADAPTER_VERIFICATION) {
      if (entry.status === 'verified') {
        expect(entry.evidence, `${entry.adapterId} claims verified without evidence`).toBeDefined();
        expect(entry.evidence?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(entry.evidence?.note.length).toBeGreaterThan(20);
      } else {
        expect(entry.evidence).toBeUndefined();
      }
    }
  });

  it('tells the user exactly how to verify each adapter', () => {
    for (const entry of ADAPTER_VERIFICATION) {
      expect(entry.howToVerify.length).toBeGreaterThan(10);
      expect(entry.mechanism.length).toBeGreaterThan(10);
    }
  });

  it('records the limitations of each unverified adapter', () => {
    for (const id of ['claude-code', 'cursor-cli', 'direct-provider']) {
      expect(verificationFor(id)?.limitations.length).toBeGreaterThan(0);
    }
  });

  it('states plainly that Claude Code is a wrapper, not an interception', () => {
    const entry = verificationFor('claude-code');
    expect(entry?.mechanism).toContain('documented');
    expect(entry?.limitations.join(' ')).toContain('wrapper');
  });

  it('records that cursor-agent is not installed here', () => {
    expect(verificationFor('cursor-cli')?.status).toBe('unavailable');
  });
});
