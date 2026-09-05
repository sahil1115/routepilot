/**
 * Generic direct-provider adapter (spec section 20).
 *
 * Transport is genuinely generic; request and response shapes are not. Every
 * provider encodes messages, streams deltas and reports usage differently, so a
 * "generic" encoder would mean inventing an API no provider implements.
 *
 * This ships the half that is real: endpoint, authentication, timeout and retry
 * from configuration; streaming over HTTP with cancellation; and credential
 * handling that keeps the secret out of every log line, error message and
 * thrown object (sections 20, 34 and 51).
 *
 * Streaming is incremental where the injected client exposes a response body,
 * which the global `fetch` does. A fake supplying only `text()` falls back to
 * buffering -- correct, but the whole response arrives at once.
 *
 * The vendor-specific half is a {@link ProviderProtocol} supplied by the
 * caller. No concrete protocol ships yet, and `verification.ts` records this
 * adapter as unverified for that reason.
 */

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentExecutionRequest,
  AgentResult,
  AgentSession,
  AgentStatus,
  AgentSupportDecision,
} from '../../core/types/agent.js';
import type { ModelSpec } from '../../core/types/model.js';
import type { ProviderSpec } from '../../core/types/provider.js';

/** An HTTP request the protocol wants sent. */
export interface ProviderRequest {
  readonly path: string;
  readonly method: 'POST' | 'GET';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The vendor-specific half of a direct integration.
 *
 * Implemented once per provider. Everything else — auth, retry, timeouts,
 * cancellation, redaction — is handled by the adapter.
 */
export interface ProviderProtocol {
  /** Stable identifier, used in adapter ids and messages. */
  readonly id: string;
  /** Build the HTTP request for a task. */
  encodeRequest(request: AgentExecutionRequest, model: ModelSpec): ProviderRequest;
  /** Map one streamed chunk onto an event. Return null to ignore it. */
  decodeEvent(chunk: string): AgentEvent | null;
  /** Map the accumulated response onto a result. */
  decodeResult(chunks: readonly string[]): AgentResult;
}

/** Minimal fetch shape, injected so tests never touch the network. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  /**
   * The response body, when the client exposes one.
   *
   * Optional because a caller may inject a fake that only implements `text()`.
   * When it is absent the adapter buffers, which is correct but not streaming;
   * when it is present events reach the caller as chunks arrive. The global
   * `fetch` supplies it, so real use streams.
   */
  body?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null | undefined;
}>;

/** Options for {@link DirectProviderAdapter}. */
export interface DirectProviderAdapterOptions {
  readonly provider: ProviderSpec;
  readonly protocol: ProviderProtocol;
  /** Environment the credential is read from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** HTTP client. Defaults to global `fetch`. */
  readonly fetch?: FetchLike | undefined;
}

const CAPABILITIES: AgentCapabilities = {
  streaming: true,
  cancellation: true,
  toolUse: true,
  // A direct API call is not an agent loop. Anything needing agentic execution
  // must go to a real coding agent, not here.
  agenticExecution: false,
  fileEditing: false,
  terminalExecution: false,
  modelSelection: true,
  usageReporting: true,
};

