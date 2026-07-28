import { describe, it, expect } from "vitest";
import type { ConversationListItem } from "@/lib/conversations/schemas";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";
import {
  resolveConversationsRenderState,
  selectAutoOpenCandidate,
  selectInitialConversation,
  isConversationPresent,
  conversationSwitchUrl,
  autoOpenUrl,
  clearSelectionUrl,
  stripSessionFilterUrl,
  type ConversationLookupSnapshot,
} from "./conversations-page-state";

const item: ConversationListItem = {
  projectName: "repo",
  projectPath: "/projects/repo",
  scope: "session" as const,
  sessionName: "fix-bug",
  worktreePath: "/projects/repo/.worktrees/fix-bug",
  conversationId: "conv-1",
  conversationName: null,
  summary: null,
  firstPromptSnippet: null,
  backend: "claude",
  backendRef: null,
  transcriptPath: null,
  debugLogPath: null,
  status: "new",
  lastActivityAt: "2026-06-01T00:00:00Z",
  archived: false,
};

function lookup(
  overrides: Partial<ConversationLookupSnapshot>,
): ConversationLookupSnapshot {
  return { isPending: false, isError: false, data: undefined, ...overrides };
}

type SessionRow = Extract<ActiveConversation, { scope: "session" }>;

function sessionRow(
  overrides: Partial<SessionRow> & { id: string },
): SessionRow {
  return {
    scope: "session",
    name: null,
    status: "awaiting",
    lastActivityAt: "2026-06-01T00:00:00Z",
    projectName: "repo",
    projectPath: "/projects/repo",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/projects/repo/.worktrees/fix-bug",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    backgroundActivity: null,
    sessionName: "fix-bug",
    branchName: "csm/fix-bug",
    ...overrides,
  };
}

function projectRow(id: string): ActiveConversation {
  const { sessionName, branchName, ...shared } = sessionRow({ id });
  void sessionName;
  void branchName;
  return { ...shared, scope: "project", open: true };
}

const idleAutoOpen = { isResolved: true, candidateId: null };

describe("resolveConversationsRenderState", () => {
  describe("with a selected conversation (?c= present)", () => {
    it("is loading while the lookup is pending", () => {
      expect(
        resolveConversationsRenderState({
          conversationId: "conv-1",
          lookup: lookup({ isPending: true }),
          autoOpen: idleAutoOpen,
        }),
      ).toEqual({ kind: "loading" });
    });

    it("mounts the workspace once the lookup resolves", () => {
      expect(
        resolveConversationsRenderState({
          conversationId: "conv-1",
          lookup: lookup({ data: item }),
          autoOpen: idleAutoOpen,
        }),
      ).toEqual({ kind: "workspace", conversation: item });
    });

    it("is not-found when the lookup resolves to null (404)", () => {
      expect(
        resolveConversationsRenderState({
          conversationId: "conv-1",
          lookup: lookup({ data: null }),
          autoOpen: idleAutoOpen,
        }),
      ).toEqual({ kind: "not-found" });
    });

    it("is error when the lookup fails with a non-404 error", () => {
      expect(
        resolveConversationsRenderState({
          conversationId: "conv-1",
          lookup: lookup({ isError: true }),
          autoOpen: idleAutoOpen,
        }),
      ).toEqual({ kind: "error" });
    });

    it("resolves a stale workspace over loading when data and pending coexist", () => {
      // React Query keeps previous data while refetching; the workspace must
      // not flicker back to the loading panel.
      expect(
        resolveConversationsRenderState({
          conversationId: "conv-1",
          lookup: lookup({ isPending: true, data: item }),
          autoOpen: idleAutoOpen,
        }),
      ).toEqual({ kind: "workspace", conversation: item });
    });
  });

  describe("with no selection (?c= absent)", () => {
    it("is loading while the auto-open data has not resolved yet", () => {
      expect(
        resolveConversationsRenderState({
          conversationId: null,
          lookup: lookup({}),
          autoOpen: { isResolved: false, candidateId: null },
        }),
      ).toEqual({ kind: "loading" });
    });

    it("is loading while an auto-open candidate is about to be applied", () => {
      expect(
        resolveConversationsRenderState({
          conversationId: null,
          lookup: lookup({}),
          autoOpen: { isResolved: true, candidateId: "conv-2" },
        }),
      ).toEqual({ kind: "loading" });
    });

    it("is empty when no auto-open candidate exists", () => {
      expect(
        resolveConversationsRenderState({
          conversationId: null,
          lookup: lookup({}),
          autoOpen: idleAutoOpen,
        }),
      ).toEqual({ kind: "empty" });
    });
  });
});

describe("selectAutoOpenCandidate", () => {
  it("picks the most recently active session-scoped row", () => {
    const rows = [
      sessionRow({ id: "old", lastActivityAt: "2026-06-01T00:00:00Z" }),
      sessionRow({ id: "newest", lastActivityAt: "2026-06-03T00:00:00Z" }),
      sessionRow({ id: "mid", lastActivityAt: "2026-06-02T00:00:00Z" }),
    ];
    expect(selectAutoOpenCandidate(rows, null)).toBe("newest");
  });

  it("ignores project-scoped rows even when they are most recent", () => {
    const rows = [
      sessionRow({ id: "session", lastActivityAt: "2026-06-01T00:00:00Z" }),
      { ...projectRow("project"), lastActivityAt: "2026-06-09T00:00:00Z" },
    ];
    expect(selectAutoOpenCandidate(rows, null)).toBe("session");
  });

  it("restricts candidates to the active session filter", () => {
    const rows = [
      sessionRow({
        id: "other-session",
        scope: "session" as const,
        sessionName: "other",
        lastActivityAt: "2026-06-09T00:00:00Z",
      }),
      sessionRow({ id: "filtered", lastActivityAt: "2026-06-01T00:00:00Z" }),
    ];
    expect(
      selectAutoOpenCandidate(rows, {
        projectName: "repo",
        sessionName: "fix-bug",
      }),
    ).toBe("filtered");
  });

  it("returns null when nothing matches the filter", () => {
    const rows = [sessionRow({ id: "a" })];
    expect(
      selectAutoOpenCandidate(rows, {
        projectName: "elsewhere",
        sessionName: "nope",
      }),
    ).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(selectAutoOpenCandidate([], null)).toBeNull();
  });
});

