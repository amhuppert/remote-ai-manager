import { NextResponse } from "next/server";
import { z } from "zod";

import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import { PersistenceError } from "@/lib/shared/errors";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import {
  createSpecDeliveryRepo,
  type SpecDeliveryRepo,
} from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  SpecElementIdTakenError,
  SpecHistoricalElementError,
  SpecRevisionImmutableError,
  StaleElementConflictError,
  StaleStageConflictError,
  createSpecsRepo,
} from "@/lib/state-store/specs-repo";
import { getStateDb } from "@/lib/state-store/store";
import { getSharedWriteQueue } from "@/lib/state-store/write-queue";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { scopeForTier } from "@/lib/workflow-graph/template-library-service";

import { draftAuthoringSequence } from "./authoring-sequence";
import {
  SpecDraftUnavailableError,
  SpecRevisionInReviewError,
  SpecSlugTakenError,
  StageBlockedWriteError,
  createAuthoringService,
  createAuthoringSpecInputSchema,
  batchCarriesWork,
  draftElementBatchShapeSchema,
  BATCH_WITHOUT_WORK_MESSAGE,
  draftElementWriteInputSchema,
  type DraftElementBatchRefusal,
  historicalElementRefusal,
  immutableRevisionRefusal,
  openAmendmentInputSchema,
  proposeAuthoringRevisionInputSchema,
  removeDraftElementInputSchema,
  reorderDraftElementInputSchema,
  type AuthoringService,
} from "./authoring-service";
import { compiledWorkflowTaskId, scopePlanFromRevision } from "./compiler";
import { isEarlierMergedDelivery } from "./delivery-gate";
import type { DeliveryPlanService } from "./delivery-plan-service";
import {
  deliveryPlanEditRequestSchema,
  deliveryPlanOpenRequestSchema,
  deliveryPlanPreviewRequestSchema,
  deliveryPlanReopenRequestSchema,
  deliveryPlanCommentRequestSchema,
  deliveryPlanReaffirmRequestSchema,
  deliveryPlanSignOffRequestSchema,
} from "./delivery-plan-views";
import { DRAFT_HEALTH_TOP_FINDINGS, draftHealth } from "./draft-health";
import type { EvidenceService } from "./evidence-service";
import { createSpecEventsPublisher } from "./events";
import {
  loadSpecExportState,
  renderCanonicalBundle,
  SpecExportNotFoundError,
  verifyExportState,
  type CanonicalSpecBundle,
  type IntegrityReport,
} from "./export";
import {
  hashExecutionScope,
  type ExecutionService,
  type ReconciledSpecExecution,
  type SpecWorkflowCleanupTarget,
} from "./execution-service";
import { createProductionSpecWorkflowCleanupPort } from "./workflow-cleanup-port";
import { readSpecExecutionOriginMap } from "./execution-origin-map";
import {
  createApprovalApplicability,
  type ApprovalApplicability,
} from "./approval-applicability";
import {
  approvalHeld,
  currentExecution,
  elementHandle,
  latestRevision,
  parseProvenance,
  type PendingApproval,
} from "./gate-projection";
import { importBaselineRevisionId } from "./import-baseline";
import {
  authoringReviewProjection,
  type AuthoringNextAction,
  type AuthoringPendingBlock,
  type ImportCarriedApproval,
  type ProjectedGateStatus,
  type ProjectedOpenComments,
  type RevisionSignOffProjection,
} from "./authoring-review-projection";
import { diffRevisions } from "./revision-diff";
import {
  ancestorIds,
  governanceBaseRevisionId,
  SpecRevisionLineageError,
} from "./revision-lineage";
import {
  explainInvalidElementHandle,
  formatBareElementHandle,
  isWellFormedElementHandle,
  parseElementHandle,
  specSlugSchema,
  type ParsedElementHandle,
} from "./handles";
import {
  LinksServiceError,
  graduateTicketInputSchema,
  linkTicketInputSchema,
  materializeApprovedTasksInputSchema,
  promoteConversationInputSchema,
  type LinksService,
  type LinkedTicketReadThrough,
} from "./links-service";
import { loadDeliveryDelta } from "./delivery-delta-query";
import type { ImportService } from "./import-service";
import type { LintFinding } from "./lint";
import type { SpecMeasuresReport } from "./measures";
import { createMeasuresQuery } from "./measures-query";
import {
  boundSpecPlanPreview,
  buildSpecPlanPreview,
  type SpecPlanPreview,
} from "./plan-preview";
import { resolveDial } from "./policy";
import {
  projectDeliveryDisplay,
  projectRequirementStatus,
  projectSpecPhase,
  projectTaskWorkStatus,
  type DeliveryCriterion,
  type IdentifiedDeliveryCriterion,
  type RequirementStatusInput,
  type SpecPhaseProjection,
} from "./phase";
import { liveProposalProjection } from "./proposal-integrity";
import { proposalNotes } from "./proposal-notes";
import {
  elementHandleInSnapshot,
  toDiffRows,
  toLintSnapshot,
} from "./review-state";
import {
  answerQuestionInputSchema,
  approveItemInputSchema,
  unapproveItemInputSchema,
  bulkApproveInputSchema,
  changeSpecPolicyInputSchema,
  dismissSupersededProposalInputSchema,
  disposeAssumptionInputSchema,
  openQuestionInputSchema,
  proposeAssumptionInputSchema,
  requestApprovalInputSchema,
  grantGateApprovalInputSchema,
  requestChangesInputSchema,
  replyToReviewThreadInputSchema,
  resolveReviewThreadInputSchema,
  reviewCommentInputSchema,
  approveRemainingAndSignOffInputSchema,
  signOffRevisionInputSchema,
  withdrawProposalInputSchema,
  type ReviewService,
} from "./review-service";
import { executionScopeSchema, type ExecutionScope } from "./scope-validation";
import { isWaiverValidForExecution } from "./waiver-staleness";
import { projectSpecComment } from "./comment-projection";
import type {
  CriterionDeliveryProjection,
  LiveProposalView,
  RemainingAuthoringSequence,
  SpecAssumptionView,
  SpecCommentsView,
  SpecDiffBaseline,
  SpecDiffView,
  SpecQuestionView,
  SpecRevisionSnapshotView,
  SpecShowOutlineView,
  SpecEditContextView,
  SpecExecutionView,
  SpecGateAdmissionView,
  SpecImportRecordView,
  SpecSearchHit,
  SpecStartedExecutionView,
  SpecStatusExecution,
  SpecStatusView as PublishedSpecStatusView,
} from "./view-schemas";
import {
  actorProvenanceSchema,
  importBundleSchema,
  specCriterionDispositionSchema,
  specAuthoringStageSchema,
  specImportedEventPayloadSchema,
  taskElementPayloadSchema,
  type ActorProvenance,
  type Refusal,
  type Spec,
  type SpecAlias,
  type SpecApprovalRow,
  type SpecAssumptionRow,
  type SpecCommentRow,
  type SpecCriterionDispositionRow,
  type SpecEventRow,
  type SpecEvidenceRow,
  type SpecExecutionRow,
  type SpecGate,
  type SpecGateAdmissionRow,
  type SpecLinkRow,
  type SpecProofVerdictRow,
  type SpecQuestionRow,
  type SpecRevision,
  type SpecRevisionElement,
  type SpecRevisionSnapshot,
  type SpecTaskClaimRow,
  type SpecWaiverRow,
  type SpecWorkflowLaneStatus,
} from "./schemas";

const logger = createLogger("specs.routes");

export const SPEC_OUTLINE_ROOT_LIMIT = 12;
export const SPEC_OUTLINE_CRITERIA_PER_REQUIREMENT_LIMIT = 6;
const SPEC_OUTLINE_SUMMARY_LIMIT = 160;

export type SpecRouteContext = {
  params: Promise<Record<string, string>>;
};

export interface SpecRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  listSpecs(projectPath: string): Promise<Spec[]>;
  resolveSpec(projectPath: string, slug: string): Promise<Spec | null>;
  listAliases(specId: string): Promise<SpecAlias[]>;
  listRevisions(specId: string): Promise<SpecRevision[]>;
  getRevisionSnapshot(revisionId: string): Promise<SpecRevisionSnapshot | null>;
  lintDraft(specId: string, revisionId: string): Promise<LintFinding[]>;
  findApprovalsBySpecId(specId: string): SpecApprovalRow[];
  findCommentsByRevision(revisionId: string): SpecCommentRow[];
  /**
   * The spec's durable events, oldest first. The detail view reads them for
   * the disposition document each proposal was proposed with — the notes live
   * on the propose event, so nothing else can answer for them.
   */
  findEventsBySpecId(specId: string): SpecEventRow[];
  findGateAdmissionsBySpecId(specId: string): SpecGateAdmissionRow[];
  findLinksBySpecId(specId: string): SpecLinkRow[];
  getLinkedTickets(
    projectPath: string,
    specId: string,
  ): Promise<LinkedTicketReadThrough[]>;
  findQuestionsBySpecId(specId: string): SpecQuestionRow[];
  findAssumptionsBySpecId(specId: string): SpecAssumptionRow[];
  findExecutionsBySpecId(specId: string): SpecExecutionRow[];
  findTaskClaimsBySpecId(specId: string): SpecTaskClaimRow[];
  findWorkflowEventsByExecution(
    executionId: string,
  ): GraphWorkflowExecutionEvent[];
  reconcileExecution(
    projectPath: string,
    execution: SpecExecutionRow,
  ): Promise<ReconciledSpecExecution>;
  ingestExecutionEvidenceBestEffort(
    projectPath: string,
    executionId: string,
  ): Promise<void>;
  findCriterionDispositionsByExecution(
    executionId: string,
  ): SpecCriterionDispositionRow[];
  findEvidenceByCriterionRevision(
    criterionElementId: string,
    revisionId: string,
  ): SpecEvidenceRow[];
  findProofVerdictsByCriterionRevision(
    criterionElementId: string,
    revisionId: string,
  ): SpecProofVerdictRow[];
  findWaiverForCriterionRevision(
    criterionElementId: string,
    revisionId: string,
  ): SpecWaiverRow | null;
  /**
   * By-id waiver resolution for the delivery projection: the gate honors a
   * waiver only through the execution disposition's `waiver_id` link, so the
   * projection must resolve exactly that row rather than "any current waiver
   * for the criterion/revision".
   */
  findWaiverById(waiverId: string): SpecWaiverRow | null;
  findWaiversByRevision(revisionId: string): SpecWaiverRow[];
  exportSpec(specId: string): Promise<CanonicalSpecBundle>;
  verifySpec(specId: string): Promise<IntegrityReport>;
  measureProject(projectPath: string): Promise<SpecMeasuresReport>;
}

export interface ResolvedSpecProjectRoute {
  projectName: string;
  projectPath: string;
}

export interface ResolvedSpecRoute extends ResolvedSpecProjectRoute {
  requestedSlug: string;
  spec: Spec;
}

interface CurrentSpecState {
  revisions: SpecRevision[];
  currentRevision: SpecRevision | null;
  currentSnapshot: SpecRevisionSnapshot | null;
  /** The current revision's immediate parent — the review diff's baseline. */
  baseSnapshot: SpecRevisionSnapshot | null;
  /**
   * The current revision's nearest approved ancestor — the baseline gate
   * applicability is cumulative against. Not the same revision as
   * `currentApprovedSnapshot` once an amendment forks past a withdrawn attempt.
   */
  governanceBaseSnapshot: SpecRevisionSnapshot | null;
  currentApprovedSnapshot: SpecRevisionSnapshot | null;
}

interface SpecCoverage {
  coveredCriteria: number;
  totalCriteria: number;
  percentage: number;
}

interface SpecStatusView {
  specId: string;
  slug: string;
  phase: SpecPhaseProjection;
  executions: SpecStatusExecution[];
  gates: ProjectedGateStatus[];
  authoringSequence: RemainingAuthoringSequence | null;
  pendingApprovals: PendingApproval[];
  importCarriedApprovals: ImportCarriedApproval[];
  applicableGates: SpecGate[];
  revisionSignOff: RevisionSignOffProjection | null;
  pendingBlock: AuthoringPendingBlock | null;
  nextAction: AuthoringNextAction;
  openComments: ProjectedOpenComments | null;
  openQuestions: Array<{
    id: string;
    handle: string;
    text: string;
    elementId: string | null;
  }>;
  assumptions: Array<{
    id: string;
    handle: string;
    text: string;
    disposition: SpecAssumptionRow["disposition"];
    elementId: string | null;
  }>;
  taskPlan: ReturnType<typeof taskPlanStatus>;
  /** Taken from the view schema so the tier cannot drift from what it parses. */
  draftHealth: PublishedSpecStatusView["draftHealth"];
  coverage: SpecCoverage;
  delivery: ReturnType<typeof projectDeliveryDisplay>;
  imported: PublishedSpecStatusView["imported"];
}

interface SpecLinkedWorkRollup {
  tickets: number;
  conversations: number;
  sessions: number;
  workflowExecutions: number;
  mergeJobs: number;
}

interface SpecElementStatusesView {
  requirements: Array<{
    elementId: string;
    status: ReturnType<typeof projectRequirementStatus>;
  }>;
  tasks: Array<{
    elementId: string;
    status: ReturnType<typeof projectTaskWorkStatus>;
  }>;
}

interface SpecElementReferenceStateView {
  observedRevision: number;
  observedPayloadHash: string | null;
  latestContainingRevision: number;
  latestPayloadHash: string;
}

async function loadProductionSpecRouteServices(projectPath: string) {
  const { createProductionSpecRouteServices } =
    await import("./service-factory");
  return createProductionSpecRouteServices(projectPath);
}

function createDefaultDeps(): SpecRouteDeps {
  const db = getStateDb();
  const specs = createSpecsRepo(db, getSharedWriteQueue());
  const review = createSpecReviewRepo(db);
  const delivery = createSpecDeliveryRepo(db);
  const links = createSpecLinksRepo(db);
  const eventsRepo = createSpecEventsRepo(db);
  const workflowEvents = createGraphWorkflowEventsRepo(db);
  const workflowStorage = createWorkflowStorageService();
  const measures = createMeasuresQuery({
    specs,
    events: eventsRepo,
    delivery,
    workflowEvents,
    async loadOriginMap(workflowDefinitionId, projectPath) {
      const record = await workflowStorage.get(
        scopeForTier("project", projectPath),
        workflowDefinitionId,
      );
      return record === null
        ? []
        : readSpecExecutionOriginMap(record.definition, (revisionId) =>
            specs.getRevisionSnapshot(revisionId),
          );
    },
    now: () => new Date().toISOString(),
  });
  const authoring = createAuthoringService({
    specs,
    review,
    links,
    events: createSpecEventsPublisher({
      appendInTransaction: (event) => eventsRepo.append(event),
    }),
  });
  // Verification reads the linked run through the SAME observe seam the
  // abandon coordinator acts through, so an orphan it reports is an orphan
  // the coordinator would agree it has to clear.
  const exportDeps = {
    specs,
    review,
    delivery,
    observeLinkedWorkflow: (target: SpecWorkflowCleanupTarget) =>
      createProductionSpecWorkflowCleanupPort().observe(target),
  };

  return {
    resolveProjectPath: defaultResolveProjectPath,
    listSpecs: (projectPath) => specs.listByProject(projectPath),
    resolveSpec: (projectPath, slug) => authoring.getSpec(projectPath, slug),
    listAliases: (specId) => specs.listAliases(specId),
    listRevisions: (specId) => specs.listRevisions(specId),
    getRevisionSnapshot: (revisionId) =>
      authoring.getRevisionSnapshot(revisionId),
    lintDraft: (specId, revisionId) => authoring.lintDraft(specId, revisionId),
    findApprovalsBySpecId: (specId) => review.findApprovalsBySpecId(specId),
    findCommentsByRevision: (revisionId) =>
      review.findCommentsByRevision(revisionId),
    findEventsBySpecId: (specId) => eventsRepo.findBySpecId(specId),
    findGateAdmissionsBySpecId: (specId) =>
      review.findGateAdmissionsBySpecId(specId),
    findLinksBySpecId: (specId) => links.findBySpecId(specId),
    async getLinkedTickets(projectPath, specId) {
      const services = await loadProductionSpecRouteServices(projectPath);
      return services.links.getSpecLinkedTickets({ specId });
    },
    findQuestionsBySpecId: (specId) => review.findQuestionsBySpecId(specId),
    findAssumptionsBySpecId: (specId) => review.findAssumptionsBySpecId(specId),
    findExecutionsBySpecId: (specId) => delivery.findExecutionsBySpecId(specId),
    findTaskClaimsBySpecId: (specId) => delivery.findTaskClaimsBySpecId(specId),
    findWorkflowEventsByExecution: (executionId) =>
      workflowEvents.findByExecution(executionId),
    async reconcileExecution(projectPath, execution) {
      const services = await loadProductionSpecRouteServices(projectPath);
      const result = await services.execution.getStatus(execution.id);
      return result.ok ? result.value : { execution, workflowStatus: null };
    },
    async ingestExecutionEvidenceBestEffort(projectPath, executionId) {
      const services = await loadProductionSpecRouteServices(projectPath);
      await services.ingestEvidenceBestEffort(executionId);
    },
    findCriterionDispositionsByExecution: (executionId) =>
      delivery.findCriterionDispositionsByExecution(executionId),
    findEvidenceByCriterionRevision: (criterionElementId, revisionId) =>
      delivery.findEvidenceByCriterionRevision(criterionElementId, revisionId),
    findProofVerdictsByCriterionRevision: (criterionElementId, revisionId) =>
      delivery.findProofVerdictsByCriterionRevision(
        criterionElementId,
        revisionId,
      ),
    findWaiverForCriterionRevision: (criterionElementId, revisionId) =>
      delivery.findWaiverForCriterionRevision(criterionElementId, revisionId),
    findWaiverById: (waiverId) => delivery.findWaiverById(waiverId),
    findWaiversByRevision: (revisionId) =>
      delivery.findWaiversByRevision(revisionId),
    async exportSpec(specId) {
      return renderCanonicalBundle(
        await loadSpecExportState(exportDeps, specId),
      );
    },
    async verifySpec(specId) {
      return verifyExportState(await loadSpecExportState(exportDeps, specId));
    },
    measureProject: (projectPath) => measures.forProject(projectPath),
  };
}

