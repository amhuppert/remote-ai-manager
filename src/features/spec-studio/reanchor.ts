import type { CommentAnchor } from "@/lib/document-comments/schemas";

export type SpecThreadAnchorState =
  | { status: "anchored"; charStart: number; charEnd: number }
  | { status: "reanchored"; charStart: number; charEnd: number }
  | { status: "stale" }
  | { status: "orphaned" };

export function reanchorSpecThread(
  anchor: CommentAnchor,
  currentElementBody: string | null,
): SpecThreadAnchorState {
  if (currentElementBody === null) return { status: "orphaned" };
  if (anchor.quote.length === 0) return { status: "stale" };

  if (
    currentElementBody.slice(anchor.charStart, anchor.charEnd) === anchor.quote
  ) {
    return {
      status: "anchored",
      charStart: anchor.charStart,
      charEnd: anchor.charEnd,
    };
  }

  const firstMatch = currentElementBody.indexOf(anchor.quote);
  if (firstMatch === -1) return { status: "stale" };
  if (currentElementBody.indexOf(anchor.quote, firstMatch + 1) !== -1) {
    return { status: "stale" };
  }

  return {
    status: "reanchored",
    charStart: firstMatch,
    charEnd: firstMatch + anchor.quote.length,
  };
}
