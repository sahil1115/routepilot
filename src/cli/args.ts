/**
 * Minimal argument parsing.
 *
 * Hand-rolled rather than pulled from a dependency: the surface is small, and
 * argument handling for a tool that spawns external agent processes is
 * security-relevant enough to be worth reading in full (spec section 51).
 */

/** A parsed command line. */
export interface ParsedArgs {
  /** Positional arguments, in order. */
  readonly positionals: readonly string[];
  /** Flags that appeared with a value, keyed by name without the leading dashes. */
  readonly values: ReadonlyMap<string, readonly string[]>;
  /** Flags that appeared without a value. */
  readonly flags: ReadonlySet<string>;
}

/** Thrown when a command line cannot be parsed. */
export class ArgumentError extends Error {
  override readonly name = 'ArgumentError';
}

/**
 * Parse `--name value`, `--name=value` and boolean `--flag` forms.
 *
 * @param argv Arguments after the node executable and script path.
 * @param valueFlags Names that take a value. Anything else is boolean.
 * @throws ArgumentError when a value flag is missing its value.
 */
export function parseArgs(argv: readonly string[], valueFlags: ReadonlySet<string>): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const body = arg.slice(2);
    if (body === '') {
      throw new ArgumentError('"--" is not a valid argument');
    }

    const eq = body.indexOf('=');
    if (eq !== -1) {
      const name = body.slice(0, eq);
      const value = body.slice(eq + 1);
      if (!valueFlags.has(name)) {
        throw new ArgumentError(`--${name} does not take a value`);
      }
      append(values, name, value);
      continue;
    }

    if (valueFlags.has(body)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new ArgumentError(`--${body} requires a value`);
      }
      append(values, body, next);
      i += 1;
      continue;
    }

    flags.add(body);
  }

  return { positionals, values, flags };
}

/** The last value given for a flag, or undefined. */
export function singleValue(args: ParsedArgs, name: string): string | undefined {
  const list = args.values.get(name);
  return list === undefined ? undefined : list[list.length - 1];
}

/** Every value given for a repeatable flag, including comma-separated forms. */
export function listValue(args: ParsedArgs, name: string): string[] {
  const list = args.values.get(name) ?? [];
  return list
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * A flag's value parsed as a non-negative integer.
 *
 * @throws ArgumentError when the value is not a non-negative integer.
 */
export function integerValue(args: ParsedArgs, name: string): number | undefined {
  const raw = singleValue(args, name);
  if (raw === undefined) return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ArgumentError(`--${name} must be a non-negative integer (received "${raw}")`);
  }
  return parsed;
}

function append(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}
