import { createHash, randomUUID } from "node:crypto";

import { readConfig } from "@/lib/config/loader";
import { defaultGitClient } from "@/lib/git/client";
import { createJobsRepo } from "@/lib/jobs/repo";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { createLogger } from "@/lib/logging";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import { getNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { readConversationMessagesWithSeq } from "@/lib/prompt/transcript";
import { getErrorMessage } from "@/lib/shared/errors";
import { getSession } from "@/lib/state-store";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createGraphWorkflowArchivedExecutionsRepo } from "@/lib/state-store/graph-workflow-archived-executions-repo";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { getStateDb } from "@/lib/state-store/store";
import { getSharedWriteQueue } from "@/lib/state-store/write-queue";
import {
  getTicketContentStore,
  getTicketService,
} from "@/lib/tickets/service-factory";
import type { TicketAttachment } from "@/lib/tickets/schemas";
import {
  approveGraphWorkflowDefinitionForSession,
  launchGraphWorkflowExecution,
  sessionHasPendingWorkflowDefinitionApproval,
} from "@/lib/workflow-graph/execution-route-handlers";
import { workflowConfigOverrideSchema } from "@/lib/workflow-graph/definition-schemas";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { scopeForTier } from "@/lib/workflow-graph/template-library-service";

import { createAuthoringService } from "./authoring-service";
import { createProductionSpecWorkflowCleanupPort } from "./workflow-cleanup-port";
import { classifyEarlierMergedDelivery } from "./delivery-gate";
import { loadDeliveryDelta } from "./delivery-delta-query";
import { deliveryPlanMaterializationCriteria } from "./delivery-plan-materializer";
import { createDeliveryPlanService } from "./delivery-plan-service";
import { resolveLegacyDeliverySource } from "./legacy-plan-import";
import { createEvidenceIngestService } from "./evidence-ingest";
import {
  createEvidenceMutationRecorder,
  createEvidenceService,
  type EvidenceService,
} from "./evidence-service";
import { createSpecEventsPublisher } from "./events";
import { loadSpecExportState, verifyExportState } from "./export";
import { createExecutionService } from "./execution-service";
import { readSpecExecutionOriginMap } from "./execution-origin-map";
import { evaluateEvidenceFreshness, type GitProbes } from "./freshness";
import { resolveCriterionBareHandle } from "./handles";
import { createImportService } from "./import-service";
import { createLinksService } from "./links-service";
import { toLintSnapshot } from "./review-state";
import { createReviewService } from "./review-service";
import {
  discoveredTaskSchema,
  evidenceEvaluatedStateSchema,
  type SpecExecutionRow,
} from "./schemas";
import type { SpecMutationServices } from "./route-handlers";

const logger = createLogger("specs.service-factory");
const servicesByProject = new Map<string, SpecMutationServices>();

