/**
 * `routepilot status` (spec section 48).
 *
 * Answers "is RoutePilot ready to work here, and what can it actually do?"
 * without running a task or spending anything.
 *
 * Credential handling: status reports whether the environment variable a
 * provider names is **set**, never its value. Knowing that
 * `ANTHROPIC_API_KEY` is missing is the whole point of the check; printing it
 * would leak the secret into terminals, CI logs and screenshots
 * (spec sections 34 and 51).
 */

import { ADAPTER_VERIFICATION, describeVerification } from '../adapters/verification.js';
import { CURRENT_SCHEMA_VERSION } from '../telemetry/schema.js';
import { defaultStorageDirectory } from '../telemetry/open.js';
import type { Registries } from '../config/registries.js';
import type { LoadedConfig } from '../config/load.js';
import { toRoutingPolicy } from '../config/policy.js';
import { block, count, duration, money, percent, renderTable } from './format.js';

/** A capability RoutePilot either has or is honest about lacking. */
export interface CapabilityStatus {
  readonly command: string;
  readonly available: boolean;
  /** What is missing, when unavailable. Always names the phase that delivers it. */
  readonly detail: string;
}

/**
 * What the CLI can currently do.
 *
 * Kept as data, and updated as phases land, so that `status` cannot drift into
 * claiming a capability that does not exist (spec section 2, rule 20).
 */
export const CAPABILITIES: readonly CapabilityStatus[] = [
  { command: 'analyze', available: true, detail: 'classify a task and analyse the repository' },
  { command: 'route', available: true, detail: 'choose a model and explain the choice' },
  { command: 'models', available: true, detail: 'list models and determine eligibility' },
  { command: 'providers', available: true, detail: 'list configured providers' },
  { command: 'config', available: true, detail: 'validate configuration' },
  { command: 'calibration', available: true, detail: 'report whether predictions can be believed' },
  { command: 'shadow', available: true, detail: 'compare the live policy against alternatives' },
  {
    command: 'run',
    available: true,
    // Wired to a real adapter in Phase 21 (spec section 74, item 8). It plans
    // by default and executes only under `--execute`, because no adapter has
    // been verified against its tool: the command exists, and the caution about
    // the path it drives is expressed in the default rather than by withholding
    // it (spec section 2, rule 20).
    detail: 'route and run a task; plans unless --execute is given',
  },
  {
    command: 'history',
    available: false,
    // The store is built and migrated; there is simply no command that reads it
    // back as a task list. `calibration` and `shadow` read their own slices.
    detail: 'the telemetry store exists, but no command lists recorded tasks',
  },
  {
    command: 'evaluate',
    available: false,
    // A reason, not a phase number. This line has been wrong twice already,
    // because the phase that would deliver it keeps moving as phases land.
    detail: 'needs offline policy evaluation against recorded outcomes',
  },
];

/** Options for {@link renderStatus}. */
export interface StatusOptions {
  readonly loaded: LoadedConfig;
  readonly registries: Registries;
  /** Environment used for credential presence checks. Injected for testing. */
  readonly env: NodeJS.ProcessEnv;
  /** Reported so a user can tell which build they are running. */
  readonly implementedPhase: number;
}

/** Structured status, for `--json`. */
export function buildStatus(options: StatusOptions): Record<string, unknown> {
  const { loaded, registries, env } = options;
  const policy = toRoutingPolicy(loaded.config);

  return {
    implementedPhase: options.implementedPhase,
    configuration: {
      path: loaded.path,
      source: loaded.sourceKind,
      valid: true,
      providers: registries.providers.size,
      models: registries.models.size,
    },
    providers: registries.providers.list().map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      availability: provider.availability,
      auth: provider.auth.kind,
      // The variable's NAME and whether it is set. Never its value.
      credentialVariable: provider.auth.envVar ?? null,
      credentialPresent: credentialPresent(provider.auth.envVar, env),
    })),
    policy,
    learning: loaded.config.learning,
    telemetry: {
      ...loaded.config.telemetry,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      storageDirectory: loaded.config.telemetry.enabled
        ? (loaded.config.telemetry.storagePath ?? defaultStorageDirectory())
        : null,
    },
    capabilities: CAPABILITIES,
    adapters: ADAPTER_VERIFICATION.map((entry) => ({
      adapterId: entry.adapterId,
      status: entry.status,
      supported: entry.status === 'verified' && entry.evidence !== undefined,
      howToVerify: entry.howToVerify,
      limitations: entry.limitations,
    })),
  };
}

