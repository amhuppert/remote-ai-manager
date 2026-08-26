import { createHash, randomUUID } from "node:crypto";

import { readConfig } from "@/lib/config/loader";
import { createJobsRepo } from "@/lib/jobs/repo";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { createLogger } from "@/lib/logging";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import { getNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
import { createProductionSpecReviewFeedbackNotifier } from "@/lib/notifications/spec-review-feedback";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { readConversationMessagesWithSeq } from "@/lib/prompt/transcript";
import { getSession } from "@/lib/state-store";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createGraphWorkflowArchivedExecutionsRepo } from "@/lib/state-store/graph-workflow-archived-executions-repo";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
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
  admitAuthoredWorkflowLaunch,
  admitAuthoredWorkflowModelSelections,
} from "@/lib/workflow-graph/authored-launch-admission";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { launchSpecDeliveryGraphWorkflowExecution } from "@/lib/workflow-graph/execution-route-handlers";
import { workingDefinitionHash } from "@/lib/workflow-graph/working-definition-hash";
import { WorkflowStartInputError } from "@/lib/workflow-graph/spec-bridge";

import { createAuthoringService } from "./authoring-service";
import { createProductionSpecWorkflowCleanupPort } from "./workflow-cleanup-port";
import { loadDeliveryPlanSeedBasis } from "./delivery-plan-basis-query";
import { createDeliveryPlanService } from "./delivery-plan-service";
import {
  createEvidenceMutationRecorder,
  createEvidenceService,
} from "./evidence-service";
import { createSpecEventsPublisher } from "./events";
import { loadSpecExportState, verifyExportState } from "./export";
import {
  createExecutionService,
  type ExecutionStartGatePort,
} from "./execution-service";
import { resolveCriterionBareHandle } from "./handles";
import { createImportService } from "./import-service";
import { createLinksService } from "./links-service";
import { createReviewService } from "./review-service";
import type { SpecExecutionRow } from "./schemas";
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
  const bindingRepo = createSpecExecutionBindingRepo(db);
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
  const reviewFeedbackNotifier = createProductionSpecReviewFeedbackNotifier();
  const review = createReviewService({
    specs,
    review: reviewRepo,
    delivery: deliveryRepo,
    links: linksRepo,
    events,
    attention: eventsRepo,
    // The approval notifier plus the proposer-facing feedback half (#60):
    // review feedback lands as passive durable notices in the proposing
    // conversation, never as a wake.
    notifier: {
      ...notifier,
      reviewFeedback: reviewFeedbackNotifier.reviewFeedback,
    },
    policyNotifier: notifier,
  });
  // Built after the review service so a successful propose can file the
  // gate-scoped asks it leaves pending through the same request verb a human
  // or an agent would call (R10.13) — one durable identity, one Needs You row.
  const authoring = createAuthoringService({
    specs,
    review: reviewRepo,
    links: linksRepo,
    events,
    waivers: deliveryRepo,
    policyNotifier: notifier,
    approvalRequests: {
      requestApproval: (input) => review.requestApproval(input),
    },
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

  const executionStartGate: ExecutionStartGatePort = {
    async launchApprovedLaunch(input) {
      try {
        const launched = await launchSpecDeliveryGraphWorkflowExecution({
          projectPath,
          projectName: input.projectName,
          sessionName: input.sessionName,
          plan: input.plan,
          specSlug: input.specSlug,
          candidateId: input.candidateId,
          ownerConversationId: input.ownerConversationId,
          ...(input.parameters === undefined
            ? {}
            : { inputs: input.parameters }),
          seededDocuments: input.seededDocuments,
          transactionAttachment: input.transactionAttachment,
        });
        return {
          ok: true as const,
          workflowExecutionId: launched.id,
          // The audit hash of the resolved runtime configuration at start
          // (amended design D3): computed from the launched working
          // definition, which is the effective-config snapshot the run runs.
          resolvedDefinitionHash: workingDefinitionHash(
            launched.workingDefinition,
          ),
        };
      } catch (error) {
        const code =
          error instanceof WorkflowStartInputError ? "validation" : undefined;
        logger.warn("specs.execution.spec-delivery-start-refused", {
          projectPath,
          sessionName: input.sessionName,
          candidateId: input.candidateId,
          ...(code === undefined ? {} : { code }),
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false as const,
          reason: error instanceof Error ? error.message : String(error),
          ...(code === undefined ? {} : { code }),
        };
      }
    },
  };

  const execution = createExecutionService({
    specsRepo: specs,
    deliveryRepo,
    bindingRepo,
    linksRepo,
    eventsRepo,
    reviewRepo,
    events,
    writeQueue,
    nextId: () => randomUUID(),
    now: () => new Date().toISOString(),
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
    executionStartGate: executionStartGate,
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
    },
    plansRepo: deliveryPlanRepo,
    deliveryPlanCapture: {
      abandonLaunchedAttempt(input) {
        return deliveryPlan.abandonLaunch(input);
      },
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
  });

  const links = createLinksService({
    specs,
    links: linksRepo,
    delivery: deliveryRepo,
    executionBindings: bindingRepo,
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
    launchedExecutionState(executionId) {
      return deliveryRepo.findExecutionById(executionId)?.state ?? null;
    },
    lastDeliveryBasis({ spec, pinnedRevision }) {
      return loadDeliveryPlanSeedBasis(
        {
          getRevisionSnapshot: (revisionId) =>
            specs.getRevisionSnapshot(revisionId),
          findExecutionsBySpecId: (id) =>
            deliveryRepo.findExecutionsBySpecId(id),
          findCriterionDispositionsByExecution: (executionId) =>
            deliveryRepo.findCriterionDispositionsByExecution(executionId),
          findDeliveryVerdictsBySpecExecutionId: (executionId) =>
            deliveryRepo.findDeliveryVerdictsBySpecExecutionId(executionId),
          findExecutionBindingBySpecExecutionId: (executionId) =>
            bindingRepo.findBySpecExecutionId(executionId),
          findWaiversByRevision: (revisionId) =>
            deliveryRepo.findWaiversByRevision(revisionId),
        },
        { spec, pinnedRevision },
      );
    },
    async admitLaunch({ spec, launch, accountabilityGroups }) {
      const [repoConfig, globalConfig] = await Promise.all([
        readRepoConfig(spec.projectPath),
        readConfig(),
      ]);
      return admitAuthoredWorkflowLaunch(launch, {
        caller: "spec-proposal",
        documentScope: { kind: "project", projectPath: spec.projectPath },
        projectValidation: repoConfig?.validation ?? null,
        globalValidation: globalConfig.validation,
        workflowDefaults: globalConfig.workflowDefaults,
        agentBackends: globalConfig.agentBackends,
        accountabilityGroups,
      });
    },
    async admitModelSelections({ spec, launch }) {
      const globalConfig = await readConfig();
      return admitAuthoredWorkflowModelSelections(launch, {
        agentBackends: globalConfig.agentBackends,
        projectPath: spec.projectPath,
        modelCatalogFor: (backend) =>
          getBackendDescriptor(backend).modelCatalog,
      });
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
    async verify(specId) {
      return verifyExportState(
        await loadSpecExportState(
          {
            specs,
            review: reviewRepo,
            delivery: deliveryRepo,
            events: eventsRepo,
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
