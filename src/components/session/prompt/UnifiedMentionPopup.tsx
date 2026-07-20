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
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  AutocompleteListbox,
  AutocompleteMatchText,
  AutocompleteNavFooter,
  AutocompleteOption,
  autocompleteHeaderClass,
  autocompleteHeaderCountClass,
} from "@/components/ui/Autocomplete";
import { StatusChip } from "@/components/ui/StatusChip";
import { useAllConversationsQuery } from "@/lib/conversations/queries";
import type { AllConversationsResponse } from "@/lib/conversations/schemas";
import {
  getUnifiedMentionGroups,
  parseSpecDrillInQuery,
  type UnifiedMentionGroup,
} from "@/lib/prompt-editor/unified-mention-extension";
import type {
  ReferencePickerContext,
  ReferencePickerItem,
  SpecPickerElement,
  SpecPickerSpec,
} from "@/lib/prompt-editor/reference-registry";
import { useProjectsQuery } from "@/lib/projects/queries";
import {
  specQueries,
  type SpecDetailView,
  type SpecSummaryView,
} from "@/lib/specs/queries";
import { useTicketListQuery } from "@/lib/tickets/queries";
import type { TicketListItem } from "@/lib/tickets/schemas";

export interface UnifiedMentionPopupHandle {
  handleKeyDown(event: KeyboardEvent): boolean;
}

export interface UnifiedMentionPopupProps {
  query: string;
  currentProjectName: string;
  currentConversationId: string | null;
  onSelect(selection: ReferencePickerItem): void;
  onClose?(): void;
  onPickerContextChange?(context: ReferencePickerContext): void;
}

interface QueryShape<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
}

export interface UnifiedMentionPopupDeps {
  useAllConversations(params: {
    includeArchived: boolean;
  }): QueryShape<AllConversationsResponse>;
  useTickets(): QueryShape<TicketListItem[]>;
  useSpecs(params: {
    currentProjectName: string;
    query: string;
  }): QueryShape<readonly SpecPickerSpec[]>;
}

export function createUnifiedMentionPopup(
  deps: UnifiedMentionPopupDeps,
): ForwardRefExoticComponent<
  UnifiedMentionPopupProps & RefAttributes<UnifiedMentionPopupHandle>
