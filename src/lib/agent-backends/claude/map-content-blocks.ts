import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import { createLogger } from "@/lib/logging";

const logger = createLogger("claude.content-mapper");

/**
 * The single source of truth for turning an Anthropic SDK assistant message's
 * content into CC's `MessageContentBlock[]`. Both Claude paths that surface
 * assistant content — the `QuerySession` driver (`TurnResult.contentBlocks`)
 * and the actor's `processMessage` (transcript persistence + live SSE) — map
 * through here so a new block variant only has to be handled in ONE place.
 * (The other two edit points for a new variant are `messageContentBlockSchema`
 * and the `MessageContent` renderer.)
 *
 * Pure: returns blocks in source order and never emits or persists — callers
 * own those responsibilities. Unrecognized block types are dropped, but logged
 * so a future SDK block type surfaces instead of silently vanishing.
 */
export function mapAssistantContentBlocks(
  sdkContent: SDKAssistantMessage["message"]["content"],
): MessageContentBlock[] {
  const blocks: MessageContentBlock[] = [];

  for (const block of sdkContent) {
    if (block.type === "text" && "text" in block) {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use" && "name" in block) {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown> | undefined,
      });
    } else if (block.type === "thinking" && "thinking" in block) {
      blocks.push({ type: "thinking", text: block.thinking });
    } else if (block.type === "redacted_thinking") {
      // Encrypted reasoning the API won't reveal — keep an empty-text marker so
      // the UI can show a "reasoning hidden" indicator.
      blocks.push({ type: "thinking", text: "", redacted: true });
    } else {
      logger.debug("claude.content-mapper.unhandled_block", {
        blockType: block.type,
      });
    }
  }

  return blocks;
}
