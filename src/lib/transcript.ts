import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { TranscriptMessage, MessageContentBlock } from "@/types";
import { getConfigDirPath } from "./config";
import { resolveImageRefs } from "./transcript-images";
import { createLogger } from "./logging";
import { getErrorMessage } from "./errors";
import { parseCommandContent } from "./command-parsing";
import {
  broadcast as defaultBroadcast,
  type BroadcastFn,
} from "./sse-broadcaster";
import {
  messageAppendedEventSchema,
  type MessageAppendedEvent,
} from "./schemas";

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
  /** Model used for this turn (stored on user entries) */
  model?: string;
  /** Reasoning effort level used for this turn (stored on user entries) */
  effort?: string;
  /** SDK message UUID (stored on assistant entries for fork resumeSessionAt) */
  uuid?: string;
}

// ============================================================
// Path Management
// ============================================================

/** Get the transcripts directory path */
function getTranscriptsDir(configDir?: string): string {
  return path.join(configDir ?? getConfigDirPath(), "transcripts");
}

/** Ensure the transcripts directory exists */
async function ensureTranscriptsDir(configDir?: string): Promise<void> {
  const dir = getTranscriptsDir(configDir);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/** Get the full absolute path to a transcript file for a conversation */
export async function getTranscriptPath(
  conversationId: string,
  configDir?: string,
): Promise<string> {
  await ensureTranscriptsDir(configDir);
  return path.join(getTranscriptsDir(configDir), `${conversationId}.jsonl`);
}

// ============================================================
// Broadcast Dependency (setter pattern for testability)
// ============================================================

/**
 * Project + session identity passed to write APIs so the transcript module
 * can publish `message-appended` SSE events scoped to the right conversation.
 * Optional: omitting it suppresses the broadcast (used by tests / utility
 * paths like `copyTranscriptUpTo` that fabricate transcripts).
 */
export interface TranscriptBroadcastMeta {
  projectName: string;
  sessionName: string;
}

interface TranscriptDeps {
  broadcast: BroadcastFn;
}

const productionDeps: TranscriptDeps = {
  broadcast: defaultBroadcast,
};

let activeDeps: TranscriptDeps = productionDeps;

export function setTranscriptDeps(overrides: Partial<TranscriptDeps>): void {
  activeDeps = { ...productionDeps, ...overrides };
}

export function _resetTranscriptDepsForTesting(): void {
  activeDeps = productionDeps;
}

// ============================================================
// Write Operations
// ============================================================

/**
 * Append a single transcript entry to the conversation's JSONL file.
 * Creates the file if it doesn't exist. When `meta` is provided and the entry
 * carries a visible user/assistant message, broadcasts a `message-appended`
 * SSE event with the new entry's 0-based JSONL line index as `seq`.
 */
export async function appendTranscriptEntry(
  conversationId: string,
  entry: TranscriptEntry,
  configDir?: string,
  meta?: TranscriptBroadcastMeta,
): Promise<void> {
  const filePath = await getTranscriptPath(conversationId, configDir);

  // Compute seq from the file's pre-append line count. Only read when we're
  // actually going to broadcast — saves I/O on fabricated/non-broadcasting
  // paths (e.g. `copyTranscriptUpTo`).
  let seq = 0;
  if (meta && existsSync(filePath)) {
    try {
      const prev = await readFile(filePath, "utf-8");
      seq = prev.match(/\n/g)?.length ?? 0;
    } catch {
      seq = 0;
    }
  }

  const line = JSON.stringify(entry) + "\n";
  await appendFile(filePath, line, "utf-8");

  // direct broadcast (not StatusBus): clients register
  // `es.addEventListener('message-appended', ...)`, which requires a dedicated
  // event-name frame line that StatusBus's generic envelope does not provide.
  if (
    meta &&
    (entry.role === "user" || entry.role === "assistant") &&
    entry.content &&
    entry.content.length > 0
  ) {
    const event: MessageAppendedEvent = messageAppendedEventSchema.parse({
      type: "message-appended",
      projectName: meta.projectName,
      sessionName: meta.sessionName,
      conversationId,
      seq,
      message: {
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp ?? null,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
      },
    });
    activeDeps.broadcast(event);
  }
}

// ============================================================
// Fork / Copy Operations
// ============================================================

/** How the cutoff at `upToMessageIndex` is interpreted. */
export type CopyTranscriptMode = "exclusive" | "inclusive";

export interface CopyTranscriptInput {
  sourceTranscriptPath: string;
  targetConversationId: string;
  /**
   * 0-based index into visible (merged) messages — user/assistant entries
   * with content; consecutive entries with the same role count as one.
   *
   * `mode` determines whether the target message is itself copied:
   * - `exclusive`: copy everything BEFORE the target merged message.
   * - `inclusive`: copy everything THROUGH the target merged message
   *   (i.e., its last JSONL line is the last line in the output).
   */
  upToMessageIndex: number;
  mode: CopyTranscriptMode;
  /** Optional config directory for transcript path resolution */
  configDir?: string;
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
    mode,
    configDir,
  } = input;

  const raw = await readFile(sourceTranscriptPath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  // Find the raw line index boundaries based on merged visible message counting.
  // Consecutive JSONL entries with the same role are merged into a single logical
  // message (matching readConversationMessages), so we only increment the merged
  // index on role transitions.
  let mergedIndex = -1;
  let lastVisibleRole: string | null = null;
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
      const wouldBeMergedIndex =
        entry.role !== lastVisibleRole ? mergedIndex + 1 : mergedIndex;

      const stop =
        mode === "exclusive"
          ? wouldBeMergedIndex >= upToMessageIndex
          : wouldBeMergedIndex > upToMessageIndex;
      if (stop) {
        break;
      }

      mergedIndex = wouldBeMergedIndex;
      lastVisibleRole = entry.role ?? null;
      cutoffLineIndex = i;
    } else if (mergedIndex >= 0 && cutoffLineIndex >= 0) {
      // Non-visible lines (system, tool_result, etc.) get included if they
      // come within the already-included range.
      cutoffLineIndex = i;
    }
  }

  // Build the copied content
  const copiedLines =
    cutoffLineIndex >= 0 ? lines.slice(0, cutoffLineIndex + 1) : [];

  // Write to target file
  const targetPath = await getTranscriptPath(targetConversationId, configDir);
  const content = copiedLines.length > 0 ? copiedLines.join("\n") + "\n" : "";
  await writeFile(targetPath, content, "utf-8");
}

