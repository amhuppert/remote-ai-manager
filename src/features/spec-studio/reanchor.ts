import type { CommentAnchor } from "@/lib/document-comments/schemas";
import type { SpecThreadAnchorState } from "@/components/document-viewer/annotation-contract";
import { projectMarkdownPassage } from "@/components/markdown/markdown-source-map";
import { tryReanchorExact } from "@/lib/document-comments/anchor";

export type { SpecThreadAnchorState };

export function reanchorSpecThread(
  anchor: CommentAnchor,
  currentElementBody: string | null,
): SpecThreadAnchorState {
  if (currentElementBody === null) return { status: "orphaned" };
  if (anchor.quote.length === 0) return { status: "stale" };

  if (anchor.endBlock) {
    const passage = projectMarkdownPassage(
      currentElementBody,
      anchor.line,
      anchor.endBlock.line,
    );
    if (
      passage === null ||
      passage.sectionId !== anchor.sectionId ||
      passage.endSectionId !== anchor.endBlock.sectionId
    )
      return { status: "stale" };
    const result = tryReanchorExact(passage.text, anchor);
    if (result.status === "stale") return result;
    return {
      ...result,
      status:
        result.charStart === anchor.charStart &&
        result.charEnd === anchor.charEnd
          ? "anchored"
          : "reanchored",
    };
  }

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
