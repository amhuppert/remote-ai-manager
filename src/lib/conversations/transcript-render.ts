/**
 * Deterministic compact-transcript normalizer
 * (docs/design/conversation-compaction/README.md §4).
 *
 * One pure function shared by the conversation read endpoint and the
 * compaction pre-strip — never two normalizers. No I/O: callers read entries
 * via `readTranscriptEntriesWithSeq` (the entry-level cached reader) and pass
 * them in. The renderer groups entries into logical messages with the same
 * consecutive-same-role merge rule as `readConversationMessagesWithSeq`, so
 * `messageIndex` matches the UI's merged-message indexes, while every line
 * keeps its entry's exact raw `seq` for entry-exact citations and slicing.
 */

import { z } from "zod";
import {
  sourceRefSchema,
  type MessageContentBlock,
  type ToolResultMetrics,
} from "@/lib/conversations/schemas";
import {
  EMPTY_TRANSCRIPT_BOUNDARIES,
  checkpointBoundaryLines,
  entryGetCommand,
  projectRangeBoundaries,
  readSeqRangeCommand,
  transcriptBoundariesSchema,
  type CheckpointBoundaryInput,
  type ReaderDetailLevel,
} from "@/lib/conversations/history-recovery";
import {
  groupLogicalUnits,
  type LogicalUnit,
  type LogicalUnitEntry,
  type LogicalUnitPart,
} from "@/lib/conversations/transcript-logical-units";
import { truncate } from "@/lib/shared/truncate";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";

/**
 * Stamped on compaction artifacts so consumers can detect when stored
 * artifacts were produced by an older rendering contract.
 */
export const NORMALIZER_VERSION = "1";

export const renderOptionsSchema = z
  .object({
    /** TOC mode: user prompts + assistant headlines only. */
    outline: z.boolean().default(false),
    /** Single logical message (merged-message index). */
    message: z.number().int().optional(),
    messageRange: z.tuple([z.number().int(), z.number().int()]).optional(),
    /** Raw JSONL line-index window; slices inside merged messages. */
    seqRange: z.tuple([z.number().int(), z.number().int()]).optional(),
    includeTools: z.enum(["none", "summary", "full"]).default("summary"),
    includeThinking: z.boolean().default(false),
    /** debug_structured blocks are collapsed, not dropped, unless disabled. */
    includeDebug: z.boolean().default(true),
    /** Regex over text-block content; returns matching units only. */
    search: z.string().optional(),
    /** Hard output bound; sets truncated=true when hit. */
    maxBytes: z.number().int().default(262_144),
    format: z.enum(["json", "markdown"]).default("json"),
  })
  .superRefine((opts, ctx) => {
    const windowModes = [opts.message, opts.messageRange, opts.seqRange].filter(
      (mode) => mode !== undefined,
    ).length;
    if (windowModes > 1) {
      ctx.addIssue({
        code: "custom",
        message: "message, messageRange, and seqRange are mutually exclusive",
      });
    }
    if (opts.search !== undefined) {
      try {
        new RegExp(opts.search);
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["search"],
          message: "search must be a valid regular expression",
        });
      }
    }
  });
export type RenderOptions = z.infer<typeof renderOptionsSchema>;

export const renderedUnitSchema = z.object({
  /** Whole-unit span (seqStart..seqEnd of the merged group). */
  ref: sourceRefSchema,
  /** Exact seq of each entry whose lines are included in this unit. */
  entrySeqs: z.array(z.number().int()),
  role: z.enum(["user", "assistant", "notice"]),
  timestamp: z.string(),
  /** Rendered content lines; every line carries its entry's `[s<seq>]` prefix. */
  lines: z.array(z.string()),
});
export type RenderedUnit = z.infer<typeof renderedUnitSchema>;

/**
 * How many excerpted entries one read names individually before falling back
 * to a count. Each rendered elision is already marked inline with its `[sN]`
 * coordinate, so the list is an index, not the only route to the evidence.
 */
export const MAX_EXCERPTED_ENTRY_REPORTS = 8;

/** One entry rendered with some of its content left out, and how to get it. */
export const elidedEntrySchema = z
  .object({
    seq: z.number().int(),
    messageIndex: z.number().int(),
    /**
     * Rendered bytes of THIS entry the response did not show — its own
     * shortened content, plus, for a partial entry, its own lines the byte
     * budget cut. Never another entry's loss.
     */
    elidedBytes: z.number().int().nonnegative(),
    /** Ready-to-run command returning this entry complete. */
    command: z.string().min(1),
  })
  .strict();
export type ElidedEntry = z.infer<typeof elidedEntrySchema>;

