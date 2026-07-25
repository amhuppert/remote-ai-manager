import type { SessionConversationListItem } from "./schemas";
import { describe, it, expect } from "vitest";
import {
  filterAndScoreConversations,
  MAX_DISPLAY_CONVERSATIONS,
} from "./conversation-autocomplete-filter";
import type { ConversationListItem } from "./schemas";

function makeItem(
  overrides: Partial<SessionConversationListItem> & { conversationId: string },
): ConversationListItem {
  return {
    projectName: "proj",
    projectPath: "/projects/proj",
    scope: "session" as const,
    sessionName: "main",
    worktreePath: "/projects/proj/.worktrees/main",
    conversationName: null,
    summary: null,
    firstPromptSnippet: null,
    backend: "claude",
    backendRef: null,
    transcriptPath: null,
    debugLogPath: null,
    status: "new",
    lastActivityAt: "2024-01-01T00:00:00Z",
    archived: false,
    ...overrides,
  };
}

const NO_CONTEXT = {
  currentProjectName: null,
  currentConversationId: null,
};

describe("filterAndScoreConversations — empty query", () => {
  it("returns all items (except current conversation)", () => {
    const items = [
      makeItem({ conversationId: "a", conversationName: "A" }),
      makeItem({ conversationId: "b", conversationName: "B" }),
      makeItem({ conversationId: "c", conversationName: "C" }),
    ];
    const result = filterAndScoreConversations("", items, {
      currentProjectName: null,
      currentConversationId: "b",
    });
    expect(result.items.map((s) => s.item.conversationId)).toEqual(["a", "c"]);
    expect(result.totalCount).toBe(2);
  });

  it("ranks items in the current project before items from other projects", () => {
    const items = [
      makeItem({
        conversationId: "other",
        conversationName: "Other",
        projectName: "other-proj",
      }),
      makeItem({
        conversationId: "current",
        conversationName: "Current",
        projectName: "proj",
      }),
    ];
    const result = filterAndScoreConversations("", items, {
      currentProjectName: "proj",
      currentConversationId: null,
    });
    expect(result.items.map((s) => s.item.conversationId)).toEqual([
      "current",
      "other",
    ]);
  });

  it("ranks running/awaiting before other statuses within the same project tier", () => {
    const items = [
      makeItem({ conversationId: "new", status: "new" }),
      makeItem({ conversationId: "running", status: "running" }),
      makeItem({ conversationId: "waiting", status: "waiting_for_input" }),
      makeItem({ conversationId: "awaiting", status: "awaiting" }),
    ];
    const result = filterAndScoreConversations("", items, NO_CONTEXT);
    const ids = result.items.map((s) => s.item.conversationId);
    // running + awaiting come before new + waiting_for_input
    expect(ids.indexOf("running")).toBeLessThan(ids.indexOf("new"));
    expect(ids.indexOf("running")).toBeLessThan(ids.indexOf("waiting"));
    expect(ids.indexOf("awaiting")).toBeLessThan(ids.indexOf("new"));
    expect(ids.indexOf("awaiting")).toBeLessThan(ids.indexOf("waiting"));
  });

  it("orders items by lastActivityAt desc within the same status group", () => {
    const items = [
      makeItem({
        conversationId: "older",
        status: "new",
        lastActivityAt: "2024-01-01T00:00:00Z",
      }),
      makeItem({
        conversationId: "newer",
        status: "new",
        lastActivityAt: "2024-06-01T00:00:00Z",
      }),
      makeItem({
        conversationId: "newest",
        status: "new",
        lastActivityAt: "2024-12-01T00:00:00Z",
      }),
    ];
    const result = filterAndScoreConversations("", items, NO_CONTEXT);
    expect(result.items.map((s) => s.item.conversationId)).toEqual([
      "newest",
      "newer",
      "older",
    ]);
  });

  it("sinks archived items to the bottom regardless of status or project", () => {
    const items = [
      makeItem({
        conversationId: "archived-current",
        conversationName: "Archived Current",
        projectName: "proj",
        status: "running",
        archived: true,
      }),
      makeItem({
        conversationId: "non-archived-other",
        conversationName: "Non-Archived Other",
        projectName: "other",
        status: "new",
        archived: false,
      }),
    ];
    const result = filterAndScoreConversations("", items, {
      currentProjectName: "proj",
      currentConversationId: null,
    });
    expect(result.items.map((s) => s.item.conversationId)).toEqual([
      "non-archived-other",
      "archived-current",
    ]);
  });
});

