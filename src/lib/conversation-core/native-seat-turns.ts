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
import { resumableRef, type ConversationRecordPort } from "./conversation-record";
import type { SeatTurnPort } from "./executor";
import { failedTurn as failed, runRecordedTurn, turnResultOf, recordedResult } from "./recorded-turn";
import type { RuntimeHost } from "./runtime-host";
import type { SeatTurnRequest } from "./schemas";
import type { TurnEngine } from "./turn-engine";

export interface NativeSeatTurnDeps {
  engine: Pick<TurnEngine, "runTurn">;
  records: ConversationRecordPort;
  host: Pick<RuntimeHost, "release">;
  getProjectDisplayName(projectPath: string): string;
  composeWriteEnvelope(input: ComposeImplementerLaneWriteEnvelopeInput): ImplementerLaneWriteEnvelope;
  fsWriteRestriction(backend: AgentBackendId): FsWriteRestrictionSupport;
  log: Pick<Logger, "info" | "warn" | "error">;
}

type Confinement =
  | { kind: "none" }
  | {
      kind: "envelope";
      envelope: ImplementerLaneWriteEnvelope;
      restriction: FsWriteRestrictionSupport;
      /** No repository path is writable: a read-only context's implementer. */
      readOnly: boolean;
    }
  | { kind: "refused"; reason: string };

/**
 * Seat turns on the core's own turn engine: the seat conversation's runtime is
 * hosted by the core, the agent acts as the seat itself, and the conversation
 * row records each turn the way every other client reads it.
 */
export function createNativeSeatTurns(deps: NativeSeatTurnDeps): SeatTurnPort {
  /** The write envelope that enforces what the request says the turn may write. */
  function confinementFor(request: SeatTurnRequest): Confinement {
    const { writes, worktreePath } = request.workspace;
    if (writes.mode === "all") return { kind: "none" };
    const readOnly = writes.mode === "none";
    const backend = request.seat.assignment.backend;
    const restriction = deps.fsWriteRestriction(backend);
    if (restriction === "unsupported") {
      return {
        kind: "refused",
        reason: `Backend "${backend}" cannot limit conversation writes, so it cannot run under a ${readOnly ? "read-only" : "owned write"} scope`,
      };
    }
    try {
      const envelope = deps.composeWriteEnvelope({
        executionId: request.seat.contextId,
        // Names the payload directory in the shared worktree: one per context's seat.
        contextId: `${request.seat.contextId}.${request.seat.assignmentId}`,
        worktreePath,
        ownedPaths: writes.mode === "paths" ? writes.paths : [],
        payloadLocation: readOnly ? "scratch" : "worktree",
      });
      return { kind: "envelope", envelope, restriction, readOnly };
    } catch (error) {
      return { kind: "refused", reason: `Cannot establish the write envelope: ${getErrorMessage(error)}` };
    }
  }

  return {
    async run({ conversationId, binding, request, signal }) {
      const confinement = confinementFor(request);
      if (confinement.kind === "refused") {
        deps.log.error("conversation_core.seat_turn_refused", {
          conversationId,
          contextId: request.seat.contextId,
          reason: confinement.reason,
        });
        return failed(confinement.reason);
      }
      const identity = {
        projectPath: binding.projectPath,
        storeSessionName: binding.sessionName,
        conversationId,
      };
      const row = await deps.records.read(identity);
      if (row === null) return failed(`Seat conversation ${conversationId} no longer exists`);
      const backend = request.seat.assignment.backend;
      const projectName = deps.getProjectDisplayName(binding.projectPath);
      const outputFormat =
        request.outputSchema === undefined ? undefined : { type: "json_schema" as const, schema: request.outputSchema };
      const promptText =
        confinement.kind === "envelope"
          ? `${renderWriteEnvelopeBriefing(confinement.envelope, confinement.restriction)}\n\n${request.message}`
          : request.message;

      const timeoutMs = request.timeoutMs;
      const timeout = timeoutMs === null ? null : AbortSignal.timeout(timeoutMs);
      const turnSignal = timeout === null ? signal : AbortSignal.any([signal, timeout]);

      const recorded = await runRecordedTurn(deps, identity, "workflow", async () => {
        const profile = await deps.records.admitProfile(identity);
        return deps.engine.runTurn({
          conversation: {
            conversationId,
            projectPath: binding.projectPath,
            projectName,
            target: sessionConversationTarget(projectName, binding.sessionName, conversationId),
            worktreePath: request.workspace.worktreePath,
            backend,
            executionClass: "governed-execution",
            // A continuation from a different backend cannot be resumed here.
            persistedRef: resumableRef(row, backend),
            callerIdentity: conversationId,
            profile,
          },
          requirements: {
            modelSelection: request.seat.assignment.modelSelection,
            ...(confinement.kind === "envelope" ? { fsWritePolicy: confinement.envelope.policy } : {}),
            instructionSelection: { autonomous: true, askUserQuestionsEnabled: request.seat.canAsk },
          },
          broadcast: { projectName, storeSessionName: binding.sessionName },
          promptText,
          userEntry: {
            timestamp: new Date().toISOString(),
            type: "user",
            role: "user",
            content: [{ type: "text", text: promptText }],
          },
          onBackendInit: (ref) => deps.records.recordContinuity(identity, ref),
          writeCapability:
            request.seat.role === "reviewer" || (confinement.kind === "envelope" && confinement.readOnly)
              ? "read_only"
              : "write_capable",
          autonomous: true,
          waitForBackgroundTasks: request.kind === "work",
          ...(outputFormat !== undefined ? { outputFormat, structuredOutputTurns: "work_then_format" as const } : {}),
          signal: turnSignal,
        });
      });
      const timedOut = timeout !== null && timeout.aborted && !signal.aborted ? timeoutMs : null;
      return recordedResult(turnResultOf(recorded.outcome, outputFormat, timedOut), recorded);
    },
  };
}
