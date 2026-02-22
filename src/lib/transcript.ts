import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import type { TranscriptMessage, MessageContentBlock } from "@/types";
import {
  transcriptEntrySchema,
  type ContentBlock,
  type TranscriptEntry,
} from "./schemas";

/** Expand leading `~` to the user's home directory */
export function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return os.homedir() + p.slice(1);
  }
  return p;
}

/**
 * Read conversation messages from a Claude Code transcript file.
 * Handles null paths (returns []), tilde expansion, and delegates to readTranscript().
 */
export async function readConversationMessages(
  transcriptPath: string | null,
): Promise<TranscriptMessage[]> {
  if (!transcriptPath) return [];
  return readTranscript(expandTilde(transcriptPath));
}

/**
 * Pattern that matches user messages containing slash command invocation tags.
 * Example content: "<command-name>/kiro:spec-init</command-name>\n<command-args>notifications</command-args>"
 */
const COMMAND_NAME_RE = /<command-name>\/?(.+?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * Try to parse a command invocation from a user message's string content.
 * Returns a command content block if the message is a slash command, null otherwise.
 */
export function parseCommandContent(
  content: string,
): MessageContentBlock | null {
  const nameMatch = content.match(COMMAND_NAME_RE);
  if (!nameMatch) return null;

  const name = nameMatch[1]!;
  const argsMatch = content.match(COMMAND_ARGS_RE);
  const args = argsMatch?.[1]?.trim() || null;

  return { type: "command" as const, name: `/${name}`, args };
}

/**
 * Read and parse a Claude transcript JSONL file into structured messages.
 *
 * Transcript format: JSONL where each line is a JSON event.
 * - Lines with `type: "user"` or `type: "assistant"` have a `message` object.
 * - `message.content` may be a string or an array of content blocks.
 * - Only `text` blocks are extracted from arrays.
 * - Tool events, permission events, etc. are ignored.
 * - Slash command invocations are detected and rendered as compact command blocks.
 * - Expanded skill/command content (the child message) is skipped.
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

  // Track UUIDs of command invocation messages so we can skip their expanded children
  const commandUuids = new Set<string>();

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

    // Skip expanded command content (child message of a command invocation)
    if (
      role === "user" &&
      entry.parentUuid &&
      commandUuids.has(entry.parentUuid)
    ) {
      continue;
    }

    // Check if this is a slash command invocation (string content with <command-name> tags)
    if (role === "user" && typeof entry.message?.content === "string") {
      const commandBlock = parseCommandContent(entry.message.content);
      if (commandBlock) {
        // Track this UUID so the expanded child message gets skipped
        if (entry.uuid) {
          commandUuids.add(entry.uuid);
        }
        messages.push({
          role: "user",
          content: [commandBlock],
          timestamp: entry.timestamp ?? null,
        });
        continue;
      }
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
