import { sendPushNotification, type PushEvent } from "./push-notification";
import { assertNever } from "./assert-never";
import { createLogger } from "./logging";
import { readConfig } from "./config";
import { getGlobalValue, setGlobalValue } from "./global-singleton";
import type {
  PushNotificationConfig,
  Notification,
  ConversationStatus,
  ConversationRole,
  WorkflowStatus,
} from "@/types";

const logger = createLogger("push-dispatcher");

/** Config reader function — injected for testability, defaults to reading from disk */
export type ConfigReaderFn = () => Promise<{
  pushNotification?: PushNotificationConfig;
}>;

const CONFIG_READER_KEY = "__cc_push_config_reader";

export function setConfigReader(reader: ConfigReaderFn): void {
  setGlobalValue(CONFIG_READER_KEY, reader);
}

async function getPushConfig(): Promise<PushNotificationConfig | undefined> {
  const configReader =
    getGlobalValue<ConfigReaderFn>(CONFIG_READER_KEY) ?? readConfig;
  try {
    const config = await configReader();
    return config.pushNotification;
  } catch {
    logger.warn("push-dispatcher.config_read_error");
    return undefined;
  }
}

// ============================================================
// Push for DB notifications (job completions)
// ============================================================

export async function pushForNotification(
  config: PushNotificationConfig | undefined,
  notification: Notification,
): Promise<void> {
  if (!config) return;

  const event: PushEvent = {
    trigger: "job-completed",
    title: notification.title,
    message: notification.message,
    projectName: notification.projectName,
    sessionName: notification.sessionName,
  };

  await sendPushNotification(config, event);
}

// ============================================================
// Push for conversation status changes
// ============================================================

interface ConversationStatusInfo {
  projectName: string;
  sessionName: string;
  conversationId: string;
  status: ConversationStatus;
  role?: ConversationRole;
}

export async function pushForConversationStatus(
  config: PushNotificationConfig | undefined,
  info: ConversationStatusInfo,
): Promise<void> {
  // Graph workflow conversations (iteration/validator) manage their own
  // notifications at the workflow level — suppress per-conversation noise.
  if (info.role === "iteration" || info.role === "validator") return;

  switch (info.status) {
    case "waiting_for_input":
      await sendPushNotification(config, {
        trigger: "waiting-for-input",
        title: "Waiting for input",
        message: `Session ${info.sessionName} needs your input`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "awaiting":
      await sendPushNotification(config, {
        trigger: "conversation-idle",
        title: "Agent finished",
        message: `Session ${info.sessionName} is now idle`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "new":
    case "running":
      return;
    default:
      assertNever(info.status);
  }
}

// ============================================================
// Push for workflow status changes
// ============================================================

interface WorkflowStatusInfo {
  projectName: string;
  sessionName: string;
  workflowStatus: WorkflowStatus;
}

export async function pushForWorkflowStatus(
  config: PushNotificationConfig | undefined,
  info: WorkflowStatusInfo,
): Promise<void> {
  switch (info.workflowStatus) {
    case "completed":
      await sendPushNotification(config, {
        trigger: "workflow-completed",
        title: "Workflow completed",
        message: `Ralph Loop workflow completed for session ${info.sessionName}`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "halted":
      await sendPushNotification(config, {
        trigger: "workflow-halted",
        title: "Workflow halted",
        message: `Ralph Loop workflow halted for session ${info.sessionName}`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "stopped":
    case "planning":
    case "running":
      // No push notification for intermediate/stop statuses
      return;
    default:
      assertNever(info.workflowStatus);
  }
}

// ============================================================
// Push for graph workflow events
// ============================================================

type GraphWorkflowPushInfo =
  | {
      kind: "workflow-completed" | "workflow-halted";
      projectName: string;
      sessionName: string;
    }
  | {
      kind: "circuit-breaker";
      projectName: string;
      sessionName: string;
      contextTitle: string;
    }
  | {
      kind: "context-completed";
      projectName: string;
      sessionName: string;
      contextTitle: string;
      completedContexts: number;
      totalContexts: number;
    };

export async function pushForGraphWorkflowEvent(
  config: PushNotificationConfig | undefined,
  info: GraphWorkflowPushInfo,
): Promise<void> {
  if (!config) return;

  switch (info.kind) {
    case "workflow-completed":
      await sendPushNotification(config, {
        trigger: "workflow-completed",
        title: "Graph workflow completed",
        message: `Graph workflow completed for session ${info.sessionName}`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "workflow-halted":
      await sendPushNotification(config, {
        trigger: "workflow-halted",
        title: "Graph workflow halted",
        message: `Graph workflow halted for session ${info.sessionName}`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "circuit-breaker":
      await sendPushNotification(config, {
        trigger: "workflow-halted",
        title: "Circuit breaker tripped",
        message: `Circuit breaker tripped in context "${info.contextTitle}" for session ${info.sessionName}`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "context-completed":
      await sendPushNotification(config, {
        trigger: "workflow-completed",
        title: `Context completed (${info.completedContexts}/${info.totalContexts})`,
        message: `Context "${info.contextTitle}" completed for session ${info.sessionName}`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    default:
      assertNever(info);
  }
}

// ============================================================
// Fire-and-forget dispatchers (read config internally)
// ============================================================

export function dispatchPushForNotification(notification: Notification): void {
  getPushConfig()
    .then((config) => pushForNotification(config, notification))
    .catch(() => {});
}

export function dispatchPushForConversationStatus(
  info: ConversationStatusInfo,
): void {
  getPushConfig()
    .then((config) => pushForConversationStatus(config, info))
    .catch(() => {});
}

export function dispatchPushForWorkflowStatus(info: WorkflowStatusInfo): void {
  getPushConfig()
    .then((config) => pushForWorkflowStatus(config, info))
    .catch(() => {});
}

export function dispatchPushForGraphWorkflowEvent(
  info: GraphWorkflowPushInfo,
): void {
  getPushConfig()
    .then((config) => pushForGraphWorkflowEvent(config, info))
    .catch(() => {});
}
