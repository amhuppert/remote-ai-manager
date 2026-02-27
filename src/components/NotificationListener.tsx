"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  sessionKeys,
  conversationKeys,
  notificationKeys,
  workflowKeys,
  devServerKeys,
} from "@/lib/query-keys";
import {
  jobStatusEventSchema,
  notificationCreatedEventSchema,
  notificationUpdatedEventSchema,
  workflowStatusEventSchema,
  workflowIterationCompleteEventSchema,
  workflowFixPlanUpdatedEventSchema,
  workflowCircuitBreakerEventSchema,
} from "@/lib/schemas";
import {
  useAddOrUpdateJob,
  useEnqueueToast,
} from "@/stores/notification.store";
import {
  useHandleWorkflowStatusEvent,
  useHandleWorkflowIterationComplete,
  useHandleWorkflowFixPlanUpdated,
  useHandleWorkflowCircuitBreaker,
} from "@/stores/workflow.store";

export default function NotificationListener(): null {
  const queryClient = useQueryClient();
  const addOrUpdateJob = useAddOrUpdateJob();
  const enqueueToast = useEnqueueToast();
  const hadErrorRef = useRef(false);
  const handleWorkflowStatus = useHandleWorkflowStatusEvent();
  const handleIterationComplete = useHandleWorkflowIterationComplete();
  const handleFixPlanUpdated = useHandleWorkflowFixPlanUpdated();
  const handleCircuitBreaker = useHandleWorkflowCircuitBreaker();

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.addEventListener("conversation-status", () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active,
      });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    });

    es.addEventListener("ask-question", () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active,
      });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    });

    es.addEventListener("session-finished", () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    });

    es.addEventListener("job-status", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = jobStatusEventSchema.safeParse(parsed);
        if (!result.success) return;
        const data = result.data;
        addOrUpdateJob(data);

        // On completed merge/commit/resolve: invalidate session queries
        if (
          data.status === "completed" &&
          (data.jobType === "merge" ||
            data.jobType === "commit" ||
            data.jobType === "resolve-conflicts")
        ) {
          void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
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
        enqueueToast(result.data.notification);
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

    // --- Dev Server SSE events ---
    es.addEventListener("dev-server-status", () => {
      void queryClient.invalidateQueries({ queryKey: devServerKeys.all });
    });

    // --- Workflow SSE events ---

    es.addEventListener("workflow-status", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = workflowStatusEventSchema.safeParse(parsed);
        if (!result.success) return;
        handleWorkflowStatus(result.data);

        // Invalidate workflow and session queries so UI refreshes
        void queryClient.invalidateQueries({
          queryKey: workflowKeys.status(
            result.data.projectName,
            result.data.sessionName,
          ),
        });
        void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
      } catch {
        // best-effort
      }
    });

    es.addEventListener("workflow-iteration-complete", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = workflowIterationCompleteEventSchema.safeParse(parsed);
        if (!result.success) return;
        handleIterationComplete(result.data);

        void queryClient.invalidateQueries({
          queryKey: workflowKeys.status(
            result.data.projectName,
            result.data.sessionName,
          ),
        });
        void queryClient.invalidateQueries({
          queryKey: workflowKeys.iterations(
            result.data.projectName,
            result.data.sessionName,
          ),
        });
      } catch {
        // best-effort
      }
    });

    es.addEventListener("workflow-fix-plan-updated", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = workflowFixPlanUpdatedEventSchema.safeParse(parsed);
        if (!result.success) return;
        handleFixPlanUpdated(result.data);

        void queryClient.invalidateQueries({
          queryKey: workflowKeys.status(
            result.data.projectName,
            result.data.sessionName,
          ),
        });
      } catch {
        // best-effort
      }
    });

    es.addEventListener("workflow-circuit-breaker", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = workflowCircuitBreakerEventSchema.safeParse(parsed);
        if (!result.success) return;
        handleCircuitBreaker(result.data);

        void queryClient.invalidateQueries({
          queryKey: workflowKeys.status(
            result.data.projectName,
            result.data.sessionName,
          ),
        });
      } catch {
        // best-effort
      }
    });

    // SSE reconnection recovery: refetch notifications on reconnect after error
    es.onerror = () => {
      hadErrorRef.current = true;
    };

    es.onopen = () => {
      if (hadErrorRef.current) {
        hadErrorRef.current = false;
        // Reconnected after error — refetch to reconcile missed events
        void queryClient.invalidateQueries({
          queryKey: notificationKeys.all,
        });
        void queryClient.invalidateQueries({
          queryKey: devServerKeys.all,
        });
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.all,
        });
        void queryClient.invalidateQueries({
          queryKey: workflowKeys.all,
        });
      }
    };

    return () => {
      es.close();
    };
  }, [
    queryClient,
    addOrUpdateJob,
    enqueueToast,
    handleWorkflowStatus,
    handleIterationComplete,
    handleFixPlanUpdated,
    handleCircuitBreaker,
  ]);

  return null;
}
