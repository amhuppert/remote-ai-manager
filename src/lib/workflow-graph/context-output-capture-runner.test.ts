import { describe, expect, it, vi } from "vitest";
import type { ConversationTurnExecution } from "@/lib/workflows/conversation/manager";
import type { ConversationTurnSubmission } from "@/lib/workflows/conversation/turn-spec";
import { settledConversationTurn } from "@/lib/workflows/conversation/testing/turn-result-fixture";
import { createWorkflowExecution } from "./test-fixtures";
import { createGraphWorkflowOutputCaptureRunner } from "./context-output-capture-runner";
import { AgentTurnFailedError } from "./errors";
import type { GraphWorkflowExecution } from "./schemas";
import { composeImplementerLaneWriteEnvelope } from "./implementer-lane-write-envelope";

/** The single dispatched turn input, narrowed from the spy's untyped call
 *  record so each assertion reads against the real request contract. */
function dispatchedInput(spy: {
  mock: { calls: unknown[][] };
}): ConversationTurnSubmission {
  const first = spy.mock.calls[0]?.[0];
  if (first === undefined) throw new Error("no turn was dispatched");
  return first as ConversationTurnSubmission;
}

function answering(result: ConversationTurnExecution) {
  return vi.fn(async (_input: ConversationTurnSubmission) => result);
}

const CAPTURED = settledConversationTurn({
  outcome: {
    kind: "completed",
    structuredOutput: { summary: "done", risks: [] },
    parse: { source: "raw_json" },
    text: "",
  },
});

