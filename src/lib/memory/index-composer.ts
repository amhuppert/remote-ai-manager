import { createLogger } from "@/lib/logging";
import type { MemoryRepo } from "@/lib/state-store/memory-repo";

import type {
  MemoryFreshnessAssessment,
  MemoryFreshnessEngine,
} from "./freshness";
import { describeMemoryAge, renderMemoryStatusLine } from "./age";
import { renderMemoryArtifactHandle } from "./artifact-handles";
import {
  memoryBodyByteLength,
  memoryIndexBudgetSchema,
  type MemoryArtifactRef,
  type MemoryDeliveryWatermark,
  type MemoryIndexBudget,
  type MemoryIndexDeliveryKind,
  type MemoryIndexDeliveryState,
  type MemoryNote,
  type MemoryScope,
  type MemoryStatusNote,
  type MemoryVisibility,
} from "./schemas";

/**
 * The generated `<memory-index>` block (spec R5, R3, D4): the zero-call half of
 * recall. It is composed from live rows on every call, so a note written by
 * any conversation on any backend is in every other conversation's next block
 * — the cross-session property is the seam's, not a subsystem's.
 *
 * Selection is quota-ordered rather than ranked: the sections below fill in
 * delivery order, each with a reserved share of the budget, so a large library
 * of auto hooks can never crowd out the notes about the artifact this
 * conversation is working on or the notes this session wrote for itself.
 * Freshness is a gate applied to the selected candidates only (D6), retrieval
 * frequency is read nowhere (inv-no-popularity-or-telemetry-rank), and only
 * `about` links cue the first section (inv-about-links-only-cues).
 *
 * Nothing is dropped silently: every section states how many of its notes it
 * shows, the closing line states the omitted count as an instruction naming
 * the recall command first and the list command second (both crowded-library
 * evaluation runs ignored the informational form), and every withheld record
 * is counted with the command that reviews it. Slugs are the only handle
 * rendered (inv-slug-only-text-output).
 */

const logger = createLogger("memory.index");

/**
 * The quota sections of the block, in delivery order (R5, D4): notes
 * about-linked to the conversation's active artifacts, the session
 * incarnation's own notes, notes whose author said they always belong in the
 * index, and the remaining auto notes project-then-global.
 */
export type MemoryIndexSection = "about" | "session" | "always" | "auto";

const SECTIONS: readonly MemoryIndexSection[] = [
  "about",
  "session",
  "always",
  "auto",
];

/**
 * Each section's reserved share of the budget (R5.3). A reservation is a
 * floor, not a ceiling: the first pass fills every section up to its share in
 * delivery order, and the second pass hands whatever is left back to the
 * sections in the same order. So a linked note or a fresh session note is
 * never displaced by the auto tail, and an empty section's share is not
 * wasted on it.
 */
const SECTION_RESERVATION: Record<MemoryIndexSection, number> = {
  about: 0.35,
  session: 0.25,
  always: 0.15,
  auto: 0.25,
};

/** The exact drill-down commands the block names (R5, R12). */
const LIST_COMMAND = "cctl memory list";
const RECALL_COMMAND = "cctl memory recall '<topic>'";
const REVIEW_COMMAND = "cctl memory review";
const PROPOSED_COMMAND = "cctl memory list --lifecycle proposed";
const READ_HINT =
  "read: cctl memory get <slug> --scope <scope>; search: cctl memory recall '<query>'";
const FULL_INDEX_COMMAND = "cctl memory index --full";
/**
 * Every delta names the full-index command (R5, D4): a backend compaction
 * Command Center cannot observe leaves the conversation without its block,
 * and this hint is its one-call recovery on any turn.
 */
const DELTA_READ_HINT = `${READ_HINT}; full index: ${FULL_INDEX_COMMAND}`;
/** A quiet turn: one line, still naming the recovery command. */
const QUIET_DELTA_TEXT = `<memory-index-delta>no memory changes since your last turn — full index: ${FULL_INDEX_COMMAND}</memory-index-delta>`;

/** The conversation an index is composed for: what it sees and what it is working on. */
export interface MemoryIndexSubject {
  readonly conversation:
    | { readonly kind: "session"; readonly sessionName: string }
    | { readonly kind: "project" };
  /** The visible scope union (R3): global + project, plus the incarnation for a session. */
  readonly visibility: MemoryVisibility;
  /** The ticket, spec, or workflow execution the conversation is working on. */
  readonly activeArtifacts: readonly MemoryArtifactRef[];
  /**
   * `ambient` composes every section; `linked-only` composes the about section
   * alone and nothing from the ambient index (R10).
   */
  readonly delivery: "ambient" | "linked-only";
}

