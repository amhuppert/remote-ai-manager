/**
 * Who may take a turn in a conversation, and how a long-running holder proves
 * it still holds one.
 *
 * An ordinary prompt and a Collaboration Mode run both occupy a conversation,
 * but only the prompt is short-lived enough to be tracked by an in-memory lock.
 * A collaboration can outlive the process, so its claim has to be durable and
 * it has to be re-checkable later — after a failure, after a restart, after the
 * user has done other things.
 *
 * Three signals were tried and rejected before this one:
 *
 *  - `status` cannot answer it. A crash leaves a dead run's conversation at
 *    `running` forever, because startup rehydration restores only actors with a
 *    pending question and never repairs the persisted status.
 *  - `promptCount` cannot answer it. It counts COMPLETED turns and is written
 *    back by the conversation actor, and `ensureConversationActor` hands back a
 *    cached actor that never re-reads the row — so an actor created before an
 *    out-of-band claim still holds the old count and writes it back unchanged,
 *    erasing the evidence that a turn happened.
 *  - The process-local prompt lock cannot answer it either: it dies with the
 *    process, so after a restart it says every conversation is free.
 *
 * What does answer it is an explicit owner plus a generation counter that is
 * incremented at ADMISSION — before any transcript or provider effect, in the
 * same durable mutation that admits the turn. A cached actor cannot forge a
 * row-level increment it never performed.
 */

import type { ConversationOwner, ConversationState } from "./schemas";

/** The fields ownership decisions read. Narrow on purpose: these functions are
 *  pure over the record, so they can be exercised without a database. */
export type ConversationOwnershipFacts = Pick<
  ConversationState,
  "owner" | "turnGeneration"
>;

export type TurnAdmissionDecision =
  | { kind: "admit"; turnGeneration: number }
  | { kind: "refuse"; owner: ConversationOwner };

/**
 * Whether an ordinary prompt turn may start here.
 *
 * A conversation held by a non-prompt owner refuses: admitting a prompt would
 * interleave two turns in one transcript and leave the holder unable to tell
 * afterwards whether the conversation it resumes is still the one it claimed.
 * The returned generation is what the caller must persist — admission is the
 * moment the count moves.
 */
export function decideTurnAdmission(
  facts: ConversationOwnershipFacts,
): TurnAdmissionDecision {
  if (facts.owner !== null) {
    return { kind: "refuse", owner: facts.owner };
  }
  return { kind: "admit", turnGeneration: facts.turnGeneration + 1 };
}

export interface OwnershipReclaimRequest {
  workflowId: string;
  /**
   * The generation this workflow observed when it first took the conversation.
   * Persisted on the workflow, not the conversation, so the comparison is
   * between what the holder remembers and what the record now says.
   */
  claimedTurnGeneration: number;
}

export type OwnershipReclaimDecision =
  | { kind: "claim"; reason: "still_owner" | "free_and_unchanged" }
  | {
      kind: "refuse";
      reason: "owned_by_other" | "turn_intervened";
      detail: string;
    };

/**
 * Whether a workflow that previously held this conversation may take it back.
 *
 * Two ways to qualify, and they cover the two ways a run ends up needing to:
 *
 *  - **Still the owner.** The run died without releasing — a process restart.
 *    The claim is literally still on the record, so there is nothing to prove.
 *  - **Free, and no turn since.** The run released the conversation when it
 *    failed so the user could type. If the generation is unchanged, the user
 *    did not, and the run may take it back.
 *
 * A dead ordinary prompt cannot be mistaken for either: prompts never write
 * `owner`, and their admission already moved the generation.
 */
export function decideOwnershipReclaim(
  facts: ConversationOwnershipFacts,
  request: OwnershipReclaimRequest,
): OwnershipReclaimDecision {
  if (facts.owner !== null) {
    if (facts.owner.workflowId === request.workflowId) {
      return { kind: "claim", reason: "still_owner" };
    }
    return {
      kind: "refuse",
      reason: "owned_by_other",
      detail: `conversation is held by workflow "${facts.owner.workflowId}"`,
    };
  }

  if (facts.turnGeneration !== request.claimedTurnGeneration) {
    return {
      kind: "refuse",
      reason: "turn_intervened",
      detail: `conversation has taken another turn since this collaboration claimed it (generation ${facts.turnGeneration}, expected ${request.claimedTurnGeneration})`,
    };
  }

  return { kind: "claim", reason: "free_and_unchanged" };
}

