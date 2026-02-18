import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TranscriptMessage, MessageContentBlock } from "@/types";
import {
  transcriptEntrySchema,
  type ContentBlock,
  type TranscriptEntry,
} from "./schemas";

/**
 * Read and parse a Claude transcript JSONL file into structured messages.
 *
 * Transcript format: JSONL where each line is a JSON event.
 * - Lines with `type: "user"` or `type: "assistant"` have a `message` object.
 * - `message.content` may be a string or an array of content blocks.
 * - Only `text` blocks are extracted from arrays.
 * - Tool events, permission events, etc. are ignored.
 *
 * Returns messages in chronological order (file order).
 */
export async function readTranscript(
  transcriptPath: string,
): Promise<TranscriptMessage[]> {
  if (!existsSync(transcriptPath)) {
    return [];
  }

  const raw = await readFile(transcriptPath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const messages: TranscriptMessage[] = [];

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      const result = transcriptEntrySchema.safeParse(JSON.parse(line));
      if (!result.success) continue;
      entry = result.data;
    } catch {
      // Skip malformed lines
      continue;
    }

    // Only process user/assistant message entries
    const role = entry.type ?? entry.message?.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const content = extractContent(entry.message?.content);
    if (!content) {
      continue;
    }

    // role is narrowed to "user" | "assistant" by the guard above
    const narrowedRole: "user" | "assistant" = role;
    messages.push({
      role: narrowedRole,
      content,
      timestamp: entry.timestamp ?? null,
    });
  }

  return messages;
}

/**
 * Extract text content from a message content field.
 * Handles both string and array-of-blocks formats.
 * Returns content as MessageContentBlock[] or null if empty.
 */
function extractContent(
  content: string | readonly ContentBlock[] | undefined,
): MessageContentBlock[] | null {
  if (!content) return null;

  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? [{ type: "text" as const, text: trimmed }] : null;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .filter(
        (block): block is ContentBlock & { text: string } =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text);

    const joined = textParts.join("\n").trim();
    return joined ? [{ type: "text" as const, text: joined }] : null;
  }

  return null;
}
