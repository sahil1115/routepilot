/**
 * Task vocabulary (spec section 9).
 *
 * These are the categories the router reasons about. Classification itself —
 * combining prompt, active file, repository state, diagnostics and history — is
 * Phase 2. This module defines only the closed vocabulary those phases share.
 */

/** Closed set of task categories RoutePilot routes for. */
export const TASK_TYPES = [
  'explanation',
  'documentation',
  'autocomplete',
  'simple-edit',
  'rename',
  'formatting',
  'test-generation',
  'bug-fix',
  'debugging',
  'feature-implementation',
  'refactoring',
  'multi-file-refactoring',
  'architecture',
  'migration',
  'performance-optimization',
  'security',
  'investigation',
  'unknown',
] as const;

/** A task category RoutePilot routes for. */
export type TaskType = (typeof TASK_TYPES)[number];

/** Runtime membership test for {@link TaskType}. */
export function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}
