// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import {
  useOpenTabs,
  OPEN_TABS_STORAGE_KEY,
  type OpenTabsApi,
} from "./use-open-tabs";

function convo(id: string): SessionActiveConversation {
  return {
    scope: "session",
    id,
    name: `Conversation ${id}`,
    status: "running",
    lastActivityAt: "2026-06-14T00:00:00.000Z",
    projectName: "proj",
    projectPath: "/tmp/proj",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/tmp/proj/.worktrees/x",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    sessionName: `session-${id}`,
    branchName: `csm/${id}`,
  };
}

function ids(api: OpenTabsApi): string[] {
  return api.workingSet.map((c) => c.id);
}

beforeEach(() => {
  localStorage.clear();
});

describe("useOpenTabs", () => {
  it("resolves an ordered working set including the active conversation (1.1, 1.3)", () => {
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b"), convo("c")];
    const { result } = renderHook(() =>
      useOpenTabs({
        activeConversationId: "a",
        activeConversations: list,
        activeConversationsLoaded: true,
        onOpenConversation,
      }),
    );

    expect(ids(result.current)).toContain("a");
    expect(result.current.activeId).toBe("a");
  });

  it("preserves display (insertion) order as different tabs are activated (1.1)", () => {
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b"), convo("c")];
    const { result, rerender } = renderHook(
      ({ activeId }) =>
        useOpenTabs({
          activeConversationId: activeId,
          activeConversations: list,
          activeConversationsLoaded: true,
          onOpenConversation,
        }),
      { initialProps: { activeId: "c" } },
    );

    rerender({ activeId: "a" });
    rerender({ activeId: "b" });

    expect(ids(result.current)).toEqual(["c", "a", "b"]);
  });

  it("adds a conversation to the set when navigation makes it active (1.4)", () => {
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b"), convo("c")];
    const { result, rerender } = renderHook(
      ({ activeId }) =>
        useOpenTabs({
          activeConversationId: activeId,
          activeConversations: list,
          activeConversationsLoaded: true,
          onOpenConversation,
        }),
      { initialProps: { activeId: "a" } },
    );

    expect(ids(result.current)).toEqual(["a"]);

    rerender({ activeId: "b" });

    expect(ids(result.current)).toContain("b");
    expect(ids(result.current)).toEqual(["a", "b"]);
  });

  it("restores the working set from localStorage on a fresh mount (1.8)", () => {
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b"), convo("c")];

    const first = renderHook(
      ({ activeId }) =>
        useOpenTabs({
          activeConversationId: activeId,
          activeConversations: list,
          activeConversationsLoaded: true,
          onOpenConversation,
        }),
      { initialProps: { activeId: "a" } },
    );
    first.rerender({ activeId: "b" });
    expect(ids(first.result.current)).toEqual(["a", "b"]);
    first.unmount();

    // Fresh hook instance, no active id — must restore from persisted storage,
    // not start empty.
    const second = renderHook(() =>
      useOpenTabs({
        activeConversationId: "",
        activeConversations: list,
        activeConversationsLoaded: true,
        onOpenConversation,
      }),
    );

    expect(ids(second.result.current)).toEqual(["a", "b"]);
  });

  it("restores a multi-tab set on reload when the active id is already in the persisted set (1.8)", async () => {
    // Reproduces a real page reload: the URL carries ?c=<id>, so the hook
    // mounts with a NON-EMPTY active id, while localStorage already holds a
    // multi-tab set. The persisted set must be restored intact — the active id
    // must NOT collapse the set down to just itself.
    localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b", "c"], lru: ["a", "b", "c"] }),
    );
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b"), convo("c")];

    const { result } = renderHook(() =>
      useOpenTabs({
        activeConversationId: "b",
        activeConversations: list,
        activeConversationsLoaded: true,
        onOpenConversation,
      }),
    );

    await waitFor(() => expect(ids(result.current)).toEqual(["a", "b", "c"]));
  });

  it("does not wipe the persisted set while the active list is still loading, then survives once it loads (1.7, 1.8)", async () => {
    // Repro for the live-found reload bug: on first render the
    // active-conversations query has not resolved, so the page passes
    // `activeConversations: []` (transiently empty, NOT genuinely empty). The
    // reconcile effect must NOT run against that empty list — doing so would
    // drop every tab and persist an empty set. Gating reconcile on
    // `activeConversationsLoaded` defers it until the live list is known.
    localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b", "c"], lru: ["a", "b", "c"] }),
    );
    const onOpenConversation = vi.fn();

    // Fresh mount mirroring a reload with ?c=b while the query is unresolved.
    const { rerender } = renderHook(
      ({
        list,
        loaded,
      }: {
        list: SessionActiveConversation[];
        loaded: boolean;
      }) =>
        useOpenTabs({
          activeConversationId: "b",
          activeConversations: list,
          activeConversationsLoaded: loaded,
          onOpenConversation,
        }),
      {
        initialProps: {
          list: [] as SessionActiveConversation[],
          loaded: false,
        },
      },
    );

    // Flush effects: with the list not loaded, reconcile must be deferred, so
    // the persisted display set on disk is untouched (NOT collapsed to {b} or
    // wiped). The add-or-bump effect may legitimately bump the active id "b" to
    // the most-recent end of lru, so the lru id SET — not its order — is what
    // must be preserved.
    await waitFor(() => {
      const persisted = localStorage.getItem(OPEN_TABS_STORAGE_KEY);
      expect(persisted).not.toBeNull();
      const model = JSON.parse(persisted as string) as {
        tabs: string[];
        lru: string[];
      };
      expect(model.tabs).toEqual(["a", "b", "c"]);
      expect([...model.lru].sort()).toEqual(["a", "b", "c"]);
    });

    // Query resolves with the full live list → reconcile runs, set survives.
    rerender({ list: [convo("a"), convo("b"), convo("c")], loaded: true });
    await waitFor(() => {
      const model = JSON.parse(
        localStorage.getItem(OPEN_TABS_STORAGE_KEY) as string,
      ) as { tabs: string[]; lru: string[] };
      expect(model.tabs).toEqual(["a", "b", "c"]);
      expect([...model.lru].sort()).toEqual(["a", "b", "c"]);
    });
  });

  it("reconciles away a stale tab once the active list resolves missing it (1.7)", async () => {
    // Once the live list is loaded, reconcile still drops genuinely-stale ids:
    // "c" is no longer in the live list, so it must leave both orders.
    localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b", "c"], lru: ["a", "b", "c"] }),
    );
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b")];

    const { result } = renderHook(() =>
      useOpenTabs({
        activeConversationId: "b",
        activeConversations: list,
        activeConversationsLoaded: true,
        onOpenConversation,
      }),
    );

    await waitFor(() => {
      expect(ids(result.current)).toEqual(["a", "b"]);
      expect(
        JSON.parse(localStorage.getItem(OPEN_TABS_STORAGE_KEY) as string),
      ).toEqual({
        tabs: ["a", "b"],
        lru: ["a", "b"],
      });
    });
  });

  it("adds the active id to the restored set without replacing it when it was not persisted (1.8)", async () => {
    // Reload where the active conversation (?c=c) is not yet in the persisted
    // set {a, b}. The restored set must keep a and b AND gain c — it must not
    // be wiped down to just the active id.
    localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b"], lru: ["a", "b"] }),
    );
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b"), convo("c")];

    const { result } = renderHook(() =>
      useOpenTabs({
        activeConversationId: "c",
        activeConversations: list,
        activeConversationsLoaded: true,
        onOpenConversation,
      }),
    );

    await waitFor(() => {
      const restored = ids(result.current);
      expect(restored).toContain("a");
      expect(restored).toContain("b");
      expect(restored).toContain("c");
    });
  });

  it("restores a set built across rerenders after an unmount/remount reload (1.8)", async () => {
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b"), convo("c")];

    const first = renderHook(
      ({ activeId }) =>
        useOpenTabs({
          activeConversationId: activeId,
          activeConversations: list,
          activeConversationsLoaded: true,
          onOpenConversation,
        }),
      { initialProps: { activeId: "a" } },
    );
    first.rerender({ activeId: "b" });
    first.rerender({ activeId: "c" });
    expect(ids(first.result.current)).toEqual(["a", "b", "c"]);
    first.unmount();

    // Realistic reload: the URL still selects "c", so the remounted hook gets a
    // non-empty active id. The full persisted set must come back.
    const second = renderHook(() =>
      useOpenTabs({
        activeConversationId: "c",
        activeConversations: list,
        activeConversationsLoaded: true,
        onOpenConversation,
      }),
    );

    await waitFor(() =>
      expect(ids(second.result.current)).toEqual(["a", "b", "c"]),
    );
  });

  it("reconciles away tabs no longer present in the live active list (1.7)", () => {
    const onOpenConversation = vi.fn();
    const { result, rerender } = renderHook(
      ({ activeId, list }) =>
        useOpenTabs({
          activeConversationId: activeId,
          activeConversations: list,
          activeConversationsLoaded: true,
          onOpenConversation,
        }),
      {
        initialProps: {
          activeId: "a",
          list: [convo("a"), convo("b"), convo("c")],
        },
      },
    );

    rerender({
      activeId: "a",
      list: [convo("a"), convo("b"), convo("c")],
    });
    // "b" enters the set via activation.
    rerender({
      activeId: "b",
      list: [convo("a"), convo("b"), convo("c")],
    });
    expect(ids(result.current)).toContain("b");

    // "b" disappears from the live list → it must drop out of the working set.
    rerender({ activeId: "a", list: [convo("a"), convo("c")] });

    expect(ids(result.current)).not.toContain("b");
    expect(ids(result.current)).toEqual(["a"]);
  });

  it("caps the working set at six, excludes open ones from addable, and no-ops addTab at cap (1.5)", () => {
    const onOpenConversation = vi.fn();
    const list = [
      convo("a"),
      convo("b"),
      convo("c"),
      convo("d"),
      convo("e"),
      convo("f"),
      convo("g"),
    ];
    const { result, rerender } = renderHook(
      ({ activeId }) =>
        useOpenTabs({
          activeConversationId: activeId,
          activeConversations: list,
          activeConversationsLoaded: true,
          onOpenConversation,
        }),
      { initialProps: { activeId: "a" } },
    );

    for (const id of ["b", "c", "d", "e", "f"]) {
      rerender({ activeId: id });
    }

    expect(result.current.workingSet).toHaveLength(6);
    expect(result.current.isAtCap).toBe(true);

    const addableIds = result.current.addableConversations.map((c) => c.id);
    expect(addableIds).toEqual(["g"]);
    for (const openId of ["a", "b", "c", "d", "e", "f"]) {
      expect(addableIds).not.toContain(openId);
    }

    onOpenConversation.mockClear();
    act(() => result.current.addTab("g"));
    expect(onOpenConversation).not.toHaveBeenCalled();
  });

  it("activates a neighbor when the active tab is closed (2.8)", () => {
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b"), convo("c")];
    const { result, rerender } = renderHook(
      ({ activeId }) =>
        useOpenTabs({
          activeConversationId: activeId,
          activeConversations: list,
          activeConversationsLoaded: true,
          onOpenConversation,
        }),
      { initialProps: { activeId: "a" } },
    );
    rerender({ activeId: "b" });
    rerender({ activeId: "c" });
    // Active is "b" (display order a, b, c).
    rerender({ activeId: "b" });
    expect(ids(result.current)).toEqual(["a", "b", "c"]);

    onOpenConversation.mockClear();
    act(() => result.current.closeTab("b"));

    expect(onOpenConversation).toHaveBeenCalledTimes(1);
    const neighbor = onOpenConversation.mock.calls[0]?.[0]?.conversationId;
    expect(["a", "c"]).toContain(neighbor);
    expect(ids(result.current)).not.toContain("b");
  });

  it("removes a non-active tab without navigating or stopping the agent (2.7)", () => {
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b"), convo("c")];
    const { result, rerender } = renderHook(
      ({ activeId }) =>
        useOpenTabs({
          activeConversationId: activeId,
          activeConversations: list,
          activeConversationsLoaded: true,
          onOpenConversation,
        }),
      { initialProps: { activeId: "a" } },
    );
    rerender({ activeId: "b" });
    rerender({ activeId: "c" });
    // Active is "c"; close the non-active "a".
    expect(ids(result.current)).toEqual(["a", "b", "c"]);

    onOpenConversation.mockClear();
    act(() => result.current.closeTab("a"));

    // 2.7: closing a tab only mutates local UI state — it never navigates and
    // never invokes any stop/agent API (the hook has no such dependency; its
    // only injected effect is `onOpenConversation`, which is not called here).
    expect(onOpenConversation).not.toHaveBeenCalled();
    expect(ids(result.current)).toEqual(["b", "c"]);
  });

  it("starts unhydrated with an empty persistedLruLive, then hydrates (1.8)", async () => {
    // `initializeWithValue: false` defers the localStorage read to a mount
    // effect, so the very first render is unhydrated. RTL flushes that effect
    // synchronously, so the observable first state already shows hydrated=true;
    // but the persisted lru must NEVER surface before hydration — both the
    // unhydrated `[]` and the post-hydration order are asserted via the
    // captured render history below.
    localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b"], lru: ["a", "b"] }),
    );
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b")];

    const history: { hydrated: boolean; lru: string[] }[] = [];
    renderHook(() => {
      const api = useOpenTabs({
        activeConversationId: "",
        activeConversations: list,
        activeConversationsLoaded: true,
        onOpenConversation,
      });
      history.push({ hydrated: api.hydrated, lru: api.persistedLruLive });
      return api;
    });

    // The very first render (before the hydration effect lands) must be the
    // unhydrated empty state.
    expect(history[0]).toEqual({ hydrated: false, lru: [] });
    // Whenever it is not hydrated, persistedLruLive is empty.
    for (const snapshot of history) {
      if (!snapshot.hydrated) expect(snapshot.lru).toEqual([]);
    }
    await waitFor(() =>
      expect(history.at(-1)).toEqual({ hydrated: true, lru: ["a", "b"] }),
    );
  });

  it("exposes hydrated=true and the live ∩ lru order (least→most recent) after hydration, dropping stale ids", async () => {
    // Persisted lru references "z", which is NOT in the live list — it must be
    // dropped. The surviving order must be the persisted least→most-recent one.
    localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b", "c"], lru: ["a", "z", "b", "c"] }),
    );
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b"), convo("c")];

    const { result } = renderHook(() =>
      useOpenTabs({
        activeConversationId: "",
        activeConversations: list,
        activeConversationsLoaded: true,
        onOpenConversation,
      }),
    );

    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.persistedLruLive).toEqual(["a", "b", "c"]);
  });

  it("falls back to an empty set when the persisted value is malformed (Error Handling)", () => {
    localStorage.setItem(OPEN_TABS_STORAGE_KEY, "{not valid json");
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b")];

    expect(() =>
      renderHook(() =>
        useOpenTabs({
          activeConversationId: "",
          activeConversations: list,
          activeConversationsLoaded: true,
          onOpenConversation,
        }),
      ),
    ).not.toThrow();
  });

  it("falls back to an empty set when persisted JSON does not match the model shape (Error Handling)", () => {
    localStorage.setItem(OPEN_TABS_STORAGE_KEY, JSON.stringify({ garbage: 1 }));
    const onOpenConversation = vi.fn();
    const list = [convo("a"), convo("b")];

    const { result } = renderHook(() =>
      useOpenTabs({
        activeConversationId: "",
        activeConversations: list,
        activeConversationsLoaded: true,
        onOpenConversation,
      }),
    );

    expect(result.current.workingSet).toEqual([]);
  });
});
