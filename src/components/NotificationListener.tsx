"use client";

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { debugLogKeys } from "@/lib/debug-log/query-keys";
import { mcpConfigKeys, mcpToolsKeys } from "@/lib/mcp/query-keys";
import { collaborationKeys } from "@/lib/workflows/query-keys";
import { devServerKeys } from "@/lib/dev-server/query-keys";
import { notificationKeys } from "@/lib/notifications/query-keys";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { projectConversationFocusHref } from "@/lib/project-conversations-client/routes";
import { projectKeys } from "@/lib/projects/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { computeAgentCapabilityInvalidations } from "@/lib/agent-capabilities/sse-invalidation";
import { computeMcpConfigInvalidations } from "@/lib/mcp/sse-invalidation";
import { reconnectReconcile } from "@/lib/events/sse-reconnect";
import { backgroundJobSchema, jobStatusEventSchema } from "@/lib/jobs/schemas";
import { z } from "zod";
import {
  notificationCreatedEventSchema,
  notificationUpdatedEventSchema,
} from "@/lib/notifications/schemas";
import { scopedStatusEventSchema } from "@/lib/api/sse-events";
import {
  conversationStatusEventSchema,
  messageAppendedEventSchema,
  messageUpdatedEventSchema,
  conversationCreatedEventSchema,
  conversationRenamedEventSchema,
  conversationArchivedEventSchema,
  conversationUnreadEventSchema,
  conversationOpenEventSchema,
  askQuestionEventSchema,
  messageQueuedEventSchema,
  messageQueueUpdatedEventSchema,
} from "@/lib/conversations/schemas";
import {
  debugLogReceivedEventSchema,
  debugModeStatusEventSchema,
} from "@/lib/debug-log/schemas";
import {
  mcpConfigUpdatedEventSchema,
  mcpToolsUpdatedEventSchema,
} from "@/lib/mcp/schemas";
import {
  agentCapabilitiesDiscoveryUpdatedEventSchema,
  agentCapabilitiesUpdatedEventSchema,
} from "@/lib/agent-capabilities/schemas";
import {
  graphWorkflowStatusEventSchema,
  graphWorkflowContextStatusEventSchema,
  graphWorkflowTaskStatusEventSchema,
  graphWorkflowValidationResultEventSchema,
  graphWorkflowCircuitBreakerEventSchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
  graphWorkflowApprovalPendingEventSchema,
  graphWorkflowApprovalResolvedEventSchema,
} from "@/lib/workflows/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  useAddOrUpdateJob,
  useReconcileJobs,
  useEnqueueToast,
  useEnqueueInputToast,
  useEnqueuePromptErrorToast,
} from "@/stores/notification.store";
export default function NotificationListener(): null {
  const queryClient = useQueryClient();
  const addOrUpdateJob = useAddOrUpdateJob();
  const reconcileJobs = useReconcileJobs();
  const enqueueToast = useEnqueueToast();
  const enqueueInputToast = useEnqueueInputToast();
  const enqueuePromptErrorToast = useEnqueuePromptErrorToast();
  const actionsRef = useRef({
    addOrUpdateJob,
    reconcileJobs,
    enqueueToast,
    enqueueInputToast,
    enqueuePromptErrorToast,
  });
  // eslint-disable-next-line react-hooks/refs -- event handlers read this after render without reconnecting the SSE effect.
  actionsRef.current = {
    addOrUpdateJob,
    reconcileJobs,
    enqueueToast,
    enqueueInputToast,
    enqueuePromptErrorToast,
  };
  const hadErrorRef = useRef(false);

  useEffect(() => {
    const es = new EventSource("/api/events");

    // SSE per-message instrumentation. The broadcaster embeds `_sentAt` in
    // every event envelope so we can compute transportMs (sentAt→received
    // wall-clock delta — clock-skew sensitive) and handlerMs (cache
    // invalidation / store mutation cost) per message. Wrapped at the
    // EventSource layer so every listener picks it up without modification;
    // Zod schemas drop the unknown `_sentAt` field by default.
    const SSE_LOG_HANDLER_MS_THRESHOLD = 1;
    const SSE_LOG_TRANSPORT_MS_THRESHOLD = 50;
    const originalAdd = es.addEventListener.bind(es);
    const instrumentedAdd = ((
      type: string,
      listener: (event: MessageEvent) => void,
    ) => {
      const wrapped = (event: MessageEvent) => {
        let sentAt: number | null = null;
        try {
          const peek = JSON.parse(event.data) as { _sentAt?: unknown };
          if (typeof peek._sentAt === "number") sentAt = peek._sentAt;
        } catch {
          // best-effort
        }
        const start = performance.now();
        try {
          listener(event);
        } finally {
          const handlerMs = Math.round(performance.now() - start);
          const transportMs = sentAt != null ? Date.now() - sentAt : null;
          if (
            handlerMs >= SSE_LOG_HANDLER_MS_THRESHOLD ||
            (transportMs != null &&
              transportMs >= SSE_LOG_TRANSPORT_MS_THRESHOLD)
          ) {
            console.debug("sse.message", {
              eventType: type,
              transportMs,
              handlerMs,
            });
          }
        }
      };
      originalAdd(type, wrapped as EventListener);
    }) as typeof es.addEventListener;
    es.addEventListener = instrumentedAdd;

    const invalidateAgentCapabilityViews = (data: {
      level: "global" | "project" | "session" | "conversation";
      projectName?: string;
      conversationScope?: "session" | "project";
      sessionName?: string;
      conversationId?: string;
      cascadeKind:
        | "claude-skills"
        | "claude-plugins"
        | "claude-agents"
        | "codex-skills"
        | "codex-plugins";
    }) => {
      const invalidations = computeAgentCapabilityInvalidations({
        level: data.level,
        cascadeKind: data.cascadeKind,
        ...(data.projectName !== undefined && {
          projectName: data.projectName,
        }),
        ...(data.conversationScope !== undefined && {
          conversationScope: data.conversationScope,
        }),
        ...(data.sessionName !== undefined && {
          sessionName: data.sessionName,
        }),
        ...(data.conversationId !== undefined && {
          conversationId: data.conversationId,
        }),
      });
      for (const matcher of invalidations) {
        void queryClient.invalidateQueries({ queryKey: matcher.queryKey });
      }
    };

    const appendMessageToQuery = (
      queryKey: QueryKey,
      entry: Record<string, unknown> & {
        role: unknown;
        content: unknown[];
        seq: number;
      },
    ) => {
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
    };

    const replaceMessageInQuery = (
      queryKey: QueryKey,
      replacement: Record<string, unknown> & { seq: number },
    ) => {
      queryClient.setQueryData(queryKey, (prev: unknown) => {
        if (!Array.isArray(prev)) return prev;
        return prev.map((m) =>
          m && typeof m === "object" && "seq" in m && m.seq === replacement.seq
            ? replacement
            : m,
        );
      });
    };

    const invalidateProjectConversationListViews = (projectName: string) => {
      void queryClient.invalidateQueries({
        queryKey: projectConversationKeys.list(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: projectConversationKeys.openCount(projectName),
      });
    };

    const invalidateProjectConversationActivity = (projectName: string) => {
      invalidateProjectConversationListViews(projectName);
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    };

    const updateProjectConversationListEntry = (
      projectName: string,
      conversationId: string,
      patch: Partial<ConversationState>,
    ) => {
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
    };

    const invalidateConversationViews = (
      projectName: string,
      sessionName: string,
    ) => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    };

    const showBrowserNotification = (input: {
      title: string;
      body: string;
      tag: string;
    }) => {
      if (!document.hidden || !("Notification" in window)) return;
      if (Notification.permission === "granted") {
        const n = new Notification(input.title, {
          body: input.body,
          tag: input.tag,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
        return;
      }
      if (Notification.permission !== "denied") {
        void Notification.requestPermission();
      }
    };

    es.addEventListener("conversation-status", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = conversationStatusEventSchema.safeParse(parsed);
        if (!result.success) return;
        const data = result.data;
        if (data.scope === "project") {
          invalidateProjectConversationActivity(data.projectName);
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
            actionsRef.current.enqueueInputToast({
              scope: "project",
              projectName: data.projectName,
              conversationId: data.conversationId,
              displayContext: "main",
              href,
            });
          }
          if (data.error) {
            actionsRef.current.enqueuePromptErrorToast({
              scope: "project",
              projectName: data.projectName,
              conversationId: data.conversationId,
              displayContext: "main",
              href,
              error: data.error,
            });
          }
          if (data.status === "awaiting" && !data.error) {
            showBrowserNotification({
              title: "Project conversation ready",
              body: `${data.projectName} / ${data.conversationId}`,
              tag: `project-conversation-ready-${data.conversationId}`,
            });
          }
          return;
        }

        invalidateConversationViews(data.projectName, data.sessionName);
        void queryClient.invalidateQueries({
          queryKey: conversationKeys.messages(
            data.projectName,
            data.sessionName,
            data.conversationId,
          ),
        });

        if (data.status === "waiting_for_input") {
          // In-app toast
          actionsRef.current.enqueueInputToast({
            projectName: data.projectName,
            sessionName: data.sessionName,
            conversationId: data.conversationId,
          });

          showBrowserNotification({
            title: "Session needs input",
            body: `${data.projectName} / ${data.sessionName}`,
            tag: `input-${data.conversationId}`,
          });
        }

        if (data.error) {
          actionsRef.current.enqueuePromptErrorToast({
            projectName: data.projectName,
            sessionName: data.sessionName,
            conversationId: data.conversationId,
            error: data.error,
          });
        }
      } catch {
        // best-effort
      }
    });

    es.addEventListener("message-appended", (event) => {
      const parsed = messageAppendedEventSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) return;
      const d = parsed.data;
      const queryKey =
        d.scope === "project"
          ? projectConversationKeys.messages(d.projectName, d.conversationId)
          : conversationKeys.messages(
              d.projectName,
              d.sessionName,
              d.conversationId,
            );
      appendMessageToQuery(queryKey, { ...d.message, seq: d.seq });
    });

    es.addEventListener("message-updated", (event) => {
      const parsed = messageUpdatedEventSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) return;
      const d = parsed.data;
      const queryKey =
        d.scope === "project"
          ? projectConversationKeys.messages(d.projectName, d.conversationId)
          : conversationKeys.messages(
              d.projectName,
              d.sessionName,
              d.conversationId,
            );
      replaceMessageInQuery(queryKey, { ...d.message, seq: d.seq });
    });

    es.addEventListener("conversation-created", (event) => {
      const parsed = conversationCreatedEventSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) return;
      const d = parsed.data;
      if (d.scope === "project") {
        queryClient.setQueryData(
          projectConversationKeys.list(d.projectName),
          (prev: unknown) =>
            Array.isArray(prev) ? [...prev, d.conversation] : [d.conversation],
        );
        invalidateProjectConversationActivity(d.projectName);
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
    });

    es.addEventListener("conversation-renamed", (event) => {
      const parsed = conversationRenamedEventSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) return;
      const d = parsed.data;
      if (d.scope === "project") {
        updateProjectConversationListEntry(d.projectName, d.conversationId, {
          name: d.name,
        });
        invalidateProjectConversationActivity(d.projectName);
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
    });

    es.addEventListener("conversation-archived", (event) => {
      const parsed = conversationArchivedEventSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) return;
      const d = parsed.data;
      if (d.scope === "project") {
        updateProjectConversationListEntry(d.projectName, d.conversationId, {
          archived: d.archived,
        });
        invalidateProjectConversationActivity(d.projectName);
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
    });

    es.addEventListener("conversation-open", (event) => {
      const parsed = conversationOpenEventSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) return;
      const d = parsed.data;
      updateProjectConversationListEntry(d.projectName, d.conversationId, {
        open: d.open,
      });
      invalidateProjectConversationActivity(d.projectName);
    });

    es.addEventListener("conversation-unread", (event) => {
      const parsed = conversationUnreadEventSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) return;
      const d = parsed.data;
      if (d.scope !== "project") return;
      updateProjectConversationListEntry(d.projectName, d.conversationId, {
        unread: d.unread,
      });
      invalidateProjectConversationActivity(d.projectName);
    });

    es.addEventListener("ask-question", (event) => {
      const parsed = askQuestionEventSchema.safeParse(JSON.parse(event.data));
      if (!parsed.success) return;
      const d = parsed.data;
      if (d.scope === "project") {
        invalidateProjectConversationActivity(d.projectName);
        void queryClient.invalidateQueries({
          queryKey: projectConversationKeys.messages(
            d.projectName,
            d.conversationId,
          ),
        });
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(d.projectName, d.sessionName),
      });
    });

    es.addEventListener("message-queued", (event) => {
      const parsed = messageQueuedEventSchema.safeParse(JSON.parse(event.data));
      if (!parsed.success) return;
      const d = parsed.data;
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(d.projectName, d.sessionName),
      });
      // Queue pending events refresh ConversationState.pendingQueue via the
      // session-detail cache; they must NOT touch conversationKeys.messages —
      // a queued message is not yet a transcript row (req 7.3). The transcript
      // cache is written only by the message-appended handler once delivery
      // produces a real message.
    });

    es.addEventListener("message-queue-updated", (event) => {
      const parsed = messageQueueUpdatedEventSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) return;
      const d = parsed.data;
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(d.projectName, d.sessionName),
      });
    });

    es.addEventListener("job-status", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = jobStatusEventSchema.safeParse(parsed);
        if (!result.success) return;
        const data = result.data;
        actionsRef.current.addOrUpdateJob(data);

        // On completed merge/commit/resolve: invalidate session queries
        if (
          data.status === "completed" &&
          (data.jobType === "merge" ||
            data.jobType === "commit" ||
            data.jobType === "resolve-conflicts")
        ) {
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.detail(data.projectName, data.sessionName),
          });
        }
      } catch {
        // best-effort: ignore malformed events
      }
    });

    // New: notification-created events → invalidate cache + enqueue toast
    es.addEventListener("notification-created", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = notificationCreatedEventSchema.safeParse(parsed);
        if (!result.success) return;

        void queryClient.invalidateQueries({
          queryKey: notificationKeys.all,
        });
        actionsRef.current.enqueueToast(result.data.notification);
      } catch {
        // best-effort
      }
    });

    // New: notification-updated events → invalidate cache
    es.addEventListener("notification-updated", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = notificationUpdatedEventSchema.safeParse(parsed);
        if (!result.success) return;

        void queryClient.invalidateQueries({
          queryKey: notificationKeys.all,
        });
      } catch {
        // best-effort
      }
    });

    // --- Debug Mode SSE events ---
    es.addEventListener("debug-mode-status", (event) => {
      const parsed = debugModeStatusEventSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) return;
      const d = parsed.data;
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(d.projectName, d.sessionName),
      });
    });

    es.addEventListener("debug-log-received", (event) => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
      try {
        const parsed = debugLogReceivedEventSchema.parse(
          JSON.parse(event.data),
        );
        queryClient.setQueryData(
          debugLogKeys.stats(
            parsed.projectName,
            parsed.sessionName,
            parsed.conversationId,
          ),
          parsed.entryCount,
        );
      } catch {
        // Fall back to invalidation if parse fails
      }
    });

    // --- Dev Server SSE events ---
    es.addEventListener("dev-server-status", () => {
      void queryClient.invalidateQueries({ queryKey: devServerKeys.all });
    });

    // --- Graph Workflow SSE events ---

    const invalidateGraphWorkflow = (
      projectName: string,
      sessionName: string,
    ) => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    };

    es.addEventListener("graph-workflow-status", (event) => {
      try {
        const parsed = graphWorkflowStatusEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        invalidateGraphWorkflow(
          parsed.data.projectName,
          parsed.data.sessionName,
        );
      } catch {
        // best-effort
      }
    });

    es.addEventListener("graph-workflow-context-status", (event) => {
      try {
        const parsed = graphWorkflowContextStatusEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        invalidateGraphWorkflow(
          parsed.data.projectName,
          parsed.data.sessionName,
        );
      } catch {
        // best-effort
      }
    });

    es.addEventListener("graph-workflow-task-status", (event) => {
      try {
        const parsed = graphWorkflowTaskStatusEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        invalidateGraphWorkflow(
          parsed.data.projectName,
          parsed.data.sessionName,
        );
      } catch {
        // best-effort
      }
    });

    es.addEventListener("graph-workflow-validation-result", (event) => {
      try {
        const parsed = graphWorkflowValidationResultEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        invalidateGraphWorkflow(
          parsed.data.projectName,
          parsed.data.sessionName,
        );
      } catch {
        // best-effort
      }
    });

    es.addEventListener("graph-workflow-circuit-breaker", (event) => {
      try {
        const parsed = graphWorkflowCircuitBreakerEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        invalidateGraphWorkflow(
          parsed.data.projectName,
          parsed.data.sessionName,
        );
      } catch {
        // best-effort
      }
    });

    es.addEventListener("graph-workflow-shared-documents-updated", (event) => {
      try {
        const parsed = graphWorkflowSharedDocumentsUpdatedEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        invalidateGraphWorkflow(
          parsed.data.projectName,
          parsed.data.sessionName,
        );
      } catch {
        // best-effort
      }
    });

    es.addEventListener("graph-workflow-approval-pending", (event) => {
      try {
        const parsed = graphWorkflowApprovalPendingEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        const d = parsed.data;
        invalidateConversationViews(d.projectName, d.sessionName);
        actionsRef.current.enqueueInputToast({
          projectName: d.projectName,
          sessionName: d.sessionName,
          conversationId: d.conversationId,
          title: "Approval required",
          variant: "approval",
          contextTitle: d.contextTitle ?? d.contextId,
        });
        showBrowserNotification({
          title: "Approval required",
          body: `${d.contextTitle ?? d.contextId} passed validators — review to continue`,
          tag: `approval-${d.conversationId}`,
        });
      } catch {
        // best-effort
      }
    });

    es.addEventListener("graph-workflow-approval-resolved", (event) => {
      try {
        const parsed = graphWorkflowApprovalResolvedEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        invalidateConversationViews(
          parsed.data.projectName,
          parsed.data.sessionName,
        );
      } catch {
        // best-effort
      }
    });

    // --- Scoped Status SSE events (StatusBus → SSE bridge) ---
    // Generic envelope for primitive-native workflows (Collaboration Mode and
    // any future workflow that publishes through `StatusBus`). Dispatch by
    // `scope`; unknown scopes are ignored on the client so feature rollouts
    // can ship a new scope without coordinating a listener change.
    es.addEventListener("scoped-status", (event) => {
      try {
        const parsed = scopedStatusEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        const data = parsed.data;
        const sessionDetail = sessionKeys.detail(
          data.projectName,
          data.sessionName,
        );
        if (data.scope === "collaboration") {
          void queryClient.invalidateQueries({
            queryKey: collaborationKeys.all,
          });
          void queryClient.invalidateQueries({ queryKey: sessionDetail });
          // The slice writes the final answer onto the conversation
          // transcript via `appendTranscriptEntry`, and progress envelopes
          // can also land while the messages query has stopped polling —
          // refetch only the affected conversation's messages so an open
          // transcript view stays current without invalidating every
          // cached conversation (which can produce a refetch storm under
          // a chatty collaboration). The workflowId arrives as `scopeId`;
          // map it to a conversationId via the cached active list.
          const activeData = queryClient.getQueryData<{
            activeCollaborationExecutions: Array<{
              workflowId: string;
              conversationId: string | null;
            }>;
          }>(conversationKeys.active());
          const collab = activeData?.activeCollaborationExecutions.find(
            (c) => c.workflowId === data.scopeId,
          );
          if (collab?.conversationId) {
            void queryClient.invalidateQueries({
              queryKey: conversationKeys.messages(
                data.projectName,
                data.sessionName,
                collab.conversationId,
              ),
            });
          }
          void queryClient.invalidateQueries({
            queryKey: conversationKeys.active(),
          });
          void queryClient.invalidateQueries({
            queryKey: projectKeys.list(),
          });
          return;
        }
        if (data.scope === "workflow") {
          void queryClient.invalidateQueries({ queryKey: sessionDetail });
          return;
        }
      } catch {
        // best-effort
      }
    });

    // --- MCP Config SSE events ---
    es.addEventListener("mcp-config-updated", (event) => {
      try {
        const parsed = mcpConfigUpdatedEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        const data = parsed.data;

        // An override at any scope changes the resolved view at that scope and
        // every descendant scope, so we invalidate the whole subtree — not
        // just the emitting level.
        const invalidations = computeMcpConfigInvalidations({
          level: data.level,
          ...(data.projectName !== undefined && {
            projectName: data.projectName,
          }),
          ...(data.sessionName !== undefined && {
            sessionName: data.sessionName,
          }),
          ...(data.conversationId !== undefined && {
            conversationId: data.conversationId,
          }),
        });
        for (const matcher of invalidations) {
          void queryClient.invalidateQueries({ queryKey: matcher.queryKey });
        }
      } catch {
        // best-effort
      }
    });

    es.addEventListener("mcp-tools-updated", (event) => {
      try {
        const parsed = mcpToolsUpdatedEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        const data = parsed.data;
        if (data.projectName && data.sessionName && data.conversationId) {
          void queryClient.invalidateQueries({
            queryKey: mcpToolsKeys.inventory(
              data.projectName,
              data.sessionName,
              data.conversationId,
              data.serverKey,
            ),
          });
        } else {
          void queryClient.invalidateQueries({ queryKey: mcpToolsKeys.all });
        }
        void queryClient.invalidateQueries({ queryKey: mcpConfigKeys.all });
      } catch {
        // best-effort
      }
    });

    es.addEventListener("agent-capabilities-updated", (event) => {
      try {
        const parsed = agentCapabilitiesUpdatedEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        invalidateAgentCapabilityViews(parsed.data);
      } catch {
        // best-effort
      }
    });

    es.addEventListener("agent-capabilities-discovery-updated", (event) => {
      try {
        const parsed = agentCapabilitiesDiscoveryUpdatedEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!parsed.success) return;
        invalidateAgentCapabilityViews(parsed.data);
      } catch {
        // best-effort
      }
    });

    // SSE reconnection recovery: refetch notifications on reconnect after error
    es.onerror = () => {
      hadErrorRef.current = true;
    };

    es.onopen = () => {
      if (!hadErrorRef.current) return;
      hadErrorRef.current = false;
      void reconnectReconcile(queryClient, (jobs) => {
        const parsed = z.array(backgroundJobSchema).safeParse(jobs);
        if (parsed.success) actionsRef.current.reconcileJobs(parsed.data);
      });
    };

    return () => {
      es.close();
    };
  }, [queryClient]);

  return null;
}
