/**
 * Claude continuity adapter.
 *
 * Handle spaces, both opaque to callers:
 * - `start`/`validate`/`resumeOrRecover` operate on SDK session ids. Every
 *   caller of these is a HEADLESS lane (graph task-strategy validators,
 *   collaboration lanes) whose turns run outside any CC conversation actor —
 *   conversation-anchored lanes carry `refKind: "conversation"` and never
 *   consult this adapter at all. So `start` mints a placeholder, exactly as
 *   Codex does: the real session id is only known after the first turn, which
 *   is why no caller resumes a `sessionAction: "create"` handle. Minting a CC
 *   conversation here instead produced one permanently empty conversation per
 *   headless lane, listed in the conversations panel and never used.
 * - `fork` operates on the persisted SDK session ref (`conversation.backendRef`)
 *   because the SDK forks sessions, not conversations. An anchored fork goes
 *   native via `forkSession`; a missing anchor or a native failure falls back
 *   to a synthetic seed built from the CC transcript. Only when both paths
 *   fail does the fork error — callers must not persist a fork artifact then.
 */

import crypto from "node:crypto";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import {
  assertRefOwnedBy,
  ContinuityForkError,
  type BackendContinuityAdapter,
  type ForkInput,
  type ForkOutcome,
} from "../continuity";

const logger = createLogger("claude:continuity");

export interface ClaudeContinuityDeps {
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
 * Production ports. Resolved lazily via dynamic import so the registry's
 * module-load bootstrap never pulls the SDK or the transcript-reading chain
 * eagerly.
 */
export function createProductionClaudeContinuityDeps(): ClaudeContinuityDeps {
  return {
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
      const ref = crypto.randomUUID();
      logger.info("continuity.start", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        sessionRef: ref,
      });
      return { backend: "claude", ref } satisfies AgentSessionRef;
    },

    async validate(ref) {
      assertRefOwnedBy("claude", ref);
      return { status: "valid" };
    },

    /**
     * Owned refs are durable: the SDK offers no cheap session probe, so
     * staleness surfaces at resume time inside the turn, where the failure
     * classifier's `ContinuationDisposition` and the caller's
     * stale-backend-ref recovery already handle it.
     */
    async resumeOrRecover(ref) {
      assertRefOwnedBy("claude", ref);
      return { ref, recovered: false };
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
