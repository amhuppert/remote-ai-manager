import {
  sendPushNotification,
  sendAgentNotification,
  type AgentNotificationTarget,
  type PushEvent,
} from "../notifications/push";
import { assertNever } from "../shared/assert-never";
import { createLogger } from "../logging";
import { readConfig } from "../config/loader";
import { getGlobalValue, setGlobalValue } from "../shared/global-singleton";
import type {
  ConversationStatus,
  ConversationRole,
} from "@/lib/conversations/schemas";
import type {
  PushNotificationConfig,
  Notification,
} from "@/lib/notifications/schemas";
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
// Agent-initiated push (the `cctl notify` / send_notification path)
// ============================================================

export interface AgentNotificationRequest {
  target: AgentNotificationTarget;
  title: string;
  message: string;
  /** info → default "robot" tag; attention → "warning" tag. */
  urgency?: "info" | "attention";
}

export type AgentNotificationOutcome =
  | { delivered: true }
  | { delivered: false; reason: string };

export interface AgentNotificationDispatchDeps {
  readPushConfig(): Promise<PushNotificationConfig | undefined>;
  sendAgentNotification(
    config: PushNotificationConfig,
    title: string,
    message: string,
    tags: string,
    target: AgentNotificationTarget,
  ): Promise<void>;
}

const defaultAgentNotificationDispatchDeps: AgentNotificationDispatchDeps = {
  readPushConfig: getPushConfig,
  sendAgentNotification,
};

const URGENCY_TAG: Record<
  NonNullable<AgentNotificationRequest["urgency"]>,
  string
> = {
  info: "robot",
  attention: "warning",
};

/**
 * Deliver an agent-initiated push. Unlike the fire-and-forget `dispatchPushFor*`
 * helpers this is awaited and returns an outcome, so the notify endpoint can
 * report an unconfigured-push precondition back to the caller. It bypasses the
 * per-trigger config gate (the agent's explicit intent is the gate) but still
 * requires push to be enabled with a topic — matching the former
 * send_notification tool.
 */
export async function dispatchAgentNotification(
  request: AgentNotificationRequest,
  deps: AgentNotificationDispatchDeps = defaultAgentNotificationDispatchDeps,
): Promise<AgentNotificationOutcome> {
  const config = await deps.readPushConfig();
  if (!config || config.enabled !== true || config.topic.trim().length === 0) {
    return {
      delivered: false,
      reason: "Push notifications are not configured",
    };
  }

  const tag = URGENCY_TAG[request.urgency ?? "info"];
  await deps.sendAgentNotification(
    config,
    request.title,
    request.message,
    tag,
    request.target,
  );
  return { delivered: true };
}

// ============================================================
// Push for DB notifications (job completions)
// ============================================================

export async function pushForNotification(
  config: PushNotificationConfig | undefined,
  notification: Notification,
): Promise<void> {
  if (!config) return;

  const event = pushEventFromNotification(notification);

  await sendPushNotification(config, event);
}

function pushEventFromNotification(notification: Notification): PushEvent {
  switch (notification.source) {
    case "job":
      return {
        trigger: "job-completed",
        title: notification.title,
        message: notification.message,
        projectName: notification.projectName,
        sessionName: notification.sessionName,
      };
    case "project-conversation":
      return {
        trigger: projectConversationPushTrigger(notification.type),
        title: notification.title,
        message: notification.message,
        projectName: notification.projectName,
        contextName:
          notification.conversationName?.trim() ||
          `Conversation ${notification.conversationId}`,
      };
    case "spec":
      return {
        trigger: specPushTrigger(notification.type),
        title: notification.title,
        message: notification.message,
        projectName: notification.projectName,
        sessionName: notification.sessionName ?? undefined,
        contextName: `${notification.specName} · ${notification.deepLinkId}`,
      };
    default:
      assertNever(notification);
  }
}

// Waiver-request and attention-resolution rows reuse the existing
// user-configurable spec approval triggers rather than adding config keys.
function specPushTrigger(
  type: Extract<Notification, { source: "spec" }>["type"],
): PushEvent["trigger"] {
  switch (type) {
    case "spec-approval-requested":
    case "spec-waiver-requested":
      return "spec-approval-requested";
    case "spec-approval-granted":
    case "spec-attention-resolved":
      return "spec-approval-granted";
    case "spec-policy-admitted":
      return "spec-policy-admitted";
    default:
      assertNever(type);
  }
}