/** Render status for a terminal. */
export function renderStatus(options: StatusOptions): string {
  const { loaded, registries, env } = options;
  const policy = toRoutingPolicy(loaded.config);
  const sections: string[] = [];

  sections.push(`RoutePilot — implemented phase ${String(options.implementedPhase)}`);

  sections.push(
    `Configuration\n${block([
      ['path', loaded.path],
      ['source', loaded.sourceKind],
      ['valid', 'yes'],
      ['providers', count(registries.providers.size)],
      ['models', count(registries.models.size)],
    ])}`,
  );

  if (registries.providers.size > 0) {
    const rows = registries.providers.list().map((provider) => {
      const variable = provider.auth.envVar;
      const credential =
        provider.auth.kind === 'none'
          ? 'not required'
          : variable === undefined
            ? 'not configured'
            : `$${variable} (${credentialPresent(variable, env) ? 'set' : 'NOT SET'})`;

      return [provider.id, provider.kind, provider.availability, provider.auth.kind, credential];
    });

    sections.push(
      `Providers\n${renderTable(['PROVIDER', 'KIND', 'AVAILABILITY', 'AUTH', 'CREDENTIAL'], rows)}`,
    );
  }

  sections.push(
    `Routing policy\n${block([
      ['minimum success', percent(policy.minimumSuccessProbability)],
      ['maximum risk', percent(policy.maxRisk)],
      ['maximum latency', duration(policy.maxLatencySeconds)],
      ['request budget', money(policy.requestBudget, policy.currency)],
      ['if over budget', policy.onBudgetExceeded],
      ['model override', policy.modelOverrideEnabled ? 'enabled' : 'disabled'],
    ])}`,
  );

  const { learning, telemetry, budgets, shadow } = loaded.config;
  sections.push(
    `Budgets and features\n${block([
      ['session budget', money(budgets.session, budgets.currency)],
      ['daily budget', money(budgets.daily, budgets.currency)],
      ['monthly budget', money(budgets.monthly, budgets.currency)],
      ['learning', learning.enabled ? 'enabled' : 'disabled'],
      // Stated whether learning is on or off, because it is the number that
      // decides when learned routing may start influencing anything.
      ['training minimum', `${count(learning.minimumTrainingSamples)} observations per model`],
      [
        'exploration',
        learning.exploration.enabled
          ? `enabled after ${count(learning.exploration.minimumObservations)} observations, ` +
            `risk below ${(learning.exploration.maxRisk * 100).toFixed(0)}%, ` +
            `premium up to ${(learning.exploration.maxCostPremium * 100).toFixed(0)}%`
          : 'disabled',
      ],
      [
        'shadow routing',
        shadow.enabled
          ? `enabled (${shadow.policies.join(', ')}) — evaluated, never executed`
          : 'disabled',
      ],
      ['telemetry', telemetry.enabled ? `enabled (privacy: ${telemetry.privacyMode})` : 'disabled'],
      [
        'telemetry store',
        telemetry.enabled
          ? `${telemetry.storagePath ?? defaultStorageDirectory()} (schema v${String(CURRENT_SCHEMA_VERSION)}, local only)`
          : 'not used',
      ],
    ])}`,
  );

  const adapterRows = ADAPTER_VERIFICATION.map((entry) => [
    entry.adapterId,
    entry.status,
    describeVerification(entry),
  ]);
  sections.push(
    `Agent adapters
${renderTable(['ADAPTER', 'STATUS', 'EVIDENCE'], adapterRows)}

` +
      `  An adapter is "supported" only once it has actually been run against the real
` +
      `  tool. Passing mock tests is not the same thing (spec section 2, rule 20).`,
  );

  const capabilityRows = CAPABILITIES.map((capability) => [
    capability.command,
    capability.available ? 'available' : 'not yet',
    capability.detail,
  ]);
  sections.push(`Capabilities\n${renderTable(['COMMAND', 'STATUS', 'DETAIL'], capabilityRows)}`);

  const missing = registries.providers
    .list()
    .filter(
      (provider) => provider.auth.kind !== 'none' && !credentialPresent(provider.auth.envVar, env),
    );

  if (missing.length > 0) {
    sections.push(
      `Note: ${String(missing.length)} provider(s) have no credential in the environment. ` +
        `Routing and analysis still work — they never call a provider — but ` +
        `"routepilot run --execute" will not.`,
    );
  }

  return sections.join('\n\n');
}

/** Whether the named environment variable holds a non-empty value. */
function credentialPresent(variable: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (variable === undefined) return false;
  const value = env[variable];
  return value !== undefined && value !== '';
}
