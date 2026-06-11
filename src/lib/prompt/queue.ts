/**
 * Durably enqueue a user message into a conversation and, for backends that
 * accept input during an in-progress turn, attempt live delivery within the
 * current turn.
 *
 * The durable queue — not the JSONL transcript — owns the message until the
 * backend confirms acceptance. Enqueue NEVER writes a transcript entry. A
 * delivered transcript entry is appended only after `queueUserInput` resolves
 * (backend acceptance), and the queue row is marked delivered only after that
 * append succeeds. A failed live delivery leaves the row `pending` so the
 * conversation actor's next-turn drain can deliver it.
 */

import { getRuntime as defaultGetRuntime } from "@/lib/agent-backends/runtime-registry";
import { messageQueueService } from "@/lib/conversations/message-queue-service";
import { queueCapabilityForBackend as defaultQueueCapabilityForBackend } from "@/lib/agent-backends/capabilities-descriptor";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import {
  saveTranscriptImage as defaultSaveTranscriptImage,
  getNextImageIndex as defaultGetNextImageIndex,
} from "@/lib/images/transcript-images";
import { buildUserTranscriptBlocks } from "@/lib/workflows/conversation/build-user-transcript-blocks";
import { parseConversationCommand } from "@/lib/conversation-commands/parse";
import { appendTranscriptEntry as defaultAppendTranscriptEntry } from "./transcript";
import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "@/lib/logging";

const logger = createLogger("message-queue");

/**
 * Build the backend-delivery content blocks from raw `{ text, images }`. Text
 * (when non-empty) becomes a single `text` block first, then each image becomes
 * an inline base64 `image` block. This is the format the next-turn drain
 * coalesces, so the live-delivery path keeps it consistent.
 */
export function buildQueueContent(args: {
  text?: string;
  images?: readonly ImagePayload[];
}): MessageContentBlock[] {
  const content: MessageContentBlock[] = [];
  if (args.text && args.text.length > 0) {
    content.push({ type: "text", text: args.text });
  }
  for (const image of args.images ?? []) {
    content.push({
      type: "image",
      mediaType: image.mediaType,
      base64Data: image.base64Data,
    });
  }
  return content;
}

