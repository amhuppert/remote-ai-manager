// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ActiveConversation,
  ActiveConversationsResponse,
} from "@/lib/active-conversations/schemas";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { OPEN_TABS_STORAGE_KEY } from "@/features/session/tabs/use-open-tabs";
import type { ConversationsPageParams } from "@/lib/conversations/hrefs";
import { useConversationsPageSelection } from "./use-conversations-page-selection";

function sessionRow(
  id: string,
  overrides: Partial<{
    name: string;
    lastActivityAt: string;
    projectName: string;
    sessionName: string;
  }> = {},
): ActiveConversation {
  return {
    scope: "session",
    id,
    name: overrides.name ?? id,
    status: "awaiting",
    lastActivityAt: overrides.lastActivityAt ?? "2026-06-01T00:00:00.000Z",
    projectName: overrides.projectName ?? "repo",
    projectPath: "/projects/repo",
    sessionName: overrides.sessionName ?? "fix-bug",
    branchName: "csm/fix-bug",
    worktreePath: "/projects/repo/.worktrees/fix-bug",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    backgroundActivity: null,
  };
}

function activeData(
  conversations: ActiveConversation[],
): ActiveConversationsResponse {
  return {
    conversations,
    graphWorkflowExecutions: [],
    activeCollaborationExecutions: [],
    specExecutions: [],
  };
}

function params(
  overrides: Partial<ConversationsPageParams> = {},
): ConversationsPageParams {
  return {
    conversationId: overrides.conversationId ?? null,
    messageId: overrides.messageId ?? null,
    sessionFilter: overrides.sessionFilter ?? null,
    autoFocus: overrides.autoFocus ?? false,
  };
}

function renderSelection(args: {
  url: string;
  active?: ActiveConversationsResponse;
  pageParams: ConversationsPageParams;
}) {
  window.history.replaceState(null, "", args.url);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  if (args.active !== undefined) {
    queryClient.setQueryData(conversationKeys.active(), args.active);
  }
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  // The harness's own URL-setup replaceState above must not pollute the spy's
  // call record, which tests inspect for selection-driven rewrites.
  replaceStateSpy.mockClear();
  pushStateSpy.mockClear();
  return renderHook(() => useConversationsPageSelection(args.pageParams), {
    wrapper,
  });
}

let pushStateSpy: ReturnType<typeof vi.spyOn>;
let replaceStateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  window.localStorage.clear();
  useSessionDetailStore.getState().resetStore();
  pushStateSpy = vi.spyOn(window.history, "pushState");
  replaceStateSpy = vi.spyOn(window.history, "replaceState");
});

afterEach(() => {
  pushStateSpy.mockRestore();
  replaceStateSpy.mockRestore();
  window.history.replaceState(null, "", "/conversations");
  useSessionDetailStore.getState().resetStore();
  window.localStorage.clear();
});

