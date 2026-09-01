import { PersistenceError } from "../shared/errors";

function ticketTimestampMillis(value: string, field: string): number {
  const millis = Date.parse(value);
  if (Number.isFinite(millis)) return millis;

  throw new PersistenceError({
    kind: "validation",
    entity: "ticket_timestamp",
    identifier: field,
    issues: `${field} must be an ISO-8601 timestamp`,
  });
}

export function nextTicketRevision(current: string, requested: string): string {
  const currentMillis = ticketTimestampMillis(current, "current");
  const requestedMillis = ticketTimestampMillis(requested, "requested");
  return new Date(Math.max(requestedMillis, currentMillis + 1)).toISOString();
}

export function nextSharedTicketRevision(
  currentRevisions: readonly string[],
  requested: string,
): string {
  return nextTicketRevision(latestTicketTimestamp(currentRevisions), requested);
}

export function latestTicketTimestamp(values: readonly string[]): string {
  let latest = values[0];
  if (latest === undefined) {
    throw new PersistenceError({
      kind: "validation",
      entity: "ticket_timestamp",
      identifier: "requested",
      issues: "at least one requested timestamp is required",
    });
  }

  let latestMillis = ticketTimestampMillis(latest, "requested");
  for (const value of values.slice(1)) {
    const millis = ticketTimestampMillis(value, "requested");
    if (millis <= latestMillis) continue;
    latest = value;
    latestMillis = millis;
  }
  return latest;
}
