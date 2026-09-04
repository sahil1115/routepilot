/**
 * Agent registry: selection, retry and fallback (spec sections 6 and 17).
 *
 * The router picks a model; this picks the adapter that runs it, and handles
 * the two recovery behaviours that belong at the transport level: retry, the
 * same adapter again for transient-looking failures, bounded and with backoff;
 * and fallback, a different adapter when this one cannot run at all.
 *
 * Neither is escalation, which changes the model because the model was not good
 * enough. Retry and fallback never change the model and never conclude anything
 * about it -- a provider outage says nothing about a model's ability -- so
 * these paths classify failures as `PROVIDER_FAILURE` or `ENVIRONMENT_FAILURE`,
 * never `MODEL_WEAKNESS` (section 22).
 */

import type {
  AgentAdapter,
  AgentEvent,
  AgentExecutionRequest,
  AgentResult,
  AgentSession,
} from '../core/types/agent.js';
import type { FailureType } from '../core/types/failure.js';
import type { ModelSpec } from '../core/types/model.js';
import { verificationFor, type VerificationStatus } from './verification.js';

/** Thrown when the registry is asked for something impossible. */
export class AdapterRegistryError extends Error {
  override readonly name = 'AdapterRegistryError';
}

/** Why an adapter was not chosen. */
export interface AdapterRejection {
  readonly adapterId: string;
  readonly reason: string;
}

/** The outcome of choosing an adapter. */
export interface AdapterSelection {
  readonly adapter: AgentAdapter | null;
  readonly rejected: readonly AdapterRejection[];
}

/** Failure classifications worth retrying on the same adapter. */
const RETRYABLE: ReadonlySet<FailureType> = new Set<FailureType>([
  'PROVIDER_FAILURE',
  'ENVIRONMENT_FAILURE',
  'TOOL_FAILURE',
  'FLAKY_TEST',
]);

/** Retry behaviour. */
export interface RetryPolicy {
  /** Total attempts including the first. */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly backoffMultiplier: number;
  readonly maxDelayMs: number;
}

/** A conservative default: one retry, briefly delayed. */
export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 2,
  initialDelayMs: 250,
  backoffMultiplier: 2,
  maxDelayMs: 5_000,
};

/** One attempt made while executing. */
export interface AttemptRecord {
  readonly adapterId: string;
  readonly attempt: number;
  readonly result: AgentResult;
}

/** The outcome of executing through the registry. */
export interface ExecutionOutcome {
  readonly result: AgentResult;
  /** The adapter that produced the final result, if any ran. */
  readonly adapterId: string | null;
  /** Every attempt made, including the ones that failed. */
  readonly attempts: readonly AttemptRecord[];
  /** Adapters skipped before execution, with reasons. */
  readonly rejected: readonly AdapterRejection[];
}

/** Options for {@link AgentRegistry.execute}. */
export interface ExecuteOptions {
  readonly retry?: RetryPolicy | undefined;
  /** Try other adapters when the preferred one cannot run. Defaults to true. */
  readonly allowFallback?: boolean | undefined;
  /** Prefer this adapter, if it can handle the request. */
  readonly preferredAdapterId?: string | undefined;
  /** Sleep function, injected so retry tests do not actually wait. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called for every normalised event as it arrives.
   *
   * Without this the event stream is consumed and discarded, which silently
   * disables the execution monitor: struggle detection and much of the failure
   * taxonomy are built on these events, and a run with none looks identical to
   * a run that did nothing.
   */
  readonly onEvent?: ((event: AgentEvent) => void) | undefined;
}

/** Registry of agent adapters. */
export class AgentRegistry {
  readonly #adapters = new Map<string, AgentAdapter>();

