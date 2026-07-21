/**
 * Queue route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createQueueRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import {
  notFound,
  resolveProjectSessionOr404,
} from "@/lib/shared/route-resolution";
import { createLogger, withTracing } from "@/lib/logging";
// Imported from the submodule so span timing survives tests that stub the
// `@/lib/logging` barrel with a partial vi.mock (createLogger/withTracing only).
import { timed } from "@/lib/logging/timed";
import {
  resolveProjectPath as defaultResolveProjectPath,
  getProjectDisplayName as defaultGetProjectDisplayName,
} from "@/lib/projects/resolver";
import {
  clearConversationPendingPromptTextIfMatches as defaultClearConversationPendingPromptTextIfMatches,
  getSession as defaultGetSession,
} from "@/lib/state-store";
import { getConversation as defaultGetConversation } from "@/lib/conversations/service";
import { queueMessage as defaultQueueMessage } from "@/lib/prompt/queue";
import {
  toQueuedMessageView as defaultToQueuedMessageView,
  messageQueueService,
} from "@/lib/conversations/message-queue-service";
import {
  hasLiveConversationActor as defaultHasLiveConversationActor,
  ensureConversationActorAndDrain as defaultEnsureConversationActorAndDrain,
} from "@/lib/workflows/conversation/manager";
import { queueCapabilityForBackend as defaultQueueCapabilityForBackend } from "@/lib/agent-backends/catalog";
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
  QueueEnqueueResponse,
} from "@/lib/prompt/schemas";
import type { DocumentFeedbackPayload } from "@/lib/conversations/message-content-schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { QueueDeliveryTiming } from "@/lib/agent-backends/descriptor";
import { getErrorMessage } from "@/lib/shared/errors";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface QueueRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
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
  clearConversationPendingPromptTextIfMatches: typeof defaultClearConversationPendingPromptTextIfMatches;
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

const defaultDeps: QueueRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getConversation: defaultGetConversation,
  getProjectDisplayName: defaultGetProjectDisplayName,
  queueMessage: defaultQueueMessage,
  queueCapabilityForBackend: defaultQueueCapabilityForBackend,
  toQueuedMessageView: defaultToQueuedMessageView,
  clearConversationPendingPromptTextIfMatches:
    defaultClearConversationPendingPromptTextIfMatches,
  hasLiveConversationActor: defaultHasLiveConversationActor,
  ensureConversationActorAndDrain: defaultEnsureConversationActorAndDrain,
  recoverAbandonedDeliveries: (input) =>
    messageQueueService.recoverAbandonedDeliveries(input),
  cancel: (input) => messageQueueService.cancel(input),
};

const logger = createLogger("message-queue");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<Record<string, string>>;
};

function queueError(
  error: string,
  code: QueueErrorCode,
  status: number,
): Response {
  return NextResponse.json({ error, code } satisfies ApiError, { status });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createQueueRouteHandlers(deps: QueueRouteDeps = defaultDeps) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const conversationId = resolvedParams["conversationId"] ?? "";

    // Validate the request body up front: an empty payload (no text and no
    // images) is rejected with the typed EMPTY_MESSAGE error before any
    // resolution or boundary work.
    let rawBody: unknown = {};
    try {
      rawBody = await request.json();
    } catch {
      rawBody = {};
    }
    const parsed = queueEnqueueRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return queueError(
        "Either message text or at least one image is required",
        "EMPTY_MESSAGE",
        400,
      );
    }

    const resolved = await resolveProjectSessionOr404(deps, name, sessionName);
    if (!resolved.ok) return resolved.response;
    const { projectPath } = resolved.value;

    const conversation = await timed(
      logger,
      "queue.post.load_conversation",
      { projectPath, sessionName, conversationId },
      () => deps.getConversation(projectPath, sessionName, conversationId),
    );
    if (!conversation) {
      return notFound("Conversation not found");
    }

    // Queuing is only for user-interactive conversations. A non-null role is a
    // managed workflow conversation (initialization/iteration/validator/planner).
    if (conversation.role !== null) {
      return queueError(
        "Queuing is not available for managed workflow conversations",
        "NON_INTERACTIVE_CONVERSATION",
        403,
      );
    }

    // Can only queue into a running conversation.
    if (conversation.status !== "running") {
      return queueError(
        "Conversation is not running — use the prompt endpoint to send a new message",
        "NOT_RUNNING",
        409,
      );
    }

    // The backend must be able to accept a queued message while running.
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

    const result = await timed(
      logger,
      "queue.post.enqueue",
      { projectPath, sessionName, conversationId },
      () =>
        deps.queueMessage({
          projectPath,
          sessionName,
          conversationId,
          text: parsed.data.text,
          images: parsed.data.images,
          ...(parsed.data.documentFeedback
            ? { documentFeedback: parsed.data.documentFeedback }
            : {}),
          backend: conversation.agentBackend,
        }),
      (r) => ({ deliveryTiming: r.deliveryTiming }),
    );

    if (parsed.data.submittedPendingPromptText !== undefined) {
      try {
        const cleared = await deps.clearConversationPendingPromptTextIfMatches(
          projectPath,
          sessionName,
          conversationId,
          parsed.data.submittedPendingPromptText,
        );
        logger.debug("queue.pending_draft_clear_completed", {
          projectPath,
          sessionName,
          conversationId,
          messageId: result.entry.id,
          cleared,
        });
      } catch (error) {
        logger.warn("queue.pending_draft_clear_failed", {
          projectPath,
          sessionName,
          conversationId,
          messageId: result.entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // The running-status check above raced the turn's end: if the turn
    // finalized between that read and the enqueue commit, the idle-entry drain
    // has already run and this row would sit pending until some future turn.
    // Ensure+drain closes the gap — it is a no-op while a turn is running (the
    // busy actor drains on its own idle entry) and delivers immediately when
    // the actor settled. Never fails the already-committed enqueue.
    try {
      await timed(
        logger,
        "queue.post.drain",
        { projectPath, sessionName, conversationId },
        () =>
          deps.ensureConversationActorAndDrain(
            projectPath,
            sessionName,
            conversationId,
          ),
      );
    } catch (err) {
      logger.error("queue.post_enqueue_drain_failed", {
        projectName: deps.getProjectDisplayName(projectPath),
        sessionName,
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

  async function DELETE(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const conversationId = resolvedParams["conversationId"] ?? "";
    const messageId = resolvedParams["messageId"] ?? "";

    const resolved = await resolveProjectSessionOr404(deps, name, sessionName);
    if (!resolved.ok) return resolved.response;
    const { projectPath } = resolved.value;

    const conversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!conversation) {
      return notFound("Conversation not found");
    }

    // Cancellation, like queuing, is only for user-interactive conversations.
    if (conversation.role !== null) {
      return queueError(
        "Queuing is not available for managed workflow conversations",
        "NON_INTERACTIVE_CONVERSATION",
        403,
      );
    }

    const projectName = deps.getProjectDisplayName(projectPath);

    // When no live actor owns the conversation (e.g. after a process restart), a
    // row may be stranded in `delivering` from an attempt whose owner is gone.
    // Recover it back to `pending` first so cancellation can succeed; a live
    // actor still owning the attempt must not be disturbed.
    if (
      !deps.hasLiveConversationActor(projectPath, sessionName, conversationId)
    ) {
      await deps.recoverAbandonedDeliveries({
        projectPath,
        sessionName,
        conversationId,
      });
    }

    const result = await deps.cancel({
      projectPath,
      sessionName,
      conversationId,
      id: messageId,
    });

    logger.info("queue.cancel", {
      projectName,
      sessionName,
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

  return { POST, DELETE };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultQueueHandlers = createQueueRouteHandlers();
export const enqueueConversationPrompt = withTracing(
  _defaultQueueHandlers.POST,
);
export const cancelConversationQueuedMessage = withTracing(
  _defaultQueueHandlers.DELETE,
);