describe("useConversationsPageSelection", () => {
  it("restores the persisted last-active (lru tail) via replaceState, never pushState (1.8)", async () => {
    // A persisted multi-tab set whose lru tail is a LIVE session id, with NO
    // ?c= and NO session filter → the tail must be restored on entry.
    window.localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b"], lru: ["a", "b"] }),
    );

    renderSelection({
      url: "/conversations",
      active: activeData([
        sessionRow("a", {
          name: "Alpha",
          lastActivityAt: "2026-06-09T00:00:00.000Z",
        }),
        sessionRow("b", {
          name: "Beta",
          lastActivityAt: "2026-06-01T00:00:00.000Z",
        }),
      ]),
      pageParams: params(),
    });

    // Restore targets "b" (the lru tail / last-active) even though "a" is the
    // generic most-recent by lastActivityAt — last-active beats most-recent.
    await waitFor(() => expect(window.location.search).toBe("?c=b"));
    expect(replaceStateSpy).toHaveBeenCalled();
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  it("leaves an explicit ?c= selection untouched (1.2)", async () => {
    window.localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b"], lru: ["a", "b"] }),
    );

    renderSelection({
      url: "/conversations?c=X",
      active: activeData([sessionRow("a"), sessionRow("b")]),
      pageParams: params({ conversationId: "X" }),
    });

    // Give effects time to (not) fire; the URL must keep the explicit selection
    // and no replaceState may change it to a different conversation.
    await waitFor(() => expect(replaceStateSpy).not.toHaveBeenCalled());
    expect(window.location.search).toBe("?c=X");
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  it("opens the session-scoped candidate when a session filter is active, not the generic most-recent", async () => {
    useSessionDetailStore.getState().setSidebarSessionFilter({
      projectName: "repo",
      sessionName: "side-quest",
    });

    renderSelection({
      url: "/conversations",
      active: activeData([
        sessionRow("conv-main", {
          name: "Main",
          lastActivityAt: "2026-06-09T00:00:00.000Z",
        }),
        sessionRow("conv-side", {
          name: "Side",
          sessionName: "side-quest",
          lastActivityAt: "2026-06-01T00:00:00.000Z",
        }),
      ]),
      pageParams: params(),
    });

    // conv-main is more recent globally, but the filter restricts the candidate
    // to the side-quest session.
    await waitFor(() => expect(window.location.search).toBe("?c=conv-side"));
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  it("does not restore before the active-conversations query resolves (hydration gate)", async () => {
    // No active data seeded → conversations is undefined; the persisted lru
    // tail must NOT be applied yet.
    window.localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b"], lru: ["a", "b"] }),
    );

    const { result } = renderSelection({
      url: "/conversations",
      pageParams: params(),
    });

    await waitFor(() => expect(result.current.openTabs.hydrated).toBe(true));
    // Even after localStorage hydrated, with no live list there is no restore.
    expect(window.location.search).toBe("");
    expect(result.current.autoOpen.isResolved).toBe(false);
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("restores the persisted last-active ahead of the generic most-recent (no premature flash)", async () => {
    // The generic most-recent is "a"; the persisted last-active is "b". The
    // restore must land on "b", proving the persisted tail wins over the
    // generic auto-open rather than the page flashing "a" first.
    window.localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b"], lru: ["a", "b"] }),
    );

    renderSelection({
      url: "/conversations",
      active: activeData([
        sessionRow("a", {
          name: "Alpha",
          lastActivityAt: "2026-06-09T00:00:00.000Z",
        }),
        sessionRow("b", {
          name: "Beta",
          lastActivityAt: "2026-06-01T00:00:00.000Z",
        }),
      ]),
      pageParams: params(),
    });

    await waitFor(() => expect(window.location.search).toBe("?c=b"));
    // The URL must never have transiently been the generic most-recent "a".
    for (const call of replaceStateSpy.mock.calls) {
      expect(call[2]).not.toBe("/conversations?c=a");
    }
  });

  it("does not wipe the persisted working set when the active-conversations query resolves after first render (1.7, 1.8)", async () => {
    // Reload repro: a persisted multi-tab set, and a ?c=b deep link, while the
    // active-conversations query is unresolved on first render (conversations
    // === undefined → sessionScoped === []). The hook must pass
    // activeConversationsLoaded:false so reconcile is deferred; once the query
    // resolves with the full live list the persisted set must survive intact,
    // not collapse to {b} or empty.
    window.localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b", "c"], lru: ["a", "b", "c"] }),
    );

    window.history.replaceState(null, "", "/conversations?c=b");
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    replaceStateSpy.mockClear();
    pushStateSpy.mockClear();

    const { result } = renderHook(
      () => useConversationsPageSelection(params({ conversationId: "b" })),
      { wrapper },
    );

    // Query unresolved on first render: localStorage hydrates, but the live
    // list is unknown, so reconcile is deferred and the persisted display set is
    // intact. The add-or-bump effect may bump the active id "b" in lru, so the
    // lru id SET — not its order — is asserted.
    await waitFor(() => expect(result.current.openTabs.hydrated).toBe(true));
    const persistedWhileLoading = JSON.parse(
      window.localStorage.getItem(OPEN_TABS_STORAGE_KEY) as string,
    ) as { tabs: string[]; lru: string[] };
    expect(persistedWhileLoading.tabs).toEqual(["a", "b", "c"]);
    expect([...persistedWhileLoading.lru].sort()).toEqual(["a", "b", "c"]);

    // Query resolves with the full live list → reconcile runs but drops nothing.
    queryClient.setQueryData(
      conversationKeys.active(),
      activeData([sessionRow("a"), sessionRow("b"), sessionRow("c")]),
    );

    await waitFor(() =>
      expect(result.current.openTabs.workingSet.map((c) => c.id)).toEqual([
        "a",
        "b",
        "c",
      ]),
    );
    const persistedAfterResolve = JSON.parse(
      window.localStorage.getItem(OPEN_TABS_STORAGE_KEY) as string,
    ) as { tabs: string[]; lru: string[] };
    expect(persistedAfterResolve.tabs).toEqual(["a", "b", "c"]);
    expect([...persistedAfterResolve.lru].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns the openTabs working set", async () => {
    window.localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a"], lru: ["a"] }),
    );

    const { result } = renderSelection({
      url: "/conversations?c=a",
      active: activeData([sessionRow("a", { name: "Alpha" })]),
      pageParams: params({ conversationId: "a" }),
    });

    await waitFor(() =>
      expect(result.current.openTabs.workingSet.map((c) => c.id)).toEqual([
        "a",
      ]),
    );
  });
});
