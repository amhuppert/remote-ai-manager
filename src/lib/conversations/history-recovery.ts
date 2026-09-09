/**
 * Stable recovery handles over an ORIGINAL conversation archive.
 *
 * Two things live here because they are the same contract from two sides:
 * the ready-to-run commands that name a piece of original evidence, and the
 * checkpoint-boundary projection that tells a reader where saved checkpoints
 * fall inside the range it just read.
 *
 * A boundary is METADATA, never a frame: it is derived from a stored
 * `capturedThroughSeq` and anchored to units the renderer already produced, so
 * projecting boundaries adds no JSONL line, no logical message, and no change
 * to `totalMessages`. Repeated compaction therefore leaves the archive's raw
 * coordinates exactly as recorded.
 *
 * Commands are built by code rather than typed by an agent: a source
 * coordinate copied by hand is the failure this module exists to remove. They
 * address a conversation by id alone — read-only leaves resolve ownership in
 * either scope, so no command here can fabricate a session path for a project
 * conversation.
 */

import { z } from "zod";

import type { MessageContentBlock } from "@/lib/conversations/schemas";

/**
 * How many boundaries one read response carries. Past this the reader hands
 * back a `checkpoint list --before <ordinal>` cursor instead of growing.
 */
export const MAX_RANGE_BOUNDARIES = 8;

// ============================================================
// Recovery commands
// ============================================================

/**
 * The detail level a read was rendered at, so a recovery command reproduces
 * the evidence the reader shortened rather than a different, quieter view.
 *
 * A command that dropped the caller's `--include-thinking` would answer a
 * truncated reasoning excerpt with no reasoning at all — the one thing the
 * handle exists to recover.
 */
export interface ReaderDetailLevel {
  includeThinking?: boolean;
  includeTools?: "none" | "summary" | "full";
}

/** The reader's own defaults, which need no flag to reproduce. */
const DEFAULT_INCLUDE_TOOLS = "summary";

function detailFlags(level: ReaderDetailLevel | undefined): string {
  if (level === undefined) return "";
  const flags: string[] = [];
  if (
    level.includeTools !== undefined &&
    level.includeTools !== DEFAULT_INCLUDE_TOOLS
  ) {
    flags.push(`--include-tools ${level.includeTools}`);
  }
  if (level.includeThinking === true) flags.push("--include-thinking");
  return flags.length === 0 ? "" : ` ${flags.join(" ")}`;
}

/**
 * The complete, unexcerpted normalized entry at one raw sequence.
 *
 * Tool detail is always full in an export, so only the thinking opt-in carries
 * over from the read that named this entry.
 */
export function entryGetCommand(
  conversationId: string,
  seq: number,
  level?: Pick<ReaderDetailLevel, "includeThinking">,
): string {
  // Built from the thinking opt-in alone rather than handed to detailFlags: a
  // parameter type removes nothing at runtime, and callers legitimately pass
  // one whole reader level to both command builders.
  const thinking = level?.includeThinking === true ? " --include-thinking" : "";
  return `cctl conversation entry get ${conversationId} ${seq}${thinking}`;
}

/** The archive-owned image bytes at one raw sequence and content block. */
export function imageGetCommand(
  conversationId: string,
  seq: number,
  contentBlockIndex: number,
): string {
  return `cctl conversation image get ${conversationId} ${seq} ${contentBlockIndex}`;
}

/** The raw-sequence window a bounded read left out, at the same detail level. */
export function readSeqRangeCommand(
  conversationId: string,
  seqStart: number,
  seqEnd: number,
  level?: ReaderDetailLevel,
): string {
  return `cctl conversation read ${conversationId} --seq-range ${seqStart}:${seqEnd}${detailFlags(level)}`;
}

/** The paginated checkpoint index below an ordinal. */
export function checkpointListCommand(
  conversationId: string,
  before: number,
): string {
  return `cctl conversation checkpoint list ${conversationId} --before ${before}`;
}

// ============================================================
// Archive image handles
// ============================================================

/**
 * A stable address for one image in the archive: the conversation, the
 * ORIGINAL CC transcript frame sequence, and the index of the IMAGE-BEARING
 * content block inside that frame.
 *
 * The caller never supplies a filesystem path — the archive owns where the
 * bytes live, which is what keeps a handle stable across repeated compaction
 * and keeps an arbitrary path out of the request.
 */
export const historyImageHandleSchema = z
  .object({
    conversationId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    contentBlockIndex: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
    /** Whether the bytes are inline base64 or an externalized file. */
    storage: z.enum(["inline", "external"]),
    command: z.string().min(1),
  })
  .strict();
export type HistoryImageHandle = z.infer<typeof historyImageHandleSchema>;