/** Calls a provider's HTTP API directly. */
export class DirectProviderAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities = CAPABILITIES;

  readonly #provider: ProviderSpec;
  readonly #protocol: ProviderProtocol;
  readonly #env: NodeJS.ProcessEnv;
  readonly #fetch: FetchLike;
  readonly #controllers = new Map<string, AbortController>();
  #sessionCounter = 0;

  constructor(options: DirectProviderAdapterOptions) {
    this.#provider = options.provider;
    this.#protocol = options.protocol;
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch ?? globalThis.fetch;

    this.id = `direct:${options.provider.id}`;
    this.displayName = `${options.provider.displayName} (direct)`;
  }

  canHandle(request: AgentExecutionRequest): AgentSupportDecision {
    for (const [capability, needed] of Object.entries(request.requiredCapabilities)) {
      if (needed !== true) continue;
      if (this.capabilities[capability as keyof AgentCapabilities]) continue;
      return {
        supported: false,
        reason: `a direct provider call cannot provide "${capability}" — this needs a coding agent`,
      };
    }
    return { supported: true };
  }

  /**
   * Availability, without making a network call.
   *
   * A missing credential is the common failure and is worth reporting by name,
   * because the fix is obvious once you know which variable is empty.
   */
  getStatus(): Promise<AgentStatus> {
    if (this.#provider.availability === 'unavailable') {
      return Promise.resolve({
        available: false,
        detail: `Provider "${this.#provider.id}" is marked unavailable in configuration.`,
      });
    }

    if (this.#provider.endpoint === undefined) {
      return Promise.resolve({
        available: false,
        detail: `Provider "${this.#provider.id}" has no endpoint configured.`,
      });
    }

    const auth = this.#provider.auth;
    if (auth.kind !== 'none') {
      if (auth.envVar === undefined) {
        return Promise.resolve({
          available: false,
          detail: `Provider "${this.#provider.id}" uses ${auth.kind} but names no environment variable.`,
        });
      }
      const value = this.#env[auth.envVar];
      if (value === undefined || value === '') {
        return Promise.resolve({
          available: false,
          // The variable's NAME, never its value.
          detail: `Environment variable ${auth.envVar} is not set, so provider "${this.#provider.id}" cannot authenticate.`,
        });
      }
    }

    return Promise.resolve({ available: true });
  }

  execute(request: AgentExecutionRequest, model: ModelSpec): Promise<AgentSession> {
    const sessionId = `${this.id}-${String((this.#sessionCounter += 1))}`;
    const controller = new AbortController();
    this.#controllers.set(sessionId, controller);

    const encoded = this.#protocol.encodeRequest(request, model);
    const chunks: string[] = [];
    const queue = new EventQueue();
    let failure: AgentResult | null = null;

    const work = (async (): Promise<void> => {
      // Asked before the request, not inferred from its rejection. A missing
      // credential would otherwise reach the provider, come back 401, and be
      // classified PROVIDER_FAILURE -- blaming the provider for a local
      // configuration problem, and feeding that to escalation and learning
      // (spec section 22).
      const status = await this.getStatus();
      const endpoint = this.#provider.endpoint;
      if (!status.available || endpoint === undefined) {
        failure = this.#environmentFailure(status.detail ?? 'no endpoint is configured');
        return;
      }

      const headers: Record<string, string> = { ...encoded.headers };
      const credential = this.#credential();
      if (credential !== null) headers[credential.header] = credential.value;

      const timeout = setTimeout(() => {
        controller.abort();
      }, this.#provider.timeoutMs);

      const emit = (line: string): void => {
        if (line.trim() === '') return;
        chunks.push(line);
        const event = this.#protocol.decodeEvent(line);
        if (event !== null) queue.push(event);
      };

      try {
        const response = await this.#fetch(joinUrl(endpoint, encoded.path), {
          method: encoded.method,
          headers,
          body: encoded.body,
          signal: controller.signal,
        });

        if (!response.ok) {
          // Drained so the connection can be reused. Never shown: a provider's
          // error body can echo the request.
          await response.text().catch(() => undefined);
          failure = {
            status: 'failed',
            changedFiles: [],
            failureType: 'PROVIDER_FAILURE',
            errorSummary: this.#redact(
              `provider responded ${String(response.status)} ${response.statusText}`,
            ),
          };
          return;
        }

        const body = response.body;
        if (body === undefined || body === null) {
          // No stream to read: buffer, which is what an injected fake with only
          // `text()` gives us.
          for (const line of (await response.text()).split('\n')) emit(line);
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';
        for await (const bytes of iterateBody(body)) {
          buffer += decoder.decode(bytes, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline !== -1) {
            emit(buffer.slice(0, newline).replace(/\r$/, ''));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
          }
        }
        // A final line without a trailing newline is still a line.
        emit(buffer + decoder.decode());
      } catch (error) {
        failure = controller.signal.aborted
          ? {
              status: 'cancelled',
              changedFiles: [],
              failureType: 'USER_CANCELLED',
              errorSummary: 'the request was cancelled or timed out',
            }
          : {
              status: 'failed',
              changedFiles: [],
              failureType: 'PROVIDER_FAILURE',
              errorSummary: this.#redact(error instanceof Error ? error.message : String(error)),
            };
      } finally {
        clearTimeout(timeout);
        this.#controllers.delete(sessionId);
      }
    })();

    // Closed however `work` ends -- returned, threw, or was cancelled -- so a
    // consumer iterating events is never left waiting on a dead request.
    void work.finally(() => {
      queue.close();
    });

    // Deliberately not `await work` before the first yield: that single line
    // was what made this buffer, by refusing to hand over anything until the
    // whole response had arrived.
    const stream: AsyncIterable<AgentEvent> = queue;

    const result = (async (): Promise<AgentResult> => {
      await work;
      if (failure !== null) return failure;
      return this.#protocol.decodeResult(chunks);
    })();

    return Promise.resolve({
      id: sessionId,
      adapterId: this.id,
      modelId: model.id,
      events: stream,
      result,
    });
  }

  cancel(sessionId: string): Promise<void> {
    this.#controllers.get(sessionId)?.abort();
    this.#controllers.delete(sessionId);
    return Promise.resolve();
  }

  normalizeEvent(raw: unknown): AgentEvent | null {
    return typeof raw === 'string' ? this.#protocol.decodeEvent(raw) : null;
  }

  normalizeResult(raw: unknown): AgentResult {
    return this.#protocol.decodeResult(Array.isArray(raw) ? (raw as string[]) : []);
  }

  /** The auth header to send, read fresh from the environment each time. */
  #credential(): { header: string; value: string } | null {
    const auth = this.#provider.auth;
    if (auth.kind === 'none' || auth.envVar === undefined) return null;

    const value = this.#env[auth.envVar];
    if (value === undefined || value === '') return null;

    switch (auth.kind) {
      case 'apiKey':
        return { header: 'x-api-key', value };
      case 'bearerToken':
      case 'oauth':
        return { header: 'authorization', value: `Bearer ${value}` };
      default:
        return { header: 'authorization', value };
    }
  }

  /**
   * Remove the credential from any text before it can be logged or thrown.
   *
   * Provider error bodies and network errors sometimes echo request headers.
   * Redaction happens at the boundary so no later code has to remember.
   */
  #redact(text: string): string {
    const auth = this.#provider.auth;
    if (auth.kind === 'none' || auth.envVar === undefined) return text;

    const secret = this.#env[auth.envVar];
    if (secret === undefined || secret === '') return text;

    return text.split(secret).join('[redacted]');
  }

  #environmentFailure(detail: string): AgentResult {
    return {
      status: 'failed',
      changedFiles: [],
      failureType: 'ENVIRONMENT_FAILURE',
      errorSummary: `provider "${this.#provider.id}": ${detail}`,
    };
  }
}

