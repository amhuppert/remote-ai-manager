/**
 * Continuation selection for one conversation turn: what the runtime is
 * created from, and what history — if any — the prompt carries.
 *
 * Three answers, chosen once and never combined: a ready checkpoint (a fresh
 * runtime seeded from the frozen payload, with no resume handle and no fork
 * seed), a synthetic fork seed (the existing first-turn behaviour of a forked
 * conversation), or ordinary continuity (resume the stored reference, seed
 * nothing). A checkpoint outranks the fork seed because it already summarises
 * the forked history; after one has been accepted the fork's seed stays
 * suppressed for good, while `forkedFrom` itself remains untouched provenance.
 */

import type { Logger } from "@/lib/logging";
import type {
  CheckpointActorProjection,
  CheckpointPayload,
  CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ForkedFrom } from "@/lib/conversations/schemas";

import { resolveSyntheticForkSeed, type ForkSeedDeps } from "./fork-seed";

export type ContinuationSeed =
  /** Deliver the frozen seed to a fresh runtime; resume nothing. */
  | { kind: "checkpoint"; operationId: string; payload: CheckpointPayload }
  /** Existing synthetic fork behaviour; `null` is a fired gate with nothing to seed. */
  | { kind: "fork"; seed: string | null }
  /** Resume the stored reference when there is one; inject no history. */
  | { kind: "ordinary" };

export interface ContinuationSeedDeps {
  readPayload(
    key: CheckpointScopeKey,
    operationId: string,
  ): Promise<CheckpointPayload | null>;
  /** Whether any checkpoint has ever been accepted for this conversation. */
  readContinuity(key: CheckpointScopeKey): Promise<{ accepted: boolean }>;
  transcript: ForkSeedDeps;
  log: Logger;
}

export interface ContinuationSeedInput {
  /** Null for an ephemeral lane, which has no checkpoint slot. */
  key: CheckpointScopeKey | null;
  checkpoint: CheckpointActorProjection | null;
  sessionName: string;
  agentBackend: AgentBackendId;
  backendRef: unknown;
  forkedFrom: ForkedFrom;
  transcriptPath: string | null;
}

export async function resolveContinuationSeed(
  deps: ContinuationSeedDeps,
  input: ContinuationSeedInput,
): Promise<ContinuationSeed> {
  const { checkpoint } = input;
  if (checkpoint !== null) {
    // Ordinary admission is held for every other active phase; a turn that
    // reaches here under one was admitted past the manager's gate.
    if (checkpoint.phase !== "ready")
      throw new Error(
        `checkpoint operation ${checkpoint.operationId} is ${checkpoint.phase}; an ordinary turn cannot run under it`,
      );
    if (input.key === null)
      throw new Error(
        `checkpoint operation ${checkpoint.operationId} is ready on a lane with no checkpoint scope`,
      );
    const payload = await deps.readPayload(input.key, checkpoint.operationId);
    if (payload === null)
      throw new Error(
        `checkpoint operation ${checkpoint.operationId} is ready but has no frozen payload`,
      );
    return { kind: "checkpoint", operationId: checkpoint.operationId, payload };
  }

  const forkSeed = await resolveSyntheticForkSeed(deps.transcript, {
    sessionName: input.sessionName,
    agentBackend: input.agentBackend,
    backendRef: input.backendRef,
    forkedFrom: input.forkedFrom,
    transcriptPath: input.transcriptPath,
  });
  if (forkSeed === undefined) return { kind: "ordinary" };

  // A fork seed would fire. The continuity read happens only here, so an
  // ordinary turn pays nothing for it; an accepted checkpoint has already
  // carried the forked history forward, and seeding it again would replay
  // the fork's past under the checkpoint's fresh reference.
  if (input.key !== null) {
    const continuity = await deps.readContinuity(input.key);
    if (continuity.accepted) {
      deps.log.info("checkpoint.fork_seed_superseded", {
        conversationId: input.key.conversationId,
        scope: input.key.scope,
        ...(input.key.sessionName === null
          ? {}
          : { sessionName: input.key.sessionName }),
        messageIndex: input.forkedFrom?.messageIndex ?? null,
      });
      return { kind: "ordinary" };
    }
  }
  return { kind: "fork", seed: forkSeed };
}
