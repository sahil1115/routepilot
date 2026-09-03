/**
 * Terminal rendering helpers.
 *
 * Shared so that every command formats money, percentages and tables the same
 * way. Nothing here emits colour: RoutePilot's output is frequently piped,
 * redirected to a log, or read in CI, and escape codes make all three worse.
 */

/** Render a left-aligned table with a two-space indent. */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );

  const line = (cells: readonly string[]): string =>
    `  ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ')}`.trimEnd();

  return [line(headers), ...rows.map(line)].join('\n');
}

/**
 * Render an amount of money.
 *
 * Four decimal places because routing decisions routinely turn on fractions of
 * a cent, and rounding to two would make two visibly different candidates look
 * identical.
 */
export function money(value: number | undefined, currency: string): string {
  if (value === undefined) return 'unlimited';
  return `${value.toFixed(4)} ${currency}`;
}

/** Render a [0, 1] value as a whole-number percentage. */
export function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** Render a token or file count with thousands separators. */
export function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** Render seconds compactly: `45s`, `12m 30s`. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unbounded';
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(remainder)}s`;
}

/** `1 file` / `3 files`. */
export function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count(value)} ${value === 1 ? singular : pluralForm}`;
}

/** Render a labelled block: two-space indent, aligned values. */
export function block(entries: readonly (readonly [string, string])[]): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, value]) => `  ${`${label}:`.padEnd(width + 2)} ${value}`).join('\n');
}
