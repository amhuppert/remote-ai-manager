"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from "react";
import {
  executionReferenceInventorySchema,
  type ExecutionReferenceItem,
} from "@/lib/workflow-graph/references";
import { apiFetch } from "@/lib/api/fetcher";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  AutocompleteKbd,
  AutocompleteListbox,
  autocompleteFooterClass,
  autocompleteHeaderClass,
  autocompleteHeaderCountClass,
  type AutocompletePlacement,
} from "@/components/ui/Autocomplete";
import { StatusChip } from "@/components/ui/StatusChip";
import { useAllConversationsQuery } from "@/lib/conversations/queries";
import type { ConversationScopeRef } from "@/lib/conversations/conversation-target";
import type { AllConversationsResponse } from "@/lib/conversations/schemas";
import { useProjectFilesQuery } from "@/lib/files/queries";
import type { FileItem } from "@/lib/files/schemas";
import { useNotepadPickerListQuery } from "@/lib/notepads/queries";
import type { NotepadListItem } from "@/lib/notepads/schemas";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  buildPickerView,
  parseSpecDrillInQuery,
  parseScopeQuery,
  PICKER_ELEMENT_ORDER,
  PICKER_SCOPE_CYCLE,
  scopeForTrigger,
  type PickerDrillScope,
  type PickerScope,
  type PickerSelection,
  type PickerTrigger,
  type PickerView,
} from "@/lib/prompt-editor/reference-picker";
import type {
  ReferencePickerContext,
  SpecPickerElement,
  SpecPickerSpec,
} from "@/lib/prompt-editor/reference-registry";
import { useProjectsQuery } from "@/lib/projects/queries";
import { specReferenceQueries } from "@/lib/specs/reference-queries";
import type {
  SpecPickerDetailView,
  SpecSummaryView,
} from "@/lib/specs/reference-view-schemas";
import { useTicketListQuery } from "@/lib/tickets/queries";
import type { TicketListItem } from "@/lib/tickets/schemas";
import { useOpenDocument } from "@/stores/session-detail.store";
import { cn } from "@/lib/ui/cn";
import {
  ReferencePickerItemRow,
  ReferencePickerMoreRow,
} from "./ReferencePickerRow";

const logger = createClientLogger("prompt-reference-picker");

export interface ReferencePickerPopupHandle {
  handleKeyDown(event: KeyboardEvent): boolean;
}

/** Everything the picker filters over, published so the editor can reuse it. */
export interface ReferencePickerData {
  context: ReferencePickerContext;
  files: readonly FileItem[];
  canOpenDocuments: boolean;
}

export interface ReferencePickerPopupProps {
  trigger: PickerTrigger;
  query: string;
  currentProjectName: string;
  scopeRef: ConversationScopeRef;
  currentConversationId: string | null;
  onSelect(selection: PickerSelection): void;
  /** Write the highlighted row's text back into the query, staying open. */
  onComplete(text: string): void;
  /** `→` only completes from the end of the query; mid-query it moves the caret. */
  isCaretAtQueryEnd(): boolean;
  onClose?(): void;
  onDataChange?(data: ReferencePickerData): void;
  /**
   * Where the popup sits relative to the editor it is anchored to. The prompt
   * opens it upward; a full-pane editor has no room above and overlays instead.
   */
  placement?: AutocompletePlacement;
}

interface QueryShape<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
}

export interface ReferencePickerPopupDeps {
  useExecutions(query: string): QueryShape<readonly ExecutionReferenceItem[]>;
  useAllConversations(params: {
    includeArchived: boolean;
  }): QueryShape<AllConversationsResponse>;
  useTickets(): QueryShape<TicketListItem[]>;
  useSpecs(params: {
    currentProjectName: string;
    query: string;
  }): QueryShape<readonly SpecPickerSpec[]>;
  useFiles(params: {
    projectName: string;
    scopeRef: ConversationScopeRef;
  }): QueryShape<{ items: FileItem[] }>;
  useNotepads(params: {
    currentProjectName: string;
  }): QueryShape<readonly NotepadListItem[]>;
}

export function createReferencePickerPopup(
  deps: ReferencePickerPopupDeps,
): ForwardRefExoticComponent<
  ReferencePickerPopupProps & RefAttributes<ReferencePickerPopupHandle>