/** One note the block carries, with the revision that was rendered (the watermark input, R15). */
export interface MemoryIndexEntry {
  readonly memoryId: string;
  readonly revision: number;
  readonly slug: string;
  readonly scope: MemoryScope;
  readonly section: MemoryIndexSection;
  /** False when the note was delivered without its stale status line (R2). */
  readonly statusDelivered: boolean;
}

/** Counts of records that were candidates but withheld, by cause (R5). */
export interface MemoryIndexWithheld {
  readonly reviewDue: number;
  readonly expired: number;
  readonly proposed: number;
}

/**
 * What a delta is computed against (R5, R15, D4): where the conversation
 * stands in the delivery sequence and, per note, the revision and status
 * state its index last carried. The caller supplies the index channel's rows
 * (`MemoryIndexDeliveryRead`); any expanded-channel row is ignored here too,
 * because a recall pack the agent asked for is not part of the block.
 */
export interface MemoryIndexDeltaBasis {
  readonly state: Pick<
    MemoryIndexDeliveryState,
    "lastFullAt" | "lastDeliveryAt"
  >;
  readonly watermarks: readonly MemoryDeliveryWatermark[];
}

export interface MemoryIndexBlock {
  /** Whether this is the whole index or only what changed since the last delivery (D4). */
  readonly kind: MemoryIndexDeliveryKind;
  /** The rendered block, byte-exact with what the turn injects (R12.2, R13.1). */
  readonly text: string;
  readonly bytes: number;
  readonly budget: MemoryIndexBudget;
  readonly entries: readonly MemoryIndexEntry[];
  /**
   * Eligible hooks the full block's budget cannot carry, stated in the block
   * with the drill-down. A delta reports the same number computed now for
   * this conversation's index, not what the delta itself dropped: the agent
   * holds an older block, and this is how far that block falls short today.
   */
  readonly omitted: number;
  /** Eligible hooks in the whole index: for a full block, entries plus omitted. */
  readonly total: number;
  readonly withheld: MemoryIndexWithheld;
  /**
   * The delivery instant a delta is computed against — the same value its
   * `since:` line renders — and null for a full block, which is a delta since
   * nothing. Stated structurally so a surface labelling a delta reads it from
   * the block rather than parsing the text it is labelling.
   */
  readonly since: string | null;
}

export interface MemoryIndexComposerDeps {
  repo: MemoryRepo;
  /**
   * The one owner of staleness: the composer selects candidates and asks the
   * engine about those only, never comparing a lease or a token itself.
   */
  freshness: MemoryFreshnessEngine;
  now(): string;
}

export interface MemoryIndexComposer {
  /**
   * Compose the block from live rows. Null when the conversation has nothing to
   * be told — no eligible hook and nothing withheld — so a library that is
   * empty for this conversation costs its turns nothing.
   */
  compose(
    subject: MemoryIndexSubject,
    budget: MemoryIndexBudget,
  ): Promise<MemoryIndexBlock | null>;
  /**
   * Compose the delta a conversation that already holds a full block is due:
   * hooks created or revised since its index watermarks and status-line
   * transitions since then, never a hook omitted over budget on an earlier
   * turn (inv-delta-never-recarries). Always a block — a turn with nothing
   * changed is told so in one line.
   */
  composeDelta(
    subject: MemoryIndexSubject,
    budget: MemoryIndexBudget,
    basis: MemoryIndexDeltaBasis,
  ): Promise<MemoryIndexBlock>;
}

// ============================================================
// Section membership and order
// ============================================================

interface Candidate {
  readonly note: MemoryNote;
  readonly section: MemoryIndexSection;
  /** The status line ambient delivery carries: null when absent or withheld. */
  readonly statusNote: MemoryStatusNote | null;
  readonly lines: readonly string[];
  /** Rendered cost including the newline that joins it to the next line. */
  readonly bytes: number;
}

/** More specific scope first: what this session learned beats the project's rule. */
function scopeOrder(scope: MemoryScope): number {
  switch (scope) {
    case "session":
      return 3;
    case "project":
      return 2;
    case "global":
      return 1;
  }
}

/**
 * Order within a section: scope specificity, then an explicit `always` ahead
 * of `auto`, then the most recently written first, then the slug — a stable,
 * agent-visible tiebreak. Retrieval frequency appears nowhere here and there
 * is no counter for it to read (inv-no-popularity-or-telemetry-rank).
 */
