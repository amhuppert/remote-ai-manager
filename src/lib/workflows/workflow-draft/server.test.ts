import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createWorkflowDefinition,
  makeImplementerAssignment,
} from "@/lib/workflow-graph/test-fixtures";
import {
  createPlannerDraftSubmission,
  consumePlannerDraft,
  deletePlannerDraft,
  submitPlannerDraft,
} from "./registry";

type CapturedTool = {
  options: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
};

function createToolCaptureServer() {
  const tools = new Map<string, CapturedTool>();

  return {
    server: {
      registerTool(
        name: string,
        options: Record<string, unknown>,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        tools.set(name, { options, handler });
      },
    },
    tools,
  };
}

describe("workflow-draft/server", () => {
  it("round-trips a Cursor-staffed charter through the advertised MCP input schema", async () => {
    const { registerPlannerDraftTools } = await import("./server");
    const { draftId } = createPlannerDraftSubmission();
    const server = new McpServer({ name: "draft-test", version: "1" });
    const client = new Client({ name: "planner-test", version: "1" });
    registerPlannerDraftTools(server, { draftId }, { submitPlannerDraft });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const definition = createWorkflowDefinition({
        workflowConfig: {
          implementer: makeImplementerAssignment({
            backend: "cursor",
            modelSelection: {
              modelId: "composer-2.5",
              parameters: { fast: "false" },
            },
          }),
        },
      });
      const result = await client.callTool({
        name: "submit_workflow_draft",
        arguments: definition,
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(consumePlannerDraft(draftId)).toEqual(definition);
    } finally {
      await client.close();
      await server.close();
      deletePlannerDraft(draftId);
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers submit_workflow_draft", async () => {
    const { registerPlannerDraftTools } = await import("./server");
    const { server, tools } = createToolCaptureServer();

    registerPlannerDraftTools(
      server as never,
      { draftId: "draft-1" },
      { submitPlannerDraft: vi.fn() },
    );

    expect(tools.has("submit_workflow_draft")).toBe(true);
  });

  it("submits a validated workflow definition", async () => {
    const { registerPlannerDraftTools } = await import("./server");
    const submitPlannerDraft = vi.fn();
    const { server, tools } = createToolCaptureServer();

    registerPlannerDraftTools(
      server as never,
      { draftId: "draft-1" },
      { submitPlannerDraft },
    );

    const handler = tools.get("submit_workflow_draft")?.handler;
    const definition = {
      schemaVersion: 1,
      workflowConfig: {},
      charter: makeTestCharter(),
      parameters: [],
      prerequisites: [],
      executionContexts: [],
      tasks: [],
      edges: [],
    };
    const result = (await handler?.(definition)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(submitPlannerDraft).toHaveBeenCalledWith("draft-1", definition);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Workflow draft submitted");
  });

  it("returns an error result when validation fails", async () => {
    const { registerPlannerDraftTools } = await import("./server");
    const { server, tools } = createToolCaptureServer();

    registerPlannerDraftTools(
      server as never,
      { draftId: "draft-1" },
      { submitPlannerDraft: vi.fn() },
    );

    const handler = tools.get("submit_workflow_draft")?.handler;
    const result = (await handler?.({ schemaVersion: "bad" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation error");
  });
});
