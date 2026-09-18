/**
 * The checkpoint seed builder: deterministic rendering of the frozen bytes.
 *
 * Everything here is pure. The model supplies working state; this module
 * decides what the injected string actually is, and the bytes it returns are
 * the bytes that get hashed, stored, and injected — nothing downstream
 * re-renders a saved payload.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  groupTranscriptEntries,
  recordedEvidenceUnits,
  isRecordedEvidenceReference,
  type TranscriptUnit,
} from "@/lib/conversations/transcript-render";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";

import {
  CHECKPOINT_SEED_BUDGET,
  truncateToUtf8Bytes,
  utf8ByteLength,
} from "./budget";
import type {
  CheckpointOmission,
  CheckpointHandoffCandidate,
  CheckpointScope,
  CheckpointSectionBytes,
} from "./schemas";

export const CHECKPOINT_NOT_ESTABLISHED =
  "not established in recorded evidence";

export const checkpointSourceRefSchema = z
  .object({
    messageIndex: z.number().int().nonnegative(),
    seqStart: z.number().int().nonnegative(),
    seqEnd: z.number().int().nonnegative(),
  })
  .strict();
export type CheckpointSourceRef = z.infer<typeof checkpointSourceRefSchema>;

const anchoredEntrySchema = z
  .object({
    text: z.string().min(1),
    sourceRefs: z.array(checkpointSourceRefSchema).min(1),
  })
  .strict();

/**
 * A single-valued factual field. It is the same shape as a list entry except
 * that `sourceRefs` may be empty, because the unestablished case is the exact
 * CHECKPOINT_NOT_ESTABLISHED text with nothing to cite. The builder enforces
 * that pairing: a stated objective must cite evidence, an unestablished one
 * must not. A discriminated union would say it in the schema, at the cost of an
 * `anyOf` that strict structured output rejects.
 */
const establishedValueSchema = z
  .object({
    text: z.string().min(1),
    sourceRefs: z.array(checkpointSourceRefSchema),
  })
  .strict();

export const checkpointWorkingStateSchema = z
  .object({
    objective: establishedValueSchema,
    latestRequest: establishedValueSchema,
    outstandingRequests: z.array(anchoredEntrySchema),
    constraints: z.array(anchoredEntrySchema),
    decisions: z.array(
      z
        .object({
          statement: z.string().min(1),
          status: z.enum(["proposed", "accepted", "rejected", "superseded"]),
          rationale: z.string().min(1),
          sourceRefs: z.array(checkpointSourceRefSchema).min(1),
        })
        .strict(),
    ),
    failedApproaches: z.array(
      z
        .object({
          approach: z.string().min(1),
          outcome: z.string().min(1),
          sourceRefs: z.array(checkpointSourceRefSchema).min(1),
        })
        .strict(),
    ),
    openQuestions: z.array(anchoredEntrySchema),
    blockers: z.array(anchoredEntrySchema),
    nextActions: z.array(anchoredEntrySchema),
  })
  .strict();
export type CheckpointWorkingState = z.infer<
  typeof checkpointWorkingStateSchema
>;

export interface CheckpointSeedIdentity {
  conversationId: string;
  checkpointId: string;
  ordinal: number;
  scope: CheckpointScope;
}

export interface CheckpointSeedSourceInfo {
  firstSeq: number;
  capturedThroughSeq: number;
  totalMessages: number;
}

export interface BuildCheckpointSeedInput {
  agentHandoff?: CheckpointHandoffCandidate;
  identity: CheckpointSeedIdentity;
  source: CheckpointSeedSourceInfo;
  workingState: CheckpointWorkingState;
  /** The captured entries the recent tail is selected from. */
  entries: TranscriptEntryWithSeq[];
}

export interface BuiltCheckpointSeed {
  handoffDecision?: "included" | "seed_budget";
  seedText: string;
  seedSha256: string;
  sectionBytes: CheckpointSectionBytes;
  omissions: CheckpointOmission[];
  sections: {
    workingState: unknown;
    recentDialogue: unknown;
    recoveryMap: unknown;
  };
}

