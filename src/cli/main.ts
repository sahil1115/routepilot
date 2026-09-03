#!/usr/bin/env node
/**
 * RoutePilot CLI (spec section 48).
 *
 * The CLI is the primary interface. RoutePilot must be fully usable from a
 * terminal — no VS Code, no editor, no GUI — so that the router can be
 * exercised, scripted and debugged on its own. The VS Code extension arrives in
 * Phase 14 and will be a thin layer over exactly these operations.
 *
 * Commands that later phases will deliver (`run`, `history`, `evaluate`) are
 * recognised and answered with what they need, rather than falling through to
 * "unknown command". Claiming a capability that does not exist is worse than
 * lacking it (spec section 2, rule 20).
 *
 * `run()` takes its output sinks as arguments so tests drive it directly.
 */

import { pathToFileURL } from 'node:url';

import { ConfigurationError } from '../config/errors.js';
import { loadConfig, type LoadedConfig } from '../config/load.js';
import { buildRegistries } from '../config/registries.js';
import { TaskClassifier } from '../core/analysis/task-classifier.js';
import type { AnalysisLevel } from '../core/types/analysis.js';
import type { ModelRequirements } from '../core/types/eligibility.js';
import {
  MODEL_CAPABILITY_KEYS,
  MODEL_TIERS,
  type ModelCapabilities,
  type ModelSpec,
  type ModelTier,
} from '../core/types/model.js';
import type { ProviderSpec } from '../core/types/provider.js';
import type { RoutingPolicy } from '../core/types/routing.js';
import { IMPLEMENTED_PHASE, PRODUCT_NAME, VERSION } from '../index.js';
import { analyzeTask, chooseAnalysisLevel, renderAnalysis } from './analyze.js';
import { ArgumentError, integerValue, listValue, parseArgs, singleValue } from './args.js';
import {
  EXIT_CODE_DESCRIPTIONS,
  EXIT_ERROR,
  EXIT_NO_MODEL,
  EXIT_OK,
  EXIT_USAGE,
} from './exit-codes.js';
import { count, renderTable } from './format.js';
import { renderRun, runTask, type RunCommandResult } from './run.js';
import { OPERATION_MODES, type OperationMode } from '../core/bandit/exploration-gate.js';
import { openTelemetryStore } from '../telemetry/open.js';
import { assessAll, renderCalibration } from './calibration.js';
import { buildShadowReport, renderShadowReport } from './shadow.js';
import { toShadowRecords } from '../core/shadow/shadow-router.js';
import { stableHash } from '../telemetry/redaction.js';
import { CALIBRATION_WINDOW, renderDecision, routeTask, SHADOW_WINDOW } from './route.js';
import { buildStatus, CAPABILITIES, renderStatus } from './status.js';

export { EXIT_ERROR, EXIT_NO_MODEL, EXIT_OK, EXIT_USAGE };

/** Output sinks, injected so tests can capture them. */
export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

/** Flags that take a value. Everything else is boolean. */
const VALUE_FLAGS = new Set([
  'config',
  'root',
  'level',
  'active-file',
  'file',
  'context',
  'output-tokens',
  'require',
  'tier',
  'provider',
  'exclude',
  'opt-in',
  'model',
  'budget',
  'min-success',
  'mode',
  'adapter',
]);

