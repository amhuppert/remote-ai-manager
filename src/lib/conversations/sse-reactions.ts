/**
 * Conversation-domain SSE reactions: how session- and project-scope
 * conversation events (status, transcript appends, list membership, queueing,
 * questions) map onto TanStack Query cache updates and attention toasts.
 * Registered against the shared `/api/events` EventSource by the client
 * assembly point (`NotificationListener`).
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { addSseListener, type SseEventTarget } from "@/lib/api/sse";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { selectLatestExplicitTurnAgentSettings } from "@/lib/conversations/last-turn-agent-settings";
import {
  askQuestionEventSchema,
  conversationArchivedEventSchema,
  conversationBackgroundActivityEventSchema,
  conversationCreatedEventSchema,
  conversationDeletedEventSchema,
  conversationOpenEventSchema,
  conversationProfileChangedEventSchema,
  conversationRenamedEventSchema,
  conversationStatusEventSchema,
  conversationUnreadEventSchema,
  conversationUsageUpdatedEventSchema,
  messageAppendedEventSchema,
  messageQueuedEventSchema,
  messageQueueUpdatedEventSchema,
  messageUpdatedEventSchema,
} from "@/lib/conversations/schemas";
import type {
  ConversationBackgroundActivity,
  ConversationState,
  PublicConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import {
  coalesceCursorContentDeltas,
  isCursorTranscriptEntryId,
} from "@/lib/agent-backends/cursor/content-deltas";
import type { ActiveConversationsResponse } from "@/lib/active-conversations/schemas";
import { renamedInActive } from "@/lib/conversations/mutations";
import { isTerminalQueuedMessageStatus } from "@/lib/conversations/message-queue-schemas";
import { createTurnEndArtifactInvalidator } from "@/lib/context-artifacts/sse-cache";
import { extractMarkdownFileRefs } from "@/lib/documents/markdown-file-refs";
import { markdownDocumentKeys } from "@/lib/documents/query-keys";
import type { BrowserNotificationInput } from "@/lib/notifications/browser-notification";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { projectConversationFocusHref } from "@/lib/project-conversations-client/routes";
import { withCreatedConversation } from "@/lib/sessions/cache-updates";
import { sessionKeys } from "@/lib/sessions/query-keys";
import type { PublicSessionState } from "@/lib/sessions/schemas";
import type {
  InputNeededItem,
  PromptErrorItem,
} from "@/stores/notification.store";

export interface ConversationSseReactionDeps {
  queryClient: QueryClient;
  enqueueInputToast(item: InputNeededItem): void;
  enqueuePromptErrorToast(item: PromptErrorItem): void;
  showBrowserNotification(input: BrowserNotificationInput): void;
  /**
   * Retire this client's pending row for a queue id the server has reported
   * terminal. Keyed by conversation and scope-invariant, so a project and a
   * session conversation reconcile through the same call.
   */
  settleOptimisticQueueEntry(conversationId: string, queueId: string): void;
}

/** Refetch the views that render a session conversation's live state. */
export function invalidateConversationViews(
  queryClient: QueryClient,
  projectName: string,
  sessionName: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: conversationKeys.active(),
  });
  void queryClient.invalidateQueries({
    queryKey: conversationKeys.list(projectName, sessionName),
  });
  void queryClient.invalidateQueries({
    queryKey: sessionKeys.detail(projectName, sessionName),
  });
}

/** Refetch the views that render a project conversation's activity. */
export function invalidateProjectConversationActivity(
  queryClient: QueryClient,
  projectName: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: projectConversationKeys.list(projectName),
  });
  void queryClient.invalidateQueries({
    queryKey: conversationKeys.active(),
  });
}

function appendMessageToQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
  entry: TranscriptMessage & { seq: number },
): void {
  queryClient.setQueryData(queryKey, (prev: unknown) => {
    // Only the messages fetch may CREATE a cache entry; appends only patch an
    // existing one (returning undefined makes setQueryData bail out). Seeding
    // from an append would cache a history-less fragment for a conversation
    // streaming in the background, and the fragment's fresh dataUpdatedAt
    // would suppress the full fetch when that conversation is next opened.
    if (!Array.isArray(prev)) return prev;
    // Mirror server-side `readConversationMessagesWithSeq` merging:
    // consecutive same-role entries collapse into one TranscriptMessage
    // so the MessageContent grouping logic sees them as a single turn.
    const lastIdx = prev.length - 1;
    const last = prev[lastIdx];
    if (
      last &&
      typeof last === "object" &&
      "role" in last &&
      "content" in last &&
      Array.isArray((last as { content: unknown }).content) &&
      (last as { role: unknown }).role === entry.role
    ) {
      const agentSettings = selectLatestExplicitTurnAgentSettings([
        last as object,
        entry,
      ]);
      const previous = last as TranscriptMessage & { seq: number };
      const content =
        isCursorTranscriptEntryId(previous.id) &&
        isCursorTranscriptEntryId(entry.id)
          ? coalesceCursorContentDeltas([...previous.content, ...entry.content])
          : [...previous.content, ...entry.content];
      const merged = {
        ...previous,
        ...(agentSettings ?? {}),
        content,
        seq: entry.seq,
      };
      return [...prev.slice(0, lastIdx), merged];
    }
    return [...prev, entry];
  });
}

function replaceMessageInQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
  replacement: Record<string, unknown> & { seq: number },
): void {
  queryClient.setQueryData(queryKey, (prev: unknown) => {
    if (!Array.isArray(prev)) return prev;
    return prev.map((m) =>
      m && typeof m === "object" && "seq" in m && m.seq === replacement.seq
        ? replacement
        : m,
    );
  });
}

// The cached list is the PUBLIC projection, so the patch is typed against that
// shape — `redactedProfileSnapshot` exists only there.
function updateProjectConversationListEntry(
  queryClient: QueryClient,
  projectName: string,
  conversationId: string,
  patch: Partial<PublicConversationState>,
): void {
  queryClient.setQueryData(
    projectConversationKeys.list(projectName),
    (prev: unknown) => {
      if (!Array.isArray(prev)) return prev;
      return prev.map((c) =>
        c && typeof c === "object" && "id" in c && c.id === conversationId
          ? { ...(c as PublicConversationState), ...patch }
          : c,
      );
    },
  );
}

function updateSessionConversationListEntry(
  queryClient: QueryClient,
  projectName: string,
  sessionName: string,
  conversationId: string,
  patch: Partial<ConversationState>,
): void {
  queryClient.setQueryData(
    conversationKeys.list(projectName, sessionName),
    (prev: unknown) => {
      if (!Array.isArray(prev)) return prev;
      return prev.map((conversation) =>
        conversation !== null &&
        typeof conversation === "object" &&
        "id" in conversation &&
        conversation.id === conversationId
          ? { ...conversation, ...patch }
          : conversation,
      );
    },
  );
}

function updateSessionConversationListStatus(
  queryClient: QueryClient,
  projectName: string,
  sessionName: string,
  conversationId: string,
  status: ConversationState["status"],
): void {
  queryClient.setQueryData(
    conversationKeys.list(projectName, sessionName),
    (prev: unknown) => {
      if (!Array.isArray(prev)) return prev;
      return prev.map((conversation) =>
        conversation !== null &&
        typeof conversation === "object" &&
        "id" in conversation &&
        conversation.id === conversationId
          ? { ...conversation, status }
          : conversation,
      );
    },
  );
}

/**
 * Whether two snapshots describe the same observation. `updatedAt` is stamped
 * once per snapshot at the source, so a redelivered event compares equal and
 * the cache write bails out — keeping the reaction idempotent without a deep
 * structural compare on every frame.
 */
function sameBackgroundActivity(
  a: ConversationBackgroundActivity | null,
  b: ConversationBackgroundActivity | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.updatedAt !== b.updatedAt) return false;
  if (a.tasks.length !== b.tasks.length) return false;
  return a.tasks.every((task, index) => {
    const other = b.tasks[index];
    return (
      other !== undefined &&
      task.taskId === other.taskId &&
      task.lastActivityAt === other.lastActivityAt
    );
  });
}