export type CheckpointBuildIssueCode =
  | "invalid_source_ref"
  | "missing_source_ref"
  | "working_state_too_large"
  | "recovery_framing_too_large"
  | "recent_dialogue_too_large"
  | "seed_too_large";

export interface CheckpointBuildIssue {
  code: CheckpointBuildIssueCode;
  detail: string;
}

export type BuildCheckpointSeedResult =
  | { ok: true; seed: BuiltCheckpointSeed }
  | { ok: false; issues: CheckpointBuildIssue[] };

/** Handles per unit before the rest collapse into one counted line. */
const MAX_UNIT_HANDLES = 8;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function seqSpan(start: number, end: number): string {
  return start === end ? `s${start}` : `s${start}\u2013s${end}`;
}

/**
 * The bounded reader. It lists what a raw range holds, under the reader's own
 * presentation limits, so it is a navigation pointer and never labelled as a
 * complete source: an oversize entry can come back as a truncation marker.
 */
function readCommand(
  conversationId: string,
  seqStart: number,
  seqEnd: number,
): string {
  return `cctl conversation read ${conversationId} --seq-range ${seqStart}:${seqEnd} --include-tools full`;
}

/**
 * The complete-entry export: one raw entry, full tool detail, no presentation
 * excerpt limits. Every handle whose content the seed dropped points here,
 * because these commands are frozen into the payload and a later reader cannot
 * repair a pointer that leads to a bounded read.
 */
function entryCommand(conversationId: string, seq: number): string {
  return `cctl conversation entry get ${conversationId} ${seq}`;
}

/** Exact entry-get commands named for an excerpted unit before the rest fold. */
const MAX_EXCERPT_ENTRY_COMMANDS = 3;

/** Complete-entry commands for a unit's own raw lines, bounded in count. */
function completeEntryCommands(conversationId: string, seqs: number[]): string {
  const shown = seqs.slice(0, MAX_EXCERPT_ENTRY_COMMANDS);
  const commands = shown
    .map((seq) => entryCommand(conversationId, seq))
    .join("; ");
  const remaining = seqs.length - shown.length;
  const last = seqs[seqs.length - 1];
  return remaining > 0 && last !== undefined
    ? `${commands}; then one entry get per remaining line through s${last}`
    : commands;
}

function renderRefs(refs: CheckpointSourceRef[]): string {
  return refs
    .map((ref) => `[#${ref.messageIndex} ${seqSpan(ref.seqStart, ref.seqEnd)}]`)
    .join(" ");
}

/** One factual claim in the working state, with the field path that names it. */
interface WorkingStateClaim {
  field: string;
  established: boolean;
  sourceRefs: CheckpointSourceRef[];
}

function listClaims(
  field: string,
  items: { sourceRefs: CheckpointSourceRef[] }[],
): WorkingStateClaim[] {
  return items.map((item, index) => ({
    field: `${field}[${index}]`,
    established: true,
    sourceRefs: item.sourceRefs,
  }));
}

/**
 * Every claim the seed will assert. Objective and latest request are claims
 * like any other: a successor agent acts on them, so they carry the same
 * anchoring obligation as a decision or a next action.
 */
function collectClaims(state: CheckpointWorkingState): WorkingStateClaim[] {
  return [
    {
      field: "objective",
      established: state.objective.text !== CHECKPOINT_NOT_ESTABLISHED,
      sourceRefs: state.objective.sourceRefs,
    },
    {
      field: "latestRequest",
      established: state.latestRequest.text !== CHECKPOINT_NOT_ESTABLISHED,
      sourceRefs: state.latestRequest.sourceRefs,
    },
    ...listClaims("outstandingRequests", state.outstandingRequests),
    ...listClaims("constraints", state.constraints),
    ...listClaims("decisions", state.decisions),
    ...listClaims("failedApproaches", state.failedApproaches),
    ...listClaims("openQuestions", state.openQuestions),
    ...listClaims("blockers", state.blockers),
    ...listClaims("nextActions", state.nextActions),
  ];
}

