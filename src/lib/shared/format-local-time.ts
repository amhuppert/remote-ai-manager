/**
 * Format an ISO timestamp as a short absolute clock time in the viewer's local
 * zone.
 *
 * Same-day timestamps drop the date ("3:42 PM"); older ones keep a compact
 * month/day prefix ("Jun 19, 3:42 PM") so a scrolled-back transcript stays
 * unambiguous without spending header width on the common case.
 *
 * `now`/`locale`/`timeZone` are injectable so callers needing deterministic
 * output (tests, snapshots) can pin the clock and zone; they default to the
 * viewer's environment.
 */
export interface FormatLocalTimeOptions {
  now?: number;
  locale?: string;
  timeZone?: string;
}

export function formatLocalTime(
  isoDate: string,
  options: FormatLocalTimeOptions = {},
): string {
  const { now = Date.now(), locale, timeZone } = options;
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";

  const time: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  };
  // Compare calendar days in the display zone, not the runtime's — a viewer in
  // a different zone than the host would otherwise see the date prefix appear
  // or vanish a few hours off their own midnight.
  const dayKey = (value: Date): string =>
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    }).format(value);

  if (dayKey(date) === dayKey(new Date(now))) {
    return new Intl.DateTimeFormat(locale, time).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...time,
  }).format(date);
}
