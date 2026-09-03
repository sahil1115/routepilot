/**
 * Configuration schema and validation (spec section 47).
 *
 * Two layers of checking happen here:
 *
 * 1. Shape validation, via schemas that reject unknown keys outright. This is
 *    what stops a credential from being pasted into a config file: any key the
 *    schema does not know about is an error, and keys that look like secrets get
 *    a specific message pointing at `auth.envVar` (spec sections 34 and 51).
 * 2. Cross-field validation, for the invariants a per-field schema cannot see —
 *    every model's provider must exist, model ids must carry their provider
 *    prefix, ids must be unique, and every price must be in the budget currency
 *    so that costs are actually comparable.
 *
 * Every failure is reported with a path and, where a concrete fix exists, a
 * hint. Validation collects all problems rather than stopping at the first.
 */

import { z } from 'zod';

import { AVAILABILITY_STATES } from '../core/types/common.js';
import { MODEL_TIERS, SKILL_DIMENSIONS } from '../core/types/model.js';
import { AUTH_KINDS, PROVIDER_KINDS } from '../core/types/provider.js';
import { SHADOW_POLICY_IDS } from '../core/shadow/policies.js';
import { ConfigurationError, type ConfigurationIssue } from './errors.js';
import { BUDGET_EXCEEDED_BEHAVIOURS, PRIVACY_MODES, type RoutePilotConfig } from './types.js';

/** Keys that suggest someone tried to store a credential in configuration. */
const SECRET_LIKE_KEY = /(api[-_]?key|secret|token|password|passwd|credential|bearer)/i;

const unitInterval = z.number().min(0).max(1);
const positiveInt = z.number().int().positive();
const nonNegativeAmount = z.number().min(0);
const identifier = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'must be lowercase alphanumeric with . _ or -');

const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 code, e.g. USD');
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO 8601 date, e.g. 2026-06-24');

const pricingSchema = z.strictObject({
  inputPerMillion: nonNegativeAmount,
  outputPerMillion: nonNegativeAmount,
  cachedInputPerMillion: nonNegativeAmount.optional(),
  currency: currencyCode.default('USD'),
  verifiedAt: isoDate.optional(),
});

const capabilitiesSchema = z.strictObject({
  toolUse: z.boolean(),
  agenticExecution: z.boolean(),
  streaming: z.boolean(),
  structuredOutput: z.boolean(),
  vision: z.boolean().default(false),
});

const latencySchema = z.strictObject({
  firstTokenSeconds: z.number().min(0),
  outputTokensPerSecond: z.number().positive(),
});

const priorsSchema = z.strictObject({
  skills: z.partialRecord(z.enum(SKILL_DIMENSIONS), unitInterval).default({}),
  languages: z.record(z.string().min(1), unitInterval).default({}),
});

const constraintsSchema = z.strictObject({
  maxConcurrentRequests: positiveInt.optional(),
  requestsPerMinute: positiveInt.optional(),
  requiresExplicitOptIn: z.boolean().optional(),
  notes: z.string().optional(),
});

const modelSchema = z
  .strictObject({
    id: z.string().min(1),
    providerId: identifier,
    modelId: z.string().min(1),
    displayName: z.string().min(1),
    tier: z.enum(MODEL_TIERS),
    contextWindow: positiveInt,
    maxOutputTokens: positiveInt.optional(),
    pricing: pricingSchema,
    capabilities: capabilitiesSchema,
    latency: latencySchema,
    availability: z.enum(AVAILABILITY_STATES).default('available'),
    priors: priorsSchema.default({ skills: {}, languages: {} }),
    constraints: constraintsSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .check((ctx) => {
    const { id, providerId } = ctx.value;
    if (!id.startsWith(`${providerId}/`)) {
      ctx.issues.push({
        code: 'custom',
        input: id,
        path: ['id'],
        message:
          `model id "${id}" must start with its provider prefix "${providerId}/" ` +
          `so a model can always be traced to its provider`,
      });
    }
  });

const authSchema = z
  .strictObject({
    kind: z.enum(AUTH_KINDS),
    envVar: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, 'must be an environment variable NAME, not a credential value')
      .optional(),
  })
  .check((ctx) => {
    const { kind, envVar } = ctx.value;
    if (kind !== 'none' && envVar === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['envVar'],
        message: `auth.kind "${kind}" requires envVar — the NAME of the environment variable holding the credential`,
      });
    }
  });

const retrySchema = z.strictObject({
  maxAttempts: positiveInt.default(3),
  initialDelayMs: z.number().int().min(0).default(500),
  backoffMultiplier: z.number().min(1).default(2),
  maxDelayMs: z.number().int().min(0).default(30_000),
});

