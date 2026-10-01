import { randomUUID } from "node:crypto";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { BackgroundTasksLostInfo } from "@/lib/agent-backends/conversation";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { ConversationDurableEffects } from "../effects";

interface BackgroundTasksLostDependencies extends Pick<
  ConversationDurableEffects,
  "recordAgentNotice"
> {
  log: Logger;
}

interface BackgroundTasksLostInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  appendTranscriptEntry(
    conversationId: string,
    entry: TranscriptEntry,
  ): Promise<void>;
}

function backgroundTasksLostReminder(
  reason: string,
  taskCount: number,
  taskSummary: string,
): string {
  return `Your previous agent session ended (${reason}) while ${taskCount} background task(s) were still running: ${taskSummary}. Those processes were terminated with the session — their completion notifications will never arrive. Do not wait for them; check any output files on disk and re-run whatever is still needed.`;
}

/** Preserve the human notice and deliver the agent reminder through its inbox. */
export function createBackgroundTasksLostHandler(
  deps: BackgroundTasksLostDependencies,
  input: BackgroundTasksLostInput,
): (info: BackgroundTasksLostInfo) => Promise<void> {
  const scope = scopeRefFromStoreSessionName(input.sessionName);
  return async (info: BackgroundTasksLostInfo): Promise<void> => {
    const occurrenceId = randomUUID();
    const occurredAt = new Date().toISOString();
    const summary = info.tasks
      .map((t) => (t.description ? `${t.taskId} (${t.description})` : t.taskId))
      .join(", ");
    // These previews fit the normal briefing budget even when quoted source
    // delimiters expand into six-character JSON escapes. Full evidence stays
    // available in the inbox and the human transcript.
    const reasonPreview = info.reason.slice(0, 64);
    const tasksPreview = summary.slice(0, 96);
    const omitted = reasonPreview !== info.reason || tasksPreview !== summary;
    deps.log.warn("prompt.background_tasks_lost_surfaced", {
      ...scope,
      conversationId: input.conversationId,
      reason: reasonPreview,
      taskCount: info.tasks.length,
    });
    const transcript = input.appendTranscriptEntry(input.conversationId, {
      timestamp: occurredAt,
      type: "notice",
      role: "notice",
      content: [
        {
          type: "text",
          text: `${info.tasks.length} background task(s) were terminated with the agent session (${info.reason}): ${summary}. Their completion can no longer wake the agent.`,
        },
      ],
    });
    const reminder = backgroundTasksLostReminder(
      info.reason,
      info.tasks.length,
      summary,
    );
    const briefingSummary =
      backgroundTasksLostReminder(
        reasonPreview,
        info.tasks.length,
        tasksPreview,
      ) +
      (omitted
        ? " Details omitted; read the full notice in the conversation."
        : "");
    const notice = deps
      .recordAgentNotice({
        recipient: {
          projectPath: input.projectPath,
          conversationId: input.conversationId,
        },
        source: { kind: "conversation", id: input.conversationId },
        reason: "Background tasks lost",
        fact: {
          occurrenceId,
          eventKind: "background-tasks-lost",
          category: "outcome",
          sourceTitle: "Background tasks",
          summary: briefingSummary,
          sourceText: reminder,
          occurredAt,
          revision: null,
          outcome: "terminated",
          retrievalHandle: `cctl conversation read ${input.conversationId}`,
          actorConversationId: null,
        },
      })
      .catch((error: unknown) => {
        deps.log.warn("prompt.background_tasks_lost_persist_failed", {
          ...scope,
          conversationId: input.conversationId,
          error: getErrorMessage(error),
        });
      });
    await Promise.all([transcript, notice]);
  };
}
