import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { SessionState } from "@/lib/sessions/schemas";
import type { SpawnAgent } from "@/lib/chat-spawning/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { executePromptStream } from "./sdk-driver";

const logger = createLogger("prompt.first-turn-dispatch");

/** No-op SSE emitter: a first-turn dispatch has no connected client. */
const noopEmit = (): void => {};

export interface DispatchFirstTurnInput {
  projectPath: string;
  projectName: string;
  /** Freshly created session; `conversations[0]` is the dispatch target. */
  session: SessionState;
  /** The first user turn to send; `null` ⇒ the session stays idle (no-op). */
  initialPrompt: string | null;
  images?: ImagePayload[];
  agent: SpawnAgent;
  /**
   * Backend model + reasoning effort for this first turn. Set only for a
   * single-backend agent (`claude` / `codex`); the `dual` race ignores both and
   * runs each participant at its backend default. Absent ⇒ backend default.
   */
  model?: string;
  reasoningEffort?: string;
}

export interface FirstTurnDispatcherDeps {
  executePromptStream: typeof executePromptStream;
  /**
   * Seed a dual Claude+Codex race from a single brief (wraps the collaboration
   * manager's `start` / the `/collab` convention). Both participants begin from
   * the same brief.
   */
  startDualRace(input: {
    projectPath: string;
    session: SessionState;
    conversationId: string;
    brief: string;
    images?: ImagePayload[];
  }): Promise<void>;
  isConversationBusy(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): boolean;
}

/**
 * Readiness-gated, exactly-once "auto-dispatch the first user turn when ready"
 * primitive (shared; the spawn service is the first consumer, optimistic mode a
 * future one). Readiness is structural: the caller invokes this only after
 * `provisionSession` resolved (worktree + init done) and `executePromptStream`
 * waits for the live backend before streaming — so no readiness poller is
 * needed. The dispatcher only ever sends the first turn; it never drives a
 * second (8.3), and a failed dispatch is logged and dropped with no retry storm.
 */
export function createFirstTurnDispatcher(deps: FirstTurnDispatcherDeps): {
  dispatchFirstTurn(
    input: DispatchFirstTurnInput,
  ): Promise<{ dispatched: boolean }>;
} {
  // Exactly-once guard: a conversation id claimed here is never dispatched
  // again, even by a concurrent call. Claimed synchronously before the first
  // await so two concurrent dispatches for one session yield a single turn.
  const claimed = new Set<string>();

  async function dispatchFirstTurn(
    input: DispatchFirstTurnInput,
  ): Promise<{ dispatched: boolean }> {
    const { projectPath, projectName, session, initialPrompt, agent } = input;

    if (initialPrompt === null) {
      return { dispatched: false };
    }

    const conversationId = session.conversations[0]?.id;
    if (conversationId === undefined) {
      logger.error("prompt.first-turn-dispatch.no_conversation", {
        projectName,
        sessionName: session.sessionName,
      });
      return { dispatched: false };
    }

    if (claimed.has(conversationId)) {
      return { dispatched: false };
    }
    if (
      deps.isConversationBusy(projectPath, session.sessionName, conversationId)
    ) {
      return { dispatched: false };
    }
    claimed.add(conversationId);

    try {
      if (agent === "dual") {
        const brief =
          initialPrompt.trim().length > 0
            ? initialPrompt
            : input.images?.length === 1
              ? "Attached image."
              : "Attached images.";
        await deps.startDualRace({
          projectPath,
          session,
          conversationId,
          brief,
          images: input.images,
        });
      } else {
        // `agent` is narrowed to "claude" | "codex" here — both are valid
        // AgentBackendId values, so the first turn runs on the chosen backend
        // with the proposed model + reasoning effort (absent ⇒ backend default).
        await deps.executePromptStream(
          projectPath,
          session,
          initialPrompt,
          noopEmit,
          conversationId,
          input.model,
          input.images,
          {
            backend: agent,
            ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
          },
        );
      }
      logger.info("prompt.first-turn-dispatch.dispatched", {
        projectName,
        sessionName: session.sessionName,
        conversationId,
        agent,
      });
      return { dispatched: true };
    } catch (err) {
      // Drop on dispatch failure — log and resolve, never throw (a throw would
      // abort the whole spawn batch) and never retry.
      logger.error("prompt.first-turn-dispatch.failed", {
        projectName,
        sessionName: session.sessionName,
        conversationId,
        agent,
        error: getErrorMessage(err),
      });
      return { dispatched: false };
    }
  }

  return { dispatchFirstTurn };
}
