/**
 * Pre-turn step: pending agent notices.
 *
 * Hides the exactly-once delivery contract for messages recorded while the
 * conversation had no live backend session (e.g. background tasks lost with a
 * dead session): notices are injected into the NEXT runtime's session
 * instructions and drained only after that runtime exists, removing exactly
 * the entries this runtime consumed so a notice recorded in between survives
 * for the following runtime. Also owns recording the notices (the
 * background-tasks-lost handler) with the persisted-blob bound.
 */

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { BackgroundTasksLostInfo } from "@/lib/agent-backends/conversation";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";

const logger = createLogger("conversation-actor");

/**
 * Cap for `pendingAgentNotices` growth between drains (the persisted-blob
 * bounds gate requires every persisted collection to be bounded). Repeated
 * losses with no intervening prompt keep only the most recent entries.
 */
export const MAX_PENDING_AGENT_NOTICES = 10;

export interface NoticesDrainDeps {
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void,
  ): Promise<void>;
}

export interface ConversationIdentity {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

/**
 * Record a durable agent-facing notice for the conversation's NEXT runtime,
 * bounded by the persisted-blob cap. This is the one append path for
 * `pendingAgentNotices`: every producer (background-task loss, spec review
 * feedback) shares the cap and the conversation-store mutation.
 */
export async function appendPendingAgentNotice(
  deps: Pick<NoticesDrainDeps, "mutateConversation">,
  identity: ConversationIdentity,
  notice: string,
  label: string,
): Promise<void> {
  await deps.mutateConversation(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
    label,
    (conversation) => {
      conversation.pendingAgentNotices = [
        ...conversation.pendingAgentNotices,
        notice,
      ].slice(-MAX_PENDING_AGENT_NOTICES);
    },
  );
}

/** Read the notices pending for injection into a new runtime's instructions. */
export async function readPendingAgentNotices(
  deps: Pick<NoticesDrainDeps, "getConversation">,
  identity: ConversationIdentity,
): Promise<string[]> {
  const conversation = await deps.getConversation(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
  );
  return conversation?.pendingAgentNotices ?? [];
}

/** Session-instructions section listing pending notices; null when none. */
export function buildPendingNoticesInstruction(
  pendingAgentNotices: readonly string[],
): string | null {
  if (pendingAgentNotices.length === 0) return null;
  return [
    "## Session notices",
    "The following was recorded for this conversation while no agent session was live. Act on it before trusting prior assumptions:",
    "",
    ...pendingAgentNotices.map((n) => `- ${n}`),
  ].join("\n");
}

/**
 * Drain exactly the notices this runtime consumed. A notice recorded between
 * the read and this write (e.g. the freshly-created session dying immediately
 * with tasks in flight) survives for the next runtime instead of being wiped.
 */
export async function drainConsumedAgentNotices(
  deps: Pick<NoticesDrainDeps, "mutateConversation">,
  identity: ConversationIdentity,
  consumed: readonly string[],
): Promise<void> {
  if (consumed.length === 0) return;
  await deps.mutateConversation(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
    "drain_agent_notices",
    (conversation) => {
      const remaining = [...conversation.pendingAgentNotices];
      for (const notice of consumed) {
        const idx = remaining.indexOf(notice);
        if (idx !== -1) remaining.splice(idx, 1);
      }
      conversation.pendingAgentNotices = remaining;
    },
  );
  logger.info("prompt.agent_notices_drained", {
    ...scopeRefFromStoreSessionName(identity.sessionName),
    conversationId: identity.conversationId,
    noticeCount: consumed.length,
  });
}

/**
 * Surface background tasks that die with the session: a visible notice row
 * for the user, and (session conversations only — the project sentinel cannot
 * address the session aggregate) a durable agent notice drained into the NEXT
 * runtime's instructions, so the agent learns its watchers are gone instead
 * of waiting for a wake that can never come.
 */
export function createBackgroundTasksLostHandler(
  deps: Pick<NoticesDrainDeps, "mutateConversation">,
  input: ConversationIdentity & {
    isProjectConversation: boolean;
    appendTranscriptEntry(
      conversationId: string,
      entry: TranscriptEntry,
    ): Promise<void>;
  },
): (info: BackgroundTasksLostInfo) => Promise<void> {
  return async (info: BackgroundTasksLostInfo): Promise<void> => {
    const summary = info.tasks
      .map((t) => (t.description ? `${t.taskId} (${t.description})` : t.taskId))
      .join(", ");
    logger.warn("prompt.background_tasks_lost_surfaced", {
      ...scopeRefFromStoreSessionName(input.sessionName),
      conversationId: input.conversationId,
      reason: info.reason,
      taskCount: info.tasks.length,
    });
    const transcript = input.appendTranscriptEntry(input.conversationId, {
      timestamp: new Date().toISOString(),
      type: "notice",
      role: "notice",
      content: [
        {
          type: "text",
          text: `${info.tasks.length} background task(s) were terminated with the agent session (${info.reason}): ${summary}. Their completion can no longer wake the agent.`,
        },
      ],
    });
    if (input.isProjectConversation) {
      await transcript;
      return;
    }
    const reminder = `Your previous agent session ended (${info.reason}) while ${info.tasks.length} background task(s) were still running: ${summary}. Those processes were terminated with the session — their completion notifications will never arrive. Do not wait for them; check any output files on disk and re-run whatever is still needed.`;
    const notice = appendPendingAgentNotice(
      deps,
      {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
      },
      reminder,
      "background_tasks_lost",
    ).catch((err) => {
      logger.warn("prompt.background_tasks_lost_persist_failed", {
        ...scopeRefFromStoreSessionName(input.sessionName),
        conversationId: input.conversationId,
        error: getErrorMessage(err),
      });
    });
    await Promise.all([transcript, notice]);
  };
}