function collectRefs(state: CheckpointWorkingState): CheckpointSourceRef[] {
  return collectClaims(state).flatMap((claim) => claim.sourceRefs);
}

/**
 * Which logical message owns each captured raw line. Units are appended in
 * stream order and their parts with them, so every line of message *n* precedes
 * every line of message *n+1*: a reference whose endpoints both belong to the
 * message it names cannot span a foreign line in between.
 */
function ownerBySeq(units: TranscriptUnit[]): Map<number, number> {
  const owner = new Map<number, number>();
  for (const unit of units) {
    for (const part of unit.parts) owner.set(part.seq, unit.messageIndex);
  }
  return owner;
}

/**
 * Anchoring is what makes a claim checkable: the reader must be able to open
 * the cited message and see the fact. A range that names a message it does not
 * belong to, or a raw line the archive never recorded, or the whole archive
 * attributed to one message, all read as evidence while pointing at nothing —
 * so each is refused rather than frozen.
 */
function validateWorkingState(
  state: CheckpointWorkingState,
  source: CheckpointSeedSourceInfo,
  units: TranscriptUnit[],
): CheckpointBuildIssue[] {
  const issues: CheckpointBuildIssue[] = [];
  const owner = ownerBySeq(units);

  for (const claim of collectClaims(state)) {
    if (claim.established && claim.sourceRefs.length === 0) {
      issues.push({
        code: "missing_source_ref",
        detail: `${claim.field} states a fact without a supporting source reference`,
      });
      continue;
    }
    if (!claim.established && claim.sourceRefs.length > 0) {
      issues.push({
        code: "invalid_source_ref",
        detail: `${claim.field} is labeled not established but cites ${claim.sourceRefs.length} source reference(s)`,
      });
      continue;
    }

    for (const ref of claim.sourceRefs) {
      if (ref.seqStart > ref.seqEnd) {
        issues.push({
          code: "invalid_source_ref",
          detail: `${claim.field}: seqStart ${ref.seqStart} is after seqEnd ${ref.seqEnd}`,
        });
        continue;
      }
      if (
        ref.seqStart < source.firstSeq ||
        ref.seqEnd > source.capturedThroughSeq
      ) {
        issues.push({
          code: "invalid_source_ref",
          detail: `${claim.field}: ${seqSpan(ref.seqStart, ref.seqEnd)} is outside the captured boundary ${seqSpan(source.firstSeq, source.capturedThroughSeq)}`,
        });
        continue;
      }
      const startOwner = owner.get(ref.seqStart);
      const endOwner = owner.get(ref.seqEnd);
      if (startOwner === undefined || endOwner === undefined) {
        issues.push({
          code: "invalid_source_ref",
          detail: `${claim.field}: ${seqSpan(ref.seqStart, ref.seqEnd)} names a raw line the captured archive does not record`,
        });
        continue;
      }
      if (startOwner !== ref.messageIndex || endOwner !== ref.messageIndex) {
        issues.push({
          code: "invalid_source_ref",
          detail: `${claim.field}: ${seqSpan(ref.seqStart, ref.seqEnd)} spans messages #${startOwner}\u2013#${endOwner}, not the cited message #${ref.messageIndex}`,
        });
        continue;
      }
      if (!isRecordedEvidenceReference(ref, units)) {
        issues.push({
          code: "invalid_source_ref",
          detail: `${claim.field}: reference contains capture-origin or foreign parts`,
        });
        continue;
      }
    }
  }
  return issues;
}

function renderAnchoredList(
  heading: string,
  items: { text: string; sourceRefs: CheckpointSourceRef[] }[],
): string {
  if (items.length === 0) {
    return `${heading}:\n- ${CHECKPOINT_NOT_ESTABLISHED}\n\n`;
  }
  const lines = items.map(
    (item) => `- ${item.text} ${renderRefs(item.sourceRefs)}`,
  );
  return `${heading}:\n${lines.join("\n")}\n\n`;
}

