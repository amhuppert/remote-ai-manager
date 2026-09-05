"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClientLogger } from "@/lib/logging/client-logger";
import { useMemoryNavigation } from "./use-memory-navigation";

import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { Button, type ButtonProps } from "@/components/ui/Button";
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
  projectName: string | null;
  sessionName: string | null;
  /** The conversation in view — the Index Preview's default subject. */
  conversationId: string | null;
  layout?: "compact" | "page";
  previewSessionName?: string | null;
  initialView?: MemoryPanelView;
  initialQueue?: MemoryQueue;
  initialNoteId?: string | null;
  initialNoteScope?: MemoryScopeRef;
  onDirtyChange?(dirty: boolean): void;
  onLocationChange?(values: Record<string, string | null>): void;
  /** Queries are gated on the Memory tab being the active right-pane tab. */
  active: boolean;
}

/** Browse and repair the library, or read a conversation's composed block. */
export type MemoryPanelView = "library" | "index";

/**
 * The Memory Library: the human repair surface for the notes every agent is
 * silently primed with. Browse what this session can see, open a note to fix
 * it under compare-and-swap (spec R12).
 *
 * Freshness and promotion candidacy are never re-derived here — both come from
 * the freshness engine's own review queue, so a badge cannot disagree with the
 * list it opens.
 */
const logger = createClientLogger("memory-library");

export default function MemoryLibraryPanel({
  projectName,
  sessionName,
  conversationId,
  active,
  layout = "compact",
  initialView = "library",
  initialQueue = "active",
  initialNoteId = null,
  initialNoteScope,
  onDirtyChange,
  onLocationChange,
  previewSessionName,
}: MemoryLibraryPanelProps): React.JSX.Element {
  const [queue, setQueue] = useState(initialQueue);
  const [view, setView] = useState<MemoryPanelView>(initialView);
  const [openNoteId, setOpenNoteId] = useState<string | null>(initialNoteId);
  const ref = useMemo<MemoryScopeRef>(
    () => ({ projectName, sessionName }),
    [projectName, sessionName],
  );
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (openNoteId === null) returnFocus.current?.focus();
  }, [openNoteId]);
  const [noteScope, setNoteScope] = useState(initialNoteScope ?? ref);
  const navigation = useMemoryNavigation();
  const setNavigationDirty = navigation.setDirty;
  const setDirty = useCallback(
    (dirty: boolean) => {
      setNavigationDirty(dirty);
      onDirtyChange?.(dirty);
    },
    [setNavigationDirty, onDirtyChange],
  );
  function openNote(id: string | null, note?: MemoryNote): void {
    navigation.navigate(() => {
      if (
        id !== null &&
        openNoteId === null &&
        document.activeElement instanceof HTMLElement
      )
        returnFocus.current = document.activeElement;
      const scope =
        note?.scope === "session" && note.sessionCreatedAt !== null
          ? {
              projectName,
              sessionName: note.sessionName,
              incarnation: note.sessionCreatedAt,
            }
          : note === undefined
            ? noteScope
            : ref;
      setDirty(false);
      setOpenNoteId(id);
      setNoteScope(scope);
      logger.info("memory.library.note_selected", {
        memoryId: id,
        projectName,
      });
      onLocationChange?.({
        note: id,
        session: scope.sessionName,
        incarnation: scope.incarnation ?? null,
      });
    });
  }
  const expandedHref = new URLSearchParams();
  if (projectName !== null) expandedHref.set("project", projectName);
  if (sessionName !== null) expandedHref.set("previewSession", sessionName);
  if (conversationId !== null) expandedHref.set("conversation", conversationId);
  if (openNoteId !== null) {
    expandedHref.set("note", openNoteId);
    if (noteScope.sessionName !== null)
      expandedHref.set("session", noteScope.sessionName);
    if (noteScope.incarnation !== undefined)
      expandedHref.set("incarnation", noteScope.incarnation);
  }
  expandedHref.set("view", view);
  expandedHref.set("queue", queue);
  return (
    <div className={PANEL_CLASS} data-testid="memory-library-panel">
      <div className="flex shrink-0 flex-wrap items-center gap-sm border-0 border-b border-solid border-border-subtle px-md py-sm">
        <span className="font-mono text-[0.72rem] font-semibold tracking-[0.05em] text-text-secondary uppercase">
          Memory
        </span>
        {layout === "compact" ? (
          <Link
            href={`/memory?${expandedHref}`}
            onClick={(event) => {
              event.preventDefault();
              navigation.navigate(() => {
                window.location.assign(`/memory?${expandedHref}`);
              });
            }}
            className="inline-flex items-center max-768:min-h-[44px] font-mono text-[0.7rem] text-text-primary underline focus-visible:outline-2 focus-visible:outline-cyan"
          >
            Open memory screen
          </Link>
        ) : null}
        <SegmentedControl
          value={view}
          onValueChange={(value) => {
            if (isPanelView(value))
              navigation.navigate(() => {
                setDirty(false);
                setView(value);
                onLocationChange?.({ view: value });
              });
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
          scopeRef={
            layout === "page"
              ? { ...ref, sessionName: previewSessionName ?? sessionName }
              : ref
          }
          conversationId={conversationId}
          active={active}
          layout={layout}
          onSubjectChange={(id, session) =>
            onLocationChange?.({ conversation: id, previewSession: session })
          }
        />
      ) : null}
      <div
        hidden={view === "index"}
        className={cn(
          "min-h-0 flex-1",
          view === "index" ? "hidden" : "flex",
          layout === "page" && "max-1180:flex-col",
        )}
      >
        <div
          className={cn(
            "min-h-0 min-w-0 flex-col",
            openNoteId !== null
              ? layout === "page"
                ? "flex w-2/5 max-1180:hidden"
                : "hidden"
              : "flex flex-1",
          )}
        >
          <MemoryBrowseView
            scopeRef={ref}
            active={active && view === "library"}
            onOpenNote={openNote}
            page={layout === "page"}
            initialQueue={initialQueue}
            onQueueChange={(queue) => {
              setQueue(queue);
              onLocationChange?.({ queue });
            }}
            selectedId={openNoteId}
          />
        </div>
        {view === "library" && openNoteId !== null ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col border-0 border-l border-solid border-border-subtle max-1180:border-l-0">
            <MemoryNoteDetail
              key={openNoteId}
              scopeRef={noteScope}
              memoryId={openNoteId}
              onClose={() => openNote(null)}
              onOpenNote={(id) => openNote(id)}
              onDirtyChange={setDirty}
            />
          </div>
        ) : null}
      </div>
      {navigation.dialog}
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
      className="shrink-0 border-0 border-b border-solid border-border-subtle bg-amber-glow px-md py-sm font-mono text-[0.72rem] text-amber"
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
export type MemoryQueue = MemoryStatusFilter | "candidates" | "attention";
type ScopeFilter = "all" | MemoryScope;

