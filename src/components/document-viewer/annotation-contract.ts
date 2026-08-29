import type { CommentAnchor } from "@/lib/document-comments/schemas";

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