const providerSchema = z.strictObject({
  id: identifier,
  displayName: z.string().min(1),
  kind: z.enum(PROVIDER_KINDS),
  endpoint: z.url('must be an absolute URL').optional(),
  auth: authSchema,
  timeoutMs: positiveInt.default(120_000),
  retry: retrySchema.default({
    maxAttempts: 3,
    initialDelayMs: 500,
    backoffMultiplier: 2,
    maxDelayMs: 30_000,
  }),
  availability: z.enum(AVAILABILITY_STATES).default('available'),
  tags: z.array(z.string().min(1)).optional(),
});

const routingSchema = z.strictObject({
  minimumSuccessProbability: unitInterval.default(0.85),
  maxRisk: unitInterval.default(0.5),
  maxLatencySeconds: z.number().positive().default(900),
  maxEscalationsPerTask: z.number().int().min(0).default(2),
  maxRetriesPerModel: z.number().int().min(0).default(1),
  maxExecutionTimeMs: positiveInt.optional(),
  modelOverrideEnabled: z.boolean().default(false),
  defaultProviderId: identifier.optional(),
  fallbackProviderId: identifier.optional(),
});

const budgetsSchema = z.strictObject({
  currency: currencyCode.default('USD'),
  request: nonNegativeAmount.optional(),
  session: nonNegativeAmount.optional(),
  daily: nonNegativeAmount.optional(),
  monthly: nonNegativeAmount.optional(),
  onExceeded: z.enum(BUDGET_EXCEEDED_BEHAVIOURS).default('ask'),
});

const calibrationSchema = z.strictObject({
  minimumSamples: z.number().int().positive().default(50),
  maxExpectedCalibrationError: z.number().min(0).max(1).default(0.15),
  maxCalibrationError: z.number().min(0).max(1).default(0.3),
  // Default is above zero on purpose: a skill score of exactly zero describes a
  // predictor that answers the same thing to every question. May be set
  // negative to accept one deliberately.
  minimumBrierSkillScore: z.number().min(-1).max(1).default(0.02),
  requireCalibration: z.boolean().default(false),
});

const explorationSchema = z.strictObject({
  enabled: z.boolean().default(false),
  // Deliberately high. Exploration before there is a baseline worth deviating
  // from is guessing, not learning (spec section 40).
  minimumObservations: z.number().int().positive().default(200),
  maxRisk: z.number().min(0).max(1).default(0.3),
  maxCostPremium: z.number().min(0).max(2).default(0.25),
  optimism: z.number().min(0).max(5).default(1.5),
});

const learningSchema = z.strictObject({
  enabled: z.boolean().default(false),
  exploration: explorationSchema.prefault({}),
  minimumTrainingSamples: z.number().int().positive().default(200),
  calibration: calibrationSchema.prefault({}),
});

const shadowSchema = z.strictObject({
  enabled: z.boolean().default(false),
  // Validated against the built-in ids so a typo fails loudly rather than
  // silently dropping a comparison the user believed they were running.
  policies: z.array(z.enum(SHADOW_POLICY_IDS)).default([...SHADOW_POLICY_IDS]),
});

const telemetrySchema = z.strictObject({
  enabled: z.boolean().default(true),
  privacyMode: z.enum(PRIVACY_MODES).default('strict'),
  storagePath: z.string().min(1).optional(),
});

/** Schema for a complete RoutePilot configuration document. */
export const routePilotConfigSchema = z.strictObject({
  version: z.literal(1),
  providers: z.array(providerSchema).default([]),
  models: z.array(modelSchema).default([]),
  routing: routingSchema.prefault({}),
  budgets: budgetsSchema.prefault({}),
  learning: learningSchema.prefault({}),
  shadow: shadowSchema.prefault({}),
  telemetry: telemetrySchema.prefault({}),
});

/**
 * Validate an unknown value as a RoutePilot configuration.
 *
 * @param input Parsed JSON, or any object.
 * @param source Path or label used in error messages.
 * @throws ConfigurationError listing every problem found.
 */
export function parseConfig(input: unknown, source?: string): RoutePilotConfig {
  const result = routePilotConfigSchema.safeParse(input);

  if (!result.success) {
    throw new ConfigurationError(
      'Invalid RoutePilot configuration',
      result.error.issues.map(toConfigurationIssue),
      source,
    );
  }

  const config = result.data;
  const crossFieldIssues = validateCrossFieldRules(config);
  if (crossFieldIssues.length > 0) {
    throw new ConfigurationError('Invalid RoutePilot configuration', crossFieldIssues, source);
  }

  return config;
}

/**
 * Invariants that span more than one field.
 *
 * Kept separate from the schema so each rule can state plainly what it protects.
 */