function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    scopeOrder(right.note.scope) - scopeOrder(left.note.scope) ||
    Number(right.note.indexMode === "always") -
      Number(left.note.indexMode === "always") ||
    right.note.updatedAt.localeCompare(left.note.updatedAt) ||
    left.note.slug.localeCompare(right.note.slug)
  );
}

function sectionOf(note: MemoryNote, aboutLinked: boolean): MemoryIndexSection {
  if (aboutLinked) return "about";
  if (note.scope === "session") return "session";
  if (note.indexMode === "always") return "always";
  return "auto";
}

// ============================================================
// Rendering
// ============================================================

/**
 * The body-size marker (R5.6): a line without one is visibly the whole note,
 * and a marker prices the read before the agent spends a call on it. Bytes
 * under 1 KiB as `+NNNb`, otherwise KiB to one decimal as `+N.Nk`.
 */
function renderBodySizeMarker(body: string): string | null {
  const bytes = memoryBodyByteLength(body);
  if (bytes === 0) return null;
  return bytes < 1024 ? `+${bytes}b` : `+${(bytes / 1024).toFixed(1)}k`;
}

function renderEntryLines(
  note: MemoryNote,
  statusNote: MemoryStatusNote | null,
  now: string,
): string[] {
  const bracket = [note.scope, describeMemoryAge(note.updatedAt, now)];
  const marker = renderBodySizeMarker(note.body);
  if (marker !== null) bracket.push(marker);
  const lines = [`- ${note.slug} [${bracket.join(", ")}] ${note.hook}`];
  if (statusNote !== null) {
    lines.push(`  status: ${renderMemoryStatusLine(statusNote, now)}`);
  }
  return lines;
}

function renderHeadLines(subject: MemoryIndexSubject): string[] {
  const visibility =
    subject.conversation.kind === "session"
      ? `visibility: global + project + session ${subject.conversation.sessionName}`
      : "visibility: global + project";
  const lines = ["<memory-index>", visibility];
  if (subject.delivery === "linked-only") {
    lines.push(
      "delivery: linked-only (notes about-linked to the active artifacts)",
    );
  }
  return lines;
}

function renderSectionHeader(
  section: MemoryIndexSection,
  shown: number,
  count: number,
  artifacts: readonly MemoryArtifactRef[],
): string {
  const title =
    section === "about"
      ? `about ${artifacts.map(renderMemoryArtifactHandle).join(", ")}`
      : section;
  return `## ${title} (${shown} of ${count})`;
}

/**
 * The closing line. With hooks omitted it is an instruction, not a report
 * (R5.2, D4): an agent that does not know a lesson exists has no reason to
 * suspect the omission is about the thing it is getting wrong, so the line
 * tells it when to search and names recall before list.
 */
function renderShowingLine(
  shown: number,
  total: number,
  omitted: number,
  referent: "listed above" | "in your index" = "listed above",
): string {
  const counts = `showing ${shown} of ${total} hooks`;
  return omitted > 0
    ? `${counts} — ${omitted} omitted over budget. If this turn touches something not ${referent}, search first: ${RECALL_COMMAND} (full list: ${LIST_COMMAND})`
    : counts;
}

/**
 * The delta's statement of where the conversation's index stands: the full
 * block's closing line computed now, addressed to the block the conversation
 * holds rather than to the lines above it.
 */
function renderIndexCountsLine(shown: number, total: number): string {
  return `index: ${renderShowingLine(shown, total, total - shown, "in your index")}`;
}

function renderWithheldLine(withheld: MemoryIndexWithheld): string | null {
  const stale: string[] = [];
  if (withheld.reviewDue > 0) stale.push(`${withheld.reviewDue} review-due`);
  if (withheld.expired > 0) stale.push(`${withheld.expired} expired`);
  const parts: string[] = [];
  if (stale.length > 0) parts.push(`${stale.join(", ")} — ${REVIEW_COMMAND}`);
  if (withheld.proposed > 0) {
    parts.push(`${withheld.proposed} proposed — ${PROPOSED_COMMAND}`);
  }
  return parts.length === 0 ? null : `withheld: ${parts.join("; ")}`;
}

interface RenderInput {
  readonly subject: MemoryIndexSubject;
  readonly sections: Record<MemoryIndexSection, readonly Candidate[]>;
  readonly admitted: Record<MemoryIndexSection, readonly Candidate[]>;
  readonly total: number;
  readonly withheld: MemoryIndexWithheld;
}

