import { createLogger } from "@/lib/logging";
import type { CreateProjectConversationNotificationInput } from "./repo";
import { getNotificationsService } from "./service";
import type {
  ProjectConversationNotification,
  ProjectConversationNotificationType,
} from "./schemas";

const logger = createLogger("notifications.project-conversation-service");

type NotifiableProjectConversationStatus = "awaiting" | "waiting_for_input";
type ProjectConversationStatus =
  | NotifiableProjectConversationStatus
  | "new"
  | "running";

export interface ProjectConversationStatusNotificationInput {
  projectName: string;
  conversationId: string;
  conversationName?: string | null;
  status: ProjectConversationStatus;
  transitionKey: string;
}

export interface ProjectConversationErrorNotificationInput {
  projectName: string;
  conversationId: string;
  conversationName?: string | null;
  errorMessage: string;
  transitionKey: string;
}

export interface ProjectConversationNotificationServiceDeps {
  createProjectConversationNotification(
    input: CreateProjectConversationNotificationInput,
  ): ProjectConversationNotification;
}

export interface ProjectConversationNotificationService {
  handleProjectConversationStatus(
    input: ProjectConversationStatusNotificationInput,
  ): ProjectConversationNotification | null;
  handleProjectConversationError(
    input: ProjectConversationErrorNotificationInput,
  ): ProjectConversationNotification;
}

const defaultDeps: ProjectConversationNotificationServiceDeps = {
  createProjectConversationNotification: (input) =>
    getNotificationsService().createProjectConversationNotification(input),
};

function conversationLabel(input: {
  conversationId: string;
  conversationName?: string | null;
}): string {
  const trimmedName = input.conversationName?.trim();
  if (trimmedName) return trimmedName;
  return `Conversation ${input.conversationId}`;
}

function buildDedupeKey(input: {
  projectName: string;
  conversationId: string;
  type: ProjectConversationNotificationType;
  transitionKey: string;
}): string {
  return [
    "project-conversation",
    input.projectName,
    input.conversationId,
    input.type,
    input.transitionKey,
  ]
    .map(encodeURIComponent)
    .join(":");
}

function createNotificationFromMapping(
  deps: ProjectConversationNotificationServiceDeps,
  input: {
    projectName: string;
    conversationId: string;
    conversationName?: string | null;
    transitionKey: string;
    type: ProjectConversationNotificationType;
    title: string;
    message: string;
    status: ProjectConversationNotification["status"];
    errorMessage?: string;
  },
): ProjectConversationNotification {
  const dedupeKey = buildDedupeKey({
    projectName: input.projectName,
    conversationId: input.conversationId,
    type: input.type,
    transitionKey: input.transitionKey,
  });

  return deps.createProjectConversationNotification({
    type: input.type,
    title: input.title,
    message: input.message,
    projectName: input.projectName,
    conversationId: input.conversationId,
    conversationName: input.conversationName ?? null,
    status: input.status,
    ...(input.errorMessage !== undefined
      ? { errorMessage: input.errorMessage }
      : {}),
    dedupeKey,
  });
}

export function createProjectConversationNotificationService(
  deps: ProjectConversationNotificationServiceDeps = defaultDeps,
): ProjectConversationNotificationService {
  function handleProjectConversationStatus(
    input: ProjectConversationStatusNotificationInput,
  ): ProjectConversationNotification | null {
    if (input.status !== "awaiting" && input.status !== "waiting_for_input") {
      logger.debug("project-conversation-notification.status_ignored", {
        projectName: input.projectName,
        conversationId: input.conversationId,
        status: input.status,
        transitionKey: input.transitionKey,
      });
      return null;
    }

    const label = conversationLabel(input);
    const notificationInput =
      input.status === "awaiting"
        ? {
            type: "project-conversation-ready" as const,
            title: "Project conversation ready",
            message: `${label} in ${input.projectName} is ready.`,
            status: "awaiting" as const,
          }
        : {
            type: "project-conversation-input-needed" as const,
            title: "Project conversation needs input",
            message: `${label} in ${input.projectName} needs input.`,
            status: "waiting_for_input" as const,
          };

    const notification = createNotificationFromMapping(deps, {
      ...notificationInput,
      projectName: input.projectName,
      conversationId: input.conversationId,
      conversationName: input.conversationName ?? null,
      transitionKey: input.transitionKey,
    });

    logger.info("project-conversation-notification.status_handled", {
      notificationId: notification.id,
      notificationType: notification.type,
      projectName: input.projectName,
      conversationId: input.conversationId,
      status: input.status,
      transitionKey: input.transitionKey,
    });

    return notification;
  }

  function handleProjectConversationError(
    input: ProjectConversationErrorNotificationInput,
  ): ProjectConversationNotification {
    const label = conversationLabel(input);
    const notification = createNotificationFromMapping(deps, {
      type: "project-conversation-failed",
      title: "Project conversation failed",
      message: `${label} in ${input.projectName} failed: ${input.errorMessage}`,
      projectName: input.projectName,
      conversationId: input.conversationId,
      conversationName: input.conversationName ?? null,
      status: "failed",
      errorMessage: input.errorMessage,
      transitionKey: input.transitionKey,
    });

    logger.info("project-conversation-notification.error_handled", {
      notificationId: notification.id,
      notificationType: notification.type,
      projectName: input.projectName,
      conversationId: input.conversationId,
      transitionKey: input.transitionKey,
    });

    return notification;
  }

  return {
    handleProjectConversationStatus,
    handleProjectConversationError,
  };
}