interface MemoryBrowseViewProps {
  scopeRef: MemoryScopeRef;
  active: boolean;
  onOpenNote(memoryId: string, note?: MemoryNote): void;
  page: boolean;
  initialQueue: MemoryQueue;
  onQueueChange(queue: MemoryQueue): void;
  selectedId: string | null;
}

function MemoryBrowseView({
  scopeRef,
  active,
  onOpenNote,
  page,
  initialQueue,
  onQueueChange,
  selectedId,
}: MemoryBrowseViewProps): React.JSX.Element {
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [status, setStatus] = useState<MemoryStatusFilter>(
    initialQueue === "candidates" || initialQueue === "attention"
      ? "review"
      : initialQueue,
  );
  const [candidatesOnly, setCandidatesOnly] = useState(
    initialQueue === "candidates",
  );
  const [attention, setAttention] = useState(initialQueue === "attention");
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
    setAttention(false);
    onQueueChange("candidates");
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
  const sessionCandidatesQuery = useSessionPromotionCandidatesQuery(
    scopeRef.projectName ?? "",
    scopeRef.sessionName ?? "",
    { enabled: active && scopeRef.sessionName !== null },
  );
  const projectCandidatesQuery = useMemoryReviewQueueQuery(
    scopeRef,
    { promotionCandidates: false, projectCandidates: true, session: null },
    {
      enabled:
        active &&
        page &&
        scopeRef.projectName !== null &&
        scopeRef.sessionName === null,
    },
  );
  const proposedQuery = useMemoryNotesQuery(
    scopeRef,
    { lifecycle: "proposed", includeArchived: false },
    { enabled: active && page },
  );
  const candidatesQuery =
    scopeRef.sessionName === null
      ? projectCandidatesQuery
      : sessionCandidatesQuery;
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
      : [
          ...(reviewQuery.data ?? []).filter(
            (entry) => !page || attention || entry.staleness.length > 0,
          ),
          ...(page && !attention ? [] : candidates),
        ];
    const source = fromQueue
      ? dedupeNotesById([
          ...queued.map((entry) => entry.note),
          ...(attention ? (proposedQuery.data ?? []) : []),
        ])
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
    attention,
    page,
    proposedQuery.data,
    candidatesOnly,
    candidates,
    status,
    scopeFilter,
    reviewQuery.data,
    listQuery.data,
    search,
  ]);

  const loading = attention
    ? reviewQuery.isLoading ||
      proposedQuery.isLoading ||
      (scopeRef.projectName !== null && candidatesQuery.isLoading)
    : candidatesOnly
      ? candidatesQuery.isLoading
      : status === "review"
        ? reviewQuery.isLoading
        : listQuery.isLoading;
  const failed = attention
    ? reviewQuery.isError ||
      proposedQuery.isError ||
      (scopeRef.projectName !== null && candidatesQuery.isError)
    : candidatesOnly
      ? candidatesQuery.isError
      : status === "review"
        ? reviewQuery.isError
        : listQuery.isError;

  const now = new Date().toISOString();

  return (
    <>
      {page ? (
        <div className="flex shrink-0 flex-wrap gap-sm border-0 border-b border-solid border-border-subtle p-md">
          <MemoryQueueChip
            onClick={() => {
              setSearch("");
              setScopeFilter("all");
              setCandidatesOnly(false);
              setAttention(false);
              setStatus("proposed");
              onQueueChange("proposed");
            }}
          >
            Proposed {proposedQuery.isSuccess ? proposedQuery.data.length : "—"}
          </MemoryQueueChip>
          <MemoryQueueChip
            onClick={() => {
              setSearch("");
              setScopeFilter("all");
              setCandidatesOnly(false);
              setAttention(false);
              setStatus("review");
              onQueueChange("review");
            }}
          >
            Review due{" "}
            {reviewQuery.isSuccess
              ? reviewQuery.data.filter((entry) => entry.staleness.length > 0)
                  .length
              : "—"}
          </MemoryQueueChip>
          {scopeRef.projectName !== null ? (
            <MemoryQueueChip onClick={openPromotionQueue}>
              Promotion candidates{" "}
              {candidatesQuery.isSuccess ? candidates.length : "—"}
            </MemoryQueueChip>
          ) : null}
        </div>
      ) : null}
      <div className="flex shrink-0 flex-wrap items-center gap-sm border-0 border-b border-solid border-border-subtle px-md py-sm">
        <SegmentedControl
          value={scopeFilter}
          onValueChange={(value) => {
            if (isScopeFilter(value)) setScopeFilter(value);
          }}
          aria-label="Filter by scope"
        >
          <SegmentedControlItem value="all">all</SegmentedControlItem>
          <SegmentedControlItem value="global">global</SegmentedControlItem>
          {scopeRef.projectName !== null ? (
            <SegmentedControlItem value="project">project</SegmentedControlItem>
          ) : null}
          {scopeRef.sessionName !== null || candidatesOnly ? (
            <SegmentedControlItem value="session">session</SegmentedControlItem>
          ) : null}
        </SegmentedControl>
        <SegmentedControl
          value={status}
          onValueChange={(value) => {
            if (isStatusFilter(value)) {
              setStatus(value);
              if (scopeRef.sessionName === null && scopeFilter === "session")
                setScopeFilter("all");
              setCandidatesOnly(false);
              setAttention(false);
              onQueueChange(value);
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
          className="max-768:min-h-[44px] min-w-0 basis-full flex-1 rounded-sm border border-solid border-border-default bg-bg-base px-sm py-xs font-mono text-[0.75rem] text-text-primary placeholder:text-text-tertiary focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)] focus:outline-none"
        />
        {!page && candidates.length > 0 ? (
          <MemoryQueueChip
            onClick={openPromotionQueue}
            aria-pressed={candidatesOnly}
          >
            {candidates.length} promotion{" "}
            {candidates.length === 1 ? "candidate" : "candidates"}
          </MemoryQueueChip>
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
              selected={selectedId === note.id}
              onOpen={() => onOpenNote(note.id, note)}
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
  global: "neutral",
  project: "neutral",
  session: "neutral",
} as const;

interface MemoryRowProps {
  note: MemoryNote;
  /** The engine's verdict for this note, when it holds one. */
  freshness: MemoryReviewQueueEntry | null;
  now: string;
  selected?: boolean;
  onOpen(): void;
}

function MemoryRow({
  note,
  freshness,
  now,
  onOpen,
  selected,
}: MemoryRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={`memory-row-${note.id}`}
      aria-pressed={selected ?? false}
      data-selected={selected ?? false}
      // The hook is the note's whole claim, so it is the row's name: an
      // internal id must never appear on an agent-facing surface, and it has
      // no place on this one either.
      aria-label={`Open memory note ${note.hook}`}
      onClick={onOpen}
      className={cn(
        "flex w-full min-w-0 cursor-pointer flex-col items-start gap-xs border-0 border-b border-solid border-border-subtle bg-transparent px-md py-sm text-left transition-colors duration-150 ease-[ease] hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]",
        note.lifecycle === "archived" && "opacity-55",
        selected && "border-l border-l-cyan bg-bg-raised",
      )}
    >
      <span className="w-full font-mono text-[0.78rem] leading-[1.35] font-medium [overflow-wrap:anywhere] text-text-primary">
        {note.hook}
      </span>
      <span className="flex flex-wrap items-center gap-xs">
        <StatusChip tone={SCOPE_TONE[note.scope]}>{note.scope}</StatusChip>
        <StatusChip tone="neutral">{note.kind}</StatusChip>
        {note.sessionName !== null ? (
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            {note.sessionName}
          </span>
        ) : null}
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
          <StatusChip tone="amber">promotion candidate</StatusChip>
        ) : null}
        <StatusChip tone="neutral">{note.createdBy}</StatusChip>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {describeMemoryAge(note.updatedAt, now)}
        </span>
      </span>
    </button>
  );
}

function MemoryQueueChip({
  children,
  ...props
}: ButtonProps): React.JSX.Element {
  return (
    <Button variant="ghost" size="sm" touch {...props}>
      <StatusChip tone="amber">{children}</StatusChip>
    </Button>
  );
}
