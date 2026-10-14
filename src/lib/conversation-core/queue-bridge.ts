import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import {
  drainConversationQueueInto,
  type ConversationQueueDeps,
  type QueuedTurnInput,
} from "@/lib/conversations/message-queue-drain";
import type { Logger } from "@/lib/logging";
import type { ConversationCore, UserMessageAdmission } from "./executor";
import type { InteractiveEnrollmentRecord } from "./schemas";

export interface CoreQueueBridgeDeps {
  queue: Omit<ConversationQueueDeps, "submitTurn">;
  enrollment(conversationId: string): InteractiveEnrollmentRecord | null;
  /** The conversation runs or holds a turn now; its end drains the queue again. */
  isBusy(conversationId: string): boolean;
  send(
    input: Parameters<ConversationCore["sendUserMessage"]>[0],
  ): Promise<UserMessageAdmission>;
  getProjectDisplayName(projectPath: string): string;
  log: Pick<Logger, "info" | "warn" | "error">;
}

export interface CoreQueueBridge {
  /** Hands the conversation's next queued batch to the core, when it has one. */
  drain(conversationId: string): Promise<void>;
  /** Returns rows a stopped process left claimed to the queue's own recovery. */
  recover(conversationId: string): Promise<void>;
}

/**
 * The conversation's message queue (the rows every client shows, cancels and
 * reviews) feeding a conversation the shared core runs. The queue keeps its
 * own claim, release and review rules; the core runs each batch as one turn.
 */
export function createCoreQueueBridge(
  deps: CoreQueueBridgeDeps,
): CoreQueueBridge {
  return {
    async drain(conversationId) {
      const enrollment = deps.enrollment(conversationId);
      if (enrollment === null || deps.isBusy(conversationId)) return;
      const context = {
        projectPath: enrollment.projectPath,
        target: targetFromStoreSessionName(
          deps.getProjectDisplayName(enrollment.projectPath),
          enrollment.sessionName,
          conversationId,
        ),
      };
      const submit = async (
        turn: QueuedTurnInput,
      ): Promise<"accepted" | "refused"> => {
        const admission = await deps.send({
          conversationId,
          text: turn.promptText,
          ...(turn.images !== undefined && turn.images.length > 0
            ? { images: turn.images }
            : {}),
          ...(turn.documentFeedback !== undefined
            ? { documentFeedback: turn.documentFeedback }
            : {}),
          ...(turn.notepadFeedback !== undefined
            ? { notepadFeedback: turn.notepadFeedback }
            : {}),
          ...(turn.modelSelection !== undefined
            ? { modelSelection: turn.modelSelection }
            : {}),
          inputOrigin: turn.inputOrigin,
          queuedDelivery: turn.queuedDelivery,
        });
        if (admission.kind === "refused") {
          deps.log.info("conversation_core.queue_batch_refused", {
            conversationId,
            code: admission.code,
          });
        }
        return admission.kind === "accepted" ? "accepted" : "refused";
      };
      // A command the queue ran to completion holds nothing: what was queued behind it runs next.
      for (;;) {
        const progress = await drainConversationQueueInto(
          context,
          deps.queue,
          submit,
        );
        if (progress !== "command" || deps.isBusy(conversationId)) return;
      }
    },
    async recover(conversationId) {
      const enrollment = deps.enrollment(conversationId);
      if (enrollment === null) return;
      await deps.queue.recoverAbandonedDeliveries({
        projectPath: enrollment.projectPath,
        sessionName: enrollment.sessionName,
        conversationId,
      });
    },
  };
}
