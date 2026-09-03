/**
 * Adapter interface conformance.
 *
 * No adapter is implemented in Phase 1. What can be verified now is that the
 * interface is actually implementable — that a conforming adapter compiles and
 * that the normalisation contract has a coherent shape. This is a real check:
 * an interface nobody has tried to implement is an interface with a mistake in
 * it (spec section 2, rule 20 — never claim an integration works until it has
 * been tested).
 */

import { describe, expect, it } from 'vitest';

import { makeModel } from '../../test-support/fixtures.js';
import {
  AGENT_EVENT_KINDS,
  type AgentAdapter,
  type AgentEvent,
  type AgentExecutionRequest,
  type AgentResult,
  type AgentSession,
  type AgentStatus,
  type AgentSupportDecision,
} from './agent.js';

/** A deliberately minimal adapter, present only to prove the interface fits. */
class ConformanceAdapter implements AgentAdapter {
  readonly id = 'conformance';
  readonly displayName = 'Conformance Adapter';
  readonly capabilities = {
    streaming: true,
    cancellation: true,
    toolUse: true,
    agenticExecution: false,
    fileEditing: false,
    terminalExecution: false,
    modelSelection: true,
    usageReporting: true,
  };

  readonly cancelled: string[] = [];

  canHandle(request: AgentExecutionRequest): AgentSupportDecision {
    if (request.requiredCapabilities.agenticExecution === true) {
      return { supported: false, reason: 'this adapter cannot drive an agentic loop' };
    }
    return { supported: true };
  }

  execute(
    request: AgentExecutionRequest,
    model: ReturnType<typeof makeModel>,
  ): Promise<AgentSession> {
    const events: AgentEvent[] = [
      { kind: 'assistant-message', timestamp: 1, summary: 'working' },
      { kind: 'completed', timestamp: 2 },
    ];

    const session: AgentSession = {
      id: `session-${request.requestId}`,
      adapterId: this.id,
      modelId: model.id,
      events: (async function* () {
        for (const event of events) {
          // Real adapters await I/O here; the await keeps this a genuine
          // AsyncIterable rather than a sync generator in disguise.
          await Promise.resolve();
          yield event;
        }
      })(),
      result: Promise.resolve<AgentResult>({
        status: 'completed',
        changedFiles: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    };

    return Promise.resolve(session);
  }

  cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
    return Promise.resolve();
  }

  getStatus(): Promise<AgentStatus> {
    return Promise.resolve({ available: true, version: '0.0.0-test' });
  }

  normalizeEvent(raw: unknown): AgentEvent | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const candidate = raw as { type?: unknown };
    if (candidate.type !== 'assistant') return null;
    return { kind: 'assistant-message', timestamp: 0 };
  }

  normalizeResult(raw: unknown): AgentResult {
    const ok = typeof raw === 'object' && raw !== null && (raw as { ok?: unknown }).ok === true;
    return ok
      ? { status: 'completed', changedFiles: [] }
      : { status: 'failed', changedFiles: [], failureType: 'UNKNOWN' };
  }
}

const request: AgentExecutionRequest = {
  requestId: 'req-1',
  prompt: 'add a test',
  workspaceRoot: '/tmp/workspace',
  taskType: 'test-generation',
  requiredCapabilities: { toolUse: true },
};

describe('AgentAdapter interface', () => {
  it('can be implemented', () => {
    const adapter: AgentAdapter = new ConformanceAdapter();
    expect(adapter.id).toBe('conformance');
  });

  it('reports support with a reason when it declines', () => {
    const adapter = new ConformanceAdapter();

    expect(adapter.canHandle(request)).toEqual({ supported: true });

    const declined = adapter.canHandle({
      ...request,
      requiredCapabilities: { agenticExecution: true },
    });
    expect(declined.supported).toBe(false);
    expect(declined.reason).toBeTruthy();
  });

  it('produces a session whose events and result can be consumed', async () => {
    const adapter = new ConformanceAdapter();
    const session = await adapter.execute(request, makeModel());

    const kinds: string[] = [];
    for await (const event of session.events) kinds.push(event.kind);

    expect(kinds).toEqual(['assistant-message', 'completed']);
    expect(session.modelId).toBe('acme/fast-1');
    await expect(session.result).resolves.toMatchObject({ status: 'completed' });
  });

  it('records cancellation by session id', async () => {
    const adapter = new ConformanceAdapter();
    const session = await adapter.execute(request, makeModel());

    await adapter.cancel(session.id);

    expect(adapter.cancelled).toEqual(['session-req-1']);
  });

  it('normalises unknown native events to null rather than guessing', () => {
    const adapter = new ConformanceAdapter();

    expect(adapter.normalizeEvent({ type: 'something-else' })).toBeNull();
    expect(adapter.normalizeEvent('garbage')).toBeNull();
    expect(adapter.normalizeEvent({ type: 'assistant' })?.kind).toBe('assistant-message');
  });

  it('normalises a failed result with a failure classification', () => {
    const adapter = new ConformanceAdapter();

    expect(adapter.normalizeResult({ ok: false })).toMatchObject({
      status: 'failed',
      failureType: 'UNKNOWN',
    });
  });

  it('reports status, with detail required when unavailable', async () => {
    const adapter = new ConformanceAdapter();
    const status = await adapter.getStatus();

    expect(status.available).toBe(true);
  });
});

describe('normalised event vocabulary', () => {
  it('covers the event kinds the adapters must map onto (spec section 19)', () => {
    expect(AGENT_EVENT_KINDS).toContain('tool-call');
    expect(AGENT_EVENT_KINDS).toContain('tool-result');
    expect(AGENT_EVENT_KINDS).toContain('file-change');
    expect(AGENT_EVENT_KINDS).toContain('terminal-command');
    expect(AGENT_EVENT_KINDS).toContain('error');
    expect(AGENT_EVENT_KINDS).toContain('completed');
    expect(AGENT_EVENT_KINDS).toContain('cancelled');
  });

  it('has no duplicate kinds', () => {
    expect(new Set(AGENT_EVENT_KINDS).size).toBe(AGENT_EVENT_KINDS.length);
  });
});
