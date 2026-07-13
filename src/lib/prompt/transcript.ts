import {
  appendFile,
  readFile,
  writeFile,
  mkdir,
  open,
  stat,
} from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import type {
  TranscriptMessage,
  MessageContentBlock,
  TranscriptMessageOrigin,
} from "@/lib/conversations/schemas";
import { getConfigDirPath } from "@/lib/config/loader";
import { parseToolResultMetrics } from "@/lib/conversations/parse-tool-result";
import { resolveImageRefs } from "@/lib/images/transcript-images";
import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";

const transcriptLogger = createLogger("transcript");
import { getErrorMessage } from "@/lib/shared/errors";
import { parseCommandContent } from "@/lib/commands/parsing";
import {
  broadcast as defaultBroadcast,
  type BroadcastFn,
} from "@/lib/events/broadcaster";
import {
  messageAppendedEventSchema,
  type MessageAppendedEvent,
} from "@/lib/conversations/schemas";
import { conversationEventScopeFields } from "@/lib/conversations/project-conversation-scope";
import { indexSessionMarkdownDocuments as defaultIndexMarkdownDocuments } from "@/lib/documents/session-index";
// ============================================================
// Transcript Entry Types
// ============================================================

/** A single entry in our JSONL transcript file */
export interface TranscriptEntry {
  /** Stable visible-message id used by cross-surface audit links. */
  id?: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** SDK message type */
  type: string;
  /** Message role (for user/assistant messages; `notice` = CC-authored) */
  role?: "user" | "assistant" | "notice";
  /** Extracted content blocks (for user/assistant/notice messages) */
  content?: MessageContentBlock[];
  /** Full SDK message data (for debugging/future use) */
  raw?: unknown;
  /** Model used for this turn (stored on user entries) */
  model?: string;
  /** Reasoning effort level used for this turn (stored on user entries) */
  effort?: string;
  /** SDK message UUID (stored on assistant entries for fork resumeSessionAt) */
  uuid?: string;
  /** Where this entry originated. Absent on legacy entries and any caller that
   *  doesn't yet thread it through. Persisted verbatim to JSONL. */
  origin?: TranscriptMessageOrigin;
}

/**
 * A transcript entry that surfaces as a conversation message: a user,
 * assistant, or CC-authored notice entry with non-empty content. Shared by
 * the SSE broadcast gate, the conversation read path, and the fork/copy
 * merged-message counting so they stay index-consistent.
 */
function isVisibleEntry(entry: TranscriptEntry): entry is TranscriptEntry & {
  role: "user" | "assistant" | "notice";
  content: MessageContentBlock[];
} {
  return (
    (entry.role === "user" ||
      entry.role === "assistant" ||
      entry.role === "notice") &&
    entry.content !== undefined &&
    entry.content.length > 0
  );
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
  indexMarkdownDocuments(input: {
    projectName: string;
    sessionName: string;
    seenAt: string;
    content: MessageContentBlock[];
  }): Promise<void>;
}

const productionDeps: TranscriptDeps = {
  broadcast: defaultBroadcast,
  indexMarkdownDocuments: defaultIndexMarkdownDocuments,
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

// Cache the 0-based JSONL line index of the last appended line per transcript
// file path. Required because the previous implementation re-read the whole
// file on every append to count newlines — pathological on long-running
// conversations. Conversation-level locking serializes appends per filePath,
// so a simple in-memory counter is safe. Bounded by oldest-first eviction at
// LAST_SEQ_CACHE_MAX entries (mirrors the lastAssistantCache pattern below).
//
// Why: any code path that truncates or rewrites an existing transcript file
// MUST invalidate the cache for that path via _resetLastSeqCacheForTesting()
// or by deleting the entry. Today, no production code truncates transcripts
// in place — `copyTranscriptUpTo` writes to a different target.
const LAST_SEQ_CACHE_MAX = 500;
const lastSeqCache = new Map<string, number>();
const idempotentAppendLocks = new Map<string, Promise<void>>();

export function _resetLastSeqCacheForTesting(): void {
  lastSeqCache.clear();
}

async function countNewlinesInFile(filePath: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let count = 0;
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => {
      const buf =
        typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) count++;
      }
    });
    stream.on("end", () => resolve(count));
    stream.on("error", reject);
  });
}

