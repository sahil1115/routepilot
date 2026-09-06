/**
 * Anthropic Messages API protocol (spec section 20).
 *
 * The vendor-specific half of {@link DirectProviderAdapter}: it encodes a
 * request for `POST /v1/messages` and decodes the server-sent event stream.
 * Everything else -- endpoint, auth, timeout, retry, cancellation, redaction --
 * belongs to the adapter and is not repeated here.
 *
 * Raw HTTP rather than `@anthropic-ai/sdk` deliberately. The SDK brings its own
 * transport, authentication and retry, so using it would bypass the adapter
 * this protocol exists to exercise. A fresh integration with no adapter to
 * verify should prefer the SDK.
 *
 * The stream is SSE, which is line-oriented:
 *
 * ```
 * event: content_block_delta
 * data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}
 * ```
 *
 * The adapter splits on newlines and hands each line to {@link decodeEvent}, so
 * `event:` lines are ignored and `data:` lines carry everything.
 */

import type { AgentEvent, AgentExecutionRequest, AgentResult } from '../../../core/types/agent.js';
import type { ModelSpec } from '../../../core/types/model.js';
import type { ProviderProtocol, ProviderRequest } from '../adapter.js';

/** The API version this protocol speaks. Sent on every request. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** Output cap when the model spec does not name one. */
const DEFAULT_MAX_TOKENS = 4096;

/** Options for {@link anthropicMessagesProtocol}. */
export interface AnthropicProtocolOptions {
  /** Overrides `model.maxOutputTokens`, for a deliberately small test call. */
  readonly maxTokens?: number | undefined;
  /** System prompt, when the caller wants one. */
  readonly system?: string | undefined;
}

/** The Messages API as a {@link ProviderProtocol}. */
export function anthropicMessagesProtocol(
  options: AnthropicProtocolOptions = {},
): ProviderProtocol {
  return {
    id: 'anthropic-messages',

    encodeRequest(request: AgentExecutionRequest, model: ModelSpec): ProviderRequest {
      const body: Record<string, unknown> = {
        model: model.modelId,
        max_tokens: options.maxTokens ?? model.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        // Streaming is the point: the adapter delivers events as they arrive,
        // and a long response would otherwise risk an HTTP timeout.
        stream: true,
        messages: [{ role: 'user', content: request.prompt }],
      };
      if (options.system !== undefined) body['system'] = options.system;

      return {
        path: '/v1/messages',
        method: 'POST',
        // The credential is NOT here. The adapter adds `x-api-key` from the
        // environment variable the provider config names, so no protocol ever
        // handles a secret.
        headers: {
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      };
    },

    decodeEvent(chunk: string): AgentEvent | null {
      const payload = dataOf(chunk);
      if (payload === null) return null;

      const type = asString(payload['type']);
      const now = Date.now();

      switch (type) {
        case 'content_block_delta': {
          const text = asString(asRecord(payload['delta'])?.['text'] ?? null);
          if (text === null || text === '') return null;
          return { kind: 'assistant-message', timestamp: now, summary: truncate(text) };
        }

        case 'message_start': {
          const usage = usageOf(asRecord(payload['message'])?.['usage'] ?? null);
          return usage === null ? null : { kind: 'usage', timestamp: now, usage };
        }

        case 'message_delta': {
          const usage = usageOf(payload['usage']);
          return usage === null ? null : { kind: 'usage', timestamp: now, usage };
        }

        case 'message_stop':
          return { kind: 'completed', timestamp: now, summary: 'run completed' };

        case 'error': {
          // The message is the provider's own and may echo the request, so it
          // is passed to the adapter, which redacts before anything is stored.
          const message = asString(asRecord(payload['error'])?.['message'] ?? null);
          return {
            kind: 'error',
            timestamp: now,
            ok: false,
            summary: message === null ? 'the provider reported an error' : truncate(message),
          };
        }

        // ping, content_block_start/stop and anything unrecognised. Ignored
        // rather than guessed at, so a new event type cannot be misreported.
        default:
          return null;
      }
    },

    decodeResult(chunks: readonly string[]): AgentResult {
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      let stopReason: string | null = null;
      let stopCategory: string | null = null;
      let error: string | null = null;
      let sawStop = false;

      for (const chunk of chunks) {
        const payload = dataOf(chunk);
        if (payload === null) continue;

        switch (asString(payload['type'])) {
          case 'message_start': {
            const started = usageOf(asRecord(payload['message'])?.['usage'] ?? null);
            if (started !== null) usage = { ...started };
            break;
          }
          case 'message_delta': {
            const delta = usageOf(payload['usage']);
            if (delta !== null && usage !== null) {
              // `message_delta` reports output tokens for the whole response,
              // not an increment, so it replaces rather than accumulates.
              usage = { inputTokens: usage.inputTokens, outputTokens: delta.outputTokens };
            } else if (delta !== null) {
              usage = { ...delta };
            }
            stopReason =
              asString(asRecord(payload['delta'])?.['stop_reason'] ?? null) ?? stopReason;
            stopCategory =
              asString(asRecord(payload['stop_details'])?.['category'] ?? null) ?? stopCategory;
            break;
          }
          case 'message_stop':
            sawStop = true;
            break;
          case 'error':
            error = asString(asRecord(payload['error'])?.['message'] ?? null) ?? 'provider error';
            break;
          default:
            break;
        }
      }

      if (error !== null) {
        return {
          status: 'failed',
          changedFiles: [],
          failureType: 'PROVIDER_FAILURE',
          errorSummary: error,
          ...(usage === null ? {} : { usage }),
        };
      }

      // A refusal is a completed exchange in which the model declined. It is
      // not a transport fault and not evidence the model is weak, so it is
      // reported as a failure the caller can read rather than either extreme.
      if (stopReason === 'refusal') {
        return {
          status: 'failed',
          changedFiles: [],
          failureType: 'UNKNOWN',
          errorSummary: `the model declined this request${stopCategory === null ? '' : ` (${stopCategory})`}`,
          ...(usage === null ? {} : { usage }),
        };
      }

      if (!sawStop) {
        return {
          status: 'failed',
          changedFiles: [],
          failureType: 'PROVIDER_FAILURE',
          errorSummary: 'the stream ended before the response was complete',
          ...(usage === null ? {} : { usage }),
        };
      }

      return {
        status: 'completed',
        // A direct API call edits nothing. Anything needing file changes must
        // go to a coding agent, which `canHandle` already enforces.
        changedFiles: [],
        ...(usage === null ? {} : { usage }),
      };
    },
  };
}

/** The JSON carried by an SSE `data:` line, or null for any other line. */
function dataOf(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;

  const raw = trimmed.slice('data:'.length).trim();
  if (raw === '' || raw === '[DONE]') return null;

  try {
    return asRecord(JSON.parse(raw));
  } catch {
    // A truncated or malformed line is ignored, never guessed at.
    return null;
  }
}

function usageOf(value: unknown): { inputTokens: number; outputTokens: number } | null {
  const usage = asRecord(value);
  if (usage === null) return null;

  const input = asNumber(usage['input_tokens']);
  const output = asNumber(usage['output_tokens']);
  if (input === null && output === null) return null;

  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function truncate(text: string, limit = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}
