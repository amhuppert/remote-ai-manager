import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TranscriptMessage } from "@/types";

/**
 * Content block in a Claude transcript message.
 * Only text blocks are extracted; tool_use, tool_result, etc. are ignored.
 */
interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Shape of a transcript JSONL entry that contains a message.
 * Not all entries have messages — tool events, permission events, etc. are skipped.
 */
interface TranscriptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  timestamp?: string;
}

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
      entry = JSON.parse(line) as TranscriptEntry;
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

    messages.push({
      role: role as "user" | "assistant",
      content,
      timestamp: entry.timestamp ?? null,
    });
  }

  return messages;
}

/**
 * Extract text content from a message content field.
 * Handles both string and array-of-blocks formats.
 */
function extractContent(
  content: string | ContentBlock[] | undefined,
): string | null {
  if (!content) return null;

  if (typeof content === "string") {
    return content.trim() || null;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!);

    const joined = textParts.join("\n").trim();
    return joined || null;
  }

  return null;
}