function projectConversationPushTrigger(
  type: Extract<Notification, { source: "project-conversation" }>["type"],
): PushEvent["trigger"] {
  switch (type) {
    case "project-conversation-ready":
      return "conversation-idle";
    case "project-conversation-input-needed":
      return "waiting-for-input";
    case "project-conversation-failed":
      return "workflow-halted";
    default:
      assertNever(type);
  }
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
    }
  | {
      kind: "approval-pending";
      projectName: string;
      sessionName: string;
      contextTitle: string;
    }
  | {
      kind: "plan-repair";
      projectName: string;
      sessionName: string;
      contextTitle?: string;
      planRepairOutcome?:
        | "repaired"
        | "declined"
        | "failed"
        | "superseded"
        | "exhausted";
      planRepairAttempt?: number;
      planRepairDiagnosis?: string | null;
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
    case "approval-pending":
      await sendPushNotification(config, {
        trigger: "waiting-for-input",
        title: "Approval required",
        message: `Context "${info.contextTitle}" passed validators — review to continue`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "plan-repair": {
      const attempt =
        info.planRepairAttempt !== undefined
          ? ` (attempt ${info.planRepairAttempt})`
          : "";
      const diagnosis = info.planRepairDiagnosis?.split("\n")[0] ?? "";
      switch (info.planRepairOutcome) {
        case "repaired":
          await sendPushNotification(config, {
            trigger: "plan-repaired",
            title: "Plan repair applied — resumed",
            message: `Context "${info.contextTitle}"${attempt}: ${diagnosis}`,
            projectName: info.projectName,
            sessionName: info.sessionName,
          });
          return;
        case "declined":
        case "failed":
        case "exhausted":
          await sendPushNotification(config, {
            trigger: "plan-repair-declined",
            title:
              info.planRepairOutcome === "exhausted"
                ? "Plan repair exhausted — human review needed"
                : "Plan repair declined — still halted",
            message: `Context "${info.contextTitle}"${attempt}${diagnosis ? `: ${diagnosis}` : ""}`,
            projectName: info.projectName,
            sessionName: info.sessionName,
          });
          return;
        default:
          // Superseded rounds are audit-only and never reach the dispatcher;
          // an unknown outcome is not worth a push.
          return;
      }
    }
    default:
      assertNever(info);
  }
}

// ============================================================
// Push for collaboration events
// ============================================================

export type CollaborationPushInfo =
  | {
      kind: "paused-for-user-input";
      projectName: string;
      sessionName: string;
      workflowId: string;
    }
  | {
      kind: "completed-converged";
      projectName: string;
      sessionName: string;
      workflowId: string;
    }
  | {
      kind: "completed-final";
      projectName: string;
      sessionName: string;
      workflowId: string;
    }
  | {
      kind: "completed-unresolved";
      projectName: string;
      sessionName: string;
      workflowId: string;
      reason: string;
    }
  | {
      kind: "failed";
      projectName: string;
      sessionName: string;
      workflowId: string;
      agent: string;
    };

export async function pushForCollaborationEvent(
  config: PushNotificationConfig | undefined,
  info: CollaborationPushInfo,
): Promise<void> {
  if (!config) return;

  switch (info.kind) {
    case "paused-for-user-input":
      await sendPushNotification(config, {
        trigger: "waiting-for-input",
        title: "Collab paused — Alex's input needed",
        message: `Collaboration paused on session ${info.sessionName}`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "completed-converged":
      await sendPushNotification(config, {
        trigger: "workflow-completed",
        title: "Collab converged — merged report ready",
        message: `Collaboration converged on session ${info.sessionName}`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "completed-final":
      await sendPushNotification(config, {
        trigger: "workflow-completed",
        title: "Collab completed — final answer ready",
        message: `Collaboration completed on session ${info.sessionName}`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "completed-unresolved":
      await sendPushNotification(config, {
        trigger: "workflow-halted",
        title: "Collab ended unresolved — latest reports are linked",
        message: `Collaboration ended unresolved on session ${info.sessionName}`,
        projectName: info.projectName,
        sessionName: info.sessionName,
      });
      return;
    case "failed":
      await sendPushNotification(config, {
        trigger: "workflow-halted",
        title: "Collab failed — see latest reports",
        message: `Collaboration failed on session ${info.sessionName} (${info.agent})`,
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

export function dispatchPushForGraphWorkflowEvent(
  info: GraphWorkflowPushInfo,
): void {
  getPushConfig()
    .then((config) => pushForGraphWorkflowEvent(config, info))
    .catch(() => {});
}

export function dispatchPushForCollaborationEvent(
  info: CollaborationPushInfo,
): void {
  getPushConfig()
    .then((config) => pushForCollaborationEvent(config, info))
    .catch(() => {});
}
