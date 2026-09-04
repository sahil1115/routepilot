/**
 * Exit-code contract. Stable; scripts and CI may rely on these.
 *
 * The distinction that matters is "the tool broke" versus "the tool worked and
 * declined", which must be visible without parsing output.
 */

/** The command did what was asked. */
export const EXIT_OK = 0;

/** The command failed: bad configuration, I/O failure, unknown model id. */
export const EXIT_ERROR = 1;

/** The command line itself was wrong: unknown command, bad flag, bad value. */
export const EXIT_USAGE = 2;

/**
 * Routing succeeded but selected no model: none met the confidence threshold,
 * fitted the budget, or satisfied the hard constraints. Nothing is broken, so a
 * script can retry with a different policy rather than treat it as a crash.
 */
export const EXIT_NO_MODEL = 3;

/**
 * The task ran, nothing contradicted it, and nothing confirmed it -- usually
 * because the workspace declares no test, build or typecheck script.
 *
 * Non-zero so `run --execute && deploy` stops; its own code so a script can
 * tell "unverified" from "failed".
 */
export const EXIT_UNVERIFIED = 4;

/** Human-readable description of each code, for `routepilot help`. */
export const EXIT_CODE_DESCRIPTIONS: readonly (readonly [number, string])[] = [
  [EXIT_OK, 'success'],
  [EXIT_ERROR, 'error (invalid configuration, I/O failure)'],
  [EXIT_USAGE, 'usage error (unknown command or bad argument)'],
  [EXIT_NO_MODEL, 'no model could be selected (routing declined, nothing is broken)'],
  [EXIT_UNVERIFIED, 'the task ran but nothing validated it'],
];
