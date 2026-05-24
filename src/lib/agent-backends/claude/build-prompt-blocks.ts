import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
export interface BuildClaudePromptBlocksArgs {
  promptText: string;
  imageRefs: readonly ConversationImageRef[];
  syntheticForkSeed?: string | null;
}

/**
 * Construct the interleaved Claude prompt content blocks for a single turn.
 *
 * Walks `promptText` for `[Image #N]` markers and replaces each known marker
 * with a `text("[Image #N source: <path>]")` annotation followed by an
 * `image` block carrying the inline base64 data. Markers that have no
 * matching `ConversationImageRef` are preserved as literal text. Refs that
 * are never referenced by a marker (strip-only attachments) are appended
 * after the prompt text in input order, each with the same source-text +
 * image pair.
 *
 * The `[Image #N source: …]` annotation lets Claude link the marker text to
 * the corresponding base64 image even though the SDK content blocks have no
 * intrinsic identity.
 *
 * Returns an empty array when there is no prompt text and no image refs so
 * the caller can choose how to handle the no-content case.
 */
export function buildClaudePromptBlocks(
  args: BuildClaudePromptBlocksArgs,
): MessageContentBlock[] {
  const { promptText, imageRefs, syntheticForkSeed } = args;

  const blocks: MessageContentBlock[] = [];
  if (syntheticForkSeed) {
    blocks.push({ type: "text", text: syntheticForkSeed });
  }

  const refByIndex = new Map<number, ConversationImageRef>();
  for (const ref of imageRefs) refByIndex.set(ref.index, ref);

  const consumed = new Set<number>();
  let cursor = 0;
  let emittedAnyPromptContent = false;

  for (const match of promptText.matchAll(/\[Image #(\d+)\]/g)) {
    const captured = match[1];
    const matchIndex = match.index;
    if (captured === undefined || matchIndex === undefined) continue;
    const idx = Number.parseInt(captured, 10);
    const ref = refByIndex.get(idx);
    if (!ref) continue;

    if (matchIndex > cursor) {
      blocks.push({
        type: "text",
        text: promptText.slice(cursor, matchIndex),
      });
      emittedAnyPromptContent = true;
    }
    blocks.push({
      type: "text",
      text: `[Image #${idx} source: ${ref.path}]`,
    });
    blocks.push({
      type: "image",
      mediaType: ref.mediaType,
      base64Data: ref.base64Data,
    });
    consumed.add(idx);
    emittedAnyPromptContent = true;
    cursor = matchIndex + match[0].length;
  }

  if (cursor < promptText.length) {
    if (cursor === 0) {
      if (promptText.length > 0) {
        blocks.push({ type: "text", text: promptText });
        emittedAnyPromptContent = true;
      }
    } else {
      blocks.push({ type: "text", text: promptText.slice(cursor) });
      emittedAnyPromptContent = true;
    }
  }

  for (const ref of imageRefs) {
    if (consumed.has(ref.index)) continue;
    blocks.push({
      type: "text",
      text: `[Image #${ref.index} source: ${ref.path}]`,
    });
    blocks.push({
      type: "image",
      mediaType: ref.mediaType,
      base64Data: ref.base64Data,
    });
  }

  if (!emittedAnyPromptContent && imageRefs.length === 0) {
    return blocks;
  }

  return blocks;
}
