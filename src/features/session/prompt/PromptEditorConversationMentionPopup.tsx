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
  ConversationAutocompleteList,
  type ConversationAutocompleteListItem,
} from "@/components/ConversationAutocompleteList";
import { filterAndScoreConversations } from "@/lib/conversations/conversation-autocomplete-filter";
import { resolveDisplayLabel } from "@/lib/conversations/display-label";
import { useAllConversationsQuery } from "@/lib/conversations/queries";
import type {
  AllConversationsResponse,
  ConversationCompactStatus,
  ConversationListItem,
} from "@/lib/conversations/schemas";

export interface ConversationMentionPopupHandle {
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

export interface ConversationMentionSelection {
  projectName: string;
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  conversationId: string;
  conversationName: string;
  backend: "claude" | "codex";
  backendRef: string;
  transcriptPath: string;
  debugLogPath: string;
  status: ConversationListItem["status"];
  lastActivityAt: string;
  /** Empty string when no completed conversation compaction exists. */
  compactArtifactId: string;
  compactStatus: ConversationCompactStatus;
  /** Covered seq range "<start>..<end>"; empty string when no compaction. */
  compactCoveredSeq: string;
  /** ISO timestamp; empty string when no compaction. */
  compactCreatedAt: string;
}

export interface ConversationMentionPopupProps {
  query: string;
  currentProjectName: string;
  currentConversationId: string;
  onSelect: (selection: ConversationMentionSelection) => void;
  /** Dismiss the popup (Escape). Host should clear its suggestion state. */
  onClose?: () => void;
}

interface QueryShape {
  data: AllConversationsResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
}

export interface ConversationMentionPopupDeps {
  useAllConversations: (params: { includeArchived: boolean }) => QueryShape;
}

function backendRefToString(ref: ConversationListItem["backendRef"]): string {
  if (ref === null) return "";
  if (ref.backend === "claude") return ref.sessionId;
  return ref.threadId;
}

function toSelection(item: ConversationListItem): ConversationMentionSelection {
  return {
    projectName: item.projectName,
    projectPath: item.projectPath,
    sessionName: item.sessionName,
    worktreePath: item.worktreePath,
    conversationId: item.conversationId,
    conversationName: item.conversationName ?? "",
    backend: item.backend,
    backendRef: backendRefToString(item.backendRef),
    transcriptPath: item.transcriptPath ?? "",
    debugLogPath: item.debugLogPath ?? "",
    status: item.status,
    lastActivityAt: item.lastActivityAt,
    compactArtifactId: item.compactArtifactId ?? "",
    compactStatus: item.compactStatus ?? "none",
    compactCoveredSeq: item.compactCoveredSeq ?? "",
    compactCreatedAt: item.compactCreatedAt ?? "",
  };
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function createConversationMentionPopup(
  deps: ConversationMentionPopupDeps,
): ForwardRefExoticComponent<
  ConversationMentionPopupProps & RefAttributes<ConversationMentionPopupHandle>
> {
  return forwardRef<
    ConversationMentionPopupHandle,
    ConversationMentionPopupProps
  >(function PromptEditorConversationMentionPopup(
    { query, currentProjectName, currentConversationId, onSelect, onClose },
    ref,
  ) {
    const [includeArchived, setIncludeArchived] = useState(false);
    const queryResult = deps.useAllConversations({ includeArchived });

    const allItems = queryResult.data?.items ?? [];

    const filterResult = useMemo(
      () =>
        filterAndScoreConversations(query, allItems, {
          currentProjectName,
          currentConversationId,
        }),
      [query, allItems, currentProjectName, currentConversationId],
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
            lastActivityRelative: formatRelative(it.lastActivityAt),
            status: it.status,
            isCurrentProject: it.projectName === currentProjectName,
            archived: it.archived,
            compactFresh: it.compactStatus === "fresh",
          };
        }),
      [filterResult.items, currentProjectName],
    );

    const [activeIndex, setActiveIndex] = useState(0);
    const resetKey = `${query}:${listItems.length}:${includeArchived}`;
    const [prevResetKey, setPrevResetKey] = useState(resetKey);
    if (resetKey !== prevResetKey) {
      setPrevResetKey(resetKey);
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
        const target = filteredItemsRef.current[index];
        if (!target) return;
        onSelect(toSelection(target.item));
      },
      [onSelect],
    );

    const toggleArchived = useCallback(() => {
      setIncludeArchived((prev) => !prev);
    }, []);

    const handleKeyDown = useCallback(
      (event: KeyboardEvent): boolean => {
        const total = filteredItemsRef.current.length;
        if (event.altKey && (event.key === "a" || event.key === "A")) {
          event.preventDefault();
          toggleArchived();
          return true;
        }
        switch (event.key) {
          case "ArrowDown": {
            event.preventDefault();
            setActiveIndex((prev) =>
              Math.min(prev + 1, Math.max(total - 1, 0)),
            );
            return true;
          }
          case "ArrowUp": {
            event.preventDefault();
            setActiveIndex((prev) => Math.max(prev - 1, 0));
            return true;
          }
          case "Enter":
          case "Tab": {
            if (total === 0) return false;
            event.preventDefault();
            selectAt(activeIndexRef.current);
            return true;
          }
          case "Escape": {
            event.preventDefault();
            event.stopPropagation();
            onClose?.();
            return true;
          }
          default:
            return false;
        }
      },
      [selectAt, toggleArchived, onClose],
    );

    useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

    const error = queryResult.isError
      ? (queryResult.error?.message ?? "Failed to load conversations")
      : null;

    return (
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
        onToggleArchived={toggleArchived}
      />
    );
  });
}

export const PromptEditorConversationMentionPopup =
  createConversationMentionPopup({
    useAllConversations: useAllConversationsQuery,
  });