const USAGE = `${PRODUCT_NAME} — choose the cheapest path to success.

RoutePilot runs entirely from the terminal. No editor required.

Usage:
  routepilot route "<task>"         Choose a model for a task and explain why
  routepilot run "<task>"           Route a task and run it (plans unless --execute)
  routepilot analyze "<task>"       Classify a task and analyse the repository
  routepilot models [options]       List configured models, or filter by eligibility
  routepilot providers [options]    List configured providers
  routepilot config validate        Validate the configuration and report problems
  routepilot status                 Show configuration, policy and what is available
  routepilot calibration            Report whether success predictions can be believed
  routepilot shadow                 Compare the live policy against alternatives
  routepilot help                   Show this message

Common options:
  --config <path>         Configuration file (else $ROUTEPILOT_CONFIG, else discovery)
  --json                  Emit JSON instead of tables
  --version               Print the version and the implemented phase

Options for "route" and "analyze":
  --root <path>           Workspace to analyse (default: current directory)
  --level <1|2|3>         Analysis depth (default: chosen from the task)
  --active-file <path>    File the user is working in
  --file <path>           File referenced by the task; repeatable

Options for "route":
  --model <id>            Use this model explicitly
  --budget <amount>       Request budget for this task
  --min-success <0..1>    Minimum acceptable success probability
  --mode <normal|production|critical>
                          Where this runs. Defaults to production, which
                          forbids exploration (spec section 40).
  --explain               Also print the provider-neutral explanation

Eligibility filters (for "models"):
  --context <tokens>      Input tokens the request must fit
  --output-tokens <n>     Output tokens the request needs room for
  --require <capability>  Required capability; repeatable or comma-separated
                          (${MODEL_CAPABILITY_KEYS.join(', ')})
  --tier <tier>           Restrict to tiers; repeatable (${MODEL_TIERS.join(', ')})
  --provider <id>         Restrict to providers; repeatable
  --exclude <model-id>    Exclude a model; repeatable
  --opt-in <model-id>     Opt into a model that requires explicit opt-in; repeatable
  --no-degraded           Exclude models whose availability is degraded
  --eligible-only         Show only eligible models, omitting the exclusion list
  --show-excluded         Show excluded models and the reason for each

Exit codes:
${EXIT_CODE_DESCRIPTIONS.map(([code, text]) => `  ${String(code)}  ${text}`).join('\n')}

Not yet available (see "routepilot status"):
${CAPABILITIES.filter((c) => !c.available)
  .map((c) => `  ${c.command.padEnd(10)}${c.detail}`)
  .join('\n')}
`;

/**
 * Execute one CLI invocation.
 *
 * @param argv Arguments after the node executable and script path.
 * @returns Process exit code. Expected failures are reported, not thrown.
 */
export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCli(argv);
  } catch (error) {
    io.err(`${describeError(error)}\n\nRun "routepilot help" for usage.`);
    return EXIT_USAGE;
  }

  const command = args.positionals[0] ?? 'help';

  // Version is checked before help, because `command` defaults to `help` when
  // no positional is given -- so a bare `--version` fell into the help branch
  // and printed the whole usage text instead of a version.
  if (command === 'version' || args.flags.has('version')) {
    io.out(`${PRODUCT_NAME} ${VERSION} (implemented phase ${String(IMPLEMENTED_PHASE)})`);
    return EXIT_OK;
  }

  if (command === 'help' || args.flags.has('help')) {
    io.out(USAGE);
    return EXIT_OK;
  }

  const unavailable = CAPABILITIES.find((c) => c.command === command && !c.available);
  if (unavailable !== undefined) {
    io.err(
      `"routepilot ${command}" is not available yet: ${unavailable.detail}.\n` +
        `Run "routepilot status" to see what this build can do.`,
    );
    return EXIT_ERROR;
  }

  try {
    switch (command) {
      case 'route':
        return await commandRoute(args, io);
      case 'run':
        return await commandRun(args, io);
      case 'analyze':
        return await commandAnalyze(args, io);
      case 'models':
        return await commandModels(args, io);
      case 'providers':
        return await commandProviders(args, io);
      case 'config':
        return await commandConfig(args, io);
      case 'status':
        return await commandStatus(args, io);
      case 'calibration':
        return await commandCalibration(args, io);
      case 'shadow':
        return await commandShadow(args, io);
      default:
        io.err(`Unknown command "${command}".\n\n${USAGE}`);
        return EXIT_USAGE;
    }
  } catch (error) {
    io.err(describeError(error));
    return error instanceof ArgumentError ? EXIT_USAGE : EXIT_ERROR;
  }
}

/**
 * `routepilot run` — the MVP spine, driven from the terminal (spec section 74).
 *
 * Routing is shared with `route` rather than repeated, so the model this
 * command names in its plan is provably the model it would execute.
 *
 * It plans by default. `--execute` is the deliberate act, because no adapter
 * has been verified against its real tool and an accidental invocation would
 * hand a coding agent write access to a workspace.
 */
