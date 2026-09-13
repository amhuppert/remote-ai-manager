import { CheckpointForkError } from "@/lib/conversation-checkpoints/fork-service";
/**
 * Scope-invariant message-queue operations, shared by the session and project
 * queue routes.
 *
 * The durable queue itself has never been session-specific: rows live on the
 * conversation, keyed by the session-keyed storage name that is the project
 * sentinel for a project conversation. What differed was the 404 ladder in
 * front of it. Splitting resolution (per scope) from policy (here) is what lets
 * a project conversation reach the same guards, the same enqueue-then-drain
 * ordering, and the same cancellation semantics as a session conversation
 * instead of a second implementation that drifts.
 *
 * Callers hand in a `ConversationScopeRef`, never a session name: the store key
 * is materialized at the storage call sites below, so no sentinel-valued
 * `sessionName` variable exists here for a log line to pick up (R1.3).
 */

import { NextResponse } from "next/server";
import { notFound, type RouteResolution } from "@/lib/shared/route-resolution";
import { createLogger } from "@/lib/logging";
// Imported from the submodule so span timing survives tests that stub the
// `@/lib/logging` barrel with a partial vi.mock (createLogger/withTracing only).
import { timed } from "@/lib/logging/timed";
import {
  storeSessionNameFromScopeRef,
  type ConversationScopeRef,
} from "@/lib/conversations/conversation-target";
import {
  queueEnqueueRequestSchema,
  queueReviewRequestSchema,
} from "@/lib/prompt/schemas";
import type { QueueCapability } from "@/lib/agent-backends/descriptor";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationState } from "@/lib/conversations/schemas";
import type {
  PendingQueuedMessage,
  QueueErrorCode,
  QueuedMessageView,
  QueueReviewAction,
} from "@/lib/conversations/message-queue-schemas";
import type {
  QueueCancellationResponse,
  QueueEnqueueRequest,
  QueueEnqueueResponse,
  QueueReviewRequest,
  QueueReviewResponse,
} from "@/lib/prompt/schemas";
import type {
  DocumentFeedbackPayload,
  NotepadFeedbackPayload,
} from "@/lib/conversations/message-content-schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { QueueDeliveryTiming } from "@/lib/agent-backends/descriptor";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { ProjectModelSelectionValidation } from "@/lib/agent-backends/conversation";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("message-queue");

/**
 * Queue behaviour both scopes depend on. Every member is addressed by the
 * session-keyed storage name, which is what makes the same set serve a project
 * conversation without a parallel implementation.
 */
export interface QueueOperationDeps {
  admitCheckpointForkSelection(input: {
    projectPath: string;
    conversation: ConversationState;
    backend: AgentBackendId;
    modelSelection?: BackendModelSelection;
  }): Promise<BackendModelSelection>;
  checkpointAcceptsQueuedInput(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): boolean;
  admitModelSelection(input: {
    backend: AgentBackendId;
    projectPath: string;
    modelSelection: BackendModelSelection;
  }): Promise<ProjectModelSelectionValidation>;
  getProjectDisplayName(projectPath: string): string;
  queueMessage(params: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    text?: string;
    images?: ImagePayload[];
    documentFeedback?: DocumentFeedbackPayload;
    notepadFeedback?: NotepadFeedbackPayload;
    modelSelection?: BackendModelSelection;
    backend: AgentBackendId;
    deliveryPolicy?: "next_turn";
  }): Promise<{
    entry: PendingQueuedMessage;
    deliveryTiming: QueueDeliveryTiming;
  }>;
  queueCapabilityForBackend(backend: AgentBackendId): QueueCapability;
  toQueuedMessageView(entry: PendingQueuedMessage): QueuedMessageView;
  clearConversationPendingPromptTextIfMatches(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    expected: string,
  ): Promise<boolean>;
  ensureConversationActorAndDrain(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<void>;
  resolveDelivery(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    id: string;
    action: QueueReviewAction;
  }): Promise<"resolved" | "not_found" | "not_reviewable">;
  cancel(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    id: string;
  }): Promise<"cancelled" | "not_found" | "not_cancellable">;
}

/** The conversation a queue operation addresses, once its scope has resolved. */
export interface ResolvedQueueTarget {
  projectPath: string;
  scope: ConversationScopeRef;
  conversationId: string;
  conversation: ConversationState;
}

export function queueError(
  error: string,
  code: QueueErrorCode,
  status: number,
): Response {
  return NextResponse.json({ error, code } satisfies ApiError, { status });
}

/**
 * Read and validate the enqueue body. Adapters call this BEFORE their 404
 * ladder, so an empty payload is the typed `EMPTY_MESSAGE` the client can act on
 * rather than a 404 about an entity the request never got to address. A body
 * that is not JSON at all is treated as empty, which is the same refusal.
 */
