import { beforeEach, describe, expect, it, vi } from "vitest";

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
