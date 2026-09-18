/**
 * The single owner of the transcript "logical unit" (merged-message) grouping.
 *
 * Four call sites reduce a raw JSONL transcript to logical messages: the
 * conversation read path (`readConversationMessagesWithSeq`), the compact
 * renderer (`groupTranscriptEntries`), the fork/copy merged-index counting
 * (`copyTranscriptUpTo`), and the fork-anchor UUID lookup (`findForkAnchorUuid`).
 * They want different products — merged content, per-entry render units,
 * raw-line spans, line-boundary anchors — but must agree on *which lines belong
 * to which merged unit*, or a merged-message index means one thing to the UI
 * and another to a fork.
 *
 * This module owns that grouping as two iterators over a normalized entry
 * stream, so visibility filtering and merged-index advancement live in exactly
 * one place:
 *
 *   - {@link iterateLineClassifications} walks every raw line (visible entries,
 *     `tool_result` lines, and other non-visible lines alike) and classifies
 *     each with its merged-unit index, whether it opens a unit, and its role /
 *     uuid — the line-level product the copy and fork-anchor projections slice.
 *   - {@link groupLogicalUnits} folds that stream into merged units, each with
 *     its parts (consecutive same-role entries plus interleaved `tool_result`
 *     lines, every part keeping its own seq) — the unit-level product the read
 *     and render projections consume.
 *
 * The boundary rule: a visible entry (user/assistant/notice with content) opens
 * a new logical unit iff its role differs from the currently-open unit's role,
 * OR it is a slash-command user entry (which always breaks the merge chain and
 * carries the parsed command block as its content). Non-visible entries
 * (system, tool_result) never open a unit; `tool_result` lines fold into the
 * open unit as parts, while other non-visible lines only inherit the open
 * merged index (used by the copy path to keep them inside an included range).
 */

import { parseCommandContent } from "@/lib/commands/parsing";
import type {
  MessageContentBlock,
  TranscriptMessageOrigin,
} from "@/lib/conversations/schemas";

export type LogicalUnitRole = "user" | "assistant" | "notice";

/**
 * If a visible entry is a single-text-block user slash-command invocation,
 * return its parsed command block (the unit's canonical content); otherwise
 * null. A command entry always starts its own logical unit.
 */
export function commandBlockForEntry(
  role: LogicalUnitRole,
  content: readonly MessageContentBlock[],
): MessageContentBlock | null {
  if (role !== "user" || content.length !== 1) return null;
  const block = content[0];
  if (!block || block.type !== "text" || !("text" in block)) return null;
  return parseCommandContent(block.text);
}

/**
 * Whether a visible entry opens a new logical unit given the currently-open
 * unit's role (null when no unit is open yet) and whether this entry is a
 * slash command. A command always breaks; otherwise a role change breaks.
 */
export function startsNewLogicalUnit(input: {
  openRole: LogicalUnitRole | null;
  entryRole: LogicalUnitRole;
  isCommand: boolean;
}): boolean {
  if (input.isCommand) return true;
  return input.entryRole !== input.openRole;
}

/**
 * A normalized raw JSONL line fed to the grouping iterators. Callers project
 * their own on-disk shape into this discriminated union:
 *   - `message`  — a visible user/assistant/notice entry with content.
 *   - `tool_result` — a stored tool-result line: not visible, but folds into
 *     the open unit as a part.
 *   - `nonvisible` — any other line (system frames, malformed-but-skipped
 *     placeholders, etc.): not visible and not folded, but its raw seq still
 *     lets a copy range include it when it falls inside an included unit.
 */
export type LogicalUnitEntry =
  | {
      seq: number;
      kind: "message";
      role: LogicalUnitRole;
      content: MessageContentBlock[];
      origin?: TranscriptMessageOrigin;
      entryId?: string | null;
      timestamp?: string | null;
      uuid?: string;
    }
  | {
      seq: number;
      kind: "tool_result";
      content: MessageContentBlock[];
      origin?: TranscriptMessageOrigin;
      entryId?: string | null;
      timestamp?: string | null;
    }
  | {
      seq: number;
      kind: "nonvisible";
    };