interface ConversationKey {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

export interface QueueMessageDeps {
  enqueue(
    input: ConversationKey & { content: MessageContentBlock[] },
  ): Promise<PendingQueuedMessage>;
  claimLiveDelivery(
    input: ConversationKey & { id: string },
  ): Promise<PendingQueuedMessage | null>;
  markDelivered(
    input: ConversationKey & { ids: string[]; deliveryAttemptId: string },
  ): Promise<void>;
  markPending(
    input: ConversationKey & {
      ids: string[];
      deliveryAttemptId: string;
      error: string;
    },
  ): Promise<void>;
  getRuntime(conversationId: string): ReturnType<typeof defaultGetRuntime>;
  appendTranscriptEntry(
    ...args: Parameters<typeof defaultAppendTranscriptEntry>
  ): Promise<void>;
  saveTranscriptImage(
    ...args: Parameters<typeof defaultSaveTranscriptImage>
  ): Promise<string>;
  getNextImageIndex(conversationId: string): Promise<number>;
  getProjectDisplayName(projectPath: string): string;
  queueCapabilityForBackend(
    backend: AgentBackendId,
  ): ReturnType<typeof defaultQueueCapabilityForBackend>;
}

const defaultDeps: QueueMessageDeps = {
  enqueue: messageQueueService.enqueue,
  claimLiveDelivery: messageQueueService.claimLiveDelivery,
  markDelivered: messageQueueService.markDelivered,
  markPending: messageQueueService.markPending,
  getRuntime: defaultGetRuntime,
  appendTranscriptEntry: defaultAppendTranscriptEntry,
  saveTranscriptImage: defaultSaveTranscriptImage,
  getNextImageIndex: defaultGetNextImageIndex,
  getProjectDisplayName: defaultGetProjectDisplayName,
  queueCapabilityForBackend: defaultQueueCapabilityForBackend,
};

export interface QueueMessageParams {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  text?: string;
  images?: ImagePayload[];
  backend: AgentBackendId;
  /** Optional dependency overrides for testing. */
  deps?: Partial<QueueMessageDeps>;
}

export interface QueueMessageResult {
  entry: PendingQueuedMessage;
  deliveryTiming: "in_turn" | "next_turn";
}

/**
 * Persist the externalized image refs for a delivered queued turn and build the
 * transcript blocks. Queued images carry no inline `[Image #N]` markers, so
 * `buildUserTranscriptBlocks` appends them as strip refs after the text. The
 * persisted `image_ref` blocks reference files on disk — base64 never lands in
 * the JSONL transcript.
 */
async function buildDeliveredTranscriptBlocks(
  deps: QueueMessageDeps,
  conversationId: string,
  text: string,
  images: readonly ImagePayload[],
): Promise<MessageContentBlock[]> {
  if (images.length === 0) {
    return text.length > 0 ? [{ type: "text", text }] : [];
  }

  const startIndex = await deps.getNextImageIndex(conversationId);
  const imageRefs: ConversationImageRef[] = [];
  let index = startIndex;
  for (const image of images) {
    const persistedPath = await deps.saveTranscriptImage(
      conversationId,
      index,
      image.mediaType,
      image.base64Data,
    );
    imageRefs.push({
      index,
      mediaType: image.mediaType,
      path: persistedPath,
      base64Data: image.base64Data,
    });
    index += 1;
  }

  return buildUserTranscriptBlocks({ rewrittenPromptText: text, imageRefs });
}

export async function queueMessage(
  params: QueueMessageParams,
): Promise<QueueMessageResult> {
  const {
    projectPath,
    sessionName,
    conversationId,
    text,
    images,
    backend,
    deps: depsOverride,
  } = params;

  const deps: QueueMessageDeps = { ...defaultDeps, ...depsOverride };

  const content = buildQueueContent({ text, images });

  const entry = await deps.enqueue({
    projectPath,
    sessionName,
    conversationId,
    content,
  });

  // Conversation commands must never be delivered into a running turn: the
  // row stays pending so the next-turn drain routes it to the command service
  // instead of the agent, regardless of backend delivery timing.
  const parsedCommand = text ? parseConversationCommand(text) : null;
  if (parsedCommand) {
    logger.info("queue.command_detected", {
      entry: "message-queue",
      command: parsedCommand.command,
      hintLength: parsedCommand.hint.length,
      projectName: deps.getProjectDisplayName(projectPath),
      sessionName,
      conversationId,
      messageIds: [entry.id],
      status: "pending",
    });
    return { entry, deliveryTiming: "next_turn" };
  }

  const timing = deps.queueCapabilityForBackend(backend).deliveryTiming;

  if (timing === "next_turn") {
    return { entry, deliveryTiming: "next_turn" };
  }

  // in_turn: attempt live delivery, confirmed by backend acceptance.
  const claimed = await deps.claimLiveDelivery({
    projectPath,
    sessionName,
    conversationId,
    id: entry.id,
  });

  if (!claimed) {
    // The row is no longer `pending` (e.g. cancelled or claimed by a racing
    // drain), so there is nothing to deliver live.
    return { entry, deliveryTiming: "in_turn" };
  }

  const deliveryAttemptId = claimed.deliveryAttemptId;
  if (!deliveryAttemptId) {
    // Invariant: `claimLiveDelivery` always stamps an attempt id on a claimed
    // row. A null here means the claim transform is broken; the row stays
    // `delivering` and the next-turn drain's abandoned-delivery recovery will
    // reclaim it rather than us inventing a bogus attempt id.
    logger.error("queue.live_delivery", {
      projectName: deps.getProjectDisplayName(projectPath),
      sessionName,
      conversationId,
      messageIds: [entry.id],
      status: "delivering",
      error: "claimed row missing delivery attempt id",
    });
    return { entry, deliveryTiming: "in_turn" };
  }

  const runtime = deps.getRuntime(conversationId);
  if (!runtime || !runtime.queueUserInput) {
    const error = "no live runtime for in-turn delivery";
    logger.warn("queue.live_delivery", {
      projectName: deps.getProjectDisplayName(projectPath),
      sessionName,
      conversationId,
      messageIds: [entry.id],
      deliveryAttemptId,
      status: "pending",
      error,
    });
    await deps.markPending({
      projectPath,
      sessionName,
      conversationId,
      ids: [entry.id],
      deliveryAttemptId,
      error,
    });
    return { entry, deliveryTiming: "in_turn" };
  }

  try {
    await runtime.queueUserInput({ content });
  } catch (err) {
    const error = getErrorMessage(err);
    logger.warn("queue.failed", {
      projectName: deps.getProjectDisplayName(projectPath),
      sessionName,
      conversationId,
      messageIds: [entry.id],
      deliveryAttemptId,
      status: "pending",
      error,
    });
    // Live delivery failed; leave the row pending for the next-turn drain. The
    // message is durably queued, so the caller still sees success.
    await deps.markPending({
      projectPath,
      sessionName,
      conversationId,
      ids: [entry.id],
      deliveryAttemptId,
      error,
    });
    return { entry, deliveryTiming: "in_turn" };
  }

  // Backend accepted the input. Append exactly one delivered user transcript
  // entry (the sole JSONL writer), then mark the row delivered.
  const transcriptBlocks = await buildDeliveredTranscriptBlocks(
    deps,
    conversationId,
    text ?? "",
    images ?? [],
  );

  await deps.appendTranscriptEntry(
    conversationId,
    {
      timestamp: new Date().toISOString(),
      type: "user",
      role: "user",
      content: transcriptBlocks,
    },
    undefined,
    {
      projectName: deps.getProjectDisplayName(projectPath),
      sessionName,
    },
  );

  await deps.markDelivered({
    projectPath,
    sessionName,
    conversationId,
    ids: [entry.id],
    deliveryAttemptId,
  });

  logger.info("queue.accepted", {
    projectName: deps.getProjectDisplayName(projectPath),
    sessionName,
    conversationId,
    messageIds: [entry.id],
    deliveryAttemptId,
    status: "delivered",
  });

  return { entry, deliveryTiming: "in_turn" };
}