export async function resolveSpecProjectRoute(
  deps: Pick<SpecRouteDeps, "resolveProjectPath">,
  context: SpecRouteContext,
): Promise<RouteResolution<ResolvedSpecProjectRoute>> {
  const { name } = await context.params;
  const project = await resolveProjectOr404(deps, name ?? "");
  if (!project.ok) return project;

  return {
    ok: true,
    value: { projectName: name ?? "", projectPath: project.value },
  };
}

export async function resolveSpecRoute(
  deps: Pick<SpecRouteDeps, "resolveProjectPath" | "resolveSpec">,
  context: SpecRouteContext,
): Promise<RouteResolution<ResolvedSpecRoute>> {
  const project = await resolveSpecProjectRoute(deps, context);
  if (!project.ok) return project;

  const { slug } = await context.params;
  const spec = await deps.resolveSpec(project.value.projectPath, slug ?? "");
  if (spec === null) {
    return { ok: false, response: notFound("Spec not found") };
  }

  return {
    ok: true,
    value: { ...project.value, requestedSlug: slug ?? "", spec },
  };
}

const planPreviewBodySchema = z
  .object({
    revisionId: z.string().min(1).optional(),
    scope: executionScopeSchema.optional(),
    contextId: z.string().min(1).optional(),
  })
  .strict();

/**
 * The whole revision as a scope: every task selected, every criterion in
 * scope, nothing excluded. This serves only the read-only legacy preview;
 * active start reads its graph from an approved DeliveryPlanAttempt.
 */
function fullRevisionScope(
  slug: string,
  snapshot: SpecRevisionSnapshot,
): ExecutionScope {
  const plan = scopePlanFromRevision(slug, snapshot);
  return {
    selectedTaskIds: plan.tasks.map((task) => task.id),
    selectedCriterionIds: plan.criteria.map((criterion) => criterion.id),
    exclusionDispositions: [],
  };
}

async function loadCurrentState(
  deps: SpecRouteDeps,
  specId: string,
): Promise<CurrentSpecState> {
  const revisions = await deps.listRevisions(specId);
  const currentRevision = latestRevision(revisions);
  const currentApprovedRevision = latestRevision(
    revisions.filter((revision) => revision.state === "approved"),
  );
  const currentSnapshot =
    currentRevision === null
      ? null
      : await deps.getRevisionSnapshot(currentRevision.id);
  const currentApprovedSnapshot =
    currentApprovedRevision === null
      ? null
      : currentApprovedRevision.id === currentRevision?.id
        ? currentSnapshot
        : await deps.getRevisionSnapshot(currentApprovedRevision.id);
  const baseRevisionId = currentRevision?.basedOnRevisionId ?? null;
  const loadedById = new Map(
    [currentSnapshot, currentApprovedSnapshot].flatMap((snapshot) =>
      snapshot === null ? [] : [[snapshot.revision.id, snapshot] as const],
    ),
  );
  const readSnapshot = async (revisionId: string | null) =>
    revisionId === null
      ? null
      : (loadedById.get(revisionId) ??
        (await deps.getRevisionSnapshot(revisionId)));
  const baseSnapshot = await readSnapshot(baseRevisionId);
  const governanceBaseId = governanceBaseRevisionId(revisions, currentRevision);
  const governanceBaseSnapshot =
    governanceBaseId === baseRevisionId
      ? baseSnapshot
      : await readSnapshot(governanceBaseId);
  return {
    revisions,
    currentRevision,
    currentSnapshot,
    baseSnapshot,
    governanceBaseSnapshot,
    currentApprovedSnapshot,
  };
}

/**
 * The approval authority for the current revision. Approvals accumulate
 * without bound while the revisions they name do not, so the snapshots are
 * read once per distinct revision rather than once per approval.
 */
async function loadApprovalApplicability(
  deps: SpecRouteDeps,
  state: CurrentSpecState,
  approvals: readonly SpecApprovalRow[],
): Promise<ApprovalApplicability> {
  const current = state.currentSnapshot;
  if (current === null) {
    return () => false;
  }
  const known = new Map(
    [state.currentSnapshot, state.baseSnapshot, state.governanceBaseSnapshot]
      .filter((snapshot): snapshot is SpecRevisionSnapshot => snapshot !== null)
      .map((snapshot) => [snapshot.revision.id, snapshot]),
  );
  const unread = [
    ...new Set(approvals.map((approval) => approval.revision_id)),
  ].filter((revisionId) => !known.has(revisionId));
  for (const [revisionId, snapshot] of await Promise.all(
    unread.map(
      async (revisionId) =>
        [revisionId, await deps.getRevisionSnapshot(revisionId)] as const,
    ),
  )) {
    if (snapshot !== null) known.set(revisionId, snapshot);
  }
  const rows = new Map(
    [...known].map(([revisionId, snapshot]) => [
      revisionId,
      toDiffRows(snapshot),
    ]),
  );
  return createApprovalApplicability({
    revisionId: current.revision.id,
    ancestorRevisionIds: ancestorIds(state.revisions, current.revision.id),
    revisionRows: rows.get(current.revision.id) ?? toDiffRows(current),
    rowsForRevision: (revisionId) => rows.get(revisionId) ?? null,
  });
}

function elementCounts(snapshot: SpecRevisionSnapshot | null) {
  const counts = { requirements: 0, criteria: 0, decisions: 0, tasks: 0 };
  for (const { element } of snapshot?.elements ?? []) {
    switch (element.kind) {
      case "requirement":
        counts.requirements += 1;
        break;
      case "criterion":
        counts.criteria += 1;
        break;
      case "decision":
        counts.decisions += 1;
        break;
      case "task":
        counts.tasks += 1;
        break;
      case "section":
        break;
    }
  }
  return counts;
}

/**
 * The criteria the coverage ratio is computed over. The plan status reports
 * the ids it excludes from the same set, so the two readings cannot disagree
 * about which criterion a revision carries.
 */
function currentCriterionElementIds(
  snapshot: SpecRevisionSnapshot | null,
): Set<string> {
  return new Set(
    (snapshot?.elements ?? [])
      .filter(({ element }) => element.kind === "criterion")
      .map(({ element }) => element.id),
  );
}

function coverage(snapshot: SpecRevisionSnapshot | null): SpecCoverage {
  const criteria = currentCriterionElementIds(snapshot);
  const covered = new Set<string>();
  for (const { version } of snapshot?.elements ?? []) {
    if (version.payload.kind !== "task") continue;
    for (const criterionId of version.payload.coveredCriterionElementIds) {
      if (criteria.has(criterionId)) covered.add(criterionId);
    }
  }
  const totalCriteria = criteria.size;
  return {
    coveredCriteria: covered.size,
    totalCriteria,
    percentage:
      totalCriteria === 0
        ? 0
        : Math.round((covered.size / totalCriteria) * 100),
  };
}

function deliveryCriteria(
  deps: SpecRouteDeps,
  currentApprovedSnapshot: SpecRevisionSnapshot | null,
  executions: readonly SpecExecutionRow[],
): IdentifiedDeliveryCriterion[] {
  const currentApprovedRevisionId = currentApprovedSnapshot?.revision.id;
  const externalDelivery =
    currentApprovedSnapshot?.revision.externalDelivery ?? null;
  const deliveredDispositions = executions
    .filter(
      (execution) =>
        execution.state === "delivered" &&
        execution.revision_id === currentApprovedRevisionId,
    )
    .flatMap((execution) =>
      deps.findCriterionDispositionsByExecution(execution.id),
    );
  return (
    currentApprovedSnapshot?.elements
      .filter(({ element }) => element.kind === "criterion")
      .map(({ element }) => {
        const waiver = deps.findWaiverForCriterionRevision(
          element.id,
          currentApprovedSnapshot.revision.id,
        );
        if (waiver?.stale === 0) {
          return { criterionElementId: element.id, state: "waived" as const };
        }

        const proven = deliveredDispositions.some(
          (disposition) =>
            disposition.criterion_element_id === element.id &&
            (disposition.disposition === "in_scope" ||
              disposition.disposition === "delivered_elsewhere"),
        );
        if (proven) {
          return {
            criterionElementId: element.id,
            state: "proven_and_merged" as const,
          };
        }

        // The imported spec's own testimony that this content shipped
        // elsewhere. It is read from the revision the criterion belongs to, so
        // an amendment — which forks a revision carrying no record — drops back
        // to pending until delivery is proven here.
        if (externalDelivery !== null) {
          return {
            criterionElementId: element.id,
            state: "delivered_externally" as const,
          };
        }

        return { criterionElementId: element.id, state: "pending" as const };
      }) ?? []
  );
}

function executionScopeCriterionIds(
  execution: SpecExecutionRow | null,
  revisionId: string | undefined,
): ReadonlySet<string> | null {
  if (execution === null || execution.revision_id !== revisionId) return null;

  try {
    const scope = executionScopeSchema.safeParse(
      JSON.parse(execution.scope_json),
    );
    return scope.success ? new Set(scope.data.selectedCriterionIds) : null;
  } catch {
    return null;
  }
}

function linkedWork(links: readonly SpecLinkRow[]): SpecLinkedWorkRollup {
  const rollup: SpecLinkedWorkRollup = {
    tickets: 0,
    conversations: 0,
    sessions: 0,
    workflowExecutions: 0,
    mergeJobs: 0,
  };
  for (const link of links) {
    switch (link.object_kind) {
      case "ticket":
        rollup.tickets += 1;
        break;
      case "conversation":
        rollup.conversations += 1;
        break;
      case "session":
        rollup.sessions += 1;
        break;
      case "workflow_execution":
        rollup.workflowExecutions += 1;
        break;
      case "merge_job":
        rollup.mergeJobs += 1;
        break;
    }
  }
  return rollup;
}

function latestApprovalValidity(
  approvals: readonly SpecApprovalRow[],
  subjectKind: SpecApprovalRow["subject_kind"],
  elementId: string | null,
): SpecApprovalRow["validity"] | null {
  const matching = approvals
    .filter(
      (approval) =>
        approval.subject_kind === subjectKind &&
        approval.element_id === elementId,
    )
    .sort((left, right) =>
      left.granted_at === right.granted_at
        ? left.id.localeCompare(right.id)
        : left.granted_at.localeCompare(right.granted_at),
    );
  return matching.at(-1)?.validity ?? null;
}

function criterionProofState(
  deps: SpecRouteDeps,
  criterionElementId: string,
  revision: SpecRevisionSnapshot["revision"],
): RequirementStatusInput["criteria"][number]["proof"] {
  const waiver = deps.findWaiverForCriterionRevision(
    criterionElementId,
    revision.id,
  );
  if (waiver?.stale === 0) return "waived";
  if (
    deps
      .findProofVerdictsByCriterionRevision(criterionElementId, revision.id)
      .some((verdict) => verdict.stale_at === null)
  ) {
    return "proven";
  }
  // Same order the delivery projection uses: work this system proved wins, and
  // otherwise the revision's own external-delivery record explains the
  // criterion. Read off the revision, so an amendment carrying no record drops
  // its criteria back to pending.
  if (revision.externalDelivery !== null) return "delivered_externally";
  return "pending";
}

function criterionOutlineStatus(
  deps: SpecRouteDeps,
  snapshot: SpecRevisionSnapshot,
  criterion: SpecRevisionElement,
  requirementTaskRows: readonly SpecRevisionElement[],
): SpecShowOutlineView["requirements"][number]["criteria"][number]["status"] {
  return {
    coverage: requirementTaskRows.some(
      ({ version }) =>
        version.payload.kind === "task" &&
        version.payload.coveredCriterionElementIds.includes(
          criterion.element.id,
        ),
    )
      ? "covered"
      : "uncovered",
    proof: criterionProofState(deps, criterion.element.id, snapshot.revision),
  };
}

function requirementStatus(
  deps: SpecRouteDeps,
  snapshot: SpecRevisionSnapshot,
  requirement: SpecRevisionElement,
  approvals: readonly SpecApprovalRow[],
  related?: {
    readonly criteria: readonly SpecRevisionElement[];
    readonly tasks: readonly SpecRevisionElement[];
  },
): ReturnType<typeof projectRequirementStatus> {
  const criteria =
    related?.criteria ??
    snapshot.elements.filter(
      ({ element }) =>
        element.kind === "criterion" &&
        element.parentElementId === requirement.element.id,
    );
  const taskRows =
    related?.tasks ??
    snapshot.elements.filter(
      ({ version }) =>
        version.payload.kind === "task" &&
        version.payload.tracedRequirementElementIds.includes(
          requirement.element.id,
        ),
    );
  return projectRequirementStatus({
    approvalValidity: latestApprovalValidity(
      approvals,
      "requirement",
      requirement.element.id,
    ),
    criteria: criteria.map((criterion) => {
      const status = criterionOutlineStatus(
        deps,
        snapshot,
        criterion,
        taskRows,
      );
      return {
        covered: status.coverage === "covered",
        proof: status.proof,
      };
    }),
  });
}

function outlineApprovalStatus(
  approvals: readonly SpecApprovalRow[],
  applies: ApprovalApplicability,
  subjectKind: "requirement" | "decision",
  elementId: string,
): "valid" | "stale" | "closed" | "unapproved" {
  if (approvalHeld(approvals, applies, subjectKind, elementId)) return "valid";
  const latest = latestApprovalValidity(approvals, subjectKind, elementId);
  return latest === "stale" || latest === "closed" ? latest : "unapproved";
}

function buildElementStatuses(
  deps: SpecRouteDeps,
  snapshot: SpecRevisionSnapshot | null,
  approvals: readonly SpecApprovalRow[],
  executions: readonly SpecExecutionRow[],
  claims: readonly SpecTaskClaimRow[],
): SpecElementStatusesView {
  if (snapshot === null) {
    return { requirements: [], tasks: [] };
  }

  const snapshotRevisionId = snapshot.revision.id;
  const snapshotExecutions = executions.filter(
    (execution) => execution.revision_id === snapshotRevisionId,
  );
  const executionIds = new Set(
    snapshotExecutions.map((execution) => execution.id),
  );
  const claimByTaskId = new Map<string, SpecTaskClaimRow>();
  for (const claim of claims) {
    if (claim.execution_id !== null && !executionIds.has(claim.execution_id)) {
      continue;
    }
    claimByTaskId.set(claim.task_element_id, claim);
  }

  const requirements = snapshot.elements
    .filter(({ element }) => element.kind === "requirement")
    .map((row) => ({
      elementId: row.element.id,
      status: requirementStatus(deps, snapshot, row, approvals),
    }));

  const tasks = snapshot.elements
    .filter(({ element }) => element.kind === "task")
    .map((row) => {
      const latestClaim = claimByTaskId.get(row.element.id);
      const executionEvents = snapshotExecutions.flatMap((execution) => {
        if (execution.workflow_execution_id === null) return [];
        return deps
          .findWorkflowEventsByExecution(execution.workflow_execution_id)
          .flatMap(({ event }) =>
            event.type === "graph-workflow-task-status" &&
            event.taskId === compiledWorkflowTaskId(row.element.id)
              ? [{ status: event.status }]
              : [],
          );
      });
      return {
        elementId: row.element.id,
        status: projectTaskWorkStatus({
          executionEvents,
          latestClaim:
            latestClaim === undefined
              ? null
              : {
                  status: latestClaim.status,
                  evidenceIds: z
                    .array(z.string().min(1))
                    .parse(JSON.parse(latestClaim.evidence_ids_json)),
                },
        }),
      };
    });

  return { requirements, tasks };
}

/**
 * Whether this spec entered the system by import. Read from the `import`-basis
 * gate admissions over the current approved revision's lineage rather than
 * from a stored flag: the admissions ARE the record of how the revision came
 * to be past its authoring gates, and reading them over the lineage is what
 * keeps an amendment — which writes no admission of its own — from laundering
 * the origin of the content it forked (R9.1).
 */
function importedProvenance(
  revisions: readonly SpecRevision[],
  currentApprovedRevisionId: string | undefined,
  admissions: readonly SpecGateAdmissionRow[],
): boolean {
  if (currentApprovedRevisionId === undefined) return false;
  // A snapshot whose revision the listing does not carry has no walkable
  // ancestry, so provenance is read from that revision alone rather than
  // failing the whole status read over a lineage question.
  const lineage = revisions.some(({ id }) => id === currentApprovedRevisionId)
    ? ancestorIds(revisions, currentApprovedRevisionId)
    : new Set<string>();
  lineage.add(currentApprovedRevisionId);
  return admissions.some(
    (admission) =>
      admission.basis === "import" &&
      admission.revision_id !== null &&
      lineage.has(admission.revision_id),
  );
}

function phase(
  spec: Spec,
  revisions: readonly SpecRevision[],
  executions: readonly SpecExecutionRow[],
  criteria: readonly DeliveryCriterion[],
): SpecPhaseProjection {
  return projectSpecPhase({
    abandoned: spec.abandonedAt !== null,
    revisions: revisions.map((revision) => ({
      state: revision.state,
      authoringStage: revision.authoringStage,
    })),
    executionStates: executions.map((execution) => execution.state),
    deliveryCriteria: [...criteria],
    deliveryPending: executions.some(
      (execution) =>
        execution.state === "definition_review" ||
        execution.state === "running",
    ),
  });
}

function handlesByElementId(
  spec: Spec,
  snapshot: SpecRevisionSnapshot,
): Map<string, string> {
  return new Map(
    toLintSnapshot(spec, snapshot).elements.map((element) => [
      element.id,
      element.handle,
    ]),
  );
}

/**
 * Attach each element's handle to a snapshot for the read projections, so an
 * agent reading the spec learns the vocabulary it must quote back. Elements
 * with no handle report null rather than echoing their element id as one.
 */
