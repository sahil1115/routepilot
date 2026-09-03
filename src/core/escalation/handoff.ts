/**
 * Context handoff builder (spec section 28).
 *
 * When a task moves to another model, sending only the original prompt wastes
 * everything the first attempt learned — and sending the full transcript is
 * worse: it costs money, crowds out the actual task, and re-presents the
 * previous model's dead ends as if they were progress worth continuing.
 *
 * So the handoff is a briefing: what the workspace looks like now, what was
 * already tried, what is known to be broken, and an explicit instruction not to
 * repeat failed approaches.
 *
 * Nothing here copies file contents. Paths, check names and one-line summaries
 * only — the same discipline the event stream follows (spec section 33).
 */

import type { ContextHandoff, ExecutionAttempt } from '../types/escalation.js';
import type { FailureType } from '../types/failure.js';

/** Everything needed to write a handoff. */
export interface HandoffInput {
  readonly originalTask: string;
  readonly repositoryRoot: string;
  readonly branch: string | null;
  readonly attempts: readonly ExecutionAttempt[];
  readonly escalationReason: string;
  /** Extra notes worth passing on. */
  readonly observations?: readonly string[] | undefined;
}

/** Caps, so a long task cannot produce an unbounded briefing. */
const MAX_FILES = 40;
const MAX_APPROACHES = 12;
const MAX_ATTEMPT_LINES = 6;

/**
 * The instruction given to the receiving model.
 *
 * Phrased almost as the specification words it. The three things that matter:
 * the workspace is not clean, existing changes should be read before new ones
 * are made, and failed approaches should not be repeated blindly.
 */
const INSTRUCTION =
  'A previous model attempted this task and did not complete it. ' +
  'Continue from the current workspace state rather than starting over. ' +
  'Review the existing changes before making new ones. ' +
  'Do not blindly repeat the approaches already tried below.';

/** Builds the briefing handed to the next model. */
export class ContextHandoffBuilder {
  /** Build a handoff from the attempts so far. */
  build(input: HandoffInput): ContextHandoff {
    const { attempts } = input;
    const last = attempts[attempts.length - 1];

    return {
      originalTask: input.originalTask,
      repositoryRoot: input.repositoryRoot,
      branch: input.branch,
      instruction: INSTRUCTION,
      filesChanged: collect(attempts, (attempt) => attempt.changedFiles),
      filesInspected: collect(attempts, (attempt) => attempt.inspectedFiles ?? []),
      failingChecks: collect(attempts, (attempt) => attempt.failedChecks ?? []),
      approachesTried: collect(attempts, (attempt) => attempt.approaches ?? [], MAX_APPROACHES),
      previousAttempts: attempts.slice(-MAX_ATTEMPT_LINES).map(describeAttempt),
      previousModelId: last?.modelId ?? null,
      failureType: last?.failureType ?? null,
      escalationReason: input.escalationReason,
      observations: input.observations ?? [],
    };
  }

  /**
   * Render a handoff as prompt text.
   *
   * Sections are omitted when empty rather than shown as "none", so the
   * briefing stays short when there is little to say.
   */
  render(handoff: ContextHandoff): string {
    const lines: string[] = [handoff.instruction, '', `## Task`, handoff.originalTask, ''];

    lines.push('## Situation');
    lines.push(`- Repository: ${handoff.repositoryRoot}`);
    if (handoff.branch !== null) lines.push(`- Branch: ${handoff.branch}`);
    if (handoff.previousModelId !== null) {
      lines.push(`- Previous model: ${handoff.previousModelId}`);
    }
    if (handoff.failureType !== null) {
      lines.push(`- Classified failure: ${handoff.failureType}`);
    }
    lines.push(`- Handed over because: ${handoff.escalationReason}`);

    section(lines, 'Files already changed (the workspace is not clean)', handoff.filesChanged);
    section(lines, 'Files already inspected', handoff.filesInspected);
    section(lines, 'Checks currently failing', handoff.failingChecks);
    section(lines, 'Approaches already tried — do not repeat these', handoff.approachesTried);
    section(lines, 'Previous attempts', handoff.previousAttempts);
    section(lines, 'Observations', handoff.observations);

    return lines.join('\n');
  }

  /**
   * Rough size of a rendered handoff, in characters.
   *
   * Exposed so a caller can confirm the briefing stayed compact rather than
   * growing into a transcript.
   */
  size(handoff: ContextHandoff): number {
    return this.render(handoff).length;
  }
}

/** Collect a de-duplicated, sorted, capped list across attempts. */
function collect(
  attempts: readonly ExecutionAttempt[],
  select: (attempt: ExecutionAttempt) => readonly string[],
  limit = MAX_FILES,
): string[] {
  const seen = new Set<string>();
  for (const attempt of attempts) {
    for (const value of select(attempt)) {
      if (value.trim() !== '') seen.add(value);
    }
  }
  return [...seen].sort().slice(0, limit);
}

function describeAttempt(attempt: ExecutionAttempt): string {
  if (attempt.succeeded) return `${attempt.modelId}: succeeded`;

  const failure = attempt.failureType ?? 'UNKNOWN';
  const reason = attempt.failureReason === undefined ? '' : ` — ${attempt.failureReason}`;
  return `${attempt.modelId}: failed (${failure})${reason}`;
}

function section(lines: string[], heading: string, values: readonly string[]): void {
  if (values.length === 0) return;
  lines.push('', `## ${heading}`);
  for (const value of values) lines.push(`- ${value}`);
}

/** Failure types where a handoff genuinely helps the next model. */
export function handoffIsUseful(failureType: FailureType | null): boolean {
  // A handoff describes what was attempted. When nothing was attempted —
  // the provider was down, the user cancelled — there is nothing to hand over.
  if (failureType === null) return true;
  return !['USER_CANCELLED', 'PROVIDER_FAILURE', 'BUDGET_EXCEEDED'].includes(failureType);
}
