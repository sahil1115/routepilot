/**
 * The executor the task runner drives (spec sections 17 and 20).
 *
 * Implements the core's `ExecutorPort` over the agent registry, so the runner
 * gets retry, adapter fallback and provider substitution without knowing any of
 * them exist.
 *
 * It exists rather than the runner calling the registry because `src/core` may
 * not import `src/adapters` -- an architectural test fails the build if it
 * does. That boundary keeps the orchestrator ignorant of which coding agent is
 * installed, and lets the whole pipeline run under a scripted executor with no
 * process spawned.
 *
 * `AgentRegistry.execute` returns a result and discards the event stream, but
 * the execution monitor needs those events -- struggle detection and much of
 * the failure taxonomy are built on them -- so this collects them as they
 * arrive.
 */

import type { AgentEvent, AgentExecutionRequest } from '../core/types/agent.js';
import type { ModelSpec } from '../core/types/model.js';
import type { ExecutorOutcome, ExecutorPort } from '../core/types/run.js';
import type { AgentRegistry, ExecuteOptions } from './registry.js';

/** Options for {@link RegistryExecutor}. */
export interface RegistryExecutorOptions extends ExecuteOptions {
  /**
   * Cap on retained events per execution.
   *
   * A runaway agent can emit tens of thousands of events, and the monitor only
   * needs enough to characterise the run. Beyond the cap, events are counted
   * but not kept, so memory stays bounded on exactly the runs most likely to
   * misbehave.
   */
  readonly maxRetainedEvents?: number | undefined;
}

/** Default retention cap. Generous enough that a normal run is never truncated. */
export const DEFAULT_MAX_RETAINED_EVENTS = 10_000;

/** Runs a request through the agent registry. */
export class RegistryExecutor implements ExecutorPort {
  readonly #registry: AgentRegistry;
  readonly #options: RegistryExecutorOptions;
  readonly #maxEvents: number;

  constructor(registry: AgentRegistry, options: RegistryExecutorOptions = {}) {
    this.#registry = registry;
    this.#options = options;
    this.#maxEvents = options.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS;
  }

  async execute(request: AgentExecutionRequest, model: ModelSpec): Promise<ExecutorOutcome> {
    const events: AgentEvent[] = [];

    const outcome = await this.#registry.execute(request, model, {
      ...this.#options,
      onEvent: (event) => {
        if (events.length < this.#maxEvents) events.push(event);
      },
    });

    return {
      result: outcome.result,
      adapterId: outcome.adapterId,
      events,
      adapterAttempts: outcome.attempts.length,
    };
  }
}
