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
import { queueCapabilityForBackend as defaultQueueCapabilityForBackend } from "@/lib/agent-backends/catalog";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import {
  saveTranscriptImage as defaultSaveTranscriptImage,
  getNextImageIndex as defaultGetNextImageIndex,
} from "@/lib/images/transcript-images";
import { buildUserTranscriptBlocks } from "@/lib/workflows/conversation/build-user-transcript-blocks";
import { parseConversationCommand } from "@/lib/conversation-commands/parse";
import { expandNativeSpecCommandForAgent } from "@/lib/conversation-commands/native-spec";
import {
  expandNotepadRefsForAgent,
  type NotepadInjectionSource,
} from "@/lib/notepads/injection";
import { getNotepadInjectionReader } from "@/lib/notepads/service-factory";
import { formatDocumentFeedbackPrompt } from "@/lib/document-comments/format-feedback";
import { appendTranscriptEntry as defaultAppendTranscriptEntry } from "./transcript";
import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import type {
  DocumentFeedbackPayload,
  MessageContentBlock,
} from "@/lib/conversations/message-content-schemas";
import type {
  PendingQueuedMessage,
  QueuedMessageMetadata,
} from "@/lib/conversations/message-queue-schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "@/lib/logging";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";

const logger = createLogger("message-queue");

/**
 * Build the content blocks from raw `{ text, images, documentFeedback }`. Text
 * (when non-empty) becomes a single `text` block first, then each image becomes
 * an inline base64 `image` block, then a `document_feedback` block (when
 * present) is appended. This is the format the next-turn drain coalesces, so the
 * live-delivery path keeps it consistent.
 *
 * NOTE: a `document_feedback` block is NOT a valid backend (SDK) content block —
 * callers that deliver content to the backend (`queueUserInput`) must omit it
 * and carry the derived prose as a `text` block instead.
 */
