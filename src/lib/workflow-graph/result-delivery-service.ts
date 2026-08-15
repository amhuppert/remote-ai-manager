import path from "node:path";
import {
  commitGraphWorkflowMissingOriginFallback,
  getConversation,
  getGraphWorkflowResultDelivery,
  listPendingGraphWorkflowResultEffects,
  markGraphWorkflowResultEffectDelivered,
  mutateConversation,
  settleGraphWorkflowResultDeliveryFallback,
} from "@/lib/state-store";
import { publishEvent } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { markWorkflowResultUnread } from "@/lib/conversations/mark-unread";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-notification/dispatcher";
import type { CreateWorkflowNotificationInput } from "@/lib/notifications/repo";
import type { WorkflowNotification } from "@/lib/notifications/schemas";
import type { GraphWorkflowResultDelivery } from "./schemas";
import { buildGraphWorkflowExecutionDeepLink } from "./execution-deep-link";
import type { GraphWorkflowResultRecordedEvent } from "./event-schemas";
import type { GraphWorkflowPushInfo } from "./execution-events";

const logger = createLogger("workflow.result-delivery");

export interface DeliverRecordedWorkflowResultInput {
  projectPath: string;
  event: GraphWorkflowResultRecordedEvent;
  completionPush: GraphWorkflowPushInfo | null;
}

export interface GraphWorkflowResultDeliveryServiceDeps {
  markOriginUnread(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
  }): Promise<boolean>;
  originExists?(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<boolean>;
  dispatchPush(info: GraphWorkflowPushInfo): void | Promise<void>;
  commitMissingOriginFallback(input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
    boundarySeq: number;
    notification: CreateWorkflowNotificationInput;
  }): Promise<{
    notification: WorkflowNotification;
    created: boolean;
    settled: boolean;
  }>;
  publishFallbackNotification(notification: WorkflowNotification): void;
  settleMissingOriginResult(input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
    boundarySeq: number;
  }): Promise<boolean>;
  isPostCommitEffectPending(input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
    boundarySeq: number;
  }): Promise<boolean>;
  markPostCommitEffectDelivered(input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
    boundarySeq: number;
  }): Promise<boolean>;
  listPendingPostCommitEffects(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowResultDelivery[]>;
  publishResultRecorded?(event: GraphWorkflowResultRecordedEvent): void;
}

export interface GraphWorkflowResultDeliveryService {
  deliverRecordedResult(
    input: DeliverRecordedWorkflowResultInput,
  ): Promise<void>;
  reconcilePendingResults(
    projectPath: string,
    sessionName: string,
  ): Promise<number>;
}

export function workflowResultDedupeKey(
  event: GraphWorkflowResultRecordedEvent,
): string {
  return `graph-workflow-result:${event.executionId}:${event.boundaryCursor}`;
}

export function workflowMissingOriginFallbackDedupeKey(
  executionId: string,
): string {
  return `graph-workflow-origin-missing:${executionId}`;
}

