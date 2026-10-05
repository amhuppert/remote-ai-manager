import { createRequiredInputReceipt } from "@/lib/workflows/conversation/pre-turn/required-input-receipt";
import { appendLiveReferenceSummaries } from "@/lib/live-references/service";
/**
 * Durably enqueue a user message into a conversation and, for backends that
 * accept input during an in-progress turn, attempt live delivery within the
 * current turn.
 *
 * The durable queue — not the JSONL transcript — owns the message until the
 * backend confirms acceptance. Enqueue NEVER writes a transcript entry. A
 * delivered transcript entry is appended inside the acceptance callback, and the queue row is marked delivered only after that
 * append succeeds. A confirmed refusal leaves the row `pending` for the
 * next-turn drain. An unconfirmed delivery stays `uncertain` for user review.
 */

import {
  getRuntime as defaultGetRuntime,
  ownRuntimeInputReceipt,
} from "@/lib/agent-backends/runtime-registry";
import { InputDeliveryUncertainError } from "@/lib/agent-backends/errors";
import { isQueuedUserMessage } from "@/lib/conversations/queued-input-provenance";
import { queuedBatchToSubmitPrompt } from "@/lib/conversations/message-queue-drain";
import type { ConversationIdentity } from "@/lib/conversation-core/conversation-record";
import type { DeliveryClass } from "@/lib/conversation-core/turn-input";
import { coreAcceptsLive, coreOwnsConversation, deliverCoreLive } from "@/lib/supervision/handles";
import type { UserTurnRequest } from "@/lib/conversation-core/schemas";
import {
  preparePassiveSubscriptionContext,
  prepareAcceptedNotepadReferences,
  productionPassiveSubscriptionDependencies,
  type PassiveSubscriptionContextDependencies,
} from "@/lib/workflows/conversation/pre-turn/passive-subscription-context";
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
import type { NotepadDeliveryRecord } from "@/lib/notepads/accepted-context";
import {
  getNotepadAcceptedContextRecorder,
  getNotepadInjectionReader,
} from "@/lib/notepads/service-factory";
import { formatDocumentFeedbackPrompt } from "@/lib/document-comments/format-feedback";
import { formatNotepadFeedbackPrompt } from "@/lib/notepads/format-feedback";
import { appendTranscriptEntryOnce as defaultAppendTranscriptEntry } from "./transcript";
import type {
  ConversationBackendRuntime,
  ConversationImageRef,
} from "@/lib/agent-backends/conversation";
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
import { modelSelectionKey } from "@/lib/agent-backends/model-selection";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "@/lib/logging";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { buildQueueContent } from "@/lib/conversations/queue-content";

const logger = createLogger("message-queue");