> {
  return forwardRef<UnifiedMentionPopupHandle, UnifiedMentionPopupProps>(
    function UnifiedMentionPopup(
      {
        query,
        currentProjectName,
        currentConversationId,
        onSelect,
        onClose,
        onPickerContextChange,
      },
      ref,
    ) {
      const [includeArchived, setIncludeArchived] = useState(false);
      const conversationsQuery = deps.useAllConversations({ includeArchived });
      const ticketsQuery = deps.useTickets();
      const specsQuery = deps.useSpecs({ currentProjectName, query });
      const pickerContext = useMemo<ReferencePickerContext>(
        () => ({
          currentProjectName,
          currentConversationId,
          conversations: conversationsQuery.data?.items ?? [],
          tickets: ticketsQuery.data ?? [],
          specs: specsQuery.data ?? [],
          selectedSpec: null,
        }),
        [
          conversationsQuery.data?.items,
          currentConversationId,
          currentProjectName,
          specsQuery.data,
          ticketsQuery.data,
        ],
      );
      useEffect(() => {
        onPickerContextChange?.(pickerContext);
      }, [onPickerContextChange, pickerContext]);

      const groups = useMemo(
        () => getUnifiedMentionGroups(query, pickerContext),
        [pickerContext, query],
      );
      const items = useMemo(
        () => groups.flatMap((group) => group.items),
        [groups],
      );
      const [activeIndex, setActiveIndex] = useState(0);
      const resetKey = `${query}:${items.map((item) => item.id).join(",")}`;
      const [previousResetKey, setPreviousResetKey] = useState(resetKey);
      if (resetKey !== previousResetKey) {
        setPreviousResetKey(resetKey);
        setActiveIndex(0);
      }

      const activeIndexRef = useRef(activeIndex);
      const itemsRef = useRef(items);
      useEffect(() => {
        activeIndexRef.current = activeIndex;
      }, [activeIndex]);
      useEffect(() => {
        itemsRef.current = items;
      }, [items]);

      const selectAt = useCallback(
        (index: number) => {
          const item = itemsRef.current[index];
          if (item) onSelect(item);
        },
        [onSelect],
      );
      const toggleArchived = useCallback(() => {
        setIncludeArchived((current) => !current);
      }, []);
      const handleKeyDown = useCallback(
        (event: KeyboardEvent): boolean => {
          const total = itemsRef.current.length;
          if (event.altKey && event.key.toLowerCase() === "a") {
            event.preventDefault();
            toggleArchived();
            return true;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((current) => {
              const next = Math.min(current + 1, Math.max(total - 1, 0));
              activeIndexRef.current = next;
              return next;
            });
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => {
              const next = Math.max(current - 1, 0);
              activeIndexRef.current = next;
              return next;
            });
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            if (total === 0) return false;
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
        [onClose, selectAt, toggleArchived],
      );
      useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

      const loading =
        conversationsQuery.isLoading ||
        ticketsQuery.isLoading ||
        specsQuery.isLoading;
      const error = conversationsQuery.isError
        ? (conversationsQuery.error?.message ?? "Failed to load conversations")
        : ticketsQuery.isError
          ? (ticketsQuery.error?.message ?? "Failed to load tickets")
          : specsQuery.isError
            ? (specsQuery.error?.message ?? "Failed to load specs")
            : null;

      return (
        <AutocompleteListbox
          label="References"
          maxHeightClassName="max-h-[380px]"
          loading={loading}
          loadingLabel="Loading references..."
          error={error}
          isEmpty={items.length === 0}
          empty="No matching references"
          header={
            <div className={autocompleteHeaderClass}>
              <span>References — grouped by type</span>
              <span className="flex items-center gap-sm">
                <span className={autocompleteHeaderCountClass}>
                  {items.length} {items.length === 1 ? "result" : "results"}
                </span>
                <StatusChip
                  as="button"
                  aria-pressed={includeArchived}
                  onClick={toggleArchived}
                  layoutClassName="border-border-default bg-transparent transition-[border-color,color,background] duration-150 ease-[ease] aria-pressed:border-amber-dim aria-pressed:text-amber [&[aria-pressed=false]]:hover:border-border-strong [&[aria-pressed=false]]:hover:text-text-secondary"
                >
                  Archived
                </StatusChip>
              </span>
            </div>
          }
          footer={
            <AutocompleteNavFooter
              layoutClassName="max-768:hidden"
              extra={<span>Alt+A archived</span>}
            />
          }
        >
          <GroupedOptions
            groups={groups}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onSelect={selectAt}
          />
        </AutocompleteListbox>
      );
    },
  );
}

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
      specQueries.inventory(projectName),
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
    ...specQueries.detail(
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
  detail: SpecDetailView | undefined,
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

function pickerElements(detail: SpecDetailView): SpecPickerElement[] {
  return [
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
}

function revisionPickerElements(detail: SpecDetailView): SpecPickerElement[] {
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

function GroupedOptions({
  groups,
  activeIndex,
  onHover,
  onSelect,
}: {
  groups: UnifiedMentionGroup[];
  activeIndex: number;
  onHover(index: number): void;
  onSelect(index: number): void;
}): React.JSX.Element {
  const indexedGroups = groups.map((group, groupIndex) => ({
    group,
    startIndex: groups
      .slice(0, groupIndex)
      .reduce((total, current) => total + current.items.length, 0),
  }));
  return (
    <>
      {indexedGroups.map(({ group, startIndex }) => {
        return (
          <div key={group.type} role="group" aria-label={group.label}>
            <div className="border-y-0 border-r-0 border-l-2 border-solid border-l-transparent bg-bg-raised px-sm py-[3px] text-[0.66rem] tracking-[0.08em] text-text-tertiary uppercase">
              {group.label}
            </div>
            {group.items.map((item, itemIndex) => {
              const index = startIndex + itemIndex;
              return (
                <AutocompleteOption
                  key={item.id}
                  id={`unified-mention-option-${index}`}
                  variant="conversation"
                  active={index === activeIndex}
                  onHover={() => onHover(index)}
                  onSelect={() => onSelect(index)}
                >
                  <div className="relative z-raised flex min-w-0 items-center gap-sm text-[0.82rem] text-text-primary">
                    <AutocompleteMatchText
                      text={item.label}
                      indices={item.matchIndices}
                      className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
                    />
                  </div>
                  <div className="relative z-raised truncate text-[0.7rem] text-text-tertiary">
                    {item.description}
                  </div>
                </AutocompleteOption>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

export const UnifiedMentionPopup = createUnifiedMentionPopup({
  useAllConversations: useAllConversationsQuery,
  useTickets: () => useTicketListQuery({}),
  useSpecs: useSpecPickerSpecs,
});
