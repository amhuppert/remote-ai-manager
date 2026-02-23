import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { TranscriptMessage, MessageContentBlock } from "@/types";
import { getConfigDirPath } from "./config";

// ============================================================
// Transcript Entry Types
// ============================================================

/** A single entry in our JSONL transcript file */
export interface TranscriptEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** SDK message type */
  type: string;
  /** Message role (for user/assistant messages) */
  role?: "user" | "assistant";
  /** Extracted content blocks (for user/assistant messages) */
  content?: MessageContentBlock[];
  /** Full SDK message data (for debugging/future use) */
  raw?: unknown;
}

// ============================================================
// Path Management
// ============================================================

/** Get the transcripts directory path */
function getTranscriptsDir(): string {
  return path.join(getConfigDirPath(), "transcripts");
}

/** Ensure the transcripts directory exists */
async function ensureTranscriptsDir(): Promise<void> {
  const dir = getTranscriptsDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/** Get the full absolute path to a transcript file for a conversation */
export async function getTranscriptPath(
  conversationId: string,
): Promise<string> {
  await ensureTranscriptsDir();
  return path.join(getTranscriptsDir(), `${conversationId}.jsonl`);
}

// ============================================================
// Write Operations
// ============================================================

/**
 * Append a single transcript entry to the conversation's JSONL file.
 * Creates the file if it doesn't exist.
 */
export async function appendTranscriptEntry(
  conversationId: string,
  entry: TranscriptEntry,
): Promise<void> {
  const filePath = await getTranscriptPath(conversationId);
  const line = JSON.stringify(entry) + "\n";
  await appendFile(filePath, line, "utf-8");
}

// ============================================================
// Read Operations
// ============================================================

/**
 * Pattern that matches user messages containing slash command invocation tags.
 * Example: "<command-name>/kiro:spec-init</command-name>\n<command-args>notifications</command-args>"
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
 * Read conversation messages from a transcript file.
 * Handles null paths and missing files gracefully (returns []).
 *
 * Parses our own JSONL format where each line is a TranscriptEntry.
 * Filters for user/assistant entries with content blocks.
 */
export async function readConversationMessages(
  transcriptPath: string | null,
): Promise<TranscriptMessage[]> {
  if (!transcriptPath) return [];

  if (!existsSync(transcriptPath)) return [];

  const raw = await readFile(transcriptPath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const messages: TranscriptMessage[] = [];

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }

    if (entry.role !== "user" && entry.role !== "assistant") continue;
    if (!entry.content || entry.content.length === 0) continue;

    // Check for slash command invocations in user text messages
    if (entry.role === "user" && entry.content.length === 1) {
      const block = entry.content[0];
      if (block && block.type === "text" && "text" in block) {
        const commandBlock = parseCommandContent(block.text);
        if (commandBlock) {
          messages.push({
            role: "user",
            content: [commandBlock],
            timestamp: entry.timestamp ?? null,
          });
          continue;
        }
      }
    }

    const prev = messages[messages.length - 1];
    if (prev && prev.role === entry.role) {
      // Merge consecutive messages from the same role into one
      prev.content = [...prev.content, ...entry.content];
    } else {
      messages.push({
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp ?? null,
      });
    }
  }

  return messages;
}
