/**
 * Cross-feature promotion seam for the annotated document surface
 * (structure.md): features outside session/ must reach the annotation host
 * through this path. It lives outside src/components/markdown/ because the
 * canonical Markdown module's boundary admits only its three public seams —
 * the annotation host is a consumer of those seams, not part of the renderer.
 */
export {
  default,
  _resetAnnotatorBoundaryForTesting,
  _setAnnotatorBoundaryForTesting,
} from "@/features/session/document-viewer/AnnotatedMarkdown";
export type {
  AnnotatedDocumentRenderer,
  AnnotatedMarkdownProps,
} from "@/features/session/document-viewer/AnnotatedMarkdown";
export type { ResolvedComment } from "@/features/session/document-viewer/types";
export { NOT_ANNOTATABLE_CLASS } from "./annotation-contract";
export type {
  CommentComposerCapability,
  MarkdownAnchorState,
  MarkdownAnnotationSource,
  MarkdownAnnotationTarget,
  MarkdownAnnotationTone,
  PersistCommentInput,
  ResolvedMarkdownAnnotation,
  SpecThreadAnchorState,
} from "./annotation-contract";
export {
  blockAnnotatableText as _blockAnnotatableTextForTesting,
  rangeFromBlockOffsets as _rangeFromBlockOffsetsForTesting,
} from "@/features/session/document-viewer/anchor-dom";
export { useLiveMarkdownAnchorResolution } from "@/features/session/document-viewer/use-live-markdown-anchor-resolution";
