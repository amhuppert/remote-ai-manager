"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sessionKeys, conversationKeys, workflowKeys } from "@/lib/query-keys";
import {
  jobStatusEventSchema,
  workflowStatusEventSchema,
  workflowIterationCompleteEventSchema,
  workflowFixPlanUpdatedEventSchema,
  workflowCircuitBreakerEventSchema,
} from "@/lib/schemas";
import { useAddOrUpdateJob } from "@/stores/notification.store";
import {
  useHandleWorkflowStatusEvent,
  useHandleWorkflowIterationComplete,
  useHandleWorkflowFixPlanUpdated,
  useHandleWorkflowCircuitBreaker,
} from "@/stores/workflow.store";

export default function NotificationListener(): null {
  const queryClient = useQueryClient();
  const addOrUpdateJob = useAddOrUpdateJob();
  const handleWorkflowStatus = useHandleWorkflowStatusEvent();
  const handleIterationComplete = useHandleWorkflowIterationComplete();
  const handleFixPlanUpdated = useHandleWorkflowFixPlanUpdated();
  const handleCircuitBreaker = useHandleWorkflowCircuitBreaker();

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.addEventListener("conversation-status", () => {
      // Invalidate active conversations query for unified panel refresh
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active,
      });
      // Also invalidate session queries for status display updates
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    });

    es.addEventListener("ask-question", () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active,
      });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    });

    es.addEventListener("job-status", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = jobStatusEventSchema.safeParse(parsed);
        if (!result.success) return;
        const data = result.data;
        addOrUpdateJob(data);

        // On completed merge: invalidate session queries
        if (data.jobType === "merge" && data.status === "completed") {
          void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
        }
        // On completed commit: invalidate session queries
        if (data.jobType === "commit" && data.status === "completed") {
          void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
        }
      } catch {
        // best-effort: ignore malformed events
      }
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
        const result =
          workflowIterationCompleteEventSchema.safeParse(parsed);
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

    return () => {
      es.close();
    };
  }, [
    queryClient,
    addOrUpdateJob,
    handleWorkflowStatus,
    handleIterationComplete,
    handleFixPlanUpdated,
    handleCircuitBreaker,
  ]);

  return null;
}
