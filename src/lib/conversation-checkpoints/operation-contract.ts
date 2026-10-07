import type { CheckpointRefusal } from "./admission";
import type { CheckpointHandoffEligibility, CheckpointReceipt } from "./receipt";
import type { CheckpointHandoffRequest, CheckpointOperation } from "./schemas";
import type { ConversationAddress } from "@/lib/conversation-core/turn/turn-spec";

// The checkpoint operations a conversation's owner offers its callers, and their outcomes.

export interface ConversationCheckpointRequest {
  handoff?: CheckpointHandoffRequest;
  address: ConversationAddress;
  /** Caller-generated UUID: the operation id, and the reuse key on retransmit. */
  requestId: string;
  /**
   * Explicit recovery: the recovery-required operation this build supersedes.
   * Absent for an ordinary checkpoint, which cannot supersede anything.
   */
  recover?: string | null;
}

export type ConversationCheckpointReconcile =
  | { kind: "repaired"; operation: CheckpointOperation }
  | {
      kind: "blocked";
      operation: CheckpointOperation;
      refusal: CheckpointRefusal;
    }
  | { kind: "unchanged"; operation: CheckpointOperation }
  | { kind: "refused"; refusal: CheckpointRefusal };

export type ConversationCheckpointStart =
  | {
      kind: "admitted" | "reused";
      operation: CheckpointOperation;
      receipt: CheckpointReceipt;
      /** Settles with the operation's durable outcome; never rejects. */
      completion: Promise<CheckpointOperation>;
    }
  | { kind: "refused"; refusal: CheckpointRefusal };

export interface ConversationCheckpointCheck {
  handoff: CheckpointHandoffEligibility;
  eligible: boolean;
  /** Every failing predicate, primary first; empty when eligible. */
  refusals: CheckpointRefusal[];
  /** The operation holding the slot, when one does. */
  active: CheckpointReceipt | null;
  hosted: boolean;
}

export type ConversationCheckpointCancel =
  | { kind: "cancelled"; operation: CheckpointOperation }
  | { kind: "completed"; operation: CheckpointOperation }
  | { kind: "refused"; refusal: CheckpointRefusal };

export type ConversationCheckpointSkip =
  | {
      kind: "stopping" | "handoff_already_settled";
      operation: CheckpointOperation;
    }
  | { kind: "refused"; refusal: CheckpointRefusal };

export interface ConversationCheckpointReconcileRequest {
  address: ConversationAddress;
  operationId: string;
  captureExecutionStopped?: boolean;
  source?: "cli" | "ui" | "api";
}

/**
 * The checkpoint owner of the conversations the shared conversation core
 * runs. The manager hands each checkpoint operation on such a conversation to
 * it whole, as it does a debug command; the actor never hosts one.
 */
export interface CoreConversationCheckpoints {
  check(
    address: ConversationAddress,
    options: { recover: string | null },
  ): Promise<ConversationCheckpointCheck>;
  start(input: ConversationCheckpointRequest): Promise<ConversationCheckpointStart>;
  cancel(input: {
    address: ConversationAddress;
    operationId: string;
  }): Promise<ConversationCheckpointCancel>;
  skipHandoff(input: {
    address: ConversationAddress;
    operationId: string;
  }): Promise<ConversationCheckpointSkip>;
  reconcile(
    input: ConversationCheckpointReconcileRequest,
  ): Promise<ConversationCheckpointReconcile>;
  /** Queued input waits for the checkpoint instead of being refused as not running. */
  acceptsQueuedInput(conversationId: string): boolean;
}