describe("filterAndScoreConversations — non-empty query", () => {
  it("filters out items whose display label does not match the query", () => {
    const items = [
      makeItem({ conversationId: "a", conversationName: "Refactor parser" }),
      makeItem({ conversationId: "b", conversationName: "Add login flow" }),
      makeItem({ conversationId: "c", conversationName: "Fix parser bug" }),
    ];
    const result = filterAndScoreConversations("parser", items, NO_CONTEXT);
    expect(result.items.map((s) => s.item.conversationId).sort()).toEqual([
      "a",
      "c",
    ]);
  });

  it("ranks prefix matches above substring matches", () => {
    const items = [
      makeItem({
        conversationId: "sub",
        conversationName: "do the foo thing",
      }),
      makeItem({
        conversationId: "pre",
        conversationName: "foo investigation",
      }),
    ];
    const result = filterAndScoreConversations("foo", items, NO_CONTEXT);
    expect(result.items.map((s) => s.item.conversationId)).toEqual([
      "pre",
      "sub",
    ]);
  });

  it("falls back to summary then firstPromptSnippet then id when name is null", () => {
    const items = [
      makeItem({
        conversationId: "from-summary",
        conversationName: null,
        summary: "the keyword is here",
      }),
      makeItem({
        conversationId: "from-snippet",
        conversationName: null,
        summary: null,
        firstPromptSnippet: "also has keyword inside",
      }),
      makeItem({
        conversationId: "no-match",
        conversationName: null,
        summary: "completely unrelated",
      }),
    ];
    const result = filterAndScoreConversations("keyword", items, NO_CONTEXT);
    const ids = result.items.map((s) => s.item.conversationId).sort();
    expect(ids).toEqual(["from-snippet", "from-summary"]);
  });

  it("excludes the current conversation from the results", () => {
    const items = [
      makeItem({ conversationId: "a", conversationName: "Hello" }),
      makeItem({ conversationId: "b", conversationName: "Hello" }),
    ];
    const result = filterAndScoreConversations("Hello", items, {
      currentProjectName: null,
      currentConversationId: "b",
    });
    expect(result.items.map((s) => s.item.conversationId)).toEqual(["a"]);
  });

  it("sinks archived items to the bottom of their match tier", () => {
    const items = [
      makeItem({
        conversationId: "archived-match",
        conversationName: "foo match",
        archived: true,
      }),
      makeItem({
        conversationId: "fresh-match",
        conversationName: "foo match",
        archived: false,
      }),
    ];
    const result = filterAndScoreConversations("foo", items, NO_CONTEXT);
    expect(result.items.map((s) => s.item.conversationId)).toEqual([
      "fresh-match",
      "archived-match",
    ]);
  });

  it("breaks tier+archived ties by current-project then lastActivityAt", () => {
    const items = [
      makeItem({
        conversationId: "other-recent",
        conversationName: "foo bar",
        projectName: "other",
        lastActivityAt: "2024-06-01T00:00:00Z",
      }),
      makeItem({
        conversationId: "current-older",
        conversationName: "foo bar",
        projectName: "proj",
        lastActivityAt: "2024-01-01T00:00:00Z",
      }),
    ];
    const result = filterAndScoreConversations("foo", items, {
      currentProjectName: "proj",
      currentConversationId: null,
    });
    expect(result.items.map((s) => s.item.conversationId)).toEqual([
      "current-older",
      "other-recent",
    ]);
  });
});

describe("filterAndScoreConversations — cap & totalCount", () => {
  it("caps displayed items at MAX_DISPLAY_CONVERSATIONS and reports pre-cap totalCount", () => {
    const items = Array.from(
      { length: MAX_DISPLAY_CONVERSATIONS + 25 },
      (_, i) =>
        makeItem({
          conversationId: `c-${i}`,
          conversationName: `match ${i}`,
        }),
    );
    const result = filterAndScoreConversations("match", items, NO_CONTEXT);
    expect(result.items.length).toBe(MAX_DISPLAY_CONVERSATIONS);
    expect(result.totalCount).toBe(MAX_DISPLAY_CONVERSATIONS + 25);
  });

  it("respects a custom maxDisplayItems override", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({
        conversationId: `c-${i}`,
        conversationName: `match ${i}`,
      }),
    );
    const result = filterAndScoreConversations("match", items, NO_CONTEXT, {
      maxDisplayItems: 3,
    });
    expect(result.items.length).toBe(3);
    expect(result.totalCount).toBe(10);
  });
});
