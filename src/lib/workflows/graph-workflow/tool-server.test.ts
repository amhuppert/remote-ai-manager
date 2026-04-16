import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerGraphWorkflowExecutionTools } from "./tool-server";
import { IterationHaltedError } from "./iteration-orchestrator";

type ToolHandler = (args: unknown) => Promise<unknown>;

const TOOLS_KEY = "__test_graph_workflow_tools";

function getCapturedTools(): Map<
  string,
  { name: string; handler: ToolHandler }
> {
  const globalState = globalThis as Record<string, unknown>;
  if (!globalState[TOOLS_KEY]) {
    globalState[TOOLS_KEY] = new Map();
  }

  return globalState[TOOLS_KEY] as Map<
    string,
    { name: string; handler: ToolHandler }
  >;
}

function createCapturingServer() {
  return {
    registerTool(name: string, _config: unknown, handler: ToolHandler): void {
      getCapturedTools().set(name, { name, handler });
    },
  };
}

function getHandler(name: string): ToolHandler {
  const tool = getCapturedTools().get(name);
  if (!tool) {
    throw new Error(`Tool ${name} not found`);
  }

  return tool.handler;
}

describe("graph workflow tool server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  it("registers explicit task and shared-document tools", async () => {
    const completeTask = vi.fn(async () => undefined);
    const addTask = vi.fn(async () => undefined);
    const upsertSharedDocument = vi.fn(async () => undefined);

    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      completeTask,
      addTask,
      upsertSharedDocument,
    });

    expect(getCapturedTools().has("begin_task")).toBe(false);
    expect(getCapturedTools().has("complete_task")).toBe(true);
    expect(getCapturedTools().has("add_task")).toBe(true);
    expect(getCapturedTools().has("upsert_shared_document")).toBe(true);

    const completeResult = (await getHandler("complete_task")({
      taskSlug: "setup-auth",
      summary: "Finished the task.",
    })) as { isError?: boolean };
    const addResult = (await getHandler("add_task")({
      slug: "capture-unknowns",
      title: "Capture unknowns",
      instructions: "Record planning gaps.",
    })) as { isError?: boolean };
    const docResult = (await getHandler("upsert_shared_document")({
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Planning notes",
      readWhen: "Read before implementation.",
    })) as { isError?: boolean };

    expect(completeResult.isError).toBeUndefined();
    expect(addResult.isError).toBeUndefined();
    expect(docResult.isError).toBeUndefined();

    expect(completeTask).toHaveBeenCalledWith(
      "setup-auth",
      "Finished the task.",
    );
    expect(addTask).toHaveBeenCalledWith({
      slug: "capture-unknowns",
      title: "Capture unknowns",
      instructions: "Record planning gaps.",
    });
    expect(upsertSharedDocument).toHaveBeenCalledWith({
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Planning notes",
      readWhen: "Read before implementation.",
    });
  });

  it("omits add_task when agent task creation is not allowed", () => {
    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Implement",
      allowAgentTaskAdd: false,
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => undefined),
    });

    expect(getCapturedTools().has("add_task")).toBe(false);
  });

  it("returns a halt-aware tool error result when completeTask raises IterationHaltedError", async () => {
    const haltError = new IterationHaltedError({
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    });

    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      completeTask: vi.fn(async () => {
        throw haltError;
      }),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => undefined),
    });

    const result = (await getHandler("complete_task")({
      taskSlug: "setup-auth",
      summary: "Finished.",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("halted");
    expect(text).toContain("circuit_breaker");
    expect(text).toContain("no further tool calls");
  });

  it("returns a halt-aware tool error result when upsertSharedDocument raises IterationHaltedError", async () => {
    const haltError = new IterationHaltedError({
      type: "validator_infra_error",
      contextId: "context-plan",
      taskId: "task-plan-1",
      engine: "codex",
      infraReason: "unparseable",
      message: "Codex returned invalid JSON",
      summary: null,
    });

    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => {
        throw haltError;
      }),
    });

    const result = (await getHandler("upsert_shared_document")({
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Planning notes",
      readWhen: "Read before implementation.",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("halted");
    expect(text).toContain("validator_infra_error");
    expect(text).toContain("no further tool calls");
  });

  it("returns a halt-aware tool error result when addTask raises IterationHaltedError", async () => {
    const haltError = new IterationHaltedError({
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    });

    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => {
        throw haltError;
      }),
      upsertSharedDocument: vi.fn(async () => undefined),
    });

    const result = (await getHandler("add_task")({
      slug: "new-task",
      title: "New task",
      instructions: "Do something.",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("halted");
    expect(text).toContain("circuit_breaker");
    expect(text).toContain("no further tool calls");
  });

  it("fails closed on invalid payloads and callback errors", async () => {
    registerGraphWorkflowExecutionTools(createCapturingServer() as never, {
      executionContextTitle: "Plan",
      allowAgentTaskAdd: true,
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => {
        throw new Error("Path escaped shared-document directory");
      }),
    });

    const failingDocumentResult = (await getHandler("upsert_shared_document")({
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Planning notes",
      readWhen: "Read before implementation.",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(failingDocumentResult.isError).toBe(true);
    expect(failingDocumentResult.content[0]?.text).toContain(
      "Path escaped shared-document directory",
    );
  });
});
