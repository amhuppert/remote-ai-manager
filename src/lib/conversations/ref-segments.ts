import { findRegisteredRefs } from "./ref-parser";
import { type ConversationRefAttrs, type MessageRefAttrs } from "./schemas";
import type { NotepadRefAttrs } from "@/lib/notepads/schemas";
import type { TicketRefAttrs } from "@/lib/tickets/schemas";
import {
  getReferenceByType,
  type ReferenceType,
} from "@/lib/prompt-editor/reference-registry";
import type {
  SpecElementRefAttrs,
  SpecRefAttrs,
  SpecSectionRefAttrs,
} from "@/lib/prompt-editor/spec-mention-nodes";

export type RefSegment =
  | { type: "text"; text: string }
  | { type: "conversation-ref"; attrs: ConversationRefAttrs; raw: string }
  | { type: "message-ref"; attrs: MessageRefAttrs; raw: string }
  | { type: "ticket-ref"; attrs: TicketRefAttrs; raw: string }
  | { type: "spec-ref"; attrs: SpecRefAttrs; raw: string }
  | {
      type: "requirement-ref";
      attrs: SpecElementRefAttrs;
      raw: string;
    }
  | { type: "decision-ref"; attrs: SpecElementRefAttrs; raw: string }
  | { type: "task-ref"; attrs: SpecElementRefAttrs; raw: string }
  | { type: "question-ref"; attrs: SpecElementRefAttrs; raw: string }
  | { type: "assumption-ref"; attrs: SpecElementRefAttrs; raw: string }
  | { type: "section-ref"; attrs: SpecSectionRefAttrs; raw: string }
  | { type: "notepad-ref"; attrs: NotepadRefAttrs; raw: string };

/**
 * Split text into plain-text runs interleaved with schema-valid
 * registered reference tags in document order. Tags that fail validation stay
 * embedded in the surrounding text. Shared by the prompt editor's paste
 * handler (text → mention chips) and transcript renderer (text → link chips).
 */
export function segmentTextByRefs(text: string): RefSegment[] {
  const found = findRegisteredRefs(text);

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
  type: ReferenceType;
  raw: string;
  attrs: Record<string, string>;
}): Exclude<RefSegment, { type: "text" }> | null {
  const entry = getReferenceByType(ref.type);
  const parsed = entry.attrsSchema.safeParse(ref.attrs);
  if (!parsed.success) return null;
  return {
    type: entry.xmlTag,
    attrs: parsed.data,
    raw: ref.raw,
  } as Exclude<RefSegment, { type: "text" }>;
}
