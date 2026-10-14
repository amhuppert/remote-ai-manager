/**
 * Pre-turn step: the conversation's agent profile layer.
 *
 * Owns the one rule that makes a persisted snapshot worth persisting (R6): the
 * runtime is handed the STORED rendered block, byte for byte, and the composer
 * is never consulted again. A restart, a mid-conversation runtime recreation,
 * or a later edit to the library record therefore cannot change what a live
 * conversation runs under, and the snapshot's `resolvedInstructionHash` stays
 * true to what the model actually received.
 *
 * A legacy conversation — no snapshot, every row created before the profile
 * library — resolves to no block and receives no injection (R6.5).
 */

import { createLogger } from "@/lib/logging";
import {
  conversationProfileInstructionBlock,
  describeConversationProfile,
  type ConversationProfileDescription,
} from "@/lib/conversations/conversation-profile";
import type { ConversationState } from "@/lib/conversations/schemas";

const logger = createLogger("conversation-actor");

export interface ProfileInjectionDeps {
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

export interface ConversationIdentity {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

export interface ResolvedProfileInjection {
  /** The stored block to append to the runtime's session instructions. */
  instructionBlock: string | null;
  /** Redacted identity for diagnostics; `legacy` when there is no profile. */
  description: ConversationProfileDescription;
}

/**
 * Read the profile layer this conversation's next runtime must carry.
 *
 * Logs the REDACTED description — the profile's qualified ref, revision, and
 * both hashes. Provenance is the whole diagnostic value here (which profile,
 * which revision, which delivered bytes), and it is exactly the part that is
 * safe to record; the instruction text never reaches a log field.
 */
export async function resolveConversationProfileInjection(
  deps: ProfileInjectionDeps,
  identity: ConversationIdentity,
): Promise<ResolvedProfileInjection> {
  const conversation = await deps.getConversation(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
  );
  if (conversation === null) {
    return { instructionBlock: null, description: { kind: "legacy" } };
  }

  const description = describeConversationProfile(conversation);
  const instructionBlock = conversationProfileInstructionBlock(conversation);

  logger.info("conversation.profile_injected", {
    conversationId: identity.conversationId,
    profile: description,
    injected: instructionBlock !== null,
  });

  return { instructionBlock, description };
}
