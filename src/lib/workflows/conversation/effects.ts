import type { ConversationState } from "@/lib/conversations/schemas";

import type { GraphWorkflowResultDelivery } from "@/lib/workflow-graph/schemas";

import type { MemoryIndexDeliveryKind } from "@/lib/memory/schemas";
import type { MemoryDeliveredNote } from "@/lib/memory/telemetry";

import type {
  NotepadDeliveryRecord,
  PreparedNotepadChangeNotice,
} from "@/lib/notepads/change-notices";

export interface ConversationDurableEffects {
  // State mutations
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void,
  ): Promise<void>;

  // Records which note revisions this turn's `<memory-index>` block actually
  // carried (spec `memory` R15), following the notepad delivery-watermark
  // precedent below. Called on backend acceptance, never at composition: the
  // `cctl memory index` verb and the Library's Index Preview compose the same
  // block for nobody, and a turn rejected between composing the block and
  // accepting the message showed it to nobody either — a watermark counting
  // either would answer a different question than the one R15 asks.
  recordMemoryIndexDeliveries(input: {
    conversationId: string;
    // Which block the turn carried, and the instant it was COMPOSED rather
    // than the instant it settles here: a note captured while the turn was in
    // flight belongs to the conversation's next delivery, and dating the
    // record at settlement would silently swallow it.
    kind: MemoryIndexDeliveryKind;
    composedAt: string;
    notes: readonly MemoryDeliveredNote[];
  }): Promise<void>;

  /** Clear the index delivery state after a backend-reported context loss. */
  resetMemoryIndexDelivery(conversationId: string): Promise<void>;

  // Records what this conversation has now been shown of each notepad whose
  // reference the backend accepted (R21/D17), using its prepared receipt.
  recordNotepadDeliveries(input: {
    conversationId: string;
    notepads: readonly NotepadDeliveryRecord[];
  }): Promise<void>;

  settleNotepadChangeNotice(notice: PreparedNotepadChangeNotice): Promise<void>;

  claimWorkflowResults(input: {
    projectPath: string;
    sessionName: string;
    originConversationId: string;
    attemptId: string;
  }): Promise<GraphWorkflowResultDelivery[]>;

  settleWorkflowResults(input: {
    projectPath: string;
    sessionName: string;
    originConversationId: string;
    attemptId: string;
  }): Promise<number>;

  releaseWorkflowResults(input: {
    projectPath: string;
    sessionName: string;
    originConversationId: string;
    attemptId: string;
  }): Promise<number>;

  // Reference documents — production routes through the shared
  // ArtifactRegistry primitive (`register()` on `focus_memory`). Tests can
  // continue to mock `createReferenceDocument` directly because the production
  // wiring assigns it to the artifact registry's `registerReferenceDocument`
  // hook in the production composition root. This preserves the existing reference
  // document store semantics while routing the side effect through the shared
  // artifact flow.
  createReferenceDocument(
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ): Promise<unknown>;

  markQueuedUncertain(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
    error: string;
  }): Promise<void>;

  /**
   * Release the rows this attempt delivered once the backend accepted the
   * input: rows still claimed, and rows the same attempt's own settlement
   * already held for review while a required receipt was being repaired.
   * Returns the number released.
   */
  confirmQueuedDelivery(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
  }): Promise<number>;

  markQueuedPending(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
    error: string;
  }): Promise<void>;

  markQueuedFailed(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
    error: string;
  }): Promise<void>;
}

export const ephemeralConversationEffects = {
  mutateConversation: async () => {},
  createReferenceDocument: async () => ({}),
  confirmQueuedDelivery: async () => 0,
  markQueuedPending: async () => {},
  markQueuedFailed: async () => {},
  markQueuedUncertain: async () => {},
  recordNotepadDeliveries: async () => {},
  recordMemoryIndexDeliveries: async () => {},
  resetMemoryIndexDelivery: async () => {},
  settleNotepadChangeNotice: async () => {},
  claimWorkflowResults: async () => [],
  settleWorkflowResults: async () => 0,
  releaseWorkflowResults: async () => 0,
} satisfies ConversationDurableEffects;