function renderWorkingState(state: CheckpointWorkingState): string {
  const decisions =
    state.decisions.length === 0
      ? `- ${CHECKPOINT_NOT_ESTABLISHED}`
      : state.decisions
          .map(
            (decision) =>
              `- [${decision.status}] ${decision.statement} \u2014 ${decision.rationale} ${renderRefs(decision.sourceRefs)}`,
          )
          .join("\n");
  const failed =
    state.failedApproaches.length === 0
      ? `- ${CHECKPOINT_NOT_ESTABLISHED}`
      : state.failedApproaches
          .map(
            (failure) =>
              `- ${failure.approach} \u2192 ${failure.outcome} ${renderRefs(failure.sourceRefs)}`,
          )
          .join("\n");

  const value = (item: { text: string; sourceRefs: CheckpointSourceRef[] }) =>
    item.sourceRefs.length === 0
      ? item.text
      : `${item.text} ${renderRefs(item.sourceRefs)}`;

  return (
    `## Working state\n\n` +
    `Objective: ${value(state.objective)}\n` +
    `Latest request: ${value(state.latestRequest)}\n\n` +
    renderAnchoredList("Outstanding requests", state.outstandingRequests) +
    renderAnchoredList("Constraints", state.constraints) +
    `Decisions:\n${decisions}\n\n` +
    `Failed approaches:\n${failed}\n\n` +
    renderAnchoredList("Unresolved questions", state.openQuestions) +
    renderAnchoredList("Blockers", state.blockers) +
    renderAnchoredList("Next actions", state.nextActions)
  );
}

interface RenderedUnitBlock {
  messageIndex: number;
  role: string;
  seqStart: number;
  seqEnd: number;
  text: string;
  excerpt: boolean;
}

function unitSpan(unit: TranscriptUnit): { start: number; end: number } {
  const first = unit.parts[0];
  const last = unit.parts[unit.parts.length - 1];
  return { start: first?.seq ?? -1, end: last?.seq ?? -1 };
}

/**
 * One dialogue block: exact recorded speech, with every non-speech block
 * reduced to an evidence handle naming the command that recovers it. Tool
 * bodies and image bytes are deliberately absent — the seed points at them,
 * it does not carry them.
 */
function renderUnitBody(
  unit: TranscriptUnit,
  conversationId: string,
): { body: string; handles: number } {
  const speech: string[] = [];
  const handles: string[] = [];
  for (const part of unit.parts) {
    for (const [blockIndex, block] of part.content.entries()) {
      const handle = renderHandle(block, part.seq, blockIndex, conversationId);
      if (handle !== null) {
        handles.push(handle);
        continue;
      }
      if (block.type === "text") speech.push(block.text);
      else if (block.type === "command")
        speech.push(`/${block.name}${block.args ? ` ${block.args}` : ""}`);
    }
  }
  const shown = handles.slice(0, MAX_UNIT_HANDLES);
  const span = unitSpan(unit);
  if (handles.length > shown.length) {
    shown.push(
      `\u2026 ${handles.length - shown.length} more evidence blocks in ${seqSpan(span.start, span.end)} \u2014 list: ${readCommand(conversationId, span.start, span.end)}`,
    );
  }
  return {
    body: [...speech, ...shown].join("\n"),
    handles: handles.length,
  };
}

