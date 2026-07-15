/**
 * Project-conversation status notification policy.
 *
 * Decides when a session-less project conversation's machine context warrants
 * a notification (readiness, input-needed, or error) and builds the
 * deduplicating transition keys the notification service keys on. Invoked by
 * the conversation actor manager on every status broadcast for
 * sentinel-session conversations.
 */

import type { ConversationContext } from "@/lib/workflows/conversation/types";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ProjectConversationNotificationService } from "@/lib/notifications/project-conversation-service";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";

type ProjectConversationStatusNotificationDeps = {
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  notificationService: ProjectConversationNotificationService;
};

let _projectConversationStatusNotificationDeps: ProjectConversationStatusNotificationDeps | null =
  null;

export function setProjectConversationStatusNotificationDepsForTesting(
  deps: ProjectConversationStatusNotificationDeps,
): void {
  _projectConversationStatusNotificationDeps = deps;
}

export function _resetProjectConversationStatusNotificationDepsForTesting(): void {
  _projectConversationStatusNotificationDeps = null;
}

async function getProjectConversationStatusNotificationDeps(): Promise<ProjectConversationStatusNotificationDeps> {
  if (_projectConversationStatusNotificationDeps) {
    return _projectConversationStatusNotificationDeps;
  }

  const [
    { getProjectConversation },
    { createProjectConversationNotificationService },
  ] = await Promise.all([
    import("@/lib/state-store"),
    import("@/lib/notifications/project-conversation-service"),
  ]);

  return {
    getProjectConversation,
    notificationService: createProjectConversationNotificationService(),
  };
}

function isNotifiableProjectConversationStatus(
  status: ConversationContext["status"],
): status is "awaiting" | "waiting_for_input" {
  return status === "awaiting" || status === "waiting_for_input";
}

function buildProjectConversationStatusTransitionKey(
  context: ConversationContext,
): string {
  if (context.status === "waiting_for_input") {
    return [
      context.projectName,
      context.conversationId,
      context.status,
      `prompt-${context.promptCount}`,
      `question-${context.pendingQuestion?.questionId ?? "unknown"}`,
    ].join(":");
  }

  return [
    context.projectName,
    context.conversationId,
    context.status,
    `prompt-${context.promptCount}`,
    `turns-${context.totals.totalTurns ?? "unknown"}`,
  ].join(":");
}

function buildProjectConversationErrorTransitionKey(
  context: ConversationContext,
  errorMessage: string,
): string {
  return [
    context.projectName,
    context.conversationId,
    "error",
    `prompt-${context.promptCount}`,
    `turns-${context.totals.totalTurns ?? "unknown"}`,
    encodeURIComponent(errorMessage),
  ].join(":");
}

export async function notifyProjectConversationStatusFromContext(
  context: ConversationContext,
): Promise<void> {
  if (!isProjectSentinel(context.sessionName)) return;

  const errorMessage =
    context.status === "awaiting"
      ? (context.lastResult?.error ?? context.lastError)
      : null;
  if (!errorMessage && !isNotifiableProjectConversationStatus(context.status)) {
    return;
  }

  const deps = await getProjectConversationStatusNotificationDeps();
  const conversation = await deps.getProjectConversation(
    context.projectPath,
    context.conversationId,
  );
  const conversationName = conversation?.name ?? null;

  if (errorMessage) {
    deps.notificationService.handleProjectConversationError({
      projectName: context.projectName,
      conversationId: context.conversationId,
      conversationName,
      errorMessage,
      transitionKey: buildProjectConversationErrorTransitionKey(
        context,
        errorMessage,
      ),
    });
    return;
  }

  if (isNotifiableProjectConversationStatus(context.status)) {
    deps.notificationService.handleProjectConversationStatus({
      projectName: context.projectName,
      conversationId: context.conversationId,
      conversationName,
      status: context.status,
      transitionKey: buildProjectConversationStatusTransitionKey(context),
    });
  }
}
