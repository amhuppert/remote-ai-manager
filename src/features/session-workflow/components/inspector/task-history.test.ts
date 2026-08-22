import { describe, expect, it } from "vitest";
import type { GraphWorkflowTaskState } from "@/lib/workflow-graph/schemas";
import { deriveTaskHistory } from "./task-history";

function taskState(
  overrides: Partial<GraphWorkflowTaskState> = {},
): GraphWorkflowTaskState {
  return {
    taskId: "task-risk-rules",
    contextId: "context-implement",
    order: 1,
    status: "completed",
    summary: null,
    startedAt: null,
    completedAt: null,
    lastConversationId: null,
    failureMessage: null,
    failureHistory: [],
    ...overrides,
  };
}

describe("deriveTaskHistory", () => {
  it("has nothing to say about a task that has not started", () => {
    const view = deriveTaskHistory(taskState({ status: "pending" }));

    expect(view.entries).toEqual([]);
    expect(view.reopenedCount).toBe(0);
    expect(view.hasHistory).toBe(false);
  });

  it("has nothing to say about a task with no recorded state", () => {
    expect(deriveTaskHistory(undefined)).toEqual({
      entries: [],
      reopenedCount: 0,
      hasHistory: false,
    });
  });

  it("reads the run as started, rejected and completed, in time order", () => {
    const view = deriveTaskHistory(
      taskState({
        startedAt: "2026-03-27T10:31:00.000Z",
        completedAt: "2026-03-27T11:04:00.000Z",
        failureMessage: "audit log bypassed on the timeout path",
        failureHistory: [
          {
            message: "audit log bypassed on the timeout path",
            timestamp: "2026-03-27T10:42:00.000Z",
          },
        ],
      }),
    );

    expect(view.entries).toEqual([
      { kind: "started", at: "2026-03-27T10:31:00.000Z", detail: null },
      {
        kind: "rejected",
        at: "2026-03-27T10:42:00.000Z",
        detail: "audit log bypassed on the timeout path",
      },
      { kind: "completed", at: "2026-03-27T11:04:00.000Z", detail: null },
    ]);
    expect(view.hasHistory).toBe(true);
  });

  it("counts every send-back as a reopening", () => {
    const view = deriveTaskHistory(
      taskState({
        status: "running",
        startedAt: "2026-03-27T10:00:00.000Z",
        failureHistory: [
          { message: "first", timestamp: "2026-03-27T10:20:00.000Z" },
          { message: "second", timestamp: "2026-03-27T10:50:00.000Z" },
        ],
      }),
    );

    expect(view.reopenedCount).toBe(2);
    expect(view.entries.map((entry) => entry.detail)).toEqual([
      null,
      "first",
      "second",
    ]);
  });

  it("orders send-backs by when they happened, not by how they were stored", () => {
    const view = deriveTaskHistory(
      taskState({
        failureHistory: [
          { message: "later", timestamp: "2026-03-27T11:00:00.000Z" },
          { message: "earlier", timestamp: "2026-03-27T10:00:00.000Z" },
        ],
      }),
    );

    expect(view.entries.map((entry) => entry.detail)).toEqual([
      "earlier",
      "later",
    ]);
  });
});
