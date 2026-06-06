import { describe, it, expect } from "vitest";
import type {
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKThinkingTokensMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  emptyBackgroundTaskState,
  applyTaskMessage,
  getWaitableInFlightTaskIds,
  WATCH_TOOL_NAMES,
  type BackgroundTaskState,
} from "./background-task-tracker";

const UUID = "00000000-0000-0000-0000-000000000000" as const;
const SESSION = "session-1";

function taskStarted(
  overrides: Partial<SDKTaskStartedMessage> & { task_id: string },
): SDKTaskStartedMessage {
  return {
    type: "system",
    subtype: "task_started",
    description: "background work",
    uuid: UUID,
    session_id: SESSION,
    ...overrides,
  };
}

function taskNotification(
  task_id: string,
  status: SDKTaskNotificationMessage["status"],
  overrides: Partial<SDKTaskNotificationMessage> = {},
): SDKTaskNotificationMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id,
    status,
    output_file: "/tmp/out.log",
    summary: "done",
    uuid: UUID,
    session_id: SESSION,
    ...overrides,
  };
}

function taskUpdated(
  task_id: string,
  patch: SDKTaskUpdatedMessage["patch"],
): SDKTaskUpdatedMessage {
  return {
    type: "system",
    subtype: "task_updated",
    task_id,
    patch,
    uuid: UUID,
    session_id: SESSION,
  };
}

function taskProgress(task_id: string): SDKTaskProgressMessage {
  return {
    type: "system",
    subtype: "task_progress",
    task_id,
    description: "still running",
    usage: { total_tokens: 1, tool_uses: 0, duration_ms: 10 },
    uuid: UUID,
    session_id: SESSION,
  };
}

/** Build a tool-name map for the originating-tool correlation. */
function toolNames(
  entries: Record<string, string>,
): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

