import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowSemanticDefinition } from "@/types";

const submittedDefinition: WorkflowSemanticDefinition = {
  schemaVersion: 1,
  workflowConfig: {},
  executionContexts: [
    {
      id: "context-plan",
      title: "Plan",
      description: "Inspect the implementation surface.",
      acceptanceCriteria: "TBD",
      implementer: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
      },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: {
        maxIterations: 2,
        continuity: { enabled: true },
      },
    },
  ],
  tasks: [
    {
      id: "task-plan-1",
      contextId: "context-plan",
      order: 1,
      title: "Inspect",
      instructions: "Read the current implementation.",
      source: "user",
    },
  ],
  edges: [],
};

const runMock = vi.fn();
const createPlannerDraftSubmissionMock = vi.fn(() => ({
  draftId: "draft-123",
}));
const consumePlannerDraftMock = vi.fn(() => submittedDefinition);
const deletePlannerDraftMock = vi.fn();
const buildWorkflowDraftPortableMcpMock = vi.fn(() => ({
  servers: [{ id: "cc-workflow-draft" }],
}));

vi.mock("@/lib/agent-backends/registry", () => ({
  getTaskRunner: vi.fn(() => ({
    run: runMock,
  })),
}));

vi.mock("@/lib/mcp-gateway/planner-draft-registry", () => ({
  createPlannerDraftSubmission: createPlannerDraftSubmissionMock,
  consumePlannerDraft: consumePlannerDraftMock,
  deletePlannerDraft: deletePlannerDraftMock,
}));

vi.mock("@/lib/mcp-gateway/portable-config", () => ({
  buildWorkflowDraftPortableMcp: buildWorkflowDraftPortableMcpMock,
}));

describe("workflow graph planner default runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMock.mockResolvedValue({
      text: null,
      usage: null,
      error: null,
      timedOut: false,
    });
  });

  it("uses workflow draft portable MCP and consumes the submitted draft", async () => {
    const { createWorkflowPlannerService } = await import("./planner");
    const service = createWorkflowPlannerService({
      loadSeedDefinition: vi.fn(async () => null),
    });

    const result = await service.generateDraft({
      objective: "Plan the migration",
      references: [],
      projectPath: "/projects/remote-ai-manager",
    });

    expect(buildWorkflowDraftPortableMcpMock).toHaveBeenCalledWith(
      "remote-ai-manager",
      "draft-123",
    );
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tooling: {
          portableMcp: {
            servers: [{ id: "cc-workflow-draft" }],
          },
        },
      }),
    );
    expect(consumePlannerDraftMock).toHaveBeenCalledWith("draft-123");
    expect(deletePlannerDraftMock).toHaveBeenCalledWith("draft-123");
    expect(result.definition).toEqual(submittedDefinition);
  });
});
