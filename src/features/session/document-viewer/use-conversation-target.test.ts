// @vitest-environment jsdom
import type { SessionConversationListItem } from "@/lib/conversations/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  createUseConversationTarget,
  pickDefaultTarget,
  targetFromConversation,
  type ConversationTargetQuery,
} from "./use-conversation-target";
import { OPEN_TABS_STORAGE_KEY } from "../tabs/use-open-tabs";
import type {
  AllConversationsResponse,
  ConversationListItem,
} from "@/lib/conversations/schemas";

function conv(
  overrides: Partial<SessionConversationListItem> & { conversationId: string },
): SessionConversationListItem {
  return {
    projectName: overrides.projectName ?? "proj-a",
    projectPath: overrides.projectPath ?? "/abs/proj-a",
    scope: "session" as const,
    sessionName: overrides.sessionName ?? "sess-1",
    worktreePath: overrides.worktreePath ?? "/abs/proj-a/.worktrees/sess-1",
    conversationId: overrides.conversationId,
    conversationName: overrides.conversationName ?? null,
    summary: overrides.summary ?? null,
    firstPromptSnippet: overrides.firstPromptSnippet ?? null,
    backend: overrides.backend ?? "claude",
    backendRef: overrides.backendRef ?? null,
    transcriptPath: overrides.transcriptPath ?? null,
    debugLogPath: overrides.debugLogPath ?? null,
    status: overrides.status ?? "awaiting",
    lastActivityAt: overrides.lastActivityAt ?? "2025-01-01T00:00:00.000Z",
    archived: overrides.archived ?? false,
  };
}

function fakeQuery(
  items: ConversationListItem[],
): () => ConversationTargetQuery {
  const data: AllConversationsResponse = { items, totalCount: items.length };
  return () => ({ data, isLoading: false, isError: false });
}

describe("targetFromConversation", () => {
  it("carries the full routing identity from a conversation list item", () => {
    const item = conv({
      conversationId: "c1",
      projectName: "proj-x",
      projectPath: "/abs/proj-x",
      scope: "session" as const,
      sessionName: "sess-9",
      backend: "codex",
      status: "running",
    });

    expect(targetFromConversation(item)).toEqual({
      projectName: "proj-x",
      projectPath: "/abs/proj-x",
      sessionName: "sess-9",
      conversationId: "c1",
      backend: "codex",
      status: "running",
    });
  });
});

describe("pickDefaultTarget", () => {
  it("defaults to the most-recently-viewed conversation (the LRU tail)", () => {
    const items = [
      conv({ conversationId: "a" }),
      conv({ conversationId: "b" }),
      conv({ conversationId: "c" }),
    ];
    // LRU is least → most recent; tail "b" is most-recently viewed.
    const result = pickDefaultTarget(items, ["c", "a", "b"]);
    expect(result?.conversationId).toBe("b");
  });

  it("walks the LRU tail→head, skipping ids no longer in the list", () => {
    const items = [
      conv({ conversationId: "a" }),
      conv({ conversationId: "b" }),
    ];
    // tail "gone" is stale; next most-recent "a" is live.
    const result = pickDefaultTarget(items, ["a", "gone"]);
    expect(result?.conversationId).toBe("a");
  });

  it("falls back to the most-recent-by-activity when no LRU id is live", () => {
    const items = [
      conv({
        conversationId: "old",
        lastActivityAt: "2025-01-01T00:00:00.000Z",
      }),
      conv({
        conversationId: "newest",
        lastActivityAt: "2025-03-01T00:00:00.000Z",
      }),
      conv({
        conversationId: "mid",
        lastActivityAt: "2025-02-01T00:00:00.000Z",
      }),
    ];
    expect(pickDefaultTarget(items, [])?.conversationId).toBe("newest");
    expect(pickDefaultTarget(items, ["stale"])?.conversationId).toBe("newest");
  });

  it("returns null when there are no conversations to target", () => {
    expect(pickDefaultTarget([], ["a"])).toBeNull();
  });
});

describe("useConversationTarget", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults the target to the most-recently-viewed conversation", () => {
    window.localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a", "b"], lru: ["a", "b"] }),
    );
    const items = [
      conv({ conversationId: "a", projectName: "p1" }),
      conv({ conversationId: "b", projectName: "p2" }),
    ];
    const useHook = createUseConversationTarget({
      useAllConversations: fakeQuery(items),
    });

    const { result } = renderHook(() => useHook());
    expect(result.current.target?.conversationId).toBe("b");
  });

  it("retains an explicitly chosen target over the default", () => {
    window.localStorage.setItem(
      OPEN_TABS_STORAGE_KEY,
      JSON.stringify({ tabs: ["a"], lru: ["a"] }),
    );
    const items = [
      conv({ conversationId: "a" }),
      conv({ conversationId: "b", projectName: "p2", status: "running" }),
    ];
    const useHook = createUseConversationTarget({
      useAllConversations: fakeQuery(items),
    });

    const { result } = renderHook(() => useHook());
    expect(result.current.target?.conversationId).toBe("a");

    act(() => {
      result.current.setTarget(targetFromConversation(items[1]!));
    });
    expect(result.current.target?.conversationId).toBe("b");
    expect(result.current.target?.status).toBe("running");
  });

  it("falls back to activity recency when no LRU data is stored", () => {
    const items = [
      conv({ conversationId: "x", lastActivityAt: "2025-01-01T00:00:00.000Z" }),
      conv({ conversationId: "y", lastActivityAt: "2025-05-01T00:00:00.000Z" }),
    ];
    const useHook = createUseConversationTarget({
      useAllConversations: fakeQuery(items),
    });

    const { result } = renderHook(() => useHook());
    expect(result.current.target?.conversationId).toBe("y");
  });
});
