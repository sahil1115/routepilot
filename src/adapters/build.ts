/**
 * Config to agent registry (spec section 74, item 8).
 *
 * Turns a configuration into the concrete adapters a run will use, mirroring
 * what `src/config/registries.ts` does for models and providers.
 *
 * `build` probes each adapter with `getStatus()` and reports what it found.
 * Nothing is filtered out silently -- an unavailable adapter comes back with
 * the reason, so the CLI can print actionable guidance rather than "no adapter"
 * (spec section 19).
 *
 * Availability is not verification: it means the binary answered a version
 * probe, not that a task has ever run through it. `verification.ts` remains the
 * authority there and is deliberately not consulted here -- this module reports
 * facts, and the CLI decides what to allow.
 */

import type { AgentAdapter, AgentStatus } from '../core/types/agent.js';

import { ClaudeCodeAdapter } from './claude-code/adapter.js';
import { CursorCliAdapter } from './cursor/adapter.js';
import { AgentRegistry } from './registry.js';

/** What one adapter reported when asked. */
export interface AdapterProbe {
  readonly adapter: AgentAdapter;
  readonly status: AgentStatus;
}

/** The result of probing every buildable adapter. */
export interface BuiltAdapters {
  /** A registry containing only the adapters that reported themselves usable. */
  readonly registry: AgentRegistry;
  /** Every adapter that was probed, available or not, in a stable order. */
  readonly probes: readonly AdapterProbe[];
}

/** Options for {@link buildAdapters}. */
export interface BuildAdaptersOptions {
  /**
   * Restrict the build to a single adapter id.
   *
   * An unknown id yields an empty result rather than an error, so the caller
   * can report it alongside the ids that do exist.
   */
  readonly only?: string | undefined;
  /**
   * Per-adapter settings, keyed by adapter id.
   *
   * Until Phase 25 every adapter was constructed with no arguments at all, so
   * `permissionMode` -- declared, plumbed and documented -- was never set, and
   * `--permission-mode` never reached the CLI.
   */
  readonly agents?: Readonly<Partial<Record<string, AgentOptions>>> | undefined;
}

/**
 * Adapters that can be constructed without configuration.
 *
 * `DirectProviderAdapter` is deliberately absent: it needs provider
 * credentials, and constructing it here would mean reading secrets in a
 * function whose job is to answer "what is installed". A run that wants it must
 * build it explicitly.
 *
 * The order is the fallback order — it is preserved into the registry, and the
 * registry tries adapters in registration order.
 */
const BUILDABLE: readonly ((options: AgentOptions) => AgentAdapter)[] = [
  (options) => new ClaudeCodeAdapter(options),
  (options) => new CursorCliAdapter(options),
];

/** Settings a caller may hand an adapter. Every field is optional. */
export interface AgentOptions {
  readonly permissionMode?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly commandArgs?: readonly string[] | undefined;
  readonly command?: string | undefined;
}

/**
 * Probe every buildable adapter and register the usable ones.
 *
 * Probes run concurrently: each spawns a short-lived process, and doing them in
 * sequence would make startup the sum of every agent's launch time rather than
 * the slowest one.
 */
export async function buildAdapters(options: BuildAdaptersOptions = {}): Promise<BuiltAdapters> {
  // Built twice: once with no options to learn each adapter's id, then again
  // with that adapter's settings. Cheap, and it keeps the id the single source
  // of truth rather than duplicating it in a lookup table.
  const candidates = BUILDABLE.map((make) => {
    const id = make({}).id;
    return make(options.agents?.[id] ?? {});
  }).filter((adapter) => options.only === undefined || adapter.id === options.only);

  const probes = await Promise.all(
    candidates.map(async (adapter): Promise<AdapterProbe> => {
      try {
        return { adapter, status: await adapter.getStatus() };
      } catch (error) {
        // A throwing probe is an unavailable adapter, not a crashed CLI. The
        // message is the adapter's own and is safe to show; nothing here has
        // seen a credential.
        return {
          adapter,
          status: {
            available: false,
            detail: `status probe failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    }),
  );

  const registry = new AgentRegistry();
  for (const probe of probes) {
    if (probe.status.available) registry.register(probe.adapter);
  }

  return { registry, probes };
}

/** Ids of every adapter this module knows how to build. */
export function buildableAdapterIds(): readonly string[] {
  return BUILDABLE.map((make) => make({}).id);
}
