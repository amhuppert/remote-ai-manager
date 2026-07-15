/**
 * Conversation-domain SSE reactions: how session- and project-scope
 * conversation events (status, transcript appends, list membership, queueing,
 * questions) map onto TanStack Query cache updates and attention toasts.
 * Registered against the shared `/api/events` EventSource by the client
 * assembly point (`NotificationListener`).
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import { conversationKeys } from "@/lib/conversations/query-keys";
import {
  askQuestionEventSchema,
  conversationArchivedEventSchema,
  conversationCreatedEventSchema,
  conversationOpenEventSchema,
  conversationRenamedEventSchema,
  conversationStatusEventSchema,
  conversationUnreadEventSchema,
  messageAppendedEventSchema,
  messageQueuedEventSchema,
  messageQueueUpdatedEventSchema,
  messageUpdatedEventSchema,
} from "@/lib/conversations/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { createTurnEndArtifactInvalidator } from "@/lib/context-artifacts/sse-cache";
import { extractMarkdownFileRefs } from "@/lib/documents/markdown-file-refs";
import { markdownDocumentKeys } from "@/lib/documents/query-keys";
import type { BrowserNotificationInput } from "@/lib/notifications/browser-notification";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { projectConversationFocusHref } from "@/lib/project-conversations-client/routes";
import { sessionKeys } from "@/lib/sessions/query-keys";
import type {
  InputNeededItem,
  PromptErrorItem,
} from "@/stores/notification.store";

export interface ConversationSseReactionDeps {
  queryClient: QueryClient;
  enqueueInputToast(item: InputNeededItem): void;
  enqueuePromptErrorToast(item: PromptErrorItem): void;
  showBrowserNotification(input: BrowserNotificationInput): void;
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
  entry: Record<string, unknown> & {
    role: unknown;
    content: unknown[];
    seq: number;
  },
): void {
  queryClient.setQueryData(queryKey, (prev: unknown) => {
    if (!Array.isArray(prev)) return [entry];
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
      const merged = {
        ...(last as object),
        content: [
          ...(last as { content: unknown[] }).content,
          ...entry.content,
        ],
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

function updateProjectConversationListEntry(
  queryClient: QueryClient,
  projectName: string,
  conversationId: string,
  patch: Partial<ConversationState>,
): void {
  queryClient.setQueryData(
    projectConversationKeys.list(projectName),
    (prev: unknown) => {
      if (!Array.isArray(prev)) return prev;
      return prev.map((c) =>
        c && typeof c === "object" && "id" in c && c.id === conversationId
          ? { ...(c as ConversationState), ...patch }
          : c,
      );
    },
  );
}

export function registerConversationSseReactions(
  es: EventSource,
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
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
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

  addSseListener(es, "message-queued", messageQueuedEventSchema, (d) => {
    invalidateConversationViews(queryClient, d.projectName, d.sessionName);
    // Queue pending events refresh ConversationState.pendingQueue via the
    // session-detail cache; they must NOT touch conversationKeys.messages —
    // a queued message is not yet a transcript row (req 7.3). The transcript
    // cache is written only by the message-appended handler once delivery
    // produces a real message.
  });

  addSseListener(
    es,
    "message-queue-updated",
    messageQueueUpdatedEventSchema,
    (d) => {
      invalidateConversationViews(queryClient, d.projectName, d.sessionName);
    },
  );
}
