/**
 * Claude Code stream-json event normalisation (spec section 19).
 *
 * Maps the `--output-format stream-json` event stream onto RoutePilot's
 * provider-neutral {@link AgentEvent}.
 *
 * **Defensive on purpose.** The event schema here is built from the documented
 * CLI surface, not from a captured real run (see `src/adapters/verification.ts`
 * — this adapter is `unverified`). Every field is therefore treated as
 * optional and every unrecognised shape returns `null` rather than a guess. An
 * event RoutePilot does not understand is an event it ignores; it never invents
 * a `tool-call` it is not sure it saw.
 *
 * Nothing here copies file contents or full message text into an event. Events
 * carry short summaries only, so that the core never becomes a place where
 * source code accumulates (spec section 33).
 */

import type { AgentEvent, AgentResult, TokenUsage } from '../../core/types/agent.js';
import type { FailureType } from '../../core/types/failure.js';

/** Maximum characters kept from any summary written into an event. */
const MAX_SUMMARY = 200;

/** Parse one stdout line as JSON. Returns null for anything unparseable. */
export function parseLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed === '' || !trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Interleaved non-JSON output is normal on stdout; it is not an error.
    return null;
  }
}

/**
 * Normalise one Claude Code event.
 *
 * @param raw A parsed stream-json object.
 * @param now Timestamp to stamp the event with, injected for determinism.
 */
export function normalizeClaudeEvent(raw: unknown, now: number): AgentEvent | null {
  const event = asRecord(raw);
  if (event === null) return null;

  const type = asString(event['type']);
  if (type === null) return null;

  switch (type) {
    case 'system':
      return normalizeSystem(event, now);
    case 'assistant':
      return normalizeAssistant(event, now);
    case 'user':
      return normalizeUser(event, now);
    case 'result':
      return normalizeResultEvent(event, now);
    default:
      // Unknown event types are ignored, not guessed at.
      return null;
  }
}

function normalizeSystem(event: Record<string, unknown>, now: number): AgentEvent | null {
  const subtype = asString(event['subtype']);
  if (subtype !== 'init') return null;

  const model = asString(event['model']);
  return {
    kind: 'assistant-message',
    timestamp: now,
    summary: model === null ? 'session started' : `session started on ${model}`,
  };
}

/**
 * An assistant turn.
 *
 * Claude Code nests the Anthropic message under `message`, whose `content` is
 * an array of blocks. A `tool_use` block is the signal RoutePilot cares about;
 * text blocks become a short summary.
 */
/**
 * The file a `tool_use` block names, if any.
 *
 * Claude Code uses `file_path` for most tools and `path` for some -- both were
 * observed in a single run against 2.1.72 -- so both are read.
 */
function pathOf(block: Record<string, unknown>): string | null {
  const input = asRecord(block['input']);
  if (input === null) return null;
  return asString(input['file_path'] ?? null) ?? asString(input['path'] ?? null);
}

/** One tool invocation, correlated to its result by `id`. */
export interface ToolUse {
  readonly id: string;
  readonly name: string | null;
  readonly path: string | null;
}

/**
 * Every `tool_use` block in an assistant event.
 *
 * Claude Code issues tool calls in parallel -- two `Read` calls can both be
 * announced before either result arrives -- so callers must correlate by `id`
 * rather than assuming a call is followed by its own result. `normalizeAssistant`
 * deliberately yields only one event per message; this reports all of them.
 */
export function toolUsesIn(event: unknown): readonly ToolUse[] {
  const record = asRecord(event);
  if (record === null || asString(record['type']) !== 'assistant') return [];
  const content = asArray(asRecord(record['message'])?.['content'] ?? null);
  if (content === null) return [];

  const uses: ToolUse[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (block === null || asString(block['type']) !== 'tool_use') continue;
    const id = asString(block['id']);
    if (id === null) continue;
    uses.push({ id, name: asString(block['name']), path: pathOf(block) });
  }
  return uses;
}

/** Every `tool_result` block in a user event, with the id it answers. */
export function toolResultsIn(event: unknown): readonly { id: string; ok: boolean }[] {
  const record = asRecord(event);
  if (record === null || asString(record['type']) !== 'user') return [];
  const content = asArray(asRecord(record['message'])?.['content'] ?? null);
  if (content === null) return [];

  const results: { id: string; ok: boolean }[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (block === null || asString(block['type']) !== 'tool_result') continue;
    const id = asString(block['tool_use_id']);
    if (id === null) continue;
    // Absent `is_error` means success -- it is omitted, not set to false.
    results.push({ id, ok: block['is_error'] !== true });
  }
  return results;
}

