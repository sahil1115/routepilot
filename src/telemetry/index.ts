/**
 * Local telemetry.
 *
 * Depends inward on `src/core`; the core never imports from here. Nothing in
 * this layer makes a network call — telemetry is local-first by default
 * (spec section 33).
 */

export { NullTelemetryStore } from './null-store.js';
export { SqliteTelemetryStore } from './sqlite-store.js';
export type { OpenReport, SqliteStoreOptions } from './sqlite-store.js';
export { openTelemetryStore } from './open.js';
export type { OpenTelemetryOptions } from './open.js';
export {
  REDACTED,
  containsLikelySecret,
  redact,
  redactPath,
  redactSummary,
  stableHash,
} from './redaction.js';
export { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './schema.js';
export type { Migration } from './schema.js';
