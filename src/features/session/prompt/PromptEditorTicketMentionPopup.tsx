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
  TicketAutocompleteList,
  type TicketAutocompleteListItem,
} from "@/components/TicketAutocompleteList";
import type { TicketMentionAttrs } from "@/lib/prompt-editor";
import { formatTicketIdentifier } from "@/lib/tickets/references";
import {
  filterAndScoreTickets,
  type TicketFilterResult,
} from "@/lib/tickets/ticket-autocomplete-filter";
import { useTicketListQuery } from "@/lib/tickets/queries";
import type { TicketListItem } from "@/lib/tickets/schemas";

export interface TicketMentionPopupHandle {
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

export type TicketMentionSelection = TicketMentionAttrs;

export interface TicketMentionPopupProps {
  query: string;
  currentProjectName: string;
  onSelect: (selection: TicketMentionSelection) => void;
  onClose?: () => void;
}

interface QueryShape {
  data: TicketListItem[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
}

export interface TicketMentionPopupDeps {
  useTickets: () => QueryShape;
}

export function createTicketMentionPopup(
  deps: TicketMentionPopupDeps,
): ForwardRefExoticComponent<
  TicketMentionPopupProps & RefAttributes<TicketMentionPopupHandle>
> {
  return forwardRef<TicketMentionPopupHandle, TicketMentionPopupProps>(
    function PromptEditorTicketMentionPopup(
      { query, currentProjectName, onSelect, onClose },
      ref,
    ) {
      const queryResult = deps.useTickets();
      const filterResult = useMemo<TicketFilterResult>(
        () =>
          filterAndScoreTickets(query, queryResult.data ?? [], {
            currentProjectName,
          }),
        [currentProjectName, query, queryResult.data],
      );
      const listItems = useMemo<TicketAutocompleteListItem[]>(
        () =>
          filterResult.items.map(({ item, titleMatchIndices }) => ({
            id: item.id,
            identifier: formatTicketIdentifier(item.projectName, item.number),
            title: item.title,
            titleMatchIndices,
            projectName: item.projectName,
            workType: item.workType,
            status: item.status,
            attachmentCount: item.attachmentCount,
            activeSessionName: item.activeSessionName,
            isCurrentProject: item.projectName === currentProjectName,
          })),
        [currentProjectName, filterResult.items],
      );

      const [activeIndex, setActiveIndex] = useState(0);
      const resetKey = `${query}:${listItems.length}`;
      const [previousResetKey, setPreviousResetKey] = useState(resetKey);
      if (resetKey !== previousResetKey) {
        setPreviousResetKey(resetKey);
        setActiveIndex(0);
      }

      const activeIndexRef = useRef(activeIndex);
      const filteredItemsRef = useRef(filterResult.items);
      useEffect(() => {
        activeIndexRef.current = activeIndex;
      }, [activeIndex]);
      useEffect(() => {
        filteredItemsRef.current = filterResult.items;
      }, [filterResult.items]);

      const selectAt = useCallback(
        (index: number) => {
          const target = filteredItemsRef.current[index]?.item;
          if (!target) return;
          onSelect({
            projectName: target.projectName,
            ticketNumber: String(target.number),
            identifier: formatTicketIdentifier(
              target.projectName,
              target.number,
            ),
            title: target.title,
          });
        },
        [onSelect],
      );

      const handleKeyDown = useCallback(
        (event: KeyboardEvent): boolean => {
          const total = filteredItemsRef.current.length;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((previous) => {
              const next = Math.min(previous + 1, Math.max(total - 1, 0));
              activeIndexRef.current = next;
              return next;
            });
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((previous) => {
              const next = Math.max(previous - 1, 0);
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
        [onClose, selectAt],
      );

      useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

      const error = queryResult.isError
        ? (queryResult.error?.message ?? "Failed to load tickets")
        : null;

      return (
        <TicketAutocompleteList
          items={listItems}
          selectedIndex={activeIndex}
          onHover={setActiveIndex}
          onSelect={(item) => {
            const index = listItems.findIndex(
              (candidate) => candidate.id === item.id,
            );
            if (index >= 0) selectAt(index);
          }}
          totalCount={filterResult.totalCount}
          loading={queryResult.isLoading}
          error={error}
        />
      );
    },
  );
}

export const PromptEditorTicketMentionPopup = createTicketMentionPopup({
  useTickets: () => useTicketListQuery({}),
});
