import type { MessageContentBlock } from "@/types";

/**
 * Extracts a plain-text/Markdown representation of a message's content
 * blocks for copying to the clipboard. Skips non-textual blocks (tool calls,
 * tool results, images) and renders command blocks as their slash form.
 */
export function extractCopyText(content: MessageContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "command") {
      parts.push(block.args ? `${block.name} ${block.args}` : block.name);
    }
  }
  return parts.join("\n\n");
}
