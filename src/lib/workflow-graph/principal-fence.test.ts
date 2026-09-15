/**
 * The execution-turnover fence for agent mutation authority (D7 R9.1/R9.4).
 *
 * The hole this closes: every lifecycle verb authorizes against the execution
 * it READ and then writes through a session-keyed API — "pause the session's
 * active run", not "pause execution E1". Those name the same run almost always,
 * and a different one exactly when it matters. If E1 settles and successor E2
 * takes the lease in the gap, an authorization that named E1's origin is spent
 * on E2, and an agent with no business on E2 mutates it.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ExecutionTurnoverError,
  LaneBindingTurnoverError,
  assertExecutionPrincipalFence,
  getCurrentExecutionPrincipalFence,
  runWithExecutionPrincipalFence,
  type GraphWorkflowPrincipalFence,
} from "./principal-fence";
import { createWorkflowExecution } from "./test-fixtures";

const fence = (
  overrides: Partial<GraphWorkflowPrincipalFence> = {},
): GraphWorkflowPrincipalFence => ({
  projectPath: "/repo",
  sessionName: "session-1",
  executionId: "execution-1",
  originConversationId: "origin-conv",
  principal: { kind: "conversation", conversationId: "origin-conv" },
  ...overrides,
});

describe("runWithExecutionPrincipalFence", () => {
  it("reports cross-module execution turnover as a conflict", async () => {
    vi.resetModules();
    const routeModule = await import("./mutation-guard");
    const result = await routeModule.runPinnedMutation(
      fence(),
      "pause",
      async () => {
        assertExecutionPrincipalFence(
          "/repo",
          "session-1",
          createWorkflowExecution({ id: "execution-successor" }),
        );
      },
    );
    expect(result.kind).toBe("turnover");
    if (result.kind !== "turnover")
      throw new Error("expected turnover refusal");
    expect(result.refusal.status).toBe(409);
    expect(await result.refusal.json()).toMatchObject({
      code: "execution_turnover",
      authorizedExecutionId: "execution-1",
      activeExecutionId: "execution-successor",
    });
  });

  it("enforces route authority across independently loaded runtime modules", async () => {
    vi.resetModules();
    const routeModule = await import("./principal-fence");
    await routeModule.runWithExecutionPrincipalFence(fence(), async () => {
      await Promise.resolve();
      expect(() =>
        assertExecutionPrincipalFence(
          "/repo",
          "session-1",
          createWorkflowExecution({
            id: "execution-successor",
          }),
        ),
      ).toThrow(ExecutionTurnoverError);
    });
  });

  it("exposes the fence to everything the fenced act awaits", async () => {
    const observed = await runWithExecutionPrincipalFence(fence(), async () => {
      await Promise.resolve();
      return getCurrentExecutionPrincipalFence();
    });

    expect(observed).toEqual(fence());
    expect(getCurrentExecutionPrincipalFence()).toBeNull();
  });
});

describe("assertExecutionPrincipalFence", () => {
  it("is a no-op outside any fenced act", () => {
    expect(() =>
      assertExecutionPrincipalFence(
        "/repo",
        "session-1",
        createWorkflowExecution({ id: "anything" }),
      ),
    ).not.toThrow();
  });

  it("admits the execution the principal was authorized against", async () => {
    await runWithExecutionPrincipalFence(fence(), async () => {
      expect(() =>
        assertExecutionPrincipalFence(
          "/repo",
          "session-1",
          createWorkflowExecution({ id: "execution-1" }),
        ),
      ).not.toThrow();
    });
  });

  it("refuses a successor that took the lease after authorization", async () => {
    await runWithExecutionPrincipalFence(fence(), async () => {
      expect(() =>
        assertExecutionPrincipalFence(
          "/repo",
          "session-1",
          createWorkflowExecution({ id: "execution-2" }),
        ),
      ).toThrow(ExecutionTurnoverError);
    });
  });

  it("refuses when the authorized execution is gone entirely", async () => {
    await runWithExecutionPrincipalFence(fence(), async () => {
      expect(() =>
        assertExecutionPrincipalFence("/repo", "session-1", null),
      ).toThrow(ExecutionTurnoverError);
    });
  });

  it("leaves other sessions' state outside its claim", async () => {
    // A fenced act may legitimately write to a different session (collaboration
    // dispatch does). The fence speaks only for the session it guarded.
    await runWithExecutionPrincipalFence(fence(), async () => {
      expect(() =>
        assertExecutionPrincipalFence(
          "/repo",
          "other-session",
          createWorkflowExecution({ id: "execution-9" }),
        ),
      ).not.toThrow();
    });
  });

  it("carries the authorized and observed executions on the refusal", async () => {
    await runWithExecutionPrincipalFence(fence(), async () => {
      try {
        assertExecutionPrincipalFence(
          "/repo",
          "session-1",
          createWorkflowExecution({ id: "execution-2" }),
        );
        expect.unreachable("turnover must throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ExecutionTurnoverError);
        if (!(error instanceof ExecutionTurnoverError)) return;
        expect(error.fence.executionId).toBe("execution-1");
        expect(error.actualExecutionId).toBe("execution-2");
      }
    });
  });

  it("refuses a lane whose binding rotates before its first serialized mutation", async () => {
    const base = createWorkflowExecution({ id: "execution-1" });
    const reboundExecution = {
      ...base,
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...base.taskStates["task-plan-1"]!,
          status: "running" as const,
          lastConversationId: "successor-lane-conv",
        },
      },
    };

    await expect(
      runWithExecutionPrincipalFence(
        fence({
          principal: {
            kind: "lane",
            executionId: "execution-1",
            contextId: "context-plan",
            conversationId: "authorized-lane-conv",
          },
        }),
        async () => {
          assertExecutionPrincipalFence("/repo", "session-1", reboundExecution);
        },
      ),
    ).rejects.toThrow(LaneBindingTurnoverError);
  });

  it("retains a lane's admission after its first write retires the binding", async () => {
    const active = createWorkflowExecution({ id: "execution-1" });
    active.taskStates["task-plan-1"] = {
      ...active.taskStates["task-plan-1"]!,
      status: "running",
      lastConversationId: "authorized-lane-conv",
    };
    const retired = {
      ...active,
      taskStates: {
        ...active.taskStates,
        "task-plan-1": {
          ...active.taskStates["task-plan-1"]!,
          status: "completed" as const,
        },
      },
    };

    await expect(
      runWithExecutionPrincipalFence(
        fence({
          principal: {
            kind: "lane",
            executionId: "execution-1",
            contextId: "context-plan",
            conversationId: "authorized-lane-conv",
          },
        }),
        async () => {
          assertExecutionPrincipalFence("/repo", "session-1", active);
          assertExecutionPrincipalFence("/repo", "session-1", retired);
        },
      ),
    ).resolves.toBeUndefined();
  });
});
