/**
 * Session-conversation queue routes — the session adapter of the shared queue
 * operations.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createQueueRouteHandlers(deps)`.
 */

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
import { ensureConversationActorAndDrain as defaultEnsureConversationActorAndDrain } from "@/lib/workflows/conversation/manager";
import { queueCapabilityForBackend as defaultQueueCapabilityForBackend } from "@/lib/agent-backends/catalog";
import { admitConfiguredModelSelection } from "@/lib/agent-backends/model-selection-admission";
import {
  cancelQueuedMessage,
  enqueueQueuedMessage,
  parseQueueEnqueueBody,
  parseQueueReviewBody,
  reviewQueuedMessage,
  type QueueOperationDeps,
} from "@/lib/prompt/queue-operations";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface QueueRouteDeps extends QueueOperationDeps {
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
}

const defaultDeps: QueueRouteDeps = {
  admitModelSelection: admitConfiguredModelSelection,
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getConversation: defaultGetConversation,
  getProjectDisplayName: defaultGetProjectDisplayName,
  queueMessage: defaultQueueMessage,
  queueCapabilityForBackend: defaultQueueCapabilityForBackend,
  toQueuedMessageView: defaultToQueuedMessageView,
  clearConversationPendingPromptTextIfMatches:
    defaultClearConversationPendingPromptTextIfMatches,
  ensureConversationActorAndDrain: defaultEnsureConversationActorAndDrain,
  cancel: (input) => messageQueueService.cancel(input),
  resolveDelivery: (input) => messageQueueService.resolveDelivery(input),
};

const logger = createLogger("message-queue");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<Record<string, string>>;
};

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

    const body = await parseQueueEnqueueBody(request);
    if (!body.ok) return body.response;

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

    return enqueueQueuedMessage(
      deps,
      {
        projectPath,
        scope: { scope: "session", sessionName },
        conversationId,
        conversation,
      },
      body.value,
    );
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

    return cancelQueuedMessage(
      deps,
      {
        projectPath,
        scope: { scope: "session", sessionName },
        conversationId,
        conversation,
      },
      messageId,
    );
  }

  async function REVIEW(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const body = await parseQueueReviewBody(request);
    if (!body.ok) return body.response;
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

    return reviewQueuedMessage(
      deps,
      {
        projectPath,
        scope: { scope: "session", sessionName },
        conversationId,
        conversation,
      },
      messageId,
      body.value,
    );
  }

  return { POST, DELETE, REVIEW };
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

export const reviewConversationQueuedMessage = withTracing(
  _defaultQueueHandlers.REVIEW,
);
