"use client";

import { useMemo, useState } from "react";

import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import { listNativeMemoryExceptions } from "@/lib/agent-backends/native-memory";
import { describeMemoryAge } from "@/lib/memory/age";
import {
  useMemoryNotesQuery,
  useMemoryReviewQueueQuery,
  useSessionPromotionCandidatesQuery,
} from "@/lib/memory/queries";
import type { MemoryScopeRef } from "@/lib/memory/query-keys";
import type {
  MemoryLifecycle,
  MemoryNote,
  MemoryReviewQueueEntry,
  MemoryScope,
} from "@/lib/memory/schemas";

import MemoryIndexPreview from "./MemoryIndexPreview";
import MemoryNoteDetail from "./MemoryNoteDetail";

export interface MemoryLibraryPanelProps {
  projectName: string;
  sessionName: string;
  /** The conversation in view — the Index Preview's default subject. */
  conversationId: string;
  /** Queries are gated on the Memory tab being the active right-pane tab. */
  active: boolean;
}

/** Browse and repair the library, or read a conversation's composed block. */
type MemoryPanelView = "library" | "index";

/**
 * The Memory Library: the human repair surface for the notes every agent is
 * silently primed with. Browse what this session can see, open a note to fix
 * it under compare-and-swap (spec R12).
 *
 * Freshness and promotion candidacy are never re-derived here — both come from
 * the freshness engine's own review queue, so a badge cannot disagree with the
 * list it opens.
 */
export default function MemoryLibraryPanel({
  projectName,
  sessionName,
  conversationId,
  active,
}: MemoryLibraryPanelProps): React.JSX.Element {
  const [view, setView] = useState<MemoryPanelView>("library");
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);

  const ref = useMemo<MemoryScopeRef>(
    () => ({ projectName, sessionName }),
    [projectName, sessionName],
  );

  return (
    <div className={PANEL_CLASS} data-testid="memory-library-panel">
      <div className="flex shrink-0 items-center gap-sm border-0 border-b border-solid border-border-subtle px-[12px] py-[8px]">
        <span className="font-mono text-[0.72rem] font-semibold tracking-[0.05em] text-text-secondary uppercase">
          Memory
        </span>
        <SegmentedControl
          value={view}
          onValueChange={(value) => {
            if (isPanelView(value)) setView(value);
          }}
          aria-label="Memory view"
          layoutClassName="ml-auto"
        >
          <SegmentedControlItem value="library">library</SegmentedControlItem>
          <SegmentedControlItem value="index">index</SegmentedControlItem>
        </SegmentedControl>
      </div>

      <NativeMemoryDisclosure />

      {view === "index" ? (
        <MemoryIndexPreview
          scopeRef={ref}
          conversationId={conversationId}
          active={active}
        />
      ) : openNoteId !== null ? (
        <MemoryNoteDetail
          key={openNoteId}
          scopeRef={ref}
          memoryId={openNoteId}
          onClose={() => setOpenNoteId(null)}
          onOpenNote={setOpenNoteId}
        />
      ) : (
        <MemoryBrowseView
          scopeRef={ref}
          active={active}
          onOpenNote={setOpenNoteId}
        />
      )}
    </div>
  );
}

function isPanelView(value: string): value is MemoryPanelView {
  return value === "library" || value === "index";
}

/**
 * The standing disclosure for a backend Command Center could not neutralize
 * (spec R14). This library only replaces the provider's own memory where a
 * disable mechanism exists; where none does, the operator is reading a Library
 * that is not the whole story, and has to be told so without going looking.
 *
 * It sits above the view switch rather than inside either view because it is a
 * property of the system, not of a note list or of one conversation's block —
 * and deliberately OUTSIDE the Index Preview's `<pre>`, which relays the
 * composed block verbatim and must keep matching it byte for byte.
 *
 * Derived from the registered declarations, so it renders nothing at all once
 * every backend declares a mechanism: a notice that fires for a neutralized
 * backend would train the eye to skip the one that matters.
 */
function NativeMemoryDisclosure(): React.JSX.Element | null {
  const { data: backends } = useBackendCatalogQuery();
  const exceptions = listNativeMemoryExceptions(backends);
  if (exceptions.length === 0) return null;
  return (
    <div
      data-testid="native-memory-disclosure"
      className="shrink-0 border-0 border-b border-solid border-border-subtle bg-amber-glow px-[12px] py-[8px] font-mono text-[0.72rem] text-amber"
    >
      {exceptions.map((exception) => (
        <p key={exception.backend} className="m-0">
          {exception.label} still runs its own native memory beside this
          library: {exception.reason}.
        </p>
      ))}
    </div>
  );
}

const PANEL_CLASS =
  "flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface";

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

/** What the list is narrowed to. `review` and `candidates` read the queue. */
type MemoryStatusFilter = "active" | "review" | "proposed" | "archived";
type ScopeFilter = "all" | MemoryScope;

interface MemoryBrowseViewProps {
  scopeRef: MemoryScopeRef;
  active: boolean;
  onOpenNote(memoryId: string): void;
}