/**
 * What ONE archive entry is, minus its body.
 *
 * Extracted here — beside the image handles it carries — because two very
 * different consumers need exactly these fields and only one of them can load
 * the export service: the server builds the full entry on top of this schema,
 * and the browser parses the `format=metadata` projection from it. Sharing the
 * definition is what keeps the two from drifting into different answers about
 * which message index a raw sequence belongs to.
 */
export const historyEntryMetadataSchema = z
  .object({
    conversationId: z.string().min(1),
    /** Raw JSONL line index, exactly as recorded. */
    seq: z.number().int().nonnegative(),
    kind: z.enum(["message", "tool_result"]),
    /** Null for a stored tool-result line, which has no role of its own. */
    role: z.enum(["user", "assistant", "notice"]).nullable(),
    entryId: z.string().nullable(),
    timestamp: z.string().nullable(),
    /** Merged-message index this entry belongs to, matching the reader. */
    messageIndex: z.number().int(),
    includeThinking: z.boolean(),
    /** Thinking blocks left out because the caller did not request them. */
    thinkingOmitted: z.number().int().nonnegative(),
    /** UTF-8 size of the exported text. */
    bytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
    images: z.array(historyImageHandleSchema),
  })
  .strict();
export type HistoryEntryMetadata = z.infer<typeof historyEntryMetadataSchema>;

/** Whether an `image_marker` at `index` is the display half of a stored pair. */
function isPairedMarker(
  content: readonly MessageContentBlock[],
  index: number,
): boolean {
  const marker = content[index];
  const next = content[index + 1];
  return (
    marker?.type === "image_marker" &&
    next?.type === "image_ref" &&
    next.imagePath === marker.imagePath
  );
}

/**
 * Enumerate the images one archive entry displays, one handle each.
 *
 * `externalizeImageBlocks` writes an image as an `image_marker` followed by the
 * `image_ref` that carries the bytes, so the pair is ONE displayed image and
 * the handle keeps the image-bearing (`image_ref`) block index. An unpaired
 * marker still yields a handle rather than disappearing.
 */
export function historyImageHandles(input: {
  conversationId: string;
  seq: number;
  content: readonly MessageContentBlock[];
}): HistoryImageHandle[] {
  const handles: HistoryImageHandle[] = [];
  input.content.forEach((block, contentBlockIndex) => {
    if (
      block.type === "image_marker" &&
      isPairedMarker(input.content, contentBlockIndex)
    ) {
      return;
    }
    if (
      block.type !== "image" &&
      block.type !== "image_ref" &&
      block.type !== "image_marker"
    ) {
      return;
    }
    handles.push({
      conversationId: input.conversationId,
      seq: input.seq,
      contentBlockIndex,
      mediaType: block.mediaType,
      storage: block.type === "image" ? "inline" : "external",
      command: imageGetCommand(
        input.conversationId,
        input.seq,
        contentBlockIndex,
      ),
    });
  });
  return handles;
}

// ============================================================
// Checkpoint boundary projection
// ============================================================

/**
 * One saved checkpoint's stored source boundary, as the checkpoint repository
 * holds it. Only the coordinate crosses into the reader — no seed, no hash, no
 * provider reference.
 */
export const checkpointBoundaryInputSchema = z
  .object({
    operationId: z.string().min(1),
    ordinal: z.number().int().positive(),
    /** Raw JSONL line the checkpoint's source capture read through. */
    capturedThroughSeq: z.number().int().nonnegative(),
  })
  .strict();
export type CheckpointBoundaryInput = z.infer<
  typeof checkpointBoundaryInputSchema
>;

/**
 * A boundary placed against the units a read actually returned. The divider
 * sits AFTER `capturedThroughSeq`, so `afterMessageIndex` is the last rendered
 * unit above it and `nextSeq` the first rendered coordinate below it.
 */
export const transcriptBoundarySchema = z
  .object({
    operationId: z.string().min(1),
    ordinal: z.number().int().positive(),
    capturedThroughSeq: z.number().int().nonnegative(),
    /** Rendered unit the divider follows; null when it precedes them all. */
    afterMessageIndex: z.number().int().nullable(),
    /** First rendered raw seq after the divider; null when none follows. */
    nextSeq: z.number().int().nullable(),
  })
  .strict();
export type TranscriptBoundary = z.infer<typeof transcriptBoundarySchema>;

export const transcriptBoundariesSchema = z
  .object({
    /** Ascending by ordinal; at most {@link MAX_RANGE_BOUNDARIES}. */
    entries: z.array(transcriptBoundarySchema),
    /** Boundaries falling in the read range, including those past the cap. */
    totalInRange: z.number().int().nonnegative(),
    /** Cursor for the older in-range boundaries; null when none were cut. */
    nextBefore: z.number().int().positive().nullable(),
    /** Ready-to-run paginated index for the boundaries past the cap. */
    indexCommand: z.string().min(1).nullable(),
  })
  .strict();
