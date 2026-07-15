/**
 * Codex continuity adapter.
 *
 * The handle is a Codex thread id. `start` mints a placeholder handle — the
 * real thread id is only known after the first turn's `backend_init` — and
 * `validate`/`resumeOrRecover` treat owned refs as durable because the Codex
 * SDK offers no cheap thread probe: staleness surfaces at resume time inside
 * the turn, where the turn-level recovery path handles it. `fork` has no
 * native Codex counterpart, so it always produces a synthetic seed built from
 * the CC transcript.
 */

import crypto from "node:crypto";
import { createLogger } from "@/lib/logging";
import {
  assertRefOwnedBy,
  ContinuityForkError,
  type BackendContinuityAdapter,
} from "../continuity";

const logger = createLogger("codex:continuity");

export interface CodexContinuityDeps {
  /** Builds the synthetic fork seed from the CC transcript; null = unbuildable. */
  buildSyntheticForkSeed(
    transcriptPath: string,
    messageIndex: number,
  ): Promise<string | null>;
}

/**
 * Production ports. Resolved lazily via dynamic import so the registry's
 * module-load bootstrap never pulls the transcript-reading chain eagerly.
 */
export function createProductionCodexContinuityDeps(): CodexContinuityDeps {
  return {
    async buildSyntheticForkSeed(transcriptPath, messageIndex) {
      const { buildSyntheticForkSeed } =
        await import("@/lib/sessions/synthetic-fork-seed");
      return buildSyntheticForkSeed(transcriptPath, messageIndex);
    },
  };
}

export function createCodexContinuityAdapter(
  deps: CodexContinuityDeps = createProductionCodexContinuityDeps(),
): BackendContinuityAdapter {
  return {
    backend: "codex",

    async start(input) {
      const ref = crypto.randomUUID();
      logger.info("continuity.start", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        threadRef: ref,
      });
      return { backend: "codex", ref };
    },

    async validate(ref) {
      assertRefOwnedBy("codex", ref);
      return { status: "valid" };
    },

    async resumeOrRecover(ref) {
      assertRefOwnedBy("codex", ref);
      return { ref, recovered: false };
    },

    async fork(ref, input) {
      assertRefOwnedBy("codex", ref);
      const seed = await deps.buildSyntheticForkSeed(
        input.sourceTranscriptPath,
        input.messageIndex,
      );
      if (seed === null) {
        throw new ContinuityForkError(
          "codex",
          "Fork creation failed: the synthetic seed could not be built from the local transcript",
        );
      }
      logger.info("continuity.fork.synthetic", {
        projectPath: input.projectPath,
        sourceThreadRef: ref.ref,
        seedLength: seed.length,
      });
      return { kind: "synthetic_seed", seed };
    },
  };
}
