import type {
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  MessageContentBlock,
  ToolResultMetrics,
} from "@/lib/conversations/schemas";
import { parseToolResultMetrics } from "@/lib/conversations/parse-tool-result";
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

interface SdkToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content?:
    | string
    | Array<{ type: string; text?: string; [k: string]: unknown }>;
}

function isSdkToolResultBlock(block: unknown): block is SdkToolResultBlock {
  return (
    block != null &&
    typeof block === "object" &&
    "type" in block &&
    block.type === "tool_result" &&
    "tool_use_id" in block &&
    typeof block.tool_use_id === "string"
  );
}

function extractToolResultText(
  content: SdkToolResultBlock["content"],
): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const textParts: string[] = [];
  for (const block of content) {
    if (
      block != null &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

/**
 * Maps the tool results carried by an SDK user message. `toolNamesById` holds
 * the names of tool calls seen earlier in the turn, so metrics can be parsed
 * for known tools. Non-array content and non-result blocks yield nothing.
 */
export function mapToolResultBlocks(
  sdkContent: SDKUserMessage["message"]["content"],
  toolNamesById: ReadonlyMap<string, string>,
): MessageContentBlock[] {
  if (!Array.isArray(sdkContent)) return [];
  const blocks: MessageContentBlock[] = [];
  for (const block of sdkContent) {
    if (!isSdkToolResultBlock(block)) continue;
    const text = extractToolResultText(block.content);
    const toolName = toolNamesById.get(block.tool_use_id);
    const metrics: ToolResultMetrics = toolName
      ? parseToolResultMetrics(toolName, text)
      : {};
    blocks.push({
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      ...(text ? { content: text } : {}),
      ...(block.is_error ? { isError: true } : {}),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    });
  }
  return blocks;
}
