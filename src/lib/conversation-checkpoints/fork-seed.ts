/**
 * Synthetic fork seed delivery.
 *
 * Hides the decision of which forked conversations need their first turn
 * seeded from the local transcript copy versus which arrive with continuity
 * already in place. A persisted agent reference does not prove seed acceptance.
 */

import { createLogger } from "@/lib/logging";
import { buildSyntheticForkSeed } from "@/lib/sessions/synthetic-fork-seed";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import {
  agentSessionRefSchema,
  type AgentBackendId,
  type AgentSessionRef,
} from "@/lib/shared/schemas";
import { backendRequiresSyntheticForkSeed } from "@/lib/agent-backends/conversation-policy";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { getErrorMessage } from "@/lib/shared/errors";

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
    forkedFrom:
      | {
          messageIndex: number;
          syntheticSeed?: string;
          syntheticSeedAcceptedRef?: AgentSessionRef;
        }
      | null
      | undefined;
    transcriptPath: string | null;
  },
): Promise<string | null | undefined> {
  if (input.forkedFrom?.syntheticSeed !== undefined) {
    const ref = agentSessionRefSchema.safeParse(input.backendRef);
    const acceptedRef = input.forkedFrom.syntheticSeedAcceptedRef;
    if (
      ref.success &&
      acceptedRef?.backend === ref.data.backend &&
      acceptedRef.ref === ref.data.ref
    )
      return undefined;
    logger.info("prompt.synthetic_fork", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      seedLength: input.forkedFrom.syntheticSeed.length,
      messageIndex: input.forkedFrom.messageIndex,
    });
    return input.forkedFrom.syntheticSeed;
  }
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

/** Keep history pending unless its acceptance is durably recorded. */
export async function acknowledgeSyntheticForkSeed(
  deps: {
    mutateConversation(
      projectPath: string,
      sessionName: string,
      conversationId: string,
      label: string,
      mutate: (conversation: ConversationState) => void,
    ): Promise<void>;
  },
  input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    seed: string;
    backendRef: AgentSessionRef;
  },
): Promise<void> {
  try {
    await deps.mutateConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "acknowledgeSyntheticForkSeed",
      (conversation) => {
        if (conversation.forkedFrom?.syntheticSeed === input.seed)
          conversation.forkedFrom.syntheticSeedAcceptedRef = input.backendRef;
      },
    );
    logger.info("prompt.synthetic_fork_accepted", {
      ...scopeRefFromStoreSessionName(input.sessionName),
      conversationId: input.conversationId,
    });
  } catch (error) {
    logger.error("prompt.synthetic_fork_acceptance_failed", {
      ...scopeRefFromStoreSessionName(input.sessionName),
      conversationId: input.conversationId,
      error: getErrorMessage(error),
    });
    throw error;
  }
}
