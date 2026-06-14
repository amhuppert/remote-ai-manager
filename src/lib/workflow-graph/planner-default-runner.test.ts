import { describe, expect, it, vi } from "vitest";
import type { WorkflowSemanticDefinition } from "@/lib/workflows/schemas";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import { createDefaultPlannerRunner } from "./planner";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

const STUB_PORTABLE_MCP: PortableMcpConfig = {
  servers: [
    {
      id: "cc-workflow-draft",
      transport: "streamable-http",
      url: "http://stub.invalid/mcp",
    },
  ],
};

const submittedDefinition: WorkflowSemanticDefinition = {
  schemaVersion: 1,
  workflowConfig: {},
  charter: makeTestCharter(),
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

describe("default planner runner — executeWorkflowTaskRun routing", () => {
  it("routes via executeWorkflowTaskRun with kind='task_run', __planner__ session, no outputFormat", async () => {
    const executeWorkflowTaskRun = vi
      .fn<
        (input: ExecuteWorkflowTaskRunInput) => Promise<{
          kind: "text";
          text: string;
          usage: {
            costUsd: null;
            durationMs: null;
            contextTokens: null;
            contextWindowMax: null;
            inputTokens: null;
            outputTokens: null;
            cachedInputTokens: null;
          };
          backendRef: null;
        }>
      >()
      .mockResolvedValue({
        kind: "text",
        text: "ok",
        usage: {
          costUsd: null,
          durationMs: null,
          contextTokens: null,
          contextWindowMax: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
        },
        backendRef: null,
      });

    const consumePlannerDraft = vi.fn(() => submittedDefinition);
    const deletePlannerDraft = vi.fn();

    const runPlannerQuery = createDefaultPlannerRunner({
      executeWorkflowTaskRun,
      createPlannerDraftSubmission: () => ({ draftId: "draft-123" }),
      consumePlannerDraft,
      deletePlannerDraft,
      buildWorkflowDraftPortableMcp: () => STUB_PORTABLE_MCP,
    });

    const result = await runPlannerQuery(
      {
        objective: "Plan the migration",
        references: [],
        projectPath: "/projects/remote-ai-manager",
        sessionName: "__planner__",
        conversationId: "planner-conv-1",
      },
      null,
    );

    expect(result).toEqual(submittedDefinition);
    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input).toMatchObject({
      projectPath: "/projects/remote-ai-manager",
      sessionName: "__planner__",
      conversationId: "planner-conv-1",
      kind: "task_run",
    });
    expect(input.outputFormat).toBeUndefined();
    expect(input.tooling).toEqual(STUB_PORTABLE_MCP);
    expect(input.prompt).toContain("Objective:\nPlan the migration");
    expect(typeof input.systemInstructions).toBe("string");

    expect(consumePlannerDraft).toHaveBeenCalledWith("draft-123");
    expect(deletePlannerDraft).toHaveBeenCalledWith("draft-123");
  });

  it("uses the planner draft from the side-channel registry as the contract — not the agent's text", async () => {
    const executeWorkflowTaskRun = vi.fn().mockResolvedValue({
      kind: "text",
      text: "free-form planner narration that is NOT the contract",
      usage: {
        costUsd: null,
        durationMs: null,
        contextTokens: null,
        contextWindowMax: null,
      },
    });

    const runPlannerQuery = createDefaultPlannerRunner({
      executeWorkflowTaskRun,
      createPlannerDraftSubmission: () => ({ draftId: "draft-456" }),
      consumePlannerDraft: () => submittedDefinition,
      deletePlannerDraft: () => undefined,
      buildWorkflowDraftPortableMcp: () => STUB_PORTABLE_MCP,
    });

    const result = await runPlannerQuery(
      {
        objective: "Plan",
        references: [],
        projectPath: "/projects/repo",
        sessionName: "__planner__",
        conversationId: "planner-conv-2",
      },
      null,
    );

    expect(result).toEqual(submittedDefinition);
  });

  it("returns an empty definition when the planner submits no draft", async () => {
    const executeWorkflowTaskRun = vi.fn().mockResolvedValue({
      kind: "text",
      text: "",
      usage: {
        costUsd: null,
        durationMs: null,
        contextTokens: null,
        contextWindowMax: null,
      },
    });

    const runPlannerQuery = createDefaultPlannerRunner({
      executeWorkflowTaskRun,
      createPlannerDraftSubmission: () => ({ draftId: "draft-789" }),
      consumePlannerDraft: () => null,
      deletePlannerDraft: () => undefined,
      buildWorkflowDraftPortableMcp: () => STUB_PORTABLE_MCP,
    });

    const result = await runPlannerQuery(
      {
        objective: "Plan",
        references: [],
        projectPath: "/projects/repo",
        sessionName: "__planner__",
        conversationId: "planner-conv-3",
      },
      null,
    );

    expect(result.schemaVersion).toBe(1);
    expect(result.workflowConfig).toEqual({});
    expect(result.executionContexts).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(result.edges).toEqual([]);
    // The empty fallback still satisfies the now-required charter contract.
    expect(result.charter.mission).toBeTruthy();
    expect(result.charter.sourcesOfTruth.length).toBeGreaterThan(0);
  });

  it("still consumes/deletes the draft when executeWorkflowTaskRun returns an error result", async () => {
    const executeWorkflowTaskRun = vi.fn().mockResolvedValue({
      kind: "error",
      error: "boom",
      aborted: false,
      usage: {
        costUsd: null,
        durationMs: null,
        contextTokens: null,
        contextWindowMax: null,
      },
    });

    const consumePlannerDraft = vi.fn(() => submittedDefinition);
    const deletePlannerDraft = vi.fn();

    const runPlannerQuery = createDefaultPlannerRunner({
      executeWorkflowTaskRun,
      createPlannerDraftSubmission: () => ({ draftId: "draft-err" }),
      consumePlannerDraft,
      deletePlannerDraft,
      buildWorkflowDraftPortableMcp: () => STUB_PORTABLE_MCP,
    });

    const result = await runPlannerQuery(
      {
        objective: "Plan",
        references: [],
        projectPath: "/projects/repo",
        sessionName: "__planner__",
        conversationId: "planner-conv-4",
      },
      null,
    );

    expect(consumePlannerDraft).toHaveBeenCalledWith("draft-err");
    expect(deletePlannerDraft).toHaveBeenCalledWith("draft-err");
    expect(result).toEqual(submittedDefinition);
  });
});
