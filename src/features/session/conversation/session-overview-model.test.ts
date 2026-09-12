import { describe, expect, it } from "vitest";
import { publicConversationStateSchema } from "@/lib/conversations/schemas";
import { selectSessionConversations } from "./session-overview-model";

const conversation = (id: string, fields: Record<string, unknown> = {}) =>
  publicConversationStateSchema.parse({
    id,
    transcriptPath: null,
    status: "awaiting",
    promptCount: 2,
    createdAt: "2026-09-11T09:00:00.000Z",
    lastActivityAt: "2026-09-11T10:00:00.000Z",
    ...fields,
  });
const defaults = { filter: "all", query: "", showArchived: false } as const;

describe("session overview conversations", () => {
  it("keeps workflow conversations out and only includes archived conversations on request", () => {
    const rows = [
      conversation("active"),
      conversation("archived", { archived: true }),
      conversation("workflow", { role: "iteration" }),
    ];
    expect(selectSessionConversations(rows, defaults).map((c) => c.id)).toEqual(
      ["active"],
    );
    expect(
      selectSessionConversations(rows, { ...defaults, showArchived: true }).map(
        (c) => c.id,
      ),
    ).toEqual(["active", "archived"]);
  });

  it("puts decisions before running work, then sorts by latest activity without changing the source", () => {
    const rows = [
      conversation("older", { lastActivityAt: "2026-09-10T10:00:00.000Z" }),
      conversation("recent"),
      conversation("working", { status: "running" }),
      conversation("decision", { status: "waiting_for_input" }),
    ];
    expect(selectSessionConversations(rows, defaults).map((c) => c.id)).toEqual(
      ["decision", "working", "recent", "older"],
    );
    expect(rows[0]?.id).toBe("older");
  });

  it("combines status and case-insensitive text search across name, summary, id and backend", () => {
    const rows = [
      conversation("review-id", {
        name: "Release review",
        summary: "Check billing",
        agentBackend: "codex",
        status: "waiting_for_input",
      }),
      conversation("build-id", {
        name: "Build",
        agentBackend: "claude",
        status: "running",
        unread: true,
      }),
    ];
    for (const query of [" RELEASE ", "billing", "review-id", "CODEX"]) {
      expect(
        selectSessionConversations(rows, {
          ...defaults,
          filter: "attention",
          query,
        }).map((c) => c.id),
      ).toEqual(["review-id"]);
    }
    expect(
      selectSessionConversations(rows, {
        ...defaults,
        filter: "running",
        query: "review",
      }),
    ).toEqual([]);
    expect(
      selectSessionConversations(rows, { ...defaults, filter: "unread" }).map(
        (c) => c.id,
      ),
    ).toEqual(["build-id"]);
  });

  it("does not treat a ready conversation as needing input and keeps archived work after active work", () => {
    const rows = [
      conversation("ready"),
      conversation("old-decision", {
        status: "waiting_for_input",
        archived: true,
      }),
    ];
    expect(
      selectSessionConversations(rows, { ...defaults, filter: "attention" }),
    ).toEqual([]);
    expect(
      selectSessionConversations(rows, { ...defaults, showArchived: true }).map(
        (c) => c.id,
      ),
    ).toEqual(["ready", "old-decision"]);
  });
});
