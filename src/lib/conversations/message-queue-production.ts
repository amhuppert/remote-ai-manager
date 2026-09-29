import { messageQueueService } from "./message-queue-service";
import { dispatchConversationCommand } from "@/lib/conversation-commands/dispatch";
import type { ConversationQueueDeps } from "./message-queue-drain";

const defaultConversationQueueDeps: ConversationQueueDeps = {
  submitTurn: async (input) => {
    const { submitConversationTurn } =
      await import("@/lib/workflows/conversation/lifecycle");
    return submitConversationTurn(input);
  },
  claimNextTurnBatch: (input) => messageQueueService.claimNextTurnBatch(input),
  markPending: (input) => messageQueueService.markPending(input),
  markDelivered: (input) => messageQueueService.markDelivered(input),
  markFailed: (input) => messageQueueService.markFailed(input),
  recoverAbandonedDeliveries: (input) =>
    messageQueueService.recoverAbandonedDeliveries(input),
  runConversationCommand: (input) => dispatchConversationCommand(input),
};

let _conversationQueueDeps: ConversationQueueDeps | null = null;

export function setConversationQueueDeps(deps: ConversationQueueDeps): void {
  _conversationQueueDeps = deps;
}

export function _resetConversationQueueDepsForTesting(): void {
  _conversationQueueDeps = null;
}

export function getConversationQueueDeps(): ConversationQueueDeps {
  return _conversationQueueDeps ?? defaultConversationQueueDeps;
}
