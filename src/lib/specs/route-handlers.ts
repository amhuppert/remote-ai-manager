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
  SpecSlugTakenError,
  StageBlockedWriteError,
  createAuthoringService,
  createAuthoringSpecInputSchema,
  draftElementBatchInputSchema,
  draftElementWriteInputSchema,
  type DraftElementBatchRefusal,
  openAmendmentInputSchema,
  proposeAuthoringRevisionInputSchema,
  removeDraftElementInputSchema,
  reorderDraftElementInputSchema,
  type AuthoringService,
} from "./authoring-service";
import { compiledWorkflowTaskId, readCompiledOriginMap } from "./compiler";
import { isEarlierMergedDelivery } from "./delivery-gate";
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
import type {
  ExecutionService,
  ReconciledSpecExecution,
} from "./execution-service";
import {
  currentExecution,
  elementHandle,
  gateStatuses,
  latestRevision,
  parseProvenance,
  pendingApprovals,
  type PendingApproval,
  type SpecGateStatus,
} from "./gate-projection";
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
import type { LintFinding } from "./lint";
import type { SpecMeasuresReport } from "./measures";
import { createMeasuresQuery } from "./measures-query";
import {
  projectDeliveryDisplay,
  projectRequirementStatus,
  projectSpecPhase,
  projectTaskWorkStatus,
  type DeliveryCriterion,
  type SpecPhaseProjection,
} from "./phase";
import { elementHandleInSnapshot, toLintSnapshot } from "./review-state";
import {
  answerQuestionInputSchema,
  approveItemInputSchema,
  unapproveItemInputSchema,
  bulkApproveInputSchema,
  changeSpecPolicyInputSchema,
  disposeAssumptionInputSchema,
  openQuestionInputSchema,
  proposeAssumptionInputSchema,
  requestApprovalInputSchema,
  grantGateApprovalInputSchema,
  requestChangesInputSchema,
  resolveReviewThreadInputSchema,
  reviewCommentInputSchema,
  signOffRevisionInputSchema,
  type ReviewService,
} from "./review-service";
import { executionScopeSchema, type ExecutionScope } from "./scope-validation";
import type {
  CriterionDeliveryProjection,
  RemainingAuthoringSequence,
  SpecAssumptionView,
  SpecQuestionView,
  SpecRevisionSnapshotView,
  SpecEditContextView,
  SpecExecutionView,
  SpecGateAdmissionView,
  SpecSearchHit,
  SpecStartedExecutionView,
  SpecStatusExecution,
} from "./view-schemas";
import {
  actorProvenanceSchema,
  specCriterionDispositionSchema,
  specAuthoringStageSchema,
  taskElementPayloadSchema,
  type ActorProvenance,
  type Refusal,
  type Spec,
  type SpecAlias,
  type SpecApprovalRow,
  type SpecAssumptionRow,
  type SpecCommentRow,
  type SpecCriterionDispositionRow,
  type SpecEvidenceRow,
  type SpecExecutionRow,
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
  baseSnapshot: SpecRevisionSnapshot | null;
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
  gates: SpecGateStatus[];
  authoringSequence: RemainingAuthoringSequence | null;
  pendingApprovals: PendingApproval[];
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
  coverage: SpecCoverage;
  delivery: ReturnType<typeof projectDeliveryDisplay>;
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
      return record === null ? [] : readCompiledOriginMap(record.definition);
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
        await loadSpecExportState({ specs, review }, specId),
      );
    },
    async verifySpec(specId) {
      return verifyExportState(
        await loadSpecExportState({ specs, review }, specId),
      );
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
  const baseSnapshot =
    baseRevisionId === null
      ? null
      : baseRevisionId === currentSnapshot?.revision.id
        ? currentSnapshot
        : baseRevisionId === currentApprovedSnapshot?.revision.id
          ? currentApprovedSnapshot
          : await deps.getRevisionSnapshot(baseRevisionId);
  return {
    revisions,
    currentRevision,
    currentSnapshot,
    baseSnapshot,
    currentApprovedSnapshot,
  };
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

function coverage(snapshot: SpecRevisionSnapshot | null): SpecCoverage {
  const criteria = new Set(
    (snapshot?.elements ?? [])
      .filter(({ element }) => element.kind === "criterion")
      .map(({ element }) => element.id),
  );
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
): Array<DeliveryCriterion & { criterionId: string }> {
  const currentApprovedRevisionId = currentApprovedSnapshot?.revision.id;
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
          return { criterionId: element.id, state: "waived" as const };
        }

        const proven = deliveredDispositions.some(
          (disposition) =>
            disposition.criterion_element_id === element.id &&
            (disposition.disposition === "in_scope" ||
              disposition.disposition === "delivered_elsewhere"),
        );
        return {
          criterionId: element.id,
          state: proven ? ("proven_and_merged" as const) : ("pending" as const),
        };
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
  revisionId: string,
): "pending" | "proven" | "waived" {
  const waiver = deps.findWaiverForCriterionRevision(
    criterionElementId,
    revisionId,
  );
  if (waiver?.stale === 0) return "waived";
  return deps
    .findProofVerdictsByCriterionRevision(criterionElementId, revisionId)
    .some((verdict) => verdict.stale_at === null)
    ? "proven"
    : "pending";
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
    .map((row) => {
      const criteria = snapshot.elements.filter(
        ({ element }) =>
          element.kind === "criterion" &&
          element.parentElementId === row.element.id,
      );
      const taskRows = snapshot.elements.filter(
        ({ version }) =>
          version.payload.kind === "task" &&
          version.payload.tracedRequirementElementIds.includes(row.element.id),
      );
      return {
        elementId: row.element.id,
        status: projectRequirementStatus({
          approvalValidity: latestApprovalValidity(
            approvals,
            "requirement",
            row.element.id,
          ),
          criteria: criteria.map((criterion) => ({
            covered: taskRows.some(
              ({ version }) =>
                version.payload.kind === "task" &&
                version.payload.coveredCriterionElementIds.includes(
                  criterion.element.id,
                ),
            ),
            proof: criterionProofState(
              deps,
              criterion.element.id,
              snapshotRevisionId,
            ),
          })),
        }),
      };
    });

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
  return snapshot.elements.flatMap((entry) => {
    const payload = entry.version.payload;
    if (payload.kind !== "task") return [];
    const handle = handles.get(entry.element.id) ?? entry.element.id;
    return [
      {
        elementId: entry.element.id,
        handle,
        title: payload.title,
        dependsOn: payload.dependsOnTaskElementIds.map(
          (elementId) => handles.get(elementId) ?? elementId,
        ),
        laneGroup: payload.laneGroup ?? null,
        touchedPaths: payload.touchedPaths ?? [],
        criterionCoverage: payload.coveredCriterionElementIds.map(
          (elementId) => handles.get(elementId) ?? elementId,
        ),
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
    if (
      waiver !== null &&
      waiver.stale === 0 &&
      waiver.spec_id === execution.spec_id &&
      waiver.revision_id === execution.revision_id &&
      waiver.criterion_element_id === criterionElementId
    ) {
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

function parseExecutionScope(raw: string): ExecutionScope | null {
  try {
    const parsed = executionScopeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
  const gates = gateStatuses(
    spec,
    revisionId,
    admissions,
    selectedExecution,
    revisionNumberById,
  );
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
      : criteria.filter(({ criterionId }) =>
          deliveryScopeCriterionIds.has(criterionId),
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
    gates,
    authoringSequence:
      state.currentSnapshot === null
        ? null
        : draftAuthoringSequence({
            policy: spec.gatePolicy,
            snapshot: state.currentSnapshot,
            baseSnapshot: state.baseSnapshot,
          }),
    pendingApprovals: pendingApprovals(
      state.currentSnapshot,
      state.baseSnapshot,
      approvals,
      gates,
      selectedExecution,
    ),
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
    coverage: coverage(state.currentSnapshot),
    delivery: projectDeliveryDisplay(displayCriteria),
  };
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
  return {
    spec,
    phase: status.phase,
    currentRevision: state.currentRevision,
    counts: elementCounts(state.currentSnapshot),
    pendingApprovalCount: status.pendingApprovals.length,
    approvalState:
      status.pendingApprovals.length === 0 ? "complete" : "pending",
    delivery: status.delivery,
    linkedWork: linkedWork(deps.findLinksBySpecId(spec.id)),
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
    const gateAdmissions = admissions.filter(
      (admission) =>
        admission.revision_id !== null &&
        pinnedRevisionIds.has(admission.revision_id),
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
    const comments = state.revisions.flatMap((revision) =>
      deps.findCommentsByRevision(revision.id),
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
    getSpecGET,
    getSpecStatusGET,
    getSpecEditContextGET,
    getSpecLintGET,
    getSpecElementGET,
    searchSpecGET,
    searchProjectSpecsGET,
    getSpecExportGET,
    getSpecVerifyGET,
  };
}

const handlers = createSpecRouteHandlers();
export const specsInventoryGET = withTracing(handlers.listSpecsGET);
export const specMeasuresGET = withTracing(handlers.getSpecMeasuresGET);
export const specSummaryGET = withTracing(handlers.getSpecSummaryGET);
export const specDetailGET = withTracing(handlers.getSpecGET);
export const specStatusGET = withTracing(handlers.getSpecStatusGET);
export const specEditContextGET = withTracing(handlers.getSpecEditContextGET);
export const specLintGET = withTracing(handlers.getSpecLintGET);
export const specElementGET = withTracing(handlers.getSpecElementGET);
export const specSearchGET = withTracing(handlers.searchSpecGET);
export const specProjectSearchGET = withTracing(handlers.searchProjectSpecsGET);
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
const draftElementBatchBodySchema = draftElementBatchInputSchema.omit({
  specId: true,
  actor: true,
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
const resolveThreadBodySchema = resolveReviewThreadInputSchema.omit({
  specId: true,
  actor: true,
});
const requestChangesBodySchema = requestChangesInputSchema.omit({
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
    scope: executionScopeSchema,
    sessionName: z.string().min(1).nullable(),
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
    executionId: z.string().min(1),
    discoveredTask: taskElementPayloadSchema.omit({ kind: true }),
    blockingReason: z.string().optional(),
  })
  .strict();
const emptyBodySchema = z.object({}).strict();

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

const HUMAN_ONLY_ACTIONS = new Set([
  "approve-item",
  "unapprove-item",
  "sign-off",
  "bulk-approve",
  "grant-gate-approval",
  "approve-execution-start",
  "grant-waiver",
  "change-policy",
  // Assumption disposition is the human half of the propose/dispose split
  // (mirrors waiver origin rules); the service also refuses agents, but the
  // route gate returns the typed refusal before any service work.
  "dispose-assumption",
  // Questions have the same split: an agent opens one FOR a human, so an
  // agent answering would clear its own blocking signal with no record that
  // no human ever decided. Studio's answer control is the human half.
  "answer-question",
  // Renames change the identity every copied reference resolves through, so
  // only the operator performs them; agents receive human_act_required.
  "rename",
  // Retiring the whole durable spec is the least reversible act on this
  // surface. Abandoning a single run ("abandon-execution") stays agent
  // reachable because stopping one run is ordinary agent work.
  "abandon-spec",
]);

function humanActRequiredResponse(action: string): Response {
  return specRefusalResponse({
    code: "human_act_required",
    unmetConditions: [`${action} is a human-only Spec Studio action.`],
    instruction: "Perform this action from the authenticated browser session.",
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
  if (error instanceof SpecRevisionImmutableError) {
    return specRefusalResponse({
      code: "amendment_required",
      unmetConditions: [error.message],
      instruction: "Open an amendment draft before changing approved content.",
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
        // evidence-kind narrowing (ticket #24): evidence is only ever
        // ingested from workflow events and proof verdicts are recorded only
        // by the delivery gate, so both fall through to the 404 default.
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
              const result = await services.execution.start({
                ...input,
                specId,
                actor: actor.value,
              });
              return result.ok
                ? {
                    ok: true as const,
                    execution: toStartedExecutionView(
                      result.execution,
                      result.revisionNumber,
                    ),
                    definition: result.definition,
                  }
                : result;
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
        default:
          return notFound("Spec action not found");
      }
    } catch (error) {
      return routeFailure(error, action ?? "unknown-spec-action");
    }
  }

  return { projectActionPOST, specActionPOST };
}

const writeHandlers = createSpecWriteRouteHandlers();
export const specProjectActionPOST = withTracing(
  writeHandlers.projectActionPOST,
);
export const specActionPOST = withTracing(writeHandlers.specActionPOST);