async function getNextAppendSeq(filePath: string): Promise<number> {
  const cached = lastSeqCache.get(filePath);
  if (cached !== undefined) {
    const next = cached + 1;
    lastSeqCache.set(filePath, next);
    return next;
  }

  let preAppendLineCount = 0;
  if (existsSync(filePath)) {
    try {
      preAppendLineCount = await countNewlinesInFile(filePath);
    } catch {
      preAppendLineCount = 0;
    }
  }

  if (lastSeqCache.size >= LAST_SEQ_CACHE_MAX) {
    const firstKey = lastSeqCache.keys().next().value;
    if (firstKey !== undefined) lastSeqCache.delete(firstKey);
  }
  lastSeqCache.set(filePath, preAppendLineCount);
  return preAppendLineCount;
}

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

  // Compute seq from the cached pre-append line count. Only compute when
  // we're actually going to broadcast — saves work on fabricated /
  // non-broadcasting paths (e.g. `copyTranscriptUpTo`).
  const seq = meta ? await getNextAppendSeq(filePath) : 0;

  const line = JSON.stringify(entry) + "\n";
  await appendFile(filePath, line, "utf-8");

  if (meta && isVisibleEntry(entry)) {
    try {
      await activeDeps.indexMarkdownDocuments({
        projectName: meta.projectName,
        sessionName: meta.sessionName,
        seenAt: entry.timestamp,
        content: entry.content,
      });
    } catch (err) {
      transcriptLogger.warn("documents-index.index_failed", {
        projectName: meta.projectName,
        sessionName: meta.sessionName,
        conversationId,
        error: getErrorMessage(err),
      });
    }
  }

  // direct broadcast (not StatusBus): clients register
  // `es.addEventListener('message-appended', ...)`, which requires a dedicated
  // event-name frame line that StatusBus's generic envelope does not provide.
  if (meta && isVisibleEntry(entry)) {
    const event: MessageAppendedEvent = messageAppendedEventSchema.parse({
      type: "message-appended",
      ...conversationEventScopeFields(
        meta.projectName,
        meta.sessionName,
        conversationId,
      ),
      seq,
      message: {
        ...(entry.id !== undefined ? { id: entry.id } : {}),
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp ?? null,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
        ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
      },
    });
    activeDeps.broadcast(event);
  }
}

export async function appendTranscriptEntryOnce(
  conversationId: string,
  entry: TranscriptEntry & { id: string },
  configDir?: string,
  meta?: TranscriptBroadcastMeta,
): Promise<void> {
  const filePath = await getTranscriptPath(conversationId, configDir);
  const previous = idempotentAppendLocks.get(filePath) ?? Promise.resolve();
  const current = previous.then(async () => {
    if (existsSync(filePath)) {
      const raw = await readFile(filePath, "utf-8");
      const alreadyAppended = raw.split("\n").some((line) => {
        if (line.trim() === "") return false;
        try {
          return (JSON.parse(line) as { id?: unknown }).id === entry.id;
        } catch {
          return false;
        }
      });
      if (alreadyAppended) return;
    }
    await appendTranscriptEntry(conversationId, entry, configDir, meta);
  });
  const settled = current.catch(() => undefined);
  idempotentAppendLocks.set(filePath, settled);
  try {
    await current;
  } finally {
    if (idempotentAppendLocks.get(filePath) === settled) {
      idempotentAppendLocks.delete(filePath);
    }
  }
}

// ============================================================
// System Notices
// ============================================================

