import type { CommentAnchor } from "@/lib/document-comments/schemas";
import type { ClipProvenance } from "@/lib/notepads/capture-fragment";

/**
 * The class an annotation host puts on content a selection must never cover —
 * chevrons, reference chips, embedded images. Anchor offsets are counted over
 * annotatable text only, so marked subtrees are skipped by both the offset
 * model and re-anchoring. Named here rather than in the DOM helpers because
 * the renderers that must apply it live outside this feature.
 */
export const NOT_ANNOTATABLE_CLASS = "not-annotatable";

export type MarkdownAnnotationTone = "active" | "settled";

export interface MarkdownAnnotationSource {
  id: string;
  anchor: CommentAnchor;
  tone: MarkdownAnnotationTone;
  accessibleLabel: string;
}

export type MarkdownAnchorState =
  | { status: "anchored"; charStart: number; charEnd: number }
  | { status: "reanchored"; charStart: number; charEnd: number }
  | { status: "stale" };

export interface ResolvedMarkdownAnnotation extends MarkdownAnnotationSource {
  anchorState: MarkdownAnchorState;
  block: HTMLElement | null;
}

export type SpecThreadAnchorState =
  | MarkdownAnchorState
  | { status: "orphaned" };

export type MarkdownAnnotationTarget =
  | { kind: "annotation"; id: string }
  | { kind: "block-group"; ids: readonly string[] };

export interface PersistCommentInput {
  anchor: CommentAnchor;
  note: string;
}

/**
 * What a host is shown of the live selection when it is asked to describe a
 * clip. `anchor` is the same one a comment would persist; `text` is the
 * selection exactly as rendered — what the clip quotes; `block` is the rendered
 * block it resolved within, so code ancestry is read off the DOM the reader is
 * looking at rather than guessed from the source.
 */
export interface ClipSelectionContext {
  anchor: CommentAnchor;
  text: string;
  block: HTMLElement;
  /**
   * The DOM range the selection covers. The block alone cannot answer every
   * ancestry question: an inline code span sits INSIDE a prose block, so the
   * stamped block is the paragraph and only the range knows the selection was
   * within `code`.
   */
  range: Range;
}

/**
 * A host's explicit opt-in to clip on the shared selection affordance. Clip is
 * offered only where a host supplies this, so a host with no provenance story
 * never shows it.
 *
 * The capability answers with DATA — a typed provenance union and a code bit —
 * and never formats an attribution line: rendering the fragment belongs to the
 * capture fragment builder alone, so every surface's clip is byte-identical
 * (D20).
 */
export interface ClipCaptureCapability {
  /** Withholds Clip without the host having to drop the capability object. */
  enabled: boolean;
  buildProvenance(selection: ClipSelectionContext): ClipProvenance;
  deriveIsCode(selection: ClipSelectionContext): boolean;
}

export type CommentComposerCapability =
  | {
      kind: "persist-only";
      submit(input: PersistCommentInput): Promise<void>;
    }
  | {
      kind: "persist-or-send";
      submit(
        input: PersistCommentInput & { delivery: "queue" | "send" },
      ): Promise<void>;
    };
