/**
 * Complete, unexcerpted export of ONE archive entry.
 *
 * The bounded reader answers "what happened here"; this answers "show me
 * exactly what that entry said". Both project the same normalized entries
 * through the same block formatter — this one with its presentation limits
 * lifted — so an export can never read differently from the transcript it came
 * from, and no provider-native payload is interpreted above the adapter.
 *
 * A single entry can be enormous (a 40 MB tool result is an ordinary day), so
 * the export is deliberately NOT something the bounded reader collects: the
 * reader excerpts and reports the recovery command, and only an explicit
 * request for that one entry materializes it. `historyEntryTextStream` exists
 * so an HTTP route can stream those bytes rather than build a JSON body around
 * them.
 *
 * This module reads. It admits nothing, submits no prompt, and has no effect
 * on any conversation's model context.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  historyEntryMetadataSchema,
  historyImageHandles,
} from "@/lib/conversations/history-recovery";
import {
  groupTranscriptEntries,
  captureOriginLabel,
  renderCompleteEntryLines,
} from "@/lib/conversations/transcript-render";
import {
  readTranscriptEntriesWithSeq as defaultReadTranscriptEntriesWithSeq,
  type TranscriptEntriesResult,
  type TranscriptEntryWithSeq,
} from "@/lib/prompt/transcript";

/** The full entry: its shared metadata plus the exported body. */
export const historyEntrySchema = historyEntryMetadataSchema.extend({
  lines: z.array(z.string()),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyEntryRefusalCodeSchema = z.enum([
  /** No archive line addresses this sequence. */
  "entry_not_found",
  /** The line exists but the adapter does not project it as a readable entry. */
  "entry_unsupported",
]);
export type HistoryEntryRefusalCode = z.infer<
  typeof historyEntryRefusalCodeSchema
>;

export type HistoryEntryResult =
  | { ok: true; entry: HistoryEntry }
  | {
      ok: false;
      code: HistoryEntryRefusalCode;
      seq: number;
      reason: string;
    };

export interface HistoryEntryServiceDeps {
  readTranscriptEntries(
    transcriptPath: string | null,
  ): Promise<TranscriptEntriesResult>;
}

export interface GetHistoryEntryInput {
  conversationId: string;
  /** Resolved by the SCOPED caller; this module never addresses a conversation. */
  transcriptPath: string | null;
  seq: number;
  includeThinking?: boolean;
}

export interface HistoryEntryService {
  getEntry(input: GetHistoryEntryInput): Promise<HistoryEntryResult>;
}

function defaultDeps(): HistoryEntryServiceDeps {
  return { readTranscriptEntries: defaultReadTranscriptEntriesWithSeq };
}

/**
 * What ONE raw sequence addresses in an archive — the single owner of that
 * question, so the entry export and the image endpoint cannot disagree about
 * which coordinates exist.
 *
 * A line the adapter does not project (a system frame, say) is `unsupported`
 * rather than absent: the distinction tells a caller whether retrying the
 * coordinate could ever work.
 */
export type ArchiveEntryLookup =
  | { ok: true; entry: TranscriptEntryWithSeq }
  | {
      ok: false;
      code: HistoryEntryRefusalCode;
      reason: string;
    };

export function lookupArchiveEntry(
  entries: TranscriptEntriesResult,
  seq: number,
): ArchiveEntryLookup {
  if (!Number.isInteger(seq) || seq < 0) {
    return {
      ok: false,
      code: "entry_not_found",
      reason: "sequence is not a raw line index",
    };
  }
  const entry = entries.entries.find((candidate) => candidate.seq === seq);
  if (entry !== undefined) return { ok: true, entry };
  return seq <= entries.maxSeq
    ? {
        ok: false,
        code: "entry_unsupported",
        reason: "the archive line at this sequence is not a readable entry",
      }
    : {
        ok: false,
        code: "entry_not_found",
        reason: "no archive line at this sequence",
      };
}

function refuse(
  code: HistoryEntryRefusalCode,
  seq: number,
  reason: string,
): HistoryEntryResult {
  return { ok: false, code, seq, reason };
}

export function createHistoryEntryService(
  deps: HistoryEntryServiceDeps = defaultDeps(),
): HistoryEntryService {
  async function getEntry(
    input: GetHistoryEntryInput,
  ): Promise<HistoryEntryResult> {
    const { seq } = input;
    const read = await deps.readTranscriptEntries(input.transcriptPath);
    const found = lookupArchiveEntry(read, seq);
    if (!found.ok) return refuse(found.code, seq, found.reason);
    const entry = found.entry;
    const entries = read.entries;

    const includeThinking = input.includeThinking === true;
    const { lines, thinkingOmitted } = renderCompleteEntryLines(entry.content, {
      includeThinking,
    });
    const label = captureOriginLabel(entry.origin);
    if (label) lines.unshift(label.trimEnd());
    const text = lines.join("\n");
    const unit = groupTranscriptEntries(entries).find((candidate) =>
      candidate.parts.some((part) => part.seq === seq),
    );

    return {
      ok: true,
      entry: {
        conversationId: input.conversationId,
        seq,
        kind: entry.kind === "tool_result" ? "tool_result" : "message",
        role: entry.kind === "tool_result" ? null : entry.role,
        entryId: entry.entryId ?? null,
        ...(entry.origin ? { origin: entry.origin } : {}),
        timestamp: entry.timestamp ?? null,
        messageIndex: unit ? unit.messageIndex : -1,
        includeThinking,
        thinkingOmitted,
        lines,
        bytes: Buffer.byteLength(text, "utf-8"),
        sha256: historyEntrySha256(text),
        images: historyImageHandles({
          conversationId: input.conversationId,
          seq,
          content: entry.content,
        }),
      },
    };
  }
  return { getEntry };
}

/** The exported text exactly as `bytes` and `sha256` measure it. */
export function historyEntryText(entry: HistoryEntry): string {
  return entry.lines.join("\n");
}

/** The same bytes, chunk by chunk, for a streaming export. */
export function* iterateHistoryEntryText(
  entry: HistoryEntry,
): Generator<string> {
  for (const [index, line] of entry.lines.entries()) {
    if (index > 0) yield "\n";
    yield line;
  }
}

/**
 * Stream composition for the HTTP export route: an unbounded entry leaves the
 * process a chunk at a time rather than as one collected response body.
 */
export function historyEntryTextStream(
  entry: HistoryEntry,
): ReadableStream<Uint8Array> {
  const chunks = iterateHistoryEntryText(entry);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next.value));
    },
  });
}

export function historyEntrySha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}