export function buildQueueContent(args: {
  text?: string;
  images?: readonly ImagePayload[];
  documentFeedback?: DocumentFeedbackPayload;
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
  if (args.documentFeedback) {
    content.push({
      type: "document_feedback",
      items: args.documentFeedback.items,
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
    input: ConversationKey & {
      content: MessageContentBlock[];
      metadata?: QueuedMessageMetadata;
      modelSelection?: BackendModelSelection;
      consumePendingQuestionId?: string;
    },
  ): Promise<PendingQueuedMessage | null>;
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
  /**
   * Reads one notepad for the agent-facing expansion pass (D5). Null means the
   * notepad is gone, so the pass reports a dangling reference rather than
   * failing delivery.
   */
  readNotepadForInjection(
    notepadId: string,
  ): Promise<NotepadInjectionSource | null>;
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
  readNotepadForInjection: (notepadId) =>
    getNotepadInjectionReader().readForInjection(notepadId),
};

export interface QueueMessageParams {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  text?: string;
  images?: ImagePayload[];
  documentFeedback?: DocumentFeedbackPayload;
  backend: AgentBackendId;
  modelSelection?: BackendModelSelection;
  /** Provenance tag persisted on the queue row (e.g. question answers) so the
   *  UI can render a structured card instead of the raw text. */
  metadata?: QueuedMessageMetadata;
  /**
   * Consume the pending question batch with this id in the same durable write
   * as the enqueue (docs/design/cc-cli/03 §3). When the marker is already
   * gone, nothing is enqueued and `queueMessage` returns null.
   */
  consumePendingQuestionId?: string;
  /** Optional dependency overrides for testing. */
  deps?: Partial<QueueMessageDeps>;
  /**
   * Keep this row pending until the actor can claim a new turn, even when the
   * backend accepts user input during an in-progress turn.
   */
  deliveryPolicy?: "next_turn";
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
  documentFeedback?: DocumentFeedbackPayload,
): Promise<MessageContentBlock[]> {
  // A feedback turn records the structured card only — its agent-facing prose
  // was delivered separately, so no duplicate prose text block is written.
  const transcriptText = documentFeedback ? "" : text;

  if (images.length === 0) {
    return buildUserTranscriptBlocks({
      rewrittenPromptText: transcriptText,
      imageRefs: [],
      documentFeedback,
    });
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

  return buildUserTranscriptBlocks({
    rewrittenPromptText: transcriptText,
    imageRefs,
    documentFeedback,
  });
}

export async function queueMessage(
  params: QueueMessageParams & { consumePendingQuestionId: string },
): Promise<QueueMessageResult | null>;
export async function queueMessage(
  params: QueueMessageParams,
): Promise<QueueMessageResult>;
export async function queueMessage(
  params: QueueMessageParams,
): Promise<QueueMessageResult | null> {
  const {
    projectPath,
    sessionName,
    conversationId,
    text,
    images,
    documentFeedback,
    backend,
    modelSelection,
    metadata,
    consumePendingQuestionId,
    deliveryPolicy,
    deps: depsOverride,
  } = params;

  const deps: QueueMessageDeps = { ...defaultDeps, ...depsOverride };

  // Diagnostic identity (R1.3): the queue is session-keyed storage, so
  // `sessionName` is the sentinel for a project conversation.
  const scopeRef = scopeRefFromStoreSessionName(sessionName);

  // Durable content carries the structured `document_feedback` block (the drain
  // re-derives its prose) and omits the redundant feedback prose text — so the
  // pending display and the drained submit do not double-render the feedback.
  const content = documentFeedback
    ? buildQueueContent({ images, documentFeedback })
    : buildQueueContent({ text, images });

  // Backend-delivery content (in-turn live delivery): the agent receives prose,
  // never a `document_feedback` block (not a valid SDK block). Derive the prose
  // from the items when feedback is present.
  // Agent-facing only: `content` above (the durable row) and the transcript
  // entry below both keep the un-expanded text, so notepad chips still render.
  // A notepad read failure degrades to the un-expanded text rather than losing
  // delivery.
  let specExpandedText = text;
  let agentFacingText = text;
  if (text && !documentFeedback) {
    specExpandedText = expandNativeSpecCommandForAgent(text);
    agentFacingText = specExpandedText;
    try {
      agentFacingText = await expandNotepadRefsForAgent(specExpandedText, {
        readForInjection: (notepadId) =>
          deps.readNotepadForInjection(notepadId),
      });
    } catch (err) {
      logger.warn("queue.notepad_expansion_failed", {
        projectName: deps.getProjectDisplayName(projectPath),
        ...scopeRef,
        conversationId,
        error: getErrorMessage(err),
      });
    }
  }
  const deliveryContent = documentFeedback
    ? buildQueueContent({
        text: formatDocumentFeedbackPrompt(documentFeedback.items),
        images,
      })
    : buildQueueContent({ text: agentFacingText, images });

  const entry = await deps.enqueue({
    projectPath,
    sessionName,
    conversationId,
    content,
    ...(metadata ? { metadata } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(consumePendingQuestionId !== undefined
      ? { consumePendingQuestionId }
      : {}),
  });
  if (!entry) {
    return null;
  }

  if (deliveryPolicy === "next_turn") {
    logger.info("queue.delivery_deferred", {
      projectName: deps.getProjectDisplayName(projectPath),
      ...scopeRef,
      conversationId,
      messageIds: [entry.id],
      status: "pending",
      reason: "caller_policy",
    });
    return { entry, deliveryTiming: "next_turn" };
  }

  if (modelSelection !== undefined) {
    logger.info("queue.delivery_deferred", {
      projectName: deps.getProjectDisplayName(projectPath),
      ...scopeRef,
      conversationId,
      messageIds: [entry.id],
      status: "pending",
      reason: "model_selection",
    });
    return { entry, deliveryTiming: "next_turn" };
  }

  // Question answers arrive as the NEXT user message (docs/design/cc-cli/03
  // §3, §5): never delivered into the still-running asking turn, even for
  // backends with in-turn delivery. The row stays pending until the actor's
  // next-turn drain claims it after the asking turn finalizes.
  if (consumePendingQuestionId !== undefined) {
    return { entry, deliveryTiming: "next_turn" };
  }

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
      ...scopeRef,
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
      ...scopeRef,
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
      ...scopeRef,
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
    if (text && specExpandedText !== text) {
      logger.info("queue.native_spec_command_expanded", {
        projectName: deps.getProjectDisplayName(projectPath),
        ...scopeRef,
        conversationId,
        messageIds: [entry.id],
        deliveryAttemptId,
        requestLength: text.length,
      });
    }
    if (agentFacingText !== specExpandedText) {
      logger.info("queue.notepad_refs_expanded", {
        projectName: deps.getProjectDisplayName(projectPath),
        ...scopeRef,
        conversationId,
        messageIds: [entry.id],
        deliveryAttemptId,
        requestLength: specExpandedText?.length ?? 0,
        expandedLength: agentFacingText?.length ?? 0,
      });
    }
    await runtime.queueUserInput({ content: deliveryContent });
  } catch (err) {
    const error = getErrorMessage(err);
    logger.warn("queue.failed", {
      projectName: deps.getProjectDisplayName(projectPath),
      ...scopeRef,
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
    documentFeedback,
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
      storeSessionName: sessionName,
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
    ...scopeRef,
    conversationId,
    messageIds: [entry.id],
    deliveryAttemptId,
    status: "delivered",
  });

  return { entry, deliveryTiming: "in_turn" };
}