export interface AppendNoticeInput {
  conversationId: string;
  /** Notice body shown in the conversation as a system-style row */
  text: string;
  projectName: string;
  sessionName: string;
  /** Optional config directory for transcript path resolution */
  configDir?: string;
}

/**
 * Append a CC-authored notice entry to the conversation transcript and
 * broadcast it as a `message-appended` SSE event. Notices are durable
 * informational rows (e.g., command rejections, fallback explanations) —
 * not user or agent turns.
 */
export async function appendNotice(input: AppendNoticeInput): Promise<void> {
  const { conversationId, text, projectName, sessionName, configDir } = input;
  await appendTranscriptEntry(
    conversationId,
    {
      timestamp: new Date().toISOString(),
      type: "notice",
      role: "notice",
      content: [{ type: "text", text }],
    },
    configDir,
    { projectName, sessionName },
  );
  transcriptLogger.info("notice_appended", {
    conversationId,
    projectName,
    sessionName,
    textLength: text.length,
  });
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

    if (isVisibleEntry(entry)) {
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
  let targetMergedRole: TranscriptEntry["role"] | null = null;
  let inclusiveAnchorUuid: string | null = null;

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }

    if (!isVisibleEntry(entry)) continue;

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
export { parseCommandContent } from "@/lib/commands/parsing";

// ============================================================
// Tail-read: most recent assistant content (hot path)
// ============================================================

// Read only the last TAIL_READ_BYTES of the JSONL to locate the most recent
// assistant entry — full transcripts can be many MB and reading them on every
// /api/conversations/active hit pegs the event loop. Cache by (mtimeMs, size)
// so the common SSE-storm case (state unchanged between invalidations) is O(1).
const TAIL_READ_BYTES = 256 * 1024;
const LAST_ASSISTANT_CACHE_MAX = 500;

interface LastAssistantCacheEntry {
  mtimeMs: number;
  size: number;
  blocks: MessageContentBlock[] | null;
}

const lastAssistantCache = new Map<string, LastAssistantCacheEntry>();

export function _resetLastAssistantCacheForTesting(): void {
  lastAssistantCache.clear();
}

async function readLastAssistantContentFromTail(
  transcriptPath: string,
  fileSize: number,
): Promise<MessageContentBlock[] | null> {
  if (fileSize === 0) return null;

  const fh = await open(transcriptPath, "r");
  try {
    const readSize = Math.min(fileSize, TAIL_READ_BYTES);
    const readStart = fileSize - readSize;
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, readStart);

    let text = buf.toString("utf-8");
    if (readStart > 0) {
      // Drop the leading partial line — its start lies before our read window.
      const firstNewline = text.indexOf("\n");
      if (firstNewline < 0) return null;
      text = text.slice(firstNewline + 1);
    }

    const lines = text.split("\n");
    const collected: MessageContentBlock[] = [];
    let foundAssistant = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.trim().length === 0) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue;
      }
      if (entry.role === "assistant") {
        if (entry.content && entry.content.length > 0) {
          // Walking backward — prepend to keep chronological order across
          // consecutive assistant entries (matches the merge semantics of
          // readConversationMessages).
          collected.unshift(...entry.content);
        }
        foundAssistant = true;
        continue;
      }
      if (entry.role === "user" && foundAssistant) {
        break;
      }
    }

    if (!foundAssistant || collected.length === 0) return null;
    return collected;
  } finally {
    await fh.close();
  }
}

/**
 * Read just the content blocks of the most recent assistant entry from a
 * transcript file. Uses a tail-read (no full-file parse) and an mtime+size
 * cache so repeated calls between writes are O(1).
 *
 * Returns null on missing path, missing file, empty file, or any read failure.
 * Image-ref blocks are NOT resolved — callers that need inline images must
 * fall back to `readConversationMessages`.
 */
