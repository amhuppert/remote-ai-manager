import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { DocumentFeedbackPayload } from "@/lib/conversations/message-content-schemas";
export interface BuildUserTranscriptBlocksArgs {
  rewrittenPromptText: string;
  imageRefs: readonly ConversationImageRef[];
  /**
   * When present, a `document_feedback` block is appended after the text/image
   * blocks. Callers that deliver feedback as the card-only transcript record
   * pass an empty `rewrittenPromptText` so no duplicate prose block precedes it
   * (the agent-facing prose lives in the turn's prompt text, not the transcript).
   */
  documentFeedback?: DocumentFeedbackPayload;
}

/**
 * Build the user-message transcript content for a single turn. Each inline
 * `[Image #N]` marker found in the rewritten prompt is replaced by a
 * `image_marker` + `image_ref` pair backed by the persisted file path. Any
 * image refs not referenced inline (strip-only) are appended at the end as
 * the same marker+ref pair, preserving their order in `imageRefs`.
 *
 * Markers without a matching ref are kept as literal text (orphans).
 */
export function buildUserTranscriptBlocks(
  args: BuildUserTranscriptBlocksArgs,
): MessageContentBlock[] {
  const { rewrittenPromptText, imageRefs, documentFeedback } = args;

  const refByIndex = new Map<number, ConversationImageRef>();
  for (const r of imageRefs) {
    refByIndex.set(r.index, r);
  }

  const blocks: MessageContentBlock[] = [];
  const referencedInline = new Set<number>();
  let cursor = 0;

  for (const match of rewrittenPromptText.matchAll(/\[Image #(\d+)\]/g)) {
    const captured = match[1];
    const matchIndex = match.index;
    if (captured === undefined || matchIndex === undefined) continue;
    const index = Number.parseInt(captured, 10);
    const ref = refByIndex.get(index);
    if (!ref) continue;

    if (matchIndex > cursor) {
      blocks.push({
        type: "text",
        text: rewrittenPromptText.slice(cursor, matchIndex),
      });
    }
    blocks.push({
      type: "image_marker",
      index,
      mediaType: ref.mediaType,
      imagePath: ref.path,
    });
    blocks.push({
      type: "image_ref",
      mediaType: ref.mediaType,
      imagePath: ref.path,
    });
    referencedInline.add(index);
    cursor = matchIndex + match[0].length;
  }

  if (cursor < rewrittenPromptText.length) {
    blocks.push({
      type: "text",
      text: rewrittenPromptText.slice(cursor),
    });
  }

  for (const ref of imageRefs) {
    if (referencedInline.has(ref.index)) continue;
    blocks.push({
      type: "image_marker",
      index: ref.index,
      mediaType: ref.mediaType,
      imagePath: ref.path,
    });
    blocks.push({
      type: "image_ref",
      mediaType: ref.mediaType,
      imagePath: ref.path,
    });
  }

  if (documentFeedback) {
    blocks.push({
      type: "document_feedback",
      items: documentFeedback.items,
    });
  }

  return blocks;
}
