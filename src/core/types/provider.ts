/**
 * ProviderSpec and supporting types (spec sections 20 and 46).
 *
 * A provider is anything that can serve a model: a cloud API, a locally hosted
 * runtime, or a custom endpoint. Local runtimes are providers like any other —
 * RoutePilot does not assume local means cheapest or best (spec section 46).
 */

import type { Availability } from './common.js';

/** How a provider is hosted. */
export const PROVIDER_KINDS = ['cloud', 'local', 'custom'] as const;

/** How a provider is hosted. */
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** How RoutePilot authenticates to a provider. */
export const AUTH_KINDS = ['none', 'apiKey', 'bearerToken', 'oauth', 'custom'] as const;

/** How RoutePilot authenticates to a provider. */
export type AuthKind = (typeof AUTH_KINDS)[number];

/**
 * Authentication configuration for a provider.
 *
 * **This type holds no secret material and must never be given a field that
 * could.** It records only the *name* of the environment variable holding the
 * credential. The configuration schema actively rejects inline credentials, so
 * a secret cannot reach a config file, a log line or the telemetry store by
 * accident (spec sections 34 and 51).
 */
export interface ProviderAuth {
  /** Authentication scheme. */
  readonly kind: AuthKind;
  /**
   * Name of the environment variable holding the credential.
   *
   * Required for every scheme except `none`. The value is read at call time and
   * is never stored, serialised or logged.
   */
  readonly envVar?: string | undefined;
}

/** Retry behaviour for transient provider failures. */
export interface RetryPolicy {
  /** Total attempts including the first. */
  readonly maxAttempts: number;
  /** Delay before the first retry, in milliseconds. */
  readonly initialDelayMs: number;
  /** Multiplier applied to the delay after each attempt. */
  readonly backoffMultiplier: number;
  /** Upper bound on any single delay, in milliseconds. */
  readonly maxDelayMs: number;
}

/** A provider that serves one or more models. */
export interface ProviderSpec {
  /** Unique registry key. Used as the prefix of every model id it serves. */
  readonly id: string;
  /** Human-readable name for UI and explanations. */
  readonly displayName: string;
  /** How the provider is hosted. */
  readonly kind: ProviderKind;
  /** Base endpoint URL, when the provider is reached over HTTP. */
  readonly endpoint?: string | undefined;
  /** Authentication configuration. Contains no secrets. */
  readonly auth: ProviderAuth;
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Retry behaviour for transient failures. */
  readonly retry: RetryPolicy;
  /** Current operational availability. */
  readonly availability: Availability;
  /** Free-form labels for operator filtering. */
  readonly tags?: readonly string[] | undefined;
}
