"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ConversationsPageParams } from "@/lib/conversations/hrefs";
import { useActiveConversationsQuery } from "@/lib/active-conversations/queries";
import {
  useSidebarSessionFilter,
  useSetSidebarSessionFilter,
} from "@/stores/session-detail.store";
import { useSidebarActiveListFilter } from "@/features/session/hooks/use-sidebar-persistent-filters";
import {
  selectAutoOpenCandidate,
  isConversationPresent,
  conversationSwitchUrl,
  autoOpenUrl,
  clearSelectionUrl,
  stripSessionFilterUrl,
  type AutoOpenSnapshot,
} from "../conversations-page-state";

/**
 * Owns the /conversations selection mechanics (contracts §1.2, §6.3–§6.5):
 * same-page switches via history.pushState, auto-open and disappearance
 * fallback via history.replaceState. Never App Router navigation — that is
 * the point of the page: the shell and rail stay mounted, only the keyed
 * workspace swaps.
 */
export function useConversationsPageSelection(
  params: ConversationsPageParams,
): {
  openConversation: (target: { conversationId: string }) => void;
  autoOpen: AutoOpenSnapshot;
} {
  const activeQuery = useActiveConversationsQuery();
  const storeSessionFilter = useSidebarSessionFilter();
  const conversations = activeQuery.data?.conversations;

  // Until §6.6 seeding strips project/session from the URL, the URL pair is
  // the rail filter; afterwards the store owns it. Using whichever is present
  // keeps auto-open scoped to the filtered session without ordering effects.
  const sessionFilter = params.sessionFilter ?? storeSessionFilter;

  // §6.6 seeding: copy the entry pair into the rail's store filter and switch
  // the rail's list filter to "session" so the pair actually restricts the
  // visible rows (the rail only applies sessionScope under that filter). Both
  // remain clearable through the rail's existing UI. Then strip the params
  // from the URL.
  const setSidebarSessionFilter = useSetSidebarSessionFilter();
  const [, setActiveListFilter] = useSidebarActiveListFilter();
  const seedProjectName = params.sessionFilter?.projectName ?? null;
  const seedSessionName = params.sessionFilter?.sessionName ?? null;
  useEffect(() => {
    if (seedProjectName === null || seedSessionName === null) return;
    setSidebarSessionFilter({
      projectName: seedProjectName,
      sessionName: seedSessionName,
    });
    setActiveListFilter("session");
    window.history.replaceState(
      null,
      "",
      stripSessionFilterUrl(new URLSearchParams(window.location.search)),
    );
  }, [
    seedProjectName,
    seedSessionName,
    setSidebarSessionFilter,
    setActiveListFilter,
  ]);

  const candidateId = useMemo(() => {
    if (params.conversationId !== null || conversations === undefined) {
      return null;
    }
    return selectAutoOpenCandidate(conversations, sessionFilter);
  }, [params.conversationId, conversations, sessionFilter]);

  useEffect(() => {
    if (params.conversationId !== null || candidateId === null) return;
    window.history.replaceState(
      null,
      "",
      autoOpenUrl(new URLSearchParams(window.location.search), candidateId),
    );
  }, [params.conversationId, candidateId]);

  // Disappearance (§6.5) triggers only for a conversation previously seen in
  // the rail data — a deep link to an archived conversation is never in the
  // active feed and must keep rendering, not get cleared.
  const seenIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = params.conversationId;
    if (id === null || conversations === undefined) return;
    if (isConversationPresent(conversations, id)) {
      seenIdRef.current = id;
      return;
    }
    if (seenIdRef.current !== id) return;
    seenIdRef.current = null;
    window.history.replaceState(
      null,
      "",
      clearSelectionUrl(new URLSearchParams(window.location.search)),
    );
  }, [params.conversationId, conversations]);

  const openConversation = useCallback((target: { conversationId: string }) => {
    window.history.pushState(
      null,
      "",
      conversationSwitchUrl(
        new URLSearchParams(window.location.search),
        target.conversationId,
      ),
    );
  }, []);

  return {
    openConversation,
    autoOpen: { isResolved: conversations !== undefined, candidateId },
  };
}