function renderHandle(
  block: MessageContentBlock,
  seq: number,
  blockIndex: number,
  conversationId: string,
): string | null {
  switch (block.type) {
    case "text":
    case "command":
    case "thinking":
      return null;
    case "tool_use":
      return `\u2699 tool ${block.name} [s${seq}] \u2014 ${entryCommand(conversationId, seq)}`;
    case "tool_result": {
      const status = block.isError === true ? "error" : "ok";
      const bytes = utf8ByteLength(block.content ?? "");
      return `\u2192 tool result ${status} (${bytes} bytes) [s${seq}] \u2014 ${entryCommand(conversationId, seq)}`;
    }
    case "image":
    case "image_ref":
    case "image_marker":
      return `\u{1F5BC} image ${block.mediaType} [s${seq} block ${blockIndex}] \u2014 cctl conversation image get ${conversationId} ${seq} ${blockIndex}`;
    case "debug_structured":
      return `\u{1F41E} debug ${block.phase} [s${seq}] \u2014 ${entryCommand(conversationId, seq)}`;
    case "document_feedback":
      return `\u{1F4DD} document feedback (${block.items.length}) [s${seq}] \u2014 ${entryCommand(conversationId, seq)}`;
    case "notepad_feedback":
      return `\u{1F4DD} notepad feedback ${block.notepadName} (${block.items.length}) [s${seq}] \u2014 ${entryCommand(conversationId, seq)}`;
  }
}

function unitHeader(unit: TranscriptUnit, suffix = ""): string {
  const span = unitSpan(unit);
  return `### #${unit.messageIndex} ${unit.role} [${seqSpan(span.start, span.end)}]${suffix}`;
}

interface DialogueSection {
  text: string;
  units: RenderedUnitBlock[];
  omittedUnits: number;
  excerpted: {
    seqStart: number;
    seqEnd: number;
    keptBytes: number;
    totalBytes: number;
  } | null;
}

/**
 * Newest-first selection, chronological presentation. Selection stops at the
 * first unit that does not fit rather than skipping ahead to a smaller older
 * one: "the most recent exchanges" must stay a contiguous tail, or the seed
 * would present a gap it never labels.
 */
function renderRecentDialogue(
  units: TranscriptUnit[],
  conversationId: string,
): DialogueSection {
  const header = `## Recent dialogue (chronological, exact recorded text)\n\n`;
  const budget = CHECKPOINT_SEED_BUDGET.recentDialogue - utf8ByteLength(header);

  const selected: { block: RenderedUnitBlock; text: string }[] = [];
  let used = 0;
  let omittedUnits = 0;
  let excerpted: DialogueSection["excerpted"] = null;

  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index]!;
    const span = unitSpan(unit);
    const { body } = renderUnitBody(unit, conversationId);
    const rendered = `${unitHeader(unit)}\n${body}\n\n`;
    const cost = utf8ByteLength(rendered);

    if (used + cost <= budget) {
      selected.unshift({
        block: {
          messageIndex: unit.messageIndex,
          role: unit.role,
          seqStart: span.start,
          seqEnd: span.end,
          text: rendered,
          excerpt: false,
        },
        text: rendered,
      });
      used += cost;
      continue;
    }

    if (selected.length === 0) {
      const totalBytes = utf8ByteLength(body);
      const recover = completeEntryCommands(
        conversationId,
        unit.parts.map((part) => part.seq),
      );
      const head = `${unitHeader(unit, " \u2014 EXCERPT")}\n`;
      const makeTail = (kept: number): string =>
        `\n\u2026 [excerpt: first ${kept} of ${totalBytes} bytes; complete source: ${recover}]\n\n`;
      const overhead =
        utf8ByteLength(head) + utf8ByteLength(makeTail(totalBytes));
      const bodyBudget = budget - overhead;
      if (bodyBudget > 0) {
        const kept = truncateToUtf8Bytes(body, bodyBudget);
        const keptBytes = utf8ByteLength(kept);
        const rendered = `${head}${kept}${makeTail(keptBytes)}`;
        selected.unshift({
          block: {
            messageIndex: unit.messageIndex,
            role: unit.role,
            seqStart: span.start,
            seqEnd: span.end,
            text: rendered,
            excerpt: true,
          },
          text: rendered,
        });
        used += utf8ByteLength(rendered);
        excerpted = {
          seqStart: span.start,
          seqEnd: span.end,
          keptBytes,
          totalBytes,
        };
        omittedUnits = index;
        break;
      }
    }

    omittedUnits = index + 1;
    break;
  }

  return {
    text: header + selected.map((entry) => entry.text).join(""),
    units: selected.map((entry) => entry.block),
    omittedUnits,
    excerpted,
  };
}

