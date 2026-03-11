import { sendPushNotification, type PushEvent } from "./push-notification";
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
  if (info.status !== "waiting_for_input") return;

  const event: PushEvent = {
    trigger: "waiting-for-input",
    title: "Waiting for input",
    message: `Session ${info.sessionName} needs your input`,
    projectName: info.projectName,
    sessionName: info.sessionName,
  };

  await sendPushNotification(config, event);
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
  if (info.workflowStatus === "completed") {
    await sendPushNotification(config, {
      trigger: "workflow-completed",
      title: "Workflow completed",
      message: `Ralph Loop workflow completed for session ${info.sessionName}`,
      projectName: info.projectName,
      sessionName: info.sessionName,
    });
  } else if (info.workflowStatus === "halted") {
    await sendPushNotification(config, {
      trigger: "workflow-halted",
      title: "Workflow halted",
      message: `Ralph Loop workflow halted for session ${info.sessionName}`,
      projectName: info.projectName,
      sessionName: info.sessionName,
    });
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
