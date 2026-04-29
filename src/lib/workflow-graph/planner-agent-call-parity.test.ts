import { describe, expect, it, vi } from "vitest";
import type {
  AgentTaskRunner,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import type { WorkflowSemanticDefinition } from "@/types";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import { createDefaultPlannerRunner } from "./planner";

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

function createMockRunner(result: Partial<AgentTaskResult>): AgentTaskRunner {
  return {
    backend: "claude",
    run: vi.fn().mockResolvedValue({
      backendRef: null,
      text: null,
      structuredOutput: undefined,
      usage: null,
      error: null,
      timedOut: false,
      ...result,
    }),
  };
}

describe("workflow graph planner Task 6.3 parity (executeAgentCall route)", () => {
  it("routes the planner turn through deps.executeAgentCall as kind=task_run with write_capable", async () => {
    const runner = createMockRunner({ text: "ok" });
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);

    const runPlannerQuery = createDefaultPlannerRunner({
      getTaskRunner: () => runner,
      executeAgentCall: executeAgentCallSpy,
      createPlannerDraftSubmission: () => ({ draftId: "draft-123" }),
      consumePlannerDraft: () => submittedDefinition,
      deletePlannerDraft: () => undefined,
      buildWorkflowDraftPortableMcp: () => STUB_PORTABLE_MCP,
    });

    const result = await runPlannerQuery(
      {
        objective: "Plan migration",
        references: [],
        projectPath: "/projects/remote-ai-manager",
      },
      null,
    );

    expect(result).toEqual(submittedDefinition);
    expect(executeAgentCallSpy).toHaveBeenCalledTimes(1);
    const [request] = executeAgentCallSpy.mock.calls[0]!;
    expect(request).toMatchObject({
      kind: "task_run",
      backend: "claude",
      writeCapability: "write_capable",
    });
    expect(request.tooling).toEqual(STUB_PORTABLE_MCP);
  });
});
