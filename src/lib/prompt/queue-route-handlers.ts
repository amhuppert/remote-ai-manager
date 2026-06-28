/**
 * Queue route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createQueueRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import {
  resolveProjectPath as defaultResolveProjectPath,
  getProjectDisplayName as defaultGetProjectDisplayName,
} from "@/lib/projects/resolver";
import { getSession as defaultGetSession } from "@/lib/state-store";
import {
  getConversation as defaultGetConversation,
  setConversationPendingPromptText as defaultSetConversationPendingPromptText,
} from "@/lib/conversations/service";
import { queueMessage as defaultQueueMessage } from "@/lib/prompt/queue";
import {
  toQueuedMessageView as defaultToQueuedMessageView,
  messageQueueService,
} from "@/lib/conversations/message-queue-service";
import { hasLiveConversationActor as defaultHasLiveConversationActor } from "@/lib/workflows/conversation/manager";
import { queueCapabilityForBackend as defaultQueueCapabilityForBackend } from "@/lib/agent-backends/capabilities-descriptor";
import { queueEnqueueRequestSchema } from "@/lib/prompt/schemas";
import type { QueueCapability } from "@/lib/agent-backends/capabilities-descriptor";
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
import type { QueueDeliveryTiming } from "@/lib/agent-backends/capabilities-descriptor";

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
  setConversationPendingPromptText(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    text: string | null,
  ): Promise<void>;
  hasLiveConversationActor(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): boolean;
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
  setConversationPendingPromptText: defaultSetConversationPendingPromptText,
  hasLiveConversationActor: defaultHasLiveConversationActor,
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

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const conversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" } satisfies ApiError,
        { status: 404 },
      );
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

    // The user is submitting their draft via the queue path — clear the
    // persisted pending prompt text so it isn't resurrected on remount.
    await deps.setConversationPendingPromptText(
      projectPath,
      sessionName,
      conversationId,
      null,
    );

    const result = await deps.queueMessage({
      projectPath,
      sessionName,
      conversationId,
      text: parsed.data.text,
      images: parsed.data.images,
      ...(parsed.data.documentFeedback
        ? { documentFeedback: parsed.data.documentFeedback }
        : {}),
      backend: conversation.agentBackend,
    });

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

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) {
      return NextResponse.json(
        { error: "Session not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const conversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" } satisfies ApiError,
        { status: 404 },
      );
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
      return NextResponse.json(
        { error: "Queued message not found" } satisfies ApiError,
        { status: 404 },
      );
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
