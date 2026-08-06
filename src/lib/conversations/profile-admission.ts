/**
 * Admitting a turn: settling which profile it runs under, once and durably.
 *
 * The lock is only real if it is BOTH durable and sequenced before the send
 * (D21). Both properties come from running inside the store's single-writer
 * critical section for this conversation: the check, the stamp, and the read of
 * the snapshot to bind happen with no other writer interleaved, and the write
 * is on disk before the call resolves. A profile change contending for the same
 * conversation therefore either commits entirely before admission — and the
 * admitted turn runs under the new profile — or is refused; it can never land
 * between the read and the stamp.
 *
 * Prompt submission awaits this before `SUBMIT_PROMPT` reaches the actor, which
 * is what closes the gap where the actor loaded conversation state ahead of the
 * submission and its derived persistence was fire-and-forget.
 *
 * The lock is never inferred from `promptCount`: that counter is written by the
 * turn's own persistence, after the send.
 */

import { createLogger } from "@/lib/logging";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import {
  agentProfileSnapshotSchema,
  redactAgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";
import type { ConversationState } from "./schemas";

const logger = createLogger("conversations");

export interface ConversationProfileAdmissionDeps {
  /**
   * The store's focused single-conversation mutation — the single-writer path.
   * Session-keyed, so the project sentinel addresses a project conversation.
   */
  mutateConversation<T = void>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T,
  ): Promise<T>;
}

export interface ConversationProfileAdmissionIdentity {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

export interface AdmittedConversationProfile {
  /**
   * The instruction block this turn's runtime must carry, or null for a legacy
   * conversation. The STORED bytes — admission never re-renders (R6).
   */
  instructionBlock: string | null;
  /** The snapshot bound to this turn, or null for a legacy conversation. */
  snapshot: AgentProfileSnapshot | null;
  /** When the profile was settled; null while there is no profile to settle. */
  lockedAt: string | null;
}

/**
 * Settle `conversationId`'s profile for the turn about to be sent and return
 * exactly what the runtime must be given.
 *
 * Idempotent: a conversation admitted before keeps its original stamp, so
 * "locked at" means when the profile stopped being changeable, not when the
 * most recent turn started.
 */
export async function admitConversationProfile(
  deps: ConversationProfileAdmissionDeps,
  identity: ConversationProfileAdmissionIdentity,
  now: () => string = () => new Date().toISOString(),
): Promise<AdmittedConversationProfile> {
  const admitted = await deps.mutateConversation(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
    "admit-agent-profile",
    (conversation): AdmittedConversationProfile => {
      const drafted = conversation.profileSnapshot ?? null;
      if (drafted === null) {
        // Legacy: no profile to settle. Stamping one would invent a lock over
        // nothing and blur the two refusal reasons the change route reports.
        return { instructionBlock: null, snapshot: null, lockedAt: null };
      }

      // Detached from the mutation draft before it is finalized: the draft's
      // proxies are revoked when the write commits, and this value outlives the
      // critical section as the turn's binding.
      const snapshot = agentProfileSnapshotSchema.parse(drafted);

      conversation.profileLockedAt ??= now();

      return {
        instructionBlock: snapshot.renderedInstructionBlock,
        snapshot,
        lockedAt: conversation.profileLockedAt,
      };
    },
  );

  logAdmission(identity, admitted);
  return admitted;
}

function logAdmission(
  identity: ConversationProfileAdmissionIdentity,
  admitted: AdmittedConversationProfile,
): void {
  logger.info("conversation.profile_admitted", {
    conversationId: identity.conversationId,
    lockedAt: admitted.lockedAt,
    // Redacted: provenance is the diagnostic value, and instruction text never
    // reaches a log field (R6.3).
    profile:
      admitted.snapshot === null
        ? null
        : redactAgentProfileSnapshot(admitted.snapshot),
  });
}

// ============================================================
// Production binding
// ============================================================

let productionDeps: ConversationProfileAdmissionDeps | null = null;

/** Substitute the store seam (a real persistence fixture) for a test. */
export function setConversationProfileAdmissionDeps(
  deps: ConversationProfileAdmissionDeps,
): void {
  productionDeps = deps;
}

export function _resetConversationProfileAdmissionDepsForTesting(): void {
  productionDeps = null;
}

async function resolveAdmissionDeps(): Promise<ConversationProfileAdmissionDeps> {
  if (productionDeps) return productionDeps;
  // Dynamic so this module stays importable from the lifecycle layer without
  // pulling the state store into its import-time cost.
  const { mutateConversation } = await import("@/lib/state-store");
  return { mutateConversation };
}

/**
 * The binding every prompt-submission path awaits before `SUBMIT_PROMPT`
 * reaches the actor. One seam for both producers (the turn executor and the
 * queue drain), so the lock cannot be settled on one path and skipped on the
 * other.
 */
export async function admitConversationProfileForTurn(
  identity: ConversationProfileAdmissionIdentity,
): Promise<AdmittedConversationProfile> {
  return admitConversationProfile(await resolveAdmissionDeps(), identity);
}
