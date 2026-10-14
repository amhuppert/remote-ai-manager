import type { SpecAbandonmentService } from "./spec-abandonment";
import { NextResponse } from "next/server";
import { z } from "zod";

import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { verifyDurableConversationIdentity } from "@/lib/conversations/provenance";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import { PersistenceError } from "@/lib/shared/errors";
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
import { DRAFT_HEALTH_TOP_FINDINGS, draftHealth } from "./draft-health";
import { createSpecEventsPublisher } from "./events";
import {
  loadSpecExportState,
  renderVerifiedCanonicalBundle,
  SpecExportNotFoundError,
  verifyExportState,
  type CanonicalSpecBundle,
  type IntegrityReport,
} from "./export";
import {
  createApprovalApplicability,
  type ApprovalApplicability,
} from "./approval-applicability";
import {
  approvalHeld,
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
  promoteConversationInputSchema,
  type LinksService,
  type LinkedTicketReadThrough,
} from "./links-service";
import type { ImportService } from "./import-service";
import type { LintFinding } from "./lint";
import {
  projectRequirementStatus,
  projectSpecPhase,
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
import { projectSpecComment } from "./comment-projection";
import {
  assembleSpecCommentThreads,
  summarizeSpecComments,
} from "./comment-threads";
import type {
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
  SpecGateAdmissionView,
  SpecImportRecordView,
  SpecSearchHit,
  SpecSectionView,
  SpecStatusView as PublishedSpecStatusView,
} from "./view-schemas";
import {
  actorProvenanceSchema,
  importBundleSchema,
  specAuthoringStageSchema,
  specImportedEventPayloadSchema,
  type ActorProvenance,
  type Refusal,
  type Spec,
  type SpecAlias,
  type SpecApprovalRow,
  type SpecAssumptionRow,
  type SpecCommentRow,
  type SpecEventRow,
  type SpecGate,
  type SpecGateAdmissionRow,
  type SpecLinkRow,
  type SpecQuestionRow,
  type SpecRevision,
  type SpecRevisionElement,
  type SpecRevisionSnapshot,
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
  exportSpec(specId: string): Promise<CanonicalSpecBundle>;
  verifySpec(specId: string): Promise<IntegrityReport>;
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

interface SpecStatusView {
  specId: string;
  currentRevision: PublishedSpecStatusView["currentRevision"];
  slug: string;
  phase: SpecPhaseProjection;
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
  imported: PublishedSpecStatusView["imported"];
}

interface SpecLinkedWorkRollup {
  tickets: number;
  conversations: number;
  sessions: number;
}

interface SpecElementStatusesView {
  requirements: Array<{
    elementId: string;
    status: ReturnType<typeof projectRequirementStatus>;
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
  const links = createSpecLinksRepo(db);
  const eventsRepo = createSpecEventsRepo(db);
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
    events: eventsRepo,
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
    async exportSpec(specId) {
      return renderVerifiedCanonicalBundle(
        await loadSpecExportState(exportDeps, specId),
      );
    },
    async verifySpec(specId) {
      return verifyExportState(await loadSpecExportState(exportDeps, specId));
    },
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

function linkedWork(links: readonly SpecLinkRow[]): SpecLinkedWorkRollup {
  const rollup: SpecLinkedWorkRollup = {
    tickets: 0,
    conversations: 0,
    sessions: 0,
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

function requirementStatus(
  _deps: SpecRouteDeps,
  _snapshot: SpecRevisionSnapshot,
  requirement: SpecRevisionElement,
  approvals: readonly SpecApprovalRow[],
  _related?: { readonly criteria: readonly SpecRevisionElement[] },
): ReturnType<typeof projectRequirementStatus> {
  return projectRequirementStatus({
    approvalValidity: latestApprovalValidity(
      approvals,
      "requirement",
      requirement.element.id,
    ),
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
    return { requirements: [] };
  }

  const requirements = snapshot.elements
    .filter(({ element }) => element.kind === "requirement")
    .map((row) => ({
      elementId: row.element.id,
      status: requirementStatus(deps, snapshot, row, approvals),
    }));

  return { requirements };
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
): SpecPhaseProjection {
  return projectSpecPhase({
    abandoned: spec.abandonedAt !== null,
    revisions: revisions.map(({ state, authoringStage }) => ({
      state,
      authoringStage,
    })),
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
  return snapshot.elements.flatMap((entry) => {
    const payload = entry.version.payload;
    if (payload.kind !== "task") return [];
    const handle = handles.get(entry.element.id) ?? entry.element.id;
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
      },
    ];
  });
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
  loadedAdmissions?: readonly SpecGateAdmissionRow[],
): Promise<SpecStatusView> {
  const revisionId = state.currentRevision?.id ?? null;
  const attention = await loadAttentionProjection(deps, spec, state.revisions);
  const approvals = deps.findApprovalsBySpecId(spec.id);
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
    phase: phase(spec, state.revisions),
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

async function buildSummary(deps: SpecRouteDeps, spec: Spec) {
  const state = await loadCurrentState(deps, spec.id);
  const status = await buildStatus(deps, spec, state);
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
  const snapshot = state.currentSnapshot;
  const counts = outlineCounts(snapshot);
  const outlinePhase = phase(spec, state.revisions);
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
  let returnedCriteria = 0;
  const requirements: SpecShowOutlineView["requirements"] =
    requirementEntries.flatMap(({ row, handle }) => {
      const payload = row.version.payload;
      if (payload.kind !== "requirement") return [];
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
    const [aliases, linkedTickets] = await Promise.all([
      deps.listAliases(resolved.value.spec.id),
      deps.getLinkedTickets(resolved.value.projectPath, resolved.value.spec.id),
    ]);
    const approvals = deps.findApprovalsBySpecId(resolved.value.spec.id);
    const admissions = deps.findGateAdmissionsBySpecId(resolved.value.spec.id);
    const status = await buildStatus(
      deps,
      resolved.value.spec,
      state,
      admissions,
    );
    const baseRevision = state.baseSnapshot;
    const approvalSnapshot =
      state.currentApprovedSnapshot ?? state.currentSnapshot;
    const revisionNumberById = new Map(
      state.revisions.map((candidate) => [candidate.id, candidate.number]),
    );
    // Pinned revisions alone are not enough. An imported spec has no execution,
    // so nothing pins its revision and every basis-`import` admission fell off
    // the wire — leaving the surfaces that must attribute imported content to
    // import (History's policy-admissions view, the Q&A provenance register)
    // with nothing to read, and no way to tell an import from a human sign-off.
    // The current approved revision's lineage is carried for that reason.
    const admissionRevisionIds = new Set<string>();
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
    const snapshotsByRevisionId = new Map(
      [state.currentSnapshot, baseRevision, state.currentApprovedSnapshot]
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
      approvalSnapshot,
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
      approvals,
      comments,
      gateAdmissions: gateAdmissions.map((admission) =>
        toGateAdmissionView(admission, revisionNumberById),
      ),
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
    return NextResponse.json({
      ...status,
      reviewHref: `/specs/${encodeURIComponent(resolved.value.projectName)}/${encodeURIComponent(resolved.value.spec.slug)}`,
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
    getSpecSummaryGET,
    getSpecOutlineGET,
    getSpecGET,
    getSpecStatusGET,
    getSpecCommentsGET,
    getSpecEditContextGET,
    getSpecLintGET,
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
export const specSummaryGET = withTracing(handlers.getSpecSummaryGET);
export const specOutlineGET = withTracing(handlers.getSpecOutlineGET);
export const specDetailGET = withTracing(handlers.getSpecGET);
export const specStatusGET = withTracing(handlers.getSpecStatusGET);
export const specCommentsGET = withTracing(handlers.getSpecCommentsGET);
export const specEditContextGET = withTracing(handlers.getSpecEditContextGET);
export const specLintGET = withTracing(handlers.getSpecLintGET);
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
  abandonment: SpecAbandonmentService;
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
  links: Pick<
    LinksService,
    | "promoteConversation"
    | "graduateTicket"
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
  verify(specId: string): Promise<IntegrityReport>;
}

export interface SpecWriteRouteDeps {
  auth: AgentAuth;
  verifyConversationIdentity(conversationId: string): Promise<boolean>;
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
const linkTicketBodySchema = linkTicketInputSchema.omit({
  specId: true,
  actor: true,
});
const abandonSpecBodySchema = z.object({ reason: z.string() }).strict();
const renameSpecBodySchema = z
  .object({ slug: specSlugSchema, name: z.string().min(1).optional() })
  .strict();
const emptyBodySchema = z.object({}).strict();

type TransportResolution = RouteResolution<ActorProvenance>;

async function resolveTransportActor(
  deps: Pick<SpecWriteRouteDeps, "auth" | "verifyConversationIdentity">,
  request: Request,
): Promise<TransportResolution> {
  const transport = await deps.auth.validateOptionalToken(request);
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
  if (!(await deps.verifyConversationIdentity(conversationId))) {
    return {
      ok: false,
      response: jsonError(
        "Originating conversation does not exist",
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
  if (refusal.code === "validation") {
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
  ["review-acceptance", BROWSER_SESSION_REMEDY],
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
    verifyConversationIdentity: async (conversationId) =>
      verifyDurableConversationIdentity(conversationId),
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
    const actor = await resolveTransportActor(deps, request);
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
    const actor = await resolveTransportActor(deps, request);
    if (!actor.ok) return actor.response;
    const resolved = await resolveSpecRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { action } = await context.params;
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
        case "abandon-spec":
          return invokeAction(request, abandonSpecBodySchema, (input) =>
            services.abandonment.abandonSpec({
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

  return {
    projectActionPOST,
    specActionPOST,
  };
}

const writeHandlers = createSpecWriteRouteHandlers();
export const specProjectActionPOST = withTracing(
  writeHandlers.projectActionPOST,
);
export const specActionPOST = withTracing(writeHandlers.specActionPOST);