function toSnapshotView(
  snapshot: SpecRevisionSnapshot,
): SpecRevisionSnapshotView {
  return {
    revision: snapshot.revision,
    elements: snapshot.elements.map((row) => ({
      ...row,
      handle: elementHandleInSnapshot(snapshot, row.element.id),
    })),
  };
}

function taskPlanStatus(snapshot: SpecRevisionSnapshot | null) {
  if (snapshot === null) return [];
  const handles = new Map(
    snapshot.elements.map((entry) => [
      entry.element.id,
      elementHandle(snapshot, entry),
    ]),
  );
  const criterionIds = currentCriterionElementIds(snapshot);
  return snapshot.elements.flatMap((entry) => {
    const payload = entry.version.payload;
    if (payload.kind !== "task") return [];
    const handle = handles.get(entry.element.id) ?? entry.element.id;
    const covered = payload.coveredCriterionElementIds;
    return [
      {
        elementId: entry.element.id,
        handle,
        title: payload.title,
        // A handle only exists for an element this revision carries, and the
        // ones it does not carry are reported as the ids they are rather than
        // sitting in the handle field looking like content.
        dependsOn: payload.dependsOnTaskElementIds
          .filter((elementId) => handles.has(elementId))
          .map((elementId) => handles.get(elementId) ?? elementId),
        unresolvedDependsOnTaskElementIds: payload.dependsOnTaskElementIds
          .filter((elementId) => !handles.has(elementId))
          .sort(),
        laneGroup: payload.laneGroup ?? null,
        executionLane: payload.executionLane ?? null,
        touchedPaths: payload.touchedPaths ?? [],
        criterionCoverage: covered
          .filter((elementId) => criterionIds.has(elementId))
          .map((elementId) => handles.get(elementId) ?? elementId),
        unresolvedCriterionElementIds: covered
          .filter((elementId) => !criterionIds.has(elementId))
          .sort(),
      },
    ];
  });
}

/**
 * Project a stored run into the domain shape (R24.1). The JSON columns become
 * the objects they hold, so a reader never parses a payload a second time, and
 * the revision's number rides alongside its id.
 */
function toExecutionView(
  execution: SpecExecutionRow,
  revisionNumberById: ReadonlyMap<string, number>,
  deliveryProjection: CriterionDeliveryProjection[],
): SpecExecutionView {
  const scope = parseExecutionScope(execution.scope_json);
  return {
    id: execution.id,
    specId: execution.spec_id,
    revisionId: execution.revision_id,
    revisionNumber: revisionNumberById.get(execution.revision_id) ?? null,
    state: execution.state,
    workflowDefinitionId: execution.workflow_definition_id,
    workflowDefinitionRevision: execution.workflow_definition_revision,
    workflowExecutionId: execution.workflow_execution_id,
    definitionApprovalRequired:
      definitionApprovalRequiredFromExecution(execution),
    scope,
    sessionName: execution.session_name,
    deliveredAt: execution.delivered_at,
    abandonedReason: execution.abandoned_reason,
    createdAt: execution.created_at,
    updatedAt: execution.updated_at,
    deliveryProjection,
  };
}

function definitionApprovalRequiredFromExecution(
  execution: SpecExecutionRow,
): boolean | null {
  const dial = execution.execution_start_dial;
  return dial === null || dial === undefined ? null : dial === "gate";
}

/**
 * The start receipt's run: the same domain shape as `toExecutionView` minus
 * the delivery projection, with the pinned revision's number supplied by the
 * start result itself so the mutation needs no second read.
 */
function toStartedExecutionView(
  execution: SpecExecutionRow,
  revisionNumber: number,
): SpecStartedExecutionView {
  return {
    id: execution.id,
    specId: execution.spec_id,
    revisionId: execution.revision_id,
    revisionNumber,
    state: execution.state,
    workflowDefinitionId: execution.workflow_definition_id,
    workflowDefinitionRevision: execution.workflow_definition_revision,
    workflowExecutionId: execution.workflow_execution_id,
    definitionApprovalRequired:
      definitionApprovalRequiredFromExecution(execution),
    scope: parseExecutionScope(execution.scope_json),
    sessionName: execution.session_name,
    deliveredAt: execution.delivered_at,
    abandonedReason: execution.abandoned_reason,
    createdAt: execution.created_at,
    updatedAt: execution.updated_at,
  };
}

/**
 * The prior-run rule needs by-id lookups; the detail route already holds every
 * execution and its dispositions in memory, so the adapter closes over those
 * instead of issuing new repo reads.
 */
type PriorRunLookup = Pick<
  SpecDeliveryRepo,
  "findExecutionById" | "findCriterionDisposition"
>;

/**
 * The per-criterion proof standing the merge-gate panel renders (F26),
 * computed over the run's pinned revision with the gate's own precedence and
 * validity rules: a valid pinned-revision waiver wins even on a delivered run;
 * external delivery must satisfy the gate's prior-run rule
 * (`isEarlierMergedDelivery`); and a verdict counts only while it is non-stale
 * AND its cited evidence still resolves — `stale_at` alone is not proof,
 * because only the gate re-resolves evidence and Studio must not claim more
 * than the gate would honor.
 */
function buildDeliveryProjection(
  deps: SpecRouteDeps,
  execution: SpecExecutionRow,
  pinnedSnapshot: SpecRevisionSnapshot | undefined,
  dispositions: readonly SpecCriterionDispositionRow[],
  priorRuns: PriorRunLookup,
): CriterionDeliveryProjection[] {
  if (pinnedSnapshot === undefined) return [];
  const scope = parseExecutionScope(execution.scope_json);
  if (scope === null) return [];
  const criteriaById = new Map(
    pinnedSnapshot.elements.flatMap((entry) =>
      entry.version.payload.kind === "criterion"
        ? [[entry.element.id, entry.version.payload] as const]
        : [],
    ),
  );
  return scope.selectedCriterionIds.flatMap((criterionElementId) => {
    const payload = criteriaById.get(criterionElementId);
    if (payload === undefined) return [];
    return [
      {
        criterionElementId,
        handle:
          elementHandleInSnapshot(pinnedSnapshot, criterionElementId) ??
          criterionElementId,
        strategyKinds: payload.validationStrategy.kinds,
        proofState: criterionDeliveryProofState(
          deps,
          execution,
          criterionElementId,
          dispositions,
          priorRuns,
        ),
      },
    ];
  });
}

function criterionDeliveryProofState(
  deps: SpecRouteDeps,
  execution: SpecExecutionRow,
  criterionElementId: string,
  dispositions: readonly SpecCriterionDispositionRow[],
  priorRuns: PriorRunLookup,
): CriterionDeliveryProjection["proofState"] {
  const disposition = dispositions.find(
    (row) => row.criterion_element_id === criterionElementId,
  );
  // The gate's disposition-owned waiver rule (`evaluateCriterion`): a waiver
  // counts only when this run's disposition is `waived` AND its linked waiver
  // resolves to a non-stale row for the pinned spec/revision/criterion. A
  // merely-granted waiver that no disposition links is one the gate refuses,
  // so Studio must not count it either; an invalid link falls through to the
  // verdict evaluation and honestly reads awaiting_proof.
  if (disposition?.disposition === "waived") {
    const waiver =
      disposition.waiver_id === null
        ? null
        : deps.findWaiverById(disposition.waiver_id);
    if (isWaiverValidForExecution(waiver, execution, criterionElementId)) {
      return "waived";
    }
  }
  if (
    disposition?.disposition === "delivered_elsewhere" &&
    isEarlierMergedDelivery(priorRuns, execution, disposition)
  ) {
    return "delivered_elsewhere";
  }
  if (execution.state === "delivered") return "proven_merged";
  const evidenceIds = new Set(
    deps
      .findEvidenceByCriterionRevision(
        criterionElementId,
        execution.revision_id,
      )
      .map((row) => row.id),
  );
  const hasResolvableVerdict = deps
    .findProofVerdictsByCriterionRevision(
      criterionElementId,
      execution.revision_id,
    )
    .some(
      (verdict) =>
        verdict.stale_at === null &&
        verdictEvidenceResolves(verdict, evidenceIds),
    );
  return hasResolvableVerdict ? "proof_recorded" : "awaiting_proof";
}

function verdictEvidenceResolves(
  verdict: SpecProofVerdictRow,
  resolvableEvidenceIds: ReadonlySet<string>,
): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(verdict.evidence_ids_json);
  } catch {
    return false;
  }
  const ids = z.array(z.string().min(1)).safeParse(raw);
  if (!ids.success) return false;
  return ids.data.every((id) => resolvableEvidenceIds.has(id));
}

/**
 * The spec's origin import, read back from its durable event. First rather than
 * last: an import creates the spec and can never run against an existing one,
 * so the earliest such row is the origin and a later one could only be a
 * duplicate record of it.
 */
function importRecordView(
  events: readonly SpecEventRow[],
  specId: string,
): SpecImportRecordView | null {
  const imported = events.find((event) => event.event_type === "spec_imported");
  if (imported === undefined) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(imported.payload_json);
  } catch {
    raw = undefined;
  }
  const payload = specImportedEventPayloadSchema.safeParse(raw);
  if (!payload.success) {
    // The provenance is still true — the admissions carry it — but its detail
    // is unreadable, so history says nothing rather than guessing at counts.
    logger.warn("specs.routes.detail.import_record_unreadable", {
      specId,
      eventId: imported.id,
    });
    return null;
  }

  return {
    occurredAt: imported.occurred_at,
    sourceLabel: payload.data.source.label,
    counts: payload.data.counts,
  };
}

