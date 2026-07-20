import { createLogger } from "@/lib/logging";
import type { PushNotificationConfig } from "@/lib/notifications/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
const logger = createLogger("push-notification");

// ============================================================
// Types
// ============================================================

export type PushTriggerType =
  | "job-completed"
  | "waiting-for-input"
  | "workflow-completed"
  | "workflow-halted"
  | "conversation-idle"
  | "spec-approval-requested"
  | "spec-approval-granted"
  | "spec-policy-admitted";

export interface PushEvent {
  trigger: PushTriggerType;
  title: string;
  message: string;
  projectName: string;
  sessionName?: string;
  contextName?: string;
}

interface FormattedPush {
  title: string;
  body: string;
  tags: string;
}

// ============================================================
// Trigger → config key mapping
// ============================================================

const triggerToConfigKey: Record<
  PushTriggerType,
  keyof PushNotificationConfig["triggers"]
> = {
  "job-completed": "jobCompleted",
  "waiting-for-input": "waitingForInput",
  "workflow-completed": "workflowCompleted",
  "workflow-halted": "workflowHalted",
  "conversation-idle": "conversationIdle",
  "spec-approval-requested": "specApprovalRequested",
  "spec-approval-granted": "specApprovalGranted",
  "spec-policy-admitted": "specPolicyAdmitted",
};

const triggerToTag: Record<PushTriggerType, string> = {
  "job-completed": "white_check_mark",
  "waiting-for-input": "bell",
  "workflow-completed": "tada",
  "workflow-halted": "warning",
  "conversation-idle": "zzz",
  "spec-approval-requested": "bell",
  "spec-approval-granted": "white_check_mark",
  "spec-policy-admitted": "eyes",
};

// ============================================================
// Public API
// ============================================================

export function shouldSendPush(
  config: PushNotificationConfig | undefined,
  trigger: PushTriggerType,
): boolean {
  if (!config) return false;
  if (!config.enabled) return false;
  if (!config.topic) return false;
  return config.triggers[triggerToConfigKey[trigger]];
}

export function formatPushMessage(event: PushEvent): FormattedPush {
  return {
    title: `[${event.projectName}] ${event.title}`,
    body: event.message,
    tags: triggerToTag[event.trigger],
  };
}

const DEFAULT_PUSH_SERVER_URL = "https://ntfy.sh";

/**
 * Build the ntfy publish URL from the configured server URL. The config loader
 * strips schema defaults not present on disk (intersectKeys), so `serverUrl`
 * can be missing at runtime despite its non-optional type — fall back to the
 * schema's ntfy.sh default rather than dereferencing undefined.
 */
function pushPublishUrl(serverUrl: string | undefined): string {
  const base =
    serverUrl && serverUrl.trim().length > 0
      ? serverUrl
      : DEFAULT_PUSH_SERVER_URL;
  return `${base.replace(/\/+$/, "")}/`;
}

export async function sendPushNotification(
  config: PushNotificationConfig | undefined,
  event: PushEvent,
): Promise<void> {
  if (!shouldSendPush(config, event.trigger)) return;

  // config is guaranteed non-null by shouldSendPush
  const cfg = config!;
  const formatted = formatPushMessage(event);
  // ntfy JSON publish: POST to root URL, not the topic URL — putting title/tags
  // in the JSON body avoids HTTP header byte-string limits (Latin-1 only),
  // which previously broke any title containing characters like em-dash.
  const url = pushPublishUrl(cfg.serverUrl);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: cfg.topic,
        title: formatted.title,
        message: formatted.body,
        tags: [formatted.tags],
      }),
    });

    if (!response.ok) {
      logger.warn("push-notification.send_failed", {
        status: response.status,
        provider: cfg.provider,
        trigger: event.trigger,
      });
    } else {
      logger.debug("push-notification.sent", {
        trigger: event.trigger,
        projectName: event.projectName,
        sessionName: event.sessionName,
      });
    }
  } catch (error) {
    logger.warn("push-notification.send_error", {
      error: getErrorMessage(error),
      provider: cfg.provider,
      trigger: event.trigger,
    });
  }
}

/**
 * Send a push notification directly from an agent tool invocation.
 * No trigger-based config gate — the tool registration is the gate.
 */
export async function sendAgentNotification(
  config: PushNotificationConfig,
  title: string,
  message: string,
  tags: string,
  projectName: string,
  sessionName: string,
): Promise<void> {
  const url = pushPublishUrl(config.serverUrl);
  const formattedTitle = `[${projectName}] ${title}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: config.topic,
        title: formattedTitle,
        message,
        tags: [tags],
      }),
    });

    if (!response.ok) {
      logger.warn("agent-notification.send_failed", {
        status: response.status,
        projectName,
        sessionName,
      });
    } else {
      logger.debug("agent-notification.sent", {
        title,
        projectName,
        sessionName,
      });
    }
  } catch (error) {
    logger.warn("agent-notification.send_error", {
      error: getErrorMessage(error),
      projectName,
      sessionName,
    });
  }
}
