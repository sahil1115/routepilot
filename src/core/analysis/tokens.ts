/**
 * Token estimation (spec section 11, "estimated input tokens").
 *
 * These are estimates, not tokenizer results: RoutePilot is provider-neutral
 * and cannot run every provider's tokenizer, so it approximates from byte and
 * character counts. A real tokenizer belongs behind these functions, not
 * scattered through the analyzer.
 */

/**
 * Bytes per token for source code. Smaller than prose because identifiers,
 * punctuation and indentation all cost tokens.
 */
const BYTES_PER_TOKEN_CODE = 3.4;

/** Bytes per token for prose. */
const BYTES_PER_TOKEN_PROSE = 4.0;

/**
 * Margin applied to context estimates. Underestimating fails a request that has
 * already been paid for; overestimating only costs a slightly larger model.
 */
const CONTEXT_SAFETY_MARGIN = 1.15;

/** Estimate tokens for a string of prose, such as a user prompt. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / BYTES_PER_TOKEN_PROSE);
}

/**
 * Estimate tokens for a number of bytes of source code.
 *
 * @throws RangeError when `bytes` is negative or not finite.
 */
export function estimateTokensFromBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`bytes must be finite and non-negative (received ${bytes})`);
  }
  return Math.ceil(bytes / BYTES_PER_TOKEN_CODE);
}

/** Apply the safety margin to a raw context estimate. */
export function withSafetyMargin(tokens: number): number {
  return Math.ceil(tokens * CONTEXT_SAFETY_MARGIN);
}

/**
 * Estimate the output tokens a task will produce.
 *
 * Scales with input size and task breadth, bounded so a huge input does not
 * imply an absurd output. Deliberately coarse: a prior, to be replaced by
 * observation once telemetry exists.
 */
export function estimateOutputTokens(inputTokens: number, expectedFileCount: number): number {
  const perFile = 400;
  const fromFiles = Math.max(1, expectedFileCount) * perFile;
  const fromInput = inputTokens * 0.25;
  return Math.ceil(Math.min(Math.max(fromFiles, fromInput), 64_000));
}
