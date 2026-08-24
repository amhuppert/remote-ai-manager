import type { CommentAnchor } from "@/lib/document-comments/schemas";

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
