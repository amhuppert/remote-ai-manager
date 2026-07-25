"use client";

import { useCallback, useMemo, useState } from "react";
import { useAllConversationsQuery } from "@/lib/conversations/queries";
import { OPEN_TABS_STORAGE_KEY } from "../tabs/use-open-tabs";
import type {
  AllConversationsResponse,
  ConversationListItem,
  SessionConversationListItem,
} from "@/lib/conversations/schemas";
import type { DocumentFeedbackTarget } from "@/lib/document-comments/schemas";

/**
 * Derive the full send-routing identity from a conversation list item. The
 * picker lists conversations cross-project while the prompt/queue routes are
 * project/session-scoped, so a bare conversation id cannot route a send — the
 * target must carry project, project path, session, conversation, backend, and
 * status (Requirement 9.4).
 */
export function targetFromConversation(
  item: SessionConversationListItem,
): DocumentFeedbackTarget {
  return {
    projectName: item.projectName,
    projectPath: item.projectPath,
    sessionName: item.sessionName,
    conversationId: item.conversationId,
    backend: item.backend,
    status: item.status,
  };
}

/**
 * Choose the default target: the most-recently-viewed conversation (the LRU
 * tail of `cc-open-tabs`) that is still live, walking tail→head so a stale id no
 * longer in the list is skipped. When no LRU id is live, fall back to the
 * most-recent-by-activity conversation. Returns null when nothing is available
 * to target (Requirements 9.2, 9.5). Pure.
 */
export function pickDefaultTarget(
  items: readonly ConversationListItem[],
  lru: readonly string[],
): DocumentFeedbackTarget | null {
  // Document feedback is a SESSION capability (its target is keyed by
  // project/session/doc path), so project conversations are not targetable and
  // are filtered out here rather than being projected into a session shape.
  const targetable = items.filter(
    (item): item is SessionConversationListItem => item.scope === "session",
  );
  if (targetable.length === 0) return null;

  const byId = new Map(targetable.map((item) => [item.conversationId, item]));
  for (let i = lru.length - 1; i >= 0; i -= 1) {
    const candidate = byId.get(lru[i] ?? "");
    if (candidate) return targetFromConversation(candidate);
  }

  // Activity fallback: ISO 8601 timestamps sort lexicographically.
  let mostRecent: SessionConversationListItem | null = null;
  for (const item of targetable) {
    if (mostRecent === null || item.lastActivityAt > mostRecent.lastActivityAt) {
      mostRecent = item;
    }
  }
  return mostRecent === null ? null : targetFromConversation(mostRecent);
}

/**
 * Read the persisted `cc-open-tabs` recency order (least → most recent) from
 * localStorage. The tail is the most-recently-viewed conversation. Read once on
 * mount; malformed/absent storage yields an empty order so the default falls
 * back to activity recency.
 */
function readPersistedLru(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(OPEN_TABS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { lru?: unknown }).lru)
    ) {
      const lru = (parsed as { lru: unknown[] }).lru;
      return lru.filter((id): id is string => typeof id === "string");
    }
    return [];
  } catch {
    return [];
  }
}

export interface ConversationTargetQuery {
  data: AllConversationsResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

export interface ConversationTargetDeps {
  useAllConversations: (params: {
    includeArchived: boolean;
  }) => ConversationTargetQuery;
}

export interface ConversationTargetApi {
  /** The active send target: the explicit choice, else the recency default. */
  target: DocumentFeedbackTarget | null;
  /** Choose a target explicitly; it sticks until changed (Requirement 9.4). */
  setTarget: (target: DocumentFeedbackTarget) => void;
  /** The recency default, exposed so callers can reset to it. */
  defaultTarget: DocumentFeedbackTarget | null;
  isLoading: boolean;
}

/**
 * Factory so the conversation-list query can be injected in tests (mirrors the
 * conversation mention popup). The default export wires the real query.
 */
export function createUseConversationTarget(
  deps: ConversationTargetDeps,
): () => ConversationTargetApi {
  return function useConversationTarget(): ConversationTargetApi {
    const { data, isLoading } = deps.useAllConversations({
      includeArchived: false,
    });
    const items = useMemo(() => data?.items ?? [], [data]);
    // The recency order is fixed at mount: the default is computed once and a
    // later explicit choice takes over (Requirement 9.4).
    const [lru] = useState<string[]>(readPersistedLru);
    const [chosen, setChosen] = useState<DocumentFeedbackTarget | null>(null);

    const defaultTarget = useMemo(
      () => pickDefaultTarget(items, lru),
      [items, lru],
    );

    const setTarget = useCallback((next: DocumentFeedbackTarget) => {
      setChosen(next);
    }, []);

    return {
      target: chosen ?? defaultTarget,
      setTarget,
      defaultTarget,
      isLoading,
    };
  };
}

export const useConversationTarget = createUseConversationTarget({
  useAllConversations: useAllConversationsQuery,
});
