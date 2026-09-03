import { describe, expect, it } from 'vitest';

import { makeModel } from '../test-support/fixtures.js';
import { isComparableCurrency, priceModelTokens, priceTokens } from './pricing.js';
import type { ModelPricing } from './types/model.js';

const pricing: ModelPricing = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  currency: 'USD',
};

describe('priceTokens — basic arithmetic', () => {
  it('prices one million input tokens at the input rate', () => {
    const cost = priceTokens(pricing, { inputTokens: 1_000_000, outputTokens: 0 });

    expect(cost.inputCost).toBeCloseTo(3, 10);
    expect(cost.outputCost).toBe(0);
    expect(cost.totalCost).toBeCloseTo(3, 10);
    expect(cost.currency).toBe('USD');
  });

  it('prices one million output tokens at the output rate', () => {
    const cost = priceTokens(pricing, { inputTokens: 0, outputTokens: 1_000_000 });
    expect(cost.outputCost).toBeCloseTo(15, 10);
    expect(cost.totalCost).toBeCloseTo(15, 10);
  });

  it('scales linearly below one million tokens', () => {
    const cost = priceTokens(pricing, { inputTokens: 50_000, outputTokens: 2_000 });

    expect(cost.inputCost).toBeCloseTo(0.15, 10);
    expect(cost.outputCost).toBeCloseTo(0.03, 10);
    expect(cost.totalCost).toBeCloseTo(0.18, 10);
  });

  it('costs nothing for no tokens', () => {
    const cost = priceTokens(pricing, { inputTokens: 0, outputTokens: 0 });
    expect(cost.totalCost).toBe(0);
  });

  it('itemises the breakdown so an estimate can be explained', () => {
    const cost = priceTokens(pricing, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost.inputCost + cost.cachedInputCost + cost.outputCost).toBeCloseTo(cost.totalCost, 10);
  });
});

describe('priceTokens — cached input', () => {
  it('bills the cached portion at the cached rate when one is configured', () => {
    const cached: ModelPricing = { ...pricing, cachedInputPerMillion: 0.3 };

    const cost = priceTokens(cached, {
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 0,
    });

    // 200k at $3/M plus 800k at $0.30/M.
    expect(cost.inputCost).toBeCloseTo(0.6, 10);
    expect(cost.cachedInputCost).toBeCloseTo(0.24, 10);
    expect(cost.totalCost).toBeCloseTo(0.84, 10);
  });

  it('assumes no discount when the provider has not declared a cached rate', () => {
    const cost = priceTokens(pricing, {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });

    expect(cost.totalCost).toBeCloseTo(3, 10);
  });

  it('treats cached tokens as a subset of input tokens, never as extra', () => {
    const cached: ModelPricing = { ...pricing, cachedInputPerMillion: 0 };

    const cost = priceTokens(cached, {
      inputTokens: 100_000,
      cachedInputTokens: 999_999_999,
      outputTokens: 0,
    });

    expect(cost.inputCost).toBe(0);
    expect(cost.totalCost).toBe(0);
  });
});

describe('priceTokens — invalid input', () => {
  it.each([
    ['negative input', { inputTokens: -1, outputTokens: 0 }],
    ['negative output', { inputTokens: 0, outputTokens: -1 }],
    ['negative cached', { inputTokens: 10, outputTokens: 0, cachedInputTokens: -5 }],
    ['NaN input', { inputTokens: Number.NaN, outputTokens: 0 }],
    ['infinite output', { inputTokens: 0, outputTokens: Number.POSITIVE_INFINITY }],
  ])('rejects %s rather than producing a nonsense cost', (_label, usage) => {
    expect(() => priceTokens(pricing, usage)).toThrow(RangeError);
  });
});

describe('priceModelTokens', () => {
  it('prices against a model spec', () => {
    const model = makeModel({
      pricing: { inputPerMillion: 10, outputPerMillion: 50, currency: 'USD' },
    });

    const cost = priceModelTokens(model, { inputTokens: 100_000, outputTokens: 10_000 });

    expect(cost.totalCost).toBeCloseTo(1.5, 10);
  });

  it('ranks a cheap model below an expensive one for identical usage', () => {
    const cheap = makeModel({
      id: 'acme/cheap',
      pricing: { inputPerMillion: 1, outputPerMillion: 5, currency: 'USD' },
    });
    const expensive = makeModel({
      id: 'acme/expensive',
      pricing: { inputPerMillion: 10, outputPerMillion: 50, currency: 'USD' },
    });
    const usage = { inputTokens: 50_000, outputTokens: 5_000 };

    expect(priceModelTokens(cheap, usage).totalCost).toBeLessThan(
      priceModelTokens(expensive, usage).totalCost,
    );
  });
});

describe('isComparableCurrency', () => {
  it('permits comparison within one currency', () => {
    expect(isComparableCurrency(pricing, { ...pricing, inputPerMillion: 99 })).toBe(true);
  });

  it('refuses comparison across currencies', () => {
    expect(isComparableCurrency(pricing, { ...pricing, currency: 'EUR' })).toBe(false);
  });
});
