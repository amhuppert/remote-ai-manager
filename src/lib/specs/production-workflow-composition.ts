import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { createJobsRepo } from "@/lib/jobs/repo";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import { getNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
import { createProductionSpecReviewFeedbackNotifier } from "@/lib/notifications/spec-review-feedback";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { createGraphWorkflowArchivedExecutionsRepo } from "@/lib/state-store/graph-workflow-archived-executions-repo";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { getStateDb } from "@/lib/state-store/store";
import { getSharedWriteQueue } from "@/lib/state-store/write-queue";
import { createDeliveryGate } from "./delivery-gate-v2";
import { createSpecEventsPublisher } from "./events";
import { createEvidenceMutationRecorder } from "./evidence-service";
import {
  createExecutionLifecycleCallbacks,
  type ExecutionLifecycleCallbacks,
} from "./execution-service";
import { createReviewService } from "./review-service";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import { createMergeAssociationResolver } from "./merge-association";
import type { WorkflowComposition } from "@/lib/workflows/production-contracts";
import { createProductionSpecWorkflowCleanupPort } from "./workflow-cleanup-port";
import {
  createSpecExecutionBindingGraphContract,
  createSpecExecutionBindingPorts,
} from "./execution-binding-service";
import { createAuthoredContextOutcomeService } from "@/lib/workflow-graph/authored-context-outcome";

const logger = createLogger("specs.production-workflow-composition");

export function createProductionSpecWorkflowComposition(): WorkflowComposition {
  const db = getStateDb();
  const writeQueue = getSharedWriteQueue();
  const deliveryRepo = createSpecDeliveryRepo(db);
  const bindingRepo = createSpecExecutionBindingRepo(db);
  const bindingPorts = createSpecExecutionBindingPorts(bindingRepo);
  const reviewRepo = createSpecReviewRepo(db);
  const specsRepo = createSpecsRepo(db, writeQueue);
  const linksRepo = createSpecLinksRepo(db);
  const eventsRepo = createSpecEventsRepo(db);
  const jobsRepo = createJobsRepo(db);
  const workflowExecutions = createGraphWorkflowExecutionsRepo(db);
  const archivedWorkflowExecutions =
    createGraphWorkflowArchivedExecutionsRepo(db);
  const deliveryOutcomes = createAuthoredContextOutcomeService({
    async findExecutionById(executionId) {
      const active = workflowExecutions.findByExecutionId(executionId);
      if (active !== null) return { execution: active, location: "active" };
      const archived =
        archivedWorkflowExecutions.findByExecutionId(executionId);
      return archived === null
        ? null
        : { execution: archived, location: "archived" };
    },
  });
  const events = createSpecEventsPublisher({
    appendInTransaction: eventsRepo.appendInTransaction,
  });
  const evidencePublication = createEvidenceMutationRecorder({
    eventsRepo,
    events,
    findSpecById: (specId) => specsRepo.findByIdInTransaction(specId),
    runInImmediateTransaction<T>(operation: () => T): T {
      return db.transaction(operation).immediate();
    },
  });
  const notificationsRepo = createNotificationsRepo(db);
  const notifier = createSpecApprovalNotifier({
    createSpecNotification(input) {
      getNotificationsService().createSpecNotification(input);
    },
    findSpecNotificationsBySpecId(specId) {
      return notificationsRepo.findSpecNotificationsBySpecId(specId);
    },
    getProjectDisplayName,
  });
  const reviewFeedbackNotifier = createProductionSpecReviewFeedbackNotifier();
  // The lifecycle gate and the delivery gate both reuse the review service so
  // parked definitions and missing delivery approvals open the same durable
  // Needs You request — and workflow-surface approvals record the same
  // execution-scoped grant — as Spec Studio's actions.
  const reviewService = createReviewService({
    specs: specsRepo,
    review: reviewRepo,
    delivery: deliveryRepo,
    links: linksRepo,
    events,
    attention: eventsRepo,
    // The approval notifier plus the author-facing feedback half (#60):
    // review feedback lands as passive durable notices in the conversation
    // that authored the draft, never as a wake.
    notifier: {
      ...notifier,
      reviewFeedback: reviewFeedbackNotifier.reviewFeedback,
    },
    policyNotifier: notifier,
  });
  const deliveryGate = createDeliveryGate({
    findWorkflowExecution(executionId) {
      return (
        workflowExecutions.findByExecutionId(executionId) ??
        archivedWorkflowExecutions.findByExecutionId(executionId)
      );
    },
    bindingPort: bindingPorts.delivery,
    outcomePort: deliveryOutcomes,
    deliveryRepo,
    reviewRepo,
    specsRepo,
    attention: eventsRepo,
    recordIntervention: evidencePublication.recordMutation,
    now: () => new Date().toISOString(),
    newVerdictId: () => randomUUID(),
    newAdmissionId: () => randomUUID(),
    events,
    writeQueue,
    runInImmediateTransaction<T>(fn: () => T): T {
      return db.transaction(fn).immediate();
    },
    policyNotifier: notifier,
    getProjectDisplayName,
    async requestDeliveryApproval({ specId, revisionId, workflowExecutionId }) {
      const result = await reviewService.requestApproval({
        specId,
        revisionId,
        gate: "delivery",
        subject: "delivery",
        actor: {
          kind: "agent",
          conversationId: workflowExecutionId
            ? `workflow:${workflowExecutionId}`
            : `delivery:${specId}`,
        },
      });
      if (!result.ok) {
        // A refusal here is informational (e.g. the human approved between
        // gate attempts → already_satisfied); the gate's own refusal already
        // carries the remediation.
        logger.debug("specs.delivery-gate.approval-request-refused", {
          specId,
          refusalCode: result.refusal.code,
        });
      }
    },
  });
  const lifecycleCallbacks: ExecutionLifecycleCallbacks =
    createExecutionLifecycleCallbacks({
      specsRepo,
      deliveryRepo,
      bindingRepo,
      linksRepo,
      eventsRepo,
      reviewRepo,
      events,
      writeQueue,
      nextId: () => randomUUID(),
      now: () => new Date().toISOString(),
      getPublishedMergeBySpecExecutionId: async (specExecutionId) =>
        jobsRepo.findLatestPublishedMergeBySpecExecutionId(specExecutionId),
      getPublishedMerge: (workflowExecutionId) =>
        Promise.resolve(
          jobsRepo.findLatestPublishedMergeByExecutionId(workflowExecutionId),
        ),
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
      policyNotifier: notifier,
      attentionNotifier: notifier,
      // The reverse hook (`executionAborted`) runs the same coordinator, so
      // this composition needs the forward seams too: an aborted run still
      // holding the session's slot is released here rather than left for an
      // operator to clear by hand (ticket #47 note 9e5ba960).
      workflowCleanup: createProductionSpecWorkflowCleanupPort(),
      lifecycleGate: {
        async requestApproval(input) {
          const result = await reviewService.requestApproval({
            specId: input.specId,
            revisionId: input.revisionId,
            gate: "execution_start",
            subject: "execution_start",
            actor: input.actor,
          });
          if (!result.ok) {
            throw new Error(result.refusal.unmetConditions.join(" "));
          }
        },
        grantApproval(input) {
          return reviewService.grantGateApproval({
            ...input,
            gate: "execution_start",
          });
        },
      },
    });

  // MA1/MA2: fresh user merges resolve their spec-execution association at
  // dispatch through this resolver; MA7: a completed gate-passed final-publish
  // merge marks the linked execution Delivered promptly (read-path
  // reconciliation stays the backstop).
  const sessionsRepo = createSessionsRepo(db);
  const mergeAssociation = createMergeAssociationResolver({
    findActiveExecutionsBySessionName:
      deliveryRepo.findActiveExecutionsBySessionName,
    getSessionTargetBranch(projectPath, sessionName) {
      return (
        sessionsRepo.findByKey(projectPath, sessionName)?.targetBranch ?? null
      );
    },
  });
  const mergeDeliveryLifecycle = {
    markDelivered(
      workflowExecutionId: string | undefined,
      mergeHash: string,
      specExecutionId?: string,
    ) {
      return lifecycleCallbacks.markDelivered(
        workflowExecutionId,
        mergeHash,
        specExecutionId,
      );
    },
  };

  return {
    deliveryGate,
    lifecycleCallbacks,
    mergeAssociation,
    mergeDeliveryLifecycle,
    executionContract: createSpecExecutionBindingGraphContract(bindingPorts, {
      loadRevisionSnapshot: (revisionId) =>
        specsRepo.getRevisionSnapshot(revisionId),
    }),
  };
}
