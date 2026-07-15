"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { instrumentSseEventSource } from "@/lib/api/sse";
import { registerAgentCapabilitySseReactions } from "@/lib/agent-capabilities/sse-reactions";
import { registerChatSpawningSseReactions } from "@/lib/chat-spawning/sse-reactions";
import { registerContextArtifactSseReactions } from "@/lib/context-artifacts/sse-reactions";
import { registerConversationSseReactions } from "@/lib/conversations/sse-reactions";
import { registerDebugLogSseReactions } from "@/lib/debug-log/sse-reactions";
import { registerDevServerSseReactions } from "@/lib/dev-server/sse-reactions";
import {
  registerJobSseReactions,
  registerJobsReconnectReconciliation,
} from "@/lib/jobs/sse-reactions";
import { showBrowserNotification } from "@/lib/notifications/browser-notification";
import { registerNotificationSseReactions } from "@/lib/notifications/sse-reactions";
import { registerMcpSseReactions } from "@/lib/mcp/sse-reactions";
import { registerSessionAlignmentSseReactions } from "@/lib/session-alignment/sse-reactions";
import { registerTicketSseReactions } from "@/lib/tickets/sse-reactions";
import { registerWorkflowSseReactions } from "@/lib/workflows/sse-reactions";
import {
  useAddOrUpdateJob,
  useReconcileJobs,
  useEnqueueToast,
  useEnqueueInputToast,
  useEnqueuePromptErrorToast,
} from "@/stores/notification.store";

/**
 * Client assembly point for the shared `/api/events` EventSource: opens the
 * one SSE connection, instruments it, and registers every domain's reaction
 * module against it. The reactions themselves (cache updates, toasts) live
 * with their owning domains in `src/lib/<domain>/sse-reactions.ts`.
 */
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

  useEffect(() => {
    const es = new EventSource("/api/events");
    instrumentSseEventSource(es);

    registerConversationSseReactions(es, {
      queryClient,
      enqueueInputToast: (item) => actionsRef.current.enqueueInputToast(item),
      enqueuePromptErrorToast: (item) =>
        actionsRef.current.enqueuePromptErrorToast(item),
      showBrowserNotification,
    });
    registerChatSpawningSseReactions(es, { queryClient });
    registerJobSseReactions(es, {
      queryClient,
      addOrUpdateJob: (event) => actionsRef.current.addOrUpdateJob(event),
    });
    registerNotificationSseReactions(es, {
      queryClient,
      enqueueToast: (notification) =>
        actionsRef.current.enqueueToast(notification),
    });
    registerDebugLogSseReactions(es, { queryClient });
    registerDevServerSseReactions(es, { queryClient });
    registerWorkflowSseReactions(es, {
      queryClient,
      enqueueInputToast: (item) => actionsRef.current.enqueueInputToast(item),
      showBrowserNotification,
    });
    registerMcpSseReactions(es, { queryClient });
    registerAgentCapabilitySseReactions(es, { queryClient });
    registerSessionAlignmentSseReactions(es, { queryClient });
    registerTicketSseReactions(es, { queryClient });
    registerContextArtifactSseReactions(es, { queryClient });
    registerJobsReconnectReconciliation(es, {
      queryClient,
      reconcileJobs: (jobs) => actionsRef.current.reconcileJobs(jobs),
    });

    return () => {
      es.close();
    };
  }, [queryClient]);

  return null;
}
