import { specDeliveryBasisSchema } from "./schemas";
import type { DeliveryApprovalService } from "./delivery-approval";
import type { DeliveryReviewService } from "./delivery-review-service";
import type { DeliveryContinuationService } from "./delivery-continuation";
import type { DeliveryReviewView } from "./delivery-review-schemas";
import {
  acceptanceReviewRequestSchema,
  deliveryContinuationRequestSchema,
  deliveryReplacementRequestSchema,
  deliveryApprovalRequestSchema,
} from "./delivery-review-schemas";
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
import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
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
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/spec-bridge";

import { draftAuthoringSequence } from "./authoring-sequence";
import {
  projectAttentionRecords,
  type AssumptionAttentionProjection,
  type AttentionRecordsProjection,
  type QuestionAttentionProjection,
} from "./attention-projection";
import { projectAttentionAuditEvents } from "./attention-audit-events";
import {
  SpecDraftUnavailableError,
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
  returnToRequirementsInputSchema,
  type AuthoringService,
} from "./authoring-service";
import { isEarlierMergedDelivery } from "./delivery-history";
import { findDeliveryVerdictForExecution } from "./delivery-verdict-identity";
import type { DeliveryPlanService } from "./delivery-plan-service";
import {
  deliveryPlanStatus,
  deliveryPlanEditRequestSchema,
  deliveryPlanOpenRequestSchema,
  deliveryPlanPreviewRequestSchema,
  deliveryPlanAbandonRequestSchema,
  deliveryPlanReopenRequestSchema,
  deliveryPlanCommentRequestSchema,
  deliveryPlanReaffirmBatchRequestSchema,
  deliveryPlanSignOffRequestSchema,
} from "./delivery-plan-views";
import { DRAFT_HEALTH_TOP_FINDINGS, draftHealth } from "./draft-health";
import type { EvidenceService } from "./evidence-service";
import { createSpecEventsPublisher } from "./events";
import type { LinkedSpecExecutionBindingV2 } from "./execution-binding";
import {
  loadSpecExportState,
  renderVerifiedCanonicalBundle,
  SpecExportNotFoundError,
  verifyExportState,
  type CanonicalSpecBundle,
  type IntegrityReport,
} from "./export";
import {
  type ExecutionService,
  type ReconciledSpecExecution,
  type SpecWorkflowCleanupTarget,
} from "./execution-service";
import { createProductionSpecWorkflowCleanupPort } from "./workflow-cleanup-port";
import { nativeSddSeedSourceSummary } from "./execution-seed-source";
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
import type { ApprovalLedger } from "./approval-ledger";
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
  projectDeliveryDisplay,
  projectRequirementStatus,
  projectSpecPhase,
  projectTaskWorkStatus,
  type DeliveryCriterion,
  type IdentifiedDeliveryCriterion,
  type RequirementStatusInput,
  type SpecPhaseProjection,
} from "./phase";
import { revisionReviewHash } from "./review-hash";
import { HUMAN_ACT_REQUIRED_RATIONALE } from "./refusal-rationale";
import { proposalNotes } from "./proposal-notes";
import {
  elementHandleInSnapshot,
  toCitationDiffContext,
  toDiffCitations,
  toDiffRows,
  toLintSnapshot,
} from "./review-state";
import {
  answerQuestionInputSchema,
  approveItemInputSchema,
  unapproveItemInputSchema,
  bulkApproveInputSchema,
  changeSpecPolicyInputSchema,
  disposeAssumptionInputSchema,
  editAttentionRecordInputSchema,
  openQuestionInputSchema,
  proposeAssumptionInputSchema,
  mutateAssumptionCitationInputSchema,
  requestApprovalInputSchema,
  grantGateApprovalInputSchema,
  withdrawDraftInputSchema,
  replyToReviewThreadInputSchema,
  resolveReviewThreadInputSchema,
  reviewCommentInputSchema,
  approveRemainingAndSignOffInputSchema,
  signOffRevisionInputSchema,
  supersedeAssumptionInputSchema,
  withdrawAttentionRecordInputSchema,
  type ReviewService,
} from "./review-service";
import { executionScopeSchema, type ExecutionScope } from "./scope-validation";
import { isWaiverValidForExecution } from "./waiver-staleness";
import { projectSpecComment } from "./comment-projection";
import {
  assembleSpecCommentThreads,
  summarizeSpecComments,
} from "./comment-threads";
import type {
  CriterionDeliveryProjection,
  DraftReviewView,
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
  SpecSectionView,
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
  type SpecDeliveryVerdictRow,
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
  readDeliveryPlan(
    spec: Spec,
  ): Promise<PublishedSpecStatusView["deliveryPlan"]>;
  readDeliveryReview(spec: Spec): Promise<DeliveryReviewView | null>;
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
   * the disposition document each review request carried — the notes live on
   * the propose event, so nothing else can answer for them.
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
  findWorkflowEventsByExecution(
    projectPath: string,
    sessionName: string,
    executionId: string,
  ): GraphWorkflowExecutionEvent[];
  reconcileExecution(
    projectPath: string,
    execution: SpecExecutionRow,
  ): Promise<ReconciledSpecExecution>;
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
  findDeliveryVerdictsBySpecExecutionId(
    executionId: string,
  ): SpecDeliveryVerdictRow[];
  findExecutionBindingBySpecExecutionId(
    executionId: string,
  ): LinkedSpecExecutionBindingV2 | null;
  findWaiverForCriterionRevision(
    criterionElementId: string,
    revisionId: string,
  ): SpecWaiverRow | null;
  /** By-id waiver resolution for persisted disposition and delta history. */
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
  currentRevision: PublishedSpecStatusView["currentRevision"];
  slug: string;
  phase: SpecPhaseProjection;
  executions: SpecStatusExecution[];
  gates: ProjectedGateStatus[];
  authoringSequence: RemainingAuthoringSequence | null;
  pendingApprovals: PendingApproval[];
  importCarriedApprovals: ImportCarriedApproval[];
  approvalLedger: ApprovalLedger;
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
  const executionBindings = createSpecExecutionBindingRepo(db);
  const links = createSpecLinksRepo(db);
  const eventsRepo = createSpecEventsRepo(db);
  const workflowEvents = createGraphWorkflowEventsRepo(db);
  const measures = createMeasuresQuery({
    specs,
    events: eventsRepo,
    delivery,
    executionBindings,
    now: () => new Date().toISOString(),
  });
  const authoring = createAuthoringService({
    specs,
    review,
    links,
    events: createSpecEventsPublisher({
      appendInTransaction: (event) => eventsRepo.append(event),
    }),
    attention: eventsRepo,
  });
  // Verification reads the linked run through the SAME observe seam the
  // abandon coordinator acts through, so an orphan it reports is an orphan
  // the coordinator would agree it has to clear.
  const exportDeps = {
    specs,
    review,
    delivery,
    events: eventsRepo,
    observeLinkedWorkflow: (target: SpecWorkflowCleanupTarget) =>
      createProductionSpecWorkflowCleanupPort().observe(target),
  };

  return {
    async readDeliveryPlan(spec) {
      const services = await loadProductionSpecRouteServices(spec.projectPath);
      const result = await services.deliveryPlan.read({ spec });
      if (!result.ok) return null;
      return deliveryPlanStatus(result.value);
    },
    async readDeliveryReview(spec) {
      const services = await loadProductionSpecRouteServices(spec.projectPath);
      return services.readDeliveryReview(spec);
    },
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
    findWorkflowEventsByExecution: (projectPath, sessionName, executionId) =>
      workflowEvents.findByExecution(projectPath, sessionName, executionId),
    async reconcileExecution(projectPath, execution) {
      const services = await loadProductionSpecRouteServices(projectPath);
      const result = await services.execution.getStatus(execution.id);
      return result.ok ? result.value : { execution, workflowStatus: null };
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
    findDeliveryVerdictsBySpecExecutionId: (executionId) =>
      delivery.findDeliveryVerdictsBySpecExecutionId(executionId),
    findExecutionBindingBySpecExecutionId: (executionId) =>
      executionBindings.findBySpecExecutionId(executionId),
    findWaiverForCriterionRevision: (criterionElementId, revisionId) =>
      delivery.findWaiverForCriterionRevision(criterionElementId, revisionId),
    findWaiverById: (waiverId) => delivery.findWaiverById(waiverId),
    findWaiversByRevision: (revisionId) =>
      delivery.findWaiversByRevision(revisionId),
    async exportSpec(specId) {
      return renderVerifiedCanonicalBundle(
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

/** The approval authority for the current revision. */
function loadApprovalApplicability(
  state: CurrentSpecState,
): ApprovalApplicability {
  const current = state.currentSnapshot;
  if (current === null) {
    return () => false;
  }
  return createApprovalApplicability({
    revisionId: current.revision.id,
    ancestorRevisionIds: ancestorIds(state.revisions, current.revision.id),
    revisionRows: toDiffRows(current),
    citationContractVersion: current.revision.citationContractVersion,
    citations: toDiffCitations(current),
    parentCitationContractVersion:
      state.baseSnapshot?.revision.citationContractVersion ?? null,
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

function recordedCriterionDelivery(
  deps: SpecRouteDeps,
  execution: SpecExecutionRow,
  criterionId: string,
  visited = new Set<string>(),
): "accepted_and_merged" | "delivered_externally" | null {
  if (execution.state !== "delivered" || visited.has(execution.id)) return null;
  visited.add(execution.id);
  const disposition = deps
    .findCriterionDispositionsByExecution(execution.id)
    .find((row) => row.criterion_element_id === criterionId);
  if (
    disposition?.disposition === "delivered_elsewhere" &&
    disposition.delivered_by_execution_id
  ) {
    const source = deps
      .findExecutionsBySpecId(execution.spec_id)
      .find((row) => row.id === disposition.delivered_by_execution_id);
    return source
      ? recordedCriterionDelivery(deps, source, criterionId, visited)
      : null;
  }
  if (
    disposition?.disposition !== "in_scope" ||
    disposition.delivered_by_execution_id !== execution.id
  )
    return null;
  const verified = findDeliveryVerdictForExecution(
    deps.findDeliveryVerdictsBySpecExecutionId(execution.id),
    execution,
    deps.findExecutionBindingBySpecExecutionId(execution.id),
    criterionId,
  );
  if (verified !== null) return null;
  const basis = execution.delivery_basis_json
    ? specDeliveryBasisSchema.parse(JSON.parse(execution.delivery_basis_json))
    : null;
  return basis?.kind === "external"
    ? "delivered_externally"
    : "accepted_and_merged";
}

function deliveryCriteria(
  deps: SpecRouteDeps,
  currentApprovedSnapshot: SpecRevisionSnapshot | null,
  executions: readonly SpecExecutionRow[],
): IdentifiedDeliveryCriterion[] {
  const currentApprovedRevisionId = currentApprovedSnapshot?.revision.id;
  const externalDelivery =
    currentApprovedSnapshot?.revision.externalDelivery ?? null;
  const deliveredExecutions = executions.filter(
    (execution) =>
      execution.state === "delivered" &&
      execution.revision_id === currentApprovedRevisionId,
  );
  const hasBoundDeliveryAttempt = deliveredExecutions.some(
    (execution) =>
      deps.findExecutionBindingBySpecExecutionId(execution.id) !== null,
  );
  const executionById = new Map(executions.map((row) => [row.id, row]));
  const dispositionsByExecution = new Map(
    executions.map((execution) => [
      execution.id,
      deps.findCriterionDispositionsByExecution(execution.id),
    ]),
  );
  const priorRuns: PriorRunLookup = {
    findExecutionById: (executionId) => executionById.get(executionId) ?? null,
    findCriterionDisposition: (executionId, criterionElementId) =>
      dispositionsByExecution
        .get(executionId)
        ?.find((row) => row.criterion_element_id === criterionElementId) ??
      null,
  };
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

        const proven = deliveredExecutions.some((execution) => {
          const disposition = dispositionsByExecution
            .get(execution.id)
            ?.find((row) => row.criterion_element_id === element.id);
          if (disposition?.disposition === "delivered_elsewhere") {
            return (
              isEarlierMergedDelivery(priorRuns, execution, disposition) &&
              recordedCriterionDelivery(deps, execution, element.id) === null
            );
          }
          if (disposition?.disposition !== "in_scope") return false;
          const linkedBinding = deps.findExecutionBindingBySpecExecutionId(
            execution.id,
          );
          if (linkedBinding === null) {
            if (hasBoundDeliveryAttempt) return false;
            return deps
              .findProofVerdictsByCriterionRevision(
                element.id,
                currentApprovedSnapshot.revision.id,
              )
              .some((verdict) => verdict.stale_at === null);
          }
          return (
            findDeliveryVerdictForExecution(
              deps.findDeliveryVerdictsBySpecExecutionId(execution.id),
              execution,
              linkedBinding,
              element.id,
            ) !== null
          );
        });
        if (proven) {
          return {
            criterionElementId: element.id,
            state: "proven_and_merged" as const,
          };
        }

        const recorded = deliveredExecutions
          .map((execution) =>
            recordedCriterionDelivery(deps, execution, element.id),
          )
          .find((state) => state !== null);
        if (recorded)
          return { criterionElementId: element.id, state: recorded };

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
  const deliveredExecutions = deps
    .findExecutionsBySpecId(revision.specId)
    .filter(
      (execution) =>
        execution.state === "delivered" &&
        execution.revision_id === revision.id,
    );
  const boundExecutions = deliveredExecutions.flatMap((execution) => {
    const linkedBinding = deps.findExecutionBindingBySpecExecutionId(
      execution.id,
    );
    return linkedBinding === null ? [] : [{ execution, linkedBinding }];
  });
  if (
    boundExecutions.some(
      ({ execution, linkedBinding }) =>
        findDeliveryVerdictForExecution(
          deps.findDeliveryVerdictsBySpecExecutionId(execution.id),
          execution,
          linkedBinding,
          criterionElementId,
        ) !== null,
    )
  ) {
    return "proven";
  }
  if (
    deliveredExecutions.some(
      (execution) =>
        recordedCriterionDelivery(deps, execution, criterionElementId) ===
        "delivered_externally",
    )
  )
    return "delivered_externally";
  if (boundExecutions.length > 0) {
    return revision.externalDelivery === null
      ? "pending"
      : "delivered_externally";
  }
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
  if (approvalHeld(approvals, applies, subjectKind, elementId) !== null) {
    return "valid";
  }
  const latest = latestApprovalValidity(approvals, subjectKind, elementId);
  return latest === "stale" || latest === "closed" ? latest : "unapproved";
}

function buildElementStatuses(
  deps: SpecRouteDeps,
  snapshot: SpecRevisionSnapshot | null,
  approvals: readonly SpecApprovalRow[],
): SpecElementStatusesView {
  if (snapshot === null) {
    return { requirements: [], tasks: [] };
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
      return {
        elementId: row.element.id,
        status: projectTaskWorkStatus({ executionEvents: [] }),
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
    assumptionCitations: snapshot.assumptionCitations,
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
    workflowSeedSource: nativeSddSeedSourceSummary(execution),
    workflowExecutionId: execution.workflow_execution_id,
    ...(execution.delivery_basis_json
      ? {
          deliveryBasis: specDeliveryBasisSchema.parse(
            JSON.parse(execution.delivery_basis_json),
          ),
        }
      : {}),
    scope,
    sessionName: execution.session_name,
    deliveredAt: execution.delivered_at,
    abandonedReason: execution.abandoned_reason,
    createdAt: execution.created_at,
    updatedAt: execution.updated_at,
    deliveryProjection,
  };
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
    workflowSeedSource: nativeSddSeedSourceSummary(execution),
    workflowExecutionId: execution.workflow_execution_id,
    ...(execution.delivery_basis_json
      ? {
          deliveryBasis: specDeliveryBasisSchema.parse(
            JSON.parse(execution.delivery_basis_json),
          ),
        }
      : {}),
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
 * The per-criterion delivery standing the merge-gate panel renders. A valid
 * pinned-revision waiver wins, external delivery must satisfy the prior-run
 * rule, and a graph verdict must name this exact spec/workflow execution and
 * criterion.
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
  const criterionIds = new Set(
    pinnedSnapshot.elements.flatMap((entry) =>
      entry.version.payload.kind === "criterion" ? [entry.element.id] : [],
    ),
  );
  return scope.selectedCriterionIds.flatMap((criterionElementId) => {
    if (!criterionIds.has(criterionElementId)) return [];
    return [
      {
        criterionElementId,
        handle:
          elementHandleInSnapshot(pinnedSnapshot, criterionElementId) ??
          criterionElementId,
        ...criterionDeliveryState(
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

function criterionDeliveryState(
  deps: SpecRouteDeps,
  execution: SpecExecutionRow,
  criterionElementId: string,
  dispositions: readonly SpecCriterionDispositionRow[],
  priorRuns: PriorRunLookup,
): Pick<CriterionDeliveryProjection, "deliveryState" | "verdict"> {
  const disposition = dispositions.find(
    (row) => row.criterion_element_id === criterionElementId,
  );
  const waiver = deps.findWaiverForCriterionRevision(
    criterionElementId,
    execution.revision_id,
  );
  if (isWaiverValidForExecution(waiver, execution, criterionElementId)) {
    return { deliveryState: "waived", verdict: null };
  }
  if (
    disposition?.disposition === "delivered_elsewhere" &&
    isEarlierMergedDelivery(priorRuns, execution, disposition)
  ) {
    return { deliveryState: "delivered_elsewhere", verdict: null };
  }
  const verdict = deps.findDeliveryVerdictsBySpecExecutionId(execution.id);
  const matchedVerdict = findDeliveryVerdictForExecution(
    verdict,
    execution,
    deps.findExecutionBindingBySpecExecutionId(execution.id),
    criterionElementId,
  );
  if (matchedVerdict === null) {
    return { deliveryState: "awaiting_outcome", verdict: null };
  }
  return {
    deliveryState:
      execution.state === "delivered" ? "delivered" : "verdict_recorded",
    verdict: matchedVerdict,
  };
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

function toQuestionView(
  projection: QuestionAttentionProjection,
): SpecQuestionView {
  const { row } = projection;
  return {
    id: row.id,
    number: row.number,
    handle: formatBareElementHandle({ kind: "question", number: row.number }),
    elementId: row.element_id,
    text: row.text,
    recordVersion: row.record_version,
    status: row.status,
    answer: row.answer,
    answeredAt: row.answered_at,
    withdrawnAt: row.withdrawn_at,
    provenance: parseProvenance(row.provenance_json),
    presentation: projection.presentation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAssumptionView(
  projection: AssumptionAttentionProjection,
  assumptionsById: ReadonlyMap<string, SpecAssumptionRow>,
  draftSnapshot: SpecRevisionSnapshot | null,
): SpecAssumptionView {
  const { row } = projection;
  const handleFor = (assumptionId: string | null): string | null => {
    if (assumptionId === null) return null;
    const assumption = assumptionsById.get(assumptionId);
    return assumption === undefined
      ? null
      : formatBareElementHandle({
          kind: "assumption",
          number: assumption.number,
        });
  };
  return {
    id: row.id,
    number: row.number,
    handle: formatBareElementHandle({ kind: "assumption", number: row.number }),
    elementId: row.element_id,
    text: row.text,
    recordVersion: row.record_version,
    disposition: row.disposition,
    disposedAt: row.disposed_at,
    withdrawnAt: row.withdrawn_at,
    proposedBy: parseProvenance(row.proposed_by_json),
    supersedesHandle: handleFor(row.supersedes_assumption_id),
    supersededByHandle: handleFor(projection.supersededByAssumptionId),
    currentDraftCitations:
      projection.currentDraftCitations === null
        ? null
        : {
            ...projection.currentDraftCitations,
            citations: projection.currentDraftCitations.citations.map(
              (citation) => ({
                ...citation,
                elementHandle:
                  draftSnapshot === null
                    ? null
                    : elementHandleInSnapshot(
                        draftSnapshot,
                        citation.elementId,
                      ),
              }),
            ),
          },
    presentation: projection.presentation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadAttentionProjection(
  deps: Pick<
    SpecRouteDeps,
    | "listRevisions"
    | "getRevisionSnapshot"
    | "findQuestionsBySpecId"
    | "findAssumptionsBySpecId"
    | "findEventsBySpecId"
  >,
  spec: Spec,
  revisions?: readonly SpecRevision[],
): Promise<{
  readonly projection: AttentionRecordsProjection;
  readonly draftSnapshot: SpecRevisionSnapshot | null;
  readonly assumptionsById: ReadonlyMap<string, SpecAssumptionRow>;
}> {
  const revisionRows = revisions ?? (await deps.listRevisions(spec.id));
  const snapshots = (
    await Promise.all(
      revisionRows.map((revision) => deps.getRevisionSnapshot(revision.id)),
    )
  ).filter((snapshot): snapshot is SpecRevisionSnapshot => snapshot !== null);
  const draftSnapshot =
    snapshots.find((snapshot) => snapshot.revision.state === "draft") ?? null;
  const assumptions = deps.findAssumptionsBySpecId(spec.id);
  return {
    projection: projectAttentionRecords({
      spec,
      revisions: revisionRows,
      currentDraftSnapshot: draftSnapshot,
      frozenSnapshots: snapshots.filter(
        (snapshot) => snapshot.revision.state !== "draft",
      ),
      questions: deps.findQuestionsBySpecId(spec.id),
      assumptions,
      events: deps.findEventsBySpecId(spec.id),
    }),
    draftSnapshot,
    assumptionsById: new Map(
      assumptions.map((assumption) => [assumption.id, assumption]),
    ),
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
  const attention = await loadAttentionProjection(deps, spec, state.revisions);
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
  const applies = loadApprovalApplicability(state);
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
  const importBaselineCitationState =
    importBaselineSnapshot === null
      ? null
      : {
          citationContractVersion:
            importBaselineSnapshot.revision.citationContractVersion,
          citations: toDiffCitations(importBaselineSnapshot),
        };
  // Sign-off is blocked by unresolved blocking threads and sign-off lint as
  // well as by outstanding subjects, so the status projection reads the same
  // three sources the sign-off transition does. The findings tier rides this
  // same read rather than adding a second one: status stays one round trip.
  const health = draftHealth(
    revisionId === null ? [] : await deps.lintDraft(spec.id, revisionId),
  );
  const signOffFindings = health.ordered.filter(
    (finding) => finding.severity !== "advisory",
  );
  const statusHandles =
    state.currentSnapshot === null
      ? new Map<string, string>()
      : handlesByElementId(spec, state.currentSnapshot);
  const specComments = state.revisions
    .flatMap((candidate) => deps.findCommentsByRevision(candidate.id))
    .map((row) =>
      projectSpecComment(row, {
        handleByElementId: statusHandles,
        revisionNumberById,
      }),
    );
  const commentThreads = assembleSpecCommentThreads(specComments);
  const openCommentThreads = commentThreads.filter((thread) => thread.open);
  const commentSummary = summarizeSpecComments(specComments);
  const statusOpenComments: ProjectedOpenComments | null =
    commentSummary.openCount === 0
      ? null
      : {
          count: commentSummary.openCount,
          blockingCount: commentSummary.openBlockingCount,
          openThreadCount: commentSummary.openThreadCount,
          openBlockingThreadCount: commentSummary.openBlockingThreadCount,
          subjects: [
            ...new Set(
              openCommentThreads.map(
                (thread) => thread.root.handle ?? thread.root.elementId,
              ),
            ),
          ],
        };
  const projection = authoringReviewProjection({
    policy: spec.gatePolicy,
    snapshot: state.currentSnapshot,
    governanceBaseSnapshot: state.governanceBaseSnapshot,
    importBaselineRows,
    importBaselineCitationState,
    approvals,
    admissions,
    currentExecution: selectedExecution,
    revisionNumberById,
    applies,
    blockingThreads: commentThreads
      .filter(
        (thread) =>
          thread.root.revisionId === revisionId &&
          thread.messages.some((comment) => comment.blocking),
      )
      .map((thread) => ({
        handle: thread.threadId,
        resolved: !thread.open,
      })),
    signOffFindings,
    // Only the current revision's threads decide who acts next: a thread
    // left open on an earlier revision can no longer be answered there.
    openComments: openCommentThreads
      .filter((thread) => thread.root.revisionId === revisionId)
      .map((thread) => ({
        threadId: thread.threadId,
        elementId: thread.root.elementId,
        handle: thread.root.handle,
        blocking: thread.blocking,
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
    currentRevision:
      state.currentRevision === null
        ? null
        : {
            id: state.currentRevision.id,
            number: state.currentRevision.number,
            state: state.currentRevision.state,
            authoringStage: state.currentRevision.authoringStage,
          },
    phase: phase(spec, state.revisions, executions, criteria),
    executions: executions.map((run) => ({
      id: run.id,
      state: run.state,
      workflowSeedSource: nativeSddSeedSourceSummary(run),
      workflowExecutionId: run.workflow_execution_id,
      ...(run.delivery_basis_json
        ? {
            deliveryBasis: specDeliveryBasisSchema.parse(
              JSON.parse(run.delivery_basis_json),
            ),
          }
        : {}),
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
    approvalLedger: projection.approvalLedger,
    applicableGates: projection.applicableGates,
    revisionSignOff: projection.revisionSignOff,
    pendingBlock: projection.pendingBlock,
    nextAction: projection.nextAction,
    openComments: statusOpenComments,
    openQuestions: attention.projection.currentQuestions
      .filter(({ presentation }) => presentation.attentionActive)
      .map(({ row }) => ({
        id: row.id,
        handle: formatBareElementHandle({
          kind: "question",
          number: row.number,
        }),
        text: row.text,
        elementId: row.element_id,
      })),
    assumptions: attention.projection.currentAssumptions
      .filter(({ presentation }) => presentation.attentionActive)
      .map(({ row }) => ({
        id: row.id,
        handle: formatBareElementHandle({
          kind: "assumption",
          number: row.number,
        }),
        text: row.text,
        disposition: row.disposition,
        elementId: row.element_id,
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

/**
 * Sections are revealed one at a time by element id, not by re-rendering the
 * spec, so their disclosure names its own command. Without it the listed ids
 * would have no advertised reader and the outline would be the only place a
 * section is ever visible.
 */
function outlineSectionsDisclosure(
  specSlug: string,
  total: number,
  returned: number,
) {
  return {
    ...outlineDisclosure(total, returned),
    next: `cctl spec section get ${specSlug} --id <element-id>`,
  };
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
      sections: [],
      disclosure: {
        requirements: empty,
        criteria: empty,
        decisions: empty,
        tasks: empty,
        sections: outlineSectionsDisclosure(spec.slug, 0, 0),
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
  const applies = loadApprovalApplicability(state);
  const taskStatuses = buildElementStatuses(
    deps,
    { ...snapshot, elements: taskEntries.map(({ row }) => row) },
    [],
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
  // Sections have no handle, so `addressableOutlineRow` cannot select them:
  // their element id IS the address, and it is what `spec section get` takes.
  const sections: SpecShowOutlineView["sections"] = ordered
    .flatMap((row) =>
      row.version.payload.kind === "section"
        ? [
            {
              elementId: row.element.id,
              role: row.version.payload.role,
              title: row.version.payload.title,
              position: row.version.position,
              elementVersion: row.version.elementVersion,
            },
          ]
        : [],
    )
    .slice(0, SPEC_OUTLINE_ROOT_LIMIT);
  const tasks: SpecShowOutlineView["tasks"] = taskEntries.flatMap(
    ({ row, handle }) =>
      row.version.payload.kind === "task"
        ? [
            {
              ...outlineIdentity(row, handle, row.version.payload.title),
              status: taskStatusById.get(row.element.id) ?? {
                status: "pending" as const,
              },
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
    sections,
    disclosure: {
      requirements: outlineDisclosure(counts.requirements, requirements.length),
      criteria: outlineDisclosure(counts.criteria, returnedCriteria),
      decisions: outlineDisclosure(counts.decisions, decisions.length),
      tasks: outlineDisclosure(counts.tasks, tasks.length),
      sections: outlineSectionsDisclosure(
        spec.slug,
        counts.sections,
        sections.length,
      ),
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
 * The open draft as a human reviews it, with the snapshots its diff reads
 * against and the review hash every review act echoes back. Null when the
 * current revision is not a draft.
 */
async function buildDraftReview(
  deps: SpecRouteDeps,
  revisions: readonly SpecRevision[],
  current: SpecRevisionSnapshot | null,
  loadedSnapshots: ReadonlyMap<string, SpecRevisionSnapshot>,
  events: readonly SpecEventRow[],
): Promise<DraftReviewView | null> {
  if (current === null || current.revision.state !== "draft") return null;
  const read = async (
    revisionId: string | null,
  ): Promise<SpecRevisionSnapshot | null> =>
    revisionId === null
      ? null
      : (loadedSnapshots.get(revisionId) ??
        (await deps.getRevisionSnapshot(revisionId)));
  const baseSnapshot = await read(current.revision.basedOnRevisionId);
  const governanceBaseSnapshot = await read(
    governanceBaseRevisionId(revisions, current.revision),
  );
  return {
    snapshot: toSnapshotView(current),
    baseSnapshot: baseSnapshot === null ? null : toSnapshotView(baseSnapshot),
    governanceBaseSnapshot:
      governanceBaseSnapshot === null
        ? null
        : toSnapshotView(governanceBaseSnapshot),
    notes: proposalNotes(events, current.revision.id),
    reviewHash: revisionReviewHash(current),
  };
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

function sectionNotFound(elementId: string): Response {
  return notFound("Spec section not found", "not_found", { elementId });
}

/**
 * The one reading of the `?revisionId=` / `?revisionNumber=` selector both
 * narrow reads share. `selected` is reported separately from the resolved row
 * because the two failures differ: an unselected read falls back to the current
 * snapshot, while a selector that names nothing is a missing revision.
 */
function selectRevision(
  searchParams: URLSearchParams,
  revisions: readonly SpecRevision[],
): { selected: boolean; revision: SpecRevision | null } {
  const targetRevisionId = searchParams.get("revisionId");
  const selected =
    targetRevisionId !== null || searchParams.has("revisionNumber");
  if (!selected) return { selected: false, revision: null };
  const targetRevisionNumber = z.coerce
    .number()
    .int()
    .positive()
    .safeParse(searchParams.get("revisionNumber"));
  return {
    selected: true,
    revision:
      revisions.find((revision) =>
        targetRevisionId !== null
          ? revision.id === targetRevisionId
          : targetRevisionNumber.success &&
            revision.number === targetRevisionNumber.data,
      ) ?? null,
  };
}

/**
 * The newest revision whose handle allocation still names an element. It exists
 * only to name a `historical_only` refusal: an element read without an explicit
 * revision selector never answers from a revision this scan finds.
 */
async function latestRevisionContainingHandle(
  deps: SpecRouteDeps,
  spec: Spec,
  revisions: readonly SpecRevision[],
  handle: string,
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
    const handles = handlesByElementId(spec, snapshot);
    const row = snapshot.elements.find(
      (candidate) => handles.get(candidate.element.id) === handle,
    );
    if (row !== undefined) return { snapshot, row };
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
    const attention = await loadAttentionProjection(
      deps,
      resolved.value.spec,
      state.revisions,
    );
    const draftReview = await buildDraftReview(
      deps,
      state.revisions,
      state.currentSnapshot,
      snapshotsByRevisionId,
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
      draftReview,
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
      questions: [
        ...attention.projection.currentQuestions,
        ...attention.projection.history.flatMap((record) =>
          record.kind === "question" ? [record] : [],
        ),
      ].map(toQuestionView),
      assumptions: [
        ...attention.projection.currentAssumptions,
        ...attention.projection.history.flatMap((record) =>
          record.kind === "assumption" ? [record] : [],
        ),
      ].map((projection) =>
        toAssumptionView(
          projection,
          attention.assumptionsById,
          attention.draftSnapshot,
        ),
      ),
      attentionAuditEvents: projectAttentionAuditEvents(specEvents),
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
    const status = await buildStatus(deps, resolved.value.spec, state);
    const review = await deps.readDeliveryReview(resolved.value.spec);
    return NextResponse.json({
      ...status,
      deliveryPlan: await deps.readDeliveryPlan(resolved.value.spec),
      reviewHref: `/specs/${encodeURIComponent(resolved.value.projectName)}/${encodeURIComponent(resolved.value.spec.slug)}`,
      deliveryReadiness:
        review === null
          ? null
          : {
              revisionId: review.revisionId,
              executionId: review.execution?.id ?? null,
              approvalGranted: review.approvalGranted,
              totalInScope: review.criteria.filter(
                (criterion) => criterion.inScope,
              ).length,
              settled: review.criteria.filter(
                (criterion) =>
                  criterion.inScope && criterion.outcome !== "needs_review",
              ).length,
              blockers: review.blockers,
            },
    });
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
    const commentSummary = summarizeSpecComments(views);
    logger.debug("specs.routes.comments.complete", {
      projectName: resolved.value.projectName,
      specId: spec.id,
      commentCount: views.length,
      returnedCount: comments.length,
      ...commentSummary,
    });
    const view: SpecCommentsView = {
      specId: spec.id,
      slug: spec.slug,
      comments,
      ...commentSummary,
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

  async function resolveQuestionOrAssumption(
    spec: Spec,
    requestedHandle: string,
  ): Promise<Response | null> {
    let parsed: ParsedElementHandle;
    try {
      parsed = parseElementHandle(requestedHandle, spec.slug);
    } catch {
      // Not a well-formed handle; fall through to the revision-element scan,
      // which owns the 404 for unknown addresses.
      return null;
    }
    if (parsed.kind === "question") {
      const attention = await loadAttentionProjection(deps, spec);
      const projection = [
        ...attention.projection.currentQuestions,
        ...attention.projection.history.flatMap((record) =>
          record.kind === "question" ? [record] : [],
        ),
      ].find(({ row }) => row.number === parsed.number);
      if (projection === undefined) return notFound("Spec question not found");
      return NextResponse.json({
        specId: spec.id,
        slug: spec.slug,
        kind: "question",
        handle: formatBareElementHandle({
          kind: "question",
          number: parsed.number,
        }),
        question: toQuestionView(projection),
      });
    }
    if (parsed.kind === "assumption") {
      const attention = await loadAttentionProjection(deps, spec);
      const projection = [
        ...attention.projection.currentAssumptions,
        ...attention.projection.history.flatMap((record) =>
          record.kind === "assumption" ? [record] : [],
        ),
      ].find(({ row }) => row.number === parsed.number);
      if (projection === undefined)
        return notFound("Spec assumption not found");
      return NextResponse.json({
        specId: spec.id,
        slug: spec.slug,
        kind: "assumption",
        handle: formatBareElementHandle({
          kind: "assumption",
          number: parsed.number,
        }),
        assumption: toAssumptionView(
          projection,
          attention.assumptionsById,
          attention.draftSnapshot,
        ),
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
    const recordResponse = await resolveQuestionOrAssumption(
      resolved.value.spec,
      requestedHandle ?? "",
    );
    if (recordResponse !== null) return recordResponse;
    const state = await loadCurrentState(deps, resolved.value.spec.id);
    const searchParams = new URL(request.url).searchParams;
    const selection = selectRevision(searchParams, state.revisions);
    const revisionSelected = selection.selected;
    const observedRevision = z.coerce
      .number()
      .int()
      .positive()
      .safeParse(searchParams.get("observedRevision"));
    if (revisionSelected && selection.revision === null) {
      return notFound("Spec revision not found");
    }
    const targetRevision = selection.revision;
    const targetSnapshot =
      targetRevision === null
        ? state.currentSnapshot
        : await deps.getRevisionSnapshot(targetRevision.id);
    if (targetSnapshot === null) return notFound("Spec element not found");

    const snapshot = targetSnapshot;
    const handles = handlesByElementId(resolved.value.spec, snapshot);
    const row = snapshot.elements.find(
      ({ element }) => handles.get(element.id) === requestedHandle,
    );
    if (row === undefined) {
      const address = requestedHandle ?? "";
      // A handle the current revision retired still resolves in the revision
      // that last carried it. Answering from that revision silently hands back
      // withdrawn content as if it were current, so the older revisions are
      // scanned only to name the one an explicit archaeological read needs.
      if (!revisionSelected) {
        const historical = await latestRevisionContainingHandle(
          deps,
          resolved.value.spec,
          state.revisions.filter(
            (candidate) => candidate.id !== snapshot.revision.id,
          ),
          address,
        );
        if (historical !== null) {
          const lastRevision = historical.snapshot.revision;
          logger.debug("specs.routes.element.historical_only", {
            projectName: resolved.value.projectName,
            specId: resolved.value.spec.id,
            handle: address,
            lastRevisionNumber: lastRevision.number,
          });
          return notFound(
            "Spec element exists only in a historical revision",
            "historical_only",
            {
              handle: address,
              elementId: historical.row.element.id,
              lastRevisionId: lastRevision.id,
              lastRevisionNumber: lastRevision.number,
              currentRevisionId: snapshot.revision.id,
              currentRevisionNumber: snapshot.revision.number,
            },
            `Read the historical element with \`cctl spec get ${resolved.value.spec.slug}/${address} --revision ${lastRevision.number}\`. The current revision does not contain this handle.`,
          );
        }
      }
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

  /**
   * The narrow section read. Sections carry no handle, so this is the only
   * address they have; a dedicated view keeps the element read's approval,
   * evidence, and reference blocks — all meaningless for a section — out of
   * the contract instead of filling them with nulls.
   */
  async function getSpecSectionGET(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { element: requestedId } = await context.params;
    const elementId = requestedId ?? "";
    const state = await loadCurrentState(deps, resolved.value.spec.id);
    const searchParams = new URL(request.url).searchParams;
    const selection = selectRevision(searchParams, state.revisions);
    if (selection.selected && selection.revision === null) {
      return notFound("Spec revision not found");
    }
    const snapshot =
      selection.revision === null
        ? state.currentSnapshot
        : await deps.getRevisionSnapshot(selection.revision.id);
    if (snapshot === null) return sectionNotFound(elementId);

    const row = snapshot.elements.find(
      (candidate) => candidate.element.id === elementId,
    );
    if (row === undefined) {
      // Same rule as the element read: a retired id resolves in the revision
      // that last carried it, and that revision is named rather than answered
      // from, so an authoring read never sees withdrawn content as current.
      if (!selection.selected) {
        const historical = await latestContainingElement(
          deps,
          state.revisions.filter(
            (candidate) => candidate.id !== snapshot.revision.id,
          ),
          elementId,
        );
        if (historical !== null) {
          const lastRevision = historical.snapshot.revision;
          logger.debug("specs.routes.section.historical_only", {
            projectName: resolved.value.projectName,
            specId: resolved.value.spec.id,
            elementId,
            lastRevisionNumber: lastRevision.number,
          });
          return notFound(
            "Spec element exists only in a historical revision",
            "historical_only",
            {
              handle: null,
              elementId,
              lastRevisionId: lastRevision.id,
              lastRevisionNumber: lastRevision.number,
              currentRevisionId: snapshot.revision.id,
              currentRevisionNumber: snapshot.revision.number,
            },
            `Read the historical section with \`cctl spec section get ${resolved.value.spec.slug} --id ${elementId} --revision ${lastRevision.number}\`. The current revision does not contain this section.`,
          );
        }
      }
      return sectionNotFound(elementId);
    }

    const payload = row.version.payload;
    if (payload.kind !== "section") {
      const handle = elementHandleInSnapshot(snapshot, row.element.id);
      logger.debug("specs.routes.section.not_section", {
        projectName: resolved.value.projectName,
        specId: resolved.value.spec.id,
        elementId,
        kind: payload.kind,
      });
      return notFound(
        "Spec element is not a section",
        "not_section",
        { elementId, kind: payload.kind, handle },
        handle === null
          ? `This ${payload.kind} has no allocated handle; read the whole revision with \`cctl spec show ${resolved.value.spec.slug} --rendered\`.`
          : `Read this ${payload.kind} with \`cctl spec get ${resolved.value.spec.slug}/${handle}\`.`,
      );
    }

    logger.debug("specs.routes.section.complete", {
      projectName: resolved.value.projectName,
      specId: resolved.value.spec.id,
      elementId,
      revisionNumber: snapshot.revision.number,
    });
    return NextResponse.json({
      specId: resolved.value.spec.id,
      slug: resolved.value.spec.slug,
      kind: "section",
      handle: null,
      elementId: row.element.id,
      role: payload.role,
      title: payload.title,
      body: payload.body,
      elementVersion: row.version.elementVersion,
      position: row.version.position,
      revision: {
        id: snapshot.revision.id,
        number: snapshot.revision.number,
        state: snapshot.revision.state,
        authoringStage: snapshot.revision.authoringStage,
      },
    } satisfies SpecSectionView);
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
      toCitationDiffContext(fromSnapshot, toSnapshot),
    );
    // `changeList` mixes two vocabularies keyed by the same element id: element
    // changes (added/modified/removed) and citation changes (citation_*). Only
    // the element changes may feed this view's four-value `classification` —
    // a citation entry overwriting an element's slot is what leaked
    // `citation_added` into a field every strict reader refuses.
    const elementChangeByElementId = new Map(
      diff.changeList.flatMap((change) =>
        change.kind === "assumption_citation" ||
        change.kind === "citation_contract"
          ? []
          : [[change.elementId, change] as const],
      ),
    );
    const citationSummariesByElementId = new Map<string, string[]>();
    for (const change of diff.changeList) {
      if (change.kind !== "assumption_citation") continue;
      const summaries =
        citationSummariesByElementId.get(change.elementId) ?? [];
      summaries.push(change.summary);
      citationSummariesByElementId.set(change.elementId, summaries);
    }
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
        const elementChange = elementChangeByElementId.get(entry.elementId);
        // An element can carry both a payload change and citation changes;
        // one row tells both, payload first. A citation-only change has no
        // element entry, so its citation summaries are the whole story — which
        // keeps `summary` null exactly when the element is unchanged.
        const summaryParts = [
          ...(elementChange === undefined ? [] : [elementChange.summary]),
          ...(citationSummariesByElementId.get(entry.elementId) ?? []),
        ];
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
          classification: entry.classification,
          directlyChanged: entry.directlyChanged,
          summary: summaryParts.length === 0 ? null : summaryParts.join(" "),
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
    getSpecElementGET,
    getSpecSectionGET,
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
export const specElementGET = withTracing(handlers.getSpecElementGET);
export const specSectionGET = withTracing(handlers.getSpecSectionGET);
export const specSearchGET = withTracing(handlers.searchSpecGET);
export const specProjectSearchGET = withTracing(handlers.searchProjectSpecsGET);
export const specDiffGET = withTracing(handlers.getSpecDiffGET);
export const specExportGET = withTracing(handlers.getSpecExportGET);
export const specVerifyGET = withTracing(handlers.getSpecVerifyGET);

export const SPEC_CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";
export const SPEC_CALLER_BACKEND_HEADER = "x-cc-agent-backend";

export interface SpecMutationServices {
  deliveryReview: DeliveryReviewService;
  deliveryApproval: DeliveryApprovalService;
  deliveryContinuation: DeliveryContinuationService;
  readDeliveryReview(
    spec: Spec,
    executionId?: string,
  ): Promise<DeliveryReviewView | null>;
  authoring: Pick<
    AuthoringService,
    | "createSpec"
    | "upsertDraftElement"
    | "upsertDraftElements"
    | "reorderDraftElement"
    | "removeDraftElement"
    | "openAmendment"
    | "returnToRequirements"
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
  verify(specId: string): Promise<IntegrityReport>;
}

export interface SpecWriteRouteDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  resolveSpec(projectPath: string, slug: string): Promise<Spec | null>;
  getServices(projectPath: string): Promise<SpecMutationServices>;
  listRevisions(specId: string): Promise<SpecRevision[]>;
  getRevisionSnapshot(revisionId: string): Promise<SpecRevisionSnapshot | null>;
  findQuestionsBySpecId(specId: string): SpecQuestionRow[];
  findAssumptionsBySpecId(specId: string): SpecAssumptionRow[];
  findEventsBySpecId(specId: string): SpecEventRow[];
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
const returnToRequirementsBodySchema = returnToRequirementsInputSchema.omit({
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
const withdrawDraftBodySchema = withdrawDraftInputSchema.omit({
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
// Delivery is the only spec-side lifecycle grant; graph-run approval stays
// with the immutable graph execution it governs.
const grantGateApprovalBodySchema = grantGateApprovalInputSchema
  .omit({
    specId: true,
    actor: true,
    approver: true,
  })
  .extend({ gate: z.literal("delivery") });
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
const editAttentionRecordBodySchema = editAttentionRecordInputSchema.omit({
  specId: true,
  actor: true,
});
const withdrawAttentionRecordBodySchema =
  withdrawAttentionRecordInputSchema.omit({
    specId: true,
    actor: true,
  });
const supersedeAssumptionBodySchema = supersedeAssumptionInputSchema.omit({
  specId: true,
  actor: true,
});
const mutateAssumptionCitationBodySchema =
  mutateAssumptionCitationInputSchema.omit({
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
    parameters: z.record(z.string(), z.unknown()).optional(),
    /** Hold an approved candidate for prelaunch review. */
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
const planAbandonBodySchema = deliveryPlanAbandonRequestSchema;
const planSignOffBodySchema = deliveryPlanSignOffRequestSchema;
const planCommentBodySchema = deliveryPlanCommentRequestSchema;

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
  if (
    refusal.code === "human_act_required" ||
    refusal.code === "authoring_agent_required"
  ) {
    return 403;
  }
  if (
    refusal.code === "validation" ||
    refusal.code === "spec_side_execution_id"
  ) {
    return 400;
  }
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
  ["grant-waiver", BROWSER_SESSION_REMEDY],
  ["review-acceptance", BROWSER_SESSION_REMEDY],
  ["approve-delivery-review", BROWSER_SESSION_REMEDY],
  ["continue-delivery", BROWSER_SESSION_REMEDY],
  ["replace-delivery", BROWSER_SESSION_REMEDY],
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
]);

function humanActRequiredResponse(action: string): Response {
  return specRefusalResponse({
    code: "human_act_required",
    unmetConditions: [`${action} is a human-only Spec Studio action.`],
    rationale: HUMAN_ACT_REQUIRED_RATIONALE,
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
          ? `This spec has no open draft, and its approved revisions are immutable. Run \`cctl spec amend ${context?.specSlug ?? "<slug>"}\` to open an editable draft. Follow its next action from \`cctl spec status ${context?.specSlug ?? "<slug>"}\`.`
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
  const db = getStateDb();
  const specs = createSpecsRepo(db, getSharedWriteQueue());
  const review = createSpecReviewRepo(db);
  const events = createSpecEventsRepo(db);
  return {
    auth: createAgentAuth(),
    resolveProjectPath: defaultResolveProjectPath,
    async resolveSpec(projectPath, slug) {
      return specs.resolve(projectPath, slug);
    },
    listRevisions: (specId) => specs.listRevisions(specId),
    getRevisionSnapshot: (revisionId) => specs.getRevisionSnapshot(revisionId),
    findQuestionsBySpecId: (specId) => review.findQuestionsBySpecId(specId),
    findAssumptionsBySpecId: (specId) => review.findAssumptionsBySpecId(specId),
    findEventsBySpecId: (specId) => events.findBySpecId(specId),
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
      const questionView = async (questionId: string) => {
        const attention = await loadAttentionProjection(
          deps,
          resolved.value.spec,
        );
        const projection = [
          ...attention.projection.currentQuestions,
          ...attention.projection.history.flatMap((record) =>
            record.kind === "question" ? [record] : [],
          ),
        ].find(({ row }) => row.id === questionId);
        if (projection === undefined) {
          throw new Error(
            `question projection missing after mutation: ${questionId}`,
          );
        }
        return toQuestionView(projection);
      };
      const assumptionView = async (assumptionId: string) => {
        const attention = await loadAttentionProjection(
          deps,
          resolved.value.spec,
        );
        const projection = [
          ...attention.projection.currentAssumptions,
          ...attention.projection.history.flatMap((record) =>
            record.kind === "assumption" ? [record] : [],
          ),
        ].find(({ row }) => row.id === assumptionId);
        if (projection === undefined) {
          throw new Error(
            `assumption projection missing after mutation: ${assumptionId}`,
          );
        }
        return toAssumptionView(
          projection,
          attention.assumptionsById,
          attention.draftSnapshot,
        );
      };

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
        case "return-to-requirements":
          return invokeAction(
            request,
            returnToRequirementsBodySchema,
            (input) =>
              services.authoring.returnToRequirements(
                withReviewIdentity(input),
              ),
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
        case "approve-delivery-review":
          return invokeAction(request, deliveryApprovalRequestSchema, (input) =>
            services.deliveryApproval.approve({
              ...input,
              spec: resolved.value.spec,
              actor: actor.value,
            }),
          );
        case "review-acceptance":
          return invokeAction(request, acceptanceReviewRequestSchema, (input) =>
            services.deliveryReview.record(withReviewIdentity(input)),
          );
        case "replace-delivery":
          return invokeAction(
            request,
            deliveryReplacementRequestSchema,
            (input) =>
              services.deliveryContinuation.replace(withReviewIdentity(input)),
          );
        case "continue-delivery":
          return invokeAction(
            request,
            deliveryContinuationRequestSchema,
            (input) =>
              services.deliveryContinuation.continue(withReviewIdentity(input)),
          );
        case "grant-gate-approval":
          return invokeAction(request, grantGateApprovalBodySchema, (input) =>
            services.review.grantGateApproval({
              ...withReviewIdentity(input),
              approver: "operator",
            }),
          );
        case "withdraw":
          return invokeAction(request, withdrawDraftBodySchema, (input) =>
            services.review.withdraw(withReviewIdentity(input)),
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
                ? { ...result, value: await questionView(result.value.id) }
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
                ? { ...result, value: await questionView(result.value.id) }
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
                ? { ...result, value: await assumptionView(result.value.id) }
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
                ? { ...result, value: await assumptionView(result.value.id) }
                : result;
            },
          );
        case "edit-attention":
          return invokeAction(request, editAttentionRecordBodySchema, (input) =>
            services.review.editAttentionRecord(withReviewIdentity(input)),
          );
        case "withdraw-attention":
          return invokeAction(
            request,
            withdrawAttentionRecordBodySchema,
            (input) =>
              services.review.withdrawAttentionRecord(
                withReviewIdentity(input),
              ),
          );
        case "supersede-assumption":
          return invokeAction(request, supersedeAssumptionBodySchema, (input) =>
            services.review.supersedeAssumption(withReviewIdentity(input)),
          );
        case "cite-assumption":
          return invokeAction(
            request,
            mutateAssumptionCitationBodySchema,
            (input) =>
              services.review.citeAssumption(withReviewIdentity(input)),
          );
        case "uncite-assumption":
          return invokeAction(
            request,
            mutateAssumptionCitationBodySchema,
            (input) =>
              services.review.unciteAssumption(withReviewIdentity(input)),
          );
        case "change-policy":
          return invokeAction(request, changePolicyBodySchema, (input) =>
            services.review.changePolicy(withReviewIdentity(input)),
          );
        // Evidence attachment, proof verdicts and task-completion claims were
        // retired with the criterion-modality proof pipeline: authored context
        // outcomes and human waivers decide delivery, so all of them fall
        // through to the 404 default.
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
                    instruction: `Nothing was started. Open an authored delivery attempt with \`cctl spec plan open ${resolved.value.spec.slug}\`, then have its draft signed off before rerunning \`cctl spec start ${resolved.value.spec.slug} --file .cc/temp/inputs.json\`.`,
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
                workflowDefinition: result.workflowDefinition,
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
          return invokeAction(request, planOpenBodySchema, () =>
            services.deliveryPlan.open({
              spec: resolved.value.spec,
              actor: actor.value,
            }),
          );
        case "plan-edit":
          return invokeAction(request, planEditBodySchema, (input) =>
            services.deliveryPlan.edit({
              spec: resolved.value.spec,
              expectedDraftRevision: input.expectedDraftRevision,
              binding: input.binding,
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
        // The prelaunch retirement (command-center#92): a never-launched
        // attempt whose pin the spec amended past is retired so a fresh open
        // can pin the current approved revision.
        case "plan-abandon":
          return invokeAction(request, planAbandonBodySchema, (input) =>
            services.deliveryPlan.abandonPrelaunch({
              spec: resolved.value.spec,
              reason: input.reason,
              actor: actor.value,
            }),
          );
        // The one default approval: it freezes the draft the caller read into
        // the candidate and admits `execution_start` in the same act. Human
        // attribution rides the transport actor, so a Builder sign-off is a
        // human act and an agent's is refused whenever the dial says a human
        // decides.
        case "plan-sign-off":
          return invokeAction(request, planSignOffBodySchema, (input) =>
            services.deliveryPlan.signOff({
              spec: resolved.value.spec,
              ...input,
              actor: actor.value,
              approver: actor.value.kind === "human" ? "operator" : "agent",
            }),
          );
        case "plan-reaffirm-batch":
          return invokeAction(
            request,
            deliveryPlanReaffirmBatchRequestSchema,
            (input) =>
              services.deliveryPlan.reaffirmBatch({
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

  async function specDeliveryReviewGET(
    request: Request,
    context: SpecRouteContext,
  ): Promise<Response> {
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    try {
      const services = await deps.getServices(resolved.value.projectPath);
      const executionId =
        new URL(request.url).searchParams.get("execution") ?? undefined;
      return NextResponse.json(
        await services.readDeliveryReview(resolved.value.spec, executionId),
      );
    } catch (error) {
      return routeFailure(error, "delivery-review");
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
   * snapshots it compares are written by sign-off, and one owner is what keeps
   * a diff from ever describing bytes no sign-off froze.
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
   * mutations for the same reason `specPlanGET` is: previewing a draft reads
   * the document sign-off finalizes, and one owner keeps the preview and
   * sign-off on the same authored bytes.
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
      stage: url.searchParams.get("stage") ?? "approved",
      ...(rawExpected === null
        ? {}
        : { expectedDraftRevision: Number(rawExpected) }),
    });
    if (!parsed.success) {
      return jsonError(
        `Invalid plan preview request. Pass ?stage=draft or ?stage=approved, and an optional integer ?expectedDraftRevision, then re-run cctl spec plan preview ${resolved.value.spec.slug} --stage <draft|approved>.`,
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
    specDeliveryReviewGET,
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

export const specDeliveryReviewGET = withTracing(
  writeHandlers.specDeliveryReviewGET,
);
