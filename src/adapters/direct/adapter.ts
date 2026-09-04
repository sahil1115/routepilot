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
    const events: AgentEvent[] = [];
    let failure: AgentResult | null = null;

    const work = (async (): Promise<void> => {
      const endpoint = this.#provider.endpoint;
      if (endpoint === undefined) {
        failure = this.#environmentFailure('no endpoint is configured');
        return;
      }

      const headers: Record<string, string> = { ...encoded.headers };
      const credential = this.#credential();
      if (credential !== null) headers[credential.header] = credential.value;

      const timeout = setTimeout(() => {
        controller.abort();
      }, this.#provider.timeoutMs);

      try {
        const response = await this.#fetch(joinUrl(endpoint, encoded.path), {
          method: encoded.method,
          headers,
          body: encoded.body,
          signal: controller.signal,
        });

        const text = await response.text();

        if (!response.ok) {
          failure = {
            status: 'failed',
            changedFiles: [],
            failureType: 'PROVIDER_FAILURE',
            // Redacted: a provider's error body can echo the request.
            errorSummary: this.#redact(
              `provider responded ${String(response.status)} ${response.statusText}`,
            ),
          };
          return;
        }

        for (const line of text.split('\n')) {
          if (line.trim() === '') continue;
          chunks.push(line);
          const event = this.#protocol.decodeEvent(line);
          if (event !== null) events.push(event);
        }
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

    const stream: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        await work;
        for (const event of events) yield event;
      },
    };

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