async function commandRun(args: CliArgs, io: CliIO): Promise<number> {
  const prompt = taskFrom(args);
  if (prompt === null) {
    io.err('run requires a task, for example: routepilot run "fix the failing test"');
    return EXIT_USAGE;
  }

  const loaded = await load(args, io);
  const root = args.root ?? process.cwd();

  const overrides: Partial<RoutingPolicy> = {
    ...(args.budget === undefined ? {} : { requestBudget: args.budget }),
    ...(args.minSuccess === undefined ? {} : { minimumSuccessProbability: args.minSuccess }),
  };

  const route = await routeTask({
    prompt,
    root,
    level: args.level ?? chooseAnalysisLevel(new TaskClassifier().classify({ prompt })),
    config: loaded.config,
    ...(args.activeFile === undefined ? {} : { activeFile: args.activeFile }),
    ...(args.files.length === 0 ? {} : { referencedFiles: args.files }),
    ...(args.model === undefined ? {} : { requestedModelId: args.model }),
    ...(Object.keys(overrides).length === 0 ? {} : { policyOverrides: overrides }),
    ...(args.mode === undefined ? {} : { operationMode: args.mode }),
  });

  // The store is opened for a run that will execute, because that is the only
  // path that produces an outcome worth recording. A plan changes nothing and
  // has nothing to say.
  const store =
    args.execute && loaded.config.telemetry.enabled
      ? await openTelemetryStore({
          enabled: loaded.config.telemetry.enabled,
          ...(loaded.config.telemetry.storagePath === undefined
            ? {}
            : { storagePath: loaded.config.telemetry.storagePath }),
          workspaceRoot: root,
          onProblem: (message) => {
            io.err(`Note: ${message}`);
          },
        })
      : undefined;

  const result = await runTask({
    route,
    config: loaded.config,
    workspaceRoot: root,
    task: prompt,
    execute: args.execute,
    ...(store === undefined ? {} : { store }),
    onProblem: (message) => {
      io.err(`Note: ${message}`);
    },
    ...(args.adapter === undefined ? {} : { adapterId: args.adapter }),
    ...(args.model === undefined ? {} : { requestedModelId: args.model }),
  });

  if (args.flags.has('json')) {
    io.out(
      JSON.stringify(
        {
          configPath: loaded.path,
          decision: result.route.decision,
          refusal: result.refusal,
          run: result.run,
        },
        null,
        2,
      ),
    );
  } else {
    io.out(renderRun(result));
  }

  store?.close();

  return exitCodeForRun(result);
}

/**
 * Map a run onto an exit code.
 *
 * A plan is a success: the user asked what would happen and was told. A refusal
 * to execute is not — it means the user asked for execution and did not get it,
 * and a script needs to be able to tell those apart.
 */
function exitCodeForRun(result: RunCommandResult): number {
  if (result.run !== null) {
    return result.run.outcome === 'succeeded' ? EXIT_OK : EXIT_ERROR;
  }

  switch (result.refusal) {
    case 'plan-only':
      return EXIT_OK;
    case 'no-model':
      return EXIT_NO_MODEL;
    default:
      return EXIT_ERROR;
  }
}

async function commandRoute(args: CliArgs, io: CliIO): Promise<number> {
  const prompt = taskFrom(args);
  if (prompt === null) {
    io.err('route requires a task, for example: routepilot route "fix the failing test"');
    return EXIT_USAGE;
  }

  const loaded = await load(args, io);

  const overrides: Partial<RoutingPolicy> = {
    ...(args.budget === undefined ? {} : { requestBudget: args.budget }),
    ...(args.minSuccess === undefined ? {} : { minimumSuccessProbability: args.minSuccess }),
  };

  // Learned statistics and shadow decisions live in the same local store as
  // telemetry. It is opened when **either** feature needs it — they are
  // independent, and gating the store on learning alone silently stopped
  // shadow routing recording anything.
  const needsStore = loaded.config.learning.enabled || loaded.config.shadow.enabled;
  const learningStore = needsStore
    ? await openTelemetryStore({
        enabled: loaded.config.telemetry.enabled,
        ...(loaded.config.telemetry.storagePath === undefined
          ? {}
          : { storagePath: loaded.config.telemetry.storagePath }),
        workspaceRoot: args.root ?? process.cwd(),
        onProblem: (message) => {
          io.err(`Note: ${message}`);
        },
      })
    : undefined;

  const result = await routeTask({
    prompt,
    root: args.root ?? process.cwd(),
    ...(learningStore === undefined ? {} : { learningStore }),
    level: args.level ?? chooseAnalysisLevel(new TaskClassifier().classify({ prompt })),
    config: loaded.config,
    ...(args.activeFile === undefined ? {} : { activeFile: args.activeFile }),
    ...(args.files.length === 0 ? {} : { referencedFiles: args.files }),
    ...(args.model === undefined ? {} : { requestedModelId: args.model }),
    ...(Object.keys(overrides).length === 0 ? {} : { policyOverrides: overrides }),
    ...(args.mode === undefined ? {} : { operationMode: args.mode }),
  });

  // Shadow decisions are recorded, never executed. The request id is a stable
  // hash of the task and workspace, so re-running the same `routepilot route`
  // replaces its row rather than inflating the agreement statistics.
  if (result.shadow !== null && learningStore !== undefined) {
    learningStore.recordShadowDecisions(
      toShadowRecords(
        result.shadow,
        stableHash(`${args.root ?? process.cwd()}::${prompt}`),
        Date.now(),
      ),
    );
  }

  learningStore?.close();

  if (args.flags.has('json')) {
    io.out(
      JSON.stringify(
        {
          configPath: loaded.path,
          classification: result.analysis.classification,
          features: result.analysis.features,
          decision: result.decision,
        },
        null,
        2,
      ),
    );
  } else {
    io.out(renderDecision(result, { explain: args.flags.has('explain') }));
  }

  return exitCodeFor(result.decision);
}