function renderBlock(input: RenderInput): string {
  const lines = renderHeadLines(input.subject);
  let shown = 0;
  for (const section of SECTIONS) {
    const admitted = input.admitted[section];
    if (admitted.length === 0) continue;
    shown += admitted.length;
    lines.push(
      renderSectionHeader(
        section,
        admitted.length,
        input.sections[section].length,
        input.subject.activeArtifacts,
      ),
    );
    for (const candidate of admitted) lines.push(...candidate.lines);
  }
  lines.push(renderShowingLine(shown, input.total, input.total - shown));
  const withheldLine = renderWithheldLine(input.withheld);
  if (withheldLine !== null) lines.push(withheldLine);
  lines.push(READ_HINT, "</memory-index>");
  return lines.join("\n");
}

interface StatusTransition {
  readonly candidate: Candidate;
  readonly line: string;
  /** Rendered cost including the newline that joins it to the next line. */
  readonly bytes: number;
}

/** Where the conversation's index stands now, as the full block would state it. */
interface IndexCounts {
  readonly shown: number;
  readonly total: number;
  readonly withheld: MemoryIndexWithheld;
}

interface DeltaRenderInput {
  readonly since: string;
  readonly changed: readonly Candidate[];
  readonly transitions: readonly StatusTransition[];
  /** Entries and transitions eligible before the budget was applied. */
  readonly changes: number;
  readonly index: IndexCounts;
}

/**
 * The delta (R5, D4): what changed since the conversation's last delivery,
 * in the full block's ordering, then where its index stands today. The
 * withheld and omitted counts are the full block's own, so the agent learns
 * that its held block falls short of the library without being sent the
 * block again.
 */
function renderDeltaBlock(input: DeltaRenderInput): string {
  const lines = ["<memory-index-delta>", `since: ${input.since}`];
  if (input.changed.length > 0) {
    lines.push(`## new or revised (${input.changed.length})`);
    for (const candidate of input.changed) lines.push(...candidate.lines);
  }
  if (input.transitions.length > 0) {
    lines.push(`## status changes (${input.transitions.length})`);
    for (const transition of input.transitions) lines.push(transition.line);
  }
  const shown = input.changed.length + input.transitions.length;
  if (shown < input.changes) {
    lines.push(renderShowingLine(shown, input.changes, input.changes - shown));
  }
  lines.push(renderIndexCountsLine(input.index.shown, input.index.total));
  const withheldLine = renderWithheldLine(input.index.withheld);
  if (withheldLine !== null) lines.push(withheldLine);
  lines.push(DELTA_READ_HINT, "</memory-index-delta>");
  return lines.join("\n");
}

/** The delta's frame at its widest, as `frameBytes` reserves the full block's. */
function deltaFrameBytes(input: {
  readonly since: string;
  readonly hasChanged: boolean;
  readonly hasTransitions: boolean;
  readonly changes: number;
  readonly index: IndexCounts;
}): number {
  const lines = ["<memory-index-delta>", `since: ${input.since}`];
  if (input.hasChanged) lines.push(`## new or revised (${input.changes})`);
  if (input.hasTransitions) lines.push(`## status changes (${input.changes})`);
  lines.push(renderShowingLine(input.changes, input.changes, input.changes));
  const { total } = input.index;
  lines.push(
    `index: ${renderShowingLine(total, total, total, "in your index")}`,
  );
  const withheldLine = renderWithheldLine(input.index.withheld);
  if (withheldLine !== null) lines.push(withheldLine);
  lines.push(DELTA_READ_HINT, "</memory-index-delta>");
  return memoryBodyByteLength(lines.join("\n"));
}

// ============================================================
// Budget fill
// ============================================================

/**
 * The bytes the block spends before any entry: the head, one header per
 * section that has candidates, and the closing lines — each rendered with the
 * LARGEST numbers it could carry, because the reserve has to hold whatever the
 * fill decides. Over-reserving by a few digits costs at most one hook;
 * under-reserving would let the disclosure push the block over its cap.
 */
function frameBytes(
  subject: MemoryIndexSubject,
  sections: Record<MemoryIndexSection, readonly Candidate[]>,
  total: number,
  withheld: MemoryIndexWithheld,
): number {
  const lines = renderHeadLines(subject);
  for (const section of SECTIONS) {
    const count = sections[section].length;
    if (count === 0) continue;
    lines.push(
      renderSectionHeader(section, count, count, subject.activeArtifacts),
    );
  }
  // The instruction form with every count at the total's width is the widest
  // closing line the fill could produce; `shown` and `omitted` never both
  // reach it, so this over-reserves by a digit or two rather than under.
  lines.push(renderShowingLine(total, total, total));
  const withheldLine = renderWithheldLine(withheld);
  if (withheldLine !== null) lines.push(withheldLine);
  lines.push(READ_HINT, "</memory-index>");
  return memoryBodyByteLength(lines.join("\n"));
}

