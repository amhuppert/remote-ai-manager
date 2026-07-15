"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ConversationsPageParams } from "@/lib/conversations/hrefs";
import { useActiveConversationsQuery } from "@/lib/active-conversations/queries";
import {
  useSidebarSessionFilter,
  useSetSidebarSessionFilter,
} from "@/stores/session-detail.store";
import { useSidebarActiveListFilter } from "@/hooks/use-sidebar-persistent-filters";
import {
  useOpenTabs,
  type OpenTabsApi,
} from "@/features/session/tabs/use-open-tabs";
import {
  selectInitialConversation,
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
  openTabs: OpenTabsApi;
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

  // The working set is session-scoped only: project-scoped active conversations
  // are not workspace-openable, so they never enter tabs/panes.
  const sessionScoped = useMemo(
    () => (conversations ?? []).filter((c) => c.scope === "session"),
    [conversations],
  );

  const openTabs = useOpenTabs({
    activeConversationId: params.conversationId ?? "",
    activeConversations: sessionScoped,
    // `sessionScoped` is `[]` both while the query loads AND when it genuinely
    // returns no session conversations; `useOpenTabs` cannot tell them apart on
    // its own. Pass the query-resolved signal so reconcile waits for the live
    // list instead of wiping the persisted set against a not-yet-loaded empty
    // list on first render (Requirement 1.8).
    activeConversationsLoaded: conversations !== undefined,
    onOpenConversation: openConversation,
  });

  // Initial-selection precedence (§1.2, §1.8): an explicit `?c=` is left as-is;
  // a session-filter entry opens its session candidate; otherwise the persisted
  // last-active (lru tail) is restored ahead of the generic most-recent. Gated
  // on both the live list AND the persisted model so restore never loses a race
  // to the generic auto-open before localStorage hydrates.
  const initial = useMemo(() => {
    if (conversations === undefined || !openTabs.hydrated) return null;
    return selectInitialConversation({
      urlConversationId: params.conversationId,
      sessionFilter,
      persistedLruLive: openTabs.persistedLruLive,
      conversations,
    });
  }, [
    conversations,
    openTabs.hydrated,
    openTabs.persistedLruLive,
    params.conversationId,
    sessionFilter,
  ]);
  const restoreId = initial?.kind === "auto" ? initial.id : null;

  // Restore is non-user-initiated, so it MUST use replaceState (never
  // pushState) — it adds no Back-history entry.
  useEffect(() => {
    if (restoreId === null) return;
    window.history.replaceState(
      null,
      "",
      autoOpenUrl(new URLSearchParams(window.location.search), restoreId),
    );
  }, [restoreId]);

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

  return {
    openConversation,
    // `isResolved` waits for hydration too: the render-state machine shows
    // loading (not the generic most-recent) until the persisted last-active
    // restore has had its chance, so the page never flashes the wrong tab.
    autoOpen: {
      isResolved: conversations !== undefined && openTabs.hydrated,
      candidateId: restoreId,
    },
    openTabs,
  };
}