describe("background-task-tracker", () => {
  describe("emptyBackgroundTaskState", () => {
    it("is empty and yields no waitable ids", () => {
      const state = emptyBackgroundTaskState();
      expect(state.tasks.size).toBe(0);
      expect(getWaitableInFlightTaskIds(state)).toEqual([]);
    });
  });

  describe("started -> present and waitable (Req 1.1)", () => {
    it("records a started task as in-flight, running, and waitable by default", () => {
      const state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "t1" }),
      );
      const record = state.tasks.get("t1");
      expect(record).toBeDefined();
      expect(record?.status).toBe("running");
      expect(record?.classification).toBe("waitable");
      expect(getWaitableInFlightTaskIds(state)).toEqual(["t1"]);
    });

    it("does not mutate the input state (pure reducer)", () => {
      const before = emptyBackgroundTaskState();
      const after = applyTaskMessage(before, taskStarted({ task_id: "t1" }));
      expect(before.tasks.size).toBe(0);
      expect(after.tasks.size).toBe(1);
      expect(after).not.toBe(before);
    });
  });

  describe("classify by originating tool name (Req 2.1, 2.2, 2.3)", () => {
    it("classifies a Monitor-originated task as excluded and keeps it out of the waitable set (Req 2.2)", () => {
      const state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "mon-1", tool_use_id: "tool-mon" }),
        { toolNamesById: toolNames({ "tool-mon": "Monitor" }) },
      );
      expect(state.tasks.get("mon-1")?.classification).toBe("excluded");
      expect(getWaitableInFlightTaskIds(state)).toEqual([]);
    });

    it("classifies a backgrounded Bash task as waitable (Req 2.1)", () => {
      const state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "shell-1", tool_use_id: "tool-bash" }),
        { toolNamesById: toolNames({ "tool-bash": "Bash" }) },
      );
      expect(state.tasks.get("shell-1")?.classification).toBe("waitable");
      expect(getWaitableInFlightTaskIds(state)).toEqual(["shell-1"]);
    });

    it("classifies a subagent Task run as waitable (Req 2.1)", () => {
      const state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "agent-1", tool_use_id: "tool-task" }),
        { toolNamesById: toolNames({ "tool-task": "Task" }) },
      );
      expect(state.tasks.get("agent-1")?.classification).toBe("waitable");
      expect(getWaitableInFlightTaskIds(state)).toEqual(["agent-1"]);
    });

    it("defaults to waitable when the originating tool name is unknown (Req 2.3)", () => {
      const state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "unk-1", tool_use_id: "tool-x" }),
        { toolNamesById: toolNames({ "tool-other": "Bash" }) },
      );
      expect(state.tasks.get("unk-1")?.classification).toBe("waitable");
      expect(getWaitableInFlightTaskIds(state)).toEqual(["unk-1"]);
    });

    it("defaults to waitable when no tool_use_id correlates the task (Req 2.3)", () => {
      const state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "unk-2" }),
        { toolNamesById: toolNames({ "tool-mon": "Monitor" }) },
      );
      expect(state.tasks.get("unk-2")?.classification).toBe("waitable");
      expect(getWaitableInFlightTaskIds(state)).toEqual(["unk-2"]);
    });

    it("defaults to waitable when no tool-name map is supplied (Req 2.3)", () => {
      const state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "unk-3", tool_use_id: "tool-mon" }),
      );
      expect(state.tasks.get("unk-3")?.classification).toBe("waitable");
      expect(getWaitableInFlightTaskIds(state)).toEqual(["unk-3"]);
    });

    it("exposes Monitor as the watch tool name", () => {
      expect(WATCH_TOOL_NAMES.has("Monitor")).toBe(true);
      expect(WATCH_TOOL_NAMES.has("Bash")).toBe(false);
    });
  });

  describe("settlement is independent of classification (Req 1.2, 4.3)", () => {
    it("settles a Monitor-originated (excluded) task when it ends", () => {
      let state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "mon-1", tool_use_id: "tool-mon" }),
        { toolNamesById: toolNames({ "tool-mon": "Monitor" }) },
      );
      expect(state.tasks.get("mon-1")?.status).toBe("running");
      state = applyTaskMessage(state, taskNotification("mon-1", "stopped"));
      expect(state.tasks.get("mon-1")?.status).toBe("stopped");
      expect(state.tasks.get("mon-1")?.classification).toBe("excluded");
    });

    it("removes a completed waitable task from the waitable set", () => {
      let state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "t1" }),
      );
      state = applyTaskMessage(state, taskNotification("t1", "completed"));
      expect(state.tasks.get("t1")?.status).toBe("completed");
      expect(getWaitableInFlightTaskIds(state)).toEqual([]);
    });

    it("settles a failed task (Req 4.3)", () => {
      let state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "t1" }),
      );
      state = applyTaskMessage(state, taskNotification("t1", "failed"));
      expect(state.tasks.get("t1")?.status).toBe("failed");
      expect(getWaitableInFlightTaskIds(state)).toEqual([]);
    });

    it("settles a stopped task (Req 4.3)", () => {
      let state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "t1" }),
      );
      state = applyTaskMessage(state, taskNotification("t1", "stopped"));
      expect(state.tasks.get("t1")?.status).toBe("stopped");
      expect(getWaitableInFlightTaskIds(state)).toEqual([]);
    });
  });

  describe("settlement via terminal task_updated.patch.status (Req 4.3)", () => {
    it("settles when patch.status is completed", () => {
      let state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "t1" }),
      );
      state = applyTaskMessage(
        state,
        taskUpdated("t1", { status: "completed" }),
      );
      expect(getWaitableInFlightTaskIds(state)).toEqual([]);
    });

    it("settles when patch.status is killed", () => {
      let state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "t1" }),
      );
      state = applyTaskMessage(state, taskUpdated("t1", { status: "killed" }));
      expect(state.tasks.get("t1")?.status).toBe("killed");
      expect(getWaitableInFlightTaskIds(state)).toEqual([]);
    });

    it("does NOT settle on a non-terminal patch.status (running)", () => {
      let state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "t1" }),
      );
      state = applyTaskMessage(state, taskUpdated("t1", { status: "running" }));
      expect(getWaitableInFlightTaskIds(state)).toEqual(["t1"]);
    });

    it("never returns a settled task to running (monotonic status)", () => {
      let state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "t1" }),
      );
      state = applyTaskMessage(state, taskNotification("t1", "completed"));
      state = applyTaskMessage(state, taskUpdated("t1", { status: "running" }));
      expect(state.tasks.get("t1")?.status).toBe("completed");
      expect(getWaitableInFlightTaskIds(state)).toEqual([]);
    });
  });

  describe("progress is noise (Req 1.3)", () => {
    it("ignores task_progress for set membership", () => {
      let state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "t1" }),
      );
      const before = state;
      state = applyTaskMessage(state, taskProgress("t1"));
      expect(getWaitableInFlightTaskIds(state)).toEqual(["t1"]);
      // No-op should not produce membership change.
      expect(getWaitableInFlightTaskIds(state)).toEqual(
        getWaitableInFlightTaskIds(before),
      );
    });

    it("ignores a notification for an unknown task id", () => {
      const state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskNotification("ghost", "completed"),
      );
      expect(state.tasks.size).toBe(0);
    });
  });

  describe("interleaved sequence -> accurate waitable set (Req 1.3)", () => {
    it("tracks a mixed sequence of starts, a Monitor watch, settles, and progress", () => {
      let state = emptyBackgroundTaskState();
      const names = toolNames({
        "tu-a": "Bash",
        "tu-b": "Bash",
        "tu-c": "Monitor",
      });

      // Two one-off shells start (waitable).
      state = applyTaskMessage(
        state,
        taskStarted({ task_id: "shell-a", tool_use_id: "tu-a" }),
        { toolNamesById: names },
      );
      state = applyTaskMessage(
        state,
        taskStarted({ task_id: "shell-b", tool_use_id: "tu-b" }),
        { toolNamesById: names },
      );

      // A Monitor watch starts and is classified excluded.
      state = applyTaskMessage(
        state,
        taskStarted({ task_id: "watch-c", tool_use_id: "tu-c" }),
        { toolNamesById: names },
      );

      expect(getWaitableInFlightTaskIds(state).sort()).toEqual([
        "shell-a",
        "shell-b",
      ]);

      // Progress noise for shell-a — no membership change.
      state = applyTaskMessage(state, taskProgress("shell-a"));
      expect(getWaitableInFlightTaskIds(state).sort()).toEqual([
        "shell-a",
        "shell-b",
      ]);

      // shell-a completes.
      state = applyTaskMessage(state, taskNotification("shell-a", "completed"));
      expect(getWaitableInFlightTaskIds(state)).toEqual(["shell-b"]);

      // shell-b fails (still settles).
      state = applyTaskMessage(state, taskNotification("shell-b", "failed"));
      expect(getWaitableInFlightTaskIds(state)).toEqual([]);

      // The excluded watch was never waited on.
      expect(state.tasks.get("watch-c")?.classification).toBe("excluded");
      expect(state.tasks.get("watch-c")?.status).toBe("running");
    });
  });

  describe("duplicate task_started", () => {
    it("never resurrects or reclassifies an already-tracked task", () => {
      let state = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "t1", tool_use_id: "tu-1" }),
        { toolNamesById: toolNames({ "tu-1": "Bash" }) },
      );
      state = applyTaskMessage(state, taskNotification("t1", "completed"));
      // A duplicate started signal — even classified differently — is ignored.
      state = applyTaskMessage(
        state,
        taskStarted({ task_id: "t1", tool_use_id: "tu-mon" }),
        { toolNamesById: toolNames({ "tu-mon": "Monitor" }) },
      );
      expect(state.tasks.get("t1")?.status).toBe("completed");
      expect(state.tasks.get("t1")?.classification).toBe("waitable");
    });
  });

  describe("unrelated messages are ignored", () => {
    it("passes through non-task SDK messages without changing state", () => {
      const start = applyTaskMessage(
        emptyBackgroundTaskState(),
        taskStarted({ task_id: "t1" }),
      );
      const thinking: SDKThinkingTokensMessage = {
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 10,
        estimated_tokens_delta: 2,
        uuid: UUID,
        session_id: SESSION,
      };
      const after: BackgroundTaskState = applyTaskMessage(start, thinking);
      expect(after).toBe(start);
      expect(getWaitableInFlightTaskIds(after)).toEqual(["t1"]);
    });
  });
});