function emptyBySection<T>(): Record<MemoryIndexSection, T[]> {
  return { about: [], session: [], always: [], auto: [] };
}

/**
 * Two passes over the sections in delivery order. Each section is a strict
 * prefix of its own priority order — a candidate that does not fit stops its
 * section rather than being skipped for a smaller one below it, because a
 * lower-ranked note taking the room of a higher-ranked one would be a ranking
 * the block does not state.
 */
function fillSections(input: {
  readonly sections: Record<MemoryIndexSection, readonly Candidate[]>;
  readonly availableBytes: number;
  readonly hooks: number;
}): Record<MemoryIndexSection, Candidate[]> {
  const admitted = emptyBySection<Candidate>();
  const cursor: Record<MemoryIndexSection, number> = {
    about: 0,
    session: 0,
    always: 0,
    auto: 0,
  };
  let usedBytes = 0;
  let usedHooks = 0;

  const admit = (section: MemoryIndexSection, candidate: Candidate): void => {
    admitted[section].push(candidate);
    cursor[section] += 1;
    usedBytes += candidate.bytes;
    usedHooks += 1;
  };
  const fits = (candidate: Candidate): boolean =>
    usedBytes + candidate.bytes <= input.availableBytes &&
    usedHooks + 1 <= input.hooks;

  // Pass one: every section up to its reservation.
  for (const section of SECTIONS) {
    const reservedBytes = Math.floor(
      input.availableBytes * SECTION_RESERVATION[section],
    );
    const reservedHooks = Math.floor(
      input.hooks * SECTION_RESERVATION[section],
    );
    let sectionBytes = 0;
    let sectionHooks = 0;
    for (const candidate of input.sections[section]) {
      if (
        sectionBytes + candidate.bytes > reservedBytes ||
        sectionHooks + 1 > reservedHooks ||
        !fits(candidate)
      ) {
        break;
      }
      admit(section, candidate);
      sectionBytes += candidate.bytes;
      sectionHooks += 1;
    }
  }

  // Pass two: the leftover, back to the sections in the same order.
  for (const section of SECTIONS) {
    const candidates = input.sections[section];
    while (cursor[section] < candidates.length) {
      const candidate = candidates[cursor[section]];
      if (candidate === undefined || !fits(candidate)) break;
      admit(section, candidate);
    }
  }

  return admitted;
}

/** Drop the lowest-priority admitted entry: the last of the last non-empty section. */
function dropLast(admitted: Record<MemoryIndexSection, Candidate[]>): boolean {
  for (const section of [...SECTIONS].reverse()) {
    if (admitted[section].length > 0) {
      admitted[section].pop();
      return true;
    }
  }
  return false;
}

interface DeltaAdmitted {
  readonly changed: Candidate[];
  readonly transitions: StatusTransition[];
}

/**
 * A strict prefix of the delta in its rendered order — entries in the full
 * block's ordering, then transitions — within the same byte and hook budget
 * as the full block. A delta that does not fit states what it dropped with
 * the same instruction. A new hook dropped here has no watermark and falls
 * before the next delivery instant, so it stays out and is reached through
 * recall (inv-delta-never-recarries); a revised one keeps its older watermark
 * and remains owed by the revision rule.
 */
function fillDelta(input: {
  readonly changed: readonly Candidate[];
  readonly transitions: readonly StatusTransition[];
  readonly availableBytes: number;
  readonly hooks: number;
}): DeltaAdmitted {
  const admitted: DeltaAdmitted = { changed: [], transitions: [] };
  let usedBytes = 0;
  let usedHooks = 0;
  const fits = (bytes: number): boolean =>
    usedBytes + bytes <= input.availableBytes && usedHooks + 1 <= input.hooks;
  for (const candidate of input.changed) {
    if (!fits(candidate.bytes)) return admitted;
    admitted.changed.push(candidate);
    usedBytes += candidate.bytes;
    usedHooks += 1;
  }
  for (const transition of input.transitions) {
    if (!fits(transition.bytes)) return admitted;
    admitted.transitions.push(transition);
    usedBytes += transition.bytes;
    usedHooks += 1;
  }
  return admitted;
}