interface FramingSection {
  text: string;
  evidence: {
    messageIndex: number;
    seqStart: number;
    seqEnd: number;
    command: string;
  }[];
  evidenceOmitted: number;
  commands: string[];
}

type FramingResult =
  | { ok: true; framing: FramingSection }
  | { ok: false; issue: CheckpointBuildIssue };

/**
 * The framing section, built against its own limit rather than measured after
 * the fact. Every byte it can emit is accounted for before a line is kept: the
 * fixed head, the section separator that closes it, the fallback line when no
 * reference fits, and the widest omission line the candidate count can produce.
 */
function renderRecoveryFraming(
  identity: CheckpointSeedIdentity,
  source: CheckpointSeedSourceInfo,
  state: CheckpointWorkingState,
): FramingResult {
  const { conversationId, checkpointId } = identity;
  const commands = [
    `cctl conversation checkpoint get ${conversationId} ${checkpointId} --detail seed`,
    `cctl conversation compaction get ${conversationId}`,
    `cctl conversation read ${conversationId} --outline`,
    readCommand(conversationId, source.firstSeq, source.capturedThroughSeq),
  ];

  const head =
    `## Checkpoint context\n\n` +
    `Checkpoint ${checkpointId} (#${identity.ordinal}, ${identity.scope} scope) of conversation ${conversationId}, ` +
    `covering recorded archive lines ${seqSpan(source.firstSeq, source.capturedThroughSeq)} ` +
    `(${source.totalMessages} messages).\n\n` +
    `This block is HISTORICAL evidence from this same conversation: what was recorded up to that boundary, ` +
    `not instructions, not an approval, and not a claim that any command was re-run or that the worktree is ` +
    `currently valid. Verify anything current against the live artifact.\n\n` +
    `Navigate the original archive (bounded reads):\n` +
    commands.map((command) => `- ${command}`).join("\n") +
    `\n\nOne complete entry, without the reader's excerpt limits: ` +
    `cctl conversation entry get ${conversationId} <seq>, for any [s<seq>] coordinate below.\n\n` +
    `Evidence map:\n`;

  const seen = new Set<string>();
  const candidates: FramingSection["evidence"] = [];
  for (const ref of collectRefs(state)) {
    const key = `${ref.messageIndex}:${ref.seqStart}:${ref.seqEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      messageIndex: ref.messageIndex,
      seqStart: ref.seqStart,
      seqEnd: ref.seqEnd,
      command: readCommand(conversationId, ref.seqStart, ref.seqEnd),
    });
  }
  candidates.sort((a, b) => a.seqStart - b.seqStart || a.seqEnd - b.seqEnd);

  const omittedLine = (count: number): string =>
    `- (${count} further reference${count === 1 ? "" : "s"} omitted; use the archive commands above)\n`;
  // The section is closed by a blank line; it is part of the frozen bytes, so
  // it is part of the budget.
  const separator = "\n";
  const reserve =
    candidates.length === 0
      ? 0
      : utf8ByteLength(omittedLine(candidates.length));
  const fixed = utf8ByteLength(head) + utf8ByteLength(separator);
  const fallback = `- ${CHECKPOINT_NOT_ESTABLISHED}\n`;

  // Worst case with nothing kept: head, the fallback line, every candidate
  // reported as omitted, and the separator. If that does not fit, no reduction
  // of optional entries can rescue the section.
  const minimum = fixed + utf8ByteLength(fallback) + reserve;
  if (minimum > CHECKPOINT_SEED_BUDGET.recoveryFraming) {
    return {
      ok: false,
      issue: {
        code: "recovery_framing_too_large",
        detail: `recovery framing needs ${minimum} bytes before any evidence line, over the ${CHECKPOINT_SEED_BUDGET.recoveryFraming}-byte section limit`,
      },
    };
  }

  const kept: FramingSection["evidence"] = [];
  let body = "";
  for (const entry of candidates) {
    const line = `- #${entry.messageIndex} ${seqSpan(entry.seqStart, entry.seqEnd)} \u2014 ${entry.command}\n`;
    const projected =
      fixed + utf8ByteLength(body) + utf8ByteLength(line) + reserve;
    if (projected > CHECKPOINT_SEED_BUDGET.recoveryFraming) break;
    body += line;
    kept.push(entry);
  }
  if (kept.length === 0) body = fallback;
  const evidenceOmitted = candidates.length - kept.length;
  if (evidenceOmitted > 0) body += omittedLine(evidenceOmitted);

  return {
    ok: true,
    framing: {
      text: `${head}${body}${separator}`,
      evidence: kept,
      evidenceOmitted,
      commands,
    },
  };
}