/** Per-raw-line classification against the merged-unit grouping. */
export interface LineClassification {
  /** Raw 0-based JSONL line index carried straight through from the entry. */
  seq: number;
  /** True only for `kind:"message"` entries with content. */
  visible: boolean;
  /**
   * Merged-unit index this line belongs to. Visible entries that open a unit
   * advance it; every other line inherits the currently-open index (−1 before
   * any unit opens).
   */
  mergedIndex: number;
  /** True when this visible entry starts a new logical unit. */
  opensUnit: boolean;
  /** Role of a visible entry; null for non-visible lines. */
  role: LogicalUnitRole | null;
  /** SDK UUID of a visible message entry when present (fork anchoring). */
  uuid?: string | undefined;
}

/**
 * Walk every raw line and classify it against the merged-unit grouping. This is
 * the line-level product: the copy path slices raw line ranges by
 * `mergedIndex`/`opensUnit`, and the fork-anchor lookup reads `mergedIndex`,
 * `role`, and `uuid`. Non-visible lines are yielded too (with their real seq)
 * so callers that need raw spans see every line.
 */
export function* iterateLineClassifications(
  entries: Iterable<LogicalUnitEntry>,
): Generator<LineClassification> {
  let openRole: LogicalUnitRole | null = null;
  let mergedIndex = -1;

  for (const entry of entries) {
    if (entry.kind !== "message") {
      yield {
        seq: entry.seq,
        visible: false,
        mergedIndex,
        opensUnit: false,
        role: null,
      };
      continue;
    }

    const isCommand = commandBlockForEntry(entry.role, entry.content) !== null;
    const opensUnit = startsNewLogicalUnit({
      openRole,
      entryRole: entry.role,
      isCommand,
    });
    if (opensUnit) {
      mergedIndex += 1;
      openRole = entry.role;
    }

    yield {
      seq: entry.seq,
      visible: true,
      mergedIndex,
      opensUnit,
      role: entry.role,
      uuid: entry.uuid,
    };
  }
}

/** One entry's contribution to a merged unit, with its raw coordinate. */
export interface LogicalUnitPart {
  origin?: TranscriptMessageOrigin;
  seq: number;
  entryId: string | null;
  content: MessageContentBlock[];
}

/** A logical (merged) message with per-entry coordinates preserved. */
export interface LogicalUnit {
  messageIndex: number;
  messageId: string | null;
  role: LogicalUnitRole;
  timestamp: string | null;
  parts: LogicalUnitPart[];
}

/**
 * Fold a normalized entry stream into merged logical units. Consecutive
 * same-role entries merge into one unit; a single-text-block user slash command
 * always starts its own unit (its part carries the parsed command block).
 * `tool_result` lines fold into the open unit as parts keeping their own seq; a
 * `tool_result` with no open unit is dropped. `nonvisible` lines never affect
 * units.
 */
export function groupLogicalUnits(
  entries: Iterable<LogicalUnitEntry>,
): LogicalUnit[] {
  const units: LogicalUnit[] = [];

  for (const entry of entries) {
    if (entry.kind === "nonvisible") continue;

    if (entry.kind === "tool_result") {
      const open = units[units.length - 1];
      if (!open) continue;
      open.parts.push({
        seq: entry.seq,
        entryId: entry.entryId ?? null,
        ...(entry.origin ? { origin: entry.origin } : {}),
        content: entry.content,
      });
      continue;
    }

    const commandBlock = commandBlockForEntry(entry.role, entry.content);
    const open = units[units.length - 1];
    const opensUnit = startsNewLogicalUnit({
      openRole: open?.role ?? null,
      entryRole: entry.role,
      isCommand: commandBlock !== null,
    });

    if (!opensUnit && open) {
      open.parts.push({
        seq: entry.seq,
        entryId: entry.entryId ?? null,
        ...(entry.origin ? { origin: entry.origin } : {}),
        content: entry.content,
      });
      continue;
    }

    units.push({
      messageIndex: units.length,
      messageId: entry.entryId ?? null,
      role: entry.role,
      timestamp: entry.timestamp ?? null,
      parts: [
        {
          seq: entry.seq,
          entryId: entry.entryId ?? null,
          ...(entry.origin ? { origin: entry.origin } : {}),
          content: commandBlock ? [commandBlock] : entry.content,
        },
      ],
    });
  }

  return units;
}
