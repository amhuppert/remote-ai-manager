import {
  segmentTextByRefs,
  type RefSegment,
} from "@/lib/conversations/ref-segments";
import { findNotepadImageTokens } from "@/lib/prompt-editor/notepad-image-token";

/**
 * How canonical notepad text decomposes into the parts a reader sees: plain
 * text, reference tags, and image tokens. This is the notepad dialect itself —
 * no Markdown knowledge, just the two token forms the format adds — so it is
 * owned here and read by both sides that must agree on it: the renderer's
 * transform, which turns the non-text parts into chips, and the comment
 * anchoring stack, which must know exactly which characters those chips hid.
 */

/**
 * One run of a literal node's value, and what the transform renders it as.
 * Offsets are relative to that value, so a caller holding the node's source
 * position can restate them over the canonical text.
 */
export type NotepadValuePart =
  | { type: "text"; text: string; start: number; end: number }
  | {
      type: "ref";
      segment: Exclude<RefSegment, { type: "text" }>;
      start: number;
      end: number;
    }
  | { type: "image"; imageId: string; start: number; end: number };

/**
 * The parts a literal node's value decomposes into.
 *
 * An `html` node with no schema-valid reference is reported as one text part:
 * the transform leaves such a node untouched, image tokens inside it included.
 */
export function notepadValueParts(
  nodeType: "html" | "text",
  value: string,
): NotepadValuePart[] {
  const untouched: NotepadValuePart[] = [
    { type: "text", text: value, start: 0, end: value.length },
  ];
  if (nodeType === "text") {
    const parts = imageParts(value, 0);
    return parts.some((part) => part.type !== "text") ? parts : untouched;
  }

  const segments = segmentTextByRefs(value);
  if (!segments.some((segment) => segment.type !== "text")) return untouched;

  const parts: NotepadValuePart[] = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.type === "text") {
      parts.push(...imageParts(segment.text, cursor));
      cursor += segment.text.length;
      continue;
    }
    parts.push({
      type: "ref",
      segment,
      start: cursor,
      end: cursor + segment.raw.length,
    });
    cursor += segment.raw.length;
  }
  return parts;
}

/**
 * The spans of a literal node's value the rendering replaces with a chip, and
 * so keeps out of the annotatable text a selection is measured over.
 */
export function notepadChipPartSpans(
  nodeType: "html" | "text",
  value: string,
): { start: number; end: number }[] {
  return notepadValueParts(nodeType, value)
    .filter((part) => part.type !== "text")
    .map(({ start, end }) => ({ start, end }));
}

function imageParts(value: string, offset: number): NotepadValuePart[] {
  const parts: NotepadValuePart[] = [];
  let cursor = 0;
  for (const token of findNotepadImageTokens(value)) {
    if (token.start > cursor) {
      parts.push({
        type: "text",
        text: value.slice(cursor, token.start),
        start: offset + cursor,
        end: offset + token.start,
      });
    }
    parts.push({
      type: "image",
      imageId: token.imageId,
      start: offset + token.start,
      end: offset + token.end,
    });
    cursor = token.end;
  }
  if (cursor < value.length || parts.length === 0) {
    parts.push({
      type: "text",
      text: value.slice(cursor),
      start: offset + cursor,
      end: offset + value.length,
    });
  }
  return parts;
}
