import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

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

describe("mcp-gateway/planner-draft-server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers submit_workflow_draft", async () => {
    const { registerPlannerDraftTools } =
      await import("./planner-draft-server");
    const { server, tools } = createToolCaptureServer();

    registerPlannerDraftTools(
      server as never,
      { draftId: "draft-1" },
      { submitPlannerDraft: vi.fn() },
    );

    expect(tools.has("submit_workflow_draft")).toBe(true);
  });

  it("submits a validated workflow definition", async () => {
    const { registerPlannerDraftTools } =
      await import("./planner-draft-server");
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
    const { registerPlannerDraftTools } =
      await import("./planner-draft-server");
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
