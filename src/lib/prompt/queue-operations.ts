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
import { queueEnqueueRequestSchema } from "@/lib/prompt/schemas";
import type { QueueCapability } from "@/lib/agent-backends/descriptor";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationState } from "@/lib/conversations/schemas";
import type {
  PendingQueuedMessage,
  QueueErrorCode,
  QueuedMessageView,
} from "@/lib/conversations/message-queue-schemas";
import type {
  QueueCancellationResponse,
  QueueEnqueueRequest,
  QueueEnqueueResponse,
} from "@/lib/prompt/schemas";
import type { DocumentFeedbackPayload } from "@/lib/conversations/message-content-schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { QueueDeliveryTiming } from "@/lib/agent-backends/descriptor";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("message-queue");

/**
 * Queue behaviour both scopes depend on. Every member is addressed by the
 * session-keyed storage name, which is what makes the same set serve a project
 * conversation without a parallel implementation.
 */
export interface QueueOperationDeps {
  getProjectDisplayName(projectPath: string): string;
  queueMessage(params: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    text?: string;
    images?: ImagePayload[];
    documentFeedback?: DocumentFeedbackPayload;
    backend: AgentBackendId;
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
  hasLiveConversationActor(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): boolean;
  ensureConversationActorAndDrain(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<void>;
  recoverAbandonedDeliveries(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<number>;
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
 * Enqueue a follow-up into a running conversation.
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

  if (conversation.status !== "running") {
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

  const storeSessionName = storeSessionNameFromScopeRef(scope);
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
        backend: conversation.agentBackend,
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

/**
 * Cancel a queued message before delivery.
 *
 * When no live actor owns the conversation (e.g. after a process restart), a row
 * may be stranded in `delivering` from an attempt whose owner is gone. Recovering
 * it back to `pending` first is what makes cancellation possible at all in that
 * state; a live actor still owning the attempt must not be disturbed.
 */
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

  if (
    !deps.hasLiveConversationActor(
      projectPath,
      storeSessionName,
      conversationId,
    )
  ) {
    await deps.recoverAbandonedDeliveries({
      projectPath,
      sessionName: storeSessionName,
      conversationId,
    });
  }

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
    "This message has already been delivered and can no longer be cancelled",
    "NOT_CANCELLABLE",
    409,
  );
}
