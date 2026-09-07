import { expect, it } from "vitest";
import { settledConversationTurn } from "@/lib/workflows/conversation/testing/turn-result-fixture";
import { toTaskRunResult } from "@/lib/workflows/conversation/turn-result";
import {
  adaptGraphConversationTurn,
  adaptValidatorTaskResult,
  classifyGraphDispatchFailure,
  ConversationTurnNotStartedError,
} from "./conversation-turn-result";
import {
  AgentTurnFailedError,
  ConversationTurnSettlementError,
} from "./errors";
import type { ConversationTurnExecution } from "@/lib/workflows/conversation/manager";
import type {
  TurnExecutionOutcome,
  TurnInterruption,
} from "@/lib/workflows/conversation/turn-result";
import type { AgentCallResult } from "@/lib/workflows/primitives/agent-call-vocabulary";
const scope = { contextId: "context", backend: "claude" as const };

it("keeps query capacity refusal outside agent-turn failure with arbitrary wording", () => {
  const execution = {
    kind: "settled" as const,
    turn: {
      attemptId: "a",
      status: "awaiting" as const,
      pendingQuestion: null,
      outcome: {
        kind: "not_started" as const,
        reason: "query_slot_timeout" as const,
        message: "No capacity available",
      },
    },
  };
  expect(() => adaptGraphConversationTurn(execution, scope)).toThrow(
    ConversationTurnNotStartedError,
  );
  try {
    adaptGraphConversationTurn(execution, scope);
  } catch (error) {
    expect(error).not.toBeInstanceOf(AgentTurnFailedError);
  }
  expect(
    classifyGraphDispatchFailure(
      adaptValidatorTaskResult(toTaskRunResult(execution.turn.outcome)),
      "claude",
    ),
  ).toMatchObject({ kind: "queue_admission_timeout" });
});

it("retains partial schema refusal, repair evidence, and cost without token counts", () => {
  const execution = settledConversationTurn({
    usage: { costUsd: 0.7 },
    outcome: {
      kind: "failed",
      contentBlocks: [{ type: "text", text: "refused answer" }],
      error: {
        backend: "claude",
        failureKind: "schema_validation",
        message: "Rejected",
        backendDetails: {
          errors: ["/answer: required"],
          repairAttempts: 1,
          repairMaxAttempts: 1,
        },
      },
    },
  });
  if (execution.kind !== "settled") throw new Error("Fixture did not settle");
  const adapted = adaptValidatorTaskResult(
    toTaskRunResult(execution.turn.outcome),
  );
  expect(adapted).toMatchObject({
    text: "refused answer",
    usage: { costUsd: 0.7, inputTokens: null },
    structuredOutputIssues: ["/answer: required"],
    structuredOutputRepair: { attempts: 1, maxAttempts: 1 },
  });
  expect(classifyGraphDispatchFailure(adapted, "claude")).toMatchObject({
    kind: "infra_error",
    failure: { kind: "schema_validation" },
    structuredOutputIssues: ["/answer: required"],
  });
});

it("uses the recorded interruption reason even when provider prose is unrelated", () => {
  const execution = settledConversationTurn(
    {
      outcome: {
        kind: "failed",
        error: {
          backend: "claude",
          failureKind: "aborted",
          message: "Channel ended",
        },
      },
    },
    { reason: "stalled", timeoutMs: 42 },
  );
  expect(() => adaptGraphConversationTurn(execution, scope)).toThrow(
    expect.objectContaining({ cause: "stall" }),
  );
});

it("does not report an unexpected paused backend outcome as a successful graph turn", () => {
  const execution = settledConversationTurn({
    outcome: { kind: "paused", pauseKind: "post_turn", resumeToken: "pending" },
  });
  expect(() => adaptGraphConversationTurn(execution, scope)).toThrow(
    "unexpected paused outcome",
  );
});

type SettlementCode = Extract<
  TurnExecutionOutcome,
  { kind: "settlement_failed" }
>["code"];

function settlementFailedExecution(
  code: SettlementCode,
  result: AgentCallResult | null,
  interruption?: TurnInterruption,
): ConversationTurnExecution {
  return {
    kind: "settled",
    turn: {
      attemptId: "attempt-77",
      status: "awaiting",
      pendingQuestion: null,
      outcome: {
        kind: "settlement_failed",
        code,
        message: "zebra 9182 arbitrary wording",
        result,
        ...(interruption ? { interruption } : {}),
      },
    },
  };
}

function completedFixtureResult(): AgentCallResult {
  const settled = settledConversationTurn({
    usage: { costUsd: 0.5, inputTokens: 10, outputTokens: 4 },
    outcome: {
      kind: "completed",
      text: "finished work",
      contentBlocks: [{ type: "text", text: "finished work" }],
    },
  });
  if (settled.kind !== "settled" || settled.turn.outcome.kind !== "call_result")
    throw new Error("Fixture did not produce a call result");
  return settled.turn.outcome.result;
}

function captureSettlementError(execution: ConversationTurnExecution) {
  try {
    adaptGraphConversationTurn(execution, scope);
  } catch (error) {
    return error;
  }
  throw new Error("Expected adaptGraphConversationTurn to throw");
}

it.each(["delivery_receipt", "persistence", "runtime_close"] as const)(
  "preserves a %s settlement failure with its completed result instead of reporting graph success",
  (code) => {
    const result = completedFixtureResult();
    const execution = settlementFailedExecution(code, result);
    const error = captureSettlementError(execution);
    expect(error).toBeInstanceOf(ConversationTurnSettlementError);
    if (!(error instanceof ConversationTurnSettlementError))
      throw new Error("unreachable");
    expect(error.name).toBe("ConversationTurnSettlementError");
    expect(error.message).toBe("zebra 9182 arbitrary wording");
    if (execution.kind !== "settled") throw new Error("unreachable");
    expect(error.outcome).toBe(execution.turn.outcome);
    expect(error.outcome.code).toBe(code);
    expect(error.outcome.result).toBe(result);
    expect(error.outcome.result?.outcome).toMatchObject({
      kind: "completed",
      text: "finished work",
    });
    expect(error.outcome.result?.usage).toMatchObject({ costUsd: 0.5 });
    expect(error).toMatchObject({
      attemptId: "attempt-77",
      contextId: "context",
      engine: "claude",
    });
    expect(error).not.toBeInstanceOf(AgentTurnFailedError);
    expect(error).not.toBeInstanceOf(ConversationTurnNotStartedError);
  },
);

it("keeps a null retained result and the interruption on the settlement error", () => {
  const execution = settlementFailedExecution("runtime_close", null, {
    reason: "stalled",
    timeoutMs: 42,
  });
  const error = captureSettlementError(execution);
  if (!(error instanceof ConversationTurnSettlementError))
    throw new Error("Expected a settlement error");
  expect(error.outcome.result).toBeNull();
  expect(error.outcome.interruption).toEqual({
    reason: "stalled",
    timeoutMs: 42,
  });
  expect(error).not.toBeInstanceOf(AgentTurnFailedError);
  expect(error).toMatchObject({ engine: "claude", contextId: "context" });
});
