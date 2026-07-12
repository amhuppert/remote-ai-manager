import {
  findConversationRefs,
  findMessageRefs,
  findTicketRefs,
} from "./ref-parser";
import {
  conversationRefAttrsSchema,
  messageRefAttrsSchema,
  type ConversationRefAttrs,
  type MessageRefAttrs,
} from "./schemas";
import {
  ticketRefAttrsSchema,
  type TicketRefAttrs,
} from "@/lib/tickets/schemas";

export type RefSegment =
  | { type: "text"; text: string }
  | { type: "conversation-ref"; attrs: ConversationRefAttrs; raw: string }
  | { type: "message-ref"; attrs: MessageRefAttrs; raw: string }
  | { type: "ticket-ref"; attrs: TicketRefAttrs; raw: string };

/**
 * Split text into plain-text runs interleaved with schema-valid
 * `<conversation-ref />`, `<message-ref />`, and `<ticket-ref />` tags, in
 * document order. Tags that fail validation stay embedded in the surrounding
 * text. Shared by the prompt editor's paste handler (text → mention chips)
 * and the transcript renderer (text → link chips).
 */
export function segmentTextByRefs(text: string): RefSegment[] {
  const found = [
    ...findConversationRefs(text).map((ref) => ({
      kind: "conversation" as const,
      ...ref,
    })),
    ...findMessageRefs(text).map((ref) => ({
      kind: "message" as const,
      ...ref,
    })),
    ...findTicketRefs(text).map((ref) => ({
      kind: "ticket" as const,
      ...ref,
    })),
  ].sort((a, b) => a.start - b.start);

  const segments: RefSegment[] = [];
  let cursor = 0;
  for (const ref of found) {
    const segment = validateRef(ref);
    if (!segment) continue;
    if (ref.start > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, ref.start) });
    }
    segments.push(segment);
    cursor = ref.end;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }
  return segments;
}

function validateRef(ref: {
  kind: "conversation" | "message" | "ticket";
  raw: string;
  attrs: Record<string, string>;
}): Exclude<RefSegment, { type: "text" }> | null {
  if (ref.kind === "conversation") {
    const parsed = conversationRefAttrsSchema.safeParse(ref.attrs);
    return parsed.success
      ? { type: "conversation-ref", attrs: parsed.data, raw: ref.raw }
      : null;
  }
  if (ref.kind === "ticket") {
    const parsed = ticketRefAttrsSchema.safeParse(ref.attrs);
    return parsed.success
      ? { type: "ticket-ref", attrs: parsed.data, raw: ref.raw }
      : null;
  }
  const parsed = messageRefAttrsSchema.safeParse(ref.attrs);
  return parsed.success
    ? { type: "message-ref", attrs: parsed.data, raw: ref.raw }
    : null;
}
