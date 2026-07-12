/**
 * URL vocabulary for the ticket surfaces. Pure functions — every link site
 * goes through these helpers instead of hand-building URLs.
 */

export function ticketDetailHref(
  projectName: string,
  ticketNumber: number | string,
): string {
  return `/tickets/${encodeURIComponent(projectName)}/${encodeURIComponent(
    String(ticketNumber),
  )}`;
}
