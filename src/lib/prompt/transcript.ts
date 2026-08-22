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
import { projectStoredToolResultBlocks } from "@/lib/agent-backends/transcript-projections";
import { resolveImageRefs } from "@/lib/images/transcript-images";
import { createLogger, type Logger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";

const transcriptLogger = createLogger("transcript");
import { getErrorMessage } from "@/lib/shared/errors";
import { parseJsonl } from "@/lib/shared/read-jsonl";
import {
  commandBlockForEntry,
  groupLogicalUnits,
  iterateLineClassifications,
  startsNewLogicalUnit,
  type LogicalUnitEntry,
  type LogicalUnitRole,
} from "@/lib/conversations/transcript-logical-units";
import {
  selectLatestExplicitTurnAgentSettings,
  type TurnAgentSettings,
} from "@/lib/conversations/last-turn-agent-settings";
import { publishEvent, type PublishFn } from "@/lib/events/publication";
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
  /** Whether this Codex turn used Fast mode (stored on user entries). */
  codexFastMode?: boolean;
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
 * Project + conversation-store identity passed to write APIs so the transcript
 * module can publish `message-appended` SSE events scoped to the right
 * conversation. Optional: omitting it suppresses the broadcast (used by tests /
 * utility paths like `copyTranscriptUpTo` that fabricate transcripts).
 *
 * `storeSessionName` is the SESSION-KEYED STORE name and is the project sentinel
 * for a project conversation, so it may only be handed to internal adapters
 * (`indexMarkdownDocuments`) or run through `conversationEventScopeFields` — it
 * is deliberately NOT named `sessionName`, because every consumer here spreads
 * meta into a payload or a log line and a `sessionName` key is a public identity
 * surface the sentinel must never occupy (R1.3).
 */
export interface TranscriptBroadcastMeta {
  projectName: string;
  storeSessionName: string;
}

interface TranscriptDeps {
  broadcast: PublishFn;
  indexMarkdownDocuments(input: {
    projectName: string;
    sessionName: string;
    seenAt: string;
    content: MessageContentBlock[];
  }): Promise<void>;
  /**
   * Sink for the scope-carrying diagnostics below. Injected for the same reason
   * `broadcast` is: what these emit is asserted (R1.3), and the module-level
   * file logger has no seam a test can read.
   */
  log: Logger;
}

const productionDeps: TranscriptDeps = {
  broadcast: publishEvent,
  indexMarkdownDocuments: defaultIndexMarkdownDocuments,
  log: transcriptLogger,
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
      // Internal adapter (A5): the document index is session-keyed storage and
      // legitimately receives the sentinel.
      await activeDeps.indexMarkdownDocuments({
        projectName: meta.projectName,
        sessionName: meta.storeSessionName,
        seenAt: entry.timestamp,
        content: entry.content,
      });
    } catch (err) {
      activeDeps.log.warn("documents-index.index_failed", {
        ...conversationEventScopeFields(
          meta.projectName,
          meta.storeSessionName,
          conversationId,
        ),
        error: getErrorMessage(err),
      });
    }
  }

  // wire-only publication (no lifecycle envelope): clients register
  // `es.addEventListener('message-appended', ...)`, which requires a dedicated
  // event-name frame line that StatusBus's generic envelope does not provide.
  if (meta && isVisibleEntry(entry)) {
    const event: MessageAppendedEvent = messageAppendedEventSchema.parse({
      type: "message-appended",
      ...conversationEventScopeFields(
        meta.projectName,
        meta.storeSessionName,
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
        ...(entry.codexFastMode !== undefined
          ? { codexFastMode: entry.codexFastMode }
          : {}),
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
  /** Session-keyed store name — the project sentinel for a PLC (see `TranscriptBroadcastMeta`). */
  storeSessionName: string;
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
  const { conversationId, text, projectName, storeSessionName, configDir } =
    input;
  await appendTranscriptEntry(
    conversationId,
    {
      timestamp: new Date().toISOString(),
      type: "notice",
      role: "notice",
      content: [{ type: "text", text }],
    },
    configDir,
    { projectName, storeSessionName },
  );
  activeDeps.log.info("notice_appended", {
    ...conversationEventScopeFields(
      projectName,
      storeSessionName,
      conversationId,
    ),
    textLength: text.length,
  });
}

// ============================================================
// Fork / Copy Operations
// ============================================================

/**
 * Project already-split, non-blank JSONL lines into the grouping owner's
 * normalized entry shape for the raw-line walk. `seq` is the index into the
 * passed `lines` array (not the original file line index), so a cutoff `seq`
 * slices `lines` directly. Unparseable lines are skipped entirely — they never
 * become a boundary but a later cutoff still slices over them.
 */
function* toCopyEntries(
  lines: string[],
  isVisible: (entry: TranscriptEntry) => entry is TranscriptEntry & {
    role: "user" | "assistant" | "notice";
    content: MessageContentBlock[];
  },
): Generator<LogicalUnitEntry> {
  for (let i = 0; i < lines.length; i++) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(lines[i]!) as TranscriptEntry;
    } catch {
      continue;
    }
    if (isVisible(entry)) {
      yield {
        seq: i,
        kind: "message",
        role: entry.role,
        content: entry.content,
        entryId: entry.id ?? null,
        timestamp: entry.timestamp ?? null,
        ...(entry.uuid !== undefined ? { uuid: entry.uuid } : {}),
      };
    } else {
      yield { seq: i, kind: "nonvisible" };
    }
  }
}

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

  // Walk the raw lines through the shared grouping owner
  // (transcript-logical-units), which threads the merged-visible-message index
  // and unit boundary onto every line — the same rule the read/render grouping
  // uses, so a fork index means the same thing here as in the UI that produced
  // it. The classification's `mergedIndex` on a visible line already reflects
  // the unit that line would land in.
  let cutoffLineIndex = -1;
  let includedAnyVisible = false;

  for (const row of iterateLineClassifications(
    toCopyEntries(lines, isVisibleEntry),
  )) {
    if (row.visible) {
      const stop =
        mode === "exclusive"
          ? row.mergedIndex >= upToMessageIndex
          : row.mergedIndex > upToMessageIndex;
      if (stop) break;
      cutoffLineIndex = row.seq;
      includedAnyVisible = true;
    } else if (includedAnyVisible) {
      // Non-visible lines (system, tool_result, etc.) get included if they
      // come within the already-included range.
      cutoffLineIndex = row.seq;
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

  let lastAssistantUuidBefore: string | null = null;
  let targetMergedRole: LogicalUnitRole | null = null;
  let inclusiveAnchorUuid: string | null = null;

  // Reuse the shared grouping owner's line walk so the merged-index the anchor
  // resolves against is identical to the one the copy path slices and the UI
  // counts.
  const forkEntries = (function* (): Generator<LogicalUnitEntry> {
    for (const parsed of parseJsonl(raw)) {
      const entry = parsed as TranscriptEntry;
      if (!isVisibleEntry(entry)) {
        yield { seq: 0, kind: "nonvisible" };
        continue;
      }
      yield {
        seq: 0,
        kind: "message",
        role: entry.role,
        content: entry.content,
        entryId: entry.id ?? null,
        timestamp: entry.timestamp ?? null,
        ...(entry.uuid !== undefined ? { uuid: entry.uuid } : {}),
      };
    }
  })();

  for (const row of iterateLineClassifications(forkEntries)) {
    if (!row.visible) continue;

    if (opts.mode === "exclusive") {
      if (row.mergedIndex >= opts.atMessageIndex) break;
      if (row.role === "assistant" && row.uuid) {
        lastAssistantUuidBefore = row.uuid;
      }
    } else {
      if (row.mergedIndex > opts.atMessageIndex) break;
      if (row.mergedIndex === opts.atMessageIndex) {
        targetMergedRole = row.role;
        if (row.role === "assistant" && row.uuid) {
          inclusiveAnchorUuid = row.uuid;
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

    const entries = parseJsonl(text);
    const collected: MessageContentBlock[] = [];
    let foundAssistant = false;

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as TranscriptEntry;
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

// ============================================================
// Tail-read: seq of the last visible entry
// ============================================================

/**
 * The file primitives the max-seq reader is allowed to touch. Injected so the
 * bounded-bytes property — the reason this reader exists — is assertable: a
 * test wraps these and counts what was actually read. `readFullMaxSeq` is part
 * of the seam for the same reason: it is the one path that reads the whole
 * file, so leaving it outside would make "bytes consumed" unobservable exactly
 * where it matters.
 */
export interface TranscriptRangeReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface TranscriptMaxSeqIO {
  stat(filePath: string): Promise<{ mtimeMs: number; size: number }>;
  openRange(filePath: string): Promise<TranscriptRangeReader>;
  /** Exhaustive parse, used only when a bounded read cannot answer. */
  readFullMaxSeq(filePath: string): Promise<number>;
}

const productionMaxSeqIO: TranscriptMaxSeqIO = {
  stat: (filePath) => stat(filePath),
  openRange: (filePath) => open(filePath, "r"),
  readFullMaxSeq: async (filePath) =>
    (await readTranscriptEntriesWithSeqImpl(filePath)).maxSeq,
};

const MAX_SEQ_CACHE_MAX = 500;
const NEWLINE_SCAN_CHUNK_BYTES = 1024 * 1024;

interface MaxSeqCacheEntry {
  mtimeMs: number;
  size: number;
  /**
   * Number of `split("\n")` segments in the file at `size` — one more than its
   * newline-byte count. seq IS a segment index, so this is what turns a
   * window-relative position into the absolute seq the full parse reports.
   */
  totalLines: number;
  maxSeq: number;
}

/** A cold scan that could not resolve maxSeq from its window carries `null`. */
interface ColdScan {
  totalLines: number;
  maxSeq: number | null;
}

/**
 * Count line terminators as BYTES. `readline` would split JSONL on U+2028 /
 * U+2029, which `JSON.stringify` emits raw inside strings, and every such split
 * would shift the seq of every line after it.
 */
function countNewlineBytes(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) count++;
  }
  return count;
}

/**
 * Index of the last segment that parses into a VISIBLE entry, offset by the
 * absolute index of `segments[0]`. Mirrors the full parse line-for-line: blank
 * segments and segments that fail `JSON.parse` are skipped, and a trailing
 * tool_result line does not count.
 */
function lastVisibleSegmentIndex(
  segments: string[],
  baseIndex: number,
): number {
  for (let j = segments.length - 1; j >= 0; j--) {
    const line = segments[j];
    if (line === undefined || line.trim().length === 0) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (isVisibleEntry(entry)) return baseIndex + j;
  }
  return -1;
}

export interface TranscriptMaxSeqReader {
  read(transcriptPath: string | null): Promise<number>;
  resetCache(): void;
}

/**
 * Read only the seq of a transcript's last visible entry.
 *
 * The staleness consumers need one number, and parsing megabytes of NDJSON to
 * learn it blocks the event loop for every other in-flight request (JSON.parse
 * is synchronous, so concurrency does not help). This reads a bounded window
 * instead: a newline-byte scan for the absolute line count plus a tail parse
 * for the last visible line, then serves later calls from the appended byte
 * range alone.
 *
 * Cached on (mtimeMs, size) like the readers above, and like them it assumes
 * transcripts are append-only: any path that truncates or rewrites one in place
 * must reset the cache. A shrink, a same-size rewrite with a new mtime, or an
 * append whose cached boundary is not a line terminator all force a full
 * rescan rather than trusting the arithmetic.
 */
export function createTranscriptMaxSeqReader(
  io: TranscriptMaxSeqIO,
): TranscriptMaxSeqReader {
  const cache = new Map<string, MaxSeqCacheEntry>();

  function remember(filePath: string, entry: MaxSeqCacheEntry): number {
    // Bounded eviction via insertion-order (oldest first).
    if (cache.size >= MAX_SEQ_CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(filePath, entry);
    return entry.maxSeq;
  }

  // A single `read` may return short; loop until the range is filled or the
  // file ends, so a partial read can never truncate a line silently.
  async function readRange(
    reader: TranscriptRangeReader,
    start: number,
    length: number,
  ): Promise<Buffer> {
    const buf = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await reader.read(
        buf,
        filled,
        length - filled,
        start + filled,
      );
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    return filled === length ? buf : buf.subarray(0, filled);
  }

  async function coldScan(filePath: string, size: number): Promise<ColdScan> {
    if (size === 0) return { totalLines: 1, maxSeq: -1 };

    const windowSize = Math.min(size, TAIL_READ_BYTES);
    const windowStart = size - windowSize;
    const reader = await io.openRange(filePath);
    try {
      // Everything before the tail window is scanned for newline bytes only —
      // no decode, no parse. The window's own newlines come from the buffer the
      // parse below needs anyway.
      let newlines = 0;
      for (
        let start = 0;
        start < windowStart;
        start += NEWLINE_SCAN_CHUNK_BYTES
      ) {
        const chunk = await readRange(
          reader,
          start,
          Math.min(NEWLINE_SCAN_CHUNK_BYTES, windowStart - start),
        );
        newlines += countNewlineBytes(chunk);
      }
      const tail = await readRange(reader, windowStart, windowSize);
      const totalLines = newlines + countNewlineBytes(tail) + 1;

      let segments = tail.toString("utf-8").split("\n");
      if (windowStart > 0) {
        // The first segment starts before the window; only the full parse can
        // read it.
        if (segments.length < 2) return { totalLines, maxSeq: null };
        segments = segments.slice(1);
      }

      const maxSeq = lastVisibleSegmentIndex(
        segments,
        totalLines - segments.length,
      );
      // "No visible entry in the window" is only an answer when the window was
      // the whole file; otherwise the entry lies further back and guessing -1
      // would advertise a stale artifact as fresh.
      if (maxSeq === -1 && windowStart > 0) return { totalLines, maxSeq: null };
      return { totalLines, maxSeq };
    } finally {
      await reader.close();
    }
  }

  async function readAppendedRange(
    filePath: string,
    cached: MaxSeqCacheEntry,
    size: number,
  ): Promise<{ totalLines: number; maxSeq: number } | null> {
    // Read one byte before the cached end so the append can be proven to start
    // on a line boundary — without that, the segment arithmetic below silently
    // shifts every seq.
    const start = cached.size > 0 ? cached.size - 1 : 0;
    const reader = await io.openRange(filePath);
    let appended: Buffer;
    try {
      appended = await readRange(reader, start, size - start);
    } finally {
      await reader.close();
    }
    if (cached.size > 0) {
      if (appended[0] !== 0x0a) return null;
      appended = appended.subarray(1);
    }

    // The cached segment count ends on an empty trailing segment; the appended
    // bytes extend that segment, so they start at index totalLines - 1.
    const baseIndex = cached.totalLines - 1;
    const segments = appended.toString("utf-8").split("\n");
    const maxSeq = lastVisibleSegmentIndex(segments, baseIndex);
    return {
      totalLines: baseIndex + segments.length,
      maxSeq: maxSeq === -1 ? cached.maxSeq : maxSeq,
    };
  }

  return {
    resetCache() {
      cache.clear();
    },
    async read(transcriptPath: string | null): Promise<number> {
      if (!transcriptPath) return -1;

      return timed(
        transcriptLogger,
        "transcript.max_seq",
        {},
        async () => {
          let stats;
          try {
            stats = await io.stat(transcriptPath);
          } catch {
            // Missing or unreadable file — parity with the full reader's empty
            // result, which the staleness consumers read as "not advanced".
            return -1;
          }

          const cached = cache.get(transcriptPath);
          if (
            cached &&
            cached.mtimeMs === stats.mtimeMs &&
            cached.size === stats.size
          ) {
            return cached.maxSeq;
          }

          if (cached && stats.size > cached.size) {
            const advanced = await readAppendedRange(
              transcriptPath,
              cached,
              stats.size,
            );
            if (advanced) {
              return remember(transcriptPath, {
                mtimeMs: stats.mtimeMs,
                size: stats.size,
                ...advanced,
              });
            }
          }

          const scan = await coldScan(transcriptPath, stats.size);
          const maxSeq =
            scan.maxSeq ?? (await io.readFullMaxSeq(transcriptPath));
          return remember(transcriptPath, {
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            totalLines: scan.totalLines,
            maxSeq,
          });
        },
        (maxSeq) => ({ maxSeq }),
      );
    },
  };
}

const productionMaxSeqReader = createTranscriptMaxSeqReader(productionMaxSeqIO);

/**
 * The seq of the last visible entry in a transcript, or -1 when there is none
 * (also for a null path or a missing file). Equals
 * `readTranscriptEntriesWithSeq(path).maxSeq` without materializing entries.
 */
export async function getTranscriptMaxSeq(
  transcriptPath: string | null,
): Promise<number> {
  return productionMaxSeqReader.read(transcriptPath);
}

export function _resetTranscriptMaxSeqCacheForTesting(): void {
  productionMaxSeqReader.resetCache();
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

  // Parse the raw lines into the grouping owner's normalized entry shape,
  // tracking each visible line's per-turn model/effort so a merged unit can
  // resolve the settings active for its turn (assistant units inherit the most
  // recent user entry's; notices carry neither). The map is keyed by the raw
  // line index the owner threads through on every part.
  const entries: LogicalUnitEntry[] = [];
  const turnMetaBySeq = new Map<number, TurnAgentSettings>();
  let currentModel: string | undefined;
  let currentEffort: string | undefined;
  let currentCodexFastMode: boolean | undefined;
  let openRole: LogicalUnitRole | null = null;

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
    const opensUnit = startsNewLogicalUnit({
      openRole,
      entryRole: entry.role,
      isCommand: commandBlockForEntry(entry.role, entry.content) !== null,
    });
    if (opensUnit) openRole = entry.role;

    if (entry.role === "user") {
      const explicitSettings = selectLatestExplicitTurnAgentSettings([entry]);
      if (explicitSettings) {
        currentModel = explicitSettings.model;
        currentEffort = explicitSettings.effort;
        currentCodexFastMode = explicitSettings.codexFastMode;
        turnMetaBySeq.set(lineIndex, explicitSettings);
      } else if (opensUnit) {
        currentEffort = undefined;
        currentCodexFastMode = undefined;
      }
    } else if (entry.role === "assistant") {
      turnMetaBySeq.set(lineIndex, {
        model: currentModel,
        effort: currentEffort,
        codexFastMode: currentCodexFastMode,
      });
    }

    entries.push({
      seq: lineIndex,
      kind: "message",
      role: entry.role,
      content: entry.content,
      entryId: entry.id ?? null,
      timestamp: entry.timestamp ?? null,
    });
  }

  const units = groupLogicalUnits(entries);
  const messages: Array<TranscriptMessage & { seq: number }> = units.map(
    (unit) => {
      // A unit's content is the concatenation of its parts (the first part
      // already carries the parsed command block when the unit is a command).
      const content = unit.parts.flatMap((part) => part.content);
      const lastPart = unit.parts[unit.parts.length - 1]!;
      const meta =
        unit.role === "user"
          ? selectLatestExplicitTurnAgentSettings(
              unit.parts.map((part) => turnMetaBySeq.get(part.seq)),
            )
          : turnMetaBySeq.get(unit.parts[0]!.seq);
      return {
        ...(unit.messageId !== null ? { id: unit.messageId } : {}),
        role: unit.role,
        content,
        timestamp: unit.timestamp ?? null,
        // User entries carry their own metadata; assistant entries inherit.
        // CC-authored notices are not agent turns and carry neither.
        ...(unit.role === "notice"
          ? {}
          : {
              model: meta?.model,
              effort: meta?.effort,
              codexFastMode: meta?.codexFastMode,
            }),
        seq: lastPart.seq,
      };
    },
  );

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
 * A stored `{type:"tool_result", raw:<backend-native payload>}` JSONL line.
 * These lines are NOT visible messages (no role/content), so the merged
 * reader and message counting ignore them, but the compact-transcript
 * renderer folds them into the assistant turn they interleave with (design §4
 * tool_result row). `content` holds `tool_result` blocks projected from the
 * frame by the backend-owned decoders behind
 * `agent-backends/transcript-projections`.
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
        content: projectStoredToolResultBlocks(entry, toolNamesById),
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

/**
 * Append an entry whose producer stamped a stable id, logging failures but not
 * throwing — the non-throwing counterpart of {@link appendTranscriptEntryOnce},
 * for stream paths where a re-delivered event must not fail the turn. Persists
 * and broadcasts at most once per id, so live SSE and durable reload agree.
 */
export async function safeAppendTranscriptEntryOnce(
  conversationId: string,
  entry: TranscriptEntry & { id: string },
  logger: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
  } = transcriptLogger,
  configDir?: string,
  meta?: TranscriptBroadcastMeta,
): Promise<void> {
  try {
    await appendTranscriptEntryOnce(conversationId, entry, configDir, meta);
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