/**
 * What a bounded read left out, separated by KIND of loss.
 *
 * `omittedAfter` names entries the byte budget never reached — recoverable by
 * reading the named seq range. `partialEntry` names the entry the cut landed
 * INSIDE (null when it fell cleanly between two entries), and
 * `excerptedEntries` the entries the renderer shortened — a summarized tool
 * result, an outline headline, a clipped thinking excerpt, tool argument,
 * debug payload or feedback note. The last two are recovered by exporting that
 * entry complete, never by raising `--max-bytes` alone.
 */
export const transcriptTruncationSchema = z
  .object({
    omittedAfter: z
      .object({
        /** First raw seq in the window the render did not reach. */
        nextSeq: z.number().int(),
        /** Last raw seq in the selected window. */
        lastSeq: z.number().int(),
        /** Logical messages dropped whole. */
        unitCount: z.number().int().nonnegative(),
        command: z.string().min(1),
      })
      .strict()
      .nullable(),
    partialEntry: elidedEntrySchema.nullable(),
    excerptedEntries: z.array(elidedEntrySchema),
    /** Excerpted entries past {@link MAX_EXCERPTED_ENTRY_REPORTS}. */
    excerptedEntriesOmitted: z.number().int().nonnegative(),
    /**
     * Where the excerpt coordinates the cap dropped still live. Re-reading
     * this window indexes the next {@link MAX_EXCERPTED_ENTRY_REPORTS} of
     * them, so the cap bounds one response instead of losing evidence.
     */
    excerptedEntriesNext: z
      .object({
        /** First raw seq whose excerpt the cap left unnamed. */
        nextSeq: z.number().int(),
        /** Last raw seq the read covered. */
        lastSeq: z.number().int(),
        command: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type TranscriptTruncation = z.infer<typeof transcriptTruncationSchema>;

export const renderedTranscriptSchema = z.object({
  conversationId: z.string(),
  totalMessages: z.number().int(),
  maxSeq: z.number().int(),
  units: z.array(renderedUnitSchema),
  truncated: z.boolean(),
  omissions: z.object({
    thinkingOmitted: z.number().int(),
    toolResultBytesElided: z.number().int(),
    unitsOutsideWindow: z.number().int(),
  }),
  /** Saved checkpoint dividers falling inside the returned range. */
  boundaries: transcriptBoundariesSchema,
  truncation: transcriptTruncationSchema,
});
export type RenderedTranscript = z.infer<typeof renderedTranscriptSchema>;

export interface RenderTranscriptInput {
  conversationId: string;
  entries: TranscriptEntryWithSeq[];
  maxSeq: number;
  /**
   * Saved checkpoint boundaries to project over the rendered range. Supplying
   * them adds metadata only: no unit, no line, and no change to
   * `totalMessages` — the archive stays exactly as recorded.
   */
  boundaries?: readonly CheckpointBoundaryInput[];
}

type UnitPart = LogicalUnitPart;

/** A logical (merged) message with per-entry coordinates preserved. */
export type TranscriptUnit = LogicalUnit;

/** Project a cached entry record into the grouping owner's normalized shape. */
function toLogicalUnitEntry(entry: TranscriptEntryWithSeq): LogicalUnitEntry {
  if (entry.kind === "tool_result") {
    return {
      seq: entry.seq,
      kind: "tool_result",
      entryId: entry.entryId,
      timestamp: entry.timestamp,
      content: entry.content,
    };
  }
  return {
    seq: entry.seq,
    kind: "message",
    role: entry.role,
    content: entry.content,
    entryId: entry.entryId,
    timestamp: entry.timestamp,
  };
}

/**
 * Group raw entries into logical messages via the shared grouping owner
 * ({@link groupLogicalUnits}): consecutive same-role entries merge into one
 * unit, a slash-command user entry always starts its own unit, and
 * `kind:"tool_result"` entries fold into the open unit as parts keeping their
 * own seq (messageIndex parity with the read path holds). A tool_result with no
 * open unit is dropped.
 */
export function groupTranscriptEntries(
  entries: TranscriptEntryWithSeq[],
): TranscriptUnit[] {
  return groupLogicalUnits(entries.map(toLogicalUnitEntry));
}

const OUTLINE_HEADLINE_MAX_CHARS = 120;
const THINKING_EXCERPT_MAX_CHARS = 500;
const TOOL_PRIMARY_ARG_MAX_CHARS = 80;
const TOOL_INPUT_GIST_MAX_CHARS = 120;
const TOOL_RESULT_HEAD_CHARS = 400;
const TOOL_RESULT_TAIL_CHARS = 200;
const DEBUG_PAYLOAD_MAX_CHARS = 300;
const FEEDBACK_NOTE_MAX_CHARS = 200;

/** Input keys most likely to identify what a tool call operates on. */
const PRIMARY_ARG_KEYS = [
  "file_path",
  "path",
  "command",
  "pattern",
  "url",
  "query",
  "prompt",
  "description",
  "name",
];

const textEncoder = new TextEncoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/**
 * An outline headline keeps one shortened line of an entry that may have had
 * many, so the bytes it drops are recorded like any other excerpt.
 */
function headline(text: string, omissions: MutableOmissions): string {
  const firstLine =
    text.split("\n").find((line) => line.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  recordElision(
    omissions,
    omittedSourceBytes(text, keptBy(trimmed, OUTLINE_HEADLINE_MAX_CHARS)),
  );
  return truncate(trimmed, OUTLINE_HEADLINE_MAX_CHARS);
}

function toolPrimaryArg(
  input: Record<string, unknown> | undefined,
  mode: BlockRenderMode,
  omissions: MutableOmissions,
): string {
  if (!input) return "";
  for (const key of PRIMARY_ARG_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return excerpt(mode, omissions, value, TOOL_PRIMARY_ARG_MAX_CHARS);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > 0) {
      return excerpt(mode, omissions, value, TOOL_PRIMARY_ARG_MAX_CHARS);
    }
  }
  return "";
}

function toolInputGist(
  input: Record<string, unknown> | undefined,
  mode: BlockRenderMode,
  omissions: MutableOmissions,
): string {
  if (!input || Object.keys(input).length === 0) return "";
  return excerpt(
    mode,
    omissions,
    JSON.stringify(input),
    TOOL_INPUT_GIST_MAX_CHARS,
  );
}

function formatMetrics(metrics: ToolResultMetrics | undefined): string {
  if (!metrics) return "";
  const parts: string[] = [];
  if (metrics.lineCount !== undefined) parts.push(`lines=${metrics.lineCount}`);
  if (metrics.fileCount !== undefined) parts.push(`files=${metrics.fileCount}`);
  if (metrics.matchCount !== undefined) {
    parts.push(`matches=${metrics.matchCount}`);
  }
  if (metrics.byteCount !== undefined) parts.push(`bytes=${metrics.byteCount}`);
  if (metrics.exitCode !== undefined) parts.push(`exit=${metrics.exitCode}`);
  return parts.join(" ");
}

interface MutableOmissions {
  thinkingOmitted: number;
  toolResultBytesElided: number;
  /**
   * Bytes lost to ANY presentation shortening, tool results included.
   *
   * Tracked separately from `toolResultBytesElided` because the two answer
   * different questions: that one sizes the compaction pre-strip, this one
   * decides whether an entry needs a complete-export recovery command. A
   * shortened headline, thinking excerpt, tool argument, debug payload or
   * feedback note is exactly as unrecoverable from the rendered text as a
   * summarized tool result, so all of them land here.
   */
  elidedBytes: number;
}

function recordElision(omissions: MutableOmissions, lost: number): void {
  if (lost > 0) omissions.elidedBytes += lost;
}

/**
 * Bytes of `value` a shortened rendering did not show.
 *
 * Measured against the SOURCE the render kept, never against the rendered
 * line: the ellipsis standing in for the dropped text is three UTF-8 bytes, so
 * comparing rendered size to original size hides a one-to-three character loss
 * behind its own marker and silently drops that entry's recovery command.
 */
function omittedSourceBytes(value: string, kept: string): number {
  return Math.max(0, byteLength(value) - byteLength(kept));
}

/** The source characters `truncate(value, max)` keeps. */
function keptBy(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * What rendering one content block depends on.
 *
 * `complete` lifts every presentation excerpt so the complete-entry export is
 * the SAME formatter without its limits, not a second one that could disagree
 * about how a block reads. `RenderOptions` satisfies this shape structurally,
 * so the bounded reader passes its own options straight through.
 */
interface BlockRenderMode {
  outline: boolean;
  includeTools: "none" | "summary" | "full";
  includeThinking: boolean;
  includeDebug: boolean;
  /** Export mode: no headline, thinking, argument, or payload excerpting. */
  complete?: boolean;
}

/** Presentation excerpt, skipped entirely in complete-export mode. */
function excerpt(
  mode: BlockRenderMode,
  omissions: MutableOmissions,
  value: string,
  max: number,
): string {
  if (mode.complete === true) return value;
  recordElision(omissions, omittedSourceBytes(value, keptBy(value, max)));
  return truncate(value, max);
}

function renderBlockLines(
  block: MessageContentBlock,
  options: BlockRenderMode,
  omissions: MutableOmissions,
): string[] {
  switch (block.type) {
    case "text": {
      if (options.outline) return [headline(block.text, omissions)];
      return block.text.split("\n");
    }
    case "thinking": {
      if (options.outline || !options.includeThinking) {
        omissions.thinkingOmitted += 1;
        return [];
      }
      if (block.redacted) return ["🧠 thinking: [redacted]"];
      // A complete export keeps the reasoning's own line breaks; the bounded
      // reader collapses them into one excerpted line.
      if (options.complete === true) {
        return ["🧠 thinking:", ...block.text.split("\n")];
      }
      const collapsed = block.text.replace(/\s+/g, " ").trim();
      recordElision(
        omissions,
        omittedSourceBytes(
          block.text,
          keptBy(collapsed, THINKING_EXCERPT_MAX_CHARS),
        ),
      );
      return [
        `🧠 thinking: ${truncate(collapsed, THINKING_EXCERPT_MAX_CHARS)}`,
      ];
    }
    case "tool_use": {
      if (options.outline || options.includeTools === "none") return [];
      const gist = toolInputGist(block.input, options, omissions);
      const summary = `⚙ ${block.name}(${toolPrimaryArg(block.input, options, omissions)})${gist ? ` — ${gist}` : ""}`;
      if (
        options.includeTools === "full" &&
        block.input &&
        Object.keys(block.input).length > 0
      ) {
        return [summary, `  input: ${JSON.stringify(block.input)}`];
      }
      return [summary];
    }
    case "tool_result": {
      if (options.outline || options.includeTools === "none") return [];
      const status = block.isError ? "error" : "ok";
      const metricsText = formatMetrics(block.metrics);
      const header = `→ ${status}${metricsText ? ` (${metricsText})` : ""}`;
      const content = block.content ?? "";
      if (content.length === 0) return [header];
      const excerptBound = TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS;
      if (
        options.complete === true ||
        options.includeTools === "full" ||
        content.length <= excerptBound
      ) {
        return [header, ...content.split("\n")];
      }
      const head = content.slice(0, TOOL_RESULT_HEAD_CHARS);
      const tail = content.slice(content.length - TOOL_RESULT_TAIL_CHARS);
      const elidedBytes = byteLength(
        content.slice(
          TOOL_RESULT_HEAD_CHARS,
          content.length - TOOL_RESULT_TAIL_CHARS,
        ),
      );
      omissions.toolResultBytesElided += elidedBytes;
      recordElision(omissions, elidedBytes);
      return [
        header,
        ...head.split("\n"),
        `… [${elidedBytes} bytes elided] …`,
        ...tail.split("\n"),
      ];
    }
    case "command":
      return [`${block.name}${block.args ? ` ${block.args}` : ""}`];
    case "image":
    case "image_ref":
    case "image_marker":
      return options.outline ? [] : [`[image ${block.mediaType}]`];
    case "debug_structured": {
      if (options.outline || !options.includeDebug) return [];
      const payloadText = JSON.stringify(block.payload) ?? "";
      return [
        `🐞 debug[${block.phase}]: ${excerpt(options, omissions, payloadText, DEBUG_PAYLOAD_MAX_CHARS)}`,
      ];
    }
    case "document_feedback": {
      if (options.outline) return [];
      return block.items.map(
        (item) =>
          `📝 ${item.docPath}:${item.line} ${item.headingLabel} — ${excerpt(options, omissions, item.note, FEEDBACK_NOTE_MAX_CHARS)}`,
      );
    }
    case "notepad_feedback": {
      if (options.outline) return [];
      // The notepad is named once and the comments listed under it: a dispatch
      // is one act on one notepad, unlike document feedback where each item
      // carries its own path.
      return [
        `📝 notepad ${block.notepadName} (${block.notepadId}) — ${block.items.length} comment${block.items.length === 1 ? "" : "s"}`,
        ...block.items.map(
          (item) =>
            `   ${item.location} — ${excerpt(options, omissions, item.body, FEEDBACK_NOTE_MAX_CHARS)}`,
        ),
      ];
    }
  }
}

export interface CompleteEntryRenderOptions {
  /** Thinking is omitted unless the caller asks for it. */
  includeThinking: boolean;
}

export interface CompleteEntryRender {
  lines: string[];
  /** Thinking blocks left out because the caller did not request them. */
  thinkingOmitted: number;
}

/**
 * Render ONE archive entry's content complete: full tool input and results, no
 * excerpt anywhere, thinking only on request.
 *
 * Uses the bounded reader's own block formatter with its presentation limits
 * lifted, so an export cannot read differently from the transcript it came
 * from, and no provider-native payload is interpreted above the adapter.
 */
export function renderCompleteEntryLines(
  content: readonly MessageContentBlock[],
  options: CompleteEntryRenderOptions,
): CompleteEntryRender {
  const mode: BlockRenderMode = {
    outline: false,
    includeTools: "full",
    includeThinking: options.includeThinking,
    includeDebug: true,
    complete: true,
  };
  const omissions: MutableOmissions = {
    thinkingOmitted: 0,
    toolResultBytesElided: 0,
    elidedBytes: 0,
  };
  const lines: string[] = [];
  for (const block of content) {
    // Appended one at a time on purpose: a single tool result can render
    // hundreds of thousands of short lines, and spreading them as call
    // arguments throws RangeError long before the byte size is a problem.
    for (const line of renderBlockLines(block, mode, omissions)) {
      lines.push(line);
    }
  }
  return { lines, thinkingOmitted: omissions.thinkingOmitted };
}

interface SelectedUnit {
  unit: TranscriptUnit;
  /** Parts to render — sliced when a seqRange boundary falls inside the unit. */
  parts: UnitPart[];
}

function selectWindow(
  units: TranscriptUnit[],
  options: RenderOptions,
): { selected: SelectedUnit[]; excluded: number } {
  const selected: SelectedUnit[] = [];
  let excluded = 0;

  for (const unit of units) {
    if (options.message !== undefined) {
      if (unit.messageIndex !== options.message) {
        excluded += 1;
        continue;
      }
      selected.push({ unit, parts: unit.parts });
    } else if (options.messageRange !== undefined) {
      const [start, end] = options.messageRange;
      if (unit.messageIndex < start || unit.messageIndex > end) {
        excluded += 1;
        continue;
      }
      selected.push({ unit, parts: unit.parts });
    } else if (options.seqRange !== undefined) {
      const [start, end] = options.seqRange;
      const parts = unit.parts.filter(
        (part) => part.seq >= start && part.seq <= end,
      );
      if (parts.length === 0) {
        excluded += 1;
        continue;
      }
      selected.push({ unit, parts });
    } else {
      selected.push({ unit, parts: unit.parts });
    }
  }

  return { selected, excluded };
}

/**
 * One entry's contribution to a rendered unit: where its lines are, and what
 * it lost on the way.
 *
 * Loss is attributed to the ENTRY, not only to the unit total: a merged unit
 * can span many entries, and both the complete-entry recovery command and the
 * byte-budget cut have to name the one entry that was actually shortened.
 */
interface RenderedPart {
  seq: number;
  /** Index of this entry's first line in the unit, inclusive. */
  lineStart: number;
  /** Index one past its last line. */
  lineEnd: number;
  /** Bytes lost to any presentation excerpt inside this entry. */
  elidedBytes: number;
  toolResultBytesElided: number;
  thinkingOmitted: number;
}

interface RenderedUnitLines {
  lines: string[];
  lineSeqs: number[];
  parts: RenderedPart[];
}

/** Render one unit's parts into `[s<seq>] <line>` lines with their seqs. */
function renderUnitLines(
  parts: UnitPart[],
  options: RenderOptions,
  omissions: MutableOmissions,
): RenderedUnitLines {
  const lines: string[] = [];
  const lineSeqs: number[] = [];
  const rendered: RenderedPart[] = [];
  for (const part of parts) {
    const before = { ...omissions };
    const lineStart = lines.length;
    for (const block of part.content) {
      for (const line of renderBlockLines(block, options, omissions)) {
        lines.push(`[s${part.seq}] ${line}`);
        lineSeqs.push(part.seq);
      }
    }
    rendered.push({
      seq: part.seq,
      lineStart,
      lineEnd: lines.length,
      elidedBytes: omissions.elidedBytes - before.elidedBytes,
      toolResultBytesElided:
        omissions.toolResultBytesElided - before.toolResultBytesElided,
      thinkingOmitted: omissions.thinkingOmitted - before.thinkingOmitted,
    });
  }
  return { lines, lineSeqs, parts: rendered };
}

/** Byte cost of a unit's rendered lines, matching the truncation accounting. */
function unitByteCost(lines: string[]): number {
  return lines.reduce((sum, line) => sum + byteLength(line) + 1, 0);
}

/** An entry a byte-budget cut reached, and whether the cut fell inside it. */
interface ReachedPart {
  part: RenderedPart;
  partial: boolean;
}

interface CutAttribution {
  /** Entries that contributed at least one displayed line. */
  reached: ReachedPart[];
  /** The one entry the cut fell inside, with the bytes it did not show. */
  partial: { part: RenderedPart; lostBytes: number } | null;
  /** Last raw seq the response covered; null when nothing was displayed. */
  lastCoveredSeq: number | null;
}

/**
 * Attribute a byte-budget cut to the entries it actually affected.
 *
 * A cut that falls exactly BETWEEN two entries leaves no partial entry: the
 * last one displayed is complete, and everything after it belongs to the
 * omitted range. Only a cut inside an entry's own lines makes that entry
 * partial, and then it loses only its own unrendered bytes — not the rest of
 * the merged unit, which the read simply never reached.
 *
 * When not even one line fit, the unit is still emitted (with its truncation
 * marker), so its first entry is the partial one: displayed as a coordinate,
 * with none of its content shown.
 */
function attributeCut(
  lines: string[],
  parts: RenderedPart[],
  cutIndex: number,
): CutAttribution {
  const lostBytesFrom = (part: RenderedPart, from: number): number => {
    let lost = 0;
    for (
      let index = Math.max(from, part.lineStart);
      index < part.lineEnd;
      index++
    ) {
      const line = lines[index];
      if (line !== undefined) lost += byteLength(line) + 1;
    }
    return lost;
  };

  const reached = parts.filter((part) => part.lineStart < cutIndex);
  const straddling = parts.find(
    (part) => part.lineStart < cutIndex && part.lineEnd > cutIndex,
  );
  if (straddling !== undefined) {
    return {
      reached: reached.map((part) => ({
        part,
        partial: part.seq === straddling.seq,
      })),
      partial: {
        part: straddling,
        lostBytes: lostBytesFrom(straddling, cutIndex),
      },
      lastCoveredSeq: straddling.seq,
    };
  }

  if (reached.length > 0) {
    const last = reached[reached.length - 1];
    return {
      reached: reached.map((part) => ({ part, partial: false })),
      partial: null,
      lastCoveredSeq: last === undefined ? null : last.seq,
    };
  }

  // Nothing fit: the unit is displayed as a coordinate alone, so its first
  // entry is the one whose content is missing.
  const first = parts.find((part) => part.lineEnd > part.lineStart) ?? parts[0];
  if (first === undefined) {
    return { reached: [], partial: null, lastCoveredSeq: null };
  }
  return {
    reached: [{ part: first, partial: true }],
    partial: { part: first, lostBytes: lostBytesFrom(first, first.lineStart) },
    lastCoveredSeq: first.seq,
  };
}

export interface TranscriptSegment {
  seqStart: number;
  seqEnd: number;
}

/**
 * Partition the (windowed) transcript into ordered, contiguous seq segments
 * whose rendered size stays within `windowBudgetBytes`, for map-reduce
 * ("delta-fold") compaction of transcripts too large for a single pass
 * (docs/design/conversation-compaction/README.md §7.3).
 *
 * Cuts fall only on merged-unit boundaries — a segment never splits a logical
 * message — so each segment's seq span aligns with the delta-merge contract
 * (coverage extends monotonically; sourceRefs stay inside the covered range).
 * A single unit larger than the budget becomes its own (over-budget) segment
 * rather than being dropped; the caller renders it with the renderer's
 * intra-unit truncation as graceful degradation. Byte accounting reuses the
 * exact per-unit rendering `renderCompactTranscript` uses, so a segment packed
 * under the budget renders without truncation.
 */
export function segmentTranscript(
  input: RenderTranscriptInput,
  options: RenderOptions,
  windowBudgetBytes: number,
): TranscriptSegment[] {
  const allUnits = groupTranscriptEntries(input.entries);
  const { selected } = selectWindow(allUnits, options);

  const segments: TranscriptSegment[] = [];
  let current: { seqStart: number; seqEnd: number; bytes: number } | null =
    null;

  for (const { parts } of selected) {
    const firstPart = parts[0];
    const lastPart = parts[parts.length - 1];
    if (!firstPart || !lastPart) continue;
    const { lines } = renderUnitLines(parts, options, {
      thinkingOmitted: 0,
      toolResultBytesElided: 0,
      elidedBytes: 0,
    });
    const cost = unitByteCost(lines);

    if (current === null) {
      current = { seqStart: firstPart.seq, seqEnd: lastPart.seq, bytes: cost };
      continue;
    }
    if (current.bytes + cost > windowBudgetBytes) {
      segments.push({ seqStart: current.seqStart, seqEnd: current.seqEnd });
      current = { seqStart: firstPart.seq, seqEnd: lastPart.seq, bytes: cost };
      continue;
    }
    current.seqEnd = lastPart.seq;
    current.bytes += cost;
  }

  if (current !== null) {
    segments.push({ seqStart: current.seqStart, seqEnd: current.seqEnd });
  }
  return segments;
}

/**
 * Render entry records into the compact transcript shape. Pure — options must
 * already be validated via `renderOptionsSchema`. `options.format` is
 * transport-level: the return value is always the json schema shape; callers
 * wanting markdown feed it through `renderedTranscriptToMarkdown`.
 */
export function renderCompactTranscript(
  input: RenderTranscriptInput,
  options: RenderOptions,
): RenderedTranscript {
  const allUnits = groupTranscriptEntries(input.entries);
  const omissions = {
    thinkingOmitted: 0,
    toolResultBytesElided: 0,
    unitsOutsideWindow: 0,
  };

  const { selected, excluded } = selectWindow(allUnits, options);
  omissions.unitsOutsideWindow += excluded;

  let visible = selected;
  if (options.search !== undefined) {
    const searchRe = new RegExp(options.search);
    visible = [];
    for (const candidate of selected) {
      const matches = candidate.parts.some((part) =>
        part.content.some(
          (block) => block.type === "text" && searchRe.test(block.text),
        ),
      );
      if (matches) visible.push(candidate);
      else omissions.unitsOutsideWindow += 1;
    }
  }

  const renderedUnits: RenderedUnit[] = [];
  const excerptedEntries: ElidedEntry[] = [];
  let excerptedEntriesOmitted = 0;
  /** First excerpt coordinate the report cap could not name. */
  let excerptedEntriesNextSeq: number | null = null;
  let partialEntry: ElidedEntry | null = null;
  /** Last raw seq any rendered line came from; drives the omission cursor. */
  let lastCoveredSeq: number | null = null;
  let truncated = false;
  let usedBytes = 0;

  /** Detail level a recovery command must reproduce to show what was cut. */
  const level = {
    includeThinking: options.includeThinking,
    includeTools: options.includeTools,
  };

  /** Record one shortened entry, or the cursor to it once the cap is full. */
  function reportExcerpt(
    part: RenderedPart,
    messageIndex: number,
    elidedBytes: number,
  ): void {
    if (elidedBytes <= 0) return;
    if (excerptedEntries.length < MAX_EXCERPTED_ENTRY_REPORTS) {
      excerptedEntries.push({
        seq: part.seq,
        messageIndex,
        elidedBytes,
        command: entryGetCommand(input.conversationId, part.seq, level),
      });
      return;
    }
    excerptedEntriesOmitted += 1;
    excerptedEntriesNextSeq ??= part.seq;
  }

  for (const { unit, parts } of visible) {
    const unitOmissions: MutableOmissions = {
      thinkingOmitted: 0,
      toolResultBytesElided: 0,
      elidedBytes: 0,
    };
    const {
      lines,
      lineSeqs,
      parts: renderedParts,
    } = renderUnitLines(parts, options, unitOmissions);

    const unitBytes = unitByteCost(lines);
    const firstPart = unit.parts[0];
    const lastPart = unit.parts[unit.parts.length - 1];
    const ref = {
      messageIndex: unit.messageIndex,
      messageId: unit.messageId,
      seqStart: firstPart ? firstPart.seq : -1,
      seqEnd: lastPart ? lastPart.seq : -1,
    };

    if (usedBytes + unitBytes > options.maxBytes) {
      truncated = true;
      // Emit the boundary unit partially when some of its lines fit, or when
      // dropping it whole would return nothing: a bounded slice of an
      // oversize message beats an empty result (§1.4 Tier-2 escalation).
      const budget = options.maxBytes - usedBytes;
      const includedLines: string[] = [];
      const includedSeqs: number[] = [];
      let includedBytes = 0;
      /** Number of the unit's rendered lines that fit. */
      let cutIndex = 0;
      for (const [index, line] of lines.entries()) {
        const lineBytes = byteLength(line) + 1;
        if (includedBytes + lineBytes > budget) break;
        includedBytes += lineBytes;
        includedLines.push(line);
        cutIndex = index + 1;
        const seq = lineSeqs[index];
        if (
          seq !== undefined &&
          includedSeqs[includedSeqs.length - 1] !== seq
        ) {
          includedSeqs.push(seq);
        }
      }
      if (includedLines.length > 0 || renderedUnits.length === 0) {
        includedLines.push(
          `… [unit truncated: ${unitBytes - includedBytes} bytes elided]`,
        );
        renderedUnits.push({
          ref,
          entrySeqs: includedSeqs,
          role: unit.role,
          timestamp: unit.timestamp ?? "",
          lines: includedLines,
        });
        const cut = attributeCut(lines, renderedParts, cutIndex);
        for (const reached of cut.reached) {
          omissions.thinkingOmitted += reached.part.thinkingOmitted;
          omissions.toolResultBytesElided += reached.part.toolResultBytesElided;
        }
        // An entry the budget stopped short of is still an entry the renderer
        // SHORTENED: its excerpt command survives the cut rather than being
        // dropped along with the entries that were never reached.
        for (const reached of cut.reached) {
          if (reached.partial) continue;
          reportExcerpt(
            reached.part,
            ref.messageIndex,
            reached.part.elidedBytes,
          );
        }
        if (cut.partial !== null) {
          // Only this entry's own unrendered lines — the rest of the unit
          // belongs to the entries the read never reached.
          partialEntry = {
            seq: cut.partial.part.seq,
            messageIndex: ref.messageIndex,
            elidedBytes: cut.partial.lostBytes + cut.partial.part.elidedBytes,
            command: entryGetCommand(
              input.conversationId,
              cut.partial.part.seq,
              level,
            ),
          };
        }
        lastCoveredSeq = cut.lastCoveredSeq ?? lastCoveredSeq;
      }
      break;
    }
    usedBytes += unitBytes;
    omissions.thinkingOmitted += unitOmissions.thinkingOmitted;
    omissions.toolResultBytesElided += unitOmissions.toolResultBytesElided;

    for (const part of renderedParts) {
      reportExcerpt(part, ref.messageIndex, part.elidedBytes);
    }

    const lastRenderedSeq = parts[parts.length - 1]?.seq;
    if (lastRenderedSeq !== undefined) lastCoveredSeq = lastRenderedSeq;

    renderedUnits.push({
      ref,
      entrySeqs: parts.map((part) => part.seq),
      role: unit.role,
      timestamp: unit.timestamp ?? "",
      lines,
    });
  }

  return {
    conversationId: input.conversationId,
    totalMessages: allUnits.length,
    maxSeq: input.maxSeq,
    units: renderedUnits,
    truncated,
    omissions,
    boundaries:
      input.boundaries === undefined || input.boundaries.length === 0
        ? EMPTY_TRANSCRIPT_BOUNDARIES
        : projectRangeBoundaries({
            conversationId: input.conversationId,
            boundaries: input.boundaries,
            units: renderedUnits.map((rendered) => ({
              messageIndex: rendered.ref.messageIndex,
              entrySeqs: rendered.entrySeqs,
            })),
          }),
    truncation: {
      // A tool-result excerpt is a loss the byte budget did not cause, so the
      // excerpt index is reported whether or not the read was truncated.
      omittedAfter: truncated
        ? omittedAfter(
            input.conversationId,
            visible,
            renderedUnits.length,
            lastCoveredSeq,
            level,
          )
        : null,
      partialEntry,
      excerptedEntries,
      excerptedEntriesOmitted,
      excerptedEntriesNext:
        excerptedEntriesNextSeq === null || lastCoveredSeq === null
          ? null
          : {
              nextSeq: excerptedEntriesNextSeq,
              lastSeq: lastCoveredSeq,
              command: readSeqRangeCommand(
                input.conversationId,
                excerptedEntriesNextSeq,
                lastCoveredSeq,
                level,
              ),
            },
    },
  };
}

/**
 * The seq window a byte-budget cut left entirely unread. Null when the cut
 * landed inside the window's last entry: that loss is the partial entry, and
 * pointing a range read at it would return the same excerpt again.
 */
function omittedAfter(
  conversationId: string,
  visible: SelectedUnit[],
  renderedUnitCount: number,
  lastCoveredSeq: number | null,
  level: ReaderDetailLevel,
): TranscriptTruncation["omittedAfter"] {
  const windowSeqs = visible
    .flatMap(({ parts }) => parts.map((part) => part.seq))
    .sort((a, b) => a - b);
  const lastSeq = windowSeqs[windowSeqs.length - 1];
  if (lastSeq === undefined) return null;

  const nextSeq = windowSeqs.find(
    (seq) => lastCoveredSeq === null || seq > lastCoveredSeq,
  );
  if (nextSeq === undefined) return null;

  return {
    nextSeq,
    lastSeq,
    unitCount: visible.length - renderedUnitCount,
    command: readSeqRangeCommand(conversationId, nextSeq, lastSeq, level),
  };
}

/**
 * Format a rendered transcript as a compact markdown document with
 * `#<messageIndex> [seq A–B] <role>` unit headers — for agents that want to
 * read prose directly instead of JSON.
 */
export function renderedTranscriptToMarkdown(
  rendered: RenderedTranscript,
): string {
  const sections = rendered.units.map((unit) => {
    const { messageIndex, seqStart, seqEnd } = unit.ref;
    const span =
      seqStart === seqEnd ? `[seq ${seqStart}]` : `[seq ${seqStart}–${seqEnd}]`;
    return [`#${messageIndex} ${span} ${unit.role}`, ...unit.lines].join("\n");
  });
  const body = [
    ...sections,
    ...checkpointBoundaryLines(rendered.boundaries),
  ].join("\n\n");
  return rendered.truncated ? `${body}\n\n… [output truncated]` : body;
}
