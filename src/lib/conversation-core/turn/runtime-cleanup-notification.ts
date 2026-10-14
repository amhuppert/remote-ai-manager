import {
  conversationTargetStoreSessionName,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import type { AppendNoticeInput } from "@/lib/prompt/transcript";
import type {
  AgentNotificationRequest,
  AgentNotificationOutcome,
} from "@/lib/push-notification/dispatcher";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";

export interface RuntimeCleanupNotificationInput {
  target: ConversationTarget;
  worktreePath: string;
}

export interface RuntimeCleanupNotificationDeps {
  appendNotice(input: AppendNoticeInput): Promise<void>;
  push(input: AgentNotificationRequest): Promise<AgentNotificationOutcome>;
  log: Logger;
}

export async function notifyRuntimeCleanup(
  input: RuntimeCleanupNotificationInput,
  deps: RuntimeCleanupNotificationDeps,
): Promise<void> {
  const text = `Process cleanup could not be verified for conversation ${input.target.conversationId} in ${input.worktreePath}. Inspect and stop surviving commands before resuming. This conversation remains blocked in this CC process; that protection ends at restart.`;
  const effects = [
    async () =>
      deps.appendNotice({
        conversationId: input.target.conversationId,
        projectName: input.target.projectName,
        storeSessionName: conversationTargetStoreSessionName(input.target),
        text,
      }),
    async () => {
      const outcome = await deps.push({
        target: input.target,
        title: "Process cleanup needs review",
        message: text,
        urgency: "attention",
      });
      if (!outcome.delivered)
        deps.log.warn("conversation.cleanup_push_unavailable", {
          ...input.target,
          reason: outcome.reason,
        });
    },
  ];
  const results = await Promise.allSettled(effects.map((effect) => effect()));
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected")
      deps.log.error("conversation.cleanup_notification_failed", {
        ...input.target,
        channel: index === 0 ? "notice" : "push",
        error: getErrorMessage(result.reason),
      });
  }
}
