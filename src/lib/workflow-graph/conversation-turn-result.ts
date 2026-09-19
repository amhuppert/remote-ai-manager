import { getErrorMessage } from "@/lib/shared/errors";
import { QuerySlotAdmissionTimeoutError } from "@/lib/shared/query-semaphore";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationTurnExecution } from "@/lib/workflows/conversation/manager";
import type {
  TurnExecutionOutcome,
  TaskRunResult,
} from "@/lib/workflows/conversation/turn-result";
import {
  AgentTurnFailedError,
  ConversationTurnSettlementError,
} from "./errors";

type TaskError = Extract<TaskRunResult, { kind: "error" }>;
export type GraphTurnFailureEvidence = Pick<
  TaskError,
  | "failure"
  | "notStarted"
  | "interruption"
  | "structuredOutputIssues"
  | "structuredOutputRepair"
  | "settlementFailure"
>;

/** A dispatch that produced no backend turn cannot be charged as an agent failure. */
export class ConversationTurnNotStartedError extends Error {
  constructor(
    readonly refusal:
      | Extract<ConversationTurnExecution, { kind: "refused" }>
      | Extract<TurnExecutionOutcome, { kind: "not_started" }>,
  ) {
    super(refusal.message);
    this.name = "ConversationTurnNotStartedError";
  }
}

export function classifyGraphDispatchFailure(
  value: Error | (GraphTurnFailureEvidence & { error: string | null }),
  engine: AgentBackendId,
) {
  if (value instanceof Error) {
    const message = getErrorMessage(value);
    return value instanceof QuerySlotAdmissionTimeoutError
      ? { kind: "queue_admission_timeout" as const, message, engine }
      : {
          kind: "infra_error" as const,
          reason: "exception" as const,
          message,
          engine,
        };
  }
  const {
    failure,
    notStarted,
    interruption,
    structuredOutputIssues,
    structuredOutputRepair,
    settlementFailure,
  } = value;
  const message = value.error ?? "Task dispatch failed";
  if (notStarted?.reason === "query_slot_timeout")
    return { kind: "queue_admission_timeout" as const, message, engine };
  return {
    kind: "infra_error" as const,
    reason: "exception" as const,
    message,
    engine,
    failure,
    notStarted,
    interruption,
    structuredOutputIssues,
    structuredOutputRepair,
    settlementFailure,
  };
}

export function adaptGraphConversationTurn(
  execution: ConversationTurnExecution,
  scope: { contextId: string; backend: AgentBackendId },
) {
  if (execution.kind === "refused")
    throw new ConversationTurnNotStartedError(execution);
  const outcome = execution.turn.outcome;
  if (outcome.kind === "not_started") {
    if (outcome.reason !== "cancelled")
      throw new ConversationTurnNotStartedError(outcome);
    throw new AgentTurnFailedError(outcome.message, {
      contextId: scope.contextId,
      engine: scope.backend,
      cause: "abort",
      originalMessage: outcome.message,
    });
  }
  // A retained completed result does not make the turn a graph success: the
  // lifecycle still owns unfinished settlement work, so the failure surfaces
  // whole (code, result, interruption, attempt) rather than as prose.
  if (outcome.kind === "settlement_failed")
    throw new ConversationTurnSettlementError({
      outcome,
      attemptId: execution.turn.attemptId,
      contextId: scope.contextId,
      engine: scope.backend,
    });
  const result = outcome.result;
  const call = result?.outcome;
  if (call?.kind === "paused")
    throw new Error("Turn produced unexpected paused outcome");
  const error = call?.kind === "failed" ? call.error : undefined;
  const interruption = outcome.interruption;
  if (interruption || error?.failureKind === "aborted") {
    const stalled = interruption?.reason === "stalled";
    const timedOut = interruption?.reason === "timeout";
    const message = stalled
      ? `Prompt execution stalled: no agent activity for ${interruption.timeoutMs ?? 0}ms`
      : timedOut && interruption.timeoutMs !== undefined
        ? `Prompt execution timed out after ${interruption.timeoutMs}ms`
        : "Prompt execution was aborted";
    throw new AgentTurnFailedError(message, {
      contextId: scope.contextId,
      engine: scope.backend,
      cause: stalled ? "stall" : timedOut ? "timeout" : "abort",
      originalMessage: message,
    });
  }
  if (error)
    throw new AgentTurnFailedError(`SDK error: ${error.message}`, {
      contextId: scope.contextId,
      engine: scope.backend,
      cause: "sdk_error",
      originalMessage: error.message,
      failure: {
        kind: error.failureKind,
        message: error.message,
        retryable: error.retryable ?? false,
        ...(error.code ? { code: error.code } : {}),
        ...(error.retryAfterHint
          ? { retryAfterHint: error.retryAfterHint }
          : {}),
      },
    });
  return {
    contextTokens: result?.usage.contextTokens ?? null,
    contextWindowMax: result?.usage.contextWindowMax ?? null,
    ...(result?.backgroundWait
      ? { backgroundWait: result.backgroundWait }
      : {}),
  };
}

/** Retains provider evidence while leaving workflow-domain verdict parsing to its owner. */
export function adaptValidatorTaskResult(result: TaskRunResult) {
  const { inputTokens, outputTokens, cachedInputTokens, costUsd } =
    result.usage;
  const usage =
    inputTokens === null &&
    outputTokens === null &&
    cachedInputTokens === null &&
    costUsd === null
      ? null
      : { inputTokens, outputTokens, cachedInputTokens, costUsd };
  return {
    text: result.text ?? null,
    structuredOutput:
      result.kind === "structured" ? result.structuredOutput : undefined,
    parse: result.kind === "structured" ? result.parse : undefined,
    transcript: result.transcript,
    error: result.kind === "error" ? result.error : null,
    ...(result.kind === "error"
      ? {
          failure: result.failure,
          notStarted: result.notStarted,
          interruption: result.interruption,
          structuredOutputIssues: result.structuredOutputIssues,
          structuredOutputRepair: result.structuredOutputRepair,
          settlementFailure: result.settlementFailure,
        }
      : {}),
    backendRef: result.backendRef,
    continuationDisposition: result.continuationDisposition,
    usage,
  };
}