// ============================================================
// Fork UUID Lookup
// ============================================================

/**
 * Returns the Claude SDK message UUID a fork should anchor on for the given
 * merged-message index and mode. Mirrors the merged-message counting used by
 * copyTranscriptUpTo.
 *
 * - `mode: "exclusive"` returns the UUID of the most recent assistant entry
 *   STRICTLY BEFORE the target merged index. The SDK's `upToMessageId` is
 *   inclusive, so anchoring on the prior assistant gives the SDK a copy
 *   whose last message is that assistant turn — i.e., the source state right
 *   before the user message at the target index.
 *
 * - `mode: "inclusive"` returns the UUID of the LAST assistant entry AT the
 *   target merged index. Intended for assistant-message forks where the new
 *   conversation should keep the target assistant's turn. Returns null if
 *   the target merged message is not an assistant turn (caller should
 *   guard against this).
 *
 * Returns null when the target cannot be addressed by UUID — e.g., legacy
 * transcripts without UUID fields, or no assistant exists in the relevant
 * range.
 */
export async function findForkAnchorUuid(
  transcriptPath: string,
  opts: {
    atMessageIndex: number;
    mode: CopyTranscriptMode;
  },
): Promise<string | null> {
  const raw = await readFile(transcriptPath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  let mergedIndex = -1;
  let lastVisibleRole: string | null = null;
  let lastAssistantUuidBefore: string | null = null;
  let targetMergedRole: "user" | "assistant" | null = null;
  let inclusiveAnchorUuid: string | null = null;

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }

    const isVisible =
      (entry.role === "user" || entry.role === "assistant") &&
      entry.content &&
      entry.content.length > 0;

    if (!isVisible) continue;

    if (entry.role !== lastVisibleRole) {
      mergedIndex++;
      lastVisibleRole = entry.role ?? null;
    }

    if (opts.mode === "exclusive") {
      if (mergedIndex >= opts.atMessageIndex) break;
      if (entry.role === "assistant" && entry.uuid) {
        lastAssistantUuidBefore = entry.uuid;
      }
    } else {
      if (mergedIndex > opts.atMessageIndex) break;
      if (mergedIndex === opts.atMessageIndex) {
        targetMergedRole = entry.role ?? null;
        if (entry.role === "assistant" && entry.uuid) {
          inclusiveAnchorUuid = entry.uuid;
        }
      }
    }
  }

  if (opts.mode === "exclusive") {
    return lastAssistantUuidBefore;
  }
  return targetMergedRole === "assistant" ? inclusiveAnchorUuid : null;
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
  const stamped = await readConversationMessagesWithSeq(transcriptPath);
  return stamped.map(({ seq: _seq, ...rest }) => rest);
}