export async function readLastAssistantContent(
  transcriptPath: string | null,
): Promise<MessageContentBlock[] | null> {
  if (!transcriptPath) return null;

  let stats;
  try {
    stats = await stat(transcriptPath);
  } catch {
    return null;
  }

  const cached = lastAssistantCache.get(transcriptPath);
  if (
    cached &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size
  ) {
    return cached.blocks;
  }

  let blocks: MessageContentBlock[] | null;
  try {
    blocks = await readLastAssistantContentFromTail(transcriptPath, stats.size);
  } catch {
    return cached?.blocks ?? null;
  }

  // Bounded eviction via insertion-order (oldest first).
  if (lastAssistantCache.size >= LAST_ASSISTANT_CACHE_MAX) {
    const firstKey = lastAssistantCache.keys().next().value;
    if (firstKey !== undefined) lastAssistantCache.delete(firstKey);
  }
  lastAssistantCache.set(transcriptPath, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    blocks,
  });
  return blocks;
}

// Cache the fully-parsed transcript message array per file path, keyed on
// (mtimeMs, size). Polling clients hit the messages endpoint many times per
// minute while the transcript is unchanged; re-reading and re-parsing the
// whole JSONL (which can grow into the MBs) on every poll pegs the event
// loop. Cache returns the array by reference so React Query can short-circuit
// re-renders on referential equality.
//
// Invariant: production transcripts are append-only. Any code path that
// truncates or rewrites a transcript MUST clear the cache for that path.
const TRANSCRIPT_READ_CACHE_MAX = 200;

interface TranscriptReadCacheEntry {
  mtimeMs: number;
  size: number;
  parsed: Array<TranscriptMessage & { seq: number }>;
}

const transcriptReadCache = new Map<string, TranscriptReadCacheEntry>();

export function _resetTranscriptReadCacheForTesting(): void {
  transcriptReadCache.clear();
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

  return timed(
    transcriptLogger,
    "transcript.read",
    {},
    async () => {
      let stats;
      try {
        stats = await stat(transcriptPath);
      } catch {
        return readConversationMessagesWithSeqImpl(transcriptPath);
      }

      const cached = transcriptReadCache.get(transcriptPath);
      if (
        cached &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.size === stats.size
      ) {
        return cached.parsed;
      }

      const parsed = await readConversationMessagesWithSeqImpl(transcriptPath);

      if (transcriptReadCache.size >= TRANSCRIPT_READ_CACHE_MAX) {
        const firstKey = transcriptReadCache.keys().next().value;
        if (firstKey !== undefined) transcriptReadCache.delete(firstKey);
      }
      transcriptReadCache.set(transcriptPath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        parsed,
      });
      return parsed;
    },
    (messages) => ({ messageCount: messages.length }),
  );
}

