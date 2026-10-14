import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  toTaskRunResult,
  type TaskRunResult,
  type TurnExecutionOutcome,
} from "@/lib/conversation-core/turn/turn-result";
import type { ConversationBackendTurnInput } from "@/lib/agent-backends/conversation";
import {
  settlementOf,
  type ConversationIdentity,
  type ConversationRecordPort,
  type TurnSource,
} from "./conversation-record";
import type { DebugFinalization } from "@/lib/workflows/debug/finalization";
import type { CoreTurnResult } from "./executor";
import type { RuntimeHost } from "./runtime-host";

export interface RecordedTurnDeps {
  records: Pick<ConversationRecordPort, "beginTurn" | "settleTurn">;
  host: Pick<RuntimeHost, "release">;
  log: Pick<Logger, "warn" | "error">;
}

export interface RecordedTurn {
  outcome: TurnExecutionOutcome;
  /** Why the runtime could not be closed, when it could not: its processes may still act. */
  uncollected: string | null;
  /** Why the conversation row could not be settled, when it could not. */
  unsettled: string | null;
  /** The debug workflow's reading of the turn, once settled; null outside debug mode or when the row could not settle. */
  debug: DebugFinalization | null;
}

/**
 * One core turn between its conversation row's begin and settle. The row and
 * the runtime are settled whatever the turn did, and nothing may keep running
 * outside the attempt, so the runtime is given back before the row goes idle.
 */
export async function runRecordedTurn(
  deps: RecordedTurnDeps,
  identity: ConversationIdentity,
  source: TurnSource,
  run: () => Promise<TurnExecutionOutcome>,
): Promise<RecordedTurn> {
  const { conversationId } = identity;
  await deps.records.beginTurn(identity, source);
  let outcome: TurnExecutionOutcome = {
    kind: "not_started",
    reason: "configuration",
    message: "The turn did not run",
  };
  let uncollected: string | null = null;
  let unsettled: string | null = null;
  let debug: DebugFinalization | null = null;
  try {
    outcome = await run();
  } catch (error) {
    deps.log.error("conversation_core.turn_threw", {
      conversationId,
      error: getErrorMessage(error),
    });
    outcome = {
      kind: "not_started",
      reason: "configuration",
      message: getErrorMessage(error),
    };
  } finally {
    // Closed first: the row shows running until nothing of the turn runs.
    await deps.host.release(conversationId).catch((error: unknown) => {
      uncollected = getErrorMessage(error);
      deps.log.error("conversation_core.runtime_release_failed", {
        conversationId,
        error: uncollected,
      });
    });
    await deps.records.settleTurn(identity, settlementOf(outcome), source).then(
      (settled) => {
        debug = settled.debug;
      },
      (error: unknown) => {
        unsettled = getErrorMessage(error);
        deps.log.error("conversation_core.row_settle_failed", {
          conversationId,
          error: unsettled,
        });
      },
    );
  }
  return { outcome, uncollected, unsettled, debug };
}

/**
 * The turn's outcome as its caller should read it, keeping what it produced:
 * a turn whose conversation row could not be settled failed in persistence,
 * and one whose runtime could not be closed failed to end — its processes may
 * still act — as the core records it too.
 */
export function recordedOutcome(
  recorded: Pick<RecordedTurn, "outcome" | "unsettled" | "uncollected">,
): TurnExecutionOutcome {
  const { outcome, unsettled, uncollected } = recorded;
  if (unsettled === null && uncollected === null) return outcome;
  const result =
    outcome.kind === "call_result" || outcome.kind === "settlement_failed"
      ? outcome.result
      : null;
  return unsettled !== null
    ? {
        kind: "settlement_failed",
        code: "persistence",
        message: `The conversation record could not be settled: ${unsettled}`,
        result,
      }
    : {
        kind: "settlement_failed",
        code: "runtime_close",
        message: `The agent runtime could not be closed: ${uncollected}`,
        result,
      };
}

/**
 * The turn's result as its recorder settles it: a turn whose conversation row
 * could not be settled failed, whatever it produced, and a runtime that could
 * not be closed is reported so its holder keeps what it holds.
 */
export function recordedResult(
  result: CoreTurnResult,
  recorded: Pick<RecordedTurn, "uncollected" | "unsettled">,
): CoreTurnResult {
  const settled =
    recorded.unsettled === null
      ? result
      : {
          ...result,
          ...failedTurn(
            `The conversation record could not be settled: ${recorded.unsettled}`,
          ),
          finalText: result.finalText,
        };
  return recorded.uncollected === null
    ? settled
    : { ...settled, runtimeUncollected: recorded.uncollected };
}

export const failedTurn = (failure: string): CoreTurnResult => ({
  status: "failed",
  finalText: null,
  structuredOutput: null,
  outputIssue: null,
  failure,
});

function resultOfRun(
  result: TaskRunResult,
  timedOutAfterMs: number | null,
): CoreTurnResult {
  const text = result.text ?? "";
  const finalText = text.length > 0 ? text : null;
  if (result.kind === "structured") {
    return {
      status: "succeeded",
      finalText,
      structuredOutput: result.structuredOutput,
      outputIssue: null,
      failure: null,
    };
  }
  if (result.kind === "text") {
    return {
      status: "succeeded",
      finalText,
      structuredOutput: null,
      outputIssue: null,
      failure: null,
    };
  }
  // The structured-output gate refused the payload of a turn that ran: the work
  // happened, and the requester decides what a missing value means.
  if (result.failure?.kind === "schema_validation") {
    const issues = result.structuredOutputIssues ?? [];
    const outputIssue =
      issues.length > 0
        ? `${result.error}: ${issues.join("; ")}`
        : result.error;
    return {
      status: "succeeded",
      finalText,
      structuredOutput: null,
      outputIssue,
      failure: null,
    };
  }
  if (timedOutAfterMs !== null)
    return {
      ...failedTurn(`The turn timed out after ${timedOutAfterMs}ms`),
      finalText,
    };
  if (result.interruption?.reason === "shutdown")
    return { ...failedTurn(result.error), status: "interrupted", finalText };
  if (result.aborted || result.interruption?.reason === "user") {
    return { ...failedTurn(result.error), status: "cancelled", finalText };
  }
  return { ...failedTurn(result.error), finalText };
}

/** One normalized turn as the core's terminal recorder consumes it. Pure. */
export function turnResultOf(
  outcome: TurnExecutionOutcome,
  outputFormat: ConversationBackendTurnInput["outputFormat"],
  timedOutAfterMs: number | null,
): CoreTurnResult {
  if (outcome.kind === "not_started") {
    if (timedOutAfterMs !== null)
      return failedTurn(
        `The turn timed out after ${timedOutAfterMs}ms before it started`,
      );
    if (outcome.interruption?.reason === "shutdown")
      return { ...failedTurn(outcome.message), status: "interrupted" };
    return outcome.reason === "cancelled"
      ? { ...failedTurn(outcome.message), status: "cancelled" }
      : failedTurn(outcome.message);
  }
  return resultOfRun(toTaskRunResult(outcome, outputFormat), timedOutAfterMs);
}