function gateRefusal(details: Record<string, unknown>, refusedText: string) {
  return settledConversationTurn({
    outcome: {
      kind: "failed",
      error: {
        backend: "claude",
        failureKind: "schema_validation",
        message: "structured output failed validation",
        backendDetails: details,
      },
      contentBlocks: [{ type: "text", text: refusedText }],
    },
  });
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
  it("continues the live lane conversation with the declared schema as a single-turn output contract", async () => {
    const executeConversationTurn = answering(CAPTURED);

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeConversationTurn,
    });
    const outcome = await runner.captureContextOutput(
      captureInput(executionWithSchema()),
    );

    expect(executeConversationTurn).toHaveBeenCalledTimes(1);
    const dispatched = dispatchedInput(executeConversationTurn);
    // A conversation turn rides the lane's live runtime, so the backend sees the
    // same session prefix as the work turn and can reuse its prompt cache.
    expect(dispatched.turn.kind).toBe("conversation_turn");
    expect(dispatched.binding.address.target.conversationId).toBe(
      "conversation-lane",
    );
    if (dispatched.turn.kind !== "conversation_turn") {
      throw new Error("expected a conversation turn");
    }
    // Validation must ride the canonical AgentCall gate, which only runs when
    // the turn carries the declared schema verbatim.
    expect(dispatched.turn.outputFormat).toEqual({
      type: "json_schema",
      schema: OUTPUT_SCHEMA,
    });
    expect(dispatched.turn.structuredOutputTurns).toBe("single");
    expect(dispatched.turn.modelSelection).toEqual({
      modelId: "opus",
      parameters: { effort: "high" },
    });
    expect(dispatched.turn.fsWritePolicy).toBeUndefined();
    expect(dispatched.turn.promptText).toContain('"summary"');
    expect(dispatched.executionContext?.workflowContext).toEqual({
      executionId: expect.any(String),
      contextId: "context-plan",
    });

    expect(outcome).toEqual({
      kind: "captured",
      value: { summary: "done", risks: [] },
      parse: { source: "raw_json" },
    });
  });

  it("keeps the implementer's ask-user setting so the live runtime is not rebuilt", async () => {
    const executeConversationTurn = answering(CAPTURED);
    const execution = executionWithSchema();
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    );
    if (!context) throw new Error("fixture missing context-plan");
    context.askUserQuestions = { enabled: true };

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeConversationTurn,
    });
    await runner.captureContextOutput(captureInput(execution));

    const dispatched = dispatchedInput(executeConversationTurn);
    if (dispatched.turn.kind !== "conversation_turn") {
      throw new Error("expected a conversation turn");
    }
    expect(dispatched.turn.askUserQuestionsEnabled).toBe(true);
    expect(dispatched.turn.autonomous).toBe(true);
  });

  it("retains a confined implementer's write envelope on the format turn", async () => {
    const executeConversationTurn = answering(CAPTURED);
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
      executeConversationTurn,
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
    const dispatched = dispatchedInput(executeConversationTurn);
    if (dispatched.turn.kind !== "conversation_turn") {
      throw new Error("expected a conversation turn");
    }
    expect(dispatched.turn.fsWritePolicy).toEqual(expectedPolicy);
    expect(dispatched.binding.worktreePath).toBe(executionTarget.worktreePath);
  });

  it("composes an owned-lane envelope from the resolved execution target", async () => {
    const executeConversationTurn = answering(CAPTURED);
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
      executeConversationTurn,
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
    const dispatched = dispatchedInput(executeConversationTurn);
    if (dispatched.turn.kind !== "conversation_turn") {
      throw new Error("expected a conversation turn");
    }
    expect(dispatched.turn.fsWritePolicy).toEqual(policy);
  });

  it("fails closed when an owned capture has no execution target", async () => {
    const executeConversationTurn = vi.fn();
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
      executeConversationTurn,
      resolveWorktreePath,
    });

    await expect(
      runner.captureContextOutput(captureInput(execution)),
    ).rejects.toThrow(/no execution target/i);
    expect(resolveWorktreePath).not.toHaveBeenCalled();
    expect(executeConversationTurn).not.toHaveBeenCalled();
  });

  it("renders the previous rejection into a retry turn's prompt", async () => {
    const executeConversationTurn = answering(CAPTURED);

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeConversationTurn,
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

    const dispatched = dispatchedInput(executeConversationTurn);
    if (dispatched.turn.kind !== "conversation_turn") {
      throw new Error("expected a conversation turn");
    }
    expect(dispatched.turn.promptText).toContain(
      "previous output was rejected",
    );
    expect(dispatched.turn.promptText).toContain("$.risks is required");
  });

  it("maps a gate refusal into a rejection with path-keyed issues and the refused text", async () => {
    const executeConversationTurn = answering(
      gateRefusal(
        { errors: ["$.risks is required", "$.summary must be string"] },
        '{"summary": 4}',
      ),
    );

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeConversationTurn,
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
    const executeConversationTurn = answering(
      gateRefusal(
        {
          errors: ["$.risks is required"],
          repairAttempts: 1,
          repairMaxAttempts: 1,
        },
        "{}",
      ),
    );

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeConversationTurn,
    });
    const outcome = await runner.captureContextOutput(
      captureInput(executionWithSchema()),
    );

    if (outcome.kind !== "rejected") throw new Error("expected a rejection");
    expect(outcome.gateRepair).toEqual({ attempts: 1, maxAttempts: 1 });
  });

  it("throws for a turn that failed outside the gate instead of counting a schema rejection", async () => {
    const executeConversationTurn = answering(
      settledConversationTurn({
        outcome: {
          kind: "failed",
          error: {
            backend: "claude",
            failureKind: "backend_error",
            message: "SDK transport closed",
          },
        },
      }),
    );

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeConversationTurn,
    });

    await expect(
      runner.captureContextOutput(captureInput(executionWithSchema())),
    ).rejects.toBeInstanceOf(AgentTurnFailedError);
  });

  it("throws when the conversation refuses to admit the turn", async () => {
    const executeConversationTurn = answering({
      kind: "refused",
      code: "busy",
      message: "conversation is busy",
    });

    const runner = createGraphWorkflowOutputCaptureRunner({
      executeConversationTurn,
    });

    await expect(
      runner.captureContextOutput(captureInput(executionWithSchema())),
    ).rejects.toBeInstanceOf(AgentTurnFailedError);
  });
});