export function createGraphWorkflowResultDeliveryService(
  deps: GraphWorkflowResultDeliveryServiceDeps,
): GraphWorkflowResultDeliveryService {
  const completedDeliveryKeys = new Set<string>();

  async function deliverRecordedResult(
    input: DeliverRecordedWorkflowResultInput,
  ): Promise<void> {
    const identity = {
      projectPath: input.projectPath,
      sessionName: input.event.sessionName,
      executionId: input.event.executionId,
      boundaryCursor: input.event.boundaryCursor,
      originConversationId: input.event.originConversationId,
    };
    const dedupeKey = workflowResultDedupeKey(input.event);
    if (completedDeliveryKeys.has(dedupeKey)) {
      logger.debug("workflow_result.delivery_deduped", {
        ...identity,
        dedupeKey,
      });
      return;
    }
    const effectScope = {
      projectPath: input.projectPath,
      sessionName: input.event.sessionName,
      executionId: input.event.executionId,
      boundarySeq: input.event.boundaryCursor,
    };
    if (!(await deps.isPostCommitEffectPending(effectScope))) {
      completedDeliveryKeys.add(dedupeKey);
      logger.debug("workflow_result.delivery_receipt_found", {
        ...identity,
        dedupeKey,
      });
      return;
    }
    logger.info("workflow_result.delivery_started", identity);

    try {
      const unreadInput = {
        projectPath: input.projectPath,
        projectName: input.event.projectName,
        sessionName: input.event.sessionName,
        conversationId: input.event.originConversationId,
      };
      let marked: boolean;
      try {
        marked = await deps.markOriginUnread(unreadInput);
      } catch (error) {
        const originStillExists =
          deps.originExists === undefined
            ? true
            : await deps.originExists(unreadInput);
        if (originStillExists) throw error;
        marked = false;
        logger.info("workflow_result.origin_deleted_during_unread", {
          ...identity,
          dedupeKey,
        });
      }
      if (!marked) {
        if (input.completionPush === null) {
          const settled = await deps.settleMissingOriginResult(effectScope);
          await deps.markPostCommitEffectDelivered(effectScope);
          completedDeliveryKeys.add(dedupeKey);
          logger.info("workflow_result.origin_missing_noncompletion_settled", {
            ...identity,
            dedupeKey,
            settled,
          });
          return;
        }
        const deepLink = buildGraphWorkflowExecutionDeepLink({
          projectName: input.event.projectName,
          sessionName: input.event.sessionName,
          executionId: input.event.executionId,
        });
        const fallback = await deps.commitMissingOriginFallback({
          ...effectScope,
          notification: {
            type: "workflow-result-ready",
            title: "Workflow result ready",
            message: `Execution "${input.event.executionId}" finished after origin conversation "${input.event.originConversationId}" was deleted.`,
            projectName: input.event.projectName,
            sessionName: input.event.sessionName,
            executionId: input.event.executionId,
            originConversationId: input.event.originConversationId,
            deepLink,
            dedupeKey: workflowMissingOriginFallbackDedupeKey(
              input.event.executionId,
            ),
          },
        });
        deps.publishFallbackNotification(fallback.notification);
        await deps.dispatchPush({ ...input.completionPush, dedupeKey });
        await deps.markPostCommitEffectDelivered(effectScope);
        completedDeliveryKeys.add(dedupeKey);
        logger.info("workflow_result.origin_missing_fallback_completed", {
          ...identity,
          dedupeKey,
          notificationId: fallback.notification.id,
          notificationCreated: fallback.created,
          settled: fallback.settled,
          deepLink,
        });
        return;
      }

      if (input.completionPush !== null) {
        await deps.dispatchPush({ ...input.completionPush, dedupeKey });
      }

      await deps.markPostCommitEffectDelivered(effectScope);
      completedDeliveryKeys.add(dedupeKey);
      logger.info("workflow_result.delivery_completed", identity);
    } catch (error) {
      logger.warn("workflow_result.delivery_failed", {
        ...identity,
        error: getErrorMessage(error),
      });
    }
  }

  async function reconcilePendingResults(
    projectPath: string,
    sessionName: string,
  ): Promise<number> {
    const pending = await deps.listPendingPostCommitEffects(
      projectPath,
      sessionName,
    );
    for (const delivery of pending) {
      const event: GraphWorkflowResultRecordedEvent = {
        type: "graph-workflow-result-recorded",
        projectName: path.basename(projectPath),
        sessionName,
        executionId: delivery.executionId,
        originConversationId: delivery.originConversationId,
        boundaryCursor: delivery.boundarySeq,
      };
      deps.publishResultRecorded?.(event);
      const isCompleted =
        delivery.payload.boundaryKind === "completion" &&
        delivery.payload.status === "completed";
      await deliverRecordedResult({
        projectPath,
        event,
        completionPush: isCompleted
          ? {
              kind: "workflow-completed",
              projectName: event.projectName,
              sessionName,
            }
          : null,
      });
    }
    if (pending.length > 0) {
      logger.info("workflow_result.effects_reconciled", {
        projectPath,
        sessionName,
        count: pending.length,
      });
    }
    return pending.length;
  }

  return { deliverRecordedResult, reconcilePendingResults };
}

const DEFAULT_SERVICE_KEY = "__cc_graph_workflow_result_delivery_service";

export function getGraphWorkflowResultDeliveryService(): GraphWorkflowResultDeliveryService {
  return getGlobalSingleton(DEFAULT_SERVICE_KEY, () =>
    createGraphWorkflowResultDeliveryService({
      async markOriginUnread(input) {
        const conversation = await getConversation(
          input.projectPath,
          input.sessionName,
          input.conversationId,
        );
        if (!conversation) return false;
        await markWorkflowResultUnread(input, {
          mutateConversation,
          publishSessionStatus: publishEvent,
        });
        return true;
      },
      async originExists(input) {
        return (
          (await getConversation(
            input.projectPath,
            input.sessionName,
            input.conversationId,
          )) !== null
        );
      },
      dispatchPush: dispatchPushForGraphWorkflowEvent,
      commitMissingOriginFallback(input) {
        return commitGraphWorkflowMissingOriginFallback(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
          input.notification,
        );
      },
      publishFallbackNotification(notification) {
        publishEvent({ type: "notification-created", notification });
      },
      settleMissingOriginResult(input) {
        return settleGraphWorkflowResultDeliveryFallback(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
      },
      async isPostCommitEffectPending(input) {
        const delivery = await getGraphWorkflowResultDelivery(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
        return delivery !== null && delivery.effectsDeliveredAt === null;
      },
      markPostCommitEffectDelivered(input) {
        return markGraphWorkflowResultEffectDelivered(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
      },
      listPendingPostCommitEffects: listPendingGraphWorkflowResultEffects,
      publishResultRecorded: publishEvent,
    }),
  );
}