/** Drop the last rendered delta line: a transition before an entry. */
function dropLastDelta(admitted: DeltaAdmitted): boolean {
  if (admitted.transitions.pop() !== undefined) return true;
  return admitted.changed.pop() !== undefined;
}

// ============================================================
// Candidate selection (shared by the full block and the delta)
// ============================================================

/**
 * Everything a block is composed from, before any budget is applied: the
 * eligible candidates by section (active, not search-only, freshness-gated),
 * the counts of what was withheld and why, and the clock the lines were
 * rendered against. The full block fills this within the budget; the delta
 * narrows it by the conversation's watermarks. One selection, so a note the
 * full block would withhold can never surface in a delta.
 */
interface CandidateSet {
  readonly visible: number;
  readonly sections: Record<MemoryIndexSection, Candidate[]>;
  readonly assessments: Map<string, MemoryFreshnessAssessment>;
  readonly withheld: MemoryIndexWithheld;
  readonly total: number;
  readonly now: string;
}

function toEntry(candidate: Candidate): MemoryIndexEntry {
  return {
    memoryId: candidate.note.id,
    revision: candidate.note.revision,
    slug: candidate.note.slug,
    scope: candidate.note.scope,
    section: candidate.section,
    statusDelivered: candidate.statusNote !== null,
  };
}

/**
 * A status line delivered now but not when the note was last carried, or the
 * reverse (R5, R15). Restored repeats the claim with its age, because the
 * conversation's copy of the block lacks it; withheld names only the cause,
 * because the claim is exactly what must not be repeated.
 */
function toStatusTransition(
  candidate: Candidate,
  assessment: MemoryFreshnessAssessment | undefined,
  now: string,
): StatusTransition {
  let line: string;
  if (candidate.statusNote !== null) {
    line = `- ${candidate.note.slug}: status restored: ${renderMemoryStatusLine(candidate.statusNote, now)}`;
  } else {
    // A candidate's line is withheld by its own lease alone — expiry and the
    // note's lease withhold the whole note, which never reaches a delta — but
    // the cause is read from the assessment rather than assumed, so the line
    // stays true if the engine grows a status-level expiry.
    const cause = assessment?.expired === true ? "expired" : "review due";
    line = `- ${candidate.note.slug}: status line withheld (${cause})`;
  }
  return { candidate, line, bytes: memoryBodyByteLength(line) + 1 };
}

interface FullLayout {
  readonly admitted: Record<MemoryIndexSection, Candidate[]>;
  readonly shown: number;
  readonly text: string;
  readonly bytes: number;
}

/**
 * Fill and render the full block within its budget. The frame is reserved at
 * its widest, so this normally renders under the cap on the first try; the
 * loop is the guarantee rather than the expectation, and it stops at the bare
 * frame. The delta runs this too and keeps only the counts, so what it states
 * about the held index is exactly what a full block would state now.
 */
function layoutFullBlock(
  subject: MemoryIndexSubject,
  selected: CandidateSet,
  budget: MemoryIndexBudget,
): FullLayout {
  const { sections, withheld, total } = selected;
  const availableBytes =
    budget.bytes - frameBytes(subject, sections, total, withheld);
  const admitted = fillSections({
    sections,
    availableBytes: Math.max(0, availableBytes),
    hooks: budget.hooks,
  });
  let text = renderBlock({ subject, sections, admitted, total, withheld });
  let bytes = memoryBodyByteLength(text);
  while (bytes > budget.bytes && dropLast(admitted)) {
    text = renderBlock({ subject, sections, admitted, total, withheld });
    bytes = memoryBodyByteLength(text);
  }
  if (bytes > budget.bytes) {
    logger.warn("memory.index.frame_over_budget", {
      kind: "full",
      bytes,
      budgetBytes: budget.bytes,
    });
  }
  const shown = SECTIONS.reduce(
    (sum, section) => sum + admitted[section].length,
    0,
  );
  return { admitted, shown, text, bytes };
}

// ============================================================
// Composer
// ============================================================

