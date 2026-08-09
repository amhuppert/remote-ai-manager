/**
 * Workflow-domain SSE reactions: graph-workflow execution events and the
 * generic `scoped-status` StatusBus bridge, registered against the shared
 * `/api/events` EventSource by the client assembly point
 * (`NotificationListener`).
 */

import type { QueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { addSseListener } from "@/lib/api/sse";
import { scopedStatusEventSchema } from "@/lib/api/sse-events";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { invalidateConversationViews } from "@/lib/conversations/sse-reactions";
import type { BrowserNotificationInput } from "@/lib/notifications/browser-notification";
import { projectKeys } from "@/lib/projects/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import {
  collaborationKeys,
  graphWorkflowEventsKeys,
  graphWorkflowExecutionKeys,
} from "@/lib/workflows/query-keys";
import {
  graphWorkflowApprovalPendingEventSchema,
  graphWorkflowApprovalResolvedEventSchema,
  graphWorkflowBatchScheduledEventSchema,
  graphWorkflowCharterRegisteredEventSchema,
  graphWorkflowCharterUpdatedEventSchema,
  graphWorkflowCircuitBreakerEventSchema,
  graphWorkflowContextStatusEventSchema,
  graphWorkflowJoinStatusEventSchema,
  graphWorkflowLaneConcurrentAdmissionEventSchema,
  graphWorkflowLaneCommitEventSchema,
  graphWorkflowLaneCreatedEventSchema,
  graphWorkflowLaneDriftHaltedEventSchema,
  graphWorkflowLaneLandedEventSchema,
  graphWorkflowLaneStatusEventSchema,
  graphWorkflowLiveEditAppliedEventSchema,
  graphWorkflowMergeStatusEventSchema,
  graphWorkflowPendingHaltReasonEventSchema,
  graphWorkflowPlanRepairEventSchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
  graphWorkflowStatusEventSchema,
  graphWorkflowTaskStatusEventSchema,
  graphWorkflowUserInputPendingEventSchema,
  graphWorkflowUserInputResolvedEventSchema,
  graphWorkflowValidationResultEventSchema,
  graphWorkflowValidationSpecialistResultEventSchema,
  graphWorkflowValidationIncidentEventSchema,
} from "@/lib/workflow-graph/event-schemas";
import type { InputNeededItem } from "@/stores/notification.store";

export interface WorkflowSseReactionDeps {
  queryClient: QueryClient;
  enqueueInputToast(item: InputNeededItem): void;
  showBrowserNotification(input: BrowserNotificationInput): void;
}

function invalidateGraphWorkflow(
  queryClient: QueryClient,
  projectName: string,
  sessionName: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: graphWorkflowExecutionKeys.detail(projectName, sessionName),
  });
}

function invalidateGraphWorkflowEvents(
  queryClient: QueryClient,
  projectName: string,
  sessionName: string,
  executionId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: graphWorkflowEventsKeys.list(
      projectName,
      sessionName,
      executionId,
    ),
  });
}

interface SessionScopedEvent {
  projectName: string;
  sessionName: string;
}

/** Events whose only reaction is a refetch of the execution detail. */
function registerDetailInvalidation<T extends SessionScopedEvent>(
  es: EventSource,
  queryClient: QueryClient,
  type: string,
  schema: z.ZodType<T>,
): void {
  addSseListener(es, type, schema, (d) => {
    invalidateGraphWorkflow(queryClient, d.projectName, d.sessionName);
  });
}

/** Events that refetch both the execution detail and its event log. */
function registerDetailAndEventsInvalidation<
  T extends SessionScopedEvent & { executionId: string },
>(
  es: EventSource,
  queryClient: QueryClient,
  type: string,
  schema: z.ZodType<T>,
): void {
  addSseListener(es, type, schema, (d) => {
    invalidateGraphWorkflow(queryClient, d.projectName, d.sessionName);
    invalidateGraphWorkflowEvents(
      queryClient,
      d.projectName,
      d.sessionName,
      d.executionId,
    );
  });
}

