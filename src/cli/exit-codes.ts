/**
 * Exit-code contract.
 *
 * RoutePilot is meant to be driven from scripts and CI as well as by hand, so
 * the difference between "the tool broke" and "the tool worked and declined to
 * route" has to be visible without parsing output.
 *
 * A caller can rely on these staying stable.
 */

/** The command did what was asked. */
export const EXIT_OK = 0;

/**
 * The command failed to run: unreadable or invalid configuration, an I/O
 * failure, an unknown model id. Something is wrong and needs fixing.
 */
export const EXIT_ERROR = 1;

/** The command line itself was wrong: unknown command, bad flag, bad value. */
export const EXIT_USAGE = 2;

/**
 * Routing completed successfully but selected no model.
 *
 * Distinct from {@link EXIT_ERROR} on purpose. Nothing is broken — the router
 * examined the candidates and declined, because none met the confidence
 * threshold, or none fitted the budget, or none satisfied the hard constraints.
 * A script can retry with a different policy rather than treating it as a
 * crash.
 */
export const EXIT_NO_MODEL = 3;

/** Human-readable description of each code, for `routepilot help`. */
export const EXIT_CODE_DESCRIPTIONS: readonly (readonly [number, string])[] = [
  [EXIT_OK, 'success'],
  [EXIT_ERROR, 'error (invalid configuration, I/O failure)'],
  [EXIT_USAGE, 'usage error (unknown command or bad argument)'],
  [EXIT_NO_MODEL, 'no model could be selected (routing declined, nothing is broken)'],
];
