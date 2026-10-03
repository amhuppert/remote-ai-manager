import { getConversationFsWriteRestrictionForBackend } from "@/lib/agent-backends/catalog";
import { createActorSeatTurns } from "@/lib/conversation-core/actor-seat-turns";
import { storeSessionNameFromScopeRef } from "@/lib/conversations/conversation-target";
import { createConversation } from "@/lib/conversations/service";
import { createLogger } from "@/lib/logging";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { enqueueConversationMessage } from "@/lib/prompt/enqueue-conversation-message";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { getSession } from "@/lib/state-store";
import { getStateDb } from "@/lib/state-store/store";
import { getValidationService } from "@/lib/validation/singleton";
import { composeImplementerLaneWriteEnvelope } from "@/lib/workflow-graph/implementer-lane-write-envelope";
import { createWorkspaceEvidence } from "@/lib/workspace/evidence";
import { createValidationCheckRunner } from "@/lib/workspace/validation-checks";
import { composeBoundaryNotice } from "./notices";
import { boundaryDetail } from "./schemas";
import { composeRunSupervision, type RunSupervision } from "./supervision";

const logger = createLogger("runs");

/**
 * The server's one supervision graph, composed on first use. Process-global so
 * boot (instrumentation) and route bundles share one scheduler, one workspace
 * admission and one set of running turns.
 */
export function getRunSupervision(): RunSupervision {
  return getGlobalSingleton(
    "__cc_run_supervision",
    composeProductionSupervision,
  );
}

function composeProductionSupervision(): RunSupervision {
  let self: RunSupervision | null = null;
  const composed = composeRunSupervision({
    db: getStateDb(),
    seatTurns: createActorSeatTurns({
      async executeConversationTurn(input) {
        const lifecycle =
          await import("@/lib/workflows/conversation/lifecycle");
        return lifecycle.executeConversationTurn(input);
      },
      async stopConversationActor(
        projectPath,
        sessionName,
        conversationId,
        reason,
      ) {
        const lifecycle =
          await import("@/lib/workflows/conversation/lifecycle");
        await lifecycle.stopConversationActor(
          projectPath,
          sessionName,
          conversationId,
          reason,
        );
      },
      getProjectDisplayName,
      composeWriteEnvelope: (input) =>
        composeImplementerLaneWriteEnvelope(input),
      fsWriteRestriction: getConversationFsWriteRestrictionForBackend,
      log: createLogger("conversation-core"),
    }),
    async createSeatConversation({ projectPath, sessionName, role, request }) {
      const conversation = await createConversation(projectPath, sessionName, {
        role: role === "implementer" ? "iteration" : "validator",
        agentBackend: request.seat.assignment.backend,
        profile: request.seat.assignment.profile,
      });
      return conversation.id;
    },
    // Seat turns run through the conversation actor, which takes the model slot
    // itself; taking a second one here could exhaust capacity with half-started
    // turns. A slot holder never waits on a workspace grant, so the actor's
    // wait cannot deadlock against the grant the core already holds.
    slots: { tryAcquire: async () => () => {}, waitForRelease: async () => {} },
    evidence: createWorkspaceEvidence(),
    runCheck: createValidationCheckRunner({
      service: getValidationService(),
      async branchOf(projectPath, sessionName) {
        const session = await getSession(projectPath, sessionName);
        return {
          branchName: session?.branchName ?? null,
          targetBranch: session?.targetBranch ?? null,
        };
      },
      log: createLogger("workspace"),
    }),
    async notifyOwner({ run, boundary }) {
      const questionId =
        boundary.kind === "question"
          ? boundaryDetail(boundary).questionId
          : undefined;
      const question =
        typeof questionId === "string" && self !== null
          ? self.requests.question(questionId)
          : null;
      await enqueueConversationMessage({
        projectPath: run.projectPath,
        sessionName: storeSessionNameFromScopeRef(
          run.ownerSessionName === null
            ? { scope: "project" }
            : { scope: "session", sessionName: run.ownerSessionName },
        ),
        conversationId: run.ownerConversationId,
        message: composeBoundaryNotice(
          run,
          boundary,
          question !== null ? { questionText: question.questionText } : {},
        ),
        deliveryPolicy: "next_turn",
      });
      logger.info("runs.owner_notified", {
        runId: run.runId,
        boundary: boundary.seq,
        kind: boundary.kind,
        conversationId: run.ownerConversationId,
      });
    },
    now: () => new Date().toISOString(),
    logger: (name) => createLogger(name),
  });
  self = composed;
  return composed;
}

/** Boot: called once after conversation actors rehydrate. */
export async function bootRunSupervision(): Promise<{
  restoredRuns: number;
  reconciledOwners: number;
}> {
  return getRunSupervision().boot();
}
