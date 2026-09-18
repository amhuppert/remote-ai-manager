import {
  queueEnqueueResponseSchema,
  type QueueEnqueueRequest,
} from "@/lib/prompt/schemas";

export function restartQueueRequest(): QueueEnqueueRequest {
  return {
    text: "Reply RESTART-QUEUED-DELIVERED and name the historical issue identifier. Do not call tools.",
  };
}

export function restartQueuedMessageId(response: unknown): string {
  return queueEnqueueResponseSchema.parse(response).message.id;
}
