import type { Logger } from "@/lib/logging";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import type { ConversationDurableEffects } from "@/lib/conversation-core/turn/effects";
import type { ConversationIdentity } from "@/lib/conversation-core/conversation-record";
import type { CustodyLossReason } from "@/lib/conversation-core/custody";
import { CUSTODY_BOUND_MS } from "@/lib/conversation-core/executor";
import { getErrorMessage } from "@/lib/shared/errors";

export interface CustodyLossDeps extends Pick<
  ConversationDurableEffects,
  "recordRuntimeLossNotice"
> {
  /** Appends the person's notice to the conversation's transcript, once by its id. */
  appendTranscriptEntryOnce(
    identity: ConversationIdentity,
    entry: TranscriptEntry & { id: string },
  ): Promise<void>;
  log: Pick<Logger, "warn">;
}

/** Why custody's work stopped, as both the person and the agent read it. */
const WHY: Record<CustodyLossReason, string> = {
  stopped: "it was stopped",
  lost: "the agent's process ended",
  timed_out: `it ran past the ${CUSTODY_BOUND_MS / 60_000} minutes work may run between turns`,
  interrupted: "the server stopped",
  reconfigured:
    "the conversation's configuration changed and its next turn needed a fresh agent process",
  merging: "the session is being merged",
  merged: "the session has been merged",
  archived: "the conversation was archived",
  deleted: "the conversation is being deleted",
};

/**
 * Records that work a custody held between turns was cut short (design C5b
 * §6): a notice the person reads in the transcript, and the runtime loss the
 * conversation's next turn hears in its `<runtime_recovery>`. Keyed by `key`
 * (the custody attempt), so recording it again changes nothing. When the
 * runtime's processes could not be confirmed stopped, only the person is told
 * so: the agent's loss claims a termination, which waits until it is known.
 * Throws when the agent's loss could not be recorded.
 */
export function createCustodyLossRecorder(
  deps: CustodyLossDeps,
): (input: {
  identity: ConversationIdentity;
  key: string;
  end: CustodyLossReason;
  collected: boolean;
}) => Promise<void> {
  return async ({ identity, key, end, collected }) => {
    const { conversationId } = identity;
    const why = WHY[end];
    const occurredAt = new Date().toISOString();
    if (!collected) {
      await deps
        .appendTranscriptEntryOnce(identity, {
          id: `custody-loss-unconfirmed:${key}`,
          timestamp: occurredAt,
          type: "notice",
          role: "notice",
          content: [
            {
              type: "text",
              text: `Background work the agent left running was stopped because ${why}, but its processes could not be confirmed to have exited. Nothing more runs in this conversation until they are collected; restarting the server collects them.`,
            },
          ],
        })
        .catch((error: unknown) =>
          deps.log.warn("conversation_core.custody_loss_notice_failed", {
            conversationId,
            key,
            error: getErrorMessage(error),
          }),
        );
      return;
    }
    const occurrenceId = `custody-loss:${key}`;
    const reminder = `Background work your previous turn left running was cut short because ${why}: the processes it started were terminated, and any continuation or reply it still owed will not arrive. Do not wait for it; check any output files on disk and re-run whatever is still needed.`;
    const transcript = deps.appendTranscriptEntryOnce(identity, {
      id: occurrenceId,
      timestamp: occurredAt,
      type: "notice",
      role: "notice",
      content: [
        {
          type: "text",
          text: `Background work the agent left running was cut short because ${why}. Anything it still owed will not arrive.`,
        },
      ],
    });
    // The runtime-loss notice is the one operational fact a turn's input admits: own conversation, terminated.
    const notice = deps.recordRuntimeLossNotice({
      recipient: { projectPath: identity.projectPath, conversationId },
      source: { kind: "conversation", id: conversationId },
      reason: "Background work lost",
      fact: {
        occurrenceId,
        eventKind: "background-tasks-lost",
        category: "outcome",
        sourceTitle: "Background work",
        summary: reminder,
        sourceText: reminder,
        occurredAt,
        revision: null,
        outcome: "terminated",
        retrievalHandle: `cctl conversation read ${conversationId}`,
        actorConversationId: null,
      },
    });
    const [appended, recorded] = await Promise.allSettled([transcript, notice]);
    if (appended.status === "rejected")
      deps.log.warn("conversation_core.custody_loss_notice_failed", {
        conversationId,
        key,
        error: getErrorMessage(appended.reason),
      });
    // The agent's notice is the one that must not be lost: the caller keeps custody admitted to record it again.
    if (recorded.status === "rejected") throw recorded.reason;
  };
}
