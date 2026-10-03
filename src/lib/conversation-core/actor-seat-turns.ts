import type { FsWriteRestrictionSupport } from "@/lib/agent-backends/descriptor";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  renderWriteEnvelopeBriefing,
  type ComposeImplementerLaneWriteEnvelopeInput,
  type ImplementerLaneWriteEnvelope,
} from "@/lib/workflow-graph/implementer-lane-write-envelope";
import type { ConversationTurnExecution } from "@/lib/workflows/conversation/manager";
import { toTaskRunResult, type TaskRunResult } from "@/lib/workflows/conversation/turn-result";
import type {
  ConversationTurnRequest,
  ConversationTurnSubmission,
} from "@/lib/workflows/conversation/turn-spec";
import type { SeatTurnPort, SeatTurnResult } from "./executor";
import type { SeatTurnRequest } from "./schemas";

export interface ActorSeatTurnDeps {
  executeConversationTurn(input: ConversationTurnSubmission): Promise<ConversationTurnExecution>;
  stopConversationActor(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    reason: string,
  ): Promise<void>;
  getProjectDisplayName(projectPath: string): string;
  composeWriteEnvelope(input: ComposeImplementerLaneWriteEnvelopeInput): ImplementerLaneWriteEnvelope;
  fsWriteRestriction(backend: AgentBackendId): FsWriteRestrictionSupport;
  log: Pick<Logger, "info" | "warn" | "error">;
}

const failed = (failure: string): SeatTurnResult => ({
  status: "failed",
  finalText: null,
  structuredOutput: null,
  outputIssue: null,
  failure,
  backendRef: null,
});

/** One settled actor turn as the core's terminal recorder consumes it. Pure. */
function seatTurnResultFrom(
  result: TaskRunResult,
  timedOutAfterMs: number | null,
): SeatTurnResult {
  const backendRef = result.backendRef?.ref ?? null;
  const text = result.text ?? "";
  const finalText = text.length > 0 ? text : null;
  if (result.kind === "structured") {
    return { status: "succeeded", finalText, structuredOutput: result.structuredOutput, outputIssue: null, failure: null, backendRef };
  }
  if (result.kind === "text") {
    return { status: "succeeded", finalText, structuredOutput: null, outputIssue: null, failure: null, backendRef };
  }
  // The structured-output gate refused the payload of a turn that ran: the work
  // happened, and the requester decides what a missing value means.
  if (result.failure?.kind === "schema_validation") {
    const issues = result.structuredOutputIssues ?? [];
    const outputIssue = issues.length > 0 ? `${result.error}: ${issues.join("; ")}` : result.error;
    return { status: "succeeded", finalText, structuredOutput: null, outputIssue, failure: null, backendRef };
  }
  if (timedOutAfterMs !== null) {
    return { ...failed(`The turn timed out after ${timedOutAfterMs}ms`), finalText, backendRef };
  }
  if (result.interruption?.reason === "shutdown") {
    return { ...failed(result.error), status: "interrupted", finalText, backendRef };
  }
  if (result.aborted) return { ...failed(result.error), status: "cancelled", finalText, backendRef };
  return { ...failed(result.error), finalText, backendRef };
}

/**
 * Seat turns dispatched through the existing conversation actor, which binds
 * the runtime, composes session instructions, writes the transcript and runs
 * the work→format→repair protocol. The core above it owns the mailbox,
 * admission and settlement; the actor also takes its own model slot, so the
 * core composes a pass-through capacity port while seats use this adapter.
 */
export function createActorSeatTurns(deps: ActorSeatTurnDeps): SeatTurnPort {
  function envelopeFor(
    request: SeatTurnRequest,
  ): { kind: "none" } | { kind: "envelope"; envelope: ImplementerLaneWriteEnvelope; restriction: FsWriteRestrictionSupport } | { kind: "refused"; reason: string } {
    const { access, scope, worktreePath } = request.workspace;
    if (access !== "write" || scope.mode !== "owned") return { kind: "none" };
    const backend = request.seat.assignment.backend;
    const restriction = deps.fsWriteRestriction(backend);
    if (restriction === "unsupported") {
      return {
        kind: "refused",
        reason: `Backend "${backend}" cannot limit conversation writes, so it cannot run under an owned write scope`,
      };
    }
    try {
      const envelope = deps.composeWriteEnvelope({
        executionId: request.seat.contextId,
        contextId: request.seat.assignmentId,
        worktreePath,
        ownedPaths: scope.paths,
        payloadLocation: "worktree",
      });
      return { kind: "envelope", envelope, restriction };
    } catch (error) {
      return { kind: "refused", reason: `Cannot establish the write envelope: ${getErrorMessage(error)}` };
    }
  }

  return {
    async run({ conversationId, binding, request, signal }) {
      const confinement = envelopeFor(request);
      if (confinement.kind === "refused") {
        deps.log.error("conversation_core.seat_turn_refused", {
          conversationId,
          contextId: request.seat.contextId,
          reason: confinement.reason,
        });
        return failed(confinement.reason);
      }
      const outputFormat =
        request.outputSchema === undefined
          ? undefined
          : { type: "json_schema" as const, schema: request.outputSchema };
      const turn: ConversationTurnRequest = {
        kind: "conversation_turn",
        promptText:
          confinement.kind === "envelope"
            ? `${renderWriteEnvelopeBriefing(confinement.envelope, confinement.restriction)}\n\n${request.message}`
            : request.message,
        backend: request.seat.assignment.backend,
        modelSelection: request.seat.assignment.modelSelection,
        autonomous: true,
        askUserQuestionsEnabled: request.seat.canAsk,
        ...(request.kind === "work" ? { waitForBackgroundTasks: true } : {}),
        ...(outputFormat !== undefined
          ? { outputFormat, structuredOutputTurns: "work_then_format" as const }
          : {}),
        ...(confinement.kind === "envelope" ? { fsWritePolicy: confinement.envelope.policy } : {}),
      };

      const timeoutMs = request.timeoutMs;
      const timeout = timeoutMs === null ? null : AbortSignal.timeout(timeoutMs);
      const turnSignal = timeout === null ? signal : AbortSignal.any([signal, timeout]);
      let execution: ConversationTurnExecution;
      try {
        execution = await deps.executeConversationTurn({
          binding: {
            kind: "durable",
            address: {
              projectPath: binding.projectPath,
              target: sessionConversationTarget(
                deps.getProjectDisplayName(binding.projectPath),
                binding.sessionName,
                conversationId,
              ),
            },
            worktreePath: request.workspace.worktreePath,
          },
          turn,
          signal: turnSignal,
          waitUntilReady: true,
        });
      } finally {
        // Reviewer cohorts run concurrently; each releases its hosted runtime
        // after the turn and keeps its durable conversation for the next round.
        if (request.seat.role === "reviewer") {
          await deps
            .stopConversationActor(binding.projectPath, binding.sessionName, conversationId, "seat_turn_completed")
            .catch((error: unknown) =>
              deps.log.warn("conversation_core.seat_runtime_release_failed", {
                conversationId,
                error: getErrorMessage(error),
              }),
            );
        }
      }
      const timedOut = timeout !== null && timeout.aborted && !signal.aborted ? timeoutMs : null;
      if (execution.kind === "refused") {
        if (timedOut !== null) return failed(`The turn timed out after ${timedOut}ms before it started`);
        return execution.code === "cancelled"
          ? { ...failed(execution.message), status: "cancelled" }
          : failed(execution.message);
      }
      return seatTurnResultFrom(toTaskRunResult(execution.turn.outcome, outputFormat), timedOut);
    },
  };
}