interface ConversationKey {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

export interface QueueMessageDeps {
  /** The shared core, which takes live input for the conversations it runs itself. */
  core?: {
    owns(conversationId: string): Promise<boolean>;
    acceptsLive(conversationId: string): Promise<boolean>;
    /** Settles the claimed rows whatever the outcome. */
    deliverLive(identity: ConversationIdentity, request: UserTurnRequest): Promise<DeliveryClass>;
  };
  subscriptions?: PassiveSubscriptionContextDependencies;
  ownSubscriptionReceipt?(
    input: {
      projectPath: string;
      sessionName: string;
      conversationId: string;
      runtime: ConversationBackendRuntime;
    },
    finish: () => Promise<void>,
  ): Promise<boolean> | boolean;
  enqueue(
    input: ConversationKey & {
      content: MessageContentBlock[];
      backend?: AgentBackendId;
      metadata?: QueuedMessageMetadata;
      inputOrigin?: "user" | "generated";
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
  markUncertain(
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
}

const defaultDeps: QueueMessageDeps = {
  core: {
    owns: async (conversationId) => coreOwnsConversation(conversationId),
    acceptsLive: coreAcceptsLive,
    deliverLive: deliverCoreLive,
  },
  subscriptions: productionPassiveSubscriptionDependencies,
  ownSubscriptionReceipt: (input, finish) =>
    ownRuntimeInputReceipt(input.conversationId, input.runtime, finish),
  enqueue: messageQueueService.enqueue,
  claimLiveDelivery: messageQueueService.claimLiveDelivery,
  markDelivered: messageQueueService.markDelivered,
  markPending: messageQueueService.markPending,
  markUncertain: messageQueueService.markUncertain,
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
    getNotepadAcceptedContextRecorder().recordDelivered(input),
};

export interface QueueMessageParams {
  inputOrigin?: "user" | "generated";
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
    inputOrigin,
    consumePendingQuestionId,
    deps: depsOverride,
  } = params;

  const deps: QueueMessageDeps = { ...defaultDeps, ...depsOverride };

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

  const enqueued = deps.enqueue({
    backend,
    projectPath,
    sessionName,
    conversationId,
    content,
    ...(inputOrigin ? { inputOrigin } : {}),
    ...(metadata ? { metadata } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(consumePendingQuestionId !== undefined
      ? { consumePendingQuestionId }
      : {}),
  });

  // Observe an enqueue failure while an earlier dispatch is still pending;
  // queueMessageInOrder rethrows it when this operation reaches the head.
  void enqueued.catch(() => {});
  const key = JSON.stringify([projectPath, sessionName, conversationId]);
  const previous = liveDispatches.get(key) ?? Promise.resolve();
  const operation = previous.then(() =>
    queueMessageInOrder(params, deps, enqueued),
  );
  const settled = operation.then(
    () => {},
    () => {},
  );
  liveDispatches.set(key, settled);
  try {
    return await operation;
  } finally {
    if (liveDispatches.get(key) === settled) liveDispatches.delete(key);
  }
}

// Reserve dispatch order before asynchronous preparation; enqueue remains prompt.
const liveDispatches = new Map<string, Promise<void>>();

function runtimeRunsSelection(
  runtime: ConversationBackendRuntime | undefined,
  selection: BackendModelSelection,
): boolean {
  return (
    runtime !== undefined &&
    modelSelectionKey(runtime.modelSelection) === modelSelectionKey(selection)
  );
}

/**
 * Whether the core runs the conversation, and whether its running turn takes
 * input now. The message is already queued, so a check that fails declines:
 * the row waits for the next turn rather than failing the request.
 */
async function coreLiveInput(
  params: QueueMessageParams,
  deps: QueueMessageDeps,
  core: NonNullable<QueueMessageDeps["core"]>,
): Promise<"not_core" | "accepts" | "declined"> {
  const { conversationId, sessionName, projectPath } = params;
  try {
    if (!(await core.owns(conversationId))) return "not_core";
    return (await core.acceptsLive(conversationId)) ? "accepts" : "declined";
  } catch (error) {
    logger.warn("queue.core_live_check_failed", {
      projectName: deps.getProjectDisplayName(projectPath),
      ...scopeRefFromStoreSessionName(sessionName),
      conversationId,
      error: getErrorMessage(error),
    });
    return "declined";
  }
}

/**
 * A conversation the core runs takes live input through the core, with the
 * same turn input as its turns; the queue only claims the row for it.
 */
async function deliverThroughCore(
  params: QueueMessageParams,
  deps: QueueMessageDeps,
  core: NonNullable<QueueMessageDeps["core"]>,
  entry: PendingQueuedMessage,
): Promise<QueueMessageResult> {
  const { projectPath, sessionName, conversationId } = params;
  const claimed = await deps.claimLiveDelivery({ projectPath, sessionName, conversationId, id: entry.id });
  // No longer pending: cancelled, or claimed by a racing drain.
  if (claimed === null) return { entry, deliveryTiming: "in_turn" };
  const deliveryAttemptId = claimed.deliveryAttemptId;
  if (deliveryAttemptId == null) {
    // As on the actor's path: abandoned-delivery recovery reclaims the row.
    logger.error("queue.live_delivery", {
      projectName: deps.getProjectDisplayName(projectPath),
      ...scopeRefFromStoreSessionName(sessionName),
      conversationId,
      messageIds: [entry.id],
      status: "delivering",
      error: "claimed row missing delivery attempt id",
    });
    return { entry, deliveryTiming: "in_turn" };
  }
  const { promptText, images, documentFeedback, notepadFeedback } = queuedBatchToSubmitPrompt(claimed.content);
  const request: UserTurnRequest = {
    kind: "user_message",
    text: promptText,
    ...(images.length > 0 ? { images } : {}),
    ...(documentFeedback !== undefined ? { documentFeedback } : {}),
    ...(notepadFeedback !== undefined ? { notepadFeedback } : {}),
    inputOrigin: isQueuedUserMessage(claimed) ? "user" : "generated",
    queuedDelivery: { messageIds: [entry.id], deliveryAttemptId },
  };
  let outcome: DeliveryClass;
  try {
    outcome = await core.deliverLive({ projectPath, storeSessionName: sessionName, conversationId }, request);
  } catch (error) {
    logger.error("queue.core_live_delivery_failed", {
      projectName: deps.getProjectDisplayName(projectPath),
      ...scopeRefFromStoreSessionName(sessionName),
      conversationId,
      messageIds: [entry.id],
      deliveryAttemptId,
      error: getErrorMessage(error),
    });
    await deps.markPending({
      projectPath,
      sessionName,
      conversationId,
      ids: [entry.id],
      deliveryAttemptId,
      error: getErrorMessage(error),
    });
    return { entry, deliveryTiming: "next_turn" };
  }
  if (outcome === "not_sent") return { entry, deliveryTiming: "next_turn" };
  if (outcome === "uncertain") {
    return {
      entry: { ...claimed, status: "uncertain", error: "It may have reached the agent; review it before sending again" },
      deliveryTiming: "in_turn",
    };
  }
  return { entry, deliveryTiming: "in_turn" };
}

async function queueMessageInOrder(
  params: QueueMessageParams,
  deps: QueueMessageDeps,
  enqueued: Promise<PendingQueuedMessage | null>,
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
    consumePendingQuestionId,
    deliveryPolicy,
  } = params;

  // Diagnostic identity (R1.3): the queue is session-keyed storage, so
  // `sessionName` is the sentinel for a project conversation.
  const scopeRef = scopeRefFromStoreSessionName(sessionName);

  const entry = await enqueued;
  if (!entry) return null;

  if (
    deliveryPolicy === "next_turn" ||
    entry.metadata?.kind === "subscription_update"
  ) {
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

  // A model selection can only take effect at a turn boundary, so a message
  // that CHANGES the selection waits for the next turn. The composer sends its
  // current selection with every queued message, so a selection the running
  // turn already uses is not a change and must not push the message out of
  // the turn. Without a live runtime nothing can confirm the active selection,
  // and the next-turn drain honours the selection either way.
  if (
    modelSelection !== undefined &&
    !runtimeRunsSelection(deps.getRuntime(conversationId), modelSelection)
  ) {
    logger.info("queue.delivery_deferred", {
      projectName: deps.getProjectDisplayName(projectPath),
      ...scopeRef,
      conversationId,
      messageIds: [entry.id],
      status: "pending",
      reason: "model_selection",
      modelId: modelSelection.modelId,
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

  if (deps.core !== undefined) {
    const live = await coreLiveInput(params, deps, deps.core);
    if (live === "accepts") return deliverThroughCore(params, deps, deps.core, entry);
    if (live === "declined") {
      // It waits for the next turn: the running turn's end, or the caller's drain, takes it.
      logger.info("queue.delivery_deferred", {
        projectName: deps.getProjectDisplayName(projectPath),
        ...scopeRef,
        conversationId,
        messageIds: [entry.id],
        status: "pending",
        reason: "core_declined",
      });
      return { entry, deliveryTiming: "next_turn" };
    }
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
    return { entry, deliveryTiming: "next_turn" };
  }

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

  // Rendered references provide a local baseline until backend acceptance.
  let passive;
  const passiveReceipts: (() => Promise<void>)[] = [];
  const notepadReferences = deliveredNotepads.map(
    ({ id, revision, openComments, commentIds }) => ({
      notepadId: id,
      revision,
      openComments,
      ...(commentIds === undefined ? {} : { commentIds }),
    }),
  );
  const acceptedNotepadContext = createRequiredInputReceipt(async () => {
    if (notepadReferences.length)
      await deps.recordNotepadDeliveries({
        conversationId,
        notepads: notepadReferences,
      });
  });
  let notepadContextFinalized = false;
  const finishNotepadContext = () => {
    notepadContextFinalized = true;
    return acceptedNotepadContext.finish();
  };
  if (notepadReferences.length) passiveReceipts.push(finishNotepadContext);
  const acceptedNotepadReferences = prepareAcceptedNotepadReferences(
    deps.subscriptions,
    { projectPath, conversationId },
    notepadReferences,
    (finish) => passiveReceipts.push(finish),
  );
  try {
    passive = await preparePassiveSubscriptionContext(
      deps.subscriptions,
      {
        recipient: { projectPath, conversationId },
        attemptId: deliveryAttemptId,
        eligible: isQueuedUserMessage(claimed),
        providedNotepadContext: notepadReferences,
      },
      (finish) => passiveReceipts.push(finish),
    );
    for (const finish of passiveReceipts) {
      if (
        !(await deps.ownSubscriptionReceipt?.(
          { projectPath, sessionName, conversationId, runtime },
          finish,
        ))
      )
        throw new Error("Live input receipt owner is no longer available");
    }
  } catch (error) {
    await passive?.finish();
    await deps.markPending({
      projectPath,
      sessionName,
      conversationId,
      ids: [entry.id],
      deliveryAttemptId,
      error: getErrorMessage(error),
    });
    return { entry, deliveryTiming: "next_turn" };
  }
  let accepted = false;
  let acceptance: Promise<void> | undefined;
  let settlementError: string | null = null;
  const holdForReview = async (error: string): Promise<void> => {
    try {
      await deps.markUncertain({
        projectPath,
        sessionName,
        conversationId,
        ids: [entry.id],
        deliveryAttemptId,
        error,
      });
    } catch (failure) {
      // The original delivering claim remains the durable no-redelivery guard.
      logger.error("queue.acceptance_review_failed", {
        projectName: deps.getProjectDisplayName(projectPath),
        ...scopeRef,
        conversationId,
        messageIds: [entry.id],
        deliveryAttemptId,
        error: getErrorMessage(failure),
      });
    }
  };
  const onAccepted = (): Promise<void> => {
    accepted = true;
    acceptance ??= (async () => {
      const passiveAcceptance = passive.onInputAccepted();
      const notepadInvolvement = acceptedNotepadReferences.onInputAccepted();
      void passiveAcceptance.catch(() => {});
      void notepadInvolvement.catch(() => {});
      const contextAcceptance = acceptedNotepadContext.onInputAccepted();
      void contextAcceptance.catch(() => {});
      // Acceptance is already proven. Preserve the user input before a
      // required context receipt can fail; keep queue ownership until all
      // receipts are durable.
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
          id: entry.id,
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

      await contextAcceptance;
      await passiveAcceptance;
      await notepadInvolvement;

      try {
        await deps.markDelivered({
          projectPath,
          sessionName,
          conversationId,
          ids: [entry.id],
          deliveryAttemptId,
        });
      } catch (error) {
        settlementError = getErrorMessage(error);
        logger.error("queue.acceptance_settlement_failed", {
          projectName: deps.getProjectDisplayName(projectPath),
          ...scopeRef,
          conversationId,
          messageIds: [entry.id],
          deliveryAttemptId,
          error: settlementError,
        });
        await holdForReview(settlementError);
      }
    })();
    return acceptance;
  };

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
    const isNativeCommand = /^\/[\w:-]+(?:\s|$)/.test(sourceText);
    const summarizedContent: MessageContentBlock[] = summary
      ? [...deliveryContent, { type: "text", text: summary }]
      : deliveryContent;
    const promptContext = isNativeCommand
      ? [passive.block, summary.trimStart()].filter(Boolean).join("\n\n")
      : undefined;
    if (notepadReferences.length && notepadContextFinalized)
      throw new Error("Accepted notepad context input already finalized");
    acceptedNotepadReferences.markDispatched();
    passive.markDispatched();
    await runtime.queueUserInput({
      userPromptText: text ?? "",
      content: isNativeCommand
        ? deliveryContent
        : passive.block
          ? [{ type: "text", text: passive.block }, ...summarizedContent]
          : summarizedContent,
      ...(promptContext ? { promptContext } : {}),
      onAccepted,
    });
  } catch (err) {
    passive.markDispatchFailure(err);
    const error = getErrorMessage(err);
    if (accepted || err instanceof InputDeliveryUncertainError) {
      await holdForReview(error);
      return {
        entry: { ...claimed, status: "uncertain", error },
        deliveryTiming: "in_turn",
      };
    }
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
    return { entry, deliveryTiming: "next_turn" };
  } finally {
    try {
      await passive.finish();
      await acceptedNotepadReferences.finish();
      await finishNotepadContext();
    } catch (error) {
      settlementError = getErrorMessage(error);
      await holdForReview(settlementError);
    }
  }

  if (settlementError !== null) {
    return {
      entry: { ...claimed, status: "uncertain", error: settlementError },
      deliveryTiming: "in_turn",
    };
  }

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