/**
 * Same as `readConversationMessages`, but each returned message carries a
 * `seq` field equal to the 0-based JSONL line index of the last entry that
 * contributed to it. Used by the cursor-reconciliation path so a client can
 * reconnect and ask for only messages newer than its last-seen seq.
 *
 * seq is derived from line position at read time — not persisted on disk.
 */
export async function readConversationMessagesWithSeq(
  transcriptPath: string | null,
): Promise<Array<TranscriptMessage & { seq: number }>> {
  if (!transcriptPath) return [];

  if (!existsSync(transcriptPath)) return [];

  const raw = await readFile(transcriptPath, "utf-8");
  const lines = raw.split("\n");
  const messages: Array<TranscriptMessage & { seq: number }> = [];

  // Track the most recent model/effort from user entries so assistant
  // messages can inherit the settings that were active for their turn.
  let currentModel: string | undefined;
  let currentEffort: string | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line || line.trim().length === 0) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }

    if (entry.role !== "user" && entry.role !== "assistant") continue;
    if (!entry.content || entry.content.length === 0) continue;

    // Update tracking when we see a user entry with model/effort metadata
    if (entry.role === "user") {
      if (entry.model !== undefined) {
        currentModel = entry.model;
      }
      // Always reset effort when we see a new user entry — if the entry
      // has no effort field, the model didn't support it for this turn.
      currentEffort = entry.effort;
    }

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
            model: entry.model,
            effort: entry.effort,
            seq: lineIndex,
          });
          continue;
        }
      }
    }

    const prev = messages[messages.length - 1];
    if (prev && prev.role === entry.role) {
      // Merge consecutive messages from the same role into one
      prev.content = [...prev.content, ...entry.content];
      prev.seq = lineIndex;
    } else {
      messages.push({
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp ?? null,
        // User entries carry their own metadata; assistant entries inherit
        model: entry.role === "user" ? entry.model : currentModel,
        effort: entry.role === "user" ? entry.effort : currentEffort,
        seq: lineIndex,
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
  configDir?: string,
  meta?: TranscriptBroadcastMeta,
): Promise<void> {
  try {
    await appendTranscriptEntry(conversationId, entry, configDir, meta);
  } catch (err) {
    logger.warn("transcript_write_failed", {
      conversationId,
      error: getErrorMessage(err),
    });
  }
}

// `message-updated` events would be wired here if there were a code path that
// rewrites an existing JSONL entry. Today every transcript update is an
// `appendFile` (see `appendTranscriptEntry`) and image externalization
// (`transcript-images.ts:externalizeImageBlocks`) substitutes blocks BEFORE
// the entry is appended — never patching an entry on disk. The
// `messageUpdatedEventSchema` + client listener exist so this wiring is a
// one-call addition the day a patch path is introduced.
