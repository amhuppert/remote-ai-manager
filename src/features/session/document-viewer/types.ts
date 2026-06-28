import type { DocumentComment } from "@/lib/document-comments/schemas";
import type { ReanchorResult } from "@/lib/document-comments/anchor";

/**
 * A stored comment plus its derived-on-read anchoring state against the current
 * document content. `reanchor` is the exact-match result (anchored offsets or
 * stale); `stale` is its convenience flag. Neither is persisted — both are
 * computed when a document loads (group 5 `use-document-comments`). Defined in
 * the viewer feature because the annotated renderer (group 4) is the first
 * consumer and the comment-state hook (group 5) lives in the same feature.
 */
export interface ResolvedComment extends DocumentComment {
  reanchor: ReanchorResult;
  stale: boolean;
}