> {
  return forwardRef<ReferencePickerPopupHandle, ReferencePickerPopupProps>(
    function ReferencePickerPopup(
      {
        trigger,
        query,
        currentProjectName,
        scopeRef,
        currentConversationId,
        onSelect,
        onComplete,
        isCaretAtQueryEnd,
        onClose,
        onDataChange,
        placement = "above",
      },
      ref,
    ) {
      const [scope, setScope] = useState<PickerScope>(() =>
        scopeForTrigger(trigger),
      );
      const [drillScope, setDrillScope] = useState<PickerDrillScope>("all");
      const [includeDone, setIncludeDone] = useState(false);
      const [includeArchived, setIncludeArchived] = useState(false);

      // Archived conversations are always fetched so the Alt+A chip can report
      // how many the filter is holding back; the filter itself is local.
      const conversationsQuery = deps.useAllConversations({
        includeArchived: true,
      });
      const ticketsQuery = deps.useTickets();
      const executionsQuery = deps.useExecutions(
        parseScopeQuery(query).searchQuery,
      );
      const specsQuery = deps.useSpecs({ currentProjectName, query });
      const filesQuery = deps.useFiles({
        projectName: currentProjectName,
        scopeRef,
      });
      const notepadsQuery = deps.useNotepads({ currentProjectName });

      const context = useMemo<ReferencePickerContext>(
        () => ({
          currentProjectName,
          currentConversationId,
          conversations: conversationsQuery.data?.items ?? [],
          tickets: ticketsQuery.data ?? [],
          specs: specsQuery.data ?? [],
          notepads: notepadsQuery.data ?? [],
          executions: executionsQuery.data ?? [],
          selectedSpec: null,
          includeFinishedTickets: includeDone,
          includeArchivedConversations: includeArchived,
        }),
        [
          conversationsQuery.data?.items,
          currentConversationId,
          currentProjectName,
          includeArchived,
          includeDone,
          notepadsQuery.data,
          specsQuery.data,
          ticketsQuery.data,
          executionsQuery.data,
        ],
      );
      const files = useMemo(
        () => filesQuery.data?.items ?? [],
        [filesQuery.data?.items],
      );
      const canOpenDocuments = scopeRef.scope === "session";

      useEffect(() => {
        onDataChange?.({ context, files, canOpenDocuments });
      }, [canOpenDocuments, context, files, onDataChange]);

      const view = useMemo(
        () =>
          buildPickerView({
            query,
            trigger,
            scope,
            drillScope,
            context,
            files,
            canOpenDocuments,
          }),
        [canOpenDocuments, context, drillScope, files, query, scope, trigger],
      );

      const [activeIndex, setActiveIndex] = useState(0);
      const resetKey = `${view.mode}:${view.scope}:${drillScope}:${view.rows
        .map((row) => (row.kind === "item" ? row.id : row.label))
        .join(",")}`;
      const [previousResetKey, setPreviousResetKey] = useState(resetKey);
      if (resetKey !== previousResetKey) {
        setPreviousResetKey(resetKey);
        setActiveIndex(0);
      }

      // Leaving a spec's drill-in must not strand the element tab it selected.
      const drilledSlug = parseSpecDrillInQuery(query)?.slug ?? null;
      const [previousSlug, setPreviousSlug] = useState(drilledSlug);
      if (drilledSlug !== previousSlug) {
        setPreviousSlug(drilledSlug);
        setDrillScope("all");
      }

      const viewRef = useRef(view);
      const activeIndexRef = useRef(activeIndex);
      const drillScopeRef = useRef(drillScope);
      useEffect(() => {
        viewRef.current = view;
      }, [view]);
      useEffect(() => {
        activeIndexRef.current = activeIndex;
      }, [activeIndex]);
      useEffect(() => {
        drillScopeRef.current = drillScope;
      }, [drillScope]);

      const openDocument = useOpenDocument();
      const moveActive = useCallback((index: number) => {
        activeIndexRef.current = index;
        setActiveIndex(index);
      }, []);

      const selectAt = useCallback(
        (index: number) => {
          const row = viewRef.current.rows[index];
          if (row === undefined) return;
          if (row.kind === "more") {
            setScope(row.scope);
            moveActive(0);
            return;
          }
          logger.info("prompt.references.item_selected", {
            projectName: currentProjectName,
            query,
            referenceId: row.id,
            referenceType: row.itemKind,
          });
          onSelect(row.selection);
        },
        [currentProjectName, moveActive, onSelect, query],
      );

      const openAt = useCallback(
        (index: number) => {
          const row = viewRef.current.rows[index];
          if (row === undefined || row.kind !== "item") return false;
          if (row.openablePath === null || scopeRef.scope !== "session") {
            return false;
          }
          const slash = row.openablePath.lastIndexOf("/");
          openDocument({
            projectName: currentProjectName,
            sessionName: scopeRef.sessionName,
            docPath: row.openablePath,
            title: row.openablePath.slice(slash + 1),
          });
          onClose?.();
          return true;
        },
        [currentProjectName, onClose, openDocument, scopeRef],
      );

      const cycleScope = useCallback(
        (backwards: boolean) => {
          const current = viewRef.current;
          const cycle: readonly (PickerScope | PickerDrillScope)[] =
            current.mode === "drill"
              ? current.tabs.map((tab) => tab.key)
              : PICKER_SCOPE_CYCLE;
          if (cycle.length === 0) return;
          const from = cycle.indexOf(
            current.mode === "drill" ? drillScopeRef.current : current.scope,
          );
          const step = backwards ? cycle.length - 1 : 1;
          const next = cycle[(Math.max(from, 0) + step) % cycle.length];
          if (next === undefined) return;
          if (current.mode === "drill") {
            setDrillScope(next as PickerDrillScope);
          } else {
            setScope(next as PickerScope);
          }
          moveActive(0);
        },
        [moveActive],
      );

      const completeActive = useCallback(() => {
        const row = viewRef.current.rows[activeIndexRef.current];
        if (row === undefined || row.kind !== "item") return false;
        if (row.completion === query) return false;
        onComplete(row.completion);
        return true;
      }, [onComplete, query]);

      const handleKeyDown = useCallback(
        (event: KeyboardEvent): boolean => {
          const rows = viewRef.current.rows;
          if (event.key === "Tab") {
            event.preventDefault();
            cycleScope(event.shiftKey);
            return true;
          }
          if (event.altKey && event.code === "KeyD") {
            event.preventDefault();
            setIncludeDone((current) => !current);
            moveActive(0);
            return true;
          }
          if (event.altKey && event.code === "KeyA") {
            event.preventDefault();
            setIncludeArchived((current) => !current);
            moveActive(0);
            return true;
          }
          if (event.altKey && event.key === "Enter") {
            if (!openAt(activeIndexRef.current)) return false;
            event.preventDefault();
            return true;
          }
          if (event.key === "ArrowRight") {
            if (!isCaretAtQueryEnd() || !completeActive()) return false;
            event.preventDefault();
            return true;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveActive(
              Math.min(
                activeIndexRef.current + 1,
                Math.max(rows.length - 1, 0),
              ),
            );
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            moveActive(Math.max(activeIndexRef.current - 1, 0));
            return true;
          }
          if (event.key === "Enter") {
            if (rows.length === 0) return false;
            event.preventDefault();
            selectAt(activeIndexRef.current);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose?.();
            return true;
          }
          return false;
        },
        [
          completeActive,
          cycleScope,
          isCaretAtQueryEnd,
          moveActive,
          onClose,
          openAt,
          selectAt,
        ],
      );
      useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

      // Reference sources feed one list, so they are reported progressively: rows
      // that have arrived stay on screen while a slower source loads, and a
      // failing source only takes over the body when nothing else matched.
      const settling =
        conversationsQuery.isLoading ||
        ticketsQuery.isLoading ||
        specsQuery.isLoading ||
        filesQuery.isLoading ||
        notepadsQuery.isLoading ||
        executionsQuery.isLoading;
      const failure = firstError([
        [conversationsQuery, "Failed to load conversations"],
        [ticketsQuery, "Failed to load tickets"],
        [specsQuery, "Failed to load specs"],
        [filesQuery, "Failed to load files"],
        [notepadsQuery, "Failed to load notepads"],
        [executionsQuery, "Failed to load workflow executions"],
      ]);
      const hasRows = view.rows.length > 0;

      return (
        <AutocompleteListbox
          label="References"
          popupRole="grid"
          // Overlaying an editor pane means the pane is also the ceiling: the
          // panel clips what runs past its edge, so the readability cap and
          // the available height are taken together.
          maxHeightClassName={
            placement === "overlay-top"
              ? "max-h-[min(420px,100%)]"
              : "max-h-[420px]"
          }
          placement={placement}
          loading={settling && !hasRows}
          loadingLabel="Loading references..."
          error={hasRows ? null : failure}
          isEmpty={!hasRows}
          empty="No matching references"
          header={
            <div className="sticky top-0 z-raised">
              <div className={autocompleteHeaderClass}>
                <span className="min-w-0 truncate font-semibold tracking-[0.06em] uppercase">
                  {view.headerLabel}
                </span>
                <span className="flex shrink-0 items-center gap-xs">
                  <FilterChip
                    chip={view.doneChip}
                    tone="green"
                    shortcut="Alt+D"
                    onToggle={() => {
                      setIncludeDone((current) => !current);
                      moveActive(0);
                    }}
                  />
                  <FilterChip
                    chip={view.archivedChip}
                    tone="amber"
                    shortcut="Alt+A"
                    onToggle={() => {
                      setIncludeArchived((current) => !current);
                      moveActive(0);
                    }}
                  />
                  <span className={autocompleteHeaderCountClass}>
                    {view.countLabel}
                  </span>
                </span>
              </div>
              <ScopeTabs
                view={view}
                onSelectScope={(key) => {
                  if (view.mode === "drill") {
                    setDrillScope(key as PickerDrillScope);
                  } else {
                    setScope(key as PickerScope);
                  }
                  moveActive(0);
                }}
              />
            </div>
          }
          footer={<PickerFooter />}
        >
          <PickerSections
            view={view}
            activeIndex={activeIndex}
            onHover={moveActive}
            onSelect={selectAt}
            onOpen={openAt}
          />
        </AutocompleteListbox>
      );
    },
  );
}

