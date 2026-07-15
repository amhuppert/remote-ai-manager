/**
 * Pre-turn step: synthetic fork seeding.
 *
 * Hides the decision of which forked conversations need their first turn
 * seeded from the local transcript copy (backends without native fork
 * continuity) versus which arrive with continuity already in place.
 */

import { createLogger } from "@/lib/logging";
import { buildSyntheticForkSeed } from "@/lib/sessions/synthetic-fork-seed";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { backendRequiresSyntheticForkSeed } from "@/lib/agent-backends/conversation-policy";

const logger = createLogger("conversation-actor");

/**
 * Decide whether the first turn should build a synthetic-fork seed from the
 * local transcript copy. The owning backend declares this continuity mode;
 * an existing ref or absent transcript closes the gate.
 */
export function shouldBuildRuntimeSyntheticSeed(input: {
  forkedFrom: unknown;
  backendRef: unknown;
  agentBackend: AgentBackendId;
  transcriptPath: string | null;
}): boolean {
  return (
    input.forkedFrom !== null &&
    input.forkedFrom !== undefined &&
    !input.backendRef &&
    backendRequiresSyntheticForkSeed(input.agentBackend) &&
    input.transcriptPath !== null
  );
}

export interface ForkSeedDeps {
  readConversationMessages(
    transcriptPath: string | null,
  ): Promise<TranscriptMessage[]>;
}

/**
 * Build the synthetic fork seed for a turn when the fork gate fires;
 * `undefined` when the gate is closed. A fired gate that yields no seed
 * (empty transcript slice) resolves `null`, matching the runtime turn-input
 * contract (`syntheticForkSeed?: string | null`).
 */
export async function resolveSyntheticForkSeed(
  deps: ForkSeedDeps,
  input: {
    sessionName: string;
    agentBackend: AgentBackendId;
    backendRef: unknown;
    forkedFrom: { messageIndex: number } | null | undefined;
    transcriptPath: string | null;
  },
): Promise<string | null | undefined> {
  if (!shouldBuildRuntimeSyntheticSeed(input)) return undefined;

  const seed = await buildSyntheticForkSeed(
    input.transcriptPath!,
    input.forkedFrom!.messageIndex,
    { readConversationMessages: deps.readConversationMessages },
  );
  if (seed) {
    logger.info("prompt.synthetic_fork", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      seedLength: seed.length,
      messageIndex: input.forkedFrom!.messageIndex,
    });
  }
  return seed;
}