export function registerWorkflowSseReactions(
  es: EventSource,
  deps: WorkflowSseReactionDeps,
): void {
  const { queryClient } = deps;

  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-status",
    graphWorkflowStatusEventSchema,
  );
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-context-status",
    graphWorkflowContextStatusEventSchema,
  );
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-task-status",
    graphWorkflowTaskStatusEventSchema,
  );
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-batch-scheduled",
    graphWorkflowBatchScheduledEventSchema,
  );
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-merge-status",
    graphWorkflowMergeStatusEventSchema,
  );
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-lane-status",
    graphWorkflowLaneStatusEventSchema,
  );
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-lane-created",
    graphWorkflowLaneCreatedEventSchema,
  );
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-lane-concurrent-admission",
    graphWorkflowLaneConcurrentAdmissionEventSchema,
  );
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-lane-landed",
    graphWorkflowLaneLandedEventSchema,
  );
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-lane-drift-halted",
    graphWorkflowLaneDriftHaltedEventSchema,
  );
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-lane-commit",
    graphWorkflowLaneCommitEventSchema,
  );
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-join-status",
    graphWorkflowJoinStatusEventSchema,
  );
  // A live edit may change only config or future structure (no status
  // diff), so refetch both the execution and its event log directly.
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-live-edit-applied",
    graphWorkflowLiveEditAppliedEventSchema,
  );
  // A plan-repair round conclusion changes the round log, the halt summary,
  // and (for repairs) the working definition — refetch detail + event log.
  registerDetailAndEventsInvalidation(
    es,
    queryClient,
    "graph-workflow-plan-repair",
    graphWorkflowPlanRepairEventSchema,
  );

  registerDetailInvalidation(
    es,
    queryClient,
    "graph-workflow-validation-result",
    graphWorkflowValidationResultEventSchema,
  );
  // Detail only, like the aggregate above: both refresh the inspector's live
  // per-lane view without re-fetching the event log, which renders neither.
  registerDetailInvalidation(
    es,
    queryClient,
    "graph-workflow-validation-specialist-result",
    graphWorkflowValidationSpecialistResultEventSchema,
  );
  registerDetailInvalidation(
    es,
    queryClient,
    "graph-workflow-validation-incident",
    graphWorkflowValidationIncidentEventSchema,
  );
  registerDetailInvalidation(
    es,
    queryClient,
    "graph-workflow-circuit-breaker",
    graphWorkflowCircuitBreakerEventSchema,
  );
  registerDetailInvalidation(
    es,
    queryClient,
    "graph-workflow-shared-documents-updated",
    graphWorkflowSharedDocumentsUpdatedEventSchema,
  );
  // Not a log-visible transition (WorkflowEventLog renders it as null), so
  // only the execution detail refetches — same for the charter events below.
  registerDetailInvalidation(
    es,
    queryClient,
    "graph-workflow-pending-halt-reason",
    graphWorkflowPendingHaltReasonEventSchema,
  );
  registerDetailInvalidation(
    es,
    queryClient,
    "graph-workflow-charter-registered",
    graphWorkflowCharterRegisteredEventSchema,
  );
  registerDetailInvalidation(
    es,
    queryClient,
    "graph-workflow-charter-updated",
    graphWorkflowCharterUpdatedEventSchema,
  );

  addSseListener(
    es,
    "graph-workflow-approval-pending",
    graphWorkflowApprovalPendingEventSchema,
    (d) => {
      invalidateConversationViews(queryClient, d.projectName, d.sessionName);
      deps.enqueueInputToast({
        projectName: d.projectName,
        sessionName: d.sessionName,
        conversationId: d.conversationId,
        title: "Approval required",
        variant: "approval",
        contextTitle: d.contextTitle ?? d.contextId,
      });
      deps.showBrowserNotification({
        title: "Approval required",
        body: `${d.contextTitle ?? d.contextId} passed validators — review to continue`,
        tag: `approval-${d.conversationId}`,
      });
    },
  );

  addSseListener(
    es,
    "graph-workflow-approval-resolved",
    graphWorkflowApprovalResolvedEventSchema,
    (d) => {
      invalidateConversationViews(queryClient, d.projectName, d.sessionName);
    },
  );

  addSseListener(
    es,
    "graph-workflow-user-input-pending",
    graphWorkflowUserInputPendingEventSchema,
    (d) => {
      invalidateGraphWorkflow(queryClient, d.projectName, d.sessionName);
      invalidateGraphWorkflowEvents(
        queryClient,
        d.projectName,
        d.sessionName,
        d.executionId,
      );
      invalidateConversationViews(queryClient, d.projectName, d.sessionName);
      deps.enqueueInputToast({
        projectName: d.projectName,
        sessionName: d.sessionName,
        conversationId: d.conversationId,
        title: "Workflow question",
        contextTitle: d.contextTitle ?? d.contextId,
      });
    },
  );

  addSseListener(
    es,
    "graph-workflow-user-input-resolved",
    graphWorkflowUserInputResolvedEventSchema,
    (d) => {
      invalidateGraphWorkflow(queryClient, d.projectName, d.sessionName);
      invalidateGraphWorkflowEvents(
        queryClient,
        d.projectName,
        d.sessionName,
        d.executionId,
      );
      invalidateConversationViews(queryClient, d.projectName, d.sessionName);
    },
  );

  // --- Scoped Status SSE events (StatusBus → SSE bridge) ---
  // Generic envelope for primitive-native workflows (Collaboration Mode and
  // any future workflow that publishes through `StatusBus`). Dispatch by
  // `scope`; unknown scopes are ignored on the client so feature rollouts
  // can ship a new scope without coordinating a listener change.
  addSseListener(es, "scoped-status", scopedStatusEventSchema, (data) => {
    const sessionDetail = sessionKeys.detail(
      data.projectName,
      data.sessionName,
    );
    if (data.scope === "collaboration") {
      void queryClient.invalidateQueries({
        queryKey: collaborationKeys.all,
      });
      invalidateConversationViews(
        queryClient,
        data.projectName,
        data.sessionName,
      );
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
        queryKey: projectKeys.list(),
      });
      return;
    }
    if (data.scope === "workflow") {
      void queryClient.invalidateQueries({ queryKey: sessionDetail });
      return;
    }
  });
}
