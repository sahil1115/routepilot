/**
 * The Anthropic Messages protocol, against a recorded stream.
 *
 * No network and no credential: the transcript below is the documented SSE
 * shape, so these tests prove the decoding is right without proving the
 * endpoint exists. That second half needs a real key and lives in
 * `scripts/verify-direct-provider.mjs`, which a human runs.
 */

import { describe, expect, it } from 'vitest';

import type { AgentExecutionRequest } from '../../../core/types/agent.js';
import type { ModelSpec } from '../../../core/types/model.js';
import { makeModel } from '../../../test-support/fixtures.js';
import { anthropicMessagesProtocol, ANTHROPIC_VERSION } from './anthropic.js';

const model: ModelSpec = makeModel({ id: 'anthropic/opus', modelId: 'claude-opus-5' });

const request: AgentExecutionRequest = {
  requestId: 'req-1',
  prompt: 'Reply with OK.',
  workspaceRoot: '/tmp/does-not-matter',
  taskType: 'explanation',
  requiredCapabilities: {},
};

/** The documented event sequence for a short successful response. */
function transcript(): string[] {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":12,"output_tokens":1}}}',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    'event: message_stop',
    'data: {"type":"message_stop"}',
  ];
}

describe('Anthropic Messages protocol', () => {
  const protocol = anthropicMessagesProtocol();

  it('encodes a streaming request against the documented endpoint', () => {
    const encoded = protocol.encodeRequest(request, model);

    expect(encoded.method).toBe('POST');
    expect(encoded.path).toBe('/v1/messages');
    expect(encoded.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);

    const body = JSON.parse(encoded.body) as Record<string, unknown>;
    expect(body['model']).toBe('claude-opus-5');
    expect(body['stream']).toBe(true);
    expect(body['messages']).toEqual([{ role: 'user', content: 'Reply with OK.' }]);
  });

  it('never puts a credential in the request it builds', () => {
    // The adapter owns the credential. A protocol that reached for one would
    // put a secret in a layer that has no redaction and no test covering it.
    const encoded = protocol.encodeRequest(request, model);

    const headerNames = Object.keys(encoded.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('x-api-key');
    expect(headerNames).not.toContain('authorization');
    expect(encoded.body).not.toMatch(/sk-ant/);
  });

  it('ignores SSE framing lines and decodes only data', () => {
    // `event:` lines arrive interleaved with `data:` lines. Decoding one as if
    // it were JSON would emit an event per frame, doubling everything.
    expect(protocol.decodeEvent('event: content_block_delta')).toBeNull();
    expect(protocol.decodeEvent('')).toBeNull();
    expect(protocol.decodeEvent('data: [DONE]')).toBeNull();
    expect(protocol.decodeEvent('data: {not json')).toBeNull();
  });

  it('decodes text deltas as assistant messages', () => {
    const event = protocol.decodeEvent(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
    );

    expect(event?.kind).toBe('assistant-message');
    expect(event?.summary).toBe('Hello');
  });

  it('reports usage from both the start and the delta', () => {
    const start = protocol.decodeEvent(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}',
    );
    expect(start?.kind).toBe('usage');
    expect(start?.usage?.inputTokens).toBe(12);

    const delta = protocol.decodeEvent(
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}',
    );
    expect(delta?.usage?.outputTokens).toBe(5);
  });

  it('reports completion and the final usage', () => {
    const lines = transcript();

    expect(protocol.decodeEvent(lines[lines.length - 1] ?? '')?.kind).toBe('completed');

    const result = protocol.decodeResult(lines);
    expect(result.status).toBe('completed');
    expect(result.changedFiles).toEqual([]);
    // Input from message_start, output replaced by message_delta -- which
    // reports the total, not an increment.
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
  });

  it('treats a truncated stream as a provider failure, not a success', () => {
    // The dangerous case: everything looked fine and the response never
    // finished. Reporting `completed` would hand the caller a partial answer.
    const cut = transcript().slice(0, 6);

    const result = protocol.decodeResult(cut);
    expect(result.status).toBe('failed');
    expect(result.failureType).toBe('PROVIDER_FAILURE');
    expect(result.errorSummary).toContain('before the response was complete');
  });

  it('surfaces a provider error event', () => {
    const result = protocol.decodeResult([
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    ]);

    expect(result.status).toBe('failed');
    expect(result.failureType).toBe('PROVIDER_FAILURE');
    expect(result.errorSummary).toContain('Overloaded');
  });

  it('reports a refusal without blaming the model', () => {
    // A refusal is a completed exchange in which the model declined. Scoring it
    // as MODEL_WEAKNESS would teach the router to avoid a model over a policy
    // decision (spec section 22).
    const result = protocol.decodeResult([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"stop_details":{"category":"cyber"},"usage":{"output_tokens":2}}',
      'data: {"type":"message_stop"}',
    ]);

    expect(result.status).toBe('failed');
    expect(result.failureType).not.toBe('MODEL_WEAKNESS');
    expect(result.errorSummary).toContain('declined');
    expect(result.errorSummary).toContain('cyber');
  });

  it('honours an explicit max_tokens, so a test call stays small', () => {
    const encoded = anthropicMessagesProtocol({ maxTokens: 16 }).encodeRequest(request, model);
    expect((JSON.parse(encoded.body) as Record<string, unknown>)['max_tokens']).toBe(16);
  });
});
