import type { PendingQueuedMessage } from "./message-queue-schemas";

export function isQueuedUserMessage(
  entry: Pick<PendingQueuedMessage, "content" | "metadata" | "inputOrigin">,
): boolean {
  return (
    entry.inputOrigin === "user" &&
    entry.metadata === null &&
    !entry.content.some(
      (block) =>
        block.type === "document_feedback" || block.type === "notepad_feedback",
    ) &&
    entry.content.some(
      (block) => block.type === "text" || block.type === "image",
    )
  );
}
