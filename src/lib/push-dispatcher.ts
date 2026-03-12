import { sendPushNotification, type PushEvent } from "./push-notification";
import { assertNever } from "./assert-never";
import { createLogger } from "./logging";
import { readConfig } from "./config";
import { getGlobalValue, setGlobalValue } from "./global-singleton";
import type {
  PushNotificationConfig,
  Notification,
  ConversationStatus,
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
}

export async function pushForConversationStatus(
  config: PushNotificationConfig | undefined,
  info: ConversationStatusInfo,
): Promise<void> {
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
    case "new":
    case "running":
    case "awaiting":
      // No push notification for these statuses
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
    case "aborted":
    case "planning":
    case "running":
    case "paused":
      // No push notification for intermediate/abort statuses
      return;
    default:
      assertNever(info.workflowStatus);
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
