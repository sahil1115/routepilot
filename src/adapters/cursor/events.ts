/**
 * Cursor CLI event normalisation (spec section 19).
 *
 * Maps `--output-format stream-json` output onto RoutePilot's
 * provider-neutral {@link AgentEvent}, covering the categories the
 * specification names: user messages, assistant messages, tool calls, tool
 * results, file changes, terminal execution, errors, completion, cancellation.
 *
 * **Written from the specification, not from captured output.** `cursor-agent`
 * is not installed here, so no real event has ever been seen. Every field is
 * optional and every unrecognised shape returns `null` — the adapter ignores
 * what it does not understand rather than inventing an interpretation. The two
 * key-naming conventions in circulation (`snake_case` and `camelCase`) are both
 * accepted, since which one the tool emits has not been confirmed.
 */

import type { AgentEvent, AgentResult } from '../../core/types/agent.js';

const MAX_SUMMARY = 200;

/** Parse one stdout line as JSON. Returns null for anything unparseable. */
export function parseLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed === '' || !trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Normalise one Cursor CLI event. */
export function normalizeCursorEvent(raw: unknown, now: number): AgentEvent | null {
  const event = asRecord(raw);
  if (event === null) return null;

  const type = asString(event['type']);
  if (type === null) return null;

  switch (type) {
    case 'user':
    case 'user_message':
      return { kind: 'user-message', timestamp: now };

    case 'assistant':
    case 'assistant_message': {
      const text = textOf(event);
      return {
        kind: 'assistant-message',
        timestamp: now,
        ...(text === null ? {} : { summary: truncate(text) }),
      };
    }

    case 'tool_call':
    case 'tool_use': {
      const tool = asString(event['name']) ?? asString(event['tool']);
      return {
        kind: 'tool-call',
        timestamp: now,
        ...(tool === null ? {} : { tool }),
        summary: tool === null ? 'tool call' : `calling ${tool}`,
      };
    }

    case 'tool_result': {
      const failed = event['is_error'] === true || event['isError'] === true;
      return {
        kind: 'tool-result',
        timestamp: now,
        ok: !failed,
        summary: failed ? 'tool call failed' : 'tool call succeeded',
      };
    }

    case 'file_change':
    case 'file_edit': {
      const path = asString(event['path']) ?? asString(event['file']);
      return {
        kind: 'file-change',
        timestamp: now,
        ...(path === null ? {} : { path: normalisePath(path) }),
        summary: path === null ? 'file changed' : `changed ${normalisePath(path)}`,
      };
    }

    case 'terminal':
    case 'shell': {
      // The command itself is not copied into the event: it can contain
      // secrets, and events are retained (spec section 33).
      const failed = event['is_error'] === true || asNumber(event['exit_code']) !== 0;
      return {
        kind: 'terminal-command',
        timestamp: now,
        ok: !failed,
        summary: 'ran a terminal command',
      };
    }

    case 'error':
      return {
        kind: 'error',
        timestamp: now,
        ok: false,
        summary: truncate(messageOf(event) ?? 'the run reported an error'),
      };

    case 'cancelled':
    case 'aborted':
      return { kind: 'cancelled', timestamp: now, summary: 'the run was cancelled' };

    case 'result':
    case 'done': {
      const failed = event['is_error'] === true || asString(event['subtype']) === 'error';
      return failed
        ? {
            kind: 'error',
            timestamp: now,
            ok: false,
            summary: truncate(messageOf(event) ?? 'the run failed'),
          }
        : { kind: 'completed', timestamp: now, summary: 'run completed' };
    }

    default:
      return null;
  }
}

/** Normalise a terminal event into an {@link AgentResult}. */
export function normalizeCursorResult(raw: unknown, changedFiles: readonly string[]): AgentResult {
  const event = asRecord(raw);

  if (event === null) {
    return {
      status: 'failed',
      changedFiles,
      failureType: 'UNKNOWN',
      errorSummary: 'the agent produced no terminal result event',
    };
  }

  const type = asString(event['type']);
  const failed =
    type === 'error' || event['is_error'] === true || asString(event['subtype']) === 'error';

  if (!failed) return { status: 'completed', changedFiles };

  return {
    status: 'failed',
    changedFiles,
    // Conservative: never MODEL_WEAKNESS from a shape that has not been
    // confirmed, because only that classification updates model beliefs.
    failureType: 'UNKNOWN',
    errorSummary: truncate(messageOf(event) ?? 'the run failed'),
  };
}

/** Text from any of the shapes the tool might use. */
function textOf(event: Record<string, unknown>): string | null {
  const direct = asString(event['text']) ?? asString(event['content']);
  if (direct !== null && direct.trim() !== '') return direct.trim();

  const message = asRecord(event['message']);
  if (message !== null) {
    const nested = asString(message['text']) ?? asString(message['content']);
    if (nested !== null && nested.trim() !== '') return nested.trim();
  }

  const blocks = Array.isArray(event['content']) ? event['content'] : null;
  if (blocks !== null) {
    for (const entry of blocks) {
      const block = asRecord(entry);
      const text = block === null ? null : asString(block['text']);
      if (text !== null && text.trim() !== '') return text.trim();
    }
  }

  return null;
}

function messageOf(event: Record<string, unknown>): string | null {
  return asString(event['message']) ?? asString(event['error']) ?? asString(event['result']);
}

function normalisePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function truncate(text: string): string {
  return text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY)}…`;
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
