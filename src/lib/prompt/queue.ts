import { appendLiveReferenceSummaries } from "@/lib/live-references/service";
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
import type {
  NotepadDeliveryRecord,
  PreparedNotepadChangeNotice,
} from "@/lib/notepads/change-notices";
import {
  getNotepadDeliveryTracker,
  getNotepadInjectionReader,
} from "@/lib/notepads/service-factory";
import { formatDocumentFeedbackPrompt } from "@/lib/document-comments/format-feedback";
import { formatNotepadFeedbackPrompt } from "@/lib/notepads/format-feedback";
import { appendTranscriptEntry as defaultAppendTranscriptEntry } from "./transcript";
import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import type {
  DocumentFeedbackPayload,
  MessageContentBlock,
  NotepadFeedbackPayload,
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
 * Build the content blocks from raw `{ text, images, feedback }`. Text (when
 * non-empty) becomes a single `text` block first, then each image becomes an
 * inline base64 `image` block, then the review-feedback blocks (when present)
 * are appended. This is the format the next-turn drain coalesces, so the
 * live-delivery path keeps it consistent.
 *
 * NOTE: neither a `document_feedback` nor a `notepad_feedback` block is a valid
 * backend (SDK) content block — callers that deliver content to the backend
 * (`queueUserInput`) must omit them and carry the derived prose as a `text`
 * block instead.
 */
export function buildQueueContent(args: {
  text?: string;
  images?: readonly ImagePayload[];
  documentFeedback?: DocumentFeedbackPayload;
  notepadFeedback?: NotepadFeedbackPayload;
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
  if (args.notepadFeedback) {
    content.push({
      type: "notepad_feedback",
      notepadId: args.notepadFeedback.notepadId,
      notepadName: args.notepadFeedback.notepadName,
      notepadRefXml: args.notepadFeedback.notepadRefXml,
      items: args.notepadFeedback.items,
    });
  }
  return content;
}

/**
 * Prepend the transient change notice to the blocks the backend receives. The
 * durable row and the transcript entry are built from the un-noticed content,
 * so the divergence the notepad expansion already models extends to the notice
 * (R21): agent-facing only, never part of what the user is recorded as saying.
 */
function withNotepadChangeNotice(
  content: MessageContentBlock[],
  notice: PreparedNotepadChangeNotice | null,
): MessageContentBlock[] {
  if (notice?.block == null) return content;
  return [{ type: "text", text: notice.block }, ...content];
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
  readLiveReference(
    target: import("@/lib/live-references/schemas").LiveReferenceTarget,
  ): Promise<
    import("@/lib/live-references/schemas").LiveReferenceSummary | null
  >;

  /**
   * Reads one notepad for the agent-facing expansion pass (D5). Null means the
   * notepad is gone, so the pass reports a dangling reference rather than
   * failing delivery.
   */
  readNotepadForInjection(
    notepadId: string,
  ): Promise<NotepadInjectionSource | null>;
  /**
   * Records what this conversation has now been shown of each notepad whose
   * reference was expanded above (R21/D17) — the queued path's half of the
   * same seam the live turn writes at.
   */
  recordNotepadDeliveries(input: {
    conversationId: string;
    notepads: readonly NotepadDeliveryRecord[];
  }): Promise<void>;
  /**
   * Builds this delivery's transient change notice (R21) — the same expansion
   * the live turn runs, so a queued message carries the notice a live turn
   * would have. A read: the watermarks advance only through `settle`.
   */
  prepareNotepadChangeNotice(
    conversationId: string,
    references?: readonly NotepadDeliveryRecord[],
  ): Promise<PreparedNotepadChangeNotice>;
  settleNotepadChangeNotice(notice: PreparedNotepadChangeNotice): Promise<void>;
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
  readLiveReference: async (target) =>
    (await import("@/lib/live-references/reader")).liveReferenceReader.read(
      target,
    ),
  readNotepadForInjection: (notepadId) =>
    getNotepadInjectionReader().readForInjection(notepadId),
  recordNotepadDeliveries: (input) =>
    getNotepadDeliveryTracker().recordDelivered(input),
  prepareNotepadChangeNotice: (conversationId, references) =>
    getNotepadDeliveryTracker().prepare(conversationId, references),
  settleNotepadChangeNotice: (notice) =>
    getNotepadDeliveryTracker().settle(notice),
};

export interface QueueMessageParams {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  text?: string;
  images?: ImagePayload[];
  documentFeedback?: DocumentFeedbackPayload;
  /** One notepad's dispatched review comments. The durable row keeps the typed
   *  block; the agent receives the derived prose. */
  notepadFeedback?: NotepadFeedbackPayload;
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
  notepadFeedback?: NotepadFeedbackPayload,
): Promise<MessageContentBlock[]> {
  // A feedback turn records the structured card only — its agent-facing prose
  // was delivered separately, so no duplicate prose text block is written.
  const transcriptText = documentFeedback || notepadFeedback ? "" : text;
  const notepadFeedbackList = notepadFeedback ? [notepadFeedback] : [];

  if (images.length === 0) {
    return buildUserTranscriptBlocks({
      rewrittenPromptText: transcriptText,
      imageRefs: [],
      documentFeedback,
      notepadFeedback: notepadFeedbackList,
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
    notepadFeedback: notepadFeedbackList,
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
    notepadFeedback,
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

  // Durable content carries the structured feedback block (the drain re-derives
  // its prose) and omits the redundant feedback prose text — so the pending
  // display and the drained submit do not double-render the feedback.
  const content =
    documentFeedback || notepadFeedback
      ? buildQueueContent({
          images,
          ...(documentFeedback ? { documentFeedback } : {}),
          ...(notepadFeedback ? { notepadFeedback } : {}),
        })
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
  let deliveredNotepads: readonly NotepadInjectionSource[] = [];
  if (text && !documentFeedback && !notepadFeedback) {
    specExpandedText = expandNativeSpecCommandForAgent(text);
    agentFacingText = specExpandedText;
    try {
      const expansion = await expandNotepadRefsForAgent(specExpandedText, {
        readForInjection: (notepadId) =>
          deps.readNotepadForInjection(notepadId),
      });
      agentFacingText = expansion.text;
      deliveredNotepads = expansion.delivered;
    } catch (err) {
      logger.warn("queue.notepad_expansion_failed", {
        projectName: deps.getProjectDisplayName(projectPath),
        ...scopeRef,
        conversationId,
        error: getErrorMessage(err),
      });
    }
  }

  const deliveryContent =
    documentFeedback || notepadFeedback
      ? buildQueueContent({
          text: [
            ...(documentFeedback
              ? [formatDocumentFeedbackPrompt(documentFeedback.items)]
              : []),
            ...(notepadFeedback
              ? [formatNotepadFeedbackPrompt(notepadFeedback)]
              : []),
          ].join("\n\n"),
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

  // Rendered references provide a local baseline until backend acceptance.
  let notepadChangeNotice: PreparedNotepadChangeNotice | null = null;
  try {
    notepadChangeNotice = await deps.prepareNotepadChangeNotice(
      conversationId,
      deliveredNotepads.map(({ id, revision, openComments }) => ({
        notepadId: id,
        revision,
        openComments,
      })),
    );
    if (notepadChangeNotice.block !== null) {
      logger.info("queue.notepad_change_notice_prepended", {
        projectName: deps.getProjectDisplayName(projectPath),
        ...scopeRef,
        conversationId,
        messageIds: [entry.id],
        deliveryAttemptId,
        count: notepadChangeNotice.advances.length,
      });
    }
  } catch (err) {
    notepadChangeNotice = null;
    logger.warn("queue.notepad_change_notice_failed", {
      projectName: deps.getProjectDisplayName(projectPath),
      ...scopeRef,
      conversationId,
      messageIds: [entry.id],
      deliveryAttemptId,
      error: getErrorMessage(err),
    });
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
    const sourceText = deliveryContent
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");
    const summarizedText = await appendLiveReferenceSummaries(sourceText, {
      read: (target) => deps.readLiveReference(target),
    });
    const summary = summarizedText.slice(sourceText.length);
    const summarizedContent: MessageContentBlock[] = summary
      ? [...deliveryContent, { type: "text", text: summary }]
      : deliveryContent;
    await runtime.queueUserInput({
      content: withNotepadChangeNotice(summarizedContent, notepadChangeNotice),
    });
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

  if (deliveredNotepads.length > 0) {
    try {
      await deps.recordNotepadDeliveries({
        conversationId,
        notepads: deliveredNotepads.map(({ id, revision, openComments }) => ({
          notepadId: id,
          revision,
          openComments,
        })),
      });
    } catch (err) {
      logger.warn("queue.notepad_delivery_record_failed", {
        projectName: deps.getProjectDisplayName(projectPath),
        ...scopeRef,
        conversationId,
        count: deliveredNotepads.length,
        error: getErrorMessage(err),
      });
    }
  }
  // `queueUserInput` resolving IS backend acceptance, and that is the settle
  // gate (D17): a delivery that threw above left the row pending AND the
  // watermarks untouched, so the notice re-fires on the next message rather
  // than being lost.
  //
  // Settled here rather than after the transcript write below: the agent has
  // already been handed the notice, so a later failure in the transcript or
  // image work must not strand the watermark and re-deliver the same notice.
  if (notepadChangeNotice !== null && notepadChangeNotice.block !== null) {
    try {
      await deps.settleNotepadChangeNotice(notepadChangeNotice);
      logger.info("queue.notepad_change_notice_settled", {
        projectName: deps.getProjectDisplayName(projectPath),
        ...scopeRef,
        conversationId,
        messageIds: [entry.id],
        deliveryAttemptId,
        count: notepadChangeNotice.advances.length,
      });
    } catch (err) {
      logger.warn("queue.notepad_change_notice_settle_failed", {
        projectName: deps.getProjectDisplayName(projectPath),
        ...scopeRef,
        conversationId,
        messageIds: [entry.id],
        deliveryAttemptId,
        error: getErrorMessage(err),
      });
    }
  }

  // Append exactly one delivered user transcript entry (the sole JSONL
  // writer), then mark the row delivered.
  const transcriptBlocks = await buildDeliveredTranscriptBlocks(
    deps,
    conversationId,
    text ?? "",
    images ?? [],
    documentFeedback,
    notepadFeedback,
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