function rowDomId(index: number): string {
  return `reference-picker-option-${index}`;
}

function firstError(
  candidates: readonly [QueryShape<unknown>, string][],
): string | null {
  for (const [query, fallback] of candidates) {
    if (query.isError) return query.error?.message ?? fallback;
  }
  return null;
}

const TAB_ACCENT_CLASS: Record<string, string> = {
  all: "border-b-cyan text-text-primary",
  file: "border-b-text-secondary text-text-primary",
  conversation: "border-b-cyan text-text-primary",
  spec: "border-b-violet text-text-primary",
  ticket: "border-b-amber text-text-primary",
  notepad: "border-b-blue text-text-primary",
};

const TAB_COUNT_CLASS: Record<string, string> = {
  all: "text-cyan",
  file: "text-text-secondary",
  conversation: "text-cyan",
  spec: "text-violet",
  ticket: "text-amber",
  notepad: "text-blue",
};

function ScopeTabs({
  view,
  onSelectScope,
}: {
  view: PickerView;
  onSelectScope(key: string): void;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Reference scope"
      className="flex items-end gap-[2px] border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-surface px-sm pt-xs"
    >
      {view.tabs.map((tab) => {
        const accentKey = tab.glyph ?? "all";
        return (
          <button
            key={tab.key}
            type="button"
            tabIndex={-1}
            aria-pressed={tab.active}
            // The label and count are separate elements, so spell the name out
            // rather than let it read as "Tickets3".
            aria-label={`${tab.label} (${tab.count})`}
            // The editor keeps DOM focus for the whole life of the popup.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelectScope(tab.key)}
            className={cn(
              "inline-flex cursor-pointer items-center gap-[5px] border-x-0 border-t-0 border-b-2 border-solid bg-transparent px-sm pt-[3px] pb-[5px] font-mono text-[0.72rem] font-semibold transition-colors duration-150",
              tab.active
                ? TAB_ACCENT_CLASS[accentKey]
                : "border-b-transparent text-text-tertiary hover:text-text-secondary",
            )}
          >
            {tab.label}
            <span
              className={cn(
                "font-medium",
                tab.active ? TAB_COUNT_CLASS[accentKey] : "text-text-tertiary",
              )}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
      <span className="ml-auto shrink-0 px-xs pb-[6px] text-[0.65rem] text-text-tertiary max-768:hidden">
        <AutocompleteKbd>Tab</AutocompleteKbd> scope
      </span>
    </div>
  );
}

function FilterChip({
  chip,
  tone,
  shortcut,
  onToggle,
}: {
  chip: PickerView["doneChip"];
  tone: "green" | "amber";
  shortcut: string;
  onToggle(): void;
}): React.JSX.Element | null {
  if (!chip.visible) return null;
  return (
    <StatusChip
      as="button"
      tone={chip.active ? tone : "neutral"}
      aria-pressed={chip.active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
    >
      {chip.label} <span className="opacity-70">{shortcut}</span>
    </StatusChip>
  );
}

function PickerSections({
  view,
  activeIndex,
  onHover,
  onSelect,
  onOpen,
}: {
  view: PickerView;
  activeIndex: number;
  onHover(index: number): void;
  onSelect(index: number): void;
  onOpen(index: number): void;
}): React.JSX.Element {
  // Scrolling by id keeps every row a direct child of its rowgroup: a wrapper
  // element to hang a ref on would break the grid's required containment.
  useEffect(() => {
    document
      .getElementById(rowDomId(activeIndex))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  return (
    <>
      {view.sections.map((section) => (
        <div key={section.key} role="rowgroup" aria-label={section.label}>
          {section.showHeader ? (
            // The rowgroup's own label already names the section for assistive
            // tech, so the visible caption is decoration.
            <div
              role="presentation"
              className="flex items-center justify-between bg-bg-raised px-sm py-[3px] text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase"
            >
              <span>{section.label}</span>
              <span className="font-medium tracking-normal normal-case">
                {section.hint}
              </span>
            </div>
          ) : null}
          {section.rows.map((row) => {
            const active = row.index === activeIndex;
            const id = rowDomId(row.index);
            return row.kind === "more" ? (
              <ReferencePickerMoreRow
                key={id}
                row={row}
                id={id}
                active={active}
                onHover={() => onHover(row.index)}
                onSelect={() => onSelect(row.index)}
              />
            ) : (
              <ReferencePickerItemRow
                key={id}
                row={row}
                id={id}
                active={active}
                onHover={() => onHover(row.index)}
                onSelect={() => onSelect(row.index)}
                onOpen={() => onOpen(row.index)}
              />
            );
          })}
        </div>
      ))}
    </>
  );
}

function PickerFooter(): React.JSX.Element {
  return (
    <div className={cn(autocompleteFooterClass, "gap-sm max-768:hidden")}>
      <span>
        <AutocompleteKbd>↑↓</AutocompleteKbd> navigate
      </span>
      <span>
        <AutocompleteKbd>Tab</AutocompleteKbd> scope
      </span>
      <span>
        <AutocompleteKbd>Enter</AutocompleteKbd> select
      </span>
      <span>
        <AutocompleteKbd>→</AutocompleteKbd> complete
      </span>
      <span className="max-960:hidden">
        <AutocompleteKbd>Alt+Enter</AutocompleteKbd> open
      </span>
      <span className="max-960:hidden">
        <AutocompleteKbd>Alt+D</AutocompleteKbd> done
      </span>
      <span className="max-960:hidden">
        <AutocompleteKbd>Alt+A</AutocompleteKbd> archived
      </span>
      <span>
        <AutocompleteKbd>Esc</AutocompleteKbd> close
      </span>
    </div>
  );
}

// ── Spec sourcing ──

function useSpecPickerSpecs({
  currentProjectName,
  query,
}: {
  currentProjectName: string;
  query: string;
}): QueryShape<readonly SpecPickerSpec[]> {
  const projectsQuery = useProjectsQuery();
  const projectNames = useMemo(
    () => [
      currentProjectName,
      ...(projectsQuery.data ?? [])
        .map((project) => project.name)
        .filter((name) => name !== currentProjectName),
    ],
    [currentProjectName, projectsQuery.data],
  );
  const inventoryQueries = useQueries({
    queries: projectNames.map((projectName) =>
      specReferenceQueries.inventory(projectName),
    ),
  });
  const summaries = useMemo(
    () =>
      projectNames.flatMap((projectName, index) =>
        (inventoryQueries[index]?.data?.specs ?? []).map((summary) => ({
          projectName,
          summary,
        })),
      ),
    [inventoryQueries, projectNames],
  );
  const drillIn = parseSpecDrillInQuery(query);
  const selected = drillIn
    ? summaries.find(
        ({ summary }) =>
          summary.spec.slug.toLowerCase() === drillIn.slug.toLowerCase(),
      )
    : undefined;
  const detailQuery = useQuery({
    ...specReferenceQueries.pickerDetail(
      selected?.projectName ?? currentProjectName,
      selected?.summary.spec.slug ?? "unresolved-spec",
    ),
    enabled: selected !== undefined,
  });
  const specs = useMemo(
    () =>
      summaries.flatMap(({ projectName, summary }) => {
        const revision = summary.currentRevision?.number;
        if (revision === undefined) return [];
        const hasLoadedDetail =
          selected?.summary.spec.id === summary.spec.id &&
          selected.projectName === projectName &&
          detailQuery.data?.spec.id === summary.spec.id;
        return [
          toSpecPickerSpec(
            projectName,
            summary,
            hasLoadedDetail ? detailQuery.data : undefined,
          ),
        ];
      }),
    [detailQuery.data, selected, summaries],
  );
  const inventoryError = inventoryQueries.find((result) => result.isError);
  const error = projectsQuery.isError
    ? projectsQuery.error
    : inventoryError?.isError
      ? inventoryError.error
      : detailQuery.isError
        ? detailQuery.error
        : null;
  return {
    data: specs,
    isLoading:
      projectsQuery.isLoading ||
      inventoryQueries.some((result) => result.isLoading) ||
      (selected !== undefined && detailQuery.isLoading),
    isError:
      projectsQuery.isError ||
      inventoryError !== undefined ||
      detailQuery.isError,
    error,
  };
}

export function toSpecPickerSpec(
  projectName: string,
  summary: SpecSummaryView,
  detail: SpecPickerDetailView | undefined,
): SpecPickerSpec {
  return {
    projectName,
    specId: summary.spec.id,
    slug: summary.spec.slug,
    name: summary.spec.name,
    revision:
      detail?.currentRevision?.revision.number ??
      summary.currentRevision!.number,
    elements: detail ? pickerElements(detail) : [],
  };
}

function pickerElements(detail: SpecPickerDetailView): SpecPickerElement[] {
  const elements = [
    ...revisionPickerElements(detail),
    ...detail.questions.map(
      (question): SpecPickerElement => ({
        type: "question",
        elementId: question.id,
        handle: question.handle,
        name: question.text,
        searchText: question.text,
      }),
    ),
    ...detail.assumptions.map(
      (assumption): SpecPickerElement => ({
        type: "assumption",
        elementId: assumption.id,
        handle: assumption.handle,
        name: assumption.text,
        searchText: assumption.text,
      }),
    ),
  ];
  // The drill-in tabs read their order straight off this list.
  return elements.sort(
    (left, right) =>
      PICKER_ELEMENT_ORDER.indexOf(left.type) -
      PICKER_ELEMENT_ORDER.indexOf(right.type),
  );
}

function revisionPickerElements(
  detail: SpecPickerDetailView,
): SpecPickerElement[] {
  return (detail.currentRevision?.elements ?? []).flatMap(
    (row): SpecPickerElement[] => {
      const number = row.element.number;
      if (number === null) return [];
      switch (row.version.payload.kind) {
        case "requirement":
          return [
            {
              type: "requirement",
              elementId: row.element.id,
              handle: `R${number}`,
              name: row.version.payload.statement,
              searchText: row.version.payload.statement,
            },
          ];
        case "decision":
          return [
            {
              type: "decision",
              elementId: row.element.id,
              handle: `D${number}`,
              name: row.version.payload.title,
              searchText: [
                row.version.payload.title,
                row.version.payload.chosenApproach,
                row.version.payload.reason,
                ...row.version.payload.rejectedAlternatives.flatMap(
                  (alternative) => [alternative.label, alternative.reason],
                ),
              ].join("\n"),
            },
          ];
        case "task":
          return [
            {
              type: "task",
              elementId: row.element.id,
              handle: `T${number}`,
              name: row.version.payload.title,
              searchText: [
                row.version.payload.title,
                row.version.payload.instructions,
              ].join("\n"),
            },
          ];
        case "criterion":
        case "section":
          return [];
      }
    },
  );
}

export const ReferencePickerPopup = createReferencePickerPopup({
  useExecutions: (query) => {
    const search = query;
    return useQuery({
      queryKey: ["execution-reference-inventory", search],
      queryFn: async () =>
        (
          await apiFetch(
            `/api/live-references/executions?q=${encodeURIComponent(search)}`,
            executionReferenceInventorySchema,
          )
        ).items,
      staleTime: 3000,
    });
  },
  useAllConversations: useAllConversationsQuery,
  useTickets: () => useTicketListQuery({}),
  useSpecs: useSpecPickerSpecs,
  useFiles: ({ projectName, scopeRef }) =>
    useProjectFilesQuery(
      scopeRef.scope === "project"
        ? { projectName }
        : { projectName, sessionName: scopeRef.sessionName },
    ),
  useNotepads: ({ currentProjectName }) =>
    useNotepadPickerListQuery(currentProjectName),
});