  constructor(adapters: readonly AgentAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  get size(): number {
    return this.#adapters.size;
  }

  /** Add an adapter. Refuses to silently replace one. */
  register(adapter: AgentAdapter): void {
    if (this.#adapters.has(adapter.id)) {
      throw new AdapterRegistryError(
        `Adapter "${adapter.id}" is already registered. Use upsert() to replace it.`,
      );
    }
    this.#adapters.set(adapter.id, adapter);
  }

  /** Add an adapter, replacing any existing one with the same id. */
  upsert(adapter: AgentAdapter): void {
    this.#adapters.set(adapter.id, adapter);
  }

  remove(id: string): boolean {
    return this.#adapters.delete(id);
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  get(id: string): AgentAdapter | undefined {
    return this.#adapters.get(id);
  }

  /** All adapters, ordered by id for deterministic selection. */
  list(): AgentAdapter[] {
    return [...this.#adapters.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** What is known about an adapter actually working (spec section 2, rule 20). */
  verificationStatus(id: string): VerificationStatus {
    return verificationFor(id)?.status ?? 'unverified';
  }

  /**
   * Choose an adapter for a request.
   *
   * A preferred adapter wins if it can handle the request and is available.
   * Otherwise adapters are tried in id order, and every rejection is recorded
   * so the caller can explain what happened.
   */
  async select(
    request: AgentExecutionRequest,
    options: { preferredAdapterId?: string | undefined; allowFallback?: boolean | undefined } = {},
  ): Promise<AdapterSelection> {
    const rejected: AdapterRejection[] = [];

    const ordered = this.#candidateOrder(options.preferredAdapterId);

    if (options.preferredAdapterId !== undefined && !this.has(options.preferredAdapterId)) {
      rejected.push({
        adapterId: options.preferredAdapterId,
        reason: `no adapter with id "${options.preferredAdapterId}" is registered`,
      });
    }

    for (const adapter of ordered) {
      const decision = adapter.canHandle(request);
      if (!decision.supported) {
        rejected.push({
          adapterId: adapter.id,
          reason: decision.reason ?? 'cannot handle this request',
        });
        continue;
      }

      const status = await adapter.getStatus();
      if (!status.available) {
        rejected.push({
          adapterId: adapter.id,
          reason: status.detail ?? 'not available',
        });
        continue;
      }

      return { adapter, rejected };
    }

    return { adapter: null, rejected };
  }

  /**
   * Execute a request, retrying transient failures and falling back when an
   * adapter cannot run at all.
   */
  async execute(
    request: AgentExecutionRequest,
    model: ModelSpec,
    options: ExecuteOptions = {},
  ): Promise<ExecutionOutcome> {
    const retry = options.retry ?? DEFAULT_RETRY;
    const sleep = options.sleep ?? defaultSleep;
    const allowFallback = options.allowFallback ?? true;

    const selection = await this.select(request, {
      ...(options.preferredAdapterId === undefined
        ? {}
        : { preferredAdapterId: options.preferredAdapterId }),
      allowFallback,
    });

    if (selection.adapter === null) {
      return {
        result: {
          status: 'failed',
          changedFiles: [],
          // No adapter could run: an environment problem, never the model's fault.
          failureType: 'ENVIRONMENT_FAILURE',
          errorSummary: describeNoAdapter(selection.rejected),
        },
        adapterId: null,
        attempts: [],
        rejected: selection.rejected,
      };
    }

    const adapter = selection.adapter;
    const attempts: AttemptRecord[] = [];
    let delay = retry.initialDelayMs;

    for (let attempt = 1; attempt <= Math.max(1, retry.maxAttempts); attempt += 1) {
      const result = await runOnce(adapter, request, model, options.onEvent);
      attempts.push({ adapterId: adapter.id, attempt, result });

      if (result.status === 'completed' || result.status === 'cancelled') {
        return { result, adapterId: adapter.id, attempts, rejected: selection.rejected };
      }

      const retryable =
        result.failureType !== undefined &&
        RETRYABLE.has(result.failureType) &&
        attempt < retry.maxAttempts;

      if (!retryable) {
        return { result, adapterId: adapter.id, attempts, rejected: selection.rejected };
      }

      await sleep(delay);
      delay = Math.min(retry.maxDelayMs, delay * retry.backoffMultiplier);
    }

    const last = attempts[attempts.length - 1];
    return {
      result: last?.result ?? {
        status: 'failed',
        changedFiles: [],
        failureType: 'UNKNOWN',
        errorSummary: 'no attempt produced a result',
      },
      adapterId: adapter.id,
      attempts,
      rejected: selection.rejected,
    };
  }

  /** Preferred adapter first, then the rest in deterministic id order. */
  #candidateOrder(preferredAdapterId: string | undefined): AgentAdapter[] {
    const all = this.list();
    if (preferredAdapterId === undefined) return all;

    const preferred = this.#adapters.get(preferredAdapterId);
    if (preferred === undefined) return all;

    return [preferred, ...all.filter((adapter) => adapter.id !== preferredAdapterId)];
  }
}

/** Run one attempt, converting a thrown error into a classified result. */
async function runOnce(
  adapter: AgentAdapter,
  request: AgentExecutionRequest,
  model: ModelSpec,
  onEvent?: (event: AgentEvent) => void,
): Promise<AgentResult> {
  try {
    const session = await adapter.execute(request, model);

    if (onEvent === undefined) return await session.result;

    // Drain the stream alongside the result rather than before it. Awaiting the
    // events first would deadlock against an adapter that only settles its
    // result once the consumer has finished, and awaiting the result first
    // would lose every event.
    const drained = (async () => {
      for await (const event of session.events) onEvent(event);
    })().catch(() => {
      // A stream that fails mid-run must not mask the result, which carries
      // the adapter's own account of what went wrong.
    });

    const [result] = await Promise.all([session.result, drained]);
    return result;
  } catch (error) {
    return {
      status: 'failed',
      changedFiles: [],
      // The adapter threw rather than reporting: a transport problem.
      failureType: 'PROVIDER_FAILURE',
      errorSummary: error instanceof Error ? error.message : String(error),
    };
  }
}

function describeNoAdapter(rejected: readonly AdapterRejection[]): string {
  if (rejected.length === 0) return 'no agent adapters are registered';
  const details = rejected.map((entry) => `${entry.adapterId}: ${entry.reason}`).join('; ');
  return `no agent adapter could run this request — ${details}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Re-exported so callers can build a session type without importing core directly. */
export type { AgentSession };