async function readConversationMessagesWithSeqImpl(
  transcriptPath: string,
): Promise<Array<TranscriptMessage & { seq: number }>> {
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

    if (!isVisibleEntry(entry)) continue;

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
            ...(entry.id !== undefined ? { id: entry.id } : {}),
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
        ...(entry.id !== undefined ? { id: entry.id } : {}),
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp ?? null,
        // User entries carry their own metadata; assistant entries inherit.
        // CC-authored notices are not agent turns and carry neither.
        ...(entry.role === "notice"
          ? {}
          : {
              model: entry.role === "user" ? entry.model : currentModel,
              effort: entry.role === "user" ? entry.effort : currentEffort,
            }),
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
// Entry-level read (raw JSONL coordinates, no merging)
// ============================================================

interface TranscriptEntryBaseWithSeq {
  /** 0-based JSONL line index of this entry. */
  seq: number;
  /** `TranscriptEntry.id` when present; null on id-less/legacy entries. */
  entryId: string | null;
  timestamp: string | null;
}

/**
 * One visible JSONL transcript entry addressed by its raw line coordinate.
 * Unlike `TranscriptMessage & { seq }`, consecutive same-role entries are NOT
 * merged, so every contributing line keeps its own `seq` — required by
 * seq-range windows and delta boundaries that fall inside a merged message
 * (docs/design/conversation-compaction/README.md §3).
 */
export interface TranscriptMessageEntryWithSeq extends TranscriptEntryBaseWithSeq {
  /** Never stamped by the reader; declared so `kind` narrows the union. */
  kind?: "message";
  role: "user" | "assistant" | "notice";
  content: MessageContentBlock[];
}

/**
 * A stored `{type:"tool_result", raw:<SDK user message>}` JSONL line. These
 * lines are NOT visible messages (no role/content), so the merged reader and
 * message counting ignore them, but the compact-transcript renderer folds
 * them into the assistant turn they interleave with (design §4 tool_result
 * row). `content` holds `tool_result` blocks parsed defensively from `raw`.
 */
export interface TranscriptToolResultEntryWithSeq extends TranscriptEntryBaseWithSeq {
  kind: "tool_result";
  content: MessageContentBlock[];
}

export type TranscriptEntryWithSeq =
  | TranscriptMessageEntryWithSeq
  | TranscriptToolResultEntryWithSeq;

export interface TranscriptEntriesResult {
  entries: TranscriptEntryWithSeq[];
  /** seq of the last visible entry; -1 when the transcript has none. */
  maxSeq: number;
}

const EMPTY_ENTRIES_RESULT: TranscriptEntriesResult = {
  entries: [],
  maxSeq: -1,
};

// Separate cache from transcriptReadCache: that one stores the merged
// (coordinate-lossy) message array, this one stores raw entry records.
// Same (mtimeMs, size) gating, bound, and return-by-reference contract.
const TRANSCRIPT_ENTRIES_CACHE_MAX = 200;

interface TranscriptEntriesCacheEntry {
  mtimeMs: number;
  size: number;
  parsed: TranscriptEntriesResult;
}

const transcriptEntriesCache = new Map<string, TranscriptEntriesCacheEntry>();

export function _resetTranscriptEntriesCacheForTesting(): void {
  transcriptEntriesCache.clear();
}

/**
 * Read every visible transcript entry with its raw JSONL line index, without
 * same-role merging, plus stored tool_result lines as `kind:"tool_result"`
 * records (their real line index preserved). Handles null paths and missing
 * files gracefully. `maxSeq` remains the last VISIBLE entry's seq.
 *
 * `image_ref` blocks pass through unresolved: entry-level consumers (the
 * compact-transcript renderer) only ever emit `[image <mediaType>]`
 * placeholders, so resolving refs would add per-block disk I/O for nothing.
 */
export async function readTranscriptEntriesWithSeq(
  transcriptPath: string | null,
): Promise<TranscriptEntriesResult> {
  if (!transcriptPath) return EMPTY_ENTRIES_RESULT;

  if (!existsSync(transcriptPath)) return EMPTY_ENTRIES_RESULT;

  return timed(
    transcriptLogger,
    "transcript.read_entries",
    {},
    async () => {
      let stats;
      try {
        stats = await stat(transcriptPath);
      } catch {
        return readTranscriptEntriesWithSeqImpl(transcriptPath);
      }

      const cached = transcriptEntriesCache.get(transcriptPath);
      if (
        cached &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.size === stats.size
      ) {
        return cached.parsed;
      }

      const parsed = await readTranscriptEntriesWithSeqImpl(transcriptPath);

      if (transcriptEntriesCache.size >= TRANSCRIPT_ENTRIES_CACHE_MAX) {
        const firstKey = transcriptEntriesCache.keys().next().value;
        if (firstKey !== undefined) transcriptEntriesCache.delete(firstKey);
      }
      transcriptEntriesCache.set(transcriptPath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        parsed,
      });
      return parsed;
    },
    (result) => ({
      entryCount: result.entries.length,
      maxSeq: result.maxSeq,
    }),
  );
}

