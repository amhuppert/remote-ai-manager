import { describe, expect, it, vi } from "vitest";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import { createWorkflowExecution } from "./test-fixtures";
import { createGraphWorkflowOutputCaptureRunner } from "./context-output-capture-runner";
import { AgentTurnFailedError } from "./errors";
import type { GraphWorkflowExecution } from "./schemas";
import { composeImplementerLaneWriteEnvelope } from "./implementer-lane-write-envelope";

/** The single dispatched task-run input, narrowed from the spy's untyped call
 *  record so each assertion reads against the real request contract. */
function dispatchedInput(spy: {
  mock: { calls: unknown[][] };
}): ExecuteWorkflowTaskRunInput {
  const first = spy.mock.calls[0]?.[0];
  if (first === undefined) throw new Error("no task run was dispatched");
  return first as ExecuteWorkflowTaskRunInput;
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "risks"],
  additionalProperties: false,
};

function executionWithSchema(): GraphWorkflowExecution {
  const execution = createWorkflowExecution({ status: "running" });
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === "context-plan",
  );
  if (!context) throw new Error("fixture missing context-plan");
  context.outputSchema = OUTPUT_SCHEMA;
  execution.contextStates["context-plan"] = {
    ...execution.contextStates["context-plan"]!,
    status: "running",
    iterationCount: 2,
  };
  return execution;
}

function captureInput(execution: GraphWorkflowExecution) {
  return {
    projectPath: "/repo",
    sessionName: "session-1",
    execution,
    contextId: "context-plan",
    conversationId: "conversation-lane",
    outputSchema: OUTPUT_SCHEMA,
  };
}

