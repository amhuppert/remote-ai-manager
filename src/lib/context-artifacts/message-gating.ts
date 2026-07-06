import type {
  MessageContentBlock,
  TranscriptMessage,
} from "@/lib/conversations/schemas";

/**
 * Minimum total `text`-block size (UTF-8 bytes, strictly greater) for a
 * tool-free assistant message to offer per-message compaction — compacting a
 * short message is noise (design docs/design/conversation-compaction/README.md
 * §12.1). Tuned later.
 */
export const MESSAGE_COMPACTION_TEXT_BYTES_THRESHOLD = 2048;

const encoder = new TextEncoder();

/**
 * Whether a message row should offer the "Compact message" action: assistant
 * messages that carry at least one `tool_use` block or whose text blocks sum
 * past the byte threshold. Pure over the content blocks — rendered/derived
 * text (copy text, markdown) deliberately plays no part.
 */
export function shouldOfferMessageCompaction(
  role: TranscriptMessage["role"] | undefined,
  content: MessageContentBlock[],
): boolean {
  if (role !== "assistant") return false;
  let textBytes = 0;
  for (const block of content) {
    if (block.type === "tool_use") return true;
    if (block.type !== "text") continue;
    textBytes += encoder.encode(block.text).length;
    if (textBytes > MESSAGE_COMPACTION_TEXT_BYTES_THRESHOLD) return true;
  }
  return false;
}
