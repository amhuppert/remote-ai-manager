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
import { Badge } from "@/components/ui/Badge";
import { FormInput } from "@/components/ui/FormField";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/Collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  CheckIcon,
  SearchIcon,
} from "@/components/icons";
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
  MemoryKind,
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
        <span className="font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase">
          {layout === "page" ? "Shared memory" : "Memory"}
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
            className="inline-flex items-center gap-xs max-768:min-h-[44px] font-mono text-[0.7rem] text-text-primary no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          >
            Open memory screen
            <ArrowUpRightIcon size={14} />
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
            "@container min-h-0 min-w-0 flex-col",
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
 * It sits outside either view because it is a
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
      className="shrink-0 border-0 border-b border-solid border-border-subtle bg-bg-base font-mono text-[0.7rem] leading-relaxed text-text-secondary"
    >
      {exceptions.map((exception) => (
        <Collapsible
          key={exception.backend}
          onOpenChange={(open) =>
            logger.info("memory.library.disclosure_toggled", {
              backend: exception.backend,
              open,
            })
          }
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group flex w-full items-center gap-sm border-0 bg-bg-base px-lg py-sm text-left font-mono text-[0.7rem] text-text-primary hover:bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px] max-768:min-h-[44px]"
            >
              <span className="shrink-0 text-amber" aria-hidden="true">
                <AlertTriangleIcon size={16} />
              </span>
              <span>{exception.label} native memory is also active</span>
              <ChevronDownIcon
                size={14}
                className="ml-auto shrink-0 text-text-secondary group-data-[state=open]:rotate-180"
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="px-lg pb-md">{exception.reason}.</p>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}

const PANEL_CLASS =
  "@container flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-solid border-border-default bg-bg-surface";

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

/** What the list is narrowed to. `review` and `candidates` read the queue. */
type MemoryStatusFilter = "active" | "review" | "proposed" | "archived";
export type MemoryQueue = MemoryStatusFilter | "candidates" | "attention";
type ScopeFilter = "all" | MemoryScope;

const SORT_OPTIONS = {
  updated: "Recently updated",
  created: "Newest created",
  oldest: "Oldest updated",
  alphabetical: "Alphabetical",
} as const;
type MemorySort = keyof typeof SORT_OPTIONS;

function isMemorySort(value: string): value is MemorySort {
  return Object.hasOwn(SORT_OPTIONS, value);
}

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
  const [sort, setSort] = useState<MemorySort>("updated");

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
    logger.info("memory.library.queue_selected", {
      queue: "candidates",
      projectName: scopeRef.projectName,
    });
  }

  function openReviewQueue(next: "proposed" | "review"): void {
    setSearch("");
    setScopeFilter("all");
    setCandidatesOnly(false);
    setAttention(false);
    setStatus(next);
    onQueueChange(next);
    logger.info("memory.library.queue_selected", {
      queue: next,
      projectName: scopeRef.projectName,
    });
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
    const filtered = scoped.filter(
      (note) =>
        note.hook.toLowerCase().includes(needle) ||
        note.slug.toLowerCase().includes(needle) ||
        note.body.toLowerCase().includes(needle),
    );
    return [...filtered].sort((a, b) => {
      const byHook =
        a.hook.localeCompare(b.hook, undefined, { sensitivity: "base" }) ||
        a.slug.localeCompare(b.slug) ||
        a.id.localeCompare(b.id);
      if (sort === "alphabetical") return byHook;
      if (sort === "created")
        return Date.parse(b.createdAt) - Date.parse(a.createdAt) || byHook;
      const byUpdated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      return (sort === "oldest" ? -byUpdated : byUpdated) || byHook;
    });
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
    sort,
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
        <div className="flex shrink-0 flex-wrap items-center gap-sm border-0 border-b border-solid border-border-subtle px-lg py-md">
          <span className="mr-xs font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-secondary uppercase @max-[560px]:hidden">
            Needs attention
          </span>
          <div className="flex min-w-0 flex-wrap gap-sm p-xs [&_button]:shrink-0">
            <MemoryQueueButton
              onClick={() => openReviewQueue("proposed")}
              aria-pressed={status === "proposed" && !attention}
              count={proposedQuery.isSuccess ? proposedQuery.data.length : null}
            >
              Proposed
            </MemoryQueueButton>
            <MemoryQueueButton
              onClick={() => openReviewQueue("review")}
              aria-pressed={
                status === "review" && !candidatesOnly && !attention
              }
              count={
                reviewQuery.isSuccess
                  ? reviewQuery.data.filter(
                      (entry) => entry.staleness.length > 0,
                    ).length
                  : null
              }
            >
              Review due
            </MemoryQueueButton>
            {scopeRef.projectName !== null ? (
              <MemoryQueueButton
                onClick={openPromotionQueue}
                aria-pressed={candidatesOnly}
                count={candidatesQuery.isSuccess ? candidates.length : null}
              >
                Promotion candidates
              </MemoryQueueButton>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="flex shrink-0 flex-col gap-md px-lg py-md">
        <div className="flex flex-wrap items-center gap-sm">
          <div className="relative min-w-0 flex-1 [&_input]:pl-2xl max-768:[&_input]:min-h-[44px]">
            <span
              className="pointer-events-none absolute inset-y-0 left-md flex items-center text-text-tertiary"
              aria-hidden="true"
            >
              <SearchIcon size={16} />
            </span>
            <FormInput
              type="search"
              aria-label="Search memory notes"
              placeholder="Search memory…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select
            value={sort}
            onValueChange={(value) => {
              if (!isMemorySort(value)) return;
              setSort(value);
              logger.info("memory.library.sort_selected", {
                sort: value,
                projectName: scopeRef.projectName,
              });
            }}
          >
            <SelectTrigger aria-label="Sort memory notes">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SORT_OPTIONS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          <MemoryFilterControl
            value={scopeFilter}
            onValueChange={(value) => {
              if (!isScopeFilter(value)) return;
              setScopeFilter(value);
              logger.info("memory.library.scope_selected", {
                scope: value,
                projectName: scopeRef.projectName,
              });
            }}
            label="Filter by scope"
            options={[
              { value: "all", label: "All scopes" },
              { value: "global", label: "Global" },
              ...(scopeRef.projectName !== null
                ? [{ value: "project", label: "Project" }]
                : []),
              ...(scopeRef.sessionName !== null || candidatesOnly
                ? [{ value: "session", label: "Session" }]
                : []),
            ]}
          />
          <MemoryFilterControl
            value={status}
            onValueChange={(value) => {
              if (!isStatusFilter(value)) return;
              setStatus(value);
              if (scopeRef.sessionName === null && scopeFilter === "session")
                setScopeFilter("all");
              setCandidatesOnly(false);
              setAttention(false);
              onQueueChange(value);
              logger.info("memory.library.status_selected", {
                status: value,
                projectName: scopeRef.projectName,
              });
            }}
            label="Filter by status"
            options={[
              { value: "active", label: "Active" },
              { value: "review", label: "Review" },
              { value: "proposed", label: "Proposed" },
              { value: "archived", label: "Archived" },
            ]}
          />
          {!page && candidates.length > 0 ? (
            <MemoryQueueButton
              onClick={openPromotionQueue}
              aria-pressed={candidatesOnly}
              aria-label={`${candidates.length} promotion ${candidates.length === 1 ? "candidate" : "candidates"}`}
              count={candidates.length}
            >
              Promotion candidates
            </MemoryQueueButton>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-sm border-0 border-y border-solid border-border-subtle bg-bg-base px-lg py-sm font-mono text-[0.7rem] tracking-[0.08em] text-text-secondary uppercase">
        <span className="font-semibold">
          {candidatesOnly
            ? "Promotion candidates"
            : attention
              ? "Needs attention"
              : `${status} notes`}
        </span>
        <span aria-live="polite" className="tabular-nums text-text-primary">
          {loading || failed ? "—" : rows.length}
        </span>
        <span className="ml-auto mr-2xl @max-[560px]:hidden">
          {sort === "created" ? "Created" : "Updated"}
        </span>
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
          <EmptyStateTitle>
            {search.trim() ? "No matching memories" : "Nothing here"}
          </EmptyStateTitle>
          <EmptyStateDesc>
            {search.trim()
              ? "Try another search or clear it to see this list."
              : "Notes captured by agents and by you appear here. The Index view shows which notes a conversation receives."}
          </EmptyStateDesc>
          {search.trim() ? (
            <Button size="sm" touch onClick={() => setSearch("")}>
              Clear search
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <div
          className="@container min-h-0 flex-1 overflow-y-auto p-sm"
          aria-label="Memory notes"
        >
          {rows.map((note) => (
            <MemoryRow
              key={note.id}
              note={note}
              freshness={freshnessByNoteId.get(note.id) ?? null}
              now={now}
              dateField={sort === "created" ? "createdAt" : "updatedAt"}
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

const KIND_ICON_PATH: Record<MemoryKind, string> = {
  lesson:
    "M12 5v15M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Z",
  procedure: "M9 5h12M9 12h12M9 19h12M3 4h1v2H3zM3 11h1v2H3zM3 18h1v2H3z",
  preference: "M3 7h4m6 0h8M3 17h10m6 0h2M7 4h6v6H7zM13 14h6v6h-6z",
  state: "M3 4h18v16H3zM7 9l3 3-3 3m6 0h4",
};

interface MemoryRowProps {
  note: MemoryNote;
  /** The engine's verdict for this note, when it holds one. */
  freshness: MemoryReviewQueueEntry | null;
  now: string;
  dateField: "createdAt" | "updatedAt";
  selected?: boolean;
  onOpen(): void;
}

function MemoryRow({
  note,
  freshness,
  now,
  onOpen,
  selected,
  dateField,
}: MemoryRowProps): React.JSX.Element {
  const date = note[dateField];
  const dateLabel = dateField === "createdAt" ? "Created" : "Updated";
  const age = describeMemoryAge(date, now);
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
      className="group mb-xs flex w-full min-w-0 cursor-pointer items-start gap-md rounded-md border border-solid px-md py-md text-left transition-colors duration-150 ease-[ease] data-[selected=false]:border-border-subtle data-[selected=false]:bg-bg-base data-[selected=false]:hover:border-border-default data-[selected=false]:hover:bg-bg-surface data-[selected=true]:border-cyan-dim data-[selected=true]:bg-bg-raised data-[selected=true]:hover:bg-bg-elevated focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]"
    >
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-md border border-solid border-border-default bg-bg-base text-text-secondary group-hover:text-text-primary @max-[560px]:hidden"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          strokeLinejoin="miter"
        >
          <path d={KIND_ICON_PATH[note.kind]} />
        </svg>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-sm">
        <span className="font-mono text-[0.82rem] leading-[1.6] font-medium [overflow-wrap:anywhere] text-text-primary">
          {note.hook}
        </span>
        <span className="flex flex-wrap items-center gap-x-sm gap-y-xs font-mono text-[0.7rem] text-text-secondary">
          <Badge subtle>{note.kind}</Badge>
          <span>{note.scope}</span>
          {note.sessionName !== null ? (
            <span className="min-w-0 truncate" title={note.sessionName}>
              {note.sessionName}
            </span>
          ) : null}
          <span aria-hidden="true" className="h-3 w-px bg-border-default" />
          <span>{note.createdBy}</span>
          {note.indexMode !== "auto" ? (
            <span className="text-text-secondary">
              {note.indexMode === "always" ? "Always in index" : "Search only"}
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
          <time
            dateTime={date}
            title={`${dateLabel} ${new Date(date).toLocaleString()}`}
            className="hidden @max-[560px]:inline"
          >
            {age}
          </time>
        </span>
      </span>
      <time
        dateTime={date}
        title={`${dateLabel} ${new Date(date).toLocaleString()}`}
        className="mt-xs w-[112px] shrink-0 text-right font-mono text-[0.7rem] leading-relaxed whitespace-nowrap text-text-secondary tabular-nums @max-[560px]:hidden"
      >
        {age}
      </time>
      <span
        aria-hidden="true"
        className="mt-xs shrink-0 text-text-secondary group-hover:text-cyan group-data-[selected=true]:text-cyan"
      >
        <ChevronRightIcon size={16} />
      </span>
    </button>
  );
}

function MemoryQueueButton({
  children,
  count,
  ...props
}: ButtonProps & { count: number | null }): React.JSX.Element {
  return (
    <Button size="sm" touch {...props}>
      {props["aria-pressed"] === true ? <CheckIcon size={14} /> : null}
      {children}
      <Badge status={count !== null && count > 0 ? "awaiting" : "idle"}>
        {count ?? "—"}
      </Badge>
    </Button>
  );
}

function MemoryFilterControl({
  value,
  onValueChange,
  label,
  options,
}: {
  value: string;
  onValueChange(value: string): void;
  label: string;
  options: readonly { value: string; label: string }[];
}): React.JSX.Element {
  return (
    <>
      <div className="flex @max-[560px]:hidden">
        <SegmentedControl
          value={value}
          onValueChange={onValueChange}
          aria-label={label}
        >
          {options.map((option) => (
            <SegmentedControlItem key={option.value} value={option.value}>
              {option.value}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>
      <div className="hidden @max-[560px]:flex">
        <Select value={value} onValueChange={onValueChange}>
          <SelectTrigger aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