export async function createProductionSpecRouteServices(
  projectPath: string,
): Promise<SpecMutationServices> {
  const existing = servicesByProject.get(projectPath);
  if (existing !== undefined) return existing;

  const db = getStateDb();
  const writeQueue = getSharedWriteQueue();
  const specs = createSpecsRepo(db, writeQueue);
  const reviewRepo = createSpecReviewRepo(db);
  const deliveryRepo = createSpecDeliveryRepo(db);
  const linksRepo = createSpecLinksRepo(db);
  const eventsRepo = createSpecEventsRepo(db);
  const deliveryPlanRepo = createSpecDeliveryPlanRepo(db, {
    appendEvent: (event) => eventsRepo.appendInTransaction(event),
  });
  const workflowEvents = createGraphWorkflowEventsRepo(db);
  const workflowExecutions = createGraphWorkflowExecutionsRepo(db);
  const archivedWorkflowExecutions =
    createGraphWorkflowArchivedExecutionsRepo(db);
  const jobsRepo = createJobsRepo(db);
  const workflowStorage = createWorkflowStorageService();
  const events = createSpecEventsPublisher({
    appendInTransaction: eventsRepo.appendInTransaction,
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
  const authoring = createAuthoringService({
    specs,
    review: reviewRepo,
    links: linksRepo,
    events,
    waivers: deliveryRepo,
    policyNotifier: notifier,
  });
  const review = createReviewService({
    specs,
    review: reviewRepo,
    delivery: deliveryRepo,
    links: linksRepo,
    events,
    attention: eventsRepo,
    notifier,
    policyNotifier: notifier,
  });

  const getWorkflowExecutionStatus = (workflowExecutionId: string) => {
    for (const workflow of workflowExecutions.listActive().values()) {
      if (workflow.id === workflowExecutionId) {
        return Promise.resolve(workflow.status);
      }
    }
    // A cleared run leaves the active slot but keeps its terminal status in
    // the archive; only a truly deleted execution reports null.
    return Promise.resolve(
      archivedWorkflowExecutions.findStatusByExecutionId(workflowExecutionId),
    );
  };

  const gitProbesForProject = (path: string) => createGitProbes(path);
  const evidenceRef: { current?: EvidenceService } = {};
  const ingest = createEvidenceIngestService({
    repo: deliveryRepo,
    workflowEvents,
    evidenceService: {
      attachEvidence(input) {
        if (evidenceRef.current === undefined) {
          throw new Error("Spec evidence service is not initialized");
        }
        return evidenceRef.current.attachEvidence(input);
      },
      recordProofVerdict(input) {
        if (evidenceRef.current === undefined) {
          throw new Error("Spec evidence service is not initialized");
        }
        return evidenceRef.current.recordProofVerdict(input);
      },
    },
    writeQueue,
    async validatedTreeHash(execution, commitSha, relevantPaths) {
      const spec = await specs.findById(execution.spec_id);
      if (spec === null) {
        throw new Error(`Spec ${execution.spec_id} was not found`);
      }
      return gitProbesForProject(spec.projectPath).relevantTreeHash(
        commitSha,
        relevantPaths,
      );
    },
    async loadOriginMap(workflowDefinitionId, execution) {
      const spec = await specs.findById(execution.spec_id);
      if (spec === null) return [];
      const record = await workflowStorage.get(
        scopeForTier("project", spec.projectPath),
        workflowDefinitionId,
      );
      return record === null
        ? []
        : readSpecExecutionOriginMap(record.definition, (revisionId) =>
            specs.getRevisionSnapshot(revisionId),
          );
    },
    getWorkflowExecutionStatus,
  });
  const ingestExecutionEvidence = (executionId: string) =>
    ingest.ingestAuthoritatively(executionId);

  const evidencePublication = createEvidenceMutationRecorder({
    eventsRepo,
    events,
    findSpecById: (specId) => specs.findByIdInTransaction(specId),
    runInImmediateTransaction<T>(operation: () => T): T {
      return db.transaction(operation).immediate();
    },
  });
  const evidence = createEvidenceService({
    repo: deliveryRepo,
    ingestExecutionEvidence,
    recordMutation: evidencePublication.recordMutation,
    runInImmediateTransaction: evidencePublication.runInImmediateTransaction,
    waiverNotifier: notifier,
    async resolveCriterionHandle(specId, criterionElementId) {
      const spec = await specs.findById(specId);
      if (spec === null) return null;
      return resolveCriterionBareHandle(
        (elementId) => specs.findElement(elementId),
        spec.slug,
        criterionElementId,
      );
    },
    nextId: () => randomUUID(),
    now: () => new Date().toISOString(),
    async getApprovedCriterion(revisionId, criterionElementId) {
      const snapshot = await specs.getRevisionSnapshot(revisionId);
      if (snapshot?.revision.state !== "approved") return null;
      const criterion = snapshot.elements.find(
        ({ element, version }) =>
          element.id === criterionElementId &&
          version.payload.kind === "criterion",
      );
      return criterion?.version.payload.kind === "criterion"
        ? {
            specId: snapshot.revision.specId,
            validationStrategy: criterion.version.payload.validationStrategy,
          }
        : null;
    },
    async gitObjectExists(ref, expectedExecution) {
      const execution = deliveryRepo.findExecutionById(
        expectedExecution.specExecutionId,
      );
      const spec =
        execution === null ? null : await specs.findById(execution.spec_id);
      if (spec === null) return false;
      try {
        await defaultGitClient.git(
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
    async isEvidenceFresh(evidenceRow) {
      let rawState: unknown;
      try {
        rawState = JSON.parse(evidenceRow.evaluated_state_json);
      } catch {
        return false;
      }
      const state = evidenceEvaluatedStateSchema.safeParse(rawState);
      if (!state.success || state.data.commitSha === undefined) return false;
      const execution =
        evidenceRow.execution_id === null
          ? null
          : deliveryRepo.findExecutionById(evidenceRow.execution_id);
      const spec = await specs.findById(evidenceRow.spec_id);
      if (execution === null || spec === null) return false;
      const freshness = await evaluateEvidenceFreshness(
        {
          id: evidenceRow.id,
          kind: evidenceRow.kind,
          evaluatedState: state.data,
          producingExecutionState: execution.state,
        },
        { commitSha: state.data.commitSha },
        gitProbesForProject(spec.projectPath),
      );
      return freshness.status === "valid";
    },
    async routeStrategyInadequacy(input) {
      logger.warn("specs.strategy_inadequacy.attention_requested", {
        specId: input.specId,
        revisionId: input.revisionId,
        criterionElementId: input.criterionElementId,
      });
    },
    async routeWaiverRequestToHuman(input) {
      const attentionId = randomUUID();
      // The durable Needs You registry for the routed request is the spec
      // notification row (R14.3) — same pipeline as gate approvals.
      const spec = await specs.findById(input.specId);
      if (spec !== null) {
        const criterionHandle = await resolveCriterionBareHandle(
          (elementId) => specs.findElement(elementId),
          spec.slug,
          input.criterionElementId,
        );
        notifier.waiverRequested({
          specId: spec.id,
          specSlug: spec.slug,
          specName: spec.name,
          projectPath: spec.projectPath,
          criterionElementId: input.criterionElementId,
          criterionHandle,
          revisionId: input.revisionId,
          attentionId,
          reason: input.reason,
          occurredAt: new Date().toISOString(),
        });
      }
      logger.info("specs.waiver_request.attention_requested", {
        attentionId,
        specId: input.specId,
        revisionId: input.revisionId,
        criterionElementId: input.criterionElementId,
      });
      return { attentionId };
    },
    async getTaskClaimContext(executionId, taskElementId) {
      const execution = deliveryRepo.findExecutionById(executionId);
      if (execution === null) return null;
      const [spec, snapshot] = await Promise.all([
        specs.findById(execution.spec_id),
        specs.getRevisionSnapshot(execution.revision_id),
      ]);
      const task = snapshot?.elements.find(
        ({ element, version }) =>
          element.id === taskElementId && version.payload.kind === "task",
      );
      if (
        spec === null ||
        snapshot === null ||
        task?.version.payload.kind !== "task"
      ) {
        return null;
      }
      return {
        specId: spec.id,
        revisionId: execution.revision_id,
        policy: spec.gatePolicy,
        draft: toLintSnapshot(spec, snapshot),
        coveredCriterionElementIds:
          task.version.payload.coveredCriterionElementIds,
      };
    },
    async getCriterionVersion(revisionId, criterionElementId) {
      const snapshot = await specs.getRevisionSnapshot(revisionId);
      const criterion = snapshot?.elements.find(
        ({ element, version }) =>
          element.id === criterionElementId &&
          version.payload.kind === "criterion",
      );
      return snapshot !== null &&
        snapshot !== undefined &&
        criterion !== undefined
        ? {
            specId: snapshot.revision.specId,
            revisionNumber: snapshot.revision.number,
            payloadHash: criterion.version.payloadHash,
          }
        : null;
    },
    wasCriterionDeliveredByMergedExecution(input) {
      return Promise.resolve(
        criterionWasDeliveredByEarlierExecution(
          input.executionId,
          input.criterionElementId,
          input.beforeExecutionId,
          deliveryRepo.findExecutionById.bind(deliveryRepo),
          linksRepo.findBySpecId.bind(linksRepo),
          deliveryRepo.findCriterionDisposition.bind(deliveryRepo),
        ),
      );
    },
  });
  evidenceRef.current = evidence;

  const execution = createExecutionService({
    specsRepo: specs,
    deliveryRepo,
    linksRepo,
    eventsRepo,
    reviewRepo,
    events,
    workflowDefinitions: {
      async findByOrigin(sourceUri) {
        const scope = scopeForTier("project", projectPath);
        const summaries = await workflowStorage.list(scope);
        for (const summary of summaries) {
          const record = await workflowStorage.get(scope, summary.id);
          if (record?.definition.origin?.sourceUri === sourceUri) return record;
        }
        return null;
      },
      create(draft) {
        return workflowStorage.create(
          scopeForTier("project", projectPath),
          draft,
        );
      },
      update(workflowId, draft) {
        return workflowStorage.update(
          scopeForTier("project", projectPath),
          workflowId,
          draft,
        );
      },
    },
    writeQueue,
    nextId: () => randomUUID(),
    now: () => new Date().toISOString(),
    ingestExecutionEvidence,
    async sessionExists(sessionName) {
      return (await getSession(projectPath, sessionName)) !== null;
    },
    getWorkflowExecutionStatus,
    getPublishedMerge(workflowExecutionId) {
      return Promise.resolve(
        jobsRepo.findLatestPublishedMergeByExecutionId(workflowExecutionId),
      );
    },
    runInImmediateTransaction<T>(operation: () => T): T {
      return db.transaction(operation).immediate();
    },
    policyNotifier: notifier,
    attentionNotifier: notifier,
    // The forward spec→workflow seams the abandon coordinator drives. Both
    // guard on the pinned execution id, so a slot re-taken between phases is
    // never the run this abandonment aborts or releases.
    workflowCleanup: createProductionSpecWorkflowCleanupPort(),
    // Read lazily: the delivery-plan service is composed below over the same
    // repositories, and a launch only ever asks after this factory returns.
    deliveryPlanLaunch: {
      resolveLaunch: (launchInput) => deliveryPlan.resolveLaunch(launchInput),
      park: (parkInput) => deliveryPlan.park(parkInput),
      recordLaunch: (launchInput) => deliveryPlan.recordLaunch(launchInput),
    },
    plansRepo: deliveryPlanRepo,
    deliveryPlanCapture: {
      async openSeededReplacement(replacementInput) {
        const opened = await deliveryPlan.open({
          spec: replacementInput.spec,
          seedFromLast: true,
          actor: replacementInput.actor,
        });
        return opened.ok
          ? { ok: true, value: { attemptId: opened.value.attempt.id } }
          : opened;
      },
    },
    executionStartGate: {
      async launchApprovedDefinition(input) {
        try {
          const launched = await launchGraphWorkflowExecution({
            projectPath,
            projectName: input.projectName,
            sessionName: input.sessionName,
            definitionId: input.definitionId,
            expectedDefinitionRevision: input.definitionRevision,
            ownerConversationId: input.ownerConversationId,
            seededDocuments: input.seededDocuments,
          });
          return { ok: true, workflowExecutionId: launched.id };
        } catch (error) {
          return { ok: false, reason: getErrorMessage(error) };
        }
      },
      hasPendingDefinitionApproval(input) {
        return sessionHasPendingWorkflowDefinitionApproval({
          projectPath,
          sessionName: input.sessionName,
          definitionId: input.definitionId,
          definitionRevision: input.definitionRevision,
        });
      },
      async ensurePendingDefinitionApproval(input) {
        let launchError: unknown = null;
        try {
          await launchGraphWorkflowExecution({
            projectPath,
            projectName: input.projectName,
            sessionName: input.sessionName,
            definitionId: input.definitionId,
            expectedDefinitionRevision: input.definitionRevision,
            ownerConversationId: input.ownerConversationId,
            seededDocuments: input.seededDocuments,
          });
        } catch (error) {
          launchError = error;
        }
        const pending = await sessionHasPendingWorkflowDefinitionApproval({
          projectPath,
          sessionName: input.sessionName,
          definitionId: input.definitionId,
          definitionRevision: input.definitionRevision,
        });
        if (pending !== null) {
          return { ok: true, workflowExecutionId: pending };
        }

        const reason =
          launchError === null
            ? "The compiled workflow did not park for definition approval."
            : getErrorMessage(launchError);
        logger.warn("specs.execution.workflow-start-not-pending", {
          projectPath,
          projectName: input.projectName,
          sessionName: input.sessionName,
          definitionId: input.definitionId,
          reason,
        });
        return { ok: false, reason };
      },
      grantApproval(input) {
        return review.grantGateApproval({ ...input, gate: "execution_start" });
      },
      approveWorkflowDefinition(input) {
        return approveGraphWorkflowDefinitionForSession({
          projectPath,
          projectName: input.projectName,
          sessionName: input.sessionName,
          workflowExecutionId: input.workflowExecutionId,
          definitionId: input.definitionId,
          definitionRevision: input.definitionRevision,
        });
      },
    },
  });

  const links = createLinksService({
    specs,
    links: linksRepo,
    delivery: deliveryRepo,
    authoring,
    events,
    workflowEvents,
    tickets: getTicketService(),
    contentStore: getTicketContentStore(),
    async loadConversationSource(conversation) {
      const session = await getSession(projectPath, conversation.sessionName);
      const source = session?.conversations.find(
        (candidate) => candidate.id === conversation.conversationId,
      );
      if (source === undefined) {
        throw new Error("Conversation source not found");
      }
      const messages = await readConversationMessagesWithSeq(
        source.transcriptPath,
      );
      return {
        messages: messages.map((message) => ({
          id: message.id ?? `seq-${message.seq}`,
          role: message.role,
          content: message.content,
        })),
        attachments: [],
      };
    },
    async resolveTicketAttachment(_ticket, attachment) {
      const content = await ticketAttachmentContent(attachment);
      return {
        content,
        version: attachment.updatedAt,
        contentHash: createHash("sha256").update(content).digest("hex"),
      };
    },
  });

  const deliveryPlan = createDeliveryPlanService({
    plans: deliveryPlanRepo,
    reviewRepo,
    events,
    policyNotifier: notifier,
    runInTransaction<T>(operation: () => T): T {
      return db.transaction(operation).immediate();
    },
    async currentApprovedRevision(specId) {
      // A plan pins the revision it is authored against, and only an approved
      // revision can be delivered — so the pin follows the spec's current
      // approved revision rather than its editable head. Read once, at open.
      const revisions = await specs.listRevisions(specId);
      const approved = revisions
        .filter((revision) => revision.state === "approved")
        .sort((left, right) => right.number - left.number)[0];
      return approved === undefined
        ? null
        : specs.getRevisionSnapshot(approved.id);
    },
    revisionSnapshot(revisionId) {
      return specs.getRevisionSnapshot(revisionId);
    },
    deliveryDelta({ spec, pinned, sinceExecutionId }) {
      return loadDeliveryDelta(
        {
          getRevisionSnapshot: (revisionId) =>
            specs.getRevisionSnapshot(revisionId),
          findExecutionsBySpecId:
            deliveryRepo.findExecutionsBySpecId.bind(deliveryRepo),
          findCriterionDispositionsByExecution:
            deliveryRepo.findCriterionDispositionsByExecution.bind(
              deliveryRepo,
            ),
          findProofVerdictsByCriterionRevision:
            deliveryRepo.findProofVerdictsByCriterionRevision.bind(
              deliveryRepo,
            ),
          findWaiverById: deliveryRepo.findWaiverById.bind(deliveryRepo),
        },
        {
          spec,
          currentApprovedSnapshot: pinned,
          // Stated rather than defaulted: an existing attempt is graded
          // against the delivery it froze, so a merge that lands afterwards
          // never re-grades criteria the plan already judged.
          ...(sinceExecutionId === null ? {} : { sinceExecutionId }),
        },
      );
    },
    latestLegacyDeliverySource(specId) {
      return resolveLegacyDeliverySource(
        deliveryRepo.findExecutionsBySpecId(specId),
        (revisionId) => specs.getRevisionSnapshot(revisionId),
      );
    },
    async capturedDiscoveries({ specId }) {
      // A discovery is its own durable row (design §11), so the next plan
      // reads the record rather than reconstructing it from the event log.
      return deliveryPlanRepo.findDiscoveriesBySpecId(specId).map((row) => {
        const task = discoveredTaskSchema.parse(
          JSON.parse(row.discovered_task_json),
        );
        return {
          discoveryId: row.id,
          title: task.title,
          instructions: task.instructions,
          coveredCriterionElementIds: task.coveredCriterionElementIds,
        };
      });
    },
    classifyDeliveredElsewhere({
      claim,
      criterionElementId,
      deliveredByExecutionId,
    }) {
      return classifyEarlierMergedDelivery(
        {
          findExecutionById: deliveryRepo.findExecutionById.bind(deliveryRepo),
          findCriterionDisposition:
            deliveryRepo.findCriterionDisposition.bind(deliveryRepo),
        },
        // The attempt stands in for the execution it will become: "earlier" is
        // measured against when the plan was opened, so an execution created
        // after it cannot back one of its claims.
        {
          id: claim.id,
          spec_id: claim.specId,
          created_at: claim.createdAt,
        },
        {
          criterion_element_id: criterionElementId,
          delivered_by_execution_id: deliveredByExecutionId,
        },
      );
    },
    async compilationContext({ spec, pinnedRevisionId }) {
      const snapshot = await specs.getRevisionSnapshot(pinnedRevisionId);
      if (snapshot === null) return null;
      const [repoConfig, globalConfig] = await Promise.all([
        readRepoConfig(spec.projectPath),
        readConfig(),
      ]);
      return {
        criteria: deliveryPlanMaterializationCriteria(snapshot),
        registeredValidationCommandNames: Object.keys(
          repoConfig?.validation?.commands ?? {},
        ),
        defaults: {
          // Never. The plan sign-off IS the execution-start admission (design
          // §5), so a candidate that also parked for workflow definition
          // approval would be the hidden second human act between propose and
          // launch that the single-act flow exists to remove. The
          // `execution_start` dial still decides who may sign the plan off and
          // on what basis — it just no longer reaches the compiled bytes.
          approvalRequired: false,
          // Resolved once and pinned. A later edit to the global workflow
          // defaults cannot reach a candidate that was already materialized.
          workflowConfig: workflowConfigOverrideSchema.parse(
            globalConfig.workflowDefaults ?? {},
          ),
        },
      };
    },
    nextId: () => randomUUID(),
    now: () => new Date().toISOString(),
  });

  const specImport = createImportService({
    specs,
    review: reviewRepo,
    links: linksRepo,
    events,
  });

  const services: SpecMutationServices = {
    authoring,
    review,
    evidence,
    execution,
    links,
    deliveryPlan,
    import: specImport,
    ingestEvidenceBestEffort(executionId) {
      return ingest.ingestBestEffort(executionId);
    },
    async verify(specId) {
      return verifyExportState(
        await loadSpecExportState(
          {
            specs,
            review: reviewRepo,
            delivery: deliveryRepo,
            // The same observe seam the abandon coordinator acts through, so
            // the orphans verify reports are the ones cleanup would clear.
            observeLinkedWorkflow: (target) =>
              createProductionSpecWorkflowCleanupPort().observe(target),
          },
          specId,
        ),
      );
    },
  };
  servicesByProject.set(projectPath, services);
  return services;
}

function criterionWasDeliveredByEarlierExecution(
  executionId: string,
  criterionElementId: string,
  beforeExecutionId: string,
  findExecution: (executionId: string) => SpecExecutionRow | null,
  findLinks: ReturnType<typeof createSpecLinksRepo>["findBySpecId"],
  findDisposition: ReturnType<
    typeof createSpecDeliveryRepo
  >["findCriterionDisposition"],
): boolean {
  const execution = findExecution(executionId);
  const before = findExecution(beforeExecutionId);
  if (
    execution === null ||
    before === null ||
    execution.spec_id !== before.spec_id ||
    execution.state !== "delivered" ||
    execution.created_at >= before.created_at
  ) {
    return false;
  }
  const disposition = findDisposition(execution.id, criterionElementId);
  if (disposition === null || disposition.disposition === "deferred") {
    return false;
  }
  return findLinks(execution.spec_id).some((link) => {
    if (link.object_kind !== "merge_job") return false;
    try {
      const ref = JSON.parse(link.object_ref_json) as Record<string, unknown>;
      return ref.specExecutionId === execution.id;
    } catch {
      return false;
    }
  });
}

async function ticketAttachmentContent(
  attachment: TicketAttachment,
): Promise<string> {
  switch (attachment.payload.kind) {
    case "note":
      return attachment.payload.markdown;
    case "file":
      return Buffer.from(
        await getTicketContentStore().read(attachment.payload.snapshotKey),
      ).toString("utf8");
    case "conversation":
      if (attachment.payload.snapshotKey === null) {
        return JSON.stringify(attachment.payload);
      }
      return Buffer.from(
        await getTicketContentStore().read(attachment.payload.snapshotKey),
      ).toString("utf8");
    case "session":
    case "related_ticket":
      return JSON.stringify(attachment.payload);
  }
}

function createGitProbes(projectPath: string): GitProbes {
  return {
    async isAncestor(ancestorSha, descendantSha) {
      try {
        await defaultGitClient.git(
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
        const { stdout } = await defaultGitClient.git(
          ["rev-parse", `${commitSha}^{tree}`],
          projectPath,
        );
        return stdout.trim();
      }
      const { stdout } = await defaultGitClient.git(
        ["ls-tree", "-r", "--full-tree", commitSha, "--", ...relevantPaths],
        projectPath,
      );
      return createHash("sha256").update(stdout).digest("hex");
    },
  };
}
