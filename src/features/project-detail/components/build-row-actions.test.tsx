import { describe, it, expect, vi } from "vitest";
import type { SessionListItem } from "@/lib/sessions/schemas";
import { buildRowActions, type RowHandlers } from "./build-row-actions";

function makeSession(overrides: Partial<SessionListItem>): SessionListItem {
  return {
    sessionName: "test",
    worktreePath: "/tmp/wt",
    branchName: "cc/test",
    targetBranch: "main",
    parentSessionName: null,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "normal",
    tddEnabled: false,
    derivedStatus: "idle",
    promptCount: 0,
    derivedLastActivityAt: new Date().toISOString(),
    collabContribution: null,
    hasActiveGraphWorkflow: false,
    ...overrides,
  };
}

function makeHandlers(): RowHandlers {
  return {
    onBranch: vi.fn(),
    onCopyBranch: vi.fn(),
    onArchive: vi.fn(),
    onToggleMerged: vi.fn(),
    onDelete: vi.fn(),
  };
}

function labels(items: ReturnType<typeof buildRowActions>): string[] {
  return items.map((it) => (it === "divider" ? "divider" : it.label));
}

describe("buildRowActions", () => {
  it("returns Branch/divider for an active session", () => {
    const items = buildRowActions(makeSession({}), makeHandlers());
    expect(labels(items)).toEqual([
      "Branch from here",
      "divider",
      "Copy branch",
      "divider",
      "Mark as merged",
      "Archive",
      "Delete session",
    ]);
  });

  it("offers branching and clearing the merged label for merged sessions", () => {
    const items = buildRowActions(
      makeSession({ finished: true }),
      makeHandlers(),
    );
    expect(labels(items)).toEqual([
      "Branch from here",
      "divider",
      "Copy branch",
      "divider",
      "Unmark as merged",
      "Archive",
      "Delete session",
    ]);
  });

  it('flips Archive label to "Unarchive" when session.archived is true', () => {
    const items = buildRowActions(
      makeSession({ archived: true }),
      makeHandlers(),
    );
    expect(labels(items)).toContain("Unarchive");
    expect(labels(items)).not.toContain("Archive");
  });

  it("marks Delete session as danger", () => {
    const items = buildRowActions(makeSession({}), makeHandlers());
    const del = items.find(
      (it) => it !== "divider" && it.label === "Delete session",
    );
    expect(del).not.toBe("divider");
    if (del !== "divider" && del) {
      expect(del.danger).toBe(true);
    }
  });

  it("each handler receives the session when its item is invoked", () => {
    const session = makeSession({ sessionName: "abc" });
    const handlers = makeHandlers();
    const items = buildRowActions(session, handlers);
    for (const it of items) {
      if (it === "divider") continue;
      it.onClick?.();
    }
    expect(handlers.onBranch).toHaveBeenCalledWith(session);
    expect(handlers.onCopyBranch).toHaveBeenCalledWith(session);
    expect(handlers.onArchive).toHaveBeenCalledWith(session);
    expect(handlers.onDelete).toHaveBeenCalledWith(session);
  });
});