describe("graph workflow output capture runner", () => {
  it("dispatches the declared schema as the turn's outputFormat on the lane conversation", async () => {
    const executeWorkflowTaskRun = vi.fn(async () => ({
      kind: "structured" as const,
      structuredOutput: { summary: "done", risks: [] },
      parse: { source: "raw_json" as const },
      text: "",
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
      continuationDisposition: "retain" as const,
    }));

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeWorkflowTaskRun,
    });
    const outcome = await runner.captureContextOutput(
      captureInput(executionWithSchema()),
    );

    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const dispatched = dispatchedInput(executeWorkflowTaskRun);
    // Validation must ride the canonical AgentCall gate, which only runs when
    // the turn carries the declared schema verbatim.
    expect(dispatched.outputFormat).toEqual({
      type: "json_schema",
      schema: OUTPUT_SCHEMA,
    });
    // Lane continuity: the format turn reuses the context's work conversation.
    expect(dispatched.binding.address.target.conversationId).toBe(
      "conversation-lane",
    );
    expect(dispatched.kind).toBe("task_run");
    expect(dispatched.modelSelection).toEqual({
      modelId: "opus",
      parameters: { effort: "high" },
    });
    expect(dispatched.fsWritePolicy).toBeUndefined();
    expect(dispatched.prompt).toContain('"summary"');
    expect(dispatched.prompt).toContain("JSON object ONLY");

    expect(outcome).toEqual({
      kind: "captured",
      value: { summary: "done", risks: [] },
      parse: { source: "raw_json" },
    });
  });

  it("retains a confined implementer's write envelope on the format turn", async () => {
    const executeWorkflowTaskRun = vi.fn(async () => ({
      kind: "structured" as const,
      structuredOutput: { summary: "done", risks: [] },
      text: "",
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
      continuationDisposition: "retain" as const,
    }));
    const execution = executionWithSchema();
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    );
    if (!context) throw new Error("fixture missing context-plan");
    context.placement = { lane: "reports", mode: "readOnly" };
    const executionTarget = {
      worktreePath: process.cwd(),
      branchName: "test-output-capture",
      isolation: "worktree" as const,
      laneId: "reports",
    };

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeWorkflowTaskRun,
    });
    await runner.captureContextOutput({
      ...captureInput(execution),
      executionTarget,
    });

    const expectedPolicy = composeImplementerLaneWriteEnvelope({
      executionId: execution.id,
      contextId: context.id,
      worktreePath: executionTarget.worktreePath,
      ownedPaths: [],
      payloadLocation: "scratch",
    }).policy;
    expect(dispatchedInput(executeWorkflowTaskRun).fsWritePolicy).toEqual(
      expectedPolicy,
    );
  });

  it("composes an owned-lane envelope from the resolved execution target", async () => {
    const executeWorkflowTaskRun = vi.fn(async () => ({
      kind: "structured" as const,
      structuredOutput: { summary: "done", risks: [] },
      text: "",
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
      continuationDisposition: "retain" as const,
    }));
    const execution = executionWithSchema();
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    );
    if (!context) throw new Error("fixture missing context-plan");
    context.placement = {
      lane: "shared",
      mode: "owned",
      ownedPaths: ["reports"],
    };
    const policy = {
      mode: "allowlist" as const,
      allowWrite: ["/scratch", "/lane/reports", "/scratch/tmp"],
      denyWrite: ["/lane/.git"],
    };
    const composeWriteEnvelope = vi.fn(() => ({
      policy,
      worktreeRoot: "/lane",
      contextScratchDir: "/scratch",
      contextTmpDir: "/scratch/tmp",
      payloadDir: "/lane/.cc/temp/context-plan",
      ownedPrefixes: ["/lane/reports"],
    }));
    const runner = createGraphWorkflowOutputCaptureRunner({
      executeWorkflowTaskRun,
      composeWriteEnvelope,
    });

    await runner.captureContextOutput({
      ...captureInput(execution),
      executionTarget: {
        worktreePath: "/lane",
        branchName: "shared",
        isolation: "worktree",
        laneId: "shared",
      },
    });

    expect(composeWriteEnvelope).toHaveBeenCalledWith({
      executionId: execution.id,
      contextId: "context-plan",
      worktreePath: "/lane",
      ownedPaths: ["reports"],
      payloadLocation: "worktree",
    });
    expect(dispatchedInput(executeWorkflowTaskRun).fsWritePolicy).toEqual(
      policy,
    );
  });

  it("fails closed when an owned capture has no execution target", async () => {
    const executeWorkflowTaskRun = vi.fn();
    const resolveWorktreePath = vi.fn(async () => "/session-worktree");
    const execution = executionWithSchema();
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    );
    if (!context) throw new Error("fixture missing context-plan");
    context.placement = {
      lane: "shared",
      mode: "owned",
      ownedPaths: ["reports"],
    };
    const runner = createGraphWorkflowOutputCaptureRunner({
      executeWorkflowTaskRun,
      resolveWorktreePath,
    });

    await expect(
      runner.captureContextOutput(captureInput(execution)),
    ).rejects.toThrow(/no execution target/i);
    expect(resolveWorktreePath).not.toHaveBeenCalled();
    expect(executeWorkflowTaskRun).not.toHaveBeenCalled();
  });

  it("renders the previous rejection into a retry turn's prompt", async () => {
    const executeWorkflowTaskRun = vi.fn(async () => ({
      kind: "structured" as const,
      structuredOutput: { summary: "done", risks: [] },
      text: "",
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
      continuationDisposition: "retain" as const,
    }));

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeWorkflowTaskRun,
    });
    await runner.captureContextOutput({
      ...captureInput(executionWithSchema()),
      previousRejection: {
        summary: "The captured output did not conform.",
        issues: [
          {
            title: "$.risks",
            description: "$.risks is required",
            path: "$.risks",
          },
        ],
      },
    });

    const dispatched = dispatchedInput(executeWorkflowTaskRun);
    expect(dispatched.prompt).toContain("previous output was rejected");
    expect(dispatched.prompt).toContain("$.risks is required");
  });

  it("maps a gate refusal into a rejection with path-keyed issues and the refused text", async () => {
    const executeWorkflowTaskRun = vi.fn(async () => ({
      kind: "error" as const,
      error:
        "structured output failed validation: $.risks is required; $.summary must be string",
      aborted: false,
      structuredOutputIssues: [
        "$.risks is required",
        "$.summary must be string",
      ],
      text: '{"summary": 4}',
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
      continuationDisposition: "retain" as const,
    }));

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeWorkflowTaskRun,
    });
    const outcome = await runner.captureContextOutput(
      captureInput(executionWithSchema()),
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected a rejection");
    expect(outcome.issues).toEqual([
      { title: "$.risks", description: "is required", path: "$.risks" },
      {
        title: "$.summary",
        description: "must be string",
        path: "$.summary",
      },
    ]);
    expect(outcome.rejectedText).toBe('{"summary": 4}');
  });

  it("carries the gate's own repair spend and budget onto the rejection", async () => {
    const executeWorkflowTaskRun = vi.fn(async () => ({
      kind: "error" as const,
      error: "structured output failed validation: $.risks is required",
      aborted: false,
      structuredOutputIssues: ["$.risks is required"],
      structuredOutputRepair: { attempts: 1, maxAttempts: 1 },
      text: "{}",
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
      continuationDisposition: "retain" as const,
    }));

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeWorkflowTaskRun,
    });
    const outcome = await runner.captureContextOutput(
      captureInput(executionWithSchema()),
    );

    if (outcome.kind !== "rejected") throw new Error("expected a rejection");
    expect(outcome.gateRepair).toEqual({ attempts: 1, maxAttempts: 1 });
  });

  it("throws for a turn that failed outside the gate instead of counting a schema rejection", async () => {
    const executeWorkflowTaskRun = vi.fn(async () => ({
      kind: "error" as const,
      error: "SDK transport closed",
      aborted: false,
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
      continuationDisposition: "retain" as const,
    }));

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeWorkflowTaskRun,
    });

    await expect(
      runner.captureContextOutput(captureInput(executionWithSchema())),
    ).rejects.toBeInstanceOf(AgentTurnFailedError);
  });
});