describe("selectInitialConversation", () => {
  it("prefers an explicit ?c= selection over every other source", () => {
    const result = selectInitialConversation({
      urlConversationId: "url-conv",
      sessionFilter: { projectName: "repo", sessionName: "fix-bug" },
      persistedLruLive: ["lru-conv"],
      conversations: [sessionRow({ id: "auto-conv" })],
    });
    expect(result).toEqual({ kind: "url" });
  });

  it("auto-opens a session-filter candidate when one matches", () => {
    const result = selectInitialConversation({
      urlConversationId: null,
      sessionFilter: { projectName: "repo", sessionName: "fix-bug" },
      persistedLruLive: ["lru-conv"],
      conversations: [
        sessionRow({
          id: "other-session",
          scope: "session" as const,
          sessionName: "other",
          lastActivityAt: "2026-06-09T00:00:00Z",
        }),
        sessionRow({ id: "filtered", lastActivityAt: "2026-06-01T00:00:00Z" }),
      ],
    });
    expect(result).toEqual({ kind: "auto", id: "filtered" });
  });

  it("yields none when a session filter is present but nothing matches it", () => {
    const result = selectInitialConversation({
      urlConversationId: null,
      sessionFilter: { projectName: "elsewhere", sessionName: "nope" },
      persistedLruLive: ["lru-conv"],
      conversations: [sessionRow({ id: "a" })],
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("restores the most-recently-active LRU tail, beating the generic most-recent row", () => {
    const result = selectInitialConversation({
      urlConversationId: null,
      sessionFilter: null,
      // least → most recent; the tail is the persisted last-active id.
      persistedLruLive: ["lru-old", "lru-recent"],
      conversations: [
        // The generic auto-open would pick this newer row, but LRU restore wins.
        sessionRow({ id: "newest", lastActivityAt: "2026-06-09T00:00:00Z" }),
        sessionRow({
          id: "lru-recent",
          lastActivityAt: "2026-06-02T00:00:00Z",
        }),
        sessionRow({ id: "lru-old", lastActivityAt: "2026-06-01T00:00:00Z" }),
      ],
    });
    expect(result).toEqual({ kind: "auto", id: "lru-recent" });
  });

  it("falls back to the most-recent row on a first visit with an empty LRU", () => {
    const result = selectInitialConversation({
      urlConversationId: null,
      sessionFilter: null,
      persistedLruLive: [],
      conversations: [
        sessionRow({ id: "old", lastActivityAt: "2026-06-01T00:00:00Z" }),
        sessionRow({ id: "newest", lastActivityAt: "2026-06-03T00:00:00Z" }),
      ],
    });
    expect(result).toEqual({ kind: "auto", id: "newest" });
  });

  it("yields none on a first visit with no LRU and no conversations", () => {
    const result = selectInitialConversation({
      urlConversationId: null,
      sessionFilter: null,
      persistedLruLive: [],
      conversations: [],
    });
    expect(result).toEqual({ kind: "none" });
  });
});

describe("isConversationPresent", () => {
  it("finds a row by id", () => {
    expect(isConversationPresent([sessionRow({ id: "x" })], "x")).toBe(true);
  });

  it("returns false when absent", () => {
    expect(isConversationPresent([sessionRow({ id: "x" })], "y")).toBe(false);
  });
});

describe("URL rewriting", () => {
  it("conversationSwitchUrl sets c, strips autoFocus, and preserves unknown params", () => {
    const url = conversationSwitchUrl(
      new URLSearchParams("c=conv-1&autoFocus=true&debug=1"),
      "conv-2",
    );
    expect(url).toBe("/conversations?c=conv-2&debug=1");
  });

  it("conversationSwitchUrl encodes the conversation id", () => {
    expect(conversationSwitchUrl(new URLSearchParams(), "a b")).toBe(
      "/conversations?c=a+b",
    );
  });

  it("autoOpenUrl sets c and preserves autoFocus and unknown params", () => {
    const url = autoOpenUrl(
      new URLSearchParams("autoFocus=true&debug=1"),
      "conv-9",
    );
    expect(url).toBe("/conversations?autoFocus=true&debug=1&c=conv-9");
  });

  it("clearSelectionUrl removes c and autoFocus but keeps unknown params", () => {
    expect(
      clearSelectionUrl(new URLSearchParams("c=gone&autoFocus=true&debug=1")),
    ).toBe("/conversations?debug=1");
  });

  it("clearSelectionUrl yields the bare path when nothing remains", () => {
    expect(clearSelectionUrl(new URLSearchParams("c=gone"))).toBe(
      "/conversations",
    );
  });

  it("stripSessionFilterUrl removes the project+session pair and preserves c, autoFocus, and unknown params", () => {
    expect(
      stripSessionFilterUrl(
        new URLSearchParams(
          "project=repo&session=fix-bug&c=conv-1&autoFocus=true&debug=1",
        ),
      ),
    ).toBe("/conversations?c=conv-1&autoFocus=true&debug=1");
  });

  it("stripSessionFilterUrl yields the bare path when only the pair was present", () => {
    expect(
      stripSessionFilterUrl(new URLSearchParams("project=repo&session=s")),
    ).toBe("/conversations");
  });
});
