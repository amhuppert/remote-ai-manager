import { describe, expect, it } from "vitest";
import { applyCursorTaskEvent, cursorTaskActivity } from "./background-tasks";
const at = "2026-09-14T00:00:00.000Z";
const later = "2026-09-14T00:00:01.000Z";
const started = {
  type: "tool_call",
  call_id: "call-1",
  name: "task",
  status: "running",
  args: { description: "Check files", subagentType: { kind: "explore" } },
};
const terminal = (isBackground: boolean) => ({
  ...started,
  status: "completed",
  result: { status: "success", value: { agentId: "child-1", isBackground } },
});
describe("Cursor provider task lifecycle", () => {
  it("tracks stable identity through progress and confirmed completion", () => {
    const state = applyCursorTaskEvent([], started, "run-1", at);
    expect(cursorTaskActivity(state, at)?.tasks).toMatchObject([
      {
        taskId: "cursor:run-1:call-1",
        description: "Check files",
        totalTokens: null,
        toolUses: null,
      },
    ]);
    expect(applyCursorTaskEvent(state, started, "run-1", later)).toEqual(state);
    const progressed = applyCursorTaskEvent(
      state,
      {
        type: "cursor_task_delta",
        update: {
          type: "tool-call-delta",
          callId: "call-1",
          taskUpdate: {
            type: "tool-call-started",
            toolCall: { type: "shell" },
          },
        },
      },
      "run-1",
      later,
    );
    expect(cursorTaskActivity(progressed, later)?.tasks[0]).toMatchObject({
      lastToolName: "shell",
      lastActivityAt: later,
      startedAt: at,
    });
    const done = applyCursorTaskEvent(
      progressed,
      terminal(false),
      "run-1",
      later,
    );
    expect(done[0]?.status).toBe("completed");
    expect(cursorTaskActivity(done, later)).toBeNull();
    expect(applyCursorTaskEvent(done, started, "run-1", later)).toEqual(done);
  });
  it("does not mistake a returned background handle for completed work", () => {
    const state = applyCursorTaskEvent([], terminal(true), "run-1", at);
    expect(state[0]?.status).toBe("background");
    expect(cursorTaskActivity(state, at)?.tasks).toHaveLength(1);
  });
  it("settles provider failures and ignores generic summaries and unrelated tools", () => {
    const state = applyCursorTaskEvent([], started, "run-1", at);
    const failed = applyCursorTaskEvent(
      state,
      {
        ...started,
        status: "completed",
        result: { status: "error", error: { message: "failed" } },
      },
      "run-1",
      later,
    );
    expect(failed[0]?.status).toBe("failed");
    expect(cursorTaskActivity(failed, later)).toBeNull();
    expect(
      applyCursorTaskEvent(
        [],
        { type: "task", status: "completed", text: "summary" },
        "run-1",
        at,
      ),
    ).toEqual([]);
    expect(
      applyCursorTaskEvent([], { ...started, name: "shell" }, "run-1", at),
    ).toEqual([]);
  });
  it("separates reused call ids between runs and does not invent missing outcomes", () => {
    const first = applyCursorTaskEvent([], started, "run-1", at);
    const second = applyCursorTaskEvent(first, started, "run-2", later);
    expect(second).toHaveLength(2);
    expect(
      applyCursorTaskEvent(
        first,
        { ...started, status: "completed" },
        "run-1",
        later,
      )[0]?.status,
    ).toBe("running");
  });
});