export async function parseQueueEnqueueBody(
  request: Request,
): Promise<RouteResolution<QueueEnqueueRequest>> {
  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = queueEnqueueRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: queueError(
        "Either message text or at least one image is required",
        "EMPTY_MESSAGE",
        400,
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Enqueue a follow-up into a running conversation or checkpoint hold.
 *
 * The post-commit drain closes the race the `running` check opens: if the turn
 * finalized between that read and the enqueue commit, the idle-entry drain has
 * already run and this row would sit pending until some future turn. Ensure+drain
 * is a no-op while a turn is running (the busy actor drains on its own idle
 * entry) and delivers immediately when the actor settled; it never fails the
 * already-committed enqueue.
 */
export async function enqueueQueuedMessage(
  deps: QueueOperationDeps,
  target: ResolvedQueueTarget,
  body: QueueEnqueueRequest,
): Promise<Response> {
  const { projectPath, scope, conversationId, conversation } = target;

  // Queuing is only for user-interactive conversations. A non-null role is a
  // managed workflow conversation (initialization/iteration/validator/planner).
  if (conversation.role !== null) {
    return queueError(
      "Queuing is not available for managed workflow conversations",
      "NON_INTERACTIVE_CONVERSATION",
      403,
    );
  }

  const storeSessionName = storeSessionNameFromScopeRef(scope);
  const checkpointQueue = deps.checkpointAcceptsQueuedInput(
    projectPath,
    storeSessionName,
    conversationId,
  );
  if (conversation.status !== "running" && !checkpointQueue) {
    return queueError(
      "Conversation is not running — use the prompt endpoint to send a new message",
      "NOT_RUNNING",
      409,
    );
  }

  if (
    !deps.queueCapabilityForBackend(conversation.agentBackend)
      .acceptsWhileRunning
  ) {
    return queueError(
      "The active backend does not support queuing messages",
      "UNSUPPORTED_BACKEND",
      422,
    );
  }

  let admittedModelSelection = body.modelSelection;
  if (conversation.checkpointFork) {
    try {
      admittedModelSelection = await deps.admitCheckpointForkSelection({
        projectPath,
        conversation,
        backend: conversation.agentBackend,
        ...(body.modelSelection ? { modelSelection: body.modelSelection } : {}),
      });
    } catch (error) {
      if (!(error instanceof CheckpointForkError)) throw error;
      logger.warn("checkpoint.fork.queue_refused", {
        conversationId,
        code: error.code,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
  } else if (body.modelSelection !== undefined) {
    const validation = await deps.admitModelSelection({
      backend: conversation.agentBackend,
      projectPath,
      modelSelection: body.modelSelection,
    });
    if (!validation.ok) {
      logger.warn("model_selection.rejected", {
        backend: conversation.agentBackend,
        modelId: validation.modelId,
        code: validation.code,
        ...(validation.parameterId !== undefined
          ? { parameterId: validation.parameterId }
          : {}),
      });
      return NextResponse.json(
        {
          error: validation.message,
          code: validation.code,
          modelId: validation.modelId,
          ...(validation.parameterId !== undefined
            ? { parameterId: validation.parameterId }
            : {}),
        },
        { status: 400 },
      );
    }
    admittedModelSelection = validation.modelSelection;
    logger.debug("model_selection.resolved", {
      backend: conversation.agentBackend,
      modelId: admittedModelSelection.modelId,
      parameterIds: Object.keys(admittedModelSelection.parameters).sort(),
      sourceLayer: "queue_request",
    });
  }

  if (checkpointQueue) {
    logger.info("queue.checkpoint_deferred", {
      projectPath,
      ...scope,
      conversationId,
    });
  }
  const result = await timed(
    logger,
    "queue.post.enqueue",
    { projectPath, ...scope, conversationId },
    () =>
      deps.queueMessage({
        projectPath,
        sessionName: storeSessionName,
        conversationId,
        ...(body.text !== undefined ? { text: body.text } : {}),
        ...(body.images !== undefined ? { images: body.images } : {}),
        ...(body.documentFeedback
          ? { documentFeedback: body.documentFeedback }
          : {}),
        ...(body.notepadFeedback
          ? { notepadFeedback: body.notepadFeedback }
          : {}),
        ...(admittedModelSelection
          ? { modelSelection: admittedModelSelection }
          : {}),
        backend: conversation.agentBackend,
        ...(checkpointQueue ? { deliveryPolicy: "next_turn" as const } : {}),
      }),
    (r) => ({ deliveryTiming: r.deliveryTiming }),
  );

  if (body.submittedPendingPromptText !== undefined) {
    try {
      const cleared = await deps.clearConversationPendingPromptTextIfMatches(
        projectPath,
        storeSessionName,
        conversationId,
        body.submittedPendingPromptText,
      );
      logger.debug("queue.pending_draft_clear_completed", {
        projectPath,
        ...scope,
        conversationId,
        messageIds: [result.entry.id],
        cleared,
      });
    } catch (error) {
      logger.warn("queue.pending_draft_clear_failed", {
        projectPath,
        ...scope,
        conversationId,
        messageIds: [result.entry.id],
        error: getErrorMessage(error),
      });
    }
  }

  try {
    await timed(
      logger,
      "queue.post.drain",
      { projectPath, ...scope, conversationId },
      () =>
        deps.ensureConversationActorAndDrain(
          projectPath,
          storeSessionName,
          conversationId,
        ),
    );
  } catch (err) {
    logger.error("queue.post_enqueue_drain_failed", {
      projectName: deps.getProjectDisplayName(projectPath),
      ...scope,
      conversationId,
      messageIds: [result.entry.id],
      error: getErrorMessage(err),
    });
  }

  const response: QueueEnqueueResponse = {
    queued: true,
    message: deps.toQueuedMessageView(result.entry),
    deliveryTiming: result.deliveryTiming,
  };
  return NextResponse.json(response);
}

/** Cancel a pending message. Claimed deliveries require explicit review after settlement. */
export async function cancelQueuedMessage(
  deps: QueueOperationDeps,
  target: ResolvedQueueTarget,
  messageId: string,
): Promise<Response> {
  const { projectPath, scope, conversationId, conversation } = target;

  // Cancellation, like queuing, is only for user-interactive conversations.
  if (conversation.role !== null) {
    return queueError(
      "Queuing is not available for managed workflow conversations",
      "NON_INTERACTIVE_CONVERSATION",
      403,
    );
  }

  const storeSessionName = storeSessionNameFromScopeRef(scope);
  const projectName = deps.getProjectDisplayName(projectPath);

  const result = await deps.cancel({
    projectPath,
    sessionName: storeSessionName,
    conversationId,
    id: messageId,
  });

  logger.info("queue.cancel", {
    projectName,
    ...scope,
    conversationId,
    messageIds: [messageId],
    result,
  });

  if (result === "cancelled") {
    const response: QueueCancellationResponse = {
      cancelled: true,
      id: messageId,
    };
    return NextResponse.json(response);
  }

  if (result === "not_found") {
    return notFound("Queued message not found");
  }

  return queueError(
    "This message is no longer pending; wait for delivery or use its review controls",
    "NOT_CANCELLABLE",
    409,
  );
}

/** Resolve a retained delivery explicitly before automatic draining can resume. */
export async function reviewQueuedMessage(
  deps: Pick<
    QueueOperationDeps,
    "resolveDelivery" | "ensureConversationActorAndDrain"
  >,
  target: ResolvedQueueTarget,
  messageId: string,
  body: QueueReviewRequest,
): Promise<Response> {
  const { projectPath, scope, conversationId, conversation } = target;
  if (conversation.role !== null)
    return queueError(
      "Queue review is not available for managed workflow conversations",
      "NON_INTERACTIVE_CONVERSATION",
      403,
    );
  if (conversation.status === "running")
    return queueError(
      "Wait for the active turn to stop before reviewing delivery",
      "NOT_REVIEWABLE",
      409,
    );
  const sessionName = storeSessionNameFromScopeRef(scope);
  const result = await deps.resolveDelivery({
    projectPath,
    sessionName,
    conversationId,
    id: messageId,
    action: body.action,
  });
  if (result === "not_found") return notFound("Queued message not found");
  if (result === "not_reviewable")
    return queueError(
      "This message does not need delivery review",
      "NOT_REVIEWABLE",
      409,
    );
  logger.info("queue.review_resolved", {
    projectPath,
    ...scope,
    conversationId,
    messageIds: [messageId],
    action: body.action,
  });
  try {
    await deps.ensureConversationActorAndDrain(
      projectPath,
      sessionName,
      conversationId,
    );
  } catch (error) {
    logger.error("queue.post_review_drain_failed", {
      projectPath,
      ...scope,
      conversationId,
      messageIds: [messageId],
      error: getErrorMessage(error),
    });
  }
  return NextResponse.json({
    resolved: true,
    id: messageId,
    action: body.action,
  } satisfies QueueReviewResponse);
}

export async function parseQueueReviewBody(
  request: Request,
): Promise<RouteResolution<QueueReviewRequest>> {
  const parsed = queueReviewRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return {
      ok: false,
      response: queueError(
        "Choose retry or discard for this delivery",
        "INVALID_QUEUE_REVIEW",
        400,
      ),
    };
  return { ok: true, value: parsed.data };
}
