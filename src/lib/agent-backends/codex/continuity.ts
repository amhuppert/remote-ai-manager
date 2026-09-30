/**
 * Codex continuity adapter.
 *
 * The handle is a Codex thread id. `start` mints a placeholder handle — the
 * real thread id is only known after the first turn's `backend_init` — and
 * `validate`/`resumeOrRecover` treat owned refs as durable because app-server
 * offers no cheap thread probe: staleness surfaces at resume time inside the
 * turn, where the turn-level recovery path handles it.
 *
 * `fork` goes native when the fork's transcript snapshot proves the fork point
 * sits on a completed source-thread turn (`./fork-boundary.ts`): app-server's
 * `thread/fork` then copies the source thread through exactly that turn.
 * Without an exact cut, or when the native fork fails, it falls back to a
 * synthetic seed built from the same snapshot.
 */

import crypto from "node:crypto";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  assertRefOwnedBy,
  ContinuityForkError,
  type BackendContinuityAdapter,
  type ForkInput,
  type ForkOutcome,
} from "../continuity";
import { selectCodexForkTurn } from "./fork-boundary";

const logger = createLogger("codex:continuity");

export interface CodexForkThreadInput {
  projectPath: string;
  threadId: string;
  /** Last source turn the fork keeps (inclusive). */
  lastTurnId: string;
}

export interface CodexContinuityDeps {
  /** Builds the synthetic fork seed from the CC transcript; null = unbuildable. */
  buildSyntheticForkSeed(
    transcriptPath: string,
    messageIndex: number,
  ): Promise<string | null>;
  /** Streams the snapshot's transcript records in order. */
  readSnapshotRecords(transcriptPath: string): AsyncIterable<unknown>;
  /** Forks a Codex thread through `lastTurnId`; resolves the new thread id. */
  forkThread(input: CodexForkThreadInput): Promise<string>;
}

/**
 * Production ports. Resolved lazily via dynamic import so the registry's
 * module-load bootstrap never pulls the transcript-reading or app-server
 * chain eagerly.
 */
export function createProductionCodexContinuityDeps(): CodexContinuityDeps {
  return {
    async buildSyntheticForkSeed(transcriptPath, messageIndex) {
      const { buildSyntheticForkSeed } =
        await import("@/lib/sessions/synthetic-fork-seed");
      return buildSyntheticForkSeed(transcriptPath, messageIndex);
    },
    async *readSnapshotRecords(transcriptPath) {
      const { readCodexTranscriptRecords } =
        await import("./transcript-records");
      yield* readCodexTranscriptRecords(transcriptPath);
    },
    async forkThread(input) {
      const { forkCodexThread } = await import("./thread-fork");
      return forkCodexThread(input);
    },
  };
}

export function createCodexContinuityAdapter(
  deps: CodexContinuityDeps = createProductionCodexContinuityDeps(),
): BackendContinuityAdapter {
  async function syntheticSeedOrThrow(
    input: ForkInput,
    failureMessage: string,
    cause?: unknown,
  ): Promise<ForkOutcome> {
    const seed = await deps.buildSyntheticForkSeed(
      input.transcriptSnapshotPath,
      input.messageIndex,
    );
    if (seed === null) {
      throw new ContinuityForkError("codex", failureMessage, { cause });
    }
    return { kind: "synthetic_seed", seed };
  }

  /** An unreadable snapshot has no cut; the seed path then reports it. */
  async function readForkTurn(
    snapshotPath: string,
    sourceThreadId: string,
  ): Promise<string | null> {
    try {
      return await selectCodexForkTurn(
        deps.readSnapshotRecords(snapshotPath),
        sourceThreadId,
      );
    } catch (err) {
      logger.warn("continuity.fork.snapshot_unreadable", {
        snapshotPath,
        error: getErrorMessage(err),
      });
      return null;
    }
  }

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

      const lastTurnId = await readForkTurn(
        input.transcriptSnapshotPath,
        ref.ref,
      );
      if (lastTurnId === null) {
        logger.info("continuity.fork.synthetic_no_boundary", {
          projectPath: input.projectPath,
          sourceThreadRef: ref.ref,
        });
        return syntheticSeedOrThrow(
          input,
          "Fork creation failed: no completed source turn at the fork point and the synthetic seed could not be built from the local transcript",
        );
      }

      try {
        const threadId = await deps.forkThread({
          projectPath: input.projectPath,
          threadId: ref.ref,
          lastTurnId,
        });
        logger.info("continuity.fork.native", {
          projectPath: input.projectPath,
          sourceThreadRef: ref.ref,
          lastTurnId,
          forkedThreadRef: threadId,
        });
        return {
          kind: "native",
          ref: { backend: "codex", ref: threadId },
          locator: lastTurnId,
        };
      } catch (err) {
        const reason = getErrorMessage(err);
        logger.warn("continuity.fork.native_failed", {
          projectPath: input.projectPath,
          sourceThreadRef: ref.ref,
          lastTurnId,
          reason,
        });
        return syntheticSeedOrThrow(
          input,
          `Fork creation failed: thread/fork failed (${reason}) and the synthetic seed could not be built from the local transcript`,
          err,
        );
      }
    },
  };
}
