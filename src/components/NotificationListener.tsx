"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  projectKeys,
  sessionKeys,
  conversationKeys,
  notificationKeys,
  workflowKeys,
  devServerKeys,
  debugLogKeys,
} from "@/lib/query-keys";
import {
  conversationStatusEventSchema,
  jobStatusEventSchema,
  notificationCreatedEventSchema,
  notificationUpdatedEventSchema,
  workflowStatusEventSchema,
  workflowIterationCompleteEventSchema,
  workflowFixPlanUpdatedEventSchema,
  workflowCircuitBreakerEventSchema,
  debugLogReceivedEventSchema,
  graphWorkflowStatusEventSchema,
  graphWorkflowContextStatusEventSchema,
  graphWorkflowTaskStatusEventSchema,
  graphWorkflowValidationResultEventSchema,
  graphWorkflowRetryEventSchema,
  graphWorkflowCircuitBreakerEventSchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
} from "@/lib/schemas";
import {
  useAddOrUpdateJob,
  useReconcileJobs,
  useEnqueueToast,
  useEnqueueInputToast,
  useEnqueuePromptErrorToast,
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
  const reconcileJobs = useReconcileJobs();
  const enqueueToast = useEnqueueToast();
  const enqueueInputToast = useEnqueueInputToast();
  const enqueuePromptErrorToast = useEnqueuePromptErrorToast();
  const hadErrorRef = useRef(false);
  const handleWorkflowStatus = useHandleWorkflowStatusEvent();
  const handleIterationComplete = useHandleWorkflowIterationComplete();
  const handleFixPlanUpdated = useHandleWorkflowFixPlanUpdated();
  const handleCircuitBreaker = useHandleWorkflowCircuitBreaker();

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.addEventListener("conversation-status", (event) => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active,
      });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
      void queryClient.invalidateQueries({ queryKey: projectKeys.list() });

      try {
        const parsed = JSON.parse(event.data);
        const result = conversationStatusEventSchema.safeParse(parsed);
        if (!result.success) return;
        const data = result.data;

        if (data.status === "waiting_for_input") {
          // In-app toast
          enqueueInputToast({
            projectName: data.projectName,
            sessionName: data.sessionName,
            conversationId: data.conversationId,
          });

          // Browser notification (only when tab is not focused)
          if (document.hidden && "Notification" in window) {
            if (Notification.permission === "granted") {
              const n = new Notification("Session needs input", {
                body: `${data.projectName} / ${data.sessionName}`,
                tag: `input-${data.conversationId}`,
              });
              n.onclick = () => {
                window.focus();
                n.close();
              };
            } else if (Notification.permission !== "denied") {
              void Notification.requestPermission();
            }
          }
        }

        if (data.error) {
          enqueuePromptErrorToast({
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

    // --- Debug Mode SSE events ---
    es.addEventListener("debug-mode-status", () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active,
      });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    });

    es.addEventListener("debug-log-received", (event) => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active,
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

    const invalidateGraphWorkflow = (
      projectName: string,
      sessionName: string,
    ) => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
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

    es.addEventListener("graph-workflow-retry", (event) => {
      try {
        const parsed = graphWorkflowRetryEventSchema.safeParse(
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
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.all,
        });

        // Reconcile stale running jobs with server-side truth
        void fetch("/api/jobs")
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data?.jobs) reconcileJobs(data.jobs);
          })
          .catch(() => {});
      }
    };

    return () => {
      es.close();
    };
  }, [
    queryClient,
    addOrUpdateJob,
    reconcileJobs,
    enqueueToast,
    enqueueInputToast,
    enqueuePromptErrorToast,
    handleWorkflowStatus,
    handleIterationComplete,
    handleFixPlanUpdated,
    handleCircuitBreaker,
  ]);

  return null;
}
