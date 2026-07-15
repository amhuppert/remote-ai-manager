/**
 * Truncate a string to a maximum length, appending an ellipsis marker when it
 * overflows. Two truncation contracts are supported because both are in live
 * use and produce different lengths:
 *
 *   - Default ("keep `max` content chars"): slices the first `max` characters
 *     and appends `ellipsis`, so the result is `max + ellipsis.length` long.
 *   - `countEllipsisInBudget: true` ("bounded total"): reserves room for the
 *     ellipsis inside `max`, so the result never exceeds `max` characters.
 *
 * `trimEnd` drops trailing whitespace from the slice before the marker is
 * appended (avoids "word …" artifacts at a hard budget).
 */
export interface TruncateOptions {
  ellipsis?: string;
  countEllipsisInBudget?: boolean;
  trimEnd?: boolean;
}

export function truncate(
  value: string,
  max: number,
  options: TruncateOptions = {},
): string {
  const {
    ellipsis = "…",
    countEllipsisInBudget = false,
    trimEnd = false,
  } = options;
  if (value.length <= max) return value;
  const sliceLength = countEllipsisInBudget ? max - ellipsis.length : max;
  const head = value.slice(0, sliceLength);
  return `${trimEnd ? head.trimEnd() : head}${ellipsis}`;
}
