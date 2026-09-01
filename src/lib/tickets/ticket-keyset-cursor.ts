import { z } from "zod";
import {
  TICKET_PAGE_DEFAULT_LIMIT,
  TICKET_PAGE_MAX_LIMIT,
} from "./disclosure-limits";

export const ticketKeysetCursorSchema = z
  .object({
    timestamp: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();
export type TicketKeysetCursor = z.infer<typeof ticketKeysetCursorSchema>;

export function encodeTicketKeysetCursor(cursor: TicketKeysetCursor): string {
  const parsed = ticketKeysetCursorSchema.parse(cursor);
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}

export function decodeTicketKeysetCursor(
  encoded: string,
): TicketKeysetCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 4096) return null;

  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return null;
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    const parsed = ticketKeysetCursorSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function normalizeTicketPageLimit(value: unknown): number | null {
  if (value === undefined || value === null) return TICKET_PAGE_DEFAULT_LIMIT;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) return null;

  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  if (numeric > TICKET_PAGE_MAX_LIMIT) return null;
  return numeric;
}

export function compareTicketKeysetNewestFirst(
  left: TicketKeysetCursor,
  right: TicketKeysetCursor,
): number {
  const timestampDifference = right.timestamp.localeCompare(left.timestamp);
  if (timestampDifference !== 0) return timestampDifference;
  return right.id.localeCompare(left.id);
}

export function isTicketKeysetRowAfterCursor(
  row: TicketKeysetCursor,
  cursor: TicketKeysetCursor,
): boolean {
  return compareTicketKeysetNewestFirst(row, cursor) > 0;
}
