/**
 * The advisory-response turn, with a fake at the one boundary that reaches a
 * provider. The schema the turn carries is the real one, and the coverage rule
 * it enforces is the real one — only the model's reply is authored here.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildAdvisoryDispositionsOutputSchema,
  stampAdvisoryIdentities,
} from "@/lib/workflow-graph/advisory-delivery";
import { createGraphWorkflowAdvisoryResponseRunner } from "@/lib/workflow-graph/advisory-response-runner";
import { AgentTurnFailedError } from "@/lib/workflow-graph/errors";
import { composeImplementerLaneWriteEnvelope } from "@/lib/workflow-graph/implementer-lane-write-envelope";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type { ConversationTurnExecution } from "@/lib/workflows/conversation/manager";
import { settledConversationTurn } from "@/lib/workflows/conversation/testing/turn-result-fixture";

const EXECUTION = createWorkflowExecution({ status: "running" });
const CONTEXT_ID = EXECUTION.workingDefinition.executionContexts[0]?.id ?? "";

const ADVISORIES = stampAdvisoryIdentities({
  roundSeq: 2,
  assignmentId: "security",
  advisories: [
    { kind: "implementation", title: "one", description: "first" },
    { kind: "plan", title: "two", description: "second" },
  ],
});
const IDENTITY_ONE = { roundSeq: 2, assignmentId: "security", ordinal: 1 };
const IDENTITY_TWO = { roundSeq: 2, assignmentId: "security", ordinal: 2 };

function structured(dispositions: unknown[]): ConversationTurnExecution {
  return settledConversationTurn({
    outcome: {
      kind: "completed",
      structuredOutput: { dispositions },
      text: "",
    },
  });
}

function run(
  results: ConversationTurnExecution[],
  deps: NonNullable<
    Parameters<typeof createGraphWorkflowAdvisoryResponseRunner>[0]
  > = {},
): ReturnType<typeof createGraphWorkflowAdvisoryResponseRunner> & {
  executeConversationTurn: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const executeConversationTurn = vi.fn(async () => {
    const result = results[Math.min(call, results.length - 1)];
    call += 1;
    if (!result) throw new Error("no scripted result");
    return result;
  });
  const runner = createGraphWorkflowAdvisoryResponseRunner({
    ...deps,
    executeConversationTurn,
  });
  return { ...runner, executeConversationTurn };
}

function input() {
  return {
    projectPath: "/repo",
    sessionName: "session-1",
    execution: EXECUTION,
    contextId: CONTEXT_ID,
    conversationId: "conversation-impl",
    advisories: ADVISORIES,
  };
}

describe("advisory-response turn", () => {
  it("continues the implementer conversation with the dispositions schema as its output contract", async () => {
    const runner = run([
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
        { identity: IDENTITY_TWO, disposition: "deferred", reason: null },
      ]),
    ]);

    await runner.runAdvisoryResponse(input());

    expect(runner.executeConversationTurn).toHaveBeenCalledTimes(1);
    const dispatched = runner.executeConversationTurn.mock.calls[0]?.[0];
    expect(dispatched.turn.kind).toBe("conversation_turn");
    expect(dispatched.turn.autonomous).toBe(true);
    expect(dispatched.turn.askUserQuestionsEnabled).toBe(false);
    expect(dispatched.turn.backend).toBe("claude");
    expect(dispatched.turn.outputFormat).toEqual({
      type: "json_schema",
      schema: buildAdvisoryDispositionsOutputSchema(ADVISORIES),
    });
    expect(dispatched.binding.address.target.conversationId).toBe(
      "conversation-impl",
    );
    expect(dispatched.turn.modelSelection).toEqual({
      modelId: "opus",
      parameters: { effort: "high" },
    });
    expect(dispatched.executionContext.workflowContext).toEqual({
      executionId: EXECUTION.id,
      contextId: CONTEXT_ID,
    });
    expect(dispatched.waitUntilReady).toBe(true);
  });

  it("retains a confined implementer's write envelope on the response turn", async () => {
    const execution = createWorkflowExecution({ status: "running" });
    const context = execution.workingDefinition.executionContexts[0];
    if (!context) throw new Error("fixture missing execution context");
    context.placement = { lane: "reports", mode: "readOnly" };
    const executionTarget = {
      worktreePath: process.cwd(),
      branchName: "test-advisory-response",
      isolation: "worktree" as const,
      laneId: "reports",
    };
    const runner = run([
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
        { identity: IDENTITY_TWO, disposition: "deferred", reason: null },
      ]),
    ]);

    await runner.runAdvisoryResponse({
      ...input(),
      execution,
      contextId: context.id,
      executionTarget,
    });

    const expectedPolicy = composeImplementerLaneWriteEnvelope({
      executionId: execution.id,
      contextId: context.id,
      worktreePath: executionTarget.worktreePath,
      ownedPaths: [],
      payloadLocation: "scratch",
    }).policy;
    expect(
      runner.executeConversationTurn.mock.calls[0]?.[0].turn.fsWritePolicy,
    ).toEqual(expectedPolicy);
  });

  it("resolves the session worktree for a lightweight read-only response turn", async () => {
    const execution = createWorkflowExecution({ status: "running" });
    const context = execution.workingDefinition.executionContexts[0];
    if (!context) throw new Error("fixture missing execution context");
    context.placement = { lane: "session", mode: "readOnly" };
    const resolveWorktreePath = vi.fn(async () => process.cwd());
    const runner = run(
      [
        structured([
          { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
          { identity: IDENTITY_TWO, disposition: "deferred", reason: null },
        ]),
      ],
      { resolveWorktreePath },
    );

    await runner.runAdvisoryResponse({
      ...input(),
      execution,
      contextId: context.id,
    });

    expect(resolveWorktreePath).toHaveBeenCalledWith("/repo", "session-1");
    const expectedPolicy = composeImplementerLaneWriteEnvelope({
      executionId: execution.id,
      contextId: context.id,
      worktreePath: process.cwd(),
      ownedPaths: [],
      payloadLocation: "scratch",
    }).policy;
    expect(
      runner.executeConversationTurn.mock.calls[0]?.[0].turn.fsWritePolicy,
    ).toEqual(expectedPolicy);
  });

  it("retains an owned implementer's write envelope on the response turn", async () => {
    const execution = createWorkflowExecution({ status: "running" });
    const context = execution.workingDefinition.executionContexts[0];
    if (!context) throw new Error("fixture missing execution context");
    context.placement = {
      lane: "synthesis",
      mode: "owned",
      ownedPaths: ["docs/reports"],
    };
    const executionTarget = {
      worktreePath: process.cwd(),
      branchName: "test-advisory-response",
      isolation: "worktree" as const,
      laneId: "synthesis",
    };
    const runner = run([
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
        { identity: IDENTITY_TWO, disposition: "deferred", reason: null },
      ]),
    ]);

    await runner.runAdvisoryResponse({
      ...input(),
      execution,
      contextId: context.id,
      executionTarget,
    });

    const expectedPolicy = composeImplementerLaneWriteEnvelope({
      executionId: execution.id,
      contextId: context.id,
      worktreePath: executionTarget.worktreePath,
      ownedPaths: ["docs/reports"],
      payloadLocation: "worktree",
    }).policy;
    expect(
      runner.executeConversationTurn.mock.calls[0]?.[0].turn.fsWritePolicy,
    ).toEqual(expectedPolicy);
  });

  it("fails closed when an owned response turn has no execution target", async () => {
    const execution = createWorkflowExecution({ status: "running" });
    const context = execution.workingDefinition.executionContexts[0];
    if (!context) throw new Error("fixture missing execution context");
    context.placement = {
      lane: "synthesis",
      mode: "owned",
      ownedPaths: ["docs/reports"],
    };
    const runner = run([
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
        { identity: IDENTITY_TWO, disposition: "deferred", reason: null },
      ]),
    ]);

    await expect(
      runner.runAdvisoryResponse({
        ...input(),
        execution,
        contextId: context.id,
      }),
    ).rejects.toBeInstanceOf(AgentTurnFailedError);
    expect(runner.executeConversationTurn).not.toHaveBeenCalled();
  });

  it("returns one disposition per delivered advisory", async () => {
    const runner = run([
      structured([
        {
          identity: IDENTITY_ONE,
          disposition: "declined",
          reason: "Deliberate.",
        },
        { identity: IDENTITY_TWO, disposition: "deferred", reason: null },
      ]),
    ]);

    const outcome = await runner.runAdvisoryResponse(input());

    expect(outcome).toEqual({
      dispositions: [
        {
          identity: IDENTITY_ONE,
          disposition: "declined",
          reason: "Deliberate.",
        },
        { identity: IDENTITY_TWO, disposition: "deferred", reason: null },
      ],
    });
  });

  it("re-asks when the reply misses a delivered advisory, naming the one it missed", async () => {
    const runner = run([
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
      ]),
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
        { identity: IDENTITY_TWO, disposition: "addressed", reason: null },
      ]),
    ]);

    const outcome = await runner.runAdvisoryResponse(input());

    expect(outcome.dispositions).toHaveLength(2);
    expect(runner.executeConversationTurn).toHaveBeenCalledTimes(2);
    expect(
      runner.executeConversationTurn.mock.calls.map(
        ([request]) => request.turn.structuredOutputTurns,
      ),
    ).toEqual(["work_then_format", "single"]);
    expect(
      runner.executeConversationTurn.mock.calls[1]?.[0].turn.promptText,
    ).toContain("2:security:2");
  });

  it("re-asks when the reply declines without a reason", async () => {
    const runner = run([
      structured([
        { identity: IDENTITY_ONE, disposition: "declined", reason: null },
        { identity: IDENTITY_TWO, disposition: "addressed", reason: null },
      ]),
      structured([
        { identity: IDENTITY_ONE, disposition: "declined", reason: "No." },
        { identity: IDENTITY_TWO, disposition: "addressed", reason: null },
      ]),
    ]);

    const outcome = await runner.runAdvisoryResponse(input());

    expect(outcome.dispositions).toHaveLength(2);
    expect(runner.executeConversationTurn).toHaveBeenCalledTimes(2);
  });

  it("fails immediately when the facade gate refused the payload", async () => {
    const runner = run([
      settledConversationTurn({
        outcome: {
          kind: "failed",
          error: {
            backend: "claude",
            failureKind: "schema_validation",
            message: "structured output did not validate",
            backendDetails: {
              errors: ["$.dispositions[0].reason is required"],
            },
          },
        },
      }),
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
        { identity: IDENTITY_TWO, disposition: "addressed", reason: null },
      ]),
    ]);

    await expect(runner.runAdvisoryResponse(input())).rejects.toThrow(
      "structured output did not validate",
    );
    expect(runner.executeConversationTurn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "text",
      settledConversationTurn({
        outcome: { kind: "completed", text: "no payload" },
      }),
    ],
    ["invalid shape", structured([null])],
  ])(
    "does not re-prompt a %s result as though it were a coverage violation",
    async (_kind, result) => {
      const runner = run([result]);
      await expect(runner.runAdvisoryResponse(input())).rejects.toBeInstanceOf(
        AgentTurnFailedError,
      );
      expect(runner.executeConversationTurn).toHaveBeenCalledTimes(1);
    },
  );

  it("fails the turn once its attempts are spent rather than returning a set the gate never validated", async () => {
    const runner = run([
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
      ]),
    ]);

    await expect(runner.runAdvisoryResponse(input())).rejects.toBeInstanceOf(
      AgentTurnFailedError,
    );
    expect(runner.executeConversationTurn).toHaveBeenCalledTimes(2);
  });

  it("names the coverage violation in the failure it raises", async () => {
    const runner = run([
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
      ]),
    ]);

    await expect(runner.runAdvisoryResponse(input())).rejects.toThrow(
      /2:security:2/,
    );
  });

  it("propagates an infrastructure failure of the turn itself", async () => {
    const runner = run([
      settledConversationTurn({
        outcome: {
          kind: "failed",
          error: {
            backend: "claude",
            failureKind: "backend_error",
            message: "the session died mid-turn",
          },
        },
      }),
    ]);

    await expect(runner.runAdvisoryResponse(input())).rejects.toBeInstanceOf(
      AgentTurnFailedError,
    );
  });
});
