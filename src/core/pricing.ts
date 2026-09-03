/**
 * Token pricing arithmetic (spec section 15).
 *
 * Phase 1 covers only the direct question "what does this many tokens cost on
 * this model". Expected total cost to success — retry cost, escalation cost and
 * failure probabilities — is Phase 4 and deliberately absent here.
 */

import type { ModelPricing, ModelSpec } from './types/model.js';

const TOKENS_PER_PRICING_UNIT = 1_000_000;

/** A token count to price. */
export interface TokenUsageEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens expected to be served from a provider-side cache. */
  readonly cachedInputTokens?: number;
}

/** An itemised cost, so that estimates can be explained rather than asserted. */
export interface CostBreakdown {
  /** Cost of input tokens billed at the full rate. */
  readonly inputCost: number;
  /** Cost of input tokens billed at the cached rate. */
  readonly cachedInputCost: number;
  /** Cost of output tokens. */
  readonly outputCost: number;
  /** Sum of the above. */
  readonly totalCost: number;
  /** ISO 4217 currency code, copied from the pricing record. */
  readonly currency: string;
}

/**
 * Price a token usage estimate against a pricing record.
 *
 * `cachedInputTokens` is treated as a subset of `inputTokens`; the cached
 * portion is billed at `cachedInputPerMillion` when that rate is configured and
 * at the full input rate when it is not. RoutePilot does not assume a cache
 * discount it has not been told about.
 *
 * @throws RangeError if any token count is negative or not finite.
 */
export function priceTokens(pricing: ModelPricing, usage: TokenUsageEstimate): CostBreakdown {
  const inputTokens = requireTokenCount(usage.inputTokens, 'inputTokens');
  const outputTokens = requireTokenCount(usage.outputTokens, 'outputTokens');
  const cachedRequested = requireTokenCount(usage.cachedInputTokens ?? 0, 'cachedInputTokens');

  // The cached portion cannot exceed the total input.
  const cachedInputTokens = Math.min(cachedRequested, inputTokens);
  const fullRateInputTokens = inputTokens - cachedInputTokens;

  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;

  const inputCost = (fullRateInputTokens / TOKENS_PER_PRICING_UNIT) * pricing.inputPerMillion;
  const cachedInputCost = (cachedInputTokens / TOKENS_PER_PRICING_UNIT) * cachedRate;
  const outputCost = (outputTokens / TOKENS_PER_PRICING_UNIT) * pricing.outputPerMillion;

  return {
    inputCost,
    cachedInputCost,
    outputCost,
    totalCost: inputCost + cachedInputCost + outputCost,
    currency: pricing.currency,
  };
}

/** Price a token usage estimate against a model. */
export function priceModelTokens(model: ModelSpec, usage: TokenUsageEstimate): CostBreakdown {
  return priceTokens(model.pricing, usage);
}

/**
 * Whether two pricing records can be compared directly.
 *
 * Comparing costs across currencies would silently produce nonsense, so
 * callers that rank models on price must check this first.
 */
export function isComparableCurrency(a: ModelPricing, b: ModelPricing): boolean {
  return a.currency === b.currency;
}

function requireTokenCount(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite, non-negative token count (received ${value})`);
  }
  return value;
}
