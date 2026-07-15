/**
 * Claude continuity adapter.
 *
 * Handle spaces, both opaque to callers:
 * - `start`/`validate`/`resumeOrRecover` operate on CC conversation ids —
 *   Claude SDK session ids rotate every turn, so the CC conversation (whose
 *   actor owns the live QuerySession) is the durable resume anchor. The
 *   adapter composes the conversation-creation service via injected deps:
 *   CC-level bookkeeping stays above the seam, SDK lifecycle below.
 * - `fork` operates on the persisted SDK session ref (`conversation.backendRef`)
 *   because the SDK forks sessions, not conversations. An anchored fork goes
 *   native via `forkSession`; a missing anchor or a native failure falls back
 *   to a synthetic seed built from the CC transcript. Only when both paths
 *   fail does the fork error — callers must not persist a fork artifact then.
 */

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import {
  assertRefOwnedBy,
  ContinuityForkError,
  type BackendContinuityAdapter,
  type ContinuityStartInput,
  type ForkInput,
  type ForkOutcome,
} from "../continuity";

const logger = createLogger("claude:continuity");

export interface ClaudeContinuityDeps {
  /** Composes the conversation-creation service; returns the new CC conversation. */
  createConversation(input: ContinuityStartInput): Promise<{ id: string }>;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<{ id: string } | null>;
  /** Anthropic SDK `forkSession` port. */
  forkSession(
    sessionId: string,
    options: { dir?: string; upToMessageId?: string },
  ): Promise<{ sessionId: string }>;
  /** Builds the synthetic-fallback seed from the CC transcript; null = unbuildable. */
  buildSyntheticForkSeed(
    transcriptPath: string,
    messageIndex: number,
  ): Promise<string | null>;
}

/**
 * Production ports. Resolved lazily via dynamic import: the conversation
 * service resolves its continuity adapter from the backend registry, so a
 * static import here would be circular at module-load time.
 */
export function createProductionClaudeContinuityDeps(): ClaudeContinuityDeps {
  return {
    async createConversation(input) {
      const { createConversation } =
        await import("@/lib/conversations/service");
      const conversation = await createConversation(
        input.projectPath,
        input.sessionName,
      );
      return { id: conversation.id };
    },
    async getConversation(projectPath, sessionName, conversationId) {
      const { getConversation } = await import("@/lib/conversations/service");
      return getConversation(projectPath, sessionName, conversationId);
    },
    async forkSession(sessionId, options) {
      const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
      return forkSession(sessionId, options);
    },
    async buildSyntheticForkSeed(transcriptPath, messageIndex) {
      const { buildSyntheticForkSeed } =
        await import("@/lib/sessions/synthetic-fork-seed");
      return buildSyntheticForkSeed(transcriptPath, messageIndex);
    },
  };
}

export function createClaudeContinuityAdapter(
  deps: ClaudeContinuityDeps = createProductionClaudeContinuityDeps(),
): BackendContinuityAdapter {
  async function syntheticSeedOrThrow(
    input: ForkInput,
    failureMessage: string,
    cause?: unknown,
  ): Promise<ForkOutcome> {
    const seed = await deps.buildSyntheticForkSeed(
      input.sourceTranscriptPath,
      input.messageIndex,
    );
    if (seed === null) {
      throw new ContinuityForkError("claude", failureMessage, { cause });
    }
    return { kind: "synthetic_seed", seed };
  }

  return {
    backend: "claude",

    async start(input) {
      const conversation = await deps.createConversation(input);
      logger.info("continuity.start", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: conversation.id,
      });
      return { backend: "claude", ref: conversation.id };
    },

    async validate(ref, input) {
      assertRefOwnedBy("claude", ref);
      const conversation = await deps.getConversation(
        input.projectPath,
        input.sessionName,
        ref.ref,
      );
      if (!conversation) {
        logger.warn("continuity.validate.stale", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: ref.ref,
        });
        return { status: "stale", reason: "conversation_not_found" };
      }
      return { status: "valid" };
    },

    async resumeOrRecover(ref, input) {
      assertRefOwnedBy("claude", ref);
      const conversation = await deps.getConversation(
        input.projectPath,
        input.sessionName,
        ref.ref,
      );
      if (conversation) {
        return { ref, recovered: false };
      }
      const fresh = await deps.createConversation(input);
      logger.warn("continuity.recovered", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        staleConversationId: ref.ref,
        conversationId: fresh.id,
      });
      return {
        ref: { backend: "claude", ref: fresh.id } satisfies AgentSessionRef,
        recovered: true,
      };
    },

    async fork(ref, input) {
      assertRefOwnedBy("claude", ref);

      // No anchor: calling forkSession without upToMessageId would silently
      // fork from the latest source state — the visible transcript would be
      // truncated while the SDK session carried the full source history.
      if (input.anchorMessageId === null) {
        logger.info("continuity.fork.synthetic_no_anchor", {
          projectPath: input.projectPath,
          sourceSessionId: ref.ref,
        });
        return syntheticSeedOrThrow(
          input,
          "Fork creation failed: no fork anchor UUID in the local transcript and the synthetic seed could not be built",
        );
      }

      try {
        const { sessionId } = await deps.forkSession(ref.ref, {
          dir: input.projectPath,
          upToMessageId: input.anchorMessageId,
        });
        logger.info("continuity.fork.native", {
          projectPath: input.projectPath,
          sourceSessionId: ref.ref,
          anchorMessageId: input.anchorMessageId,
          forkedSessionId: sessionId,
        });
        return { kind: "native", ref: { backend: "claude", ref: sessionId } };
      } catch (err) {
        const reason = getErrorMessage(err);
        logger.warn("continuity.fork.native_failed", {
          projectPath: input.projectPath,
          sourceSessionId: ref.ref,
          anchorMessageId: input.anchorMessageId,
          reason,
        });
        return syntheticSeedOrThrow(
          input,
          `Fork creation failed: SDK forkSession threw (${reason}) and the local transcript could not be read for synthetic fallback`,
          err,
        );
      }
    },
  };
}