/**
 * The last word on the frozen bytes. Each section renders against its own
 * limit, but the seed's promise is about the string that ships, so the measured
 * result is checked before it can be returned: a section that overran its
 * budget fails the build instead of being frozen and injected.
 */
function overBudgetIssues(
  sectionBytes: CheckpointSectionBytes,
): CheckpointBuildIssue[] {
  const issues: CheckpointBuildIssue[] = [];
  const over = (
    code: CheckpointBuildIssueCode,
    label: string,
    actual: number,
    limit: number,
  ): void => {
    if (actual > limit) {
      issues.push({
        code,
        detail: `${label} rendered to ${actual} bytes, over the ${limit}-byte limit`,
      });
    }
  };
  over(
    "working_state_too_large",
    "working state",
    sectionBytes.workingState,
    CHECKPOINT_SEED_BUDGET.workingState,
  );
  over(
    "recent_dialogue_too_large",
    "recent dialogue",
    sectionBytes.recentDialogue,
    CHECKPOINT_SEED_BUDGET.recentDialogue,
  );
  over(
    "recovery_framing_too_large",
    "recovery framing",
    sectionBytes.recoveryFraming,
    CHECKPOINT_SEED_BUDGET.recoveryFraming,
  );
  over(
    "seed_too_large",
    "the checkpoint seed",
    sectionBytes.total,
    CHECKPOINT_SEED_BUDGET.total,
  );
  return issues;
}

