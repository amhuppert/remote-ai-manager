/**
 * Project-conversation queue routes — the project adapter of the shared queue
 * operations.
 *
 * Swaps the session 404 ladder for `resolveProjectConversationRoute` and hands
 * the scope-invariant policy a `scope: "project"` ref. The conversation is
 * addressed by project + conversation only, so no session segment exists in the
 * URL and no session name exists in this module to leak into a payload or a log
 * line; the store key is materialized inside the shared operations.
 */

import { withTracing } from "@/lib/logging";
import {
  getProjectDisplayName as defaultGetProjectDisplayName,
  resolveProjectPath as defaultResolveProjectPath,
} from "@/lib/projects/resolver";
import {
  cancelQueuedMessage,
  enqueueQueuedMessage,
  parseQueueEnqueueBody,
  type QueueOperationDeps,
} from "@/lib/prompt/queue-operations";
import { queueMessage as defaultQueueMessage } from "@/lib/prompt/queue";
import {
  toQueuedMessageView as defaultToQueuedMessageView,
  messageQueueService,
} from "@/lib/conversations/message-queue-service";
import { clearConversationPendingPromptTextIfMatches as defaultClearConversationPendingPromptTextIfMatches } from "@/lib/state-store";
import {
  hasLiveConversationActor as defaultHasLiveConversationActor,
  ensureConversationActorAndDrain as defaultEnsureConversationActorAndDrain,
} from "@/lib/workflows/conversation/manager";
import { queueCapabilityForBackend as defaultQueueCapabilityForBackend } from "@/lib/agent-backends/catalog";
import { admitConfiguredModelSelection } from "@/lib/agent-backends/model-selection-admission";
import { createProjectConversationService } from "./service";
import { resolveProjectConversationRoute } from "./route-resolution";
import type { ConversationState } from "@/lib/conversations/schemas";

type RouteContext = { params: Promise<Record<string, string>> };

export interface ProjectQueueRouteDeps extends QueueOperationDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

function defaultDeps(): ProjectQueueRouteDeps {
  const service = createProjectConversationService();
  return {
    admitModelSelection: admitConfiguredModelSelection,
    resolveProjectPath: defaultResolveProjectPath,
    getProjectDisplayName: defaultGetProjectDisplayName,
    getProjectConversation: (projectPath, id) =>
      service.getProjectConversation(projectPath, id),
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
}

export function createProjectQueueRouteHandlers(
  deps: ProjectQueueRouteDeps = defaultDeps(),
) {
  async function POST(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const body = await parseQueueEnqueueBody(request);
    if (!body.ok) return body.response;

    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId, conversation } = resolved.value;

    return enqueueQueuedMessage(
      deps,
      {
        projectPath,
        scope: { scope: "project" },
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
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, conversationId, conversation } = resolved.value;
    const messageId = (await context.params)["messageId"] ?? "";

    return cancelQueuedMessage(
      deps,
      {
        projectPath,
        scope: { scope: "project" },
        conversationId,
        conversation,
      },
      messageId,
    );
  }

  return { POST, DELETE };
}

const _handlers = createProjectQueueRouteHandlers();
export const projectConversationQueuePOST = withTracing(_handlers.POST);
export const projectConversationQueueCancelDELETE = withTracing(
  _handlers.DELETE,
);