function MemoryBrowseView({
  scopeRef,
  active,
  onOpenNote,
}: MemoryBrowseViewProps): React.JSX.Element {
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [status, setStatus] = useState<MemoryStatusFilter>("active");
  const [candidatesOnly, setCandidatesOnly] = useState(false);
  const [search, setSearch] = useState("");

  /**
   * The badge is a navigation, not one more filter. Whatever narrowing is in
   * force — a scope chosen earlier, a search still in the box — would otherwise
   * be intersected with the candidates and could hide every one of them, so
   * opening the queue clears both and moves the status control to the review
   * view it actually lands on.
   */
  function openPromotionQueue(): void {
    setScopeFilter("all");
    setSearch("");
    setStatus("review");
    setCandidatesOnly(true);
  }

  const listFilters = useMemo(
    () => ({
      ...(scopeFilter === "all" ? {} : { scope: scopeFilter }),
      lifecycle: LIFECYCLE_OF_STATUS[status],
      includeArchived: status === "archived",
    }),
    [scopeFilter, status],
  );

  // The list is the row source for every status but `review`, which reads the
  // freshness engine's queue: staleness is the engine's judgement, and a
  // second scan here would be free to disagree with the one delivery uses.
  const listQuery = useMemoryNotesQuery(scopeRef, listFilters, {
    enabled: active && !candidatesOnly && status !== "review",
  });
  const reviewQuery = useMemoryReviewQueueQuery(
    scopeRef,
    { promotionCandidates: false, session: null },
    { enabled: active },
  );

  /**
   * The candidate contract (spec R11), through its single client binding — the
   * same one the session-completion count uses, so the two surfaces cannot
   * build different keys for the same question. The badge's number is this
   * query's length by construction, so it can never promise rows the queue then
   * fails to show, and candidacy is derived server-side from whether the
   * incarnation is over rather than from a flag kept in sync here.
   */
  const candidatesQuery = useSessionPromotionCandidatesQuery(
    scopeRef.projectName,
    scopeRef.sessionName ?? "",
    { enabled: active && scopeRef.sessionName !== null },
  );
  const candidates = useMemo(
    () => candidatesQuery.data ?? [],
    [candidatesQuery.data],
  );

  const freshnessByNoteId = useMemo(() => {
    const map = new Map<string, MemoryReviewQueueEntry>();
    for (const entry of reviewQuery.data ?? []) map.set(entry.note.id, entry);
    for (const entry of candidates) {
      const existing = map.get(entry.note.id);
      map.set(
        entry.note.id,
        existing === undefined
          ? entry
          : { ...existing, promotionCandidate: true },
      );
    }
    return map;
  }, [reviewQuery.data, candidates]);

  const rows = useMemo(() => {
    // The queue is a second row source with its own reach: an unpromoted
    // candidate is work owed like a stale claim, so the review view shows both
    // and the badge's rows can never be missing from the list it opens.
    const fromQueue = candidatesOnly || status === "review";
    const queued = candidatesOnly
      ? candidates
      : [...(reviewQuery.data ?? []), ...candidates];
    const source = fromQueue
      ? dedupeNotesById(queued.map((entry) => entry.note))
      : (listQuery.data ?? []);
    // The list read is narrowed server-side by `listFilters`; the queue is not,
    // so the scope the human chose is applied to every queue-sourced view here
    // rather than being silently dropped.
    const scoped =
      fromQueue && scopeFilter !== "all"
        ? source.filter((note) => note.scope === scopeFilter)
        : source;
    const needle = search.trim().toLowerCase();
    if (needle === "") return scoped;
    return scoped.filter(
      (note) =>
        note.hook.toLowerCase().includes(needle) ||
        note.slug.toLowerCase().includes(needle) ||
        note.body.toLowerCase().includes(needle),
    );
  }, [
    candidatesOnly,
    candidates,
    status,
    scopeFilter,
    reviewQuery.data,
    listQuery.data,
    search,
  ]);

  const loading = candidatesOnly
    ? candidatesQuery.isLoading
    : status === "review"
      ? reviewQuery.isLoading
      : listQuery.isLoading;
  const failed = candidatesOnly
    ? candidatesQuery.isError
    : status === "review"
      ? reviewQuery.isError
      : listQuery.isError;

  const now = new Date().toISOString();

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-sm border-0 border-b border-solid border-border-subtle px-[12px] py-[8px]">
        <SegmentedControl
          value={scopeFilter}
          onValueChange={(value) => {
            if (isScopeFilter(value)) setScopeFilter(value);
          }}
          aria-label="Filter by scope"
        >
          <SegmentedControlItem value="all">all</SegmentedControlItem>
          <SegmentedControlItem value="global">global</SegmentedControlItem>
          <SegmentedControlItem value="project">project</SegmentedControlItem>
          <SegmentedControlItem value="session">session</SegmentedControlItem>
        </SegmentedControl>
        <SegmentedControl
          value={status}
          onValueChange={(value) => {
            if (isStatusFilter(value)) {
              setStatus(value);
              setCandidatesOnly(false);
            }
          }}
          aria-label="Filter by status"
        >
          <SegmentedControlItem value="active">active</SegmentedControlItem>
          <SegmentedControlItem value="review">review</SegmentedControlItem>
          <SegmentedControlItem value="proposed">proposed</SegmentedControlItem>
          <SegmentedControlItem value="archived">archived</SegmentedControlItem>
        </SegmentedControl>
        <input
          type="search"
          aria-label="Search memory notes"
          placeholder="Search hooks"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-0 flex-1 rounded-sm border border-solid border-border-default bg-bg-base px-[8px] py-[4px] font-mono text-[0.75rem] text-text-primary placeholder:text-text-tertiary focus:border-cyan-dim focus:[outline:none]"
        />
        {candidates.length > 0 ? (
          <StatusChip
            as="button"
            tone="violet"
            onClick={openPromotionQueue}
            aria-pressed={candidatesOnly}
          >
            {candidates.length} promotion{" "}
            {candidates.length === 1 ? "candidate" : "candidates"}
          </StatusChip>
        ) : null}
      </div>

      {loading ? (
        <EmptyState layoutClassName="min-h-0 flex-1">
          <EmptyStateTitle>Loading memory…</EmptyStateTitle>
        </EmptyState>
      ) : failed ? (
        <EmptyState layoutClassName="min-h-0 flex-1">
          <EmptyStateTitle>Could not load memory</EmptyStateTitle>
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState layoutClassName="min-h-0 flex-1">
          <EmptyStateTitle>Nothing here</EmptyStateTitle>
          <EmptyStateDesc>
            Notes captured by agents and by you appear here, and the Index
            Preview shows exactly which of them a conversation is told.
          </EmptyStateDesc>
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-sm">
          {rows.map((note) => (
            <MemoryRow
              key={note.id}
              note={note}
              freshness={freshnessByNoteId.get(note.id) ?? null}
              now={now}
              onOpen={() => onOpenNote(note.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** First occurrence wins: the review entry a note already has keeps its place. */
function dedupeNotesById(notes: readonly MemoryNote[]): MemoryNote[] {
  const seen = new Set<string>();
  const unique: MemoryNote[] = [];
  for (const note of notes) {
    if (seen.has(note.id)) continue;
    seen.add(note.id);
    unique.push(note);
  }
  return unique;
}

const LIFECYCLE_OF_STATUS: Record<
  MemoryStatusFilter,
  MemoryLifecycle | undefined
> = {
  active: "active",
  // The review list comes from the queue, so its list filters are never sent.
  review: undefined,
  proposed: "proposed",
  archived: "archived",
};

function isScopeFilter(value: string): value is ScopeFilter {
  return (
    value === "all" ||
    value === "global" ||
    value === "project" ||
    value === "session"
  );
}

function isStatusFilter(value: string): value is MemoryStatusFilter {
  return (
    value === "active" ||
    value === "review" ||
    value === "proposed" ||
    value === "archived"
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const SCOPE_TONE = {
  global: "violet",
  project: "cyan",
  session: "neutral",
} as const;

interface MemoryRowProps {
  note: MemoryNote;
  /** The engine's verdict for this note, when it holds one. */
  freshness: MemoryReviewQueueEntry | null;
  now: string;
  onOpen(): void;
}

function MemoryRow({
  note,
  freshness,
  now,
  onOpen,
}: MemoryRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={`memory-row-${note.id}`}
      // The hook is the note's whole claim, so it is the row's name: an
      // internal id must never appear on an agent-facing surface, and it has
      // no place on this one either.
      aria-label={`Open memory note ${note.hook}`}
      onClick={onOpen}
      className={cn(
        "flex w-full min-w-0 cursor-pointer flex-col items-start gap-[4px] border-0 border-b border-solid border-border-subtle bg-transparent px-[12px] py-[8px] text-left transition-colors duration-150 ease-[ease] hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]",
        note.lifecycle === "archived" && "opacity-55",
      )}
    >
      <span className="w-full font-mono text-[0.78rem] leading-[1.35] font-medium [overflow-wrap:anywhere] text-text-primary">
        {note.hook}
      </span>
      <span className="flex flex-wrap items-center gap-[4px]">
        <StatusChip tone={SCOPE_TONE[note.scope]}>{note.scope}</StatusChip>
        <StatusChip tone="neutral">{note.kind}</StatusChip>
        {note.lifecycle === "active" ? null : (
          <StatusChip
            tone={note.lifecycle === "proposed" ? "amber" : "neutral"}
          >
            {note.lifecycle}
          </StatusChip>
        )}
        {freshness?.expired ? (
          <StatusChip tone="red">expired</StatusChip>
        ) : null}
        {freshness !== null &&
        !freshness.expired &&
        (freshness.noteReviewDue || freshness.statusReviewDue) ? (
          <StatusChip tone="amber">review due</StatusChip>
        ) : null}
        {freshness?.promotionCandidate ? (
          <StatusChip tone="violet">promotion candidate</StatusChip>
        ) : null}
        <StatusChip tone="neutral">{note.createdBy}</StatusChip>
        <span className="font-mono text-[0.68rem] text-text-tertiary">
          {describeMemoryAge(note.updatedAt, now)}
        </span>
      </span>
    </button>
  );
}