function normalizeAssistant(event: Record<string, unknown>, now: number): AgentEvent | null {
  const message = asRecord(event['message']);
  if (message === null) return null;

  const content = event['message'] !== undefined ? asArray(message['content']) : null;
  if (content !== null) {
    for (const entry of content) {
      const block = asRecord(entry);
      if (block === null) continue;
      if (asString(block['type']) === 'tool_use') {
        const name = asString(block['name']);
        // The file a tool is about to touch. Discarding it left
        // `AgentResult.changedFiles` permanently empty for this adapter, which
        // silently disabled the post-failure classification path in
        // `TaskRunner` -- it is gated on `changedFiles.length > 0`.
        const path = pathOf(block);
        return {
          kind: 'tool-call',
          timestamp: now,
          ...(name === null ? {} : { tool: name }),
          ...(path === null ? {} : { path }),
          summary: name === null ? 'tool call' : `calling ${name}`,
        };
      }
    }
  }

  const usage = extractUsage(message['usage']);
  const text = firstText(content);

  return {
    kind: 'assistant-message',
    timestamp: now,
    ...(text === null ? {} : { summary: truncate(text) }),
    ...(usage === null ? {} : { usage }),
  };
}

/**
 * A user turn.
 *
 * In print mode these carry tool results back into the conversation, so they
 * are normalised as `tool-result` rather than as user input.
 */
function normalizeUser(event: Record<string, unknown>, now: number): AgentEvent | null {
  const message = asRecord(event['message']);
  if (message === null) return null;

  const content = asArray(message['content']);
  if (content === null) return null;

  for (const entry of content) {
    const block = asRecord(entry);
    if (block === null) continue;
    if (asString(block['type']) !== 'tool_result') continue;

    const isError = block['is_error'];
    return {
      kind: 'tool-result',
      timestamp: now,
      ok: isError !== true,
      summary: isError === true ? 'tool call failed' : 'tool call succeeded',
    };
  }

  return null;
}

function normalizeResultEvent(event: Record<string, unknown>, now: number): AgentEvent {
  const isError = event['is_error'] === true;
  const subtype = asString(event['subtype']);
  const usage = extractUsage(event['usage']);

  if (isError || (subtype !== null && subtype !== 'success')) {
    return {
      kind: 'error',
      timestamp: now,
      ok: false,
      summary: truncate(asString(event['result']) ?? subtype ?? 'run failed'),
      ...(usage === null ? {} : { usage }),
    };
  }

  return {
    kind: 'completed',
    timestamp: now,
    summary: 'run completed',
    ...(usage === null ? {} : { usage }),
  };
}

/** Normalise the terminal `result` event into an {@link AgentResult}. */
export function normalizeClaudeResult(raw: unknown, changedFiles: readonly string[]): AgentResult {
  const event = asRecord(raw);

  if (event === null || asString(event['type']) !== 'result') {
    return {
      status: 'failed',
      changedFiles,
      failureType: 'UNKNOWN',
      errorSummary: 'the agent produced no terminal result event',
    };
  }

  const usage = extractUsage(event['usage']);
  const isError = event['is_error'] === true;
  const subtype = asString(event['subtype']);

  if (!isError && (subtype === null || subtype === 'success')) {
    return {
      status: 'completed',
      changedFiles,
      ...(usage === null ? {} : { usage }),
    };
  }

  return {
    status: 'failed',
    changedFiles,
    failureType: classifySubtype(subtype),
    errorSummary: truncate(asString(event['result']) ?? subtype ?? 'run failed'),
    ...(usage === null ? {} : { usage }),
  };
}

/**
 * Map a failure subtype onto RoutePilot's taxonomy (spec section 22).
 *
 * Deliberately conservative: anything not clearly identifiable becomes
 * `UNKNOWN` rather than `MODEL_WEAKNESS`. Only `MODEL_WEAKNESS` may update
 * beliefs about a model's ability, so guessing it would corrupt learning.
 */
export function classifySubtype(subtype: string | null): FailureType {
  if (subtype === null) return 'UNKNOWN';
  const value = subtype.toLowerCase();

  if (value.includes('max_turns') || value.includes('max-turns')) return 'TIMEOUT';
  if (value.includes('budget')) return 'BUDGET_EXCEEDED';
  if (value.includes('cancel') || value.includes('abort')) return 'USER_CANCELLED';
  if (value.includes('context')) return 'CONTEXT_LIMIT';
  if (value.includes('during_execution') || value.includes('error')) return 'TOOL_FAILURE';

  return 'UNKNOWN';
}

/** Token usage, when the payload reports it in the documented shape. */
function extractUsage(raw: unknown): TokenUsage | null {
  const usage = asRecord(raw);
  if (usage === null) return null;

  const input = asNumber(usage['input_tokens']);
  const output = asNumber(usage['output_tokens']);
  if (input === null && output === null) return null;

  const cached =
    asNumber(usage['cache_read_input_tokens']) ?? asNumber(usage['cache_creation_input_tokens']);

  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(cached === null ? {} : { cachedInputTokens: cached }),
  };
}

function firstText(content: readonly unknown[] | null): string | null {
  if (content === null) return null;
  for (const entry of content) {
    const block = asRecord(entry);
    if (block === null) continue;
    if (asString(block['type']) === 'text') {
      const text = asString(block['text']);
      if (text !== null && text.trim() !== '') return text.trim();
    }
  }
  return null;
}

function truncate(text: string): string {
  return text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
