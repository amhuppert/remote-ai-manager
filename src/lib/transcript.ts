import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { TranscriptMessage, MessageContentBlock } from "@/types";
import { getConfigDirPath } from "./config";
import { resolveImageRefs } from "./transcript-images";
import { createLogger } from "./logging";
import { getErrorMessage } from "./errors";
import { parseCommandContent } from "./command-parsing";

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
// Fork / Copy Operations
// ============================================================

export interface CopyTranscriptInput {
  sourceTranscriptPath: string;
  targetConversationId: string;
  /** 0-based index into visible messages (user/assistant with content) */
  upToMessageIndex: number;
  /** If true, include the assistant response after the target user message */
  includeAssistantResponse: boolean;
  /** If provided, replaces the message at upToMessageIndex with edited text */
  appendEditedMessage?: {
    text: string;
    timestamp: string;
  };
}

/**
 * Copy JSONL transcript entries from source to a new target file,
 * up to a specified visible message index.
 *
 * "Visible messages" are those with role=user or role=assistant and non-empty content.
 * All raw JSONL lines between visible messages (system, tool_result, etc.) are preserved.
 */
export async function copyTranscriptUpTo(
  input: CopyTranscriptInput,
): Promise<void> {
  const {
    sourceTranscriptPath,
    targetConversationId,
    upToMessageIndex,
    includeAssistantResponse,
    appendEditedMessage,
  } = input;

  const raw = await readFile(sourceTranscriptPath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  // Find the raw line index boundaries based on visible message counting
  let visibleCount = -1;
  let cutoffLineIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(lines[i]!) as TranscriptEntry;
    } catch {
      continue;
    }

    const isVisible =
      (entry.role === "user" || entry.role === "assistant") &&
      entry.content &&
      entry.content.length > 0;

    if (isVisible) {
      visibleCount++;

      if (appendEditedMessage) {
        // For edit-and-fork: copy up to (but NOT including) the target message
        if (visibleCount === upToMessageIndex) {
          cutoffLineIndex = i - 1;
          break;
        }
      } else if (includeAssistantResponse) {
        // For direct fork: include the target user message + next assistant response
        if (visibleCount === upToMessageIndex) {
          // This is the target user message — continue to find assistant response
          cutoffLineIndex = i;
        } else if (
          visibleCount === upToMessageIndex + 1 &&
          entry.role === "assistant"
        ) {
          // Found the assistant response after the fork point
          cutoffLineIndex = i;
          break;
        } else if (visibleCount > upToMessageIndex) {
          // Next visible message is user, not assistant — stop
          break;
        }
      } else {
        // Copy up to and including the target message
        if (visibleCount === upToMessageIndex) {
          cutoffLineIndex = i;
          break;
        }
      }
    } else if (visibleCount >= 0 && cutoffLineIndex >= 0) {
      // Non-visible lines after the cutoff — include them if they come before the next visible message
      cutoffLineIndex = i;
    }
  }

  // If we never broke, include remaining non-visible lines after the last match
  if (cutoffLineIndex === -1 && visibleCount >= upToMessageIndex) {
    cutoffLineIndex = lines.length - 1;
  }

  // Build the copied content
  const copiedLines =
    cutoffLineIndex >= 0 ? lines.slice(0, cutoffLineIndex + 1) : [];

  // Append edited message if provided
  if (appendEditedMessage) {
    const editedEntry: TranscriptEntry = {
      timestamp: appendEditedMessage.timestamp,
      type: "user",
      role: "user",
      content: [{ type: "text", text: appendEditedMessage.text }],
    };
    copiedLines.push(JSON.stringify(editedEntry));
  }

  // Write to target file
  const targetPath = await getTranscriptPath(targetConversationId);
  const content = copiedLines.length > 0 ? copiedLines.join("\n") + "\n" : "";
  await writeFile(targetPath, content, "utf-8");
}

// ============================================================
// Read Operations
// ============================================================

// Re-export from shared module (also used by client-side use-send-prompt.ts)
export { parseCommandContent } from "./command-parsing";

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

  // Resolve image_ref blocks back to inline image blocks
  for (const message of messages) {
    message.content = await resolveImageRefs(message.content);
  }

  return messages;
}

// ============================================================
// Safe Transcript Write
// ============================================================

/**
 * Append a transcript entry, logging failures but not throwing.
 * Used by prompt.ts and orchestrator.ts for fire-and-forget transcript writes.
 */
const transcriptLogger = createLogger("transcript");

export async function safeAppendTranscriptEntry(
  conversationId: string,
  entry: TranscriptEntry,
  logger: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
  } = transcriptLogger,
): Promise<void> {
  try {
    await appendTranscriptEntry(conversationId, entry);
  } catch (err) {
    logger.warn("transcript_write_failed", {
      conversationId,
      error: getErrorMessage(err),
    });
  }
}