export function registerConversationSseReactions(
  es: SseEventTarget,
  deps: ConversationSseReactionDeps,
): void {
  const { queryClient } = deps;

  // Per-connection status memory: after a reconnect the first event per
  // conversation only seeds the tracker, so no spurious refetch fires.
  const invalidateArtifactsOnTurnEnd = createTurnEndArtifactInvalidator();

  addSseListener(
    es,
    "conversation-status",
    conversationStatusEventSchema,
    (data) => {
      invalidateArtifactsOnTurnEnd(queryClient, data);
      if (data.scope === "project") {
        invalidateProjectConversationActivity(queryClient, data.projectName);
        void queryClient.invalidateQueries({
          queryKey: projectConversationKeys.messages(
            data.projectName,
            data.conversationId,
          ),
        });
        const href = projectConversationFocusHref(
          data.projectName,
          data.conversationId,
        );
        if (data.status === "waiting_for_input") {
          deps.enqueueInputToast({
            scope: "project",
            projectName: data.projectName,
            conversationId: data.conversationId,
            displayContext: "main",
            href,
          });
        }
        if (data.error) {
          deps.enqueuePromptErrorToast({
            scope: "project",
            projectName: data.projectName,
            conversationId: data.conversationId,
            displayContext: "main",
            href,
            error: data.error,
          });
        }
        if (data.status === "awaiting" && !data.error) {
          deps.showBrowserNotification({
            title: "Project conversation ready",
            body: `${data.projectName} / ${data.conversationId}`,
            tag: `project-conversation-ready-${data.conversationId}`,
          });
        }
        return;
      }

      updateSessionConversationListStatus(
        queryClient,
        data.projectName,
        data.sessionName,
        data.conversationId,
        data.status,
      );
      invalidateConversationViews(
        queryClient,
        data.projectName,
        data.sessionName,
      );
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.messages(
          data.projectName,
          data.sessionName,
          data.conversationId,
        ),
      });

      if (data.status === "waiting_for_input") {
        // In-app toast
        deps.enqueueInputToast({
          projectName: data.projectName,
          sessionName: data.sessionName,
          conversationId: data.conversationId,
        });

        deps.showBrowserNotification({
          title: "Session needs input",
          body: `${data.projectName} / ${data.sessionName}`,
          tag: `input-${data.conversationId}`,
        });
      }

      if (data.error) {
        deps.enqueuePromptErrorToast({
          projectName: data.projectName,
          sessionName: data.sessionName,
          conversationId: data.conversationId,
          error: data.error,
        });
      }
    },
  );

  addSseListener(es, "message-appended", messageAppendedEventSchema, (d) => {
    const queryKey =
      d.scope === "project"
        ? projectConversationKeys.messages(d.projectName, d.conversationId)
        : conversationKeys.messages(
            d.projectName,
            d.sessionName,
            d.conversationId,
          );
    appendMessageToQuery(queryClient, queryKey, { ...d.message, seq: d.seq });
    if (
      d.scope === "session" &&
      extractMarkdownFileRefs(d.message.content).length > 0
    ) {
      void queryClient.invalidateQueries({
        queryKey: markdownDocumentKeys.list(d.projectName, d.sessionName),
      });
    }
  });

  addSseListener(es, "message-updated", messageUpdatedEventSchema, (d) => {
    const queryKey =
      d.scope === "project"
        ? projectConversationKeys.messages(d.projectName, d.conversationId)
        : conversationKeys.messages(
            d.projectName,
            d.sessionName,
            d.conversationId,
          );
    replaceMessageInQuery(queryClient, queryKey, { ...d.message, seq: d.seq });
  });

  addSseListener(
    es,
    "conversation-created",
    conversationCreatedEventSchema,
    (d) => {
      if (d.scope === "project") {
        queryClient.setQueryData(
          projectConversationKeys.list(d.projectName),
          (prev: unknown) =>
            Array.isArray(prev) ? [...prev, d.conversation] : [d.conversation],
        );
        invalidateProjectConversationActivity(queryClient, d.projectName);
        return;
      }
      queryClient.setQueryData(
        conversationKeys.list(d.projectName, d.sessionName),
        (prev: unknown) =>
          Array.isArray(prev) ? [...prev, d.conversation] : [d.conversation],
      );
      // The workspace resolves its active conversation from the session
      // detail, which stays fresh for 30s and never refetches on focus, so
      // the created row lands there directly rather than after a refetch.
      queryClient.setQueryData<PublicSessionState>(
        sessionKeys.detail(d.projectName, d.sessionName),
        (prev) => withCreatedConversation(prev, d.conversation),
      );
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  );

  addSseListener(
    es,
    "conversation-deleted",
    conversationDeletedEventSchema,
    (d) => {
      queryClient.setQueryData(
        conversationKeys.list(d.projectName, d.sessionName),
        (prev: unknown) => {
          if (!Array.isArray(prev)) return prev;
          return prev.filter(
            (conversation) =>
              !(
                conversation !== null &&
                typeof conversation === "object" &&
                "id" in conversation &&
                conversation.id === d.conversationId
              ),
          );
        },
      );
      queryClient.setQueriesData(
        { queryKey: conversationKeys.active() },
        (prev: ActiveConversationsResponse | undefined) => {
          if (!prev) return prev;
          return {
            ...prev,
            conversations: prev.conversations.filter(
              (conversation) => conversation.id !== d.conversationId,
            ),
          };
        },
      );
      invalidateConversationViews(queryClient, d.projectName, d.sessionName);
    },
  );

  // The profile chip reads the conversation's redacted snapshot, so a
  // pre-first-turn profile change lands the same way a rename does: patch the
  // cached row in place rather than refetch the list.
  addSseListener(
    es,
    "conversation-profile-changed",
    conversationProfileChangedEventSchema,
    (d) => {
      if (d.scope === "project") {
        updateProjectConversationListEntry(
          queryClient,
          d.projectName,
          d.conversationId,
          { redactedProfileSnapshot: d.redactedProfileSnapshot },
        );
        return;
      }
      queryClient.setQueryData(
        conversationKeys.list(d.projectName, d.sessionName),
        (prev: unknown) => {
          if (!Array.isArray(prev)) return prev;
          return prev.map((c) =>
            c && typeof c === "object" && "id" in c && c.id === d.conversationId
              ? { ...c, redactedProfileSnapshot: d.redactedProfileSnapshot }
              : c,
          );
        },
      );
    },
  );

  addSseListener(
    es,
    "conversation-renamed",
    conversationRenamedEventSchema,
    (d) => {
      if (d.scope === "project") {
        updateProjectConversationListEntry(
          queryClient,
          d.projectName,
          d.conversationId,
          { name: d.name },
        );
        invalidateProjectConversationActivity(queryClient, d.projectName);
        return;
      }
      queryClient.setQueryData(
        conversationKeys.list(d.projectName, d.sessionName),
        (prev: unknown) => {
          if (!Array.isArray(prev)) return prev;
          return prev.map((c) =>
            c && typeof c === "object" && "id" in c && c.id === d.conversationId
              ? { ...(c as ConversationState), name: d.name }
              : c,
          );
        },
      );
      // Background auto-naming is fire-and-forget and can land after the
      // turn's final conversation-status event, so this event is the only
      // signal that ever carries the name to the active rail and tab strip.
      queryClient.setQueriesData(
        { queryKey: conversationKeys.active() },
        (prev: ActiveConversationsResponse | undefined) =>
          renamedInActive(prev, d.conversationId, d.name),
      );
    },
  );

  addSseListener(
    es,
    "conversation-archived",
    conversationArchivedEventSchema,
    (d) => {
      if (d.scope === "project") {
        updateProjectConversationListEntry(
          queryClient,
          d.projectName,
          d.conversationId,
          { archived: d.archived },
        );
        invalidateProjectConversationActivity(queryClient, d.projectName);
        return;
      }
      queryClient.setQueryData(
        conversationKeys.list(d.projectName, d.sessionName),
        (prev: unknown) => {
          if (!Array.isArray(prev)) return prev;
          return prev.map((c) =>
            c && typeof c === "object" && "id" in c && c.id === d.conversationId
              ? { ...(c as ConversationState), archived: d.archived }
              : c,
          );
        },
      );
      invalidateConversationViews(queryClient, d.projectName, d.sessionName);
    },
  );

  addSseListener(es, "conversation-open", conversationOpenEventSchema, (d) => {
    updateProjectConversationListEntry(
      queryClient,
      d.projectName,
      d.conversationId,
      { open: d.open },
    );
    invalidateProjectConversationActivity(queryClient, d.projectName);
  });

  addSseListener(
    es,
    "conversation-unread",
    conversationUnreadEventSchema,
    (d) => {
      if (d.scope !== "project") return;
      updateProjectConversationListEntry(
        queryClient,
        d.projectName,
        d.conversationId,
        { unread: d.unread },
      );
      invalidateProjectConversationActivity(queryClient, d.projectName);
    },
  );

  // Inline data: the new total patches the cached rows, and the session
  // detail (which also carries totals) is refetched. Repeat delivery is
  // idempotent because the payload is the total, not a delta.
  addSseListener(
    es,
    "conversation-usage-updated",
    conversationUsageUpdatedEventSchema,
    (d) => {
      if (d.scope === "project") {
        updateProjectConversationListEntry(
          queryClient,
          d.projectName,
          d.conversationId,
          { totalCostUsd: d.totalCostUsd },
        );
        return;
      }
      updateSessionConversationListEntry(
        queryClient,
        d.projectName,
        d.sessionName,
        d.conversationId,
        { totalCostUsd: d.totalCostUsd },
      );
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(d.projectName, d.sessionName),
      });
    },
  );

  // Replace semantics: the event carries the conversation's whole (small)
  // background-task set, so the row field is overwritten rather than
  // invalidated. Never a refetch — this fires while the conversation is
  // otherwise idle, and a refetch per progress tick would be pure waste. Row
  // membership belongs to the other list events, so an unmatched id is a no-op.
  addSseListener(
    es,
    "conversation-background-activity",
    conversationBackgroundActivityEventSchema,
    (d) => {
      queryClient.setQueriesData(
        { queryKey: conversationKeys.active() },
        (prev: ActiveConversationsResponse | undefined) => {
          if (!prev || !Array.isArray(prev.conversations)) return prev;
          let changed = false;
          const conversations = prev.conversations.map((conversation) => {
            if (conversation.id !== d.conversationId) return conversation;
            if (
              sameBackgroundActivity(
                conversation.backgroundActivity,
                d.activity,
              )
            ) {
              return conversation;
            }
            changed = true;
            return { ...conversation, backgroundActivity: d.activity };
          });
          return changed ? { ...prev, conversations } : prev;
        },
      );
    },
  );

  addSseListener(es, "ask-question", askQuestionEventSchema, (d) => {
    if (d.scope === "project") {
      invalidateProjectConversationActivity(queryClient, d.projectName);
      void queryClient.invalidateQueries({
        queryKey: projectConversationKeys.messages(
          d.projectName,
          d.conversationId,
        ),
      });
      return;
    }
    invalidateConversationViews(queryClient, d.projectName, d.sessionName);
  });

  // Queue events refresh the cache that carries `ConversationState.pendingQueue`
  // for the addressed scope — the session-detail cache, or the project
  // conversation list the cockpit reads its tabs from. They must NOT touch the
  // messages cache: a queued message is not yet a transcript row (req 7.3), and
  // the transcript is written only by the message-appended handler once delivery
  // produces a real message.
  addSseListener(es, "message-queued", messageQueuedEventSchema, (d) => {
    if (d.scope === "project") {
      invalidateProjectConversationActivity(queryClient, d.projectName);
      return;
    }
    invalidateConversationViews(queryClient, d.projectName, d.sessionName);
  });

  addSseListener(
    es,
    "message-queue-updated",
    messageQueueUpdatedEventSchema,
    (d) => {
      // A terminal row is the end of this client's pending display for it: the
      // durable row leaves the active queue in the same write, so nothing else
      // would ever retire the optimistic stand-in and the delivered message
      // would render twice — once as its transcript row, once as still-queued.
      if (isTerminalQueuedMessageStatus(d.message.status)) {
        deps.settleOptimisticQueueEntry(d.conversationId, d.message.id);
      }
      if (d.scope === "project") {
        invalidateProjectConversationActivity(queryClient, d.projectName);
        return;
      }
      invalidateConversationViews(queryClient, d.projectName, d.sessionName);
    },
  );
}