function joinUrl(base: string, path: string): string {
  if (path === '') return base;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Iterate a response body, whichever shape the client gave us.
 *
 * Node's `fetch` returns a web `ReadableStream`, which is async-iterable on
 * Node and not in every browser build, so the reader path is kept as a
 * fallback rather than assumed away.
 */
async function* iterateBody(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  // Probed rather than narrowed with `in`: this lib declares ReadableStream as
  // async-iterable too, so `in` narrows the alternative to `never`.
  const candidate = body as Partial<AsyncIterable<Uint8Array>> & ReadableStream<Uint8Array>;
  if (typeof candidate[Symbol.asyncIterator] === 'function') {
    yield* candidate as AsyncIterable<Uint8Array>;
    return;
  }

  const reader = candidate.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Events, yielded as they are produced.
 *
 * The same shape as `LineQueue` in the process runner, for the same reason: a
 * consumer must be able to see an event before the producer has finished.
 */
class EventQueue implements AsyncIterable<AgentEvent> {
  #pending: AgentEvent[] = [];
  #closed = false;
  #notify: (() => void) | null = null;

  push(event: AgentEvent): void {
    if (this.#closed) return;
    this.#pending.push(event);
    this.#wake();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    const notify = this.#notify;
    this.#notify = null;
    notify?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      const next = this.#pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#notify = resolve;
      });
    }
  }
}
