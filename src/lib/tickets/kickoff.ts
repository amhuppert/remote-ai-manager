import { createLogger } from "@/lib/logging";
import type { DispatchFirstTurnInput } from "@/lib/prompt/first-turn-dispatch";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { TicketKickoffInput } from "./start-service";

const logger = createLogger("tickets.kickoff");

// ============================================================
// Dependencies (method syntax → bivariant params)
// ============================================================

export interface TicketKickoffQueuerDeps {
  /** Null when the session row does not exist. */
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  /** Resolves only when the whole first turn completes (or fails). */
  dispatchFirstTurn(
    input: DispatchFirstTurnInput,
  ): Promise<{ dispatched: boolean }>;
  /**
   * The configured default single backend (`config.defaultAgentBackend`).
   * Used when a caller does not supply an explicit backend.
   */
  getDefaultAgentBackend(): Promise<AgentBackendId>;
  appendNotice(input: {
    conversationId: string;
    text: string;
    projectName: string;
    storeSessionName: string;
  }): Promise<void>;
}

export interface TicketKickoffQueuer {
  queueKickoff(input: TicketKickoffInput): Promise<boolean>;
}

// ============================================================
// Factory
// ============================================================

export function buildKickoffFailureNoticeText(
  ticketIdentifier: string,
  reason: string | null,
): string {
  const cause = reason === null ? "" : ` (${reason})`;
  return (
    `The agent kickoff for ticket ${ticketIdentifier} failed — the first turn did not run to completion${cause}. ` +
    `The session stays linked and usable; send a prompt to continue.`
  );
}

/**
 * The ticket start path's kickoff seam (design §Error Handling: Dispatch).
 * The first-turn dispatcher resolves only when the whole turn completes, so
 * the queue call is fire-and-forget: `true` means the turn was queued, and a
 * later dispatch failure is surfaced as a durable conversation notice — the
 * linked session stays usable, never rolled back.
 */
export function createTicketKickoffQueuer(
  deps: TicketKickoffQueuerDeps,
): TicketKickoffQueuer {
  async function surfaceDispatchFailure(
    input: TicketKickoffInput,
    reason: string | null,
  ): Promise<void> {
    try {
      await deps.appendNotice({
        conversationId: input.conversationId,
        text: buildKickoffFailureNoticeText(input.ticketIdentifier, reason),
        projectName: input.projectName,
        storeSessionName: input.sessionName,
      });
      logger.info("kickoff.failure_notice_appended", {
        ticketIdentifier: input.ticketIdentifier,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
      });
    } catch (error) {
      logger.error("kickoff.failure_notice_failed", {
        ticketIdentifier: input.ticketIdentifier,
        sessionName: input.sessionName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    async queueKickoff(input) {
      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (session === null) {
        logger.error("kickoff.session_missing", {
          ticketIdentifier: input.ticketIdentifier,
          projectName: input.projectName,
          sessionName: input.sessionName,
        });
        return false;
      }
      const agent = input.backend ?? (await deps.getDefaultAgentBackend());
      void deps
        .dispatchFirstTurn({
          projectPath: input.projectPath,
          projectName: input.projectName,
          session,
          initialPrompt: input.prompt,
          agent,
          modelSelection: input.modelSelection,
        })
        .then(
          (result) => {
            if (result.dispatched) return undefined;
            return surfaceDispatchFailure(input, null);
          },
          (error: unknown) => {
            const reason =
              error instanceof Error ? error.message : String(error);
            logger.error("kickoff.dispatch_failed", {
              ticketIdentifier: input.ticketIdentifier,
              sessionName: input.sessionName,
              error: reason,
            });
            return surfaceDispatchFailure(input, reason);
          },
        );
      return true;
    },
  };
}
