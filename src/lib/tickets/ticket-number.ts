const CANONICAL_TICKET_NUMBER = /^[1-9][0-9]*$/;

export function parseTicketNumberSegment(segment: string): number | null {
  if (!CANONICAL_TICKET_NUMBER.test(segment)) return null;
  const number = Number(segment);
  return Number.isSafeInteger(number) ? number : null;
}