function parseExecutionScope(raw: string): ExecutionScope | null {
  try {
    const parsed = executionScopeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toDiffRevisionRef(revision: SpecRevision): SpecDiffView["to"] {
  return {
    revisionId: revision.id,
    number: revision.number,
    state: revision.state,
  };
}

function toGateAdmissionView(
  admission: SpecGateAdmissionRow,
  revisionNumberById: ReadonlyMap<string, number>,
): SpecGateAdmissionView {
  return {
    id: admission.id,
    specId: admission.spec_id,
    gate: admission.gate,
    basis: admission.basis,
    approvalId: admission.approval_id,
    revisionId: admission.revision_id,
    revisionNumber:
      admission.revision_id === null
        ? null
        : (revisionNumberById.get(admission.revision_id) ?? null),
    executionId: admission.execution_id,
    actor: parseProvenance(admission.actor_json),
    createdAt: admission.created_at,
  };
}

function toQuestionView(row: SpecQuestionRow): SpecQuestionView {
  return {
    id: row.id,
    number: row.number,
    handle: formatBareElementHandle({ kind: "question", number: row.number }),
    elementId: row.element_id,
    text: row.text,
    status: row.status,
    answer: row.answer,
    answeredAt: row.answered_at,
    provenance: parseProvenance(row.provenance_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAssumptionView(row: SpecAssumptionRow): SpecAssumptionView {
  return {
    id: row.id,
    number: row.number,
    handle: formatBareElementHandle({ kind: "assumption", number: row.number }),
    elementId: row.element_id,
    text: row.text,
    disposition: row.disposition,
    disposedAt: row.disposed_at,
    proposedBy: parseProvenance(row.proposed_by_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function buildStatus(
  deps: SpecRouteDeps,
  spec: Spec,
  state: CurrentSpecState,
  loadedExecutions?: ReconciledExecutions,
  loadedAdmissions?: readonly SpecGateAdmissionRow[],
): Promise<SpecStatusView> {
  const revisionId = state.currentRevision?.id ?? null;
  const approvals = deps.findApprovalsBySpecId(spec.id);
  const reconciled =
    loadedExecutions ?? (await loadReconciledExecutions(deps, spec));
  const executions = reconciled.rows;
  const selectedExecution = currentExecution(executions);
  // Authoring-gate admissions live on the current document revision and
  // execution-scoped ones on the selected run's pinned revision, but the
  // whole spec's admissions are read so a gate that an amendment reset can
  // still report where its earlier admission happened.
  const revisionNumberById = new Map(
    state.revisions.map((candidate) => [candidate.id, candidate.number]),
  );
  const admissions =
    loadedAdmissions ?? deps.findGateAdmissionsBySpecId(spec.id);
  const applies = await loadApprovalApplicability(deps, state, approvals);
  // The revision an import created, read even when it is no longer the
  // governance base: the elements nobody has touched since the import are
  // still admitted by it alone, and the status read must owe exactly what
  // sign-off owes.
  const importBaselineRevision = importBaselineRevisionId(admissions);
  const importBaselineSnapshot =
    importBaselineRevision === null
      ? null
      : await deps.getRevisionSnapshot(importBaselineRevision);
  const importBaselineRows =
    importBaselineSnapshot === null ? null : toDiffRows(importBaselineSnapshot);
  // Sign-off is blocked by unresolved blocking threads and sign-off lint as
  // well as by outstanding subjects, so the status projection reads the same
  // three sources the sign-off transition does. The findings tier rides this
  // same read rather than adding a second one: status stays one round trip.
  const health = draftHealth(
    revisionId === null ? [] : await deps.lintDraft(spec.id, revisionId),
  );
  const signOffFindings =
    health.groups.find((group) => group.severity === "blocks_signoff")
      ?.findings ?? [];
  const revisionComments =
    revisionId === null ? [] : deps.findCommentsByRevision(revisionId);
  const statusHandles =
    state.currentSnapshot === null
      ? new Map<string, string>()
      : handlesByElementId(spec, state.currentSnapshot);
  const projection = authoringReviewProjection({
    policy: spec.gatePolicy,
    snapshot: state.currentSnapshot,
    governanceBaseSnapshot: state.governanceBaseSnapshot,
    importBaselineRows,
    approvals,
    admissions,
    currentExecution: selectedExecution,
    revisionNumberById,
    applies,
    blockingThreads: revisionComments
      .filter((comment) => comment.blocking === 1)
      .map((comment) => ({
        handle: comment.thread_id,
        resolved: comment.resolution !== "open",
      })),
    signOffFindings,
    openComments: revisionComments
      .filter((comment) => comment.resolution === "open")
      .map((comment) => ({
        elementId: comment.element_id,
        handle: statusHandles.get(comment.element_id) ?? null,
        blocking: comment.blocking === 1,
      })),
    specSlug: spec.slug,
  });
  const criteria = deliveryCriteria(
    deps,
    state.currentApprovedSnapshot,
    executions,
  );
  const deliveryScopeCriterionIds = executionScopeCriterionIds(
    selectedExecution,
    state.currentApprovedSnapshot?.revision.id,
  );
  const displayCriteria =
    deliveryScopeCriterionIds === null
      ? criteria
      : criteria.filter(({ criterionElementId }) =>
          deliveryScopeCriterionIds.has(criterionElementId),
        );
  return {
    specId: spec.id,
    slug: spec.slug,
    phase: phase(spec, state.revisions, executions, criteria),
    executions: executions.map((run) => ({
      id: run.id,
      state: run.state,
      workflowDefinitionId: run.workflow_definition_id,
      workflowExecutionId: run.workflow_execution_id,
      workflowStatus: reconciled.laneStatusById.get(run.id) ?? null,
    })),
    gates: projection.gates,
    authoringSequence:
      state.currentSnapshot === null
        ? null
        : draftAuthoringSequence({
            policy: spec.gatePolicy,
            snapshot: state.currentSnapshot,
            governanceBaseSnapshot: state.governanceBaseSnapshot,
          }),
    pendingApprovals: projection.pendingApprovals,
    importCarriedApprovals: projection.importCarriedApprovals,
    applicableGates: projection.applicableGates,
    revisionSignOff: projection.revisionSignOff,
    pendingBlock: projection.pendingBlock,
    nextAction: projection.nextAction,
    openComments: projection.openComments,
    openQuestions: deps
      .findQuestionsBySpecId(spec.id)
      .filter((question) => question.status === "open")
      .map((question) => ({
        id: question.id,
        handle: formatBareElementHandle({
          kind: "question",
          number: question.number,
        }),
        text: question.text,
        elementId: question.element_id,
      })),
    assumptions: deps.findAssumptionsBySpecId(spec.id).map((assumption) => ({
      id: assumption.id,
      handle: formatBareElementHandle({
        kind: "assumption",
        number: assumption.number,
      }),
      text: assumption.text,
      disposition: assumption.disposition,
      elementId: assumption.element_id,
    })),
    taskPlan: taskPlanStatus(state.currentSnapshot),
    draftHealth:
      revisionId === null
        ? null
        : {
            revisionId,
            total: health.total,
            blocking: health.blocking,
            counts: health.counts.map((entry) => ({ ...entry })),
            top: statusDraftHealthTop(health.ordered),
          },
    coverage: coverage(state.currentSnapshot),
    delivery: projectDeliveryDisplay(displayCriteria),
    imported: importedProvenance(
      state.revisions,
      state.currentApprovedSnapshot?.revision.id,
      admissions,
    ),
  };
}

function statusDraftHealthTop(findings: readonly LintFinding[]): LintFinding[] {
  const top = findings.slice(0, DRAFT_HEALTH_TOP_FINDINGS);
  const emptyDesign = findings.find(
    ({ ruleId }) => ruleId === "9.13.design-stage-without-design-content",
  );
  if (
    emptyDesign === undefined ||
    top.some(({ ruleId }) => ruleId === emptyDesign.ruleId)
  ) {
    return top;
  }
  return [...top, emptyDesign];
}

/**
 * The reconciled rows plus each active run's live lane status keyed by
 * execution id — kept side by side so the row-consuming projections stay
 * untouched while the status facet can report the lane's real position.
 */
interface ReconciledExecutions {
  rows: SpecExecutionRow[];
  laneStatusById: ReadonlyMap<string, SpecWorkflowLaneStatus | null>;
}

async function loadReconciledExecutions(
  deps: SpecRouteDeps,
  spec: Spec,
): Promise<ReconciledExecutions> {
  const reconciled = await Promise.all(
    deps
      .findExecutionsBySpecId(spec.id)
      .map((execution) =>
        execution.state === "definition_review" || execution.state === "running"
          ? deps.reconcileExecution(spec.projectPath, execution)
          : Promise.resolve({ execution, workflowStatus: null }),
      ),
  );
  return {
    rows: reconciled.map((entry) => entry.execution),
    laneStatusById: new Map(
      reconciled.map((entry) => [entry.execution.id, entry.workflowStatus]),
    ),
  };
}

async function buildSummary(deps: SpecRouteDeps, spec: Spec) {
  const state = await loadCurrentState(deps, spec.id);
  const reconciled = await loadReconciledExecutions(deps, spec);
  const status = await buildStatus(deps, spec, state, reconciled);
  // A consulted gate stays pending after its last subject approval until a
  // human signs the revision off, so the outstanding sign-off is one more
  // human act the inventory owes — counting only subjects made a revision that
  // still needs a human vanish from the "needs you" rollups.
  const signOffOutstanding =
    status.revisionSignOff !== null &&
    status.revisionSignOff.state !== "signed_off";
  const pendingApprovalCount =
    status.pendingApprovals.length + (signOffOutstanding ? 1 : 0);
  return {
    spec,
    phase: status.phase,
    currentRevision: state.currentRevision,
    counts: elementCounts(state.currentSnapshot),
    pendingApprovalCount,
    approvalState: pendingApprovalCount === 0 ? "complete" : "pending",
    delivery: status.delivery,
    linkedWork: linkedWork(deps.findLinksBySpecId(spec.id)),
    imported: status.imported,
  };
}

function outlineCounts(
  snapshot: SpecRevisionSnapshot | null,
): SpecShowOutlineView["counts"] {
  const counts: SpecShowOutlineView["counts"] = {
    requirements: 0,
    criteria: 0,
    decisions: 0,
    tasks: 0,
    sections: 0,
  };
  for (const { element } of snapshot?.elements ?? []) {
    switch (element.kind) {
      case "requirement":
        counts.requirements += 1;
        break;
      case "criterion":
        counts.criteria += 1;
        break;
      case "decision":
        counts.decisions += 1;
        break;
      case "task":
        counts.tasks += 1;
        break;
      case "section":
        counts.sections += 1;
        break;
    }
  }
  return counts;
}

function outlineDisclosure(total: number, returned: number) {
  return { total, returned, truncated: returned < total };
}

function outlineSummary(text: string): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= SPEC_OUTLINE_SUMMARY_LIMIT) return singleLine;
  return `${singleLine.slice(0, SPEC_OUTLINE_SUMMARY_LIMIT - 1)}…`;
}

function outlineIdentity(
  row: SpecRevisionElement,
  handle: string,
  summary: string,
) {
  return {
    handle,
    elementId: row.element.id,
    elementVersion: row.version.elementVersion,
    summary: outlineSummary(summary),
  };
}

interface AddressableOutlineRow {
  readonly row: SpecRevisionElement;
  readonly handle: string;
}

function addressableOutlineRow(
  specSlug: string,
  snapshot: SpecRevisionSnapshot,
  row: SpecRevisionElement,
): AddressableOutlineRow | null {
  const handle = elementHandleInSnapshot(snapshot, row.element.id);
  return handle !== null && isWellFormedElementHandle(handle, specSlug)
    ? { row, handle }
    : null;
}

async function buildOutline(
  deps: SpecRouteDeps,
  spec: Spec,
): Promise<SpecShowOutlineView> {
  const state = await loadCurrentState(deps, spec.id);
  const reconciled = await loadReconciledExecutions(deps, spec);
  const snapshot = state.currentSnapshot;
  const counts = outlineCounts(snapshot);
  const outlinePhase = phase(
    spec,
    state.revisions,
    reconciled.rows,
    deliveryCriteria(deps, state.currentApprovedSnapshot, reconciled.rows),
  );
  const empty = outlineDisclosure(0, 0);
  if (snapshot === null) {
    return {
      spec: { id: spec.id, slug: spec.slug, name: spec.name },
      revision: null,
      phase: outlinePhase,
      counts,
      requirements: [],
      decisions: [],
      tasks: [],
      disclosure: {
        requirements: empty,
        criteria: empty,
        decisions: empty,
        tasks: empty,
        sections: empty,
        next: `cctl spec show ${spec.slug} --rendered`,
      },
    };
  }

  const ordered = [...snapshot.elements].sort((left, right) =>
    left.version.position === right.version.position
      ? left.element.id.localeCompare(right.element.id)
      : left.version.position - right.version.position,
  );
  const criteriaByRequirement = new Map<string, SpecRevisionElement[]>();
  const tasksByRequirement = new Map<string, SpecRevisionElement[]>();
  for (const row of ordered) {
    if (
      row.version.payload.kind === "criterion" &&
      row.element.parentElementId !== null
    ) {
      const rows = criteriaByRequirement.get(row.element.parentElementId) ?? [];
      rows.push(row);
      criteriaByRequirement.set(row.element.parentElementId, rows);
    }
    if (row.version.payload.kind === "task") {
      for (const requirementId of row.version.payload
        .tracedRequirementElementIds) {
        const rows = tasksByRequirement.get(requirementId) ?? [];
        rows.push(row);
        tasksByRequirement.set(requirementId, rows);
      }
    }
  }
  const addressable = (row: SpecRevisionElement) =>
    addressableOutlineRow(spec.slug, snapshot, row);
  const requirementEntries = ordered
    .filter(({ version }) => version.payload.kind === "requirement")
    .flatMap((row) => {
      const entry = addressable(row);
      return entry === null ? [] : [entry];
    })
    .slice(0, SPEC_OUTLINE_ROOT_LIMIT);
  const decisionEntries = ordered
    .filter(({ version }) => version.payload.kind === "decision")
    .flatMap((row) => {
      const entry = addressable(row);
      return entry === null ? [] : [entry];
    })
    .slice(0, SPEC_OUTLINE_ROOT_LIMIT);
  const taskEntries = ordered
    .filter(({ version }) => version.payload.kind === "task")
    .flatMap((row) => {
      const entry = addressable(row);
      return entry === null ? [] : [entry];
    })
    .slice(0, SPEC_OUTLINE_ROOT_LIMIT);
  const selectedApprovalElementIds = new Set([
    ...requirementEntries.map(({ row }) => row.element.id),
    ...decisionEntries.map(({ row }) => row.element.id),
  ]);
  const approvals = deps
    .findApprovalsBySpecId(spec.id)
    .filter(
      (approval) =>
        approval.element_id !== null &&
        selectedApprovalElementIds.has(approval.element_id),
    );
  const applies = await loadApprovalApplicability(deps, state, approvals);
  const taskStatuses = buildElementStatuses(
    deps,
    { ...snapshot, elements: taskEntries.map(({ row }) => row) },
    [],
    reconciled.rows,
    deps.findTaskClaimsBySpecId(spec.id),
  );
  const taskStatusById = new Map(
    taskStatuses.tasks.map((entry) => [entry.elementId, entry.status]),
  );
  let returnedCriteria = 0;
  const requirements: SpecShowOutlineView["requirements"] =
    requirementEntries.flatMap(({ row, handle }) => {
      const payload = row.version.payload;
      if (payload.kind !== "requirement") return [];
      const taskRows = tasksByRequirement.get(row.element.id) ?? [];
      const criterionRows = criteriaByRequirement.get(row.element.id) ?? [];
      const criteria = criterionRows
        .flatMap((criterion) => {
          const entry = addressable(criterion);
          return entry === null ? [] : [entry];
        })
        .slice(0, SPEC_OUTLINE_CRITERIA_PER_REQUIREMENT_LIMIT)
        .flatMap(({ row: criterion, handle: criterionHandle }) => {
          const criterionPayload = criterion.version.payload;
          if (criterionPayload.kind !== "criterion") return [];
          return [
            {
              ...outlineIdentity(
                criterion,
                criterionHandle,
                criterionPayload.text,
              ),
              validationKinds: [
                ...new Set(criterionPayload.validationStrategy.kinds),
              ],
              status: criterionOutlineStatus(
                deps,
                snapshot,
                criterion,
                taskRows,
              ),
            },
          ];
        });
      returnedCriteria += criteria.length;
      return [
        {
          ...outlineIdentity(row, handle, payload.statement),
          priority: payload.priority,
          risk: payload.risk,
          status: {
            ...requirementStatus(deps, snapshot, row, approvals, {
              criteria: criterionRows,
              tasks: taskRows,
            }),
            approval: outlineApprovalStatus(
              approvals,
              applies,
              "requirement",
              row.element.id,
            ),
          },
          criteria,
        },
      ];
    });
  const decisions: SpecShowOutlineView["decisions"] = decisionEntries.flatMap(
    ({ row, handle }) =>
      row.version.payload.kind === "decision"
        ? [
            {
              ...outlineIdentity(row, handle, row.version.payload.title),
              status: {
                approval: outlineApprovalStatus(
                  approvals,
                  applies,
                  "decision",
                  row.element.id,
                ),
              },
            },
          ]
        : [],
  );
  const tasks: SpecShowOutlineView["tasks"] = taskEntries.flatMap(
    ({ row, handle }) =>
      row.version.payload.kind === "task"
        ? [
            {
              ...outlineIdentity(row, handle, row.version.payload.title),
              status: (() => {
                const status = taskStatusById.get(row.element.id) ?? {
                  status: "pending" as const,
                  claimEvidenceIds: [],
                };
                return {
                  status: status.status,
                  claimEvidenceCount: status.claimEvidenceIds.length,
                };
              })(),
            },
          ]
        : [],
  );

  return {
    spec: { id: spec.id, slug: spec.slug, name: spec.name },
    revision: {
      role: "current",
      id: snapshot.revision.id,
      number: snapshot.revision.number,
      state: snapshot.revision.state,
      authoringStage: snapshot.revision.authoringStage,
      basedOnRevisionId: snapshot.revision.basedOnRevisionId,
    },
    phase: outlinePhase,
    counts,
    requirements,
    decisions,
    tasks,
    disclosure: {
      requirements: outlineDisclosure(counts.requirements, requirements.length),
      criteria: outlineDisclosure(counts.criteria, returnedCriteria),
      decisions: outlineDisclosure(counts.decisions, decisions.length),
      tasks: outlineDisclosure(counts.tasks, tasks.length),
      sections: outlineDisclosure(counts.sections, 0),
      next: `cctl spec show ${spec.slug} --rendered`,
    },
  };
}

function criterionIdsForElement(
  snapshot: SpecRevisionSnapshot,
  row: SpecRevisionElement,
): string[] {
  if (row.element.kind === "criterion") return [row.element.id];
  if (row.element.kind === "requirement") {
    return snapshot.elements
      .filter(
        ({ element }) =>
          element.kind === "criterion" &&
          element.parentElementId === row.element.id,
      )
      .map(({ element }) => element.id);
  }
  if (row.version.payload.kind === "task") {
    return row.version.payload.coveredCriterionElementIds;
  }
  return [];
}

function searchableText(row: SpecRevisionElement): string | null {
  switch (row.version.payload.kind) {
    case "requirement":
      return row.version.payload.statement;
    case "decision":
      return [
        row.version.payload.title,
        row.version.payload.chosenApproach,
        row.version.payload.reason,
        ...row.version.payload.rejectedAlternatives.flatMap((alternative) => [
          alternative.label,
          alternative.reason,
        ]),
      ].join("\n");
    default:
      return null;
  }
}

function approvalAppliesToElement(
  _snapshot: SpecRevisionSnapshot,
  row: SpecRevisionElement,
  approval: SpecApprovalRow,
): boolean {
  switch (row.element.kind) {
    case "requirement":
      return (
        approval.subject_kind === "requirement" &&
        approval.element_id === row.element.id
      );
    case "criterion":
      return (
        approval.subject_kind === "requirement" &&
        approval.element_id === row.element.parentElementId
      );
    case "decision":
      return (
        approval.subject_kind === "decision" &&
        approval.element_id === row.element.id
      );
    case "task":
      return approval.subject_kind === "plan" && approval.element_id === null;
    case "section":
      return false;
  }
}

async function snapshotForRevisionId(
  deps: SpecRouteDeps,
  revisionId: string | null,
): Promise<SpecRevisionSnapshot | null> {
  if (revisionId === null) return null;
  return deps.getRevisionSnapshot(revisionId);
}

/**
 * Every revision under review, with the verdict the shared supersession
 * predicate reached and the snapshots its diff needs.
 *
 * The verdict is read from `liveProposalProjection`, never from a rule
 * restated here: the surfaces that render this list must offer exactly the
 * dismissals the review service would accept, and a second copy of the
 * ancestry test is how they would drift apart.
 */
async function buildLiveProposals(
  deps: SpecRouteDeps,
  revisions: readonly SpecRevision[],
  loadedSnapshots: ReadonlyMap<string, SpecRevisionSnapshot>,
  specId: string,
  events: readonly SpecEventRow[],
): Promise<LiveProposalView[]> {
  const cache = new Map(loadedSnapshots);
  const read = async (
    revisionId: string | null,
  ): Promise<SpecRevisionSnapshot | null> => {
    if (revisionId === null) return null;
    const cached = cache.get(revisionId);
    if (cached !== undefined) return cached;
    const loaded = await deps.getRevisionSnapshot(revisionId);
    if (loaded !== null) cache.set(revisionId, loaded);
    return loaded;
  };

  const entries = await Promise.all(
    liveProposalProjection(revisions).map(async (entry) => {
      const snapshot = await read(entry.revision.id);
      if (snapshot === null) {
        // A proposed revision row with no snapshot is broken storage. Say so
        // rather than dropping it: an unlisted proposal is the dead end this
        // projection exists to end (#50).
        logger.warn("specs.routes.live_proposal.snapshot_missing", {
          specId,
          revisionId: entry.revision.id,
        });
        return null;
      }
      const baseSnapshot = await read(entry.revision.basedOnRevisionId);
      return {
        revision: entry.revision,
        supersededBy: entry.supersededBy,
        snapshot: toSnapshotView(snapshot),
        baseSnapshot:
          baseSnapshot === null ? null : toSnapshotView(baseSnapshot),
        notes: proposalNotes(events, entry.revision.id),
      };
    }),
  );
  return entries.filter((entry): entry is LiveProposalView => entry !== null);
}

async function latestContainingElement(
  deps: SpecRouteDeps,
  revisions: readonly SpecRevision[],
  elementId: string,
): Promise<{
  snapshot: SpecRevisionSnapshot;
  row: SpecRevisionElement;
} | null> {
  const ordered = [...revisions].sort(
    (left, right) => right.number - left.number,
  );
  for (const revision of ordered) {
    const snapshot = await deps.getRevisionSnapshot(revision.id);
    if (snapshot === null) continue;
    const row = snapshot.elements.find(
      (candidate) => candidate.element.id === elementId,
    );
    if (row !== undefined) {
      return { snapshot, row };
    }
  }
  return null;
}

async function buildReferenceState(
  deps: SpecRouteDeps,
  revisions: readonly SpecRevision[],
  row: SpecRevisionElement,
  observedRevisionNumber: number | null,
): Promise<SpecElementReferenceStateView | null> {
  if (observedRevisionNumber === null) return null;

  const observedRevision =
    revisions.find((revision) => revision.number === observedRevisionNumber) ??
    null;
  const latest = await latestContainingElement(deps, revisions, row.element.id);
  if (latest === null) return null;

  const observedSnapshot =
    observedRevision === null
      ? null
      : await deps.getRevisionSnapshot(observedRevision.id);
  const observedRow =
    observedSnapshot?.elements.find(
      (candidate) => candidate.element.id === row.element.id,
    ) ?? null;

  return {
    observedRevision: observedRevisionNumber,
    observedPayloadHash: observedRow?.version.payloadHash ?? null,
    latestContainingRevision: latest.snapshot.revision.number,
    latestPayloadHash: latest.row.version.payloadHash,
  };
}

export function createSpecRouteHandlers(
  deps: SpecRouteDeps = createDefaultDeps(),
) {
  async function listSpecsGET(
    _request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const project = await resolveSpecProjectRoute(deps, context);
    if (!project.ok) return project.response;
    const specs = await deps.listSpecs(project.value.projectPath);
    const summaries = await Promise.all(
      specs.map((spec) => buildSummary(deps, spec)),
    );
    logger.debug("specs.routes.inventory.complete", {
      projectName: project.value.projectName,
      specCount: summaries.length,
    });
    return NextResponse.json({ specs: summaries });
  }

  async function getSpecMeasuresGET(
    _request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const project = await resolveSpecProjectRoute(deps, context);
    if (!project.ok) return project.response;
    const report = await deps.measureProject(project.value.projectPath);
    logger.info("specs.routes.measures.complete", {
      projectName: project.value.projectName,
      definitionsVersion: report.definitionsVersion,
      deliveredCriterionCount:
        report.traceabilityCompleteness.deliveredInScopeCriterionCount,
      completeChainCount: report.traceabilityCompleteness.completeChainCount,
    });
    return NextResponse.json(report);
  }

  async function getSpecSummaryGET(
    _request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    return NextResponse.json(await buildSummary(deps, resolved.value.spec));
  }

  async function getSpecOutlineGET(
    _request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const outline = await buildOutline(deps, resolved.value.spec);
    logger.debug("specs.routes.outline.complete", {
      projectName: resolved.value.projectName,
      specId: resolved.value.spec.id,
      requestedSlug: resolved.value.requestedSlug,
      resolvedSlug: resolved.value.spec.slug,
      revisionId: outline.revision?.id ?? null,
      returnedRequirementCount: outline.requirements.length,
      returnedCriterionCount: outline.disclosure.criteria.returned,
      returnedDecisionCount: outline.decisions.length,
      returnedTaskCount: outline.tasks.length,
    });
    return NextResponse.json(outline);
  }

  async function getSpecGET(
    _request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const state = await loadCurrentState(deps, resolved.value.spec.id);
    const [aliases, reconciled, linkedTickets] = await Promise.all([
      deps.listAliases(resolved.value.spec.id),
      loadReconciledExecutions(deps, resolved.value.spec),
      deps.getLinkedTickets(resolved.value.projectPath, resolved.value.spec.id),
    ]);
    const executions = reconciled.rows;
    const approvals = deps.findApprovalsBySpecId(resolved.value.spec.id);
    const admissions = deps.findGateAdmissionsBySpecId(resolved.value.spec.id);
    const status = await buildStatus(
      deps,
      resolved.value.spec,
      state,
      reconciled,
      admissions,
    );
    const baseRevision = state.baseSnapshot;
    const proofSnapshot =
      state.currentApprovedSnapshot ?? state.currentSnapshot;
    const executionRevisionIds = [
      ...new Set(executions.map((execution) => execution.revision_id)),
    ].filter(
      (revisionId) =>
        revisionId !== state.currentSnapshot?.revision.id &&
        revisionId !== baseRevision?.revision.id &&
        revisionId !== state.currentApprovedSnapshot?.revision.id,
    );
    const executionRevisionSnapshots = (
      await Promise.all(
        executionRevisionIds.map((revisionId) =>
          snapshotForRevisionId(deps, revisionId),
        ),
      )
    ).filter((snapshot): snapshot is SpecRevisionSnapshot => snapshot !== null);
    const dispositionsByExecution = new Map(
      executions.map((execution) => [
        execution.id,
        deps.findCriterionDispositionsByExecution(execution.id),
      ]),
    );
    const criterionDispositions = [...dispositionsByExecution.values()].flat();
    const pinnedRevisionIds = new Set(
      executions.map((execution) => execution.revision_id),
    );
    const revisionNumberById = new Map(
      state.revisions.map((candidate) => [candidate.id, candidate.number]),
    );
    // Pinned revisions alone are not enough. An imported spec has no execution,
    // so nothing pins its revision and every basis-`import` admission fell off
    // the wire — leaving the surfaces that must attribute imported content to
    // import (History's policy-admissions view, the Q&A provenance register)
    // with nothing to read, and no way to tell an import from a human sign-off.
    // The current approved revision's lineage is carried for that reason.
    const admissionRevisionIds = new Set(pinnedRevisionIds);
    const approvedRevisionId = state.currentApprovedSnapshot?.revision.id;
    if (approvedRevisionId !== undefined) {
      admissionRevisionIds.add(approvedRevisionId);
      // A snapshot the listing does not carry has no walkable ancestry; the
      // revision itself still answers for its own admissions.
      if (state.revisions.some(({ id }) => id === approvedRevisionId)) {
        for (const id of ancestorIds(state.revisions, approvedRevisionId)) {
          admissionRevisionIds.add(id);
        }
      }
    }
    const gateAdmissions = admissions.filter(
      (admission) =>
        admission.revision_id !== null &&
        admissionRevisionIds.has(admission.revision_id),
    );
    // The merge gate honors waivers for each run's pinned revision, so the
    // detail view must carry those too — loading only the proof snapshot's
    // waivers made a valid older-pin waiver invisible in Studio (F26).
    const proofSnapshotWaivers =
      proofSnapshot?.elements
        .filter(({ element }) => element.kind === "criterion")
        .flatMap(({ element }) => {
          const waiver = deps.findWaiverForCriterionRevision(
            element.id,
            proofSnapshot.revision.id,
          );
          return waiver === null ? [] : [waiver];
        }) ?? [];
    const waivers = [
      ...new Map(
        [
          ...proofSnapshotWaivers,
          ...[...pinnedRevisionIds].flatMap((revisionId) =>
            deps.findWaiversByRevision(revisionId),
          ),
        ].map((waiver) => [waiver.id, waiver]),
      ).values(),
    ];
    const snapshotsByRevisionId = new Map(
      [
        state.currentSnapshot,
        baseRevision,
        state.currentApprovedSnapshot,
        ...executionRevisionSnapshots,
      ]
        .filter(
          (candidate): candidate is SpecRevisionSnapshot => candidate !== null,
        )
        .map((candidate) => [candidate.revision.id, candidate]),
    );
    const specEvents = deps.findEventsBySpecId(resolved.value.spec.id);
    const liveProposals = await buildLiveProposals(
      deps,
      state.revisions,
      snapshotsByRevisionId,
      resolved.value.spec.id,
      specEvents,
    );
    const executionById = new Map(
      executions.map((execution) => [execution.id, execution]),
    );
    const priorRunLookup: PriorRunLookup = {
      findExecutionById(id) {
        return executionById.get(id) ?? null;
      },
      findCriterionDisposition(executionId, criterionElementId) {
        return (
          dispositionsByExecution
            .get(executionId)
            ?.find((row) => row.criterion_element_id === criterionElementId) ??
          null
        );
      },
    };
    const commentHandles =
      state.currentSnapshot === null
        ? new Map<string, string>()
        : handlesByElementId(resolved.value.spec, state.currentSnapshot);
    const comments = state.revisions
      .flatMap((revision) => deps.findCommentsByRevision(revision.id))
      .map((row) =>
        projectSpecComment(row, {
          handleByElementId: commentHandles,
          revisionNumberById,
        }),
      );
    const elementStatuses = buildElementStatuses(
      deps,
      proofSnapshot,
      approvals,
      executions,
      deps.findTaskClaimsBySpecId(resolved.value.spec.id),
    );
    logger.debug("specs.routes.detail.complete", {
      projectName: resolved.value.projectName,
      specId: resolved.value.spec.id,
      requestedSlug: resolved.value.requestedSlug,
      resolvedSlug: resolved.value.spec.slug,
      commentRevisionCount: state.revisions.length,
      commentCount: comments.length,
    });
    return NextResponse.json({
      spec: resolved.value.spec,
      aliases,
      revisions: state.revisions,
      liveProposals,
      baseRevision: baseRevision === null ? null : toSnapshotView(baseRevision),
      currentRevision:
        state.currentSnapshot === null
          ? null
          : toSnapshotView(state.currentSnapshot),
      currentApprovedRevision:
        state.currentApprovedSnapshot === null
          ? null
          : toSnapshotView(state.currentApprovedSnapshot),
      executionRevisionSnapshots:
        executionRevisionSnapshots.map(toSnapshotView),
      approvals,
      comments,
      executions: executions.map((run) =>
        toExecutionView(
          run,
          revisionNumberById,
          buildDeliveryProjection(
            deps,
            run,
            snapshotsByRevisionId.get(run.revision_id),
            dispositionsByExecution.get(run.id) ?? [],
            priorRunLookup,
          ),
        ),
      ),
      criterionDispositions,
      gateAdmissions: gateAdmissions.map((admission) =>
        toGateAdmissionView(admission, revisionNumberById),
      ),
      waivers,
      elementStatuses,
      status,
      linkedTickets,
      questions: deps
        .findQuestionsBySpecId(resolved.value.spec.id)
        .map(toQuestionView),
      assumptions: deps
        .findAssumptionsBySpecId(resolved.value.spec.id)
        .map(toAssumptionView),
      importRecord: importRecordView(specEvents, resolved.value.spec.id),
    });
  }

  async function getSpecStatusGET(
    _request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const state = await loadCurrentState(deps, resolved.value.spec.id);
    return NextResponse.json(
      await buildStatus(deps, resolved.value.spec, state),
    );
  }

  /**
   * The review loop's feedback read (#60). One request answers "what did the
   * reviewers say" without the full detail dump: every comment on the spec,
   * projected out of its raw row shape. The open counts are spec-wide,
   * deliberately independent of the filters, so a filtered read still reports
   * how much feedback is outstanding overall.
   */
  async function getSpecCommentsGET(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const spec = resolved.value.spec;
    const state = await loadCurrentState(deps, spec.id);
    const handleByElementId =
      state.currentSnapshot === null
        ? new Map<string, string>()
        : handlesByElementId(spec, state.currentSnapshot);
    const revisionNumberById = new Map(
      state.revisions.map((candidate) => [candidate.id, candidate.number]),
    );
    const views = state.revisions
      .flatMap((candidate) => deps.findCommentsByRevision(candidate.id))
      .map((row) =>
        projectSpecComment(row, { handleByElementId, revisionNumberById }),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    const searchParams = new URL(request.url).searchParams;
    const elementFilter = searchParams.get("element");
    const openOnly = searchParams.get("open") === "true";
    if (elementFilter !== null) {
      const known =
        handleByElementId.has(elementFilter) ||
        [...handleByElementId.values()].includes(elementFilter) ||
        views.some((comment) => comment.elementId === elementFilter);
      // An element that exists but carries no comments answers with an empty
      // list; a name that resolves to nothing refuses, so a typo'd handle is
      // never mistaken for "no feedback".
      if (!known) {
        return notFound(
          `Element "${elementFilter}" is not carried by the current revision and no comment references it. Drop --element to list every comment.`,
        );
      }
    }
    const comments = views.filter(
      (comment) =>
        (elementFilter === null ||
          comment.handle === elementFilter ||
          comment.elementId === elementFilter) &&
        (!openOnly || comment.resolution === "open"),
    );
    const openViews = views.filter((comment) => comment.resolution === "open");
    logger.debug("specs.routes.comments.complete", {
      projectName: resolved.value.projectName,
      specId: spec.id,
      commentCount: views.length,
      returnedCount: comments.length,
      openCount: openViews.length,
    });
    const view: SpecCommentsView = {
      specId: spec.id,
      slug: spec.slug,
      comments,
      openCount: openViews.length,
      openBlockingCount: openViews.filter((comment) => comment.blocking).length,
    };
    return NextResponse.json(view);
  }

  /**
   * The write path's read (R7.1). It resolves only what a write must name, so
   * an authoring session that saves N elements no longer transfers the whole
   * spec N times.
   */
  async function getSpecEditContextGET(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const spec = resolved.value.spec;
    const revisions = await deps.listRevisions(spec.id);
    const current = latestRevision(revisions);
    const approved = latestRevision(
      revisions.filter((revision) => revision.state === "approved"),
    );
    const requested = new URL(request.url).searchParams.get("element");
    const snapshot =
      current === null || requested === null
        ? null
        : await deps.getRevisionSnapshot(current.id);
    const row =
      snapshot === null || requested === null
        ? undefined
        : snapshot.elements.find(
            (candidate) =>
              candidate.element.id === requested ||
              elementHandleInSnapshot(snapshot, candidate.element.id) ===
                requested,
          );
    const view: SpecEditContextView = {
      specId: spec.id,
      slug: spec.slug,
      name: spec.name,
      gatePolicy: spec.gatePolicy,
      currentRevision:
        current === null
          ? null
          : {
              id: current.id,
              number: current.number,
              state: current.state,
              authoringStage: current.authoringStage,
            },
      latestApprovedRevision:
        approved === null ? null : { id: approved.id, number: approved.number },
      element:
        row === undefined || snapshot === null
          ? null
          : {
              elementId: row.element.id,
              handle: elementHandleInSnapshot(snapshot, row.element.id),
              kind: row.element.kind,
              elementVersion: row.version.elementVersion,
              position: row.version.position,
            },
    };
    return NextResponse.json(view);
  }

  /**
   * The delivery-delta projection (P1/P2). Read-only and computed per request:
   * it persists nothing, so there is no cached classification that can drift
   * from the revisions it compares.
   */
  async function getSpecDeltaGET(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const state = await loadCurrentState(deps, resolved.value.spec.id);
    if (state.currentApprovedSnapshot === null) {
      return notFound(
        `Spec ${resolved.value.spec.slug} has no approved revision, so there is nothing to compare a delivery against. Approve a revision first, then read the delta.`,
      );
    }
    const since = new URL(request.url).searchParams.get("since") ?? undefined;
    const result = await loadDeliveryDelta(deps, {
      spec: resolved.value.spec,
      currentApprovedSnapshot: state.currentApprovedSnapshot,
      sinceExecutionId: since,
    });
    if (!result.ok) {
      logger.debug("specs.routes.delta.refused", {
        specId: resolved.value.spec.id,
        code: result.code,
      });
      return result.code === "execution_not_found"
        ? notFound(result.message, result.code)
        : jsonError(result.message, 409, result.code);
    }
    logger.debug("specs.routes.delta.complete", {
      specId: resolved.value.spec.id,
      comparedExecutionId: result.projection.comparedExecution?.executionId,
      criterionCount: result.projection.criteria.length,
      advisoryCount: result.projection.advisories.length,
    });
    return NextResponse.json(result.projection);
  }

  async function getSpecLintGET(
    _request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const state = await loadCurrentState(deps, resolved.value.spec.id);
    const draft = [...state.revisions]
      .sort((left, right) => right.number - left.number)
      .find((revision) => revision.state === "draft");
    const lintRevision = draft ?? state.currentRevision;
    if (lintRevision === null) return notFound("Spec draft not found");
    const findings = await deps.lintDraft(
      resolved.value.spec.id,
      lintRevision.id,
    );
    logger.debug("specs.routes.lint.complete", {
      specId: resolved.value.spec.id,
      revisionId: lintRevision.id,
      revisionState: lintRevision.state,
      findingCount: findings.length,
    });
    return NextResponse.json({ revisionId: lintRevision.id, findings });
  }

  /**
   * The compiled-plan preview. POST because the scope is a document, not a
   * query string — the handler mutates nothing and writes no audit record.
   *
   * Unlike the compile path this accepts a draft or proposed revision: the
   * whole point is showing a planner the shape their plan compiles to while it
   * is still editable. A plan the compiler refuses is itself the answer, so a
   * materialization error is returned as a 422 the planner can act on rather
   * than a 500.
   */
  async function planPreviewPOST(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { spec } = resolved.value;
    // An absent body is the explicit "preview the whole revision" request, but
    // a MALFORMED one is not: silently reading it as {} would answer a request
    // that meant to narrow by scope, revision, or context with the full plan
    // instead — a wider answer than was asked for, and indistinguishable from
    // a correct one.
    const rawBody = await request.text();
    let body: unknown = {};
    if (rawBody.trim().length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return jsonError(
          `Plan preview request body is not valid JSON. Send no body (or {}) to preview the whole revision, or a JSON object with scope, revisionId, or contextId, then re-run cctl spec plan preview ${spec.slug}.`,
          400,
          "plan_preview_invalid_body",
        );
      }
    }
    const parsedBody = planPreviewBodySchema.safeParse(body ?? {});
    if (!parsedBody.success) {
      return jsonError("Invalid plan preview request body", 400);
    }
    const state = await loadCurrentState(deps, spec.id);
    const requestedRevisionId = parsedBody.data.revisionId ?? null;
    const revision =
      requestedRevisionId === null
        ? state.currentRevision
        : (state.revisions.find(
            (candidate) => candidate.id === requestedRevisionId,
          ) ?? null);
    if (revision === null) return notFound("Spec revision not found");
    const snapshot =
      revision.id === state.currentRevision?.id
        ? state.currentSnapshot
        : await deps.getRevisionSnapshot(revision.id);
    if (snapshot === null) return notFound("Spec revision not found");

    // No scope document means "preview the whole plan": every task and every
    // criterion this revision carries, which is the scope a planner is reading
    // the compiled shape of before they narrow it.
    const scope =
      parsedBody.data.scope ?? fullRevisionScope(spec.slug, snapshot);
    let preview: SpecPlanPreview;
    try {
      preview = buildSpecPlanPreview({
        spec: { id: spec.id, slug: spec.slug, name: spec.name },
        revisionSnapshot: snapshot,
        scope,
        scopeHash: hashExecutionScope(scope),
        approvalRequired:
          resolveDial(spec.gatePolicy, "execution_start") === "gate",
      });
    } catch (error) {
      logger.debug("specs.routes.plan-preview.uncompilable", {
        specId: spec.id,
        revisionId: revision.id,
      });
      // The refusal names its own repair: an uncompilable plan is a plan
      // defect or a scope defect, and both are edits the caller makes before
      // re-running the same preview.
      return jsonError(
        `${error instanceof Error ? error.message : String(error)} Repair the plan elements or the selection in --scope, then re-run cctl spec plan preview ${spec.slug}.`,
        422,
        "plan_preview_uncompilable",
      );
    }
    const bounded = boundSpecPlanPreview(preview, {
      ...(parsedBody.data.contextId === undefined
        ? {}
        : { contextId: parsedBody.data.contextId }),
    });
    if (!bounded.ok) {
      return jsonError(
        `This plan has no context ${JSON.stringify(parsedBody.data.contextId)}. Re-run without --context, or name one of: ${bounded.knownContextIds.join(", ")}.`,
        422,
        "plan_preview_unknown_context",
      );
    }
    logger.debug("specs.routes.plan-preview.complete", {
      specId: spec.id,
      revisionId: revision.id,
      revisionState: revision.state,
      contextCount: bounded.value.totalContextCount,
      evidenceGapCount: bounded.value.evidenceGaps.length,
    });
    return NextResponse.json(bounded.value);
  }

  function resolveQuestionOrAssumption(
    spec: Spec,
    requestedHandle: string,
  ): Response | null {
    let parsed: ParsedElementHandle;
    try {
      parsed = parseElementHandle(requestedHandle, spec.slug);
    } catch {
      // Not a well-formed handle; fall through to the revision-element scan,
      // which owns the 404 for unknown addresses.
      return null;
    }
    if (parsed.kind === "question") {
      const row = deps
        .findQuestionsBySpecId(spec.id)
        .find((candidate) => candidate.number === parsed.number);
      if (row === undefined) return notFound("Spec question not found");
      return NextResponse.json({
        specId: spec.id,
        slug: spec.slug,
        kind: "question",
        handle: formatBareElementHandle({
          kind: "question",
          number: parsed.number,
        }),
        question: toQuestionView(row),
      });
    }
    if (parsed.kind === "assumption") {
      const row = deps
        .findAssumptionsBySpecId(spec.id)
        .find((candidate) => candidate.number === parsed.number);
      if (row === undefined) return notFound("Spec assumption not found");
      return NextResponse.json({
        specId: spec.id,
        slug: spec.slug,
        kind: "assumption",
        handle: formatBareElementHandle({
          kind: "assumption",
          number: parsed.number,
        }),
        assumption: toAssumptionView(row),
      });
    }
    return null;
  }

  async function getSpecElementGET(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { element: requestedHandle } = await context.params;
    // Q/A records are spec-scoped, not revision-scoped: resolve them before
    // any snapshot work so they never fall into the older-revision scan.
    const recordResponse = resolveQuestionOrAssumption(
      resolved.value.spec,
      requestedHandle ?? "",
    );
    if (recordResponse !== null) return recordResponse;
    const state = await loadCurrentState(deps, resolved.value.spec.id);
    const searchParams = new URL(request.url).searchParams;
    const targetRevisionId = searchParams.get("revisionId");
    const observedRevision = z.coerce
      .number()
      .int()
      .positive()
      .safeParse(searchParams.get("observedRevision"));
    const targetRevision =
      targetRevisionId === null
        ? null
        : state.revisions.find((revision) => revision.id === targetRevisionId);
    if (targetRevisionId !== null && targetRevision === undefined) {
      return notFound("Spec revision not found");
    }
    const targetSnapshot =
      targetRevision === null || targetRevision === undefined
        ? state.currentSnapshot
        : await deps.getRevisionSnapshot(targetRevision.id);
    if (targetSnapshot === null) return notFound("Spec element not found");

    let snapshot = targetSnapshot;
    let handles = handlesByElementId(resolved.value.spec, snapshot);
    let row = snapshot.elements.find(
      ({ element }) => handles.get(element.id) === requestedHandle,
    );
    if (row === undefined && targetRevisionId === null) {
      const olderRevisions = [...state.revisions]
        .filter((candidate) => candidate.id !== snapshot.revision.id)
        .sort((left, right) => right.number - left.number);
      for (const candidate of olderRevisions) {
        const candidateSnapshot = await deps.getRevisionSnapshot(candidate.id);
        if (candidateSnapshot === null) continue;
        const candidateHandles = handlesByElementId(
          resolved.value.spec,
          candidateSnapshot,
        );
        const candidateRow = candidateSnapshot.elements.find(
          ({ element }) => candidateHandles.get(element.id) === requestedHandle,
        );
        if (candidateRow === undefined) continue;
        snapshot = candidateSnapshot;
        handles = candidateHandles;
        row = candidateRow;
        break;
      }
    }
    if (row === undefined) {
      const address = requestedHandle ?? "";
      // A well-formed handle that resolves to nothing is a genuine miss; an
      // ill-formed one is a mis-addressed element, so its refusal teaches the
      // grammar and names the real handle when the value is an element id.
      if (isWellFormedElementHandle(address, resolved.value.spec.slug)) {
        return notFound("Spec element not found");
      }
      const knownHandle = handles.get(address) ?? null;
      return notFound(
        explainInvalidElementHandle(address, handles),
        "invalid_handle",
        {
          handle: address,
          elementHandle: knownHandle === address ? null : knownHandle,
        },
      );
    }

    const revisionId = snapshot.revision.id;
    const executions = deps
      .findExecutionsBySpecId(resolved.value.spec.id)
      .filter((execution) => execution.revision_id === revisionId);
    for (const execution of executions) {
      await deps.ingestExecutionEvidenceBestEffort(
        resolved.value.projectPath,
        execution.id,
      );
    }
    const evidenceState = criterionIdsForElement(snapshot, row).map(
      (criterionElementId) => ({
        criterionElementId,
        handle: handles.get(criterionElementId) ?? criterionElementId,
        evidence: deps.findEvidenceByCriterionRevision(
          criterionElementId,
          revisionId,
        ),
        verdicts: deps.findProofVerdictsByCriterionRevision(
          criterionElementId,
          revisionId,
        ),
        waiver: deps.findWaiverForCriterionRevision(
          criterionElementId,
          revisionId,
        ),
      }),
    );
    const referenceState = await buildReferenceState(
      deps,
      state.revisions,
      row,
      observedRevision.success ? observedRevision.data : null,
    );
    logger.debug("specs.routes.element.complete", {
      projectName: resolved.value.projectName,
      specId: resolved.value.spec.id,
      handle: handles.get(row.element.id),
      latestContainingRevision:
        referenceState?.latestContainingRevision ?? snapshot.revision.number,
    });
    return NextResponse.json({
      specId: resolved.value.spec.id,
      slug: resolved.value.spec.slug,
      revision: snapshot.revision,
      handle: handles.get(row.element.id),
      element: row,
      approvals: deps
        .findApprovalsBySpecId(resolved.value.spec.id)
        .filter((approval) =>
          approvalAppliesToElement(snapshot, row, approval),
        ),
      evidenceState,
      referenceState,
    });
  }

  async function searchSpecGET(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const state = await loadCurrentState(deps, resolved.value.spec.id);
    const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    const normalized = query.toLocaleLowerCase();
    if (state.currentSnapshot === null || normalized.length === 0) {
      return NextResponse.json({ query, results: [] });
    }
    const handles = handlesByElementId(
      resolved.value.spec,
      state.currentSnapshot,
    );
    const results = state.currentSnapshot.elements.flatMap((row) => {
      const searchable = searchableText(row);
      if (
        searchable === null ||
        !searchable.toLocaleLowerCase().includes(normalized)
      ) {
        return [];
      }
      return [
        {
          handle: handles.get(row.element.id) ?? row.element.id,
          kind: row.element.kind,
          elementId: row.element.id,
          text: searchable,
        },
      ];
    });
    logger.debug("specs.routes.search.complete", {
      specId: resolved.value.spec.id,
      queryLength: query.length,
      resultCount: results.length,
    });
    return NextResponse.json({ query, results });
  }

  /**
   * Project-wide search (R24.11). Element text lives only in the current
   * revision, so matching loads that one snapshot per candidate and nothing
   * else; the full summary — which reloads revisions, executions, and gate
   * status — is built only for the specs that matched.
   */
  async function searchProjectSpecsGET(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const project = await resolveSpecProjectRoute(deps, context);
    if (!project.ok) return project.response;
    const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    const normalized = query.toLocaleLowerCase();
    if (normalized.length === 0) {
      return NextResponse.json({ query, results: [] });
    }
    const specs = await deps.listSpecs(project.value.projectPath);
    const results: SpecSearchHit[] = [];
    for (const candidate of [...specs].sort((left, right) =>
      left.slug.localeCompare(right.slug),
    )) {
      const current = latestRevision(await deps.listRevisions(candidate.id));
      const snapshot =
        current === null ? null : await deps.getRevisionSnapshot(current.id);
      const handles =
        snapshot === null
          ? new Map<string, string>()
          : handlesByElementId(candidate, snapshot);
      const matches = (snapshot?.elements ?? []).flatMap((row) => {
        const searchable = searchableText(row);
        if (
          searchable === null ||
          !searchable.toLocaleLowerCase().includes(normalized)
        ) {
          return [];
        }
        return [
          {
            handle: handles.get(row.element.id) ?? row.element.id,
            kind: row.element.kind,
            elementId: row.element.id,
            text: searchable,
          },
        ];
      });
      const matchedName = `${candidate.slug}\n${candidate.name}`
        .toLocaleLowerCase()
        .includes(normalized);
      if (!matchedName && matches.length === 0) continue;
      const summary = await buildSummary(deps, candidate);
      results.push({
        specId: candidate.id,
        slug: candidate.slug,
        name: candidate.name,
        phase: summary.phase,
        preset: candidate.gatePolicy.preset,
        gatePolicy: candidate.gatePolicy,
        matchedName,
        matchCount: matches.length,
        matches,
      });
    }
    logger.debug("specs.routes.project_search.complete", {
      projectName: project.value.projectName,
      queryLength: query.length,
      specCount: specs.length,
      hitCount: results.length,
    });
    return NextResponse.json({ query, results });
  }

  /**
   * The reviewer's changelog (R26). Its default pair is the one Spec Studio's
   * review cards diff — the current revision against `basedOnRevisionId` —
   * because that is the comparison a human signs off on. The governance base is
   * reachable, but only when the caller asks for it by name: swapping it in
   * silently would classify the same review differently from the surface that
   * approves it.
   */
  async function getSpecDiffGET(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const spec = resolved.value.spec;
    const params = new URL(request.url).searchParams;
    const requestedBaseline = params.get("baseline");
    if (requestedBaseline !== null && requestedBaseline !== "governance") {
      return jsonError(
        `Unknown diff baseline ${JSON.stringify(requestedBaseline)}; the only explicit baseline is "governance" (the nearest approved ancestor). Omit it to compare against the immediate review base.`,
        400,
        "invalid_baseline",
      );
    }
    // Each names a base. Picking one would drop a base the caller asked for,
    // so the ambiguity is refused rather than resolved by precedence.
    if (requestedBaseline !== null && params.get("from") !== null) {
      return jsonError(
        `Diff baseline "governance" and an explicit "from" revision name different bases; send one of them — drop "from" to compare against the nearest approved ancestor, or drop "baseline" to compare against the revision you name.`,
        400,
        "conflicting_baseline",
      );
    }
    const revisions = await deps.listRevisions(spec.id);
    const requestedTo = params.get("to");
    const to =
      requestedTo === null
        ? latestRevision(revisions)
        : (revisions.find((revision) => revision.id === requestedTo) ?? null);
    if (to === null) {
      return notFound(
        requestedTo === null
          ? `Spec ${spec.slug} has no revision to diff`
          : `Revision ${requestedTo} is not part of spec ${spec.slug} — write its full revision list with cctl spec show ${spec.slug} --full`,
      );
    }

    const requestedFrom = params.get("from");
    let baseline: SpecDiffBaseline;
    let baseRevisionId: string | null;
    try {
      if (requestedFrom !== null) {
        baseline = "explicit";
        baseRevisionId = requestedFrom;
      } else if (requestedBaseline === "governance") {
        baseline = "governance";
        baseRevisionId = governanceBaseRevisionId(revisions, to);
      } else {
        baseline = "review";
        baseRevisionId = to.basedOnRevisionId;
      }
    } catch (error) {
      if (!(error instanceof SpecRevisionLineageError)) throw error;
      return jsonError(
        `Spec ${spec.slug} has broken revision lineage: ${error.message}. Compare explicit revision ids with --from/--to.`,
        409,
        "broken_lineage",
      );
    }
    const from =
      baseRevisionId === null
        ? null
        : (revisions.find((revision) => revision.id === baseRevisionId) ??
          null);
    if (baseRevisionId !== null && from === null) {
      return notFound(
        `Revision ${baseRevisionId} is not part of spec ${spec.slug} — write its full revision list with cctl spec show ${spec.slug} --full`,
      );
    }

    const toSnapshot = await deps.getRevisionSnapshot(to.id);
    if (toSnapshot === null) {
      return notFound(`Revision ${to.id} has no stored content`);
    }
    const fromSnapshot =
      from === null ? null : await deps.getRevisionSnapshot(from.id);
    if (from !== null && fromSnapshot === null) {
      return notFound(`Revision ${from.id} has no stored content`);
    }
    const diff = diffRevisions(
      fromSnapshot === null ? [] : toDiffRows(fromSnapshot),
      toDiffRows(toSnapshot),
    );
    const changeByElementId = new Map(
      diff.changeList.map((change) => [change.elementId, change]),
    );
    logger.debug("specs.routes.diff.complete", {
      specId: spec.id,
      baseline,
      fromRevisionId: from?.id ?? null,
      toRevisionId: to.id,
      changeCount: diff.changeList.length,
      planStale: diff.planStale,
    });
    return NextResponse.json({
      slug: spec.slug,
      baseline,
      from: from === null ? null : toDiffRevisionRef(from),
      to: toDiffRevisionRef(to),
      elements: diff.classifications.map((entry) => {
        const change = changeByElementId.get(entry.elementId);
        return {
          elementId: entry.elementId,
          // A removed element is absent from the compared revision, so its
          // handle can only come from the base it was removed from.
          handle:
            elementHandleInSnapshot(toSnapshot, entry.elementId) ??
            (fromSnapshot === null
              ? null
              : elementHandleInSnapshot(fromSnapshot, entry.elementId)),
          kind: entry.kind,
          classification: change?.change ?? "unchanged",
          directlyChanged: entry.directlyChanged,
          summary: change?.summary ?? null,
        };
      }),
      planStale: diff.planStale,
    });
  }

  async function getSpecExportGET(
    _request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const bundle = await deps.exportSpec(resolved.value.spec.id);
    logger.debug("specs.routes.export.complete", {
      specId: resolved.value.spec.id,
      markdownFileCount: bundle.markdownFiles.length,
    });
    return NextResponse.json(bundle);
  }

  async function getSpecVerifyGET(
    _request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const report = await deps.verifySpec(resolved.value.spec.id);
    logger.debug("specs.routes.verify.complete", {
      specId: resolved.value.spec.id,
      ok: report.ok,
      checkedRevisionCount: report.checkedRevisionIds.length,
      mismatchCount: report.mismatches.length,
    });
    return NextResponse.json(report);
  }

  return {
    listSpecsGET,
    getSpecMeasuresGET,
    getSpecSummaryGET,
    getSpecOutlineGET,
    getSpecGET,
    getSpecStatusGET,
    getSpecCommentsGET,
    getSpecEditContextGET,
    getSpecLintGET,
    getSpecDeltaGET,
    planPreviewPOST,
    getSpecElementGET,
    searchSpecGET,
    searchProjectSpecsGET,
    getSpecDiffGET,
    getSpecExportGET,
    getSpecVerifyGET,
  };
}

const handlers = createSpecRouteHandlers();
export const specsInventoryGET = withTracing(handlers.listSpecsGET);
export const specMeasuresGET = withTracing(handlers.getSpecMeasuresGET);
export const specSummaryGET = withTracing(handlers.getSpecSummaryGET);
export const specOutlineGET = withTracing(handlers.getSpecOutlineGET);
export const specDetailGET = withTracing(handlers.getSpecGET);
export const specStatusGET = withTracing(handlers.getSpecStatusGET);
export const specCommentsGET = withTracing(handlers.getSpecCommentsGET);
export const specEditContextGET = withTracing(handlers.getSpecEditContextGET);
export const specLintGET = withTracing(handlers.getSpecLintGET);
export const specDeltaGET = withTracing(handlers.getSpecDeltaGET);
export const specPlanPreviewPOST = withTracing(handlers.planPreviewPOST);
export const specElementGET = withTracing(handlers.getSpecElementGET);
export const specSearchGET = withTracing(handlers.searchSpecGET);
export const specProjectSearchGET = withTracing(handlers.searchProjectSpecsGET);
export const specDiffGET = withTracing(handlers.getSpecDiffGET);
export const specExportGET = withTracing(handlers.getSpecExportGET);
export const specVerifyGET = withTracing(handlers.getSpecVerifyGET);

export const SPEC_CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";
export const SPEC_CALLER_BACKEND_HEADER = "x-cc-agent-backend";

export interface SpecMutationServices {
  authoring: Pick<
    AuthoringService,
    | "createSpec"
    | "upsertDraftElement"
    | "upsertDraftElements"
    | "reorderDraftElement"
    | "removeDraftElement"
    | "openAmendment"
    | "renameSpec"
    | "proposeRevision"
    | "advanceAuthoringStage"
  >;
  review: ReviewService;
  evidence: EvidenceService;
  execution: Pick<
    ExecutionService,
    | "start"
    | "parkDeliveryPlan"
    | "approveExecutionStart"
    | "linkWorkflowExecution"
    | "markRunning"
    | "markDelivered"
    | "getStatus"
    | "abandonExecution"
    | "abandonSpec"
    | "captureScopeAmendment"
  >;
  links: Pick<
    LinksService,
    | "promoteConversation"
    | "graduateTicket"
    | "materializeApprovedTasks"
    | "linkTicket"
    | "getSpecLinkedTickets"
    | "getTicketReadThrough"
  >;
  /**
   * The one-shot spec import. It sits beside the other entry paths rather than
   * inside `authoring` because it creates a whole approved spec in one
   * transaction instead of continuing an authoring line.
   */
  import: Pick<ImportService, "importSpec">;
  deliveryPlan: DeliveryPlanService;
  ingestEvidenceBestEffort(executionId: string): Promise<unknown>;
  verify(specId: string): Promise<IntegrityReport>;
}

export interface SpecWriteRouteDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  resolveSpec(projectPath: string, slug: string): Promise<Spec | null>;
  getServices(projectPath: string): Promise<SpecMutationServices>;
}

const createSpecBodySchema = createAuthoringSpecInputSchema.omit({
  projectPath: true,
  actor: true,
});
const promoteConversationBodySchema = promoteConversationInputSchema.omit({
  projectPath: true,
  actor: true,
});
const graduateTicketBodySchema = graduateTicketInputSchema.omit({
  actor: true,
});
const draftElementBodySchema = draftElementWriteInputSchema.omit({
  specId: true,
  actor: true,
});
const draftElementBatchBodySchema = draftElementBatchShapeSchema
  .omit({ specId: true, actor: true })
  .refine(batchCarriesWork, {
    message: BATCH_WITHOUT_WORK_MESSAGE,
    path: ["elements"],
  });
const reorderDraftElementBodySchema = reorderDraftElementInputSchema.omit({
  specId: true,
  actor: true,
});
const removeDraftElementBodySchema = removeDraftElementInputSchema.omit({
  specId: true,
  actor: true,
});
const openAmendmentBodySchema = openAmendmentInputSchema.omit({
  specId: true,
  actor: true,
});
const proposeRevisionBodySchema = proposeAuthoringRevisionInputSchema.omit({
  specId: true,
  actor: true,
});
const advanceAuthoringStageBodySchema = z
  .object({
    revisionId: z.string().min(1),
    expectedStage: specAuthoringStageSchema,
  })
  .strict();
const reviewCommentBodySchema = reviewCommentInputSchema.omit({
  specId: true,
  actor: true,
});
const replyBodySchema = replyToReviewThreadInputSchema.omit({
  specId: true,
  actor: true,
});
const resolveThreadBodySchema = resolveReviewThreadInputSchema.omit({
  specId: true,
  actor: true,
});
const requestChangesBodySchema = requestChangesInputSchema.omit({
  specId: true,
  actor: true,
});
// The revision id stays required rather than defaulting to the current
// proposal: it is the caller's compare-and-swap token, and inferring it would
// let a replacement proposal be withdrawn by an agent that never saw it.
const withdrawProposalBodySchema = withdrawProposalInputSchema.omit({
  specId: true,
  actor: true,
});
// The reason is required, not defaulted: the row it lands in is the only
// place a later reader learns why reviewed work was disposed of (#50).
const dismissSupersededProposalBodySchema =
  dismissSupersededProposalInputSchema.omit({
    specId: true,
    actor: true,
  });
const approveItemBodySchema = approveItemInputSchema.omit({
  specId: true,
  actor: true,
  approver: true,
});
const unapproveItemBodySchema = unapproveItemInputSchema.omit({
  specId: true,
  actor: true,
});
const signOffBodySchema = signOffRevisionInputSchema.omit({
  specId: true,
  actor: true,
  approver: true,
});
// No subject list at the transport: the combined act derives what is still
// outstanding from the same projection Studio renders, so the confirmation the
// operator read and the rows the transaction writes cannot disagree.
const approveRemainingAndSignOffBodySchema =
  approveRemainingAndSignOffInputSchema.omit({
    specId: true,
    actor: true,
    approver: true,
  });
// Delivery-only at the transport: execution-start grants must flow through
// the approve-execution-start action, which also approves the pending
// workflow definition so the granted gate actually starts the run.
const grantGateApprovalBodySchema = grantGateApprovalInputSchema
  .omit({
    specId: true,
    actor: true,
    approver: true,
  })
  .extend({ gate: z.literal("delivery") });
const approveExecutionStartBodySchema = z
  .object({ executionId: z.string().min(1) })
  .strict();
const bulkApproveBodySchema = bulkApproveInputSchema.omit({
  specId: true,
  actor: true,
  approver: true,
});
const openQuestionBodySchema = openQuestionInputSchema.omit({
  specId: true,
  actor: true,
});
const answerQuestionBodySchema = answerQuestionInputSchema.omit({
  specId: true,
  actor: true,
});
const proposeAssumptionBodySchema = proposeAssumptionInputSchema.omit({
  specId: true,
  actor: true,
});
const requestApprovalBodySchema = requestApprovalInputSchema.omit({
  specId: true,
  actor: true,
});
const disposeAssumptionBodySchema = disposeAssumptionInputSchema.omit({
  specId: true,
  actor: true,
});
const changePolicyBodySchema = changeSpecPolicyInputSchema.omit({
  specId: true,
  actor: true,
});
const materializeTasksBodySchema = materializeApprovedTasksInputSchema.omit({
  specId: true,
  actor: true,
});
const linkTicketBodySchema = linkTicketInputSchema.omit({
  specId: true,
  actor: true,
});

const taskClaimBodySchema = z
  .object({
    taskElementId: z.string().min(1),
    executionId: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)),
  })
  .strict();
const claimIdBodySchema = z
  .object({
    claimId: z.string().min(1),
    changedIntentElementIds: z.array(z.string().min(1)).default([]),
  })
  .strict();
const waiverBodySchema = z
  .object({
    criterionElementId: z.string().min(1),
    revisionId: z.string().min(1),
    reason: z.string(),
  })
  .strict();
const staleWaiverBodySchema = z
  .object({
    waiverId: z.string().min(1),
    laterRevisionId: z.string().min(1),
  })
  .strict();
const dispositionBodySchema = z
  .object({
    executionId: z.string().min(1),
    criterionElementId: z.string().min(1),
    disposition: specCriterionDispositionSchema,
    waiverId: z.string().min(1).optional(),
    deliveredByExecutionId: z.string().min(1).optional(),
  })
  .strict();
const startExecutionBodySchema = z
  .object({
    revisionId: z.string().min(1),
    /**
     * Recognized only so retired clients receive the migration act rather than
     * a generic strict-schema refusal. Active delivery-plan starts omit it.
     */
    scope: executionScopeSchema.nullable().optional(),
    sessionName: z.string().min(1).nullable(),
    /** Hold a proposed or approved candidate for prelaunch review. */
    park: z.boolean().optional(),
  })
  .strict();
const abandonExecutionBodySchema = z
  .object({ executionId: z.string().min(1), reason: z.string() })
  .strict();
const abandonSpecBodySchema = z.object({ reason: z.string() }).strict();
const renameSpecBodySchema = z
  .object({ slug: specSlugSchema, name: z.string().min(1).optional() })
  .strict();
const captureScopeAmendmentBodySchema = z
  .object({
    /** Optional: the spec's live attempt names the run it launched. */
    executionId: z.string().min(1).optional(),
    discoveredTask: taskElementPayloadSchema.omit({ kind: true }),
    blockingReason: z.string().optional(),
  })
  .strict();
const emptyBodySchema = z.object({}).strict();

// The plan request bodies are the CLI's `--file` documents, parsed by the same
// schemas on both sides (`src/lib/specs/delivery-plan-views.ts`).
const planOpenBodySchema = deliveryPlanOpenRequestSchema;
const planEditBodySchema = deliveryPlanEditRequestSchema;
const planReopenBodySchema = deliveryPlanReopenRequestSchema;
const planSignOffBodySchema = deliveryPlanSignOffRequestSchema;
const planCommentBodySchema = deliveryPlanCommentRequestSchema;
const planReaffirmBodySchema = deliveryPlanReaffirmRequestSchema;

type TransportResolution = RouteResolution<ActorProvenance>;

async function resolveTransportActor(
  auth: AgentAuth,
  request: Request,
): Promise<TransportResolution> {
  const transport = await auth.validateOptionalToken(request);
  if (transport.kind === "invalid") {
    return {
      ok: false,
      response: jsonError("Invalid Command Center API token", 401),
    };
  }
  if (transport.kind === "absent") {
    return { ok: true, value: actorProvenanceSchema.parse({ kind: "human" }) };
  }

  const conversationId = request.headers
    .get(SPEC_CALLER_CONVERSATION_HEADER)
    ?.trim();
  if (!conversationId) {
    return {
      ok: false,
      response: jsonError(
        "Originating conversation identity is required for agent mutations",
        400,
        "validation",
      ),
    };
  }
  const backend = request.headers.get(SPEC_CALLER_BACKEND_HEADER)?.trim();
  return {
    ok: true,
    value: actorProvenanceSchema.parse({
      kind: "agent",
      conversationId,
      ...(backend ? { backend } : {}),
    }),
  };
}

function validationResponse(error: z.ZodError): Response {
  return NextResponse.json(
    {
      error: "Spec request validation failed",
      code: "validation",
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
    { status: 400 },
  );
}

async function parseActionBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<RouteResolution<T>> {
  try {
    const parsed = schema.safeParse(await request.json());
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, response: validationResponse(parsed.error) };
  } catch {
    return {
      ok: false,
      response: jsonError(
        "Spec request body must be valid JSON",
        400,
        "validation",
      ),
    };
  }
}

function refusalStatus(refusal: Pick<Refusal, "code">): number {
  if (refusal.code === "human_act_required") return 403;
  if (refusal.code === "validation") return 400;
  if (refusal.code === "not_found") return 404;
  return 409;
}

export function specRefusalResponse(refusal: Refusal): Response {
  logger.warn("specs.transition_refused", {
    code: refusal.code,
    unmetConditionCount: refusal.unmetConditions.length,
  });
  return NextResponse.json(refusal, { status: refusalStatus(refusal) });
}

function serviceResultResponse(result: unknown): Response {
  if (
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    (result as { ok: unknown }).ok === false &&
    "refusal" in result
  ) {
    return specRefusalResponse((result as { refusal: Refusal }).refusal);
  }
  if (
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    (result as { ok: unknown }).ok === true
  ) {
    if ("value" in result) {
      return NextResponse.json((result as { value: unknown }).value);
    }
    return NextResponse.json(
      Object.fromEntries(
        Object.entries(result).filter(([key]) => key !== "ok"),
      ),
    );
  }
  return NextResponse.json(result ?? { ok: true });
}

const BROWSER_SESSION_REMEDY =
  "Perform this action from the authenticated browser session.";

/**
 * Action -> the remedy its refusal hands the agent. Most human-only acts have
 * one obvious home in Studio, so the generic browser-session line is enough;
 * an act whose surface an agent could not otherwise find names that surface.
 */
const HUMAN_ONLY_ACTIONS = new Map<string, string>([
  ["approve-item", BROWSER_SESSION_REMEDY],
  ["unapprove-item", BROWSER_SESSION_REMEDY],
  ["sign-off", BROWSER_SESSION_REMEDY],
  ["approve-remaining-and-sign-off", BROWSER_SESSION_REMEDY],
  ["bulk-approve", BROWSER_SESSION_REMEDY],
  ["grant-gate-approval", BROWSER_SESSION_REMEDY],
  ["approve-execution-start", BROWSER_SESSION_REMEDY],
  ["grant-waiver", BROWSER_SESSION_REMEDY],
  ["change-policy", BROWSER_SESSION_REMEDY],
  // Assumption disposition is the human half of the propose/dispose split
  // (mirrors waiver origin rules); the service also refuses agents, but the
  // route gate returns the typed refusal before any service work.
  ["dispose-assumption", BROWSER_SESSION_REMEDY],
  // Questions have the same split: an agent opens one FOR a human, so an
  // agent answering would clear its own blocking signal with no record that
  // no human ever decided. Studio's answer control is the human half.
  ["answer-question", BROWSER_SESSION_REMEDY],
  // Renames change the identity every copied reference resolves through, so
  // only the operator performs them; agents receive human_act_required.
  ["rename", BROWSER_SESSION_REMEDY],
  // Retiring the whole durable spec is the least reversible act on this
  // surface. Abandoning a single run ("abandon-execution") stays agent
  // reachable because stopping one run is ordinary agent work.
  ["abandon-spec", BROWSER_SESSION_REMEDY],
  // "dismiss-superseded" is deliberately absent: its refusal must name the
  // target revision, which only exists in the parsed body, and this gate runs
  // before the body is read. The service refuses it as its first act after
  // schema parse — no state read, no mutation — so the agent still gets a
  // typed human_act_required, and that one names the revision it refused.
]);

function humanActRequiredResponse(action: string): Response {
  return specRefusalResponse({
    code: "human_act_required",
    unmetConditions: [`${action} is a human-only Spec Studio action.`],
    instruction: HUMAN_ONLY_ACTIONS.get(action) ?? BROWSER_SESSION_REMEDY,
  });
}

/**
 * Slug of the spec a failing action addressed. Refusal instructions name the
 * exact recovery command, which is only actionable with the caller's slug;
 * project-scoped actions have none, so the copy degrades to a placeholder.
 */
interface SpecActionFailureContext {
  readonly specSlug: string;
}

function routeFailure(
  error: unknown,
  action: string,
  context?: SpecActionFailureContext,
): Response {
  if (error instanceof PersistenceError) {
    const { failure } = error;
    if (failure.kind === "not_found") {
      return notFound(`${failure.entity} not found`, "not_found", {
        entity: failure.entity,
        identifier: failure.identifier,
      });
    }
    if (failure.kind === "validation") {
      return jsonError(
        "Spec persistence validation failed",
        400,
        "validation",
        {
          entity: failure.entity,
          ...(failure.identifier === undefined
            ? {}
            : { identifier: failure.identifier }),
          issues: failure.issues,
        },
      );
    }
    if (failure.kind === "constraint") {
      return jsonError(
        "Spec persistence constraint failed",
        400,
        "validation",
        {
          constraint: failure.constraint,
          ...(failure.entity === undefined ? {} : { entity: failure.entity }),
          ...(failure.identifier === undefined
            ? {}
            : { identifier: failure.identifier }),
        },
      );
    }
  }
  if (error instanceof StaleElementConflictError) {
    return specRefusalResponse({
      code: "stale_element",
      unmetConditions: [error.message],
      instruction:
        "Read the current element version and retry the draft write.",
      details: {
        currentContent: error.current.payload,
        currentVersion: error.current.elementVersion,
      },
    });
  }
  if (error instanceof StageBlockedWriteError) {
    return specRefusalResponse(error.refusal);
  }
  if (error instanceof StaleStageConflictError) {
    return specRefusalResponse({
      code: "stale_stage",
      unmetConditions: [error.message],
      // With no draft open there is nothing to re-read: approved revisions are
      // immutable, so the only way forward is opening an amendment draft.
      instruction:
        error.currentRevision === null
          ? `This spec has no open draft, and its approved revisions are immutable. Run \`cctl spec amend ${context?.specSlug ?? "<slug>"}\` to open an amendment draft, then advance that draft.`
          : "Read the current draft and authoring stage, then advance that exact revision if it still applies.",
      details: {
        expectedRevisionId: error.expectedRevisionId,
        expectedStage: error.expectedStage,
        currentRevision: error.currentRevision,
      },
    });
  }
  if (error instanceof SpecSlugTakenError) {
    return specRefusalResponse({
      code: "slug_taken",
      unmetConditions: [error.message],
      instruction:
        "Read `cctl spec show <slug>` and continue the existing draft with `cctl spec draft <slug>`, or choose a different slug.",
      details: {
        existingSpecId: error.existingSpecId,
        name: error.existingName,
      },
    });
  }
  if (error instanceof SpecElementIdTakenError) {
    return specRefusalResponse({
      code: error.code,
      unmetConditions: [error.message],
      instruction: `Choose a globally unique element ID, preferably prefixed with the spec slug (for example, "<spec-slug>-${error.elementId}"), then retry.`,
      details: {
        elementId: error.elementId,
        existingSpecId: error.existingSpecId,
      },
    });
  }
  if (error instanceof SpecHistoricalElementError) {
    return specRefusalResponse(historicalElementRefusal(error));
  }
  if (error instanceof SpecRevisionImmutableError) {
    return specRefusalResponse(immutableRevisionRefusal(error));
  }
  if (error instanceof SpecRevisionInReviewError) {
    return specRefusalResponse({
      code: error.code,
      unmetConditions: [error.message],
      instruction: error.instruction,
      details: {
        proposals: error.proposals.map(({ id, number }) => ({ id, number })),
        approvedBaseRevisionId: error.approvedBase?.id ?? null,
      },
    });
  }
  if (
    error instanceof SpecDraftUnavailableError ||
    error instanceof SpecExportNotFoundError
  ) {
    return notFound("Spec target not found", "not_found");
  }
  if (error instanceof LinksServiceError) {
    const code = error.code === "not_found" ? "not_found" : "validation";
    return specRefusalResponse({
      code,
      unmetConditions: [error.message],
      instruction:
        code === "not_found"
          ? "Select an existing source object and try again."
          : "Correct the linked source request and try again.",
    });
  }
  if (error instanceof z.ZodError) return validationResponse(error);
  logger.error("specs.routes.mutation_failed", {
    action,
    error: error instanceof Error ? error.message : String(error),
  });
  return jsonError("Spec mutation failed", 500);
}

/**
 * A batch is all-or-nothing, so its refusal is one refusal about many
 * elements. The per-element results ride in `details.refusals`, indexed by the
 * caller's own array, so the writer can see exactly which element refused and
 * why without diffing what it sent against what landed (R24.1).
 */
function batchRefusal(refusals: readonly DraftElementBatchRefusal[]): Refusal {
  return {
    code: refusals[0]?.code ?? "validation",
    unmetConditions: refusals.map(
      (refusal) =>
        `[${refusal.index}]${refusal.elementId === null ? "" : ` ${refusal.elementId}`}: ${refusal.unmetConditions.join(" ")}`,
    ),
    instruction:
      "The batch was refused as a whole and nothing was written. Correct the elements named in details.refusals, then resubmit the batch.",
    details: { refusals },
  };
}

async function invokeAction<T>(
  request: Request,
  schema: z.ZodType<T>,
  operation: (input: T) => Promise<unknown>,
  context?: SpecActionFailureContext,
): Promise<Response> {
  try {
    const parsed = await parseActionBody(request, schema);
    if (!parsed.ok) return parsed.response;
    return serviceResultResponse(await operation(parsed.value));
  } catch (error) {
    return routeFailure(error, "spec-action", context);
  }
}

function createDefaultWriteDeps(): SpecWriteRouteDeps {
  return {
    auth: createAgentAuth(),
    resolveProjectPath: defaultResolveProjectPath,
    async resolveSpec(projectPath, slug) {
      const repo = createSpecsRepo(getStateDb(), getSharedWriteQueue());
      return repo.resolve(projectPath, slug);
    },
    async getServices(projectPath) {
      const { createProductionSpecRouteServices } =
        await import("./service-factory");
      return createProductionSpecRouteServices(projectPath);
    },
  };
}

export function createSpecWriteRouteHandlers(
  deps: SpecWriteRouteDeps = createDefaultWriteDeps(),
) {
  async function projectActionPOST(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const actor = await resolveTransportActor(deps.auth, request);
    if (!actor.ok) return actor.response;
    const project = await resolveSpecProjectRoute(deps, context);
    if (!project.ok) return project.response;
    const { action } = await context.params;

    try {
      const services = await deps.getServices(project.value.projectPath);
      switch (action) {
        case "create":
          return invokeAction(request, createSpecBodySchema, (input) =>
            services.authoring.createSpec({
              ...input,
              projectPath: project.value.projectPath,
              actor: actor.value,
            }),
          );
        case "promote-conversation":
          return invokeAction(request, promoteConversationBodySchema, (input) =>
            services.links.promoteConversation({
              ...input,
              projectPath: project.value.projectPath,
              actor: actor.value,
            }),
          );
        case "graduate-ticket":
          return invokeAction(request, graduateTicketBodySchema, (input) =>
            services.links.graduateTicket({ ...input, actor: actor.value }),
          );
        // Deliberately absent from HUMAN_ONLY_ACTIONS: an import is agent work
        // by construction — it authors a bundle from an external source — and
        // the spec it creates is born past its authoring gates on import
        // provenance, never on an approval a human would have to grant here.
        case "import":
          return invokeAction(request, importBundleSchema, (bundle) =>
            services.import.importSpec({
              projectPath: project.value.projectPath,
              bundle,
              actor: actor.value,
            }),
          );
        default:
          return notFound("Spec action not found");
      }
    } catch (error) {
      return routeFailure(error, action ?? "unknown-project-action");
    }
  }

  async function specActionPOST(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const actor = await resolveTransportActor(deps.auth, request);
    if (!actor.ok) return actor.response;
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { name, action } = await context.params;
    if (actor.value.kind === "agent" && HUMAN_ONLY_ACTIONS.has(action ?? "")) {
      return humanActRequiredResponse(action ?? "unknown");
    }

    try {
      const services = await deps.getServices(resolved.value.projectPath);
      const specId = resolved.value.spec.id;
      const withReviewIdentity = <T extends object>(input: T) => ({
        ...input,
        specId,
        actor: actor.value,
      });

      switch (action) {
        case "draft-upsert":
          return invokeAction(request, draftElementBodySchema, (input) =>
            services.authoring.upsertDraftElement(withReviewIdentity(input)),
          );
        case "draft-batch":
          return invokeAction(
            request,
            draftElementBatchBodySchema,
            async (input) => {
              const result = await services.authoring.upsertDraftElements(
                withReviewIdentity(input),
              );
              return result.ok
                ? result
                : {
                    ok: false as const,
                    refusal: batchRefusal(result.refusals),
                  };
            },
          );
        case "draft-reorder":
          return invokeAction(request, reorderDraftElementBodySchema, (input) =>
            services.authoring.reorderDraftElement(withReviewIdentity(input)),
          );
        case "draft-remove":
          return invokeAction(
            request,
            removeDraftElementBodySchema,
            async (input) => {
              await services.authoring.removeDraftElement(
                withReviewIdentity(input),
              );
              return { ok: true };
            },
          );
        case "open-amendment":
          return invokeAction(request, openAmendmentBodySchema, (input) =>
            services.authoring.openAmendment(withReviewIdentity(input)),
          );
        case "rename":
          return invokeAction(request, renameSpecBodySchema, (input) =>
            services.authoring.renameSpec(withReviewIdentity(input)),
          );
        case "propose":
          return invokeAction(request, proposeRevisionBodySchema, (input) =>
            services.authoring.proposeRevision(withReviewIdentity(input)),
          );
        case "advance":
          return invokeAction(
            request,
            advanceAuthoringStageBodySchema,
            (input) =>
              services.authoring.advanceAuthoringStage(
                withReviewIdentity(input),
              ),
            // Advance is the one action whose stale-stage refusal names a
            // recovery command that has to carry the caller's own slug.
            { specSlug: resolved.value.spec.slug },
          );
        case "comment":
          return invokeAction(request, reviewCommentBodySchema, (input) =>
            services.review.comment(withReviewIdentity(input)),
          );
        case "reply":
          return invokeAction(request, replyBodySchema, (input) =>
            services.review.replyToThread(withReviewIdentity(input)),
          );
        case "resolve-thread":
          return invokeAction(request, resolveThreadBodySchema, (input) =>
            services.review.resolveThread(withReviewIdentity(input)),
          );
        case "request-changes":
          return invokeAction(request, requestChangesBodySchema, (input) =>
            services.review.requestChanges(withReviewIdentity(input)),
          );
        case "approve-item":
          return invokeAction(request, approveItemBodySchema, (input) =>
            services.review.approveItem({
              ...withReviewIdentity(input),
              approver: "operator",
            }),
          );
        case "unapprove-item":
          return invokeAction(request, unapproveItemBodySchema, (input) =>
            services.review.unapproveItem(withReviewIdentity(input)),
          );
        case "sign-off":
          return invokeAction(request, signOffBodySchema, (input) =>
            services.review.signOffRevision({
              ...withReviewIdentity(input),
              approver: "operator",
            }),
          );
        case "approve-remaining-and-sign-off":
          return invokeAction(
            request,
            approveRemainingAndSignOffBodySchema,
            (input) =>
              services.review.approveRemainingAndSignOff({
                ...withReviewIdentity(input),
                approver: "operator",
              }),
          );
        case "grant-gate-approval":
          return invokeAction(request, grantGateApprovalBodySchema, (input) =>
            services.review.grantGateApproval({
              ...withReviewIdentity(input),
              approver: "operator",
            }),
          );
        case "approve-execution-start":
          return invokeAction(
            request,
            approveExecutionStartBodySchema,
            (input) =>
              services.execution.approveExecutionStart({
                ...input,
                specId,
                actor: actor.value,
                approver: "operator",
                projectName: name ?? "",
              }),
          );
        case "withdraw":
          return invokeAction(request, requestChangesBodySchema, (input) =>
            services.review.withdraw(withReviewIdentity(input)),
          );
        case "withdraw-proposal":
          return invokeAction(request, withdrawProposalBodySchema, (input) =>
            services.review.withdrawProposal(withReviewIdentity(input)),
          );
        case "dismiss-superseded":
          return invokeAction(
            request,
            dismissSupersededProposalBodySchema,
            (input) =>
              services.review.dismissSupersededProposal(
                withReviewIdentity(input),
              ),
          );
        case "bulk-approve":
          return invokeAction(request, bulkApproveBodySchema, (input) =>
            services.review.bulkApprove({
              ...withReviewIdentity(input),
              approver: "operator",
            }),
          );
        // Question and assumption mutations answer with the same domain
        // shape the read path projects (camelCase, parsed provenance, the
        // handle every later call must quote) — never the persistence row.
        case "open-question":
          return invokeAction(
            request,
            openQuestionBodySchema,
            async (input) => {
              const result = await services.review.openQuestion(
                withReviewIdentity(input),
              );
              return result.ok
                ? { ...result, value: toQuestionView(result.value) }
                : result;
            },
          );
        case "answer-question":
          return invokeAction(
            request,
            answerQuestionBodySchema,
            async (input) => {
              const result = await services.review.answerQuestion(
                withReviewIdentity(input),
              );
              return result.ok
                ? { ...result, value: toQuestionView(result.value) }
                : result;
            },
          );
        case "propose-assumption":
          return invokeAction(
            request,
            proposeAssumptionBodySchema,
            async (input) => {
              const result = await services.review.proposeAssumption(
                withReviewIdentity(input),
              );
              return result.ok
                ? { ...result, value: toAssumptionView(result.value) }
                : result;
            },
          );
        case "request-approval":
          return invokeAction(request, requestApprovalBodySchema, (input) =>
            services.review.requestApproval(withReviewIdentity(input)),
          );
        case "dispose-assumption":
          return invokeAction(
            request,
            disposeAssumptionBodySchema,
            async (input) => {
              const result = await services.review.disposeAssumption(
                withReviewIdentity(input),
              );
              return result.ok
                ? { ...result, value: toAssumptionView(result.value) }
                : result;
            },
          );
        case "change-policy":
          return invokeAction(request, changePolicyBodySchema, (input) =>
            services.review.changePolicy(withReviewIdentity(input)),
          );
        // "attach-evidence" and "record-verdict" were removed with the
        // evidence-kind narrowing (ticket #24): evidence and proof verdicts
        // originate only from execution ingestion or gate-side issuance, so
        // both fall through to the 404 default.
        case "claim-task-complete":
          return invokeAction(request, taskClaimBodySchema, (input) =>
            services.evidence.claimTaskComplete({
              ...input,
              specId,
              actor: actor.value,
            }),
          );
        case "reopen-claim":
          return invokeAction(request, claimIdBodySchema, (input) =>
            input.changedIntentElementIds.length === 0
              ? services.evidence.reopenTaskClaim(input.claimId, actor.value)
              : services.evidence.reopenTaskClaim(
                  input.claimId,
                  actor.value,
                  input.changedIntentElementIds,
                ),
          );
        case "request-waiver":
          if (actor.value.kind !== "agent") {
            return specRefusalResponse({
              code: "validation",
              unmetConditions: [
                "Waiver requests from this route require agent provenance.",
              ],
              instruction:
                "Grant or reject the waiver from Spec Studio instead.",
            });
          }
          return invokeAction(request, waiverBodySchema, (input) =>
            services.evidence.requestWaiver({
              ...input,
              specId,
              source: actor.value as Extract<
                ActorProvenance,
                { kind: "agent" }
              >,
            }),
          );
        case "grant-waiver":
          return invokeAction(request, waiverBodySchema, (input) =>
            services.evidence.grantWaiver({
              ...input,
              specId,
              actor: actor.value,
            }),
          );
        case "mark-waiver-stale":
          return invokeAction(request, staleWaiverBodySchema, (input) =>
            services.evidence.markWaiverStaleForCriterionChange({
              ...input,
              actor: actor.value,
            }),
          );
        case "set-disposition":
          return invokeAction(request, dispositionBodySchema, (input) =>
            services.evidence.setDisposition({ ...input, actor: actor.value }),
          );
        case "start-execution":
          return invokeAction(
            request,
            startExecutionBodySchema,
            async (input) => {
              if (input.scope !== undefined && input.scope !== null) {
                logger.warn("specs.routes.execution-scope-retired", {
                  specId,
                  specSlug: resolved.value.spec.slug,
                  actorKind: actor.value.kind,
                  parkRequested: input.park === true,
                });
                return {
                  ok: false as const,
                  refusal: {
                    code: "validation" as const,
                    unmetConditions: [
                      "Execution scope documents are retired; the approved delivery plan is the execution graph.",
                    ],
                    instruction: `Nothing was started. Import legacy planning with \`cctl spec plan open ${resolved.value.spec.slug} --seed-from last\`, then propose and sign off that candidate before rerunning \`cctl spec start ${resolved.value.spec.slug}\`.`,
                  },
                };
              }
              const { scope: _retiredScope, ...activeInput } = input;
              const startInput = {
                ...activeInput,
                specId,
                actor: actor.value,
                projectName: name ?? "",
              };
              // A park launches nothing, so it is a different act with a
              // different receipt rather than a start that quietly did less.
              if (activeInput.park === true) {
                const parked =
                  await services.execution.parkDeliveryPlan(startInput);
                return parked.ok
                  ? { ok: true as const, parked: parked.value }
                  : parked;
              }
              const result = await services.execution.start(startInput);
              if (!result.ok) return result;
              return {
                ok: true as const,
                execution: toStartedExecutionView(
                  result.execution,
                  result.revisionNumber,
                ),
                definition: result.definition,
                deliveryPlan: result.deliveryPlan,
              };
            },
          );
        case "abandon-execution":
          return invokeAction(request, abandonExecutionBodySchema, (input) =>
            services.execution.abandonExecution({
              ...input,
              actor: actor.value,
            }),
          );
        case "abandon-spec":
          return invokeAction(request, abandonSpecBodySchema, (input) =>
            services.execution.abandonSpec({
              ...input,
              specId,
              actor: actor.value,
            }),
          );
        case "capture-scope-amendment":
          return invokeAction(
            request,
            captureScopeAmendmentBodySchema,
            (input) =>
              services.execution.captureScopeAmendment({
                ...input,
                specId,
                actor: actor.value,
              }),
          );
        case "materialize-tasks":
          return invokeAction(request, materializeTasksBodySchema, (input) =>
            services.links.materializeApprovedTasks({
              ...input,
              specId,
              actor: actor.value,
            }),
          );
        case "link-ticket":
          return invokeAction(request, linkTicketBodySchema, (input) =>
            services.links.linkTicket({
              ...input,
              specId,
              actor: actor.value,
            }),
          );
        case "verify":
          // The report's own `ok` field collides with the Result-envelope
          // convention in serviceResultResponse, so wrap it explicitly.
          return invokeAction(request, emptyBodySchema, async () => ({
            ok: true as const,
            value: await services.verify(specId),
          }));
        case "plan-open":
          return invokeAction(request, planOpenBodySchema, (input) =>
            services.deliveryPlan.open({
              spec: resolved.value.spec,
              seedFromLast: input.seedFromLast,
              actor: actor.value,
            }),
          );
        case "plan-edit":
          return invokeAction(request, planEditBodySchema, (input) =>
            services.deliveryPlan.edit({
              spec: resolved.value.spec,
              expectedDraftRevision: input.expectedDraftRevision,
              document: input.document,
              actor: actor.value,
            }),
          );
        case "plan-propose":
          return invokeAction(request, emptyBodySchema, () =>
            services.deliveryPlan.propose({
              spec: resolved.value.spec,
              actor: actor.value,
            }),
          );
        case "plan-reopen":
          return invokeAction(request, planReopenBodySchema, (input) =>
            services.deliveryPlan.reopen({
              spec: resolved.value.spec,
              reason: input.reason,
              actor: actor.value,
            }),
          );
        // The one default approval: it binds the candidate identity the caller
        // read and admits `execution_start` in the same act. Human attribution
        // rides the transport actor, so a Studio sign-off is a human act and an
        // agent's is refused whenever the dial says a human decides.
        case "plan-sign-off":
          return invokeAction(request, planSignOffBodySchema, (input) =>
            services.deliveryPlan.signOff({
              spec: resolved.value.spec,
              ...input,
              actor: actor.value,
              approver: actor.value.kind === "human" ? "operator" : "agent",
            }),
          );
        // The audited human reaffirmation of one soft-stale criterion. Human
        // attribution rides the transport actor, so an agent's call is refused
        // by the service rather than by a client-side guard.
        case "plan-reaffirm":
          return invokeAction(request, planReaffirmBodySchema, (input) =>
            services.deliveryPlan.reaffirm({
              spec: resolved.value.spec,
              ...input,
              actor: actor.value,
            }),
          );
        // A review note anchored to one context of the live attempt. The
        // transport actor is the author, so the comment carries the same
        // durable attribution every other spec act does.
        case "plan-comment":
          return invokeAction(request, planCommentBodySchema, (input) =>
            services.deliveryPlan.comment({
              spec: resolved.value.spec,
              ...input,
              actor: actor.value,
            }),
          );
        default:
          return notFound("Spec action not found");
      }
    } catch (error) {
      return routeFailure(error, action ?? "unknown-spec-action");
    }
  }

  /**
   * The delivery-plan read. It lives beside the plan mutations rather than in
   * the read-handler family because it reads through the same service the
   * mutations write through — one projection owner, so `spec plan status` and
   * an edit receipt can never disagree about what the attempt owes.
   */
  async function specPlanGET(
    _request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    try {
      const services = await deps.getServices(resolved.value.projectPath);
      const result = await services.deliveryPlan.read({
        spec: resolved.value.spec,
      });
      return serviceResultResponse(result);
    } catch (error) {
      return routeFailure(error, "plan-read");
    }
  }

  /**
   * The delivery-plan review read: the plan projection resolved with its
   * pinned criteria in full. It is a separate route rather than a field on
   * `specPlanGET` because the criterion text is what a Studio reviewer needs
   * and what a `cctl spec plan status` receipt would only have to truncate —
   * one service call behind both, two response bounds in front.
   */
  async function specPlanReviewGET(
    _request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    try {
      const services = await deps.getServices(resolved.value.projectPath);
      return serviceResultResponse(
        await services.deliveryPlan.review({ spec: resolved.value.spec }),
      );
    } catch (error) {
      return routeFailure(error, "plan-review");
    }
  }

  /**
   * The semantic diff between two of the attempt's frozen snapshots. A read,
   * mounted beside the plan mutations for the same reason the others are: the
   * snapshots it compares are written by propose, and one owner is what keeps
   * a diff from ever describing bytes no proposal froze.
   */
  async function specPlanDiffGET(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (from === null || to === null) {
      return jsonError(
        `Invalid plan diff request. Pass ?from=<snapshotId>&to=<snapshotId>; list this attempt's snapshots with cctl spec plan status ${resolved.value.spec.slug}.`,
        400,
        "plan_diff_invalid_request",
      );
    }
    try {
      const services = await deps.getServices(resolved.value.projectPath);
      return serviceResultResponse(
        await services.deliveryPlan.diffSnapshots({
          spec: resolved.value.spec,
          fromSnapshotId: from,
          toSnapshotId: to,
        }),
      );
    } catch (error) {
      return routeFailure(error, "plan-diff");
    }
  }

  /**
   * The delivery-plan preview. A read, but mounted here beside the plan
   * mutations for the same reason `specPlanGET` is: previewing a draft
   * compiles the very document propose freezes, and one owner is what keeps a
   * preview and a proposal from ever compiling different bytes.
   */
  async function specPlanPreviewGET(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const url = new URL(request.url);
    const rawExpected = url.searchParams.get("expectedDraftRevision");
    const parsed = deliveryPlanPreviewRequestSchema.safeParse({
      stage: url.searchParams.get("stage") ?? "proposed",
      ...(rawExpected === null
        ? {}
        : { expectedDraftRevision: Number(rawExpected) }),
    });
    if (!parsed.success) {
      return jsonError(
        `Invalid plan preview request. Pass ?stage=draft or ?stage=proposed, and an optional integer ?expectedDraftRevision, then re-run cctl spec plan preview ${resolved.value.spec.slug} --stage <draft|proposed>.`,
        400,
        "plan_preview_invalid_request",
      );
    }
    try {
      const services = await deps.getServices(resolved.value.projectPath);
      return serviceResultResponse(
        await services.deliveryPlan.preview({
          spec: resolved.value.spec,
          stage: parsed.data.stage,
          ...(parsed.data.expectedDraftRevision === undefined
            ? {}
            : { expectedDraftRevision: parsed.data.expectedDraftRevision }),
        }),
      );
    } catch (error) {
      return routeFailure(error, "plan-preview");
    }
  }

  return {
    projectActionPOST,
    specActionPOST,
    specPlanGET,
    specPlanReviewGET,
    specPlanDiffGET,
    specPlanPreviewGET,
  };
}

const writeHandlers = createSpecWriteRouteHandlers();
export const specProjectActionPOST = withTracing(
  writeHandlers.projectActionPOST,
);
export const specActionPOST = withTracing(writeHandlers.specActionPOST);
export const specPlanGET = withTracing(writeHandlers.specPlanGET);
export const specPlanReviewGET = withTracing(writeHandlers.specPlanReviewGET);
export const specPlanDiffGET = withTracing(writeHandlers.specPlanDiffGET);
export const specPlanAttemptPreviewGET = withTracing(
  writeHandlers.specPlanPreviewGET,
);
