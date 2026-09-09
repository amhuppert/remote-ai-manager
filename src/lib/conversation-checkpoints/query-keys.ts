/**
 * Query keys for the checkpoint caches.
 *
 * A checkpoint operation is addressed by the conversation it retires, and a
 * conversation exists at one of two scopes, so keys are derived from the
 * canonical `ConversationTarget` rather than from positional project/session
 * arguments. The session and project hosts therefore share one cache identity
 * and one set of hooks — a project conversation can never be addressed through
 * a fabricated session path (design §7).
 */
import {
  conversationTargetKey,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";

/**
 * Checkpoint addressing IS conversation addressing; the alias keeps the
 * domain's local name while the contract has one owner.
 */
export type CheckpointTarget = ConversationTarget;

/** The paging options that vary a receipt-index response. */
export interface CheckpointListOptions {
  before?: number;
  limit?: number;
}

export const checkpointKeys = {
  all: ["conversation-checkpoints"] as const,
  conversation: (target: CheckpointTarget) =>
    [...checkpointKeys.all, ...conversationTargetKey(target)] as const,
  eligibility: (target: CheckpointTarget) =>
    [...checkpointKeys.conversation(target), "eligibility"] as const,
  /** Prefix over every receipt page of one conversation. */
  lists: (target: CheckpointTarget) =>
    [...checkpointKeys.conversation(target), "list"] as const,
  list: (target: CheckpointTarget, options: CheckpointListOptions = {}) =>
    [
      ...checkpointKeys.lists(target),
      { before: options.before ?? null, limit: options.limit ?? null },
    ] as const,
  /**
   * Prefix over every per-operation receipt of one conversation — the
   * freshness ledger a list read reconciles both phase AND membership against.
   */
  details: (target: CheckpointTarget) =>
    [...checkpointKeys.conversation(target), "detail"] as const,
  detail: (target: CheckpointTarget, operationId: string) =>
    [...checkpointKeys.details(target), operationId] as const,
  /**
   * The explicit seed disclosure is a SEPARATE key from the receipt: a panel
   * that renders receipts must not pull payload text into its cache by
   * observing the same query, and evicting the seed must not evict the receipt.
   */
  seed: (target: CheckpointTarget, operationId: string) =>
    [...checkpointKeys.conversation(target), "seed", operationId] as const,
} as const;