export type TranscriptBoundaries = z.infer<typeof transcriptBoundariesSchema>;

export const EMPTY_TRANSCRIPT_BOUNDARIES: TranscriptBoundaries = {
  entries: [],
  totalInRange: 0,
  nextBefore: null,
  indexCommand: null,
};

export function checkpointBoundaryLines(
  boundaries: TranscriptBoundaries,
): string[] {
  const lines = boundaries.entries.map(
    (entry) =>
      `Checkpoint #${entry.ordinal} ${entry.operationId} — captured through raw seq ${entry.capturedThroughSeq}`,
  );
  const omitted = boundaries.totalInRange - boundaries.entries.length;
  if (omitted > 0) {
    lines.push(
      `Checkpoint boundaries: ${boundaries.entries.length} of ${boundaries.totalInRange} shown, ${omitted} omitted — ${boundaries.indexCommand}`,
    );
  }
  return lines;
}

/**
 * Project saved checkpoint receipts into reader boundary inputs.
 *
 * Structurally typed rather than importing the receipt: the reader depends on
 * a coordinate and an ordinal, not on the checkpoint domain. A receipt with no
 * frozen payload has no saved checkpoint to divide the history at — a build
 * that failed or was cancelled never became a boundary — so it is left out.
 */
export function savedCheckpointBoundaries(
  receipts: readonly {
    operationId: string;
    ordinal: number;
    boundary: { capturedThroughSeq: number };
    checkpoint: object | null;
  }[],
): CheckpointBoundaryInput[] {
  return receipts
    .filter((receipt) => receipt.checkpoint !== null)
    .map((receipt) => ({
      operationId: receipt.operationId,
      ordinal: receipt.ordinal,
      capturedThroughSeq: receipt.boundary.capturedThroughSeq,
    }));
}

/** The rendered coordinates a boundary is anchored against. */
export interface BoundaryAnchorUnit {
  messageIndex: number;
  entrySeqs: readonly number[];
}

export interface ProjectRangeBoundariesInput {
  conversationId: string;
  boundaries: readonly CheckpointBoundaryInput[];
  /** The units the read returned, in render order. */
  units: readonly BoundaryAnchorUnit[];
}

/**
 * Place saved checkpoint boundaries against the units a read returned.
 *
 * A boundary is in range when its divider — the gap after
 * `capturedThroughSeq` — falls within the rendered coordinates, including the
 * gap immediately before the first one (a read that begins right after a
 * checkpoint is exactly the case a viewer needs the divider for). Anything
 * else belongs to another part of the archive and is left out rather than
 * anchored to a unit it does not separate.
 *
 * When more than {@link MAX_RANGE_BOUNDARIES} are in range the NEWEST are
 * kept, because the older ones are already reachable through the descending
 * `checkpoint list --before <ordinal>` index this hands back.
 */
export function projectRangeBoundaries(
  input: ProjectRangeBoundariesInput,
): TranscriptBoundaries {
  const anchors: { seq: number; messageIndex: number }[] = [];
  for (const unit of input.units) {
    for (const seq of unit.entrySeqs) {
      anchors.push({ seq, messageIndex: unit.messageIndex });
    }
  }
  anchors.sort((a, b) => a.seq - b.seq);

  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (first === undefined || last === undefined) {
    return EMPTY_TRANSCRIPT_BOUNDARIES;
  }

  const inRange = input.boundaries
    .filter(
      (candidate) =>
        candidate.capturedThroughSeq >= first.seq - 1 &&
        candidate.capturedThroughSeq <= last.seq,
    )
    .sort((a, b) => a.ordinal - b.ordinal);

  const kept = inRange.slice(-MAX_RANGE_BOUNDARIES);
  const cutOff = inRange.length - kept.length;
  const oldestKept = kept[0];
  const nextBefore =
    cutOff > 0 && oldestKept !== undefined ? oldestKept.ordinal : null;

  return {
    entries: kept.map((candidate) => {
      const above = anchors.filter(
        (anchor) => anchor.seq <= candidate.capturedThroughSeq,
      );
      const below = anchors.find(
        (anchor) => anchor.seq > candidate.capturedThroughSeq,
      );
      const preceding = above[above.length - 1];
      return {
        operationId: candidate.operationId,
        ordinal: candidate.ordinal,
        capturedThroughSeq: candidate.capturedThroughSeq,
        afterMessageIndex: preceding ? preceding.messageIndex : null,
        nextSeq: below ? below.seq : null,
      };
    }),
    totalInRange: inRange.length,
    nextBefore,
    indexCommand:
      nextBefore === null
        ? null
        : checkpointListCommand(input.conversationId, nextBefore),
  };
}