/**
 * Map a routing outcome onto an exit code.
 *
 * The distinction that matters to a script: naming a model that does not exist
 * is a mistake to fix (EXIT_ERROR), whereas the router examining the candidates
 * and declining is a legitimate result that a caller can respond to by
 * relaxing the policy (EXIT_NO_MODEL).
 */
function exitCodeFor(decision: { selectedModelId: string | null; outcome: string }): number {
  if (decision.selectedModelId !== null) return EXIT_OK;
  return decision.outcome === 'explicit-model-unknown' ? EXIT_ERROR : EXIT_NO_MODEL;
}

async function commandAnalyze(args: CliArgs, io: CliIO): Promise<number> {
  const prompt = taskFrom(args);
  if (prompt === null) {
    io.err('analyze requires a task, for example: routepilot analyze "fix the failing test"');
    return EXIT_USAGE;
  }

  const result = await analyzeTask({
    prompt,
    root: args.root ?? process.cwd(),
    level: args.level ?? chooseAnalysisLevel(new TaskClassifier().classify({ prompt })),
    ...(args.activeFile === undefined ? {} : { activeFile: args.activeFile }),
    ...(args.files.length === 0 ? {} : { referencedFiles: args.files }),
  });

  if (args.flags.has('json')) {
    io.out(
      JSON.stringify(
        {
          classification: result.classification,
          features: result.features,
          repository: {
            level: result.snapshot.level,
            level1: result.snapshot.level1,
            level2: result.snapshot.level2,
            level3: result.snapshot.level3,
            cache: result.snapshot.cache,
          },
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  io.out(renderAnalysis(result));
  return EXIT_OK;
}

async function commandModels(args: CliArgs, io: CliIO): Promise<number> {
  const loaded = await load(args, io);
  const { models } = buildRegistries(loaded.config);

  const filtered = hasAnyFilter(args);

  // An unfiltered `models` call is a plain inventory: it must show every
  // configured model. Running the eligibility filter here would silently hide
  // models that are merely gated (opt-in, degraded) and make the count in the
  // heading disagree with the rows beneath it.
  const result = filtered
    ? models.findEligible(buildRequirements(args))
    : { eligible: models.list(), excluded: [] };

  if (args.flags.has('json')) {
    io.out(
      JSON.stringify(
        {
          configPath: loaded.path,
          configSource: loaded.sourceKind,
          filtered,
          eligible: result.eligible.map(describeModel),
          excluded: result.excluded,
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  if (models.size === 0) {
    io.out('No models are configured.');
    return EXIT_OK;
  }

  io.out(
    filtered
      ? `Eligible models (${String(result.eligible.length)} of ${String(models.size)})`
      : `Configured models (${String(models.size)})`,
  );
  io.out(renderModelTable(result.eligible));

  const showExcluded =
    args.flags.has('show-excluded') || (filtered && !args.flags.has('eligible-only'));
  if (showExcluded && result.excluded.length > 0) {
    io.out(`\nExcluded (${String(result.excluded.length)}):`);
    for (const exclusion of result.excluded) {
      io.out(`  ${exclusion.modelId}  [${exclusion.reason}]`);
      io.out(`    ${exclusion.detail}`);
    }
  }

  if (filtered && result.eligible.length === 0) {
    io.out('\nNo model satisfies these requirements.');
  }

  return EXIT_OK;
}

async function commandProviders(args: CliArgs, io: CliIO): Promise<number> {
  const loaded = await load(args, io);
  const { providers } = buildRegistries(loaded.config);

  if (args.flags.has('json')) {
    io.out(JSON.stringify({ configPath: loaded.path, providers: providers.list() }, null, 2));
    return EXIT_OK;
  }

  if (providers.size === 0) {
    io.out('No providers are configured.');
    return EXIT_OK;
  }

  io.out(`Configured providers (${String(providers.size)})`);
  io.out(renderProviderTable(providers.list()));
  return EXIT_OK;
}

/**
 * `routepilot calibration`.
 *
 * Read-only. Opens the local store regardless of whether learning is enabled,
 * because "how well were my predictions doing?" is a fair question to ask
 * before deciding whether to switch learning on.
 */
async function commandCalibration(args: CliArgs, io: CliIO): Promise<number> {
  const loaded = await load(args, io);
  const { telemetry } = loaded.config;

  if (!telemetry.enabled) {
    io.out(
      [
        'Telemetry is disabled, so no predictions have been recorded and',
        'calibration cannot be measured. Routing uses configured priors, which',
        'is a supported way to operate.',
      ].join('\n'),
    );
    return EXIT_OK;
  }

  const store = await openTelemetryStore({
    enabled: true,
    ...(telemetry.storagePath === undefined ? {} : { storagePath: telemetry.storagePath }),
    workspaceRoot: args.root ?? process.cwd(),
    onProblem: (message) => {
      io.err(`Note: ${message}`);
    },
  });

  const predictions = store.loadPredictions(CALIBRATION_WINDOW);
  store.close();

  const result = assessAll(predictions, loaded.config);

  if (args.flags.has('json')) {
    io.out(JSON.stringify(result, null, 2));
    return EXIT_OK;
  }

  io.out(renderCalibration(result));
  return EXIT_OK;
}

/**
 * `routepilot shadow`.
 *
 * Read-only. Reports what alternative policies would have chosen over the
 * recorded history; nothing here executes anything.
 */
async function commandShadow(args: CliArgs, io: CliIO): Promise<number> {
  const loaded = await load(args, io);
  const { telemetry, shadow } = loaded.config;

  if (!telemetry.enabled) {
    io.out(
      [
        'Telemetry is disabled, so no shadow decisions have been recorded.',
        'Shadow routing needs somewhere to write its comparisons.',
      ].join('\n'),
    );
    return EXIT_OK;
  }

  const store = await openTelemetryStore({
    enabled: true,
    ...(telemetry.storagePath === undefined ? {} : { storagePath: telemetry.storagePath }),
    workspaceRoot: args.root ?? process.cwd(),
    onProblem: (message) => {
      io.err(`Note: ${message}`);
    },
  });

  const records = store.loadShadowDecisions(SHADOW_WINDOW);
  store.close();

  const report = buildShadowReport(records);

  if (args.flags.has('json')) {
    io.out(JSON.stringify(report, null, 2));
    return EXIT_OK;
  }

  io.out(renderShadowReport(report, shadow.enabled));
  return EXIT_OK;
}

async function commandConfig(args: CliArgs, io: CliIO): Promise<number> {
  const sub = args.positionals[1] ?? 'validate';
  if (sub !== 'validate') {
    io.err(`Unknown subcommand "config ${sub}". Supported: validate.`);
    return EXIT_USAGE;
  }

  const loaded = await load(args, io);
  const { models, providers } = buildRegistries(loaded.config);
  const { learning, telemetry } = loaded.config;

  io.out(`Configuration is valid: ${loaded.path}`);
  io.out(`  source:    ${loaded.sourceKind}`);
  io.out(`  providers: ${String(providers.size)}`);
  io.out(`  models:    ${String(models.size)}`);
  io.out(`  learning:  ${learning.enabled ? 'enabled' : 'disabled'}`);
  io.out(
    `  telemetry: ${telemetry.enabled ? 'enabled' : 'disabled'} (privacy: ${telemetry.privacyMode})`,
  );
  return EXIT_OK;
}

async function commandStatus(args: CliArgs, io: CliIO): Promise<number> {
  const loaded = await load(args, io);
  const registries = buildRegistries(loaded.config);

  const options = {
    loaded,
    registries,
    env: process.env,
    implementedPhase: IMPLEMENTED_PHASE,
  };

  io.out(
    args.flags.has('json') ? JSON.stringify(buildStatus(options), null, 2) : renderStatus(options),
  );
  return EXIT_OK;
}

async function load(args: CliArgs, io: CliIO): Promise<LoadedConfig> {
  const loaded = await loadConfig({
    ...(args.config === undefined ? {} : { explicitPath: args.config }),
    allowBundledExample: true,
  });

  if (loaded.sourceKind === 'bundled-example') {
    io.err(
      `Note: no configuration found, using the bundled example at ${loaded.path}.\n` +
        `      Copy it to routepilot.config.json and verify its prices before relying on them.`,
    );
  }

  return loaded;
}

/** The task text, or null when none was given. */
function taskFrom(args: CliArgs): string | null {
  const prompt = args.positionals.slice(1).join(' ').trim();
  return prompt === '' ? null : prompt;
}

/** Build the hard requirements from the eligibility flags that were given. */
function buildRequirements(args: CliArgs): ModelRequirements {
  const requirements: { -readonly [K in keyof ModelRequirements]: ModelRequirements[K] } = {};

  if (args.requiredCapabilities.length > 0) {
    const caps: Partial<Record<keyof ModelCapabilities, boolean>> = {};
    for (const capability of args.requiredCapabilities) {
      caps[capability] = true;
    }
    requirements.requiredCapabilities = caps;
  }
  if (args.context !== undefined) requirements.requiredContextTokens = args.context;
  if (args.outputTokens !== undefined) requirements.requiredOutputTokens = args.outputTokens;
  if (args.tiers.length > 0) requirements.tiers = args.tiers;
  if (args.providers.length > 0) requirements.providerIds = args.providers;
  if (args.exclude.length > 0) requirements.excludeModelIds = args.exclude;
  if (args.optIn.length > 0) requirements.optInModelIds = args.optIn;
  if (args.noDegraded) requirements.allowDegraded = false;

  return requirements;
}

function hasAnyFilter(args: CliArgs): boolean {
  return (
    args.requiredCapabilities.length > 0 ||
    args.context !== undefined ||
    args.outputTokens !== undefined ||
    args.tiers.length > 0 ||
    args.providers.length > 0 ||
    args.exclude.length > 0 ||
    args.noDegraded
  );
}

function describeModel(model: ModelSpec): Record<string, unknown> {
  return {
    id: model.id,
    providerId: model.providerId,
    displayName: model.displayName,
    tier: model.tier,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    availability: model.availability,
    pricing: model.pricing,
    capabilities: model.capabilities,
  };
}

function renderModelTable(models: readonly ModelSpec[]): string {
  if (models.length === 0) return '  (none)';

  const rows = models.map((model) => [
    model.id,
    model.tier,
    count(model.contextWindow),
    `${model.pricing.inputPerMillion.toFixed(2)}/${model.pricing.outputPerMillion.toFixed(2)} ${model.pricing.currency}`,
    // A gated model is listed, but never without saying it is gated.
    model.constraints?.requiresExplicitOptIn === true
      ? `${model.availability} (opt-in)`
      : model.availability,
    capabilitySummary(model.capabilities),
  ]);

  return renderTable(
    ['MODEL', 'TIER', 'CONTEXT', 'PER 1M IN/OUT', 'AVAILABILITY', 'CAPABILITIES'],
    rows,
  );
}

function renderProviderTable(providers: readonly ProviderSpec[]): string {
  const rows = providers.map((provider) => [
    provider.id,
    provider.kind,
    provider.availability,
    provider.auth.kind === 'none'
      ? 'none'
      : `${provider.auth.kind} via $${provider.auth.envVar ?? '?'}`,
    provider.endpoint ?? '-',
  ]);

  return renderTable(['PROVIDER', 'KIND', 'AVAILABILITY', 'AUTH', 'ENDPOINT'], rows);
}

function capabilitySummary(capabilities: ModelCapabilities): string {
  const present = MODEL_CAPABILITY_KEYS.filter((key) => capabilities[key]);
  return present.length > 0 ? present.join(',') : '(none)';
}

/** Normalised CLI arguments. */
interface CliArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly config: string | undefined;
  readonly root: string | undefined;
  readonly level: AnalysisLevel | undefined;
  readonly activeFile: string | undefined;
  readonly files: readonly string[];
  readonly model: string | undefined;
  readonly budget: number | undefined;
  readonly minSuccess: number | undefined;
  readonly mode: OperationMode | undefined;
  readonly context: number | undefined;
  readonly outputTokens: number | undefined;
  readonly requiredCapabilities: readonly (keyof ModelCapabilities)[];
  readonly tiers: readonly ModelTier[];
  readonly providers: readonly string[];
  readonly exclude: readonly string[];
  readonly optIn: readonly string[];
  readonly noDegraded: boolean;
  readonly adapter: string | undefined;
  /** Whether the user explicitly asked for execution. Defaults to false. */
  readonly execute: boolean;
}

/**
 * Validate an operation mode.
 *
 * Rejected rather than defaulted on a typo: `--mode prodution` silently
 * becoming `normal` would be the one direction that quietly *permits*
 * experiments, which is the wrong way for a mistake to fail.
 */
function toMode(value: string | undefined): OperationMode | undefined {
  if (value === undefined) return undefined;
  if ((OPERATION_MODES as readonly string[]).includes(value)) return value as OperationMode;
  throw new ArgumentError(`Unknown mode "${value}". Supported: ${OPERATION_MODES.join(', ')}.`);
}

function parseCli(argv: readonly string[]): CliArgs {
  const parsed = parseArgs(argv, VALUE_FLAGS);

  return {
    positionals: parsed.positionals,
    flags: parsed.flags,
    config: singleValue(parsed, 'config'),
    root: singleValue(parsed, 'root'),
    level: toLevel(singleValue(parsed, 'level')),
    activeFile: singleValue(parsed, 'active-file'),
    files: listValue(parsed, 'file'),
    model: singleValue(parsed, 'model'),
    budget: toNonNegativeNumber(singleValue(parsed, 'budget'), 'budget'),
    minSuccess: toProbability(singleValue(parsed, 'min-success')),
    mode: toMode(singleValue(parsed, 'mode')),
    context: integerValue(parsed, 'context'),
    outputTokens: integerValue(parsed, 'output-tokens'),
    requiredCapabilities: listValue(parsed, 'require').map(toCapability),
    tiers: listValue(parsed, 'tier').map(toTier),
    providers: listValue(parsed, 'provider'),
    exclude: listValue(parsed, 'exclude'),
    optIn: listValue(parsed, 'opt-in'),
    noDegraded: parsed.flags.has('no-degraded'),
    adapter: singleValue(parsed, 'adapter'),
    execute: parsed.flags.has('execute'),
  };
}

function toLevel(raw: string | undefined): AnalysisLevel | undefined {
  if (raw === undefined) return undefined;
  if (raw === '1' || raw === '2' || raw === '3') return Number(raw) as AnalysisLevel;
  throw new ArgumentError(`--level must be 1, 2 or 3 (received "${raw}")`);
}

function toNonNegativeNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ArgumentError(`--${flag} must be a non-negative number (received "${raw}")`);
  }
  return parsed;
}

function toProbability(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ArgumentError(`--min-success must be between 0 and 1 (received "${raw}")`);
  }
  return parsed;
}

function toCapability(raw: string): keyof ModelCapabilities {
  const normalised = raw.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const match = MODEL_CAPABILITY_KEYS.find((key) => key === normalised);
  if (match === undefined) {
    throw new ArgumentError(
      `unknown capability "${raw}". Supported: ${MODEL_CAPABILITY_KEYS.join(', ')}.`,
    );
  }
  return match;
}

function toTier(raw: string): ModelTier {
  const match = MODEL_TIERS.find((tier) => tier === raw);
  if (match === undefined) {
    throw new ArgumentError(`unknown tier "${raw}". Supported: ${MODEL_TIERS.join(', ')}.`);
  }
  return match;
}

function describeError(error: unknown): string {
  if (error instanceof ConfigurationError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/* c8 ignore start -- process entry point, exercised by invoking the binary */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const io: CliIO = {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  };
  run(process.argv.slice(2), io)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${describeError(error)}\n`);
      process.exitCode = EXIT_ERROR;
    });
}
/* c8 ignore stop */
