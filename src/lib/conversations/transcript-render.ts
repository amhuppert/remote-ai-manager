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
});
export type RenderedTranscript = z.infer<typeof renderedTranscriptSchema>;

export interface RenderTranscriptInput {
  conversationId: string;
  entries: TranscriptEntryWithSeq[];
  maxSeq: number;
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

function headline(text: string): string {
  const firstLine =
    text.split("\n").find((line) => line.trim().length > 0) ?? "";
  return truncate(firstLine.trim(), OUTLINE_HEADLINE_MAX_CHARS);
}

function toolPrimaryArg(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of PRIMARY_ARG_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return truncate(value, TOOL_PRIMARY_ARG_MAX_CHARS);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > 0) {
      return truncate(value, TOOL_PRIMARY_ARG_MAX_CHARS);
    }
  }
  return "";
}

function toolInputGist(input: Record<string, unknown> | undefined): string {
  if (!input || Object.keys(input).length === 0) return "";
  return truncate(JSON.stringify(input), TOOL_INPUT_GIST_MAX_CHARS);
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
}

function renderBlockLines(
  block: MessageContentBlock,
  options: RenderOptions,
  omissions: MutableOmissions,
): string[] {
  switch (block.type) {
    case "text": {
      if (options.outline) return [headline(block.text)];
      return block.text.split("\n");
    }
    case "thinking": {
      if (options.outline || !options.includeThinking) {
        omissions.thinkingOmitted += 1;
        return [];
      }
      if (block.redacted) return ["🧠 thinking: [redacted]"];
      const collapsed = block.text.replace(/\s+/g, " ").trim();
      return [
        `🧠 thinking: ${truncate(collapsed, THINKING_EXCERPT_MAX_CHARS)}`,
      ];
    }
    case "tool_use": {
      if (options.outline || options.includeTools === "none") return [];
      const gist = toolInputGist(block.input);
      const summary = `⚙ ${block.name}(${toolPrimaryArg(block.input)})${gist ? ` — ${gist}` : ""}`;
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
      if (options.includeTools === "full" || content.length <= excerptBound) {
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
        `🐞 debug[${block.phase}]: ${truncate(payloadText, DEBUG_PAYLOAD_MAX_CHARS)}`,
      ];
    }
    case "document_feedback": {
      if (options.outline) return [];
      return block.items.map(
        (item) =>
          `📝 ${item.docPath}:${item.line} ${item.headingLabel} — ${truncate(item.note, FEEDBACK_NOTE_MAX_CHARS)}`,
      );
    }
  }
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

/** Render one unit's parts into `[s<seq>] <line>` lines with their seqs. */
function renderUnitLines(
  parts: UnitPart[],
  options: RenderOptions,
  omissions: MutableOmissions,
): { lines: string[]; lineSeqs: number[] } {
  const lines: string[] = [];
  const lineSeqs: number[] = [];
  for (const part of parts) {
    for (const block of part.content) {
      for (const line of renderBlockLines(block, options, omissions)) {
        lines.push(`[s${part.seq}] ${line}`);
        lineSeqs.push(part.seq);
      }
    }
  }
  return { lines, lineSeqs };
}

/** Byte cost of a unit's rendered lines, matching the truncation accounting. */
function unitByteCost(lines: string[]): number {
  return lines.reduce((sum, line) => sum + byteLength(line) + 1, 0);
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
  let truncated = false;
  let usedBytes = 0;

  for (const { unit, parts } of visible) {
    const unitOmissions: MutableOmissions = {
      thinkingOmitted: 0,
      toolResultBytesElided: 0,
    };
    const { lines, lineSeqs } = renderUnitLines(parts, options, unitOmissions);

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
      for (const [index, line] of lines.entries()) {
        const lineBytes = byteLength(line) + 1;
        if (includedBytes + lineBytes > budget) break;
        includedBytes += lineBytes;
        includedLines.push(line);
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
      }
      break;
    }
    usedBytes += unitBytes;
    omissions.thinkingOmitted += unitOmissions.thinkingOmitted;
    omissions.toolResultBytesElided += unitOmissions.toolResultBytesElided;

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
  const body = sections.join("\n\n");
  return rendered.truncated ? `${body}\n\n… [output truncated]` : body;
}