export function buildCheckpointSeed(
  input: BuildCheckpointSeedInput,
): BuildCheckpointSeedResult {
  const { identity, source, workingState, entries } = input;
  const units = groupTranscriptEntries(entries);

  const issues = validateWorkingState(workingState, source, units);
  if (issues.length > 0) return { ok: false, issues };

  const workingStateText = renderWorkingState(workingState);
  const workingStateBytes = utf8ByteLength(workingStateText);
  if (workingStateBytes > CHECKPOINT_SEED_BUDGET.workingState) {
    return {
      ok: false,
      issues: [
        {
          code: "working_state_too_large",
          detail: `working state rendered to ${workingStateBytes} bytes, over the ${CHECKPOINT_SEED_BUDGET.workingState}-byte section limit`,
        },
      ],
    };
  }

  const framingResult = renderRecoveryFraming(identity, source, workingState);
  if (!framingResult.ok) return { ok: false, issues: [framingResult.issue] };
  const framing = framingResult.framing;
  const dialogue = renderRecentDialogue(
    recordedEvidenceUnits(units),
    identity.conversationId,
  );

  let seedText = `${framing.text}${workingStateText}${dialogue.text}`;
  let sectionBytes: CheckpointSectionBytes = {
    total: utf8ByteLength(seedText),
    workingState: workingStateBytes,
    recentDialogue: utf8ByteLength(dialogue.text),
    recoveryFraming: utf8ByteLength(framing.text),
  };
  const budgetIssues = overBudgetIssues(sectionBytes);
  if (budgetIssues.length > 0) return { ok: false, issues: budgetIssues };

  const omissions: CheckpointOmission[] = [];
  if (dialogue.omittedUnits > 0) {
    omissions.push({
      category: "recent_dialogue_units_omitted",
      detail: `${dialogue.omittedUnits} older exchange${dialogue.omittedUnits === 1 ? "" : "s"} outside the recent-dialogue budget; read the archive by seq range`,
    });
  }
  if (dialogue.excerpted !== null) {
    omissions.push({
      category: "recent_dialogue_excerpt",
      detail: `${seqSpan(dialogue.excerpted.seqStart, dialogue.excerpted.seqEnd)} kept ${dialogue.excerpted.keptBytes} of ${dialogue.excerpted.totalBytes} bytes`,
    });
  }
  if (framing.evidenceOmitted > 0) {
    omissions.push({
      category: "evidence_map_truncated",
      detail: `${framing.evidenceOmitted} evidence reference${framing.evidenceOmitted === 1 ? "" : "s"} omitted from the map; every working-state field was retained`,
    });
  }

  let frozenWorkingState: unknown = workingState;
  let handoffDecision: BuiltCheckpointSeed["handoffDecision"];
  if (input.agentHandoff !== undefined) {
    const handoff = {
      attribution: `Source agent of conversation ${identity.conversationId}, captured for checkpoint ${identity.checkpointId}`,
      caveat:
        "Advisory beliefs and proposals at capture time. References locate original observations; they do not establish current approval, validation or task completion. Missing recorded evidence remains unestablished.",
      categoryCounts: Object.fromEntries(
        Object.entries(input.agentHandoff).map(([category, claims]) => [
          category,
          claims.length,
        ]),
      ),
      candidate: input.agentHandoff,
    };
    // JSON string escaping keeps multiline claims as data; escape markup too.
    const data = JSON.stringify(handoff, null, 2)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/`/g, "\\u0060");
    const handoffText = `## Agent handoff — advisory account at capture time\n\n\`\`\`json\n${data}\n\`\`\`\n\n`;
    const addedBytes = utf8ByteLength(handoffText);
    const combinedBytes = {
      ...sectionBytes,
      total: sectionBytes.total + addedBytes,
      workingState: sectionBytes.workingState + addedBytes,
    };
    if (overBudgetIssues(combinedBytes).length > 0) {
      handoffDecision = "seed_budget";
      omissions.push({ category: "handoff_omitted", detail: "seed_budget" });
    } else {
      handoffDecision = "included";
      seedText = `${framing.text}${workingStateText}${handoffText}${dialogue.text}`;
      sectionBytes = combinedBytes;
      frozenWorkingState = { ...workingState, agentHandoff: handoff };
    }
  }

  return {
    ok: true,
    seed: {
      ...(handoffDecision ? { handoffDecision } : {}),
      seedText,
      seedSha256: sha256(seedText),
      sectionBytes,
      omissions,
      sections: {
        workingState: frozenWorkingState,
        recentDialogue: {
          units: dialogue.units.map((unit) => ({
            messageIndex: unit.messageIndex,
            role: unit.role,
            seqStart: unit.seqStart,
            seqEnd: unit.seqEnd,
            excerpt: unit.excerpt,
          })),
          omittedUnits: dialogue.omittedUnits,
        },
        recoveryMap: {
          conversationId: identity.conversationId,
          checkpointId: identity.checkpointId,
          ordinal: identity.ordinal,
          scope: identity.scope,
          boundary: {
            firstSeq: source.firstSeq,
            capturedThroughSeq: source.capturedThroughSeq,
            totalMessages: source.totalMessages,
          },
          commands: framing.commands,
          evidence: framing.evidence,
          evidenceOmitted: framing.evidenceOmitted,
        },
      },
    },
  };
}