// ============================================================
// Durable operations.
// ============================================================

/** The one conversation mutation entry point these operations need. Injected
 *  so the operations are exercised against the real store in tests without
 *  this module reaching for the singleton. */
export type MutateConversationFn = <T>(
  projectPath: string,
  storeSessionName: string,
  conversationId: string,
  label: string,
  mutate: (conversation: ConversationState) => T,
) => Promise<T>;

export interface ConversationOwnershipRef {
  projectPath: string;
  /** The session-keyed storage name — the project sentinel for a project
   *  conversation. Ownership is scope-invariant, so this is the one name. */
  storeSessionName: string;
  conversationId: string;
}

/**
 * Admit an ordinary prompt turn.
 *
 * The check and the increment are ONE mutation: a collaboration claim that
 * lands between a read and a separate write would otherwise be overwritten by
 * a turn that was admitted against a conversation nobody owned yet.
 */
export async function admitConversationTurn(
  mutateConversation: MutateConversationFn,
  scope: ConversationOwnershipRef,
): Promise<TurnAdmissionDecision> {
  return mutateConversation(
    scope.projectPath,
    scope.storeSessionName,
    scope.conversationId,
    "conversation.turn.admit",
    (conversation) => {
      const decision = decideTurnAdmission(conversation);
      if (decision.kind === "admit") {
        conversation.turnGeneration = decision.turnGeneration;
      }
      return decision;
    },
  );
}

/**
 * Take a conversation for a non-prompt owner, recording the generation the
 * owner is claiming against so a later re-claim has something to compare to.
 */
export async function claimConversationOwnership(
  mutateConversation: MutateConversationFn,
  scope: ConversationOwnershipRef,
  owner: ConversationOwner,
): Promise<TurnAdmissionDecision> {
  return mutateConversation(
    scope.projectPath,
    scope.storeSessionName,
    scope.conversationId,
    "conversation.owner.claim",
    (conversation) => {
      const decision = decideTurnAdmission(conversation);
      if (decision.kind === "admit") {
        conversation.turnGeneration = decision.turnGeneration;
        conversation.owner = owner;
      }
      return decision;
    },
  );
}

/**
 * Take a conversation BACK for an owner that already held it — the resume
 * path. Unlike a first claim this does not move the generation: no new turn is
 * being admitted, the same one is continuing.
 */
export async function reclaimConversationOwnership(
  mutateConversation: MutateConversationFn,
  scope: ConversationOwnershipRef,
  owner: ConversationOwner,
  request: OwnershipReclaimRequest,
): Promise<OwnershipReclaimDecision> {
  return mutateConversation(
    scope.projectPath,
    scope.storeSessionName,
    scope.conversationId,
    "conversation.owner.reclaim",
    (conversation) => {
      const decision = decideOwnershipReclaim(conversation, request);
      if (decision.kind === "claim") {
        conversation.owner = owner;
      }
      return decision;
    },
  );
}

/**
 * Release a conversation so the user can type again.
 *
 * Fenced on the exact attempt: a superseded attempt finishing late must not
 * release a conversation its successor now holds. Returns whether this call
 * was the one that released.
 */
export async function releaseConversationOwnership(
  mutateConversation: MutateConversationFn,
  scope: ConversationOwnershipRef,
  owner: ConversationOwner,
): Promise<boolean> {
  return mutateConversation(
    scope.projectPath,
    scope.storeSessionName,
    scope.conversationId,
    "conversation.owner.release",
    (conversation) => {
      const current = conversation.owner;
      if (
        current === null ||
        current.workflowId !== owner.workflowId ||
        current.attemptEpoch !== owner.attemptEpoch
      ) {
        return false;
      }
      conversation.owner = null;
      return true;
    },
  );
}
