import { beforeEach, describe, expect, it, vi } from "vitest";

const TOOLS_KEY = "__test_graph_workflow_tools";

function getCapturedTools(): Map<
  string,
  { name: string; handler: (args: unknown) => Promise<unknown> }
> {
  const globalState = globalThis as unknown as Record<string, unknown>;
  if (!globalState[TOOLS_KEY]) {
    globalState[TOOLS_KEY] = new Map();
  }

  return globalState[TOOLS_KEY] as Map<
    string,
    { name: string; handler: (args: unknown) => Promise<unknown> }
  >;
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const toolsKey = "__test_graph_workflow_tools";

  function getTools(): Map<
    string,
    { name: string; handler: (args: unknown) => Promise<unknown> }
  > {
    const globalState = globalThis as unknown as Record<string, unknown>;
    if (!globalState[toolsKey]) {
      globalState[toolsKey] = new Map();
    }

    return globalState[toolsKey] as Map<
      string,
      { name: string; handler: (args: unknown) => Promise<unknown> }
    >;
  }

  return {
    createSdkMcpServer: vi.fn(
      (config: {
        tools: Array<{
          name: string;
          handler: (args: unknown) => Promise<unknown>;
        }>;
      }) => {
        const tools = getTools();
        for (const tool of config.tools) {
          tools.set(tool.name, tool);
        }

        return { __mock: true, tools: config.tools };
      },
    ),
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) => ({
        name,
        handler,
      }),
    ),
  };
});

function getHandler(name: string): (args: unknown) => Promise<unknown> {
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
    const { createGraphWorkflowToolServer } = await import("./tool-server");

    const completeTask = vi.fn(async () => undefined);
    const addTask = vi.fn(async () => undefined);
    const upsertSharedDocument = vi.fn(async () => undefined);

    createGraphWorkflowToolServer({
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

  it("omits add_task when agent task creation is not allowed", async () => {
    const { createGraphWorkflowToolServer } = await import("./tool-server");

    createGraphWorkflowToolServer({
      executionContextTitle: "Implement",
      allowAgentTaskAdd: false,
      completeTask: vi.fn(async () => undefined),
      addTask: vi.fn(async () => undefined),
      upsertSharedDocument: vi.fn(async () => undefined),
    });

    expect(getCapturedTools().has("add_task")).toBe(false);
  });

  it("fails closed on invalid payloads and callback errors", async () => {
    const { createGraphWorkflowToolServer } = await import("./tool-server");

    createGraphWorkflowToolServer({
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
