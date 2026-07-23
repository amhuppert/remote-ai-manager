import { createHash, randomUUID } from "node:crypto";
import { defaultGitClient, type GitClient } from "@/lib/git/client";
import { createJobsRepo } from "@/lib/jobs/repo";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import { getNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { getStateDb } from "@/lib/state-store/store";
import { getSharedWriteQueue } from "@/lib/state-store/write-queue";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { scopeForTier } from "@/lib/workflow-graph/template-library-service";
import { readCompiledOriginMap } from "./compiler";
import { createDeliveryGate } from "./delivery-gate";
import { createEvidenceIngestService } from "./evidence-ingest";
import { createSpecEventsPublisher } from "./events";
import {
  createEvidenceMutationRecorder,
  createEvidenceService,
  type EvidenceService,
} from "./evidence-service";
import {
  createExecutionLifecycleCallbacks,
  type ExecutionLifecycleCallbacks,
} from "./execution-service";
import { evaluateEvidenceFreshness, type GitProbes } from "./freshness";
import { createReviewService } from "./review-service";
import { evidenceEvaluatedStateSchema } from "./schemas";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import { createMergeAssociationResolver } from "./merge-association";
import type { SpecWorkflowComposition } from "./workflow-composition";
import { registerSpecWorkflowComposition } from "./workflow-composition";
import { createSpecExecutionContract } from "./execution-contract";

export interface ProductionSpecWorkflowCompositionDeps {
  gitClient: GitClient;
}

const defaultDeps: ProductionSpecWorkflowCompositionDeps = {
  gitClient: defaultGitClient,
};

export function createProductionSpecWorkflowComposition(
  deps: ProductionSpecWorkflowCompositionDeps = defaultDeps,
): SpecWorkflowComposition {
  const db = getStateDb();
  const writeQueue = getSharedWriteQueue();
  const deliveryRepo = createSpecDeliveryRepo(db);
  const reviewRepo = createSpecReviewRepo(db);
  const specsRepo = createSpecsRepo(db, writeQueue);
  const linksRepo = createSpecLinksRepo(db);
  const eventsRepo = createSpecEventsRepo(db);
  const jobsRepo = createJobsRepo(db);
  const workflowEvents = createGraphWorkflowEventsRepo(db);
  const workflowStorage = createWorkflowStorageService();
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
  const gitProbesForProject = (projectPath: string) =>
    createGitProbes(deps.gitClient, projectPath);
  const evidenceServiceRef: { current?: EvidenceService } = {};
  const ingestService = createEvidenceIngestService({
    repo: deliveryRepo,
    workflowEvents,
    evidenceService: {
      attachEvidence(input) {
        const evidenceService = evidenceServiceRef.current;
        if (evidenceService === undefined) {
          throw new Error("Spec evidence service is not initialized");
        }
        return evidenceService.attachEvidence(input);
      },
    },
    writeQueue,
    async loadOriginMap(workflowDefinitionId, execution) {
      const spec = await specsRepo.findById(execution.spec_id);
      if (spec === null) return [];
      const record = await workflowStorage.get(
        scopeForTier("project", spec.projectPath),
        workflowDefinitionId,
      );
      return record === null ? [] : readCompiledOriginMap(record.definition);
    },
  });
  const ingestExecutionEvidence = (executionId: string) =>
    ingestService.ingestAuthoritatively(executionId);

  const evidenceService = createEvidenceService({
    repo: deliveryRepo,
    ingestExecutionEvidence,
    recordMutation: evidencePublication.recordMutation,
    runInImmediateTransaction: evidencePublication.runInImmediateTransaction,
    nextId: () => randomUUID(),
    now: () => new Date().toISOString(),
    async getApprovedCriterion(revisionId, criterionElementId) {
      const snapshot = await specsRepo.getRevisionSnapshot(revisionId);
      if (snapshot?.revision.state !== "approved") return null;
      const criterion = snapshot.elements.find(
        (item) =>
          item.element.id === criterionElementId &&
          item.version.payload.kind === "criterion",
      );
      if (criterion?.version.payload.kind !== "criterion") return null;
      return {
        specId: snapshot.revision.specId,
        validationStrategy: criterion.version.payload.validationStrategy,
      };
    },
    async gitObjectExists(ref, expectedExecution) {
      const execution = deliveryRepo.findExecutionById(
        expectedExecution.specExecutionId,
      );
      const spec =
        execution === null ? null : await specsRepo.findById(execution.spec_id);
      if (spec === null) return false;
      try {
        await deps.gitClient.git(
          ["cat-file", "-e", `${ref.objectId}^{object}`],
          spec.projectPath,
        );
        return true;
      } catch {
        return false;
      }
    },
    async workflowEventExists(ref, expectedExecution) {
      const record = workflowEvents.findRecordById(ref.eventId);
      return (
        record !== null &&
        record.executionId === expectedExecution.workflowExecutionId &&
        "contextId" in record.event &&
        record.event.contextId === ref.contextId
      );
    },
    async mergeValidationFactExists(ref, expectedExecution) {
      const job = jobsRepo.getJobRecord(ref.mergeJobId);
      return (
        job?.executionId === expectedExecution.workflowExecutionId &&
        job.candidateValidation?.validationRef === ref.validationRef
      );
    },
    async contentObjectExists() {
      return false;
    },
    async humanActorExists() {
      return false;
    },
    async isEvidenceFresh(evidence) {
      let rawState: unknown;
      try {
        rawState = JSON.parse(evidence.evaluated_state_json);
      } catch {
        return false;
      }
      const parsed = evidenceEvaluatedStateSchema.safeParse(rawState);
      if (!parsed.success || parsed.data.commitSha === undefined) return false;
      const execution =
        evidence.execution_id === null
          ? null
          : deliveryRepo.findExecutionById(evidence.execution_id);
      const spec = await specsRepo.findById(evidence.spec_id);
      if (execution === null || spec === null) return false;
      const freshness = await evaluateEvidenceFreshness(
        {
          id: evidence.id,
          kind: evidence.kind,
          evaluatedState: parsed.data,
          producingExecutionState: execution.state,
        },
        { commitSha: parsed.data.commitSha },
        gitProbesForProject(spec.projectPath),
      );
      return freshness.status === "valid";
    },
    async routeStrategyInadequacy() {
      throw new Error("Strategy inadequacy routing is unavailable here");
    },
    async routeWaiverRequestToHuman() {
      throw new Error("Waiver routing is unavailable here");
    },
    async getTaskClaimContext() {
      return null;
    },
    async getCriterionVersion(revisionId, criterionElementId) {
      const snapshot = await specsRepo.getRevisionSnapshot(revisionId);
      const criterion = snapshot?.elements.find(
        (item) => item.element.id === criterionElementId,
      );
      return snapshot === null ||
        snapshot === undefined ||
        criterion === undefined
        ? null
        : {
            specId: snapshot.revision.specId,
            revisionNumber: snapshot.revision.number,
            payloadHash: criterion.version.payloadHash,
          };
    },
    async wasCriterionDeliveredByMergedExecution() {
      return false;
    },
  });
  evidenceServiceRef.current = evidenceService;

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
  const deliveryGate = createDeliveryGate({
    deliveryRepo,
    reviewRepo,
    specsRepo,
    evidenceService,
    ingestExecutionEvidence,
    gitProbesForProject,
    recordIntervention: evidencePublication.recordMutation,
    now: () => new Date().toISOString(),
    newAdmissionId: () => randomUUID(),
    events,
    writeQueue,
    runInImmediateTransaction<T>(fn: () => T): T {
      return db.transaction(fn).immediate();
    },
    policyNotifier: notifier,
    async resolveCandidateValidation(input) {
      const source = jobsRepo.findMergeValidationByExecutionIdAndRef(
        input.workflowExecutionId,
        input.validationRef,
      );
      return source === null
        ? null
        : {
            ...source,
            producer: {
              kind: "agent",
              conversationId: `workflow:${input.workflowExecutionId}`,
            },
          };
    },
  });
  // The lifecycle gate reuses the review service so parked definitions open
  // the same durable Needs You request — and workflow-surface approvals
  // record the same execution-scoped grant — as Spec Studio's actions.
  const reviewService = createReviewService({
    specs: specsRepo,
    review: reviewRepo,
    delivery: deliveryRepo,
    links: linksRepo,
    events,
    notifier,
    policyNotifier: notifier,
  });
  const lifecycleCallbacks: ExecutionLifecycleCallbacks =
    createExecutionLifecycleCallbacks({
      specsRepo,
      deliveryRepo,
      linksRepo,
      eventsRepo,
      reviewRepo,
      events,
      writeQueue,
      nextId: () => randomUUID(),
      now: () => new Date().toISOString(),
      ingestExecutionEvidence,
      getPublishedMerge: (workflowExecutionId) =>
        Promise.resolve(
          jobsRepo.findLatestPublishedMergeByExecutionId(workflowExecutionId),
        ),
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
      policyNotifier: notifier,
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
    markDelivered(workflowExecutionId: string, mergeHash: string) {
      return lifecycleCallbacks.markDelivered(workflowExecutionId, mergeHash);
    },
  };

  return {
    deliveryGate,
    lifecycleCallbacks,
    mergeAssociation,
    mergeDeliveryLifecycle,
    executionContract: createSpecExecutionContract(),
  };
}

export function registerProductionSpecWorkflowComposition(): void {
  registerSpecWorkflowComposition(createProductionSpecWorkflowComposition());
}

function createGitProbes(gitClient: GitClient, projectPath: string): GitProbes {
  return {
    async isAncestor(ancestorSha, descendantSha) {
      try {
        await gitClient.git(
          ["merge-base", "--is-ancestor", ancestorSha, descendantSha],
          projectPath,
        );
        return true;
      } catch {
        return false;
      }
    },
    async relevantTreeHash(commitSha, relevantPaths) {
      if (relevantPaths.length === 0) {
        const { stdout } = await gitClient.git(
          ["rev-parse", `${commitSha}^{tree}`],
          projectPath,
        );
        return stdout.trim();
      }
      const { stdout } = await gitClient.git(
        ["ls-tree", "-r", "--full-tree", commitSha, "--", ...relevantPaths],
        projectPath,
      );
      return createHash("sha256").update(stdout).digest("hex");
    },
  };
}