/**
 * Defensively parse a stored tool_result line's `raw` payload into
 * `tool_result` content blocks. The production shape (written by
 * `processMessage`) is the full SDK user message —
 * `{ type:"user", message:{ content:[{type:"tool_result", tool_use_id,
 * content, is_error}] } }` where `content` is a string or an array of
 * `{type:"text"|"tool_reference", …}` blocks. Legacy/fabricated lines may
 * store the bare block itself. Anything unrecognizable becomes a single
 * generic block — this function never throws.
 *
 * The raw payload carries no tool name, so metrics are recovered by pairing
 * `tool_use_id` with the preceding assistant `tool_use` blocks
 * (`toolNamesById`) and re-running `parseToolResultMetrics`, exactly like the
 * live Claude turn path (`query-session.ts` `buildToolResultBlock`).
 */
function parseStoredToolResultBlocks(
  raw: unknown,
  toolNamesById: ReadonlyMap<string, string>,
): MessageContentBlock[] {
  const candidates: unknown[] = [];
  if (raw !== null && typeof raw === "object") {
    const rawObj = raw as { message?: unknown; content?: unknown };
    const message = rawObj.message;
    const messageContent =
      message !== null && typeof message === "object"
        ? (message as { content?: unknown }).content
        : undefined;
    if (Array.isArray(messageContent)) {
      candidates.push(...messageContent);
    } else if (Array.isArray(rawObj.content)) {
      candidates.push(...rawObj.content);
    } else {
      candidates.push(raw);
    }
  }

  const blocks: MessageContentBlock[] = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    const record = candidate as {
      type?: unknown;
      tool_use_id?: unknown;
      is_error?: unknown;
      content?: unknown;
    };
    if (typeof record.tool_use_id !== "string") continue;
    if (record.type !== undefined && record.type !== "tool_result") continue;
    const text = extractStoredToolResultText(record.content);
    const toolName = toolNamesById.get(record.tool_use_id);
    const metrics = toolName ? parseToolResultMetrics(toolName, text) : {};
    blocks.push({
      type: "tool_result",
      tool_use_id: record.tool_use_id,
      ...(text !== undefined ? { content: text } : {}),
      ...(record.is_error === true ? { isError: true } : {}),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    });
  }

  if (blocks.length === 0) {
    return [
      {
        type: "tool_result",
        tool_use_id: "",
        content: "[unrecognized tool_result payload]",
      },
    ];
  }
  return blocks;
}

function extractStoredToolResultText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.length > 0 ? content : undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

async function readTranscriptEntriesWithSeqImpl(
  transcriptPath: string,
): Promise<TranscriptEntriesResult> {
  const raw = await readFile(transcriptPath, "utf-8");
  const lines = raw.split("\n");
  const entries: TranscriptEntryWithSeq[] = [];
  const toolNamesById = new Map<string, string>();
  let maxSeq = -1;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line || line.trim().length === 0) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }

    if (isVisibleEntry(entry)) {
      for (const block of entry.content) {
        if (block.type === "tool_use" && block.id !== undefined) {
          toolNamesById.set(block.id, block.name);
        }
      }
      entries.push({
        seq: lineIndex,
        entryId: entry.id ?? null,
        role: entry.role,
        timestamp: entry.timestamp ?? null,
        content: entry.content,
      });
      // maxSeq tracks VISIBLE entries only: a trailing tool_result line
      // belongs to an in-flight turn and must not advance staleness.
      maxSeq = lineIndex;
      continue;
    }

    if (entry.type === "tool_result") {
      entries.push({
        kind: "tool_result",
        seq: lineIndex,
        entryId: entry.id ?? null,
        timestamp: entry.timestamp ?? null,
        content: parseStoredToolResultBlocks(entry.raw, toolNamesById),
      });
    }
  }

  return { entries, maxSeq };
}

// ============================================================
// Safe Transcript Write
// ============================================================

/**
 * Append a transcript entry, logging failures but not throwing.
 * Used by prompt.ts and orchestrator.ts for fire-and-forget transcript writes.
 */

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
