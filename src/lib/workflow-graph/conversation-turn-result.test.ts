import { expect, it } from "vitest";
import { settledConversationTurn } from "@/lib/workflows/conversation/testing/turn-result-fixture";
import { toTaskRunResult } from "@/lib/workflows/conversation/turn-result";
import {
  adaptGraphConversationTurn,
  adaptValidatorTaskResult,
  classifyGraphDispatchFailure,
  ConversationTurnNotStartedError,
} from "./conversation-turn-result";
import { AgentTurnFailedError } from "./errors";
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
