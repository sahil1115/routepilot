/**
 * Agent adapters.
 *
 * This layer depends inward on `src/core`; the core never imports from here.
 *
 * `verification.ts` is the authority on what has actually been observed to
 * work. Implemented and mock-tested is not the same as known to work
 * (spec section 2, rule 20).
 */

export { AgentRegistry, AdapterRegistryError, DEFAULT_RETRY } from './registry.js';
export type {
  AdapterRejection,
  AdapterSelection,
  AttemptRecord,
  ExecuteOptions,
  ExecutionOutcome,
  RetryPolicy,
} from './registry.js';

export {
  ADAPTER_VERIFICATION,
  describeVerification,
  isSupported,
  verificationFor,
  VERIFICATION_STATUSES,
} from './verification.js';
export type {
  AdapterVerification,
  VerificationEvidence,
  VerificationStatus,
} from './verification.js';

export { ClaudeCodeAdapter } from './claude-code/adapter.js';
export type { ClaudeCodeAdapterOptions } from './claude-code/adapter.js';

export { CursorCliAdapter } from './cursor/adapter.js';
export type { CursorCliAdapterOptions } from './cursor/adapter.js';

export { DirectProviderAdapter } from './direct/adapter.js';
export { anthropicMessagesProtocol, ANTHROPIC_VERSION } from './direct/protocols/anthropic.js';
export type { AnthropicProtocolOptions } from './direct/protocols/anthropic.js';
export type {
  DirectProviderAdapterOptions,
  FetchLike,
  ProviderProtocol,
  ProviderRequest,
} from './direct/adapter.js';

export { FakeAgentAdapter } from './fake/adapter.js';
export type { FakeAdapterOptions, FakeScript } from './fake/adapter.js';

export { probeExecutable, runProcess } from './process/runner.js';
export type { RunHandle, RunOptions, RunOutcome, RunResult } from './process/runner.js';