export function createMemoryIndexComposer(
  deps: MemoryIndexComposerDeps,
): MemoryIndexComposer {
  /**
   * The ids about-linked to any active artifact. Only `about` is a relevance
   * cue: a `source` link to the very same artifact grants nothing
   * (inv-about-links-only-cues).
   */
  async function aboutLinkedIds(
    artifacts: readonly MemoryArtifactRef[],
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const artifact of artifacts) {
      for (const link of await deps.repo.listLinksForArtifact(artifact)) {
        if (link.kind === "about") ids.add(link.memoryId);
      }
    }
    return ids;
  }

  async function selectCandidates(
    subject: MemoryIndexSubject,
  ): Promise<CandidateSet> {
    // Archived records are out of every default read (R4): they are not
    // withheld from the index, they are outside the library it indexes.
    const visible = await deps.repo.list({
      visibility: subject.visibility,
      includeArchived: false,
    });
    const cued = await aboutLinkedIds(subject.activeArtifacts);
    const candidates =
      subject.delivery === "linked-only"
        ? visible.filter((note) => cued.has(note.id))
        : visible;

    let proposed = 0;
    const indexable: MemoryNote[] = [];
    for (const note of candidates) {
      // An unapproved global proposal primes no conversation (R9).
      if (note.lifecycle === "proposed") {
        proposed += 1;
        continue;
      }
      if (note.lifecycle !== "active") continue;
      // The author's own statement that this record is for search, not for
      // the index; it is not withheld, it was never a candidate.
      if (note.indexMode === "search-only") continue;
      indexable.push(note);
    }

    // Freshness is checked for the selected candidates only (D6), and the
    // engine decides both levels: a withheld note leaves the block, a stale
    // status line leaves its note (R2).
    const assessments = await deps.freshness.check(indexable);
    const now = deps.now();
    let reviewDue = 0;
    let expired = 0;
    const sections = emptyBySection<Candidate>();
    for (const note of indexable) {
      const assessment = assessments.get(note.id);
      if (assessment?.ambient === "withhold") {
        if (assessment.expired) expired += 1;
        else reviewDue += 1;
        continue;
      }
      const statusNote = assessment?.statusNote ?? null;
      const lines = renderEntryLines(note, statusNote, now);
      const section = sectionOf(note, cued.has(note.id));
      sections[section].push({
        note,
        section,
        statusNote,
        lines,
        bytes: memoryBodyByteLength(lines.join("\n")) + 1,
      });
    }
    for (const section of SECTIONS) sections[section].sort(compareCandidates);

    return {
      visible: visible.length,
      sections,
      assessments,
      withheld: { reviewDue, expired, proposed },
      total: SECTIONS.reduce(
        (sum, section) => sum + sections[section].length,
        0,
      ),
      now,
    };
  }

  return {
    async compose(subject, budget) {
      const startedAt = performance.now();
      const parsedBudget = memoryIndexBudgetSchema.parse(budget);
      const selected = await selectCandidates(subject);
      const { withheld, total } = selected;
      if (
        total === 0 &&
        withheld.reviewDue + withheld.expired + withheld.proposed === 0
      ) {
        logger.debug("memory.index.empty", {
          conversation: subject.conversation.kind,
          delivery: subject.delivery,
          durationMs: performance.now() - startedAt,
        });
        return null;
      }

      const layout = layoutFullBlock(subject, selected, parsedBudget);
      const entries = SECTIONS.flatMap((section) =>
        layout.admitted[section].map(toEntry),
      );
      const block: MemoryIndexBlock = {
        kind: "full",
        text: layout.text,
        bytes: layout.bytes,
        budget: parsedBudget,
        entries,
        omitted: total - entries.length,
        total,
        withheld,
        since: null,
      };
      logger.debug("memory.index.composed", {
        kind: "full",
        conversation: subject.conversation.kind,
        delivery: subject.delivery,
        visible: selected.visible,
        total,
        entries: entries.length,
        omitted: block.omitted,
        withheldReviewDue: withheld.reviewDue,
        withheldExpired: withheld.expired,
        withheldProposed: withheld.proposed,
        bytes: block.bytes,
        budgetBytes: parsedBudget.bytes,
        budgetHooks: parsedBudget.hooks,
        durationMs: performance.now() - startedAt,
      });
      return block;
    },

    async composeDelta(subject, budget, basis) {
      const startedAt = performance.now();
      const parsedBudget = memoryIndexBudgetSchema.parse(budget);
      const selected = await selectCandidates(subject);
      // The counts the delta states are the full block's, computed now for
      // this conversation; its text is discarded.
      const index: IndexCounts = {
        shown: layoutFullBlock(subject, selected, parsedBudget).shown,
        total: selected.total,
        withheld: selected.withheld,
      };

      // The index channel only: a recall pack the agent expanded is not part
      // of the block, and letting it stand in for one would hide a hook the
      // ambient block never carried.
      const seen = new Map<string, MemoryDeliveryWatermark>();
      for (const row of basis.watermarks) {
        if (row.channel === "index") seen.set(row.memoryId, row);
      }
      const sinceMs = Date.parse(basis.state.lastDeliveryAt);

      /**
       * The two watermark rules (R5, D4). A watermarked note is carried on a
       * newer revision alone, whatever its updatedAt says against the
       * delivery instant — the recorded state is what the block carried, and
       * a revision it did not carry is owed. An unwatermarked note is carried
       * only if written at or after the last delivery: one older than that
       * was omitted over budget on an earlier block, and a delta never
       * re-carries it (inv-delta-never-recarries).
       */
      const isDeltaEntry = (note: MemoryNote): boolean => {
        const watermark = seen.get(note.id);
        if (watermark !== undefined) return watermark.revision < note.revision;
        const updatedMs = Date.parse(note.updatedAt);
        return Number.isNaN(sinceMs) || updatedMs >= sinceMs;
      };

      const changed = SECTIONS.flatMap((section) =>
        selected.sections[section].filter((candidate) =>
          isDeltaEntry(candidate.note),
        ),
      );
      const changedIds = new Set(changed.map((candidate) => candidate.note.id));

      // A note the delta carries anyway is not also a transition: its entry
      // renders the current status line as the full block would, so a
      // transition line would say the same thing twice.
      const transitions: StatusTransition[] = [];
      for (const section of SECTIONS) {
        for (const candidate of selected.sections[section]) {
          if (changedIds.has(candidate.note.id)) continue;
          const watermark = seen.get(candidate.note.id);
          if (watermark === undefined) continue;
          if ((candidate.statusNote !== null) === watermark.statusDelivered) {
            continue;
          }
          transitions.push(
            toStatusTransition(
              candidate,
              selected.assessments.get(candidate.note.id),
              selected.now,
            ),
          );
        }
      }

      const changes = changed.length + transitions.length;
      const omitted = index.total - index.shown;
      if (changes === 0) {
        logger.debug("memory.index.composed", {
          kind: "delta",
          conversation: subject.conversation.kind,
          delivery: subject.delivery,
          visible: selected.visible,
          total: index.total,
          entries: 0,
          omitted,
          durationMs: performance.now() - startedAt,
        });
        return {
          kind: "delta",
          text: QUIET_DELTA_TEXT,
          bytes: memoryBodyByteLength(QUIET_DELTA_TEXT),
          budget: parsedBudget,
          entries: [],
          omitted,
          total: index.total,
          withheld: index.withheld,
          since: basis.state.lastDeliveryAt,
        };
      }

      const since = basis.state.lastDeliveryAt;
      const availableBytes =
        parsedBudget.bytes -
        deltaFrameBytes({
          since,
          hasChanged: changed.length > 0,
          hasTransitions: transitions.length > 0,
          changes,
          index,
        });
      const admitted = fillDelta({
        changed,
        transitions,
        availableBytes: Math.max(0, availableBytes),
        hooks: parsedBudget.hooks,
      });
      const render = (): string =>
        renderDeltaBlock({ since, ...admitted, changes, index });
      let text = render();
      let bytes = memoryBodyByteLength(text);
      while (bytes > parsedBudget.bytes && dropLastDelta(admitted)) {
        text = render();
        bytes = memoryBodyByteLength(text);
      }
      if (bytes > parsedBudget.bytes) {
        logger.warn("memory.index.frame_over_budget", {
          kind: "delta",
          bytes,
          budgetBytes: parsedBudget.bytes,
        });
      }

      const entries = [
        ...admitted.changed.map(toEntry),
        ...admitted.transitions.map((transition) =>
          toEntry(transition.candidate),
        ),
      ];
      logger.debug("memory.index.composed", {
        kind: "delta",
        conversation: subject.conversation.kind,
        delivery: subject.delivery,
        visible: selected.visible,
        total: index.total,
        changes,
        entries: entries.length,
        omitted,
        withheldReviewDue: index.withheld.reviewDue,
        withheldExpired: index.withheld.expired,
        withheldProposed: index.withheld.proposed,
        bytes,
        budgetBytes: parsedBudget.bytes,
        budgetHooks: parsedBudget.hooks,
        durationMs: performance.now() - startedAt,
      });
      return {
        kind: "delta",
        text,
        bytes,
        budget: parsedBudget,
        entries,
        omitted,
        total: index.total,
        withheld: index.withheld,
        since,
      };
    },
  };
}
