import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecution } from "@/types";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { resolveBoundConversationId } from "./workflow-execution-server";

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    resolveProjectPath: vi.fn(async () => "/projects/test"),
    loadExecutionContext: vi.fn(async () => ({
      executionContextTitle: "Build auth",
      allowAgentTaskAdd: true,
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => undefined),
    })),
    registerGraphWorkflowExecutionTools: vi.fn(),
    ...overrides,
  };
}

describe("mcp-gateway/workflow-execution-server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers graph workflow execution tools for the resolved context", async () => {
    const { createWorkflowExecutionMcpServer } =
      await import("./workflow-execution-server");
    const deps = createDeps();

    await createWorkflowExecutionMcpServer(
      {
        name: "my-project",
        session: "test session",
        executionId: "exec-1",
        contextId: "ctx-1",
      },
      deps,
    );

    expect(deps.registerGraphWorkflowExecutionTools).toHaveBeenCalledOnce();
    expect(deps.loadExecutionContext).toHaveBeenCalledWith(
      "/projects/test",
      "test session",
      "exec-1",
      "ctx-1",
    );
  });

  it("throws when the project cannot be resolved", async () => {
    const { createWorkflowExecutionMcpServer } =
      await import("./workflow-execution-server");
    const deps = createDeps({
      resolveProjectPath: vi.fn(async () => null),
    });

    await expect(
      createWorkflowExecutionMcpServer(
        {
          name: "missing-project",
          session: "test session",
          executionId: "exec-1",
          contextId: "ctx-1",
        },
        deps,
      ),
    ).rejects.toThrow("Project not found");
  });

  it("throws when the execution context cannot be resolved", async () => {
    const { createWorkflowExecutionMcpServer } =
      await import("./workflow-execution-server");
    const deps = createDeps({
      loadExecutionContext: vi.fn(async () => null),
    });

    await expect(
      createWorkflowExecutionMcpServer(
        {
          name: "my-project",
          session: "test session",
          executionId: "exec-1",
          contextId: "missing",
        },
        deps,
      ),
    ).rejects.toThrow("Workflow execution context not found");
  });
});

describe("resolveBoundConversationId", () => {
  function buildExecution(): GraphWorkflowExecution {
    return createWorkflowExecution();
  }

  it("returns the lane conversation when no task in the bound context is running", () => {
    const base = buildExecution();
    const planTask = base.taskStates["task-plan-1"];
    if (!planTask) throw new Error("missing plan task fixture");
    const execution: GraphWorkflowExecution = {
      ...base,
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...planTask,
          status: "completed",
          lastConversationId: "conv-stale-completed",
          completedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      laneStates: {
        "context-plan": {
          implementer: {
            lane: "implementer",
            contextId: "context-plan",
            engine: "claude",
            workflowConversationId: "conv-active-lane",
            sessionRef: {
              engine: "claude",
              lane: "implementer",
              conversationId: "conv-session-ref",
            },
            lastContextTokens: null,
            lastContextWindowMax: null,
            rotateBeforeNextTurn: false,
            limitEvaluation: "disabled",
            lastUsedAt: "2026-03-27T12:00:00.000Z",
          },
        },
      },
    };

    expect(resolveBoundConversationId(execution, "context-plan")).toBe(
      "conv-active-lane",
    );
  });

  it("prefers a running task's lastConversationId over the lane state", () => {
    const base = buildExecution();
    const planTask = base.taskStates["task-plan-1"];
    if (!planTask) throw new Error("missing plan task fixture");
    const execution: GraphWorkflowExecution = {
      ...base,
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...planTask,
          status: "running",
          lastConversationId: "conv-running-task",
          startedAt: "2026-03-27T12:00:00.000Z",
        },
      },
      laneStates: {
        "context-plan": {
          implementer: {
            lane: "implementer",
            contextId: "context-plan",
            engine: "claude",
            workflowConversationId: "conv-other-lane",
            sessionRef: {
              engine: "claude",
              lane: "implementer",
              conversationId: "conv-session-ref",
            },
            lastContextTokens: null,
            lastContextWindowMax: null,
            rotateBeforeNextTurn: false,
            limitEvaluation: "disabled",
            lastUsedAt: "2026-03-27T12:00:00.000Z",
          },
        },
      },
    };

    expect(resolveBoundConversationId(execution, "context-plan")).toBe(
      "conv-running-task",
    );
  });

  it("ignores completed tasks in the bound context when no lane is recorded", () => {
    const base = buildExecution();
    const planTask = base.taskStates["task-plan-1"];
    if (!planTask) throw new Error("missing plan task fixture");
    const execution: GraphWorkflowExecution = {
      ...base,
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...planTask,
          status: "completed",
          lastConversationId: "conv-stale",
          completedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    expect(resolveBoundConversationId(execution, "context-plan")).toBeNull();
  });
});