function validateCrossFieldRules(config: RoutePilotConfig): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const providerIds = new Set<string>();

  config.providers.forEach((provider, index) => {
    if (providerIds.has(provider.id)) {
      issues.push({
        path: `providers[${index}].id`,
        message: `duplicate provider id "${provider.id}"`,
        hint: 'Provider ids must be unique; the second definition would silently shadow the first.',
      });
    }
    providerIds.add(provider.id);
  });

  const modelIds = new Set<string>();
  config.models.forEach((model, index) => {
    if (modelIds.has(model.id)) {
      issues.push({
        path: `models[${index}].id`,
        message: `duplicate model id "${model.id}"`,
        hint: 'Model ids must be unique; the second definition would silently shadow the first.',
      });
    }
    modelIds.add(model.id);

    if (!providerIds.has(model.providerId)) {
      issues.push({
        path: `models[${index}].providerId`,
        message: `model "${model.id}" references unknown provider "${model.providerId}"`,
        hint:
          providerIds.size > 0
            ? `Known providers: ${[...providerIds].sort().join(', ')}.`
            : 'No providers are defined. Add one to the "providers" array.',
      });
    }

    if (model.pricing.currency !== config.budgets.currency) {
      issues.push({
        path: `models[${index}].pricing.currency`,
        message:
          `model "${model.id}" is priced in ${model.pricing.currency} but budgets are in ` +
          `${config.budgets.currency}`,
        hint:
          'RoutePilot compares model costs directly, which is only meaningful in a single ' +
          'currency. Convert the prices, or change budgets.currency.',
      });
    }

    if (
      model.maxOutputTokens !== undefined &&
      model.maxOutputTokens > model.contextWindow &&
      model.contextWindow > 0
    ) {
      issues.push({
        path: `models[${index}].maxOutputTokens`,
        message:
          `model "${model.id}" declares maxOutputTokens (${model.maxOutputTokens}) greater than ` +
          `its contextWindow (${model.contextWindow})`,
        hint: 'Check the two values against the provider documentation; one of them is wrong.',
      });
    }
  });

  for (const [field, value] of [
    ['defaultProviderId', config.routing.defaultProviderId],
    ['fallbackProviderId', config.routing.fallbackProviderId],
  ] as const) {
    if (value !== undefined && !providerIds.has(value)) {
      issues.push({
        path: `routing.${field}`,
        message: `references unknown provider "${value}"`,
        hint:
          providerIds.size > 0
            ? `Known providers: ${[...providerIds].sort().join(', ')}.`
            : 'No providers are defined. Add one to the "providers" array.',
      });
    }
  }

  const budgetOrder = [
    ['request', config.budgets.request],
    ['session', config.budgets.session],
    ['daily', config.budgets.daily],
    ['monthly', config.budgets.monthly],
  ] as const;
  for (let i = 0; i < budgetOrder.length - 1; i += 1) {
    const narrow = budgetOrder[i];
    const wide = budgetOrder[i + 1];
    if (narrow === undefined || wide === undefined) continue;
    const [narrowName, narrowValue] = narrow;
    const [wideName, wideValue] = wide;
    if (narrowValue !== undefined && wideValue !== undefined && narrowValue > wideValue) {
      issues.push({
        path: `budgets.${narrowName}`,
        message: `${narrowName} budget (${narrowValue}) exceeds ${wideName} budget (${wideValue})`,
        hint: `A single ${narrowName} could exhaust the whole ${wideName} budget. Lower it, or raise ${wideName}.`,
      });
    }
  }

  if (config.learning.enabled && config.models.length === 0) {
    issues.push({
      path: 'learning.enabled',
      message: 'learning is enabled but no models are configured',
      hint: 'There is nothing to learn about. Define models, or set learning.enabled to false.',
    });
  }

  return issues;
}

/** Convert a schema issue into an actionable configuration issue. */
function toConfigurationIssue(issue: z.core.$ZodIssue): ConfigurationIssue {
  const path = formatPath(issue.path);

  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys;
    const secretLike = keys.filter((key) => SECRET_LIKE_KEY.test(key));
    return {
      path,
      message: `unknown ${keys.length === 1 ? 'key' : 'keys'}: ${keys.join(', ')}`,
      hint:
        secretLike.length > 0
          ? `RoutePilot never stores credentials in configuration. Remove ${secretLike.join(', ')} ` +
            'and point auth.envVar at the environment variable holding the credential instead.'
          : 'Remove the key, or check it against docs/ARCHITECTURE.md for the supported fields.',
    };
  }

  return { path, message: issue.message };
}

/** Render a schema path as a dotted/bracketed string. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      out += out === '' ? String(segment) : `.${String(segment)}`;
    }
  }
  return out;
}
