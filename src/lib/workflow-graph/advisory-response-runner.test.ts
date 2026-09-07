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
import {
  ADVISORY_RESPONSE_ATTEMPTS,
  createGraphWorkflowAdvisoryResponseRunner,
} from "@/lib/workflow-graph/advisory-response-runner";
import { AgentTurnFailedError } from "@/lib/workflow-graph/errors";
import { composeImplementerLaneWriteEnvelope } from "@/lib/workflow-graph/implementer-lane-write-envelope";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";

const USAGE = {
  costUsd: null,
  durationMs: null,
  contextTokens: null,
  contextWindowMax: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
};

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

function structured(dispositions: unknown[]): TaskRunResult {
  return {
    kind: "structured",
    structuredOutput: { dispositions },
    text: "",
    usage: USAGE,
    backendRef: null,
    continuationDisposition: "retain",
  };
}

function run(
  results: TaskRunResult[],
  deps: NonNullable<
    Parameters<typeof createGraphWorkflowAdvisoryResponseRunner>[0]
  > = {},
): ReturnType<typeof createGraphWorkflowAdvisoryResponseRunner> & {
  executeWorkflowTaskRun: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const executeWorkflowTaskRun = vi.fn(async () => {
    const result = results[Math.min(call, results.length - 1)];
    call += 1;
    if (!result) throw new Error("no scripted result");
    return result;
  });
  const runner = createGraphWorkflowAdvisoryResponseRunner({
    ...deps,
    executeWorkflowTaskRun,
  });
  return { ...runner, executeWorkflowTaskRun };
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
  it("dispatches with the dispositions schema as the turn's output contract", async () => {
    const runner = run([
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
        { identity: IDENTITY_TWO, disposition: "deferred", reason: null },
      ]),
    ]);

    await runner.runAdvisoryResponse(input());

    expect(runner.executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const dispatched = runner.executeWorkflowTaskRun.mock.calls[0]?.[0];
    expect(dispatched.outputFormat).toEqual({
      type: "json_schema",
      schema: buildAdvisoryDispositionsOutputSchema(ADVISORIES),
    });
    expect(dispatched.binding.address.target.conversationId).toBe(
      "conversation-impl",
    );
    expect(dispatched.modelSelection).toEqual({
      modelId: "opus",
      parameters: { effort: "high" },
    });
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
      runner.executeWorkflowTaskRun.mock.calls[0]?.[0].fsWritePolicy,
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
      runner.executeWorkflowTaskRun.mock.calls[0]?.[0].fsWritePolicy,
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
      runner.executeWorkflowTaskRun.mock.calls[0]?.[0].fsWritePolicy,
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
    expect(runner.executeWorkflowTaskRun).not.toHaveBeenCalled();
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
    expect(runner.executeWorkflowTaskRun).toHaveBeenCalledTimes(2);
    expect(runner.executeWorkflowTaskRun.mock.calls[1]?.[0].prompt).toContain(
      "2:security:2",
    );
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
    expect(runner.executeWorkflowTaskRun).toHaveBeenCalledTimes(2);
  });

  it("re-asks when the gate itself refused the payload", async () => {
    const runner = run([
      {
        kind: "error",
        error: "structured output did not validate",
        aborted: false,
        structuredOutputIssues: ["$.dispositions[0].reason is required"],
        text: "",
        usage: USAGE,
        backendRef: null,
        continuationDisposition: "retain",
      },
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
        { identity: IDENTITY_TWO, disposition: "addressed", reason: null },
      ]),
    ]);

    const outcome = await runner.runAdvisoryResponse(input());

    expect(outcome.dispositions).toHaveLength(2);
    expect(runner.executeWorkflowTaskRun).toHaveBeenCalledTimes(2);
  });

  it("fails the turn once its attempts are spent rather than returning a set the gate never validated", async () => {
    const runner = run([
      structured([
        { identity: IDENTITY_ONE, disposition: "addressed", reason: null },
      ]),
    ]);

    await expect(runner.runAdvisoryResponse(input())).rejects.toBeInstanceOf(
      AgentTurnFailedError,
    );
    expect(runner.executeWorkflowTaskRun).toHaveBeenCalledTimes(
      ADVISORY_RESPONSE_ATTEMPTS,
    );
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
      {
        kind: "error",
        error: "the session died mid-turn",
        aborted: false,
        text: "",
        usage: USAGE,
        backendRef: null,
        continuationDisposition: "retain",
      },
    ]);

    await expect(runner.runAdvisoryResponse(input())).rejects.toBeInstanceOf(
      AgentTurnFailedError,
    );
  });
});
