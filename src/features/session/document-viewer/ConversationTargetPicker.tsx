"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import {
  ConversationAutocompleteList,
  type ConversationAutocompleteListItem,
} from "@/components/ConversationAutocompleteList";
import { filterAndScoreConversations } from "@/lib/conversations/conversation-autocomplete-filter";
import { resolveDisplayLabel } from "@/lib/conversations/display-label";
import { useAllConversationsQuery } from "@/lib/conversations/queries";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import { cn } from "@/lib/ui/cn";
import { targetFromConversation } from "./use-conversation-target";
import type { ConversationTargetDeps } from "./use-conversation-target";
import type { DocumentFeedbackTarget } from "@/lib/document-comments/schemas";

export interface ConversationTargetPickerProps {
  /** The active send target; its label is shown on the trigger. */
  target: DocumentFeedbackTarget | null;
  /** Called with the full routing identity when a conversation is chosen. */
  onSelect: (target: DocumentFeedbackTarget) => void;
  /** The document's project — its conversations sort first in the list. */
  docProjectName?: string | null;
  /** Initial open state (testing / controlled callers). */
  defaultOpen?: boolean;
  /** Label shown on the trigger when no target is selected. */
  placeholder?: string;
}

const searchInputClass =
  "mb-2 w-full rounded-sm border border-solid border-border-default bg-bg-base px-sm py-xs font-mono text-[0.82rem] text-text-primary outline-none placeholder:text-text-tertiary focus:border-cyan";

/**
 * Factory so the conversation-list query can be injected in tests (mirrors the
 * conversation mention popup). The default export wires the real query.
 */
export function createConversationTargetPicker(deps: ConversationTargetDeps) {
  return function ConversationTargetPicker({
    target,
    onSelect,
    docProjectName,
    defaultOpen,
    placeholder = "Choose conversation",
  }: ConversationTargetPickerProps) {
    const listboxId = useId();
    const [open, setOpen] = useState(defaultOpen ?? false);
    const [query, setQuery] = useState("");
    const [includeArchived, setIncludeArchived] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);

    const queryResult = deps.useAllConversations({ includeArchived });
    const allItems = useMemo(
      () => queryResult.data?.items ?? [],
      [queryResult.data],
    );

    const filterResult = useMemo(
      () =>
        filterAndScoreConversations(query, allItems, {
          currentProjectName: docProjectName ?? null,
          currentConversationId: null,
        }),
      [query, allItems, docProjectName],
    );

    const listItems = useMemo<ConversationAutocompleteListItem[]>(
      () =>
        filterResult.items.map((scored) => {
          const it = scored.item;
          return {
            id: it.conversationId,
            displayLabel: resolveDisplayLabel({
              conversationName: it.conversationName,
              summary: it.summary,
              firstPromptSnippet: it.firstPromptSnippet,
              conversationId: it.conversationId,
            }),
            matchIndices: scored.indices,
            projectName: it.projectName,
            sessionName: it.sessionName,
            backend: it.backend,
            model: null,
            lastActivityRelative: formatRelativeTime(it.lastActivityAt, {
              style: "short",
            }),
            status: it.status,
            isCurrentProject: it.projectName === docProjectName,
            archived: it.archived,
          };
        }),
      [filterResult.items, docProjectName],
    );

    // Reset the active row whenever the visible list changes (mirrors the
    // mention popup) so Enter never selects a stale index.
    const resetKey = `${query}:${listItems.length}:${includeArchived}`;
    const [prevResetKey, setPrevResetKey] = useState(resetKey);
    if (resetKey !== prevResetKey) {
      setPrevResetKey(resetKey);
      setActiveIndex(0);
    }

    const filteredRef = useRef(filterResult.items);
    filteredRef.current = filterResult.items;

    const selectAt = useCallback(
      (index: number) => {
        const scored = filteredRef.current[index];
        if (!scored) return;
        onSelect(targetFromConversation(scored.item));
        setOpen(false);
        setQuery("");
      },
      [onSelect],
    );

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        const total = filteredRef.current.length;
        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            setActiveIndex((prev) =>
              Math.min(prev + 1, Math.max(total - 1, 0)),
            );
            break;
          case "ArrowUp":
            event.preventDefault();
            setActiveIndex((prev) => Math.max(prev - 1, 0));
            break;
          case "Enter":
            if (total === 0) break;
            event.preventDefault();
            selectAt(activeIndex);
            break;
          default:
            break;
        }
      },
      [activeIndex, selectAt],
    );

    const triggerLabel = useMemo(() => {
      if (!target) return placeholder;
      const found = allItems.find(
        (it) => it.conversationId === target.conversationId,
      );
      return found
        ? resolveDisplayLabel({
            conversationName: found.conversationName,
            summary: found.summary,
            firstPromptSnippet: found.firstPromptSnippet,
            conversationId: found.conversationId,
          })
        : target.conversationId;
    }, [target, allItems, placeholder]);

    const error = queryResult.isError ? "Failed to load conversations" : null;

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="default" size="sm">
            <span className="max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap">
              {triggerLabel}
            </span>
            <span aria-hidden className="text-text-tertiary">
              ▾
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent layoutClassName="w-[360px]">
          <input
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-label="Search conversations"
            className={cn(searchInputClass)}
            placeholder="Search conversations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div id={listboxId}>
            <ConversationAutocompleteList
              items={listItems}
              selectedIndex={activeIndex}
              onHover={setActiveIndex}
              onSelect={(item) => {
                const idx = listItems.findIndex((i) => i.id === item.id);
                if (idx >= 0) selectAt(idx);
              }}
              totalCount={filterResult.totalCount}
              loading={queryResult.isLoading}
              error={error}
              includeArchived={includeArchived}
              onToggleArchived={() => setIncludeArchived((prev) => !prev)}
            />
          </div>
        </PopoverContent>
      </Popover>
    );
  };
}

export const ConversationTargetPicker = createConversationTargetPicker({
  useAllConversations: useAllConversationsQuery,
});
