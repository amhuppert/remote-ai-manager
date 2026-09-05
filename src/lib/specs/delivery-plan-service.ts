import type { PlanReviewLookup } from "@/lib/workflows/plan-review/service";
import { canonicalPlanDefinitionHash } from "@/lib/workflows/plan-review/schemas";
import type { PlanReviewAdvisory } from "@/lib/workflows/plan-review/status-schemas";
import { criterionRecordsOf } from "@/lib/workflow-graph/criteria/criterion-records";
import { buildPinnedSpecDocument, buildContextSpecDocument } from "./export";
import { buildSpecExecutionClaimsDocument } from "./execution-claims-document";
import { buildSpecOwnershipProjection } from "./spec-ownership-projection";
import { createLogger } from "@/lib/logging";
import { stableStringify } from "@/lib/state-store/serialization";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  StaleDeliveryPlanDraftError,
  type SpecDeliveryPlanRepo,
} from "@/lib/state-store/spec-delivery-plan-repo";
import type {
  AuthoredWorkflowLaunchAdmissionResult,
  AuthoredWorkflowModelSelectionAdmissionResult,
} from "@/lib/workflow-graph/authored-launch-admission";
import type { AuthoredAccountabilityCoverageGroup } from "@/lib/workflow-graph/spec-bridge";
import type { ManagedDefinitionPreflightResult } from "@/lib/workflows/managed-definition-preflight-contract";
import {
  type WorkflowDefinitionDraft,
  type WorkflowDefinitionMutation,
} from "@/lib/workflow-graph/definition-schemas";

import {
  canonicalDeliveryPlanEnvelopeBytes,
  deliveryPlanAttemptBlocksReplacement,
  deliveryPlanCandidateRecordSchema,
  deliveryPlanCandidateClaims,
  deliveryPlanBindingSchema,
  type DeliveryPlanClaim,
  deliveryPlanDocumentSchema,
  exclusionDispositionFromDeliveryPlan,
  executionDispositionFromDeliveryPlan,
  finalizedDeliveryPlanApprovalSchema,
  finalizedDeliveryPlanPrelaunchSchema,
  liveDeliveryPlanAttempt,
  postLaunchPathsSentence,
  type DeliveryPlanBinding,
  type DeliveryPlanCandidateRecord,
  type DeliveryPlanDocument,
  type FinalizedDeliveryPlanApproval,
  type FinalizedDeliveryPlanCandidateIdentity,
  type FinalizedDeliveryPlanPrelaunch,
} from "./delivery-plan";
import {
  admitExecutionStartForAttemptInTransaction,
  type DeliveryPlanExecutionStartAdmission,
} from "./delivery-plan-approval";
import {
  deliveryPlanBindingAccountabilityGroups,
  deriveDeliveryPlanClaims,
} from "./delivery-plan-binding-lint";
import {
  deliveryPlanBindingHash,
  deliveryPlanCandidateHash,
  deliveryPlanCandidateHashFromBytes,
  workflowDefinitionHash,
} from "./delivery-plan-hash";
import type { SpecEventsPublisher } from "./events";
import { dialRequiresHumanApproval, resolveDial } from "./policy";
import {
  renderSeededDeliveryPlanMission,
  seededDeliveryPlanCharterSources,
} from "./delivery-plan-charter-seed";
import { deliveryPlanNextAct } from "./delivery-plan-next-act";
import { HUMAN_ACT_REQUIRED_RATIONALE } from "./refusal-rationale";
import type { SpecPolicyAdmissionNotifier } from "./policy-admissions";
import type { DeliveryPlanDocumentDiff } from "./delivery-plan-diff";
import {
  certifiedDeliveryPlanClaims,
  deliveryPlanLedgerSummary,
  deliveryPlanRefusalRationale,
  unprovenDeliveryPlanClaims,
  projectDeliveryPlanDraftHealth,
  LAUNCH_NOT_ADMISSIBLE_RULE_ID,
  PLAN_PINNED_REVISION_UNAVAILABLE_RULE_ID,
  PLAN_WORKFLOW_DEFINITION_UNAVAILABLE_RULE_ID,
  type DeliveryPlanDraftHealth,
} from "./delivery-plan-health";
import {
  seedDeliveryPlanFromLast,
  seedDispositionsFromDelivery,
  type DeliveryPlanSeedBasis,
  type DeliveryPlanSeedBasisResult,
  type SeededDeliveryPlanDraft,
} from "./delivery-plan-seed";
import { draftHealth } from "./draft-health";
import {
  specPlanAttemptTransitionEvent,
  specPlanPreflightEvent,
  specPlanProposeAcceptedEvent,
  type DeliveryPlanAttemptOrigin,
  type DeliveryPlanGateSurface,
} from "./planning-telemetry";
import {
  deliveryPlanReviewView,
  type DeliveryPlanReviewView,
} from "./delivery-plan-review";
import type {
  DeliveryPlanMutationView,
  DeliveryPlanNextAct,
  DeliveryPlanPreviewStage,
  DeliveryPlanPreviewView,
  DeliveryPlanSnapshotDiffView,
  DeliveryPlanSnapshotView,
  DeliveryPlanView,
} from "./delivery-plan-views";
import type {
  ActorProvenance,
  DeliveryPlanAttemptStatus,
  Refusal,
  Spec,
  SpecDeliveryPlanAttemptRow,
  SpecDeliveryPlanSnapshotRow,
  SpecCriterionDisposition,
  SpecExecutionState,
  SpecRevisionSnapshot,
} from "./schemas";
import type { ExecutionScope } from "./scope-validation";
import type {
  ManagedWorkflowDefinitionRecord,
  ManagedWorkflowDefinitionService,
} from "./managed-workflow-definition-service";

const logger = createLogger("specs.delivery-plan");

export interface DeliveryPlanServiceDeps {
  plans: SpecDeliveryPlanRepo;
  planReviews: PlanReviewLookup;
  reviewRepo: Pick<SpecReviewRepo, "saveApproval" | "insertGateAdmission">;
  events: SpecEventsPublisher;
  managedDefinitions: ManagedWorkflowDefinitionService;
  policyNotifier?: SpecPolicyAdmissionNotifier;
  runInTransaction<T>(operation: () => T): T;
  currentApprovedRevision(specId: string): Promise<SpecRevisionSnapshot | null>;
  activeAuthoringBlocker?(input: {
    specId: string;
    pinnedRevisionId: string;
  }): Promise<{
    revisionId: string;
    revisionNumber: number;
    stage: "requirements" | "design";
    state: "draft" | "proposed" | "approved";
  } | null>;
  revisionSnapshot(revisionId: string): Promise<SpecRevisionSnapshot | null>;
  /**
   * The delivery a new attempt is measured against, read from the delivery
   * delta at open time. Every attempt records the execution it was measured
   * against; the default delta seed also derives its dispositions from it.
   */
  lastDeliveryBasis(input: {
    spec: Spec;
    pinnedRevision: SpecRevisionSnapshot;
  }): Promise<DeliveryPlanSeedBasisResult>;
  /**
   * The lifecycle state of the spec execution a launched attempt owns, or null
   * when it cannot be resolved. Read at open time so a finished run stops
   * blocking its replacement without the attempt row mirroring — and possibly
   * contradicting — the execution that owns that fact.
   */
  launchedExecutionState(executionId: string): SpecExecutionState | null;
  /**
   * The workflow execution id a launched spec execution is bound to, or null
   * when it has none. Read rather than mirrored onto the attempt row because
   * the execution owns the link, and a refusal that named a stale mirror would
   * hand the reader an id no verb accepts.
   */
  launchedWorkflowExecutionId(executionId: string): string | null;
  admitLaunch(input: {
    spec: Spec;
    launch: WorkflowDefinitionMutation;
    accountabilityGroups: readonly AuthoredAccountabilityCoverageGroup[];
  }): Promise<AuthoredWorkflowLaunchAdmissionResult>;
  admitModelSelections(input: {
    spec: Spec;
    launch: WorkflowDefinitionDraft;
  }): Promise<AuthoredWorkflowModelSelectionAdmissionResult>;
  nextId(): string;
  now(): string;
  projectName?(projectPath: string): string;
}

export type PlanResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: Refusal };

export interface OpenDeliveryPlanInput {
  spec: Spec;
  actor: ActorProvenance;
}
export interface EditDeliveryPlanInput {
  spec: Spec;
  expectedDraftRevision: number;
  binding: DeliveryPlanBinding;
  actor: ActorProvenance;
}
export interface ProposeDeliveryPlanServiceInput {
  spec: Spec;
  actor: ActorProvenance;
}
export interface DiffDeliveryPlanSnapshotsInput {
  spec: Spec;
  fromSnapshotId: string;
  toSnapshotId: string;
}
export interface ReaffirmDeliveryPlanCriteriaInput {
  spec: Spec;
  expectedDraftRevision: number;
  criterionElementIds: readonly string[];
  actor: ActorProvenance;
}
export interface CommentOnDeliveryPlanInput {
  spec: Spec;
  contextId: string;
  body: string;
  actor: ActorProvenance;
}
export interface ReopenDeliveryPlanServiceInput {
  spec: Spec;
  reason: string;
  actor: ActorProvenance;
}
export interface PreviewDeliveryPlanServiceInput {
  spec: Spec;
  stage: DeliveryPlanPreviewStage;
  expectedDraftRevision?: number;
}
export interface SignOffDeliveryPlanServiceInput extends FinalizedDeliveryPlanCandidateIdentity {
  spec: Spec;
  actor: ActorProvenance;
  approver: string;
}
export interface ParkDeliveryPlanServiceInput extends FinalizedDeliveryPlanCandidateIdentity {
  spec: Spec;
  reason: string | null;
  actor: ActorProvenance;
}

export interface DeliveryPlanLaunchCandidate {
  attemptId: string;
  pinnedRevisionId: string;
  launchRevision: number;
  candidate: FinalizedDeliveryPlanCandidateIdentity;
  candidateRecord: DeliveryPlanCandidateRecord;
  candidateBytes: string;
  workflowDefinition: {
    id: string;
    revision: number;
    definitionHash: string;
  };
  binding: DeliveryPlanBinding;
  claims: DeliveryPlanClaim[];
  scope: ExecutionScope;
  dispositions: readonly {
    criterionElementId: string;
    disposition: SpecCriterionDisposition;
    deliveredByExecutionId: string | null;
  }[];
}

export type DeliveryPlanLaunchResolution =
  | { readonly kind: "ready"; readonly value: DeliveryPlanLaunchCandidate }
  | {
      readonly kind: "unapproved";
      readonly attemptId: string;
      readonly candidate: FinalizedDeliveryPlanCandidateIdentity;
      readonly refusal: Refusal;
    }
  | { readonly kind: "refused"; readonly refusal: Refusal };

export interface DeliveryPlanService {
  open(
    input: OpenDeliveryPlanInput,
  ): Promise<PlanResult<DeliveryPlanMutationView>>;
  edit(
    input: EditDeliveryPlanInput,
  ): Promise<PlanResult<DeliveryPlanMutationView>>;
  propose(
    input: ProposeDeliveryPlanServiceInput,
  ): Promise<PlanResult<DeliveryPlanMutationView>>;
  reopen(
    input: ReopenDeliveryPlanServiceInput,
  ): Promise<PlanResult<DeliveryPlanMutationView>>;
  read(input: { spec: Spec }): Promise<PlanResult<DeliveryPlanView>>;
  preflight(input: {
    spec: Spec;
    attemptId: string;
    workflowDefinitionId: string;
    launch: WorkflowDefinitionMutation;
  }): Promise<ManagedDefinitionPreflightResult>;
  review(input: { spec: Spec }): Promise<PlanResult<DeliveryPlanReviewView>>;
  comment(
    input: CommentOnDeliveryPlanInput,
  ): Promise<PlanResult<DeliveryPlanReviewView>>;
  reaffirmBatch(
    input: ReaffirmDeliveryPlanCriteriaInput,
  ): Promise<PlanResult<DeliveryPlanReviewView>>;
  diffSnapshots(
    input: DiffDeliveryPlanSnapshotsInput,
  ): Promise<PlanResult<DeliveryPlanSnapshotDiffView>>;
  preview(
    input: PreviewDeliveryPlanServiceInput,
  ): Promise<PlanResult<DeliveryPlanPreviewView>>;
  signOff(
    input: SignOffDeliveryPlanServiceInput,
  ): Promise<PlanResult<DeliveryPlanMutationView>>;
  park(
    input: ParkDeliveryPlanServiceInput,
  ): Promise<PlanResult<DeliveryPlanMutationView>>;
  resolveLaunch(input: { spec: Spec }): Promise<DeliveryPlanLaunchResolution>;
  recordLaunch(input: {
    spec: Spec;
    executionId: string;
    candidate: FinalizedDeliveryPlanCandidateIdentity;
    actor: ActorProvenance;
  }): Promise<PlanResult<DeliveryPlanMutationView>>;
  abandonLaunch(input: {
    spec: Spec;
    executionId: string;
    reason: string;
    actor: ActorProvenance;
  }): Promise<PlanResult<{ attemptId: string }>>;
  abandonPrelaunch(input: {
    spec: Spec;
    reason: string;
    actor: ActorProvenance;
  }): Promise<PlanResult<{ attemptId: string }>>;
}

function coverageUpgradeRefusal(
  attempt: SpecDeliveryPlanAttemptRow,
  slug: string,
): Refusal | null {
  if (attempt.status === "launched" || attempt.status === "abandoned")
    return null;
  const document = deliveryPlanDocumentSchema.parse(
    JSON.parse(attempt.content_json),
  );
  if (document.schemaVersion === 4) return null;
  return {
    code: "plan_status_conflict",
    unmetConditions: [
      "This v3 attempt must be reopened into v4 so its claims derive from criterion coverage; any signed candidate needs fresh sign-off.",
    ],
    instruction: `Run \`cctl spec plan reopen ${slug} --reason <why>\`, author covers through workflow replace, then propose and sign off the v4 candidate.`,
  };
}

export function createDeliveryPlanService(
  deps: DeliveryPlanServiceDeps,
): DeliveryPlanService {
  function liveAttempt(specId: string): SpecDeliveryPlanAttemptRow | null {
    return liveDeliveryPlanAttempt(deps.plans.findAttemptsBySpecId(specId));
  }

  function blocksReplacement(attempt: SpecDeliveryPlanAttemptRow): boolean {
    return deliveryPlanAttemptBlocksReplacement({
      status: attempt.status,
      launchedExecutionState:
        attempt.launched_execution_id === null
          ? null
          : deps.launchedExecutionState(attempt.launched_execution_id),
    });
  }

  async function authoringBlocker(
    spec: Spec,
    pinnedRevisionId: string,
  ): Promise<Refusal | null> {
    const blocker = await deps.activeAuthoringBlocker?.({
      specId: spec.id,
      pinnedRevisionId,
    });
    if (!blocker) return null;
    return {
      code: "authoring_unsettled",
      unmetConditions: [
        `${blocker.stage} revision ${blocker.revisionNumber} (${blocker.revisionId}) is ${blocker.state}.`,
      ],
      rationale:
        "Requirements settle before design, and design settles before delivery planning so implementation choices cannot shape an unapproved contract.",
      instruction: `Settle or withdraw the active ${blocker.stage} revision before planning or launching delivery for ${spec.slug}.`,
    };
  }

  async function pinned(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
  ): Promise<PlanResult<SpecRevisionSnapshot>> {
    const snapshot = await deps.revisionSnapshot(attempt.pinned_revision_id);
    return snapshot === null
      ? {
          ok: false,
          refusal: {
            code: "not_found",
            unmetConditions: [
              `Delivery plan ${attempt.id} pins missing revision ${attempt.pinned_revision_id}.`,
            ],
            instruction: `Open a fresh delivery-plan attempt for ${spec.slug}.`,
          },
        }
      : { ok: true, value: snapshot };
  }

  function snapshots(
    attempt: SpecDeliveryPlanAttemptRow,
  ): DeliveryPlanSnapshotView[] {
    return deps.plans.findSnapshotsByAttemptId(attempt.id).map(snapshotView);
  }

  function candidateIdentity(
    attempt: SpecDeliveryPlanAttemptRow,
  ): FinalizedDeliveryPlanCandidateIdentity | null {
    if (attempt.proposed_snapshot_id === null) return null;
    const snapshot = deps.plans.findSnapshotById(attempt.proposed_snapshot_id);
    return snapshot === null ||
      snapshot.candidate_id === null ||
      snapshot.candidate_hash === null
      ? null
      : {
          candidateId: snapshot.candidate_id,
          candidateHash: snapshot.candidate_hash,
        };
  }

  async function workingDefinition(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
  ): Promise<ManagedWorkflowDefinitionRecord | null> {
    if (attempt.workflow_definition_id === null) return null;
    return deps.managedDefinitions.get({
      projectPath: spec.projectPath,
      workflowDefinitionId: attempt.workflow_definition_id,
    });
  }

  /**
   * A proposal that failed to commit would otherwise leave the definition
   * frozen under a draft attempt — a charter nobody can author. Restoring the
   * draft stage keeps the attempt editable; a failure here is logged rather
   * than raised so the commit error stays the one the caller sees.
   */
  async function thawAfterFailedProposal(
    spec: Spec,
    attempt: SpecDeliveryPlanAttemptRow,
    frozen: ManagedWorkflowDefinitionRecord,
  ): Promise<void> {
    try {
      await deps.managedDefinitions.restage({
        spec,
        pinnedRevisionId: attempt.pinned_revision_id,
        attemptId: attempt.id,
        workflowDefinitionId: frozen.id,
        expectedRevision: frozen.revision,
        stage: "draft",
      });
    } catch (thawError) {
      logger.error("specs.delivery-plan.definition.thaw_failed", {
        specId: spec.id,
        attemptId: attempt.id,
        workflowDefinitionId: frozen.id,
        revision: frozen.revision,
        error:
          thawError instanceof Error ? thawError.message : String(thawError),
      });
    }
  }

  /**
   * What the draft still owes, read through the projection `propose` refuses
   * on. A frozen attempt owes nothing: its bytes were admitted and linted at
   * proposal and cannot change, so re-admitting them would only report the same
   * verdict against a launch nobody can still edit.
   */
  async function healthOf(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
    document: DeliveryPlanDocument,
    surface: DeliveryPlanGateSurface,
    submittedLaunch?: WorkflowDefinitionMutation,
  ): Promise<DeliveryPlanDraftHealth> {
    const health = await projectHealth(
      attempt,
      spec,
      document,
      submittedLaunch,
    );
    const telemetry = specPlanPreflightEvent({
      slug: spec.slug,
      surface,
      findings: health.findings,
    });
    logger.info(telemetry.event, telemetry.fields);
    return health;
  }

  /**
   * The projection itself. Separated from {@link healthOf} so every evaluation
   * — including the ones that answer early — leaves exactly one
   * `spec.plan.preflight` line, rather than one per return path.
   */
  async function projectHealth(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
    document: DeliveryPlanDocument,
    submittedLaunch?: WorkflowDefinitionMutation,
  ): Promise<DeliveryPlanDraftHealth> {
    const upgrade = coverageUpgradeRefusal(attempt, spec.slug);
    if (upgrade !== null) {
      const message = `${upgrade.unmetConditions.join(" ")} ${upgrade.instruction}`;
      return {
        findings: [
          {
            ruleId: "plan/coverage-upgrade-required",
            severity: "blocks_propose",
            elementHandle: attempt.id,
            message,
          },
        ],
        unresolved: [],
        refusalConditions: [message],
        claims: unprovenDeliveryPlanClaims(document.binding),
      };
    }
    if (attempt.status !== "draft") {
      return {
        findings: [],
        unresolved: [],
        refusalConditions: [],
        claims: certifiedDeliveryPlanClaims(document.binding),
      };
    }
    const pinnedRevision = await deps.revisionSnapshot(
      attempt.pinned_revision_id,
    );
    if (pinnedRevision === null) {
      const message = `Pinned revision ${attempt.pinned_revision_id} is unavailable, so this draft cannot be judged against the criteria it must dispose.`;
      return {
        findings: [
          {
            ruleId: PLAN_PINNED_REVISION_UNAVAILABLE_RULE_ID,
            severity: "blocks_propose",
            elementHandle: attempt.pinned_revision_id,
            message,
          },
        ],
        unresolved: [],
        refusalConditions: [message],
        claims: unprovenDeliveryPlanClaims(document.binding),
      };
    }
    const definition = await workingDefinition(attempt, spec);
    if (definition === null) {
      const message = `Managed workflow definition ${attempt.workflow_definition_id ?? "(missing identity)"} is unavailable.`;
      return {
        findings: [
          {
            ruleId: PLAN_WORKFLOW_DEFINITION_UNAVAILABLE_RULE_ID,
            severity: "blocks_propose",
            elementHandle: attempt.id,
            message,
          },
        ],
        unresolved: [],
        refusalConditions: [message],
        claims: unprovenDeliveryPlanClaims(document.binding),
      };
    }
    const launch = submittedLaunch ?? definition;
    return projectDeliveryPlanDraftHealth({
      pinnedRevision,
      binding: document.binding,
      draftCharter: launch.definition.charter,
      workflowDefinitionId: definition.id,
      admission: await deps.admitLaunch({
        spec,
        launch,
        accountabilityGroups: deliveryPlanBindingAccountabilityGroups(
          document.binding,
          launch.definition,
        ),
      }),
    });
  }

  /**
   * The refusal a blocking projection produces. Each class keeps the code its
   * caller already handles — an unreadable draft is still `not_found`, a launch
   * the graph boundary refuses is still an admission refusal — but every
   * condition is the projection's own text, so `spec plan status` and this
   * refusal can never word the same finding differently.
   */
  function proposeRefusal(
    spec: Spec,
    attempt: SpecDeliveryPlanAttemptRow,
    health: DeliveryPlanDraftHealth,
  ): PlanResult<never> | null {
    if (health.refusalConditions.length === 0) return null;
    const ruleIds = new Set(health.findings.map((finding) => finding.ruleId));
    const unmetConditions = [...health.refusalConditions];
    // The why: line belongs to the finding, not to the class of refusal that
    // happens to carry it: a charter stub reported beside an inadmissible graph
    // states its reason exactly as it does when it is the only condition.
    const rationale = deliveryPlanRefusalRationale(health);
    const reasoned = (refusal: Refusal): PlanResult<never> => ({
      ok: false,
      refusal: {
        ...refusal,
        findings: [...health.findings],
        ...(rationale === undefined ? {} : { rationale }),
      },
    });

    if (ruleIds.has(PLAN_PINNED_REVISION_UNAVAILABLE_RULE_ID)) {
      return reasoned({
        code: "not_found",
        unmetConditions,
        instruction: `Open a fresh attempt for ${spec.slug}.`,
      });
    }
    if (ruleIds.has(PLAN_WORKFLOW_DEFINITION_UNAVAILABLE_RULE_ID)) {
      // The code and instruction the caller already handles, over the
      // projection's own condition: the refusal names the definition status
      // reported, not a second sentence about the same absence.
      return reasoned({ ...invalidCandidate(spec.slug), unmetConditions });
    }
    if (ruleIds.has(LAUNCH_NOT_ADMISSIBLE_RULE_ID)) {
      return reasoned(admissionRefusal(spec.slug, unmetConditions));
    }
    logger.info("specs.delivery-plan.binding_lint_refused", {
      specId: spec.id,
      attemptId: attempt.id,
      candidateId: attempt.workflow_definition_id,
      issueCount: health.refusalConditions.length,
    });
    return reasoned({
      code: "lint_blocked",
      unmetConditions,
      instruction:
        "Correct coverage and charter findings with cctl workflow replace; settle human dispositions in Spec Studio, then propose again.",
    });
  }

  function planReview(
    definition: ManagedWorkflowDefinitionRecord | null,
    expectedHash: string,
  ): PlanReviewAdvisory {
    if (
      definition === null ||
      workflowDefinitionHash(definition) !== expectedHash
    )
      return { state: "unreviewed" };
    try {
      const review = deps.planReviews.findLatestTerminalReview(
        canonicalPlanDefinitionHash(definition.definition),
      );
      return review === null
        ? { state: "unreviewed" }
        : {
            state: review.verdict,
            reviewerConversationId: review.reviewerConversationId,
            reviewedAt: review.reviewedAt,
          };
    } catch (error) {
      logger.warn("specs.delivery-plan.review_lookup_failed", {
        workflowDefinitionId: definition.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { state: "unreviewed" };
    }
  }

  async function project(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
  ): Promise<DeliveryPlanView> {
    const candidate = candidateIdentity(attempt);
    const frozenCandidate = candidateRecord(attempt, deps.plans);
    const document =
      frozenCandidate === null
        ? deliveryPlanDocumentSchema.parse(JSON.parse(attempt.content_json))
        : deliveryPlanDocumentSchema.parse({
            schemaVersion: frozenCandidate.schemaVersion,
            binding: frozenCandidate.binding,
          });
    const approval = parseApproval(attempt);
    const current = candidate;
    const prelaunch = parsePrelaunch(attempt);
    const health = await healthOf(attempt, spec, document, "status");
    const currentDefinition = await workingDefinition(attempt, spec);
    const workflowDefinition =
      frozenCandidate?.workflowDefinition ??
      (currentDefinition === null
        ? null
        : {
            id: currentDefinition.id,
            revision: currentDefinition.revision,
            definitionHash: workflowDefinitionHash(currentDefinition),
          });
    if (workflowDefinition === null) {
      throw new Error(
        `Managed workflow definition ${attempt.workflow_definition_id ?? "(missing identity)"} is unavailable.`,
      );
    }
    return {
      attempt: {
        id: attempt.id,
        specSlug: spec.slug,
        status: attempt.status,
        draftRevision: attempt.draft_revision,
        pinnedRevisionId: attempt.pinned_revision_id,
        deltaBasisExecutionId: attempt.delta_basis_execution_id,
        proposedSnapshotId: attempt.proposed_snapshot_id,
        candidateId: current?.candidateId ?? null,
        candidateHash: current?.candidateHash ?? null,
        launchedExecutionId: attempt.launched_execution_id,
        workflowDefinitionId:
          attempt.workflow_definition_id ??
          frozenCandidate?.workflowDefinition.id ??
          attempt.id,
        createdAt: attempt.created_at,
        updatedAt: attempt.updated_at,
      },
      approval,
      prelaunch:
        prelaunch === null
          ? null
          : {
              parkedAt: prelaunch.parkedAt,
              parkedBy: prelaunch.parkedBy,
              reason: prelaunch.reason,
              approvedAtPark: prelaunch.approvedAtPark,
              parkedCandidateId: prelaunch.candidate.candidateId,
              parkedCandidateHash: prelaunch.candidate.candidateHash,
              currentCandidateId: current?.candidateId ?? null,
              currentCandidateHash: current?.candidateHash ?? null,
              candidateChanged:
                current === null ||
                !sameCandidate(current, prelaunch.candidate),
            },
      document,
      claims:
        frozenCandidate !== null
          ? deliveryPlanCandidateClaims(frozenCandidate)
          : document.schemaVersion === 3
            ? document.binding.claims
            : currentDefinition === null
              ? []
              : deriveDeliveryPlanClaims(
                  document.binding,
                  currentDefinition.definition,
                ),
      workflowDefinition: {
        ...workflowDefinition,
        builderHref: `/projects/${encodeURIComponent(deps.projectName?.(spec.projectPath) ?? spec.projectPath.split("/").filter(Boolean).at(-1) ?? spec.projectPath)}/workflows?definition=${encodeURIComponent(workflowDefinition.id)}`,
      },
      reviewStatus: planReview(
        currentDefinition,
        workflowDefinition.definitionHash,
      ),
      health: healthView(health),
      ledger: deliveryPlanLedgerSummary({
        binding: document.binding,
        workflowCharter: currentDefinition?.definition.charter ?? null,
        health,
      }),
      dispositionCounts: dispositionCounts(document.binding),
      unresolved: [...health.unresolved],
      snapshots: snapshots(attempt),
      nextAct: nextAct(attempt, spec),
    };
  }

  async function reviewOf(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
  ): Promise<PlanResult<DeliveryPlanReviewView>> {
    const resolved = await pinned(attempt, spec);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      value: deliveryPlanReviewView({
        plan: await project(attempt, spec),
        pinned: resolved.value,
        comments: deps.plans
          .findCommentsByAttemptId(attempt.id)
          .map((comment) => ({
            id: comment.id,
            contextId: comment.context_id,
            body: comment.body,
            author: JSON.parse(comment.author_json) as ActorProvenance,
            createdAt: comment.created_at,
          })),
      }),
    };
  }

  function publishPlanChange(
    spec: Spec,
    view: DeliveryPlanView,
    kind: string,
  ): void {
    deps.events.publishSseAfterCommit({
      type: "spec-delivery-plan-changed",
      kind,
      projectPath: spec.projectPath,
      specId: spec.id,
      specSlug: spec.slug,
      occurredAt: view.attempt.updatedAt,
      attemptId: view.attempt.id,
      draftRevision: view.attempt.draftRevision,
      candidateId: view.attempt.candidateId,
    });
  }

  async function admitSeededModelSelections(
    spec: Spec,
    document: SeededDeliveryPlanDraft,
  ): Promise<PlanResult<SeededDeliveryPlanDraft>> {
    const admission = await deps.admitModelSelections({
      spec,
      launch: document.launch,
    });
    if (!admission.ok) {
      logger.warn("specs.delivery-plan.model-selection-rejected", {
        specId: spec.id,
        operation: "seed_from_last",
        issueCount: admission.issues.length,
        issueCodes: admission.issues.map((issue) => issue.code),
      });
      return seededOpenAdmissionRefusal(
        spec.slug,
        admission.issues.map((issue) => `${issue.path}: ${issue.message}`),
      );
    }
    return {
      ok: true,
      value: { ...document, launch: admission.launch },
    };
  }

  return {
    async preflight(input) {
      const attempt = deps.plans.findAttemptById(input.attemptId);
      if (
        attempt === null ||
        attempt.spec_id !== input.spec.id ||
        attempt.workflow_definition_id !== input.workflowDefinitionId
      ) {
        return {
          ok: false,
          refusal: {
            code: "definition_not_managed",
            message: `Workflow definition ${input.workflowDefinitionId} is not the current managed definition for ${input.spec.slug}.`,
            instruction: `Run \`cctl spec plan status ${input.spec.slug}\` and use the workflow definition id it names.`,
          },
        };
      }
      if (attempt.status !== "draft") {
        const reopenable = ["proposed", "approved", "parked"].includes(
          attempt.status,
        );
        return {
          ok: false,
          refusal: {
            code: "delivery_plan_not_draft",
            message: `Delivery plan ${input.spec.slug} is ${attempt.status}, not draft.`,
            instruction: reopenable
              ? `Run \`cctl spec plan reopen ${input.spec.slug} --reason <why>\` before validating replacement bytes.`
              : `Run \`cctl spec plan status ${input.spec.slug}\` to read the attempt's available next act.`,
            ...(attempt.status === "abandoned"
              ? {}
              : {
                  rationale:
                    "the signed candidate is immutable so sign-off approves exact bytes",
                }),
          },
        };
      }

      const document = deliveryPlanDocumentSchema.parse(
        JSON.parse(attempt.content_json),
      );
      const health = await healthOf(
        attempt,
        input.spec,
        document,
        "validate",
        input.launch,
      );
      return {
        ok: true,
        specSlug: input.spec.slug,
        findings: [...health.findings],
        summary: deliveryPlanLedgerSummary({
          binding: document.binding,
          workflowCharter: input.launch.definition.charter,
          health,
        }),
      };
    },

    async open(input) {
      return deps.managedDefinitions.runExclusive(
        `native-sdd-open:${input.spec.id}`,
        async () => {
          const pinnedRevision = await deps.currentApprovedRevision(
            input.spec.id,
          );
          if (pinnedRevision === null)
            return noApprovedRevision(input.spec.slug);
          const unsettled = await authoringBlocker(
            input.spec,
            pinnedRevision.revision.id,
          );
          if (unsettled) return { ok: false, refusal: unsettled };
          const blocking = liveAttempt(input.spec.id);
          if (blocking !== null && blocksReplacement(blocking)) {
            return liveAttemptAlreadyOpen(input.spec.slug);
          }
          const basis = await deps.lastDeliveryBasis({
            spec: input.spec,
            pinnedRevision,
          });
          if (!basis.ok)
            return unreadableDeliveryBasis(input.spec.slug, basis.message);
          const hasSeedCandidate = deps.plans
            .findAttemptsBySpecId(input.spec.id)
            .some((attempt) => storedCandidate(attempt, deps.plans) !== null);
          const document = hasSeedCandidate
            ? await seededDocumentForOpen(
                deps.plans,
                deps.managedDefinitions,
                input.spec,
                pinnedRevision,
                basis.basis,
              )
            : {
                ok: true as const,
                value: initialDocumentForOpen(input.spec, pinnedRevision),
              };
          if (!document.ok) return document;
          const admittedDocument = hasSeedCandidate
            ? await admitSeededModelSelections(input.spec, document.value)
            : document;
          if (!admittedDocument.ok) return admittedDocument;
          const occurredAt = deps.now();
          try {
            const attempts = deps.plans.findAttemptsBySpecId(input.spec.id);
            const orphan = await deps.managedDefinitions.findOpenOrphan({
              spec: input.spec,
              pinnedRevisionId: pinnedRevision.revision.id,
              existingAttemptIds: attempts.map((attempt) => attempt.id),
            });
            const attemptId = orphan?.id ?? deps.nextId();
            const existingDefinition = await deps.managedDefinitions.get({
              projectPath: input.spec.projectPath,
              workflowDefinitionId: attemptId,
            });
            const definition = await deps.managedDefinitions.open({
              spec: input.spec,
              pinnedRevisionId: pinnedRevision.revision.id,
              attemptId,
              launch: admittedDocument.value.launch,
            });
            const planDocument = deliveryPlanDocumentSchema.parse({
              schemaVersion: 4,
              binding: admittedDocument.value.binding,
            });
            let opened: SpecDeliveryPlanAttemptRow;
            try {
              opened = deps.plans.open({
                attempt: {
                  id: attemptId,
                  spec_id: input.spec.id,
                  pinned_revision_id: pinnedRevision.revision.id,
                  delta_basis_execution_id: basis.basis.comparedExecutionId,
                  status: "draft",
                  draft_revision: 1,
                  content_json:
                    canonicalDeliveryPlanEnvelopeBytes(planDocument),
                  proposed_snapshot_id: null,
                  approval_json: null,
                  prelaunch_json: null,
                  launched_execution_id: null,
                  workflow_definition_id: definition.id,
                  created_at: occurredAt,
                  updated_at: occurredAt,
                },
                occurredAt,
                actor: input.actor,
              });
            } catch (error) {
              if (existingDefinition === null) {
                try {
                  await deps.managedDefinitions.removeExact({
                    projectPath: input.spec.projectPath,
                    workflowDefinitionId: definition.id,
                    revision: definition.revision,
                    definitionHash: workflowDefinitionHash(definition),
                  });
                } catch (cleanupError) {
                  logger.error(
                    "specs.delivery-plan.definition.cleanup_failed",
                    {
                      specId: input.spec.id,
                      attemptId,
                      workflowDefinitionId: definition.id,
                      error:
                        cleanupError instanceof Error
                          ? cleanupError.message
                          : String(cleanupError),
                    },
                  );
                }
              }
              throw error;
            }
            logAttemptTransition({
              slug: input.spec.slug,
              from: "none",
              to: opened.status,
              actor: input.actor,
            });
            const view = await project(opened, input.spec);
            logger.info("specs.delivery-plan.opened", {
              specId: input.spec.id,
              attemptId: opened.id,
              seedFromLast: hasSeedCandidate,
              deltaBasisExecutionId: basis.basis.comparedExecutionId,
              blockingFindingCount: view.health.blocking,
            });
            publishPlanChange(input.spec, view, "opened");
            return mutation(view, null, null);
          } catch (error) {
            return planFailure(error, input.spec.slug);
          }
        },
      );
    },

    async edit(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      const upgrade = coverageUpgradeRefusal(attempt, input.spec.slug);
      if (upgrade !== null) return { ok: false, refusal: upgrade };
      const document = deliveryPlanDocumentSchema.parse({
        schemaVersion: 4,
        binding: input.binding,
      });
      // Read before the write: the receipt reports the blocking count the edit
      // moved from, which is what makes a partial correction legible.
      const before = await healthOf(
        attempt,
        input.spec,
        deliveryPlanDocumentSchema.parse(JSON.parse(attempt.content_json)),
        "status",
      );
      try {
        const edited = deps.plans.saveDraft({
          attemptId: attempt.id,
          expectedDraftRevision: input.expectedDraftRevision,
          document,
          updatedAt: deps.now(),
        });
        const view = await project(edited, input.spec);
        logger.info("specs.delivery-plan.edited", {
          specId: input.spec.id,
          attemptId: edited.id,
          draftRevision: edited.draft_revision,
          blockingFindingCount: view.health.blocking,
        });
        publishPlanChange(input.spec, view, "edited");
        return mutation(view, healthTotals(before), null);
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async propose(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      const upgrade = coverageUpgradeRefusal(attempt, input.spec.slug);
      if (upgrade !== null) return { ok: false, refusal: upgrade };
      const unsettled = await authoringBlocker(
        input.spec,
        attempt.pinned_revision_id,
      );
      if (unsettled) return { ok: false, refusal: unsettled };
      if (attempt.workflow_definition_id === null) {
        return {
          ok: false,
          refusal: invalidCandidate(
            input.spec.slug,
            "The managed workflow definition is missing.",
          ),
        };
      }
      const sourceDefinitionId = attempt.workflow_definition_id;
      return deps.managedDefinitions.runExclusive(
        sourceDefinitionId,
        async () => {
          const document = deliveryPlanDocumentSchema.parse(
            JSON.parse(attempt.content_json),
          );
          // The refusal and `plan status` read the same projection through the
          // same entry, so a draft that reads proposable cannot refuse here and
          // a refusal always shows up on the next status.
          const health = await healthOf(
            attempt,
            input.spec,
            document,
            "propose",
          );
          const blocked = proposeRefusal(input.spec, attempt, health);
          if (blocked) return blocked;
          const definition = await workingDefinition(attempt, input.spec);
          if (definition === null) {
            return {
              ok: false,
              refusal: invalidCandidate(
                input.spec.slug,
                "The managed workflow definition is missing.",
              ),
            };
          }
          try {
            // The freeze is the lock. The draft definition keeps its charter
            // authorable; proposing writes the candidate-stage revision a
            // sign-off binds, so the manifest names the frozen bytes.
            const pinnedRevision = await pinned(attempt, input.spec);
            if (!pinnedRevision.ok) return pinnedRevision;
            const claims = deriveDeliveryPlanClaims(
              document.binding,
              definition.definition,
            );
            const selected = new Set(
              document.binding.dispositions
                .filter((entry) => entry.disposition === "in_scope")
                .map((entry) => entry.criterionElementId),
            );
            const seededDocuments = [
              buildPinnedSpecDocument(input.spec, pinnedRevision.value),
              ...definition.definition.executionContexts.map((context) =>
                buildContextSpecDocument(
                  input.spec,
                  pinnedRevision.value,
                  context.id,
                  criterionRecordsOf(context.acceptanceCriteria).flatMap(
                    (record) =>
                      (record.covers ?? []).filter((id) => selected.has(id)),
                  ),
                ),
              ),
              buildSpecExecutionClaimsDocument(
                buildSpecOwnershipProjection(
                  {
                    candidateId: definition.id,
                    pinnedRevisionId: attempt.pinned_revision_id,
                    dispositions: document.binding.dispositions,
                    claims,
                  },
                  pinnedRevision.value,
                  undefined,
                  definition.definition.executionContexts.map(
                    (context) => context.id,
                  ),
                ),
              ),
            ];
            const frozen = await deps.managedDefinitions.restage({
              spec: input.spec,
              pinnedRevisionId: attempt.pinned_revision_id,
              attemptId: attempt.id,
              workflowDefinitionId: definition.id,
              expectedRevision: definition.revision,
              stage: "candidate",
              seededDocuments,
            });
            const candidateRecord: DeliveryPlanCandidateRecord = {
              protocol: "native-sdd-delivery-candidate/v4",
              schemaVersion: 4,
              specId: input.spec.id,
              attemptId: attempt.id,
              candidateId: frozen.id,
              pinnedRevisionId: attempt.pinned_revision_id,
              draftRevision: attempt.draft_revision,
              workflowDefinition: {
                id: frozen.id,
                revision: frozen.revision,
                definitionHash: workflowDefinitionHash(frozen),
              },
              binding: deliveryPlanBindingSchema.parse(document.binding),
              claims,
              bindingHash: deliveryPlanBindingHash(document.binding),
            };
            const candidateHash = deliveryPlanCandidateHash(candidateRecord);
            let proposed: ReturnType<SpecDeliveryPlanRepo["propose"]>;
            try {
              proposed = deps.plans.propose({
                attemptId: attempt.id,
                expectedDraftRevision: attempt.draft_revision,
                snapshotId: deps.nextId(),
                proposedAt: deps.now(),
                actor: input.actor,
                candidate: { record: candidateRecord, candidateHash },
              });
            } catch (error) {
              await thawAfterFailedProposal(input.spec, attempt, frozen);
              throw error;
            }
            logger.info("specs.delivery-plan.proposed", {
              specId: input.spec.id,
              attemptId: attempt.id,
              candidateId: candidateRecord.candidateId,
              candidateHash,
              workflowDefinitionRevision: frozen.revision,
              seededDocumentCount:
                frozen.definition.seededDocuments?.length ?? 0,
            });
            logAttemptTransition({
              slug: input.spec.slug,
              from: attempt.status,
              to: proposed.attempt.status,
              actor: input.actor,
            });
            const accepted = specPlanProposeAcceptedEvent({
              slug: input.spec.slug,
              covered: health.claims.claimed,
              selected: health.claims.selected,
              contexts: frozen.definition.executionContexts.length,
            });
            logger.info(accepted.event, accepted.fields);
            const view = await project(proposed.attempt, input.spec);
            publishPlanChange(input.spec, view, "proposed");
            return mutation(view, healthTotals(health), null);
          } catch (error) {
            return planFailure(error, input.spec.slug);
          }
        },
      );
    },

    async reopen(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      if (attempt.workflow_definition_id === null) {
        return {
          ok: false,
          refusal: invalidCandidate(
            input.spec.slug,
            "The attempt has no managed workflow definition to reopen.",
          ),
        };
      }
      const sourceDefinitionId = attempt.workflow_definition_id;
      return deps.managedDefinitions.runExclusive(
        sourceDefinitionId,
        async () => {
          try {
            const linkedDefinitionIds = [
              sourceDefinitionId,
              ...deps.plans
                .findSnapshotsByAttemptId(attempt.id)
                .flatMap((snapshot) =>
                  snapshot.workflow_definition_id === null
                    ? []
                    : [snapshot.workflow_definition_id],
                ),
            ];
            const orphan = await deps.managedDefinitions.findReopenOrphan({
              spec: input.spec,
              pinnedRevisionId: attempt.pinned_revision_id,
              attemptId: attempt.id,
              linkedDefinitionIds,
            });
            const cloneDefinitionId = orphan?.id ?? deps.nextId();
            const existingDefinition = await deps.managedDefinitions.get({
              projectPath: input.spec.projectPath,
              workflowDefinitionId: cloneDefinitionId,
            });
            const clone = await deps.managedDefinitions.clone({
              spec: input.spec,
              pinnedRevisionId: attempt.pinned_revision_id,
              attemptId: attempt.id,
              sourceDefinitionId,
              cloneDefinitionId,
            });
            let reopened: ReturnType<SpecDeliveryPlanRepo["reopen"]>;
            try {
              reopened = deps.plans.reopen({
                attemptId: attempt.id,
                reopenedAt: deps.now(),
                actor: input.actor,
                reason: input.reason,
                workflowDefinitionId: clone.id,
              });
            } catch (error) {
              if (existingDefinition === null) {
                try {
                  await deps.managedDefinitions.removeExact({
                    projectPath: input.spec.projectPath,
                    workflowDefinitionId: clone.id,
                    revision: clone.revision,
                    definitionHash: workflowDefinitionHash(clone),
                  });
                } catch (cleanupError) {
                  logger.error(
                    "specs.delivery-plan.definition.cleanup_failed",
                    {
                      specId: input.spec.id,
                      attemptId: attempt.id,
                      workflowDefinitionId: clone.id,
                      error:
                        cleanupError instanceof Error
                          ? cleanupError.message
                          : String(cleanupError),
                    },
                  );
                }
              }
              throw error;
            }
            logAttemptTransition({
              slug: input.spec.slug,
              from: attempt.status,
              to: reopened.attempt.status,
              actor: input.actor,
            });
            const view = await project(reopened.attempt, input.spec);
            publishPlanChange(input.spec, view, "reopened");
            // Frozen bytes owed nothing; the reopened draft's own health is what
            // the receipt moves to.
            return mutation(
              view,
              { total: 0, blocking: 0 },
              reopened.invalidatedApproval,
            );
          } catch (error) {
            return planFailure(error, input.spec.slug);
          }
        },
      );
    },

    async read(input) {
      const attempt = liveAttempt(input.spec.id);
      return attempt === null
        ? noAttempt(input.spec.slug)
        : { ok: true, value: await project(attempt, input.spec) };
    },

    async review(input) {
      const attempt = liveAttempt(input.spec.id);
      return attempt === null
        ? noAttempt(input.spec.slug)
        : reviewOf(attempt, input.spec);
    },

    async comment(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      deps.plans.addComment({
        comment: {
          id: deps.nextId(),
          attempt_id: attempt.id,
          context_id: input.contextId,
          body: input.body,
          author_json: stableStringify(input.actor),
          created_at: deps.now(),
        },
        actor: input.actor,
      });
      const result = await reviewOf(attempt, input.spec);
      if (result.ok) publishPlanChange(input.spec, result.value, "commented");
      return result;
    },

    async reaffirmBatch(input) {
      if (input.actor.kind !== "human")
        return humanReaffirmation(input.spec.slug);
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      try {
        const reaffirmed = deps.plans.reaffirmDraftBatch({
          attemptId: attempt.id,
          expectedDraftRevision: input.expectedDraftRevision,
          criterionElementIds: input.criterionElementIds,
          reaffirmedAt: deps.now(),
          actor: input.actor,
        });
        const result = await reviewOf(reaffirmed, input.spec);
        if (result.ok) {
          logger.info("specs.delivery-plan.reaffirmed", {
            specId: input.spec.id,
            attemptId: reaffirmed.id,
            criterionCount: input.criterionElementIds.length,
          });
          publishPlanChange(input.spec, result.value, "reaffirmed");
        }
        return result;
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async diffSnapshots(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      const from = deps.plans.findSnapshotById(input.fromSnapshotId);
      const to = deps.plans.findSnapshotById(input.toSnapshotId);
      if (
        from === null ||
        to === null ||
        from.attempt_id !== attempt.id ||
        to.attempt_id !== attempt.id
      ) {
        return { ok: false, refusal: unknownSnapshots(input.spec.slug) };
      }
      const fromCandidate = deliveryPlanCandidateRecordSchema.parse(
        JSON.parse(from.content_json),
      );
      const toCandidate = deliveryPlanCandidateRecordSchema.parse(
        JSON.parse(to.content_json),
      );
      const diff: DeliveryPlanDocumentDiff = {
        launchChanged:
          fromCandidate.workflowDefinition.definitionHash !==
          toCandidate.workflowDefinition.definitionHash,
        bindingChanged: fromCandidate.bindingHash !== toCandidate.bindingHash,
      };
      return {
        ok: true,
        value: { from: snapshotView(from), to: snapshotView(to), diff },
      };
    },

    async preview(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return previewFailure(noAttempt(input.spec.slug));
      // A stated draft revision binds both stages: a caller reading the
      // finalized candidate for a state the attempt has left is looking at
      // something else, and being told so is what lets it re-read.
      if (
        input.expectedDraftRevision !== undefined &&
        input.expectedDraftRevision !== attempt.draft_revision
      ) {
        return previewFailure(
          stalePreview(input.spec.slug, attempt, input.expectedDraftRevision),
        );
      }
      if (input.stage === "draft") {
        if (attempt.status !== "draft")
          return previewFailure(notDraft(input.spec.slug, attempt));
        const document = deliveryPlanDocumentSchema.parse(
          JSON.parse(attempt.content_json),
        );
        const definition = await workingDefinition(attempt, input.spec);
        if (definition === null) {
          return {
            ok: false,
            refusal: invalidCandidate(
              input.spec.slug,
              "The managed workflow definition is missing.",
            ),
          };
        }
        return {
          ok: true,
          value: previewView({
            stage: "draft",
            attempt,
            spec: input.spec,
            document,
            launch: definition,
            candidate: null,
          }),
        };
      }
      const stored = storedCandidate(attempt, deps.plans);
      if (stored === null)
        return { ok: false, refusal: noCandidate(input.spec.slug) };
      const integrity = candidateIntegrityFailure(attempt, stored);
      if (integrity !== null)
        return {
          ok: false,
          refusal: invalidCandidate(input.spec.slug, integrity),
        };
      return {
        ok: true,
        value: {
          stage: "proposed",
          attemptId: attempt.id,
          specSlug: input.spec.slug,
          draftRevision: attempt.draft_revision,
          pinnedRevisionId: attempt.pinned_revision_id,
          candidateHash: stored.identity.candidateHash,
          snapshotId: stored.snapshot.id,
          candidateId: stored.identity.candidateId,
          approvable:
            attempt.status === "proposed" ||
            attempt.status === "approved" ||
            attempt.status === "parked",
          approvability: "This is the stored finalized launch envelope.",
          launch: await deps.managedDefinitions.getExact({
            projectPath: input.spec.projectPath,
            workflowDefinitionId: stored.record.workflowDefinition.id,
            revision: stored.record.workflowDefinition.revision,
            definitionHash: stored.record.workflowDefinition.definitionHash,
          }),
          binding: stored.record.binding,
        },
      };
    },

    async signOff(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      const upgrade = coverageUpgradeRefusal(attempt, input.spec.slug);
      if (upgrade !== null) return { ok: false, refusal: upgrade };
      if (attempt.workflow_definition_id === null) {
        return {
          ok: false,
          refusal: invalidCandidate(
            input.spec.slug,
            "The attempt has no managed workflow definition to sign off.",
          ),
        };
      }
      return deps.managedDefinitions.runExclusive(
        attempt.workflow_definition_id,
        async () => {
          const unsettled = await authoringBlocker(
            input.spec,
            attempt.pinned_revision_id,
          );
          if (unsettled) return { ok: false, refusal: unsettled };
          const candidate = statedCandidate(input);
          const stored = candidateIdentity(attempt);
          if (stored === null || !sameCandidate(candidate, stored))
            return staleCandidate(input.spec.slug, attempt, candidate, stored);
          const candidateSnapshot = storedCandidate(attempt, deps.plans);
          if (candidateSnapshot === null) {
            return { ok: false, refusal: noCandidate(input.spec.slug) };
          }
          const integrity = candidateIntegrityFailure(
            attempt,
            candidateSnapshot,
          );
          if (integrity !== null) {
            return {
              ok: false,
              refusal: invalidCandidate(input.spec.slug, integrity),
            };
          }
          try {
            await deps.managedDefinitions.getExact({
              projectPath: input.spec.projectPath,
              workflowDefinitionId:
                candidateSnapshot.record.workflowDefinition.id,
              revision: candidateSnapshot.record.workflowDefinition.revision,
              definitionHash:
                candidateSnapshot.record.workflowDefinition.definitionHash,
            });
          } catch (error) {
            return {
              ok: false,
              refusal: invalidCandidate(
                input.spec.slug,
                error instanceof Error ? error.message : String(error),
              ),
            };
          }
          const dial = resolveDial(input.spec.gatePolicy, "execution_start");
          if (dialRequiresHumanApproval(dial) && input.actor.kind !== "human")
            return humanSignoff(input.spec.slug);
          try {
            const outcome = deps.runInTransaction(() => {
              const approved = deps.plans.recordTransition({
                attemptId: attempt.id,
                transition: { kind: "approve", ...candidate },
                occurredAt: deps.now(),
                actor: input.actor,
              });
              const admission = admitExecutionStartForAttemptInTransaction(
                {
                  reviewRepo: deps.reviewRepo,
                  events: deps.events,
                  nextId: deps.nextId,
                },
                {
                  spec: input.spec,
                  pinnedRevisionId: approved.pinned_revision_id,
                  attemptId: approved.id,
                  candidate,
                  actor: input.actor,
                  approver: input.approver,
                  occurredAt: deps.now(),
                },
              );
              return { approved, admission };
            });
            deps.events.publishAfterCommit(outcome.admission.prepared);
            if (outcome.admission.notice !== null)
              deps.policyNotifier?.policyAdmitted(outcome.admission.notice);
            logAttemptTransition({
              slug: input.spec.slug,
              from: attempt.status,
              to: outcome.approved.status,
              actor: input.actor,
            });
            const view = await project(outcome.approved, input.spec);
            publishPlanChange(input.spec, view, "signed-off");
            return mutation(view, null, null, admissionView(outcome.admission));
          } catch (error) {
            return planFailure(error, input.spec.slug);
          }
        },
      );
    },

    async park(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      if (attempt.workflow_definition_id === null) {
        return {
          ok: false,
          refusal: invalidCandidate(
            input.spec.slug,
            "The attempt has no managed workflow definition to park.",
          ),
        };
      }
      return deps.managedDefinitions.runExclusive(
        attempt.workflow_definition_id,
        async () => {
          const candidate = statedCandidate(input);
          const stored = candidateIdentity(attempt);
          if (stored === null || !sameCandidate(candidate, stored))
            return staleCandidate(input.spec.slug, attempt, candidate, stored);
          try {
            const parked = deps.plans.recordTransition({
              attemptId: attempt.id,
              transition: { kind: "park", ...candidate, reason: input.reason },
              occurredAt: deps.now(),
              actor: input.actor,
            });
            logAttemptTransition({
              slug: input.spec.slug,
              from: attempt.status,
              to: parked.status,
              actor: input.actor,
            });
            const view = await project(parked, input.spec);
            publishPlanChange(input.spec, view, "parked");
            return mutation(view, null, null);
          } catch (error) {
            return planFailure(error, input.spec.slug);
          }
        },
      );
    },

    async resolveLaunch(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null)
        return { kind: "refused", refusal: noAttemptRefusal(input.spec.slug) };
      const upgrade = coverageUpgradeRefusal(attempt, input.spec.slug);
      if (upgrade !== null) return { kind: "refused", refusal: upgrade };
      if (attempt.workflow_definition_id === null) {
        return {
          kind: "refused",
          refusal: invalidCandidate(
            input.spec.slug,
            "The attempt has no managed workflow definition to launch.",
          ),
        };
      }
      return deps.managedDefinitions.runExclusive(
        attempt.workflow_definition_id,
        async () => {
          const unsettled = await authoringBlocker(
            input.spec,
            attempt.pinned_revision_id,
          );
          if (unsettled) {
            return { kind: "refused", refusal: unsettled };
          }
          const candidate = candidateIdentity(attempt);
          if (candidate === null)
            return { kind: "refused", refusal: noCandidate(input.spec.slug) };
          const approval = parseApproval(attempt);
          if (
            (attempt.status !== "approved" && attempt.status !== "parked") ||
            approval === null
          ) {
            return {
              kind: "unapproved",
              attemptId: attempt.id,
              candidate,
              refusal: notApproved(input.spec.slug, attempt),
            };
          }
          if (!sameCandidate(approval, candidate)) {
            return {
              kind: "refused",
              refusal: approvalIntegrityFailure(
                input.spec.slug,
                approval,
                candidate,
              ),
            };
          }
          const stored = storedCandidate(attempt, deps.plans);
          if (stored === null)
            return {
              kind: "refused",
              refusal: invalidCandidate(
                input.spec.slug,
                "The proposed snapshot does not contain a finalized candidate record.",
              ),
            };
          const integrity = candidateIntegrityFailure(attempt, stored);
          if (integrity !== null)
            return {
              kind: "refused",
              refusal: invalidCandidate(input.spec.slug, integrity),
            };
          try {
            await deps.managedDefinitions.getExact({
              projectPath: input.spec.projectPath,
              workflowDefinitionId: stored.record.workflowDefinition.id,
              revision: stored.record.workflowDefinition.revision,
              definitionHash: stored.record.workflowDefinition.definitionHash,
            });
          } catch (error) {
            return {
              kind: "refused",
              refusal: invalidCandidate(
                input.spec.slug,
                error instanceof Error ? error.message : String(error),
              ),
            };
          }
          const binding = stored.record.binding;
          return {
            kind: "ready",
            value: {
              attemptId: attempt.id,
              pinnedRevisionId: attempt.pinned_revision_id,
              launchRevision: attempt.draft_revision,
              candidate,
              candidateRecord: stored.record,
              candidateBytes: stored.candidateBytes,
              workflowDefinition: stored.record.workflowDefinition,
              binding,
              claims: deliveryPlanCandidateClaims(stored.record),
              scope: executionScopeFromDeliveryPlanBinding(binding),
              dispositions: binding.dispositions.map((disposition) => ({
                ...disposition,
                disposition: executionDispositionFromDeliveryPlan(
                  disposition.disposition,
                ),
              })),
            },
          };
        },
      );
    },

    async recordLaunch(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      if (attempt.workflow_definition_id === null) {
        return {
          ok: false,
          refusal: invalidCandidate(
            input.spec.slug,
            "The attempt has no managed workflow definition to launch.",
          ),
        };
      }
      return deps.managedDefinitions.runExclusive(
        attempt.workflow_definition_id,
        async () => {
          try {
            const launched = deps.plans.recordTransition({
              attemptId: attempt.id,
              transition: {
                kind: "launch",
                ...input.candidate,
                executionId: input.executionId,
              },
              occurredAt: deps.now(),
              actor: input.actor,
            });
            logAttemptTransition({
              slug: input.spec.slug,
              from: attempt.status,
              to: launched.status,
              actor: input.actor,
            });
            const view = await project(launched, input.spec);
            publishPlanChange(input.spec, view, "launched");
            return mutation(view, null, null);
          } catch (error) {
            return planFailure(error, input.spec.slug);
          }
        },
      );
    },

    /**
     * The prelaunch exit (command-center#92): a never-launched attempt pinned
     * to a revision the spec has amended past can neither be re-pinned (the
     * pin is immutable by design) nor launched honestly, and it blocks a
     * replacement `open` forever. Retiring it is the escape that lets a fresh
     * attempt pin the current approved revision. A launched attempt is owned
     * by its execution, so its retirement stays with the post-launch paths.
     */
    async abandonPrelaunch(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      if (attempt.status === "launched") {
        const workflowExecutionId =
          attempt.launched_execution_id === null
            ? null
            : deps.launchedWorkflowExecutionId(attempt.launched_execution_id);
        return {
          ok: false,
          refusal: {
            code: "plan_status_conflict",
            unmetConditions: [
              `Attempt ${attempt.id} launched execution ${workflowExecutionId ?? "unknown"}; a launched attempt is retired through its run, not from prelaunch.`,
            ],
            instruction: postLaunchPathsSentence({
              slug: input.spec.slug,
              workflowExecutionId: workflowExecutionId ?? "unknown",
            }),
          },
        };
      }
      if (attempt.workflow_definition_id === null) {
        return {
          ok: false,
          refusal: invalidCandidate(
            input.spec.slug,
            "The managed workflow definition is missing.",
          ),
        };
      }
      return deps.managedDefinitions.runExclusive(
        attempt.workflow_definition_id,
        async () => {
          try {
            const abandoned = deps.plans.recordTransition({
              attemptId: attempt.id,
              transition: { kind: "abandon", reason: input.reason },
              occurredAt: deps.now(),
              actor: input.actor,
            });
            logger.info("specs.delivery-plan.abandoned", {
              specId: input.spec.id,
              attemptId: abandoned.id,
              executionId: null,
            });
            logAttemptTransition({
              slug: input.spec.slug,
              from: attempt.status,
              to: abandoned.status,
              actor: input.actor,
            });
            publishPlanChange(
              input.spec,
              await project(abandoned, input.spec),
              "abandoned",
            );
            return { ok: true, value: { attemptId: abandoned.id } };
          } catch (error) {
            return planFailure(error, input.spec.slug);
          }
        },
      );
    },

    /**
     * Retiring the attempt an execution launched is idempotent, and it looks
     * the attempt up by the execution it owns rather than by "whatever is live
     * now": the abandon coordinator can be re-entered after a faulted phase,
     * and by then a replacement attempt may already be open. A second call
     * therefore reports the retirement that already happened instead of
     * recording a second `abandon` transition against the same run.
     */
    async abandonLaunch(input) {
      const attempt =
        deps.plans
          .findAttemptsBySpecId(input.spec.id)
          .find(
            (candidate) =>
              candidate.launched_execution_id === input.executionId,
          ) ?? null;
      if (attempt === null) return noAttempt(input.spec.slug);
      if (attempt.status === "abandoned") {
        return { ok: true, value: { attemptId: attempt.id } };
      }
      if (attempt.workflow_definition_id === null) {
        return {
          ok: false,
          refusal: invalidCandidate(
            input.spec.slug,
            "The launched attempt has no managed workflow definition.",
          ),
        };
      }
      if (attempt.status !== "launched") {
        return {
          ok: false,
          refusal: {
            code: "plan_status_conflict",
            unmetConditions: [
              // Named by status rather than by `input.executionId`: that is
              // the internal spec execution row id, which no agent surface
              // states (design 3.5, D-B).
              `Attempt ${attempt.id} is ${attempt.status}, so it owns no launched run to retire.`,
            ],
            instruction: `Read the active attempt with \`cctl spec plan status ${input.spec.slug}\`.`,
          },
        };
      }
      return deps.managedDefinitions.runExclusive(
        attempt.workflow_definition_id,
        async () => {
          try {
            const abandoned = deps.plans.recordTransition({
              attemptId: attempt.id,
              transition: { kind: "abandon", reason: input.reason },
              occurredAt: deps.now(),
              actor: input.actor,
            });
            logger.info("specs.delivery-plan.abandoned", {
              specId: input.spec.id,
              attemptId: abandoned.id,
              executionId: input.executionId,
            });
            logAttemptTransition({
              slug: input.spec.slug,
              from: attempt.status,
              to: abandoned.status,
              actor: input.actor,
            });
            publishPlanChange(
              input.spec,
              await project(abandoned, input.spec),
              "abandoned",
            );
            return { ok: true, value: { attemptId: abandoned.id } };
          } catch (error) {
            return planFailure(error, input.spec.slug);
          }
        },
      );
    },
  };
}

function mutation(
  view: DeliveryPlanView,
  previousHealth: { total: number; blocking: number } | null,
  invalidatedApproval: { snapshotId: string; candidateHash: string } | null,
  executionStartAdmission: DeliveryPlanMutationView["executionStartAdmission"] = null,
): PlanResult<DeliveryPlanMutationView> {
  return {
    ok: true,
    value: {
      ...view,
      previousHealth,
      invalidatedApproval,
      executionStartAdmission,
    },
  };
}

/**
 * The shared severity reading every lint surface uses, applied to the plan's
 * own findings — so a plan panel ranks and counts the way a spec lint panel
 * does.
 */
function healthView(
  health: DeliveryPlanDraftHealth,
): DeliveryPlanView["health"] {
  const summary = draftHealth([...health.findings]);
  return {
    total: summary.total,
    blocking: summary.blocking,
    counts: [...summary.counts],
    findings: [...summary.ordered],
  };
}

/**
 * One `spec.plan.attempt.transition` line per recorded act (#80 design 3.10).
 * Only the actor's KIND travels: a name or a conversation handle would be
 * content, and this event exists to count acts, not to identify people.
 */
function logAttemptTransition(input: {
  slug: string;
  from: DeliveryPlanAttemptOrigin;
  to: DeliveryPlanAttemptStatus;
  actor: ActorProvenance;
}): void {
  const telemetry = specPlanAttemptTransitionEvent({
    slug: input.slug,
    from: input.from,
    to: input.to,
    actor: input.actor.kind,
  });
  logger.info(telemetry.event, telemetry.fields);
}

function healthTotals(health: DeliveryPlanDraftHealth): {
  total: number;
  blocking: number;
} {
  const summary = draftHealth([...health.findings]);
  return { total: summary.total, blocking: summary.blocking };
}

function parseApproval(
  attempt: SpecDeliveryPlanAttemptRow,
): FinalizedDeliveryPlanApproval | null {
  return attempt.approval_json === null
    ? null
    : finalizedDeliveryPlanApprovalSchema.parse(
        JSON.parse(attempt.approval_json),
      );
}
function parsePrelaunch(
  attempt: SpecDeliveryPlanAttemptRow,
): FinalizedDeliveryPlanPrelaunch | null {
  return attempt.prelaunch_json === null
    ? null
    : finalizedDeliveryPlanPrelaunchSchema.parse(
        JSON.parse(attempt.prelaunch_json),
      );
}
function snapshotView(
  snapshot: SpecDeliveryPlanSnapshotRow,
): DeliveryPlanSnapshotView {
  if (snapshot.candidate_id === null || snapshot.candidate_hash === null) {
    throw new Error(
      `Delivery plan snapshot ${snapshot.id} has no finalized candidate identity.`,
    );
  }
  return {
    id: snapshot.id,
    draftRevision: snapshot.draft_revision,
    candidateId: snapshot.candidate_id,
    candidateHash: snapshot.candidate_hash,
    proposedAt: snapshot.proposed_at,
  };
}
function dispositionCounts(
  binding: DeliveryPlanBinding,
): DeliveryPlanView["dispositionCounts"] {
  const counts = new Map<
    DeliveryPlanBinding["dispositions"][number]["disposition"],
    number
  >();
  for (const item of binding.dispositions)
    counts.set(item.disposition, (counts.get(item.disposition) ?? 0) + 1);
  return [...counts]
    .map(([disposition, count]) => ({ disposition, count }))
    .sort((a, b) => a.disposition.localeCompare(b.disposition));
}
function executionScopeFromDeliveryPlanBinding(
  binding: DeliveryPlanBinding,
): ExecutionScope {
  return {
    selectedTaskIds: [],
    selectedCriterionIds: binding.dispositions
      .filter((entry) => entry.disposition === "in_scope")
      .map((entry) => entry.criterionElementId),
    exclusionDispositions: binding.dispositions.flatMap((entry) =>
      entry.disposition === "in_scope"
        ? []
        : [
            {
              criterionId: entry.criterionElementId,
              disposition: exclusionDispositionFromDeliveryPlan(
                entry.disposition,
              ),
            },
          ],
    ),
  };
}
function nextAct(
  attempt: SpecDeliveryPlanAttemptRow,
  spec: Spec,
): DeliveryPlanNextAct {
  const upgrade = coverageUpgradeRefusal(attempt, spec.slug);
  if (upgrade !== null)
    return {
      actor: "agent",
      command: `cctl spec plan reopen ${spec.slug} --reason <why>`,
      reason: upgrade.unmetConditions.join(" "),
    };
  return deliveryPlanNextAct({
    status: attempt.status,
    specSlug: spec.slug,
    workflowDefinitionId: attempt.workflow_definition_id ?? attempt.id,
    signOffRequiresHuman: dialRequiresHumanApproval(
      resolveDial(spec.gatePolicy, "execution_start"),
    ),
    parkedApproved: parseApproval(attempt) !== null,
  });
}
interface StoredDeliveryPlanCandidate {
  readonly snapshot: SpecDeliveryPlanSnapshotRow;
  readonly identity: FinalizedDeliveryPlanCandidateIdentity;
  readonly record: DeliveryPlanCandidateRecord;
  readonly candidateBytes: string;
}
function storedCandidate(
  attempt: SpecDeliveryPlanAttemptRow,
  plans: SpecDeliveryPlanRepo,
): StoredDeliveryPlanCandidate | null {
  if (attempt.proposed_snapshot_id === null) return null;
  const snapshot = plans.findSnapshotById(attempt.proposed_snapshot_id);
  if (
    snapshot === null ||
    snapshot.candidate_id === null ||
    snapshot.candidate_hash === null
  )
    return null;
  try {
    const raw = JSON.parse(snapshot.content_json) as unknown;
    const parsed = deliveryPlanCandidateRecordSchema.safeParse(raw);
    if (!parsed.success) return null;
    if (stableStringify(raw) !== stableStringify(parsed.data)) return null;
    return {
      snapshot,
      identity: {
        candidateId: snapshot.candidate_id,
        candidateHash: snapshot.candidate_hash,
      },
      record: raw as DeliveryPlanCandidateRecord,
      candidateBytes: snapshot.content_json,
    };
  } catch {
    return null;
  }
}
function candidateRecord(
  attempt: SpecDeliveryPlanAttemptRow,
  plans: SpecDeliveryPlanRepo,
): DeliveryPlanCandidateRecord | null {
  return storedCandidate(attempt, plans)?.record ?? null;
}
function candidateIntegrityFailure(
  attempt: SpecDeliveryPlanAttemptRow,
  stored: StoredDeliveryPlanCandidate,
): string | null {
  const { record, identity, snapshot } = stored;
  if (record.specId !== attempt.spec_id)
    return `Candidate ${record.candidateId} names spec ${record.specId}, not ${attempt.spec_id}.`;
  if (record.attemptId !== attempt.id)
    return `Candidate ${record.candidateId} names attempt ${record.attemptId}, not ${attempt.id}.`;
  if (record.candidateId !== identity.candidateId)
    return `Snapshot ${snapshot.id} names candidate ${identity.candidateId}, but its bytes name ${record.candidateId}.`;
  if (record.pinnedRevisionId !== attempt.pinned_revision_id)
    return `Candidate ${record.candidateId} pins ${record.pinnedRevisionId}, not ${attempt.pinned_revision_id}.`;
  if (record.draftRevision !== snapshot.draft_revision)
    return `Candidate ${record.candidateId} names draft revision ${record.draftRevision}, not ${snapshot.draft_revision}.`;
  if (
    snapshot.workflow_definition_id !== record.workflowDefinition.id ||
    snapshot.workflow_definition_revision !==
      record.workflowDefinition.revision ||
    snapshot.workflow_definition_hash !==
      record.workflowDefinition.definitionHash
  ) {
    return `Snapshot ${snapshot.id} workflow-definition identity does not match its manifest.`;
  }
  if (deliveryPlanBindingHash(record.binding) !== record.bindingHash) {
    return `Candidate ${record.candidateId} binding hash does not match its binding bytes.`;
  }
  const actualHash = deliveryPlanCandidateHashFromBytes(stored.candidateBytes);
  return actualHash === identity.candidateHash
    ? null
    : `Candidate ${identity.candidateId} stores ${identity.candidateHash}, but its canonical bytes hash to ${actualHash}.`;
}
function sameCandidate(
  left: FinalizedDeliveryPlanCandidateIdentity,
  right: FinalizedDeliveryPlanCandidateIdentity,
): boolean {
  return (
    left.candidateId === right.candidateId &&
    left.candidateHash === right.candidateHash
  );
}
function statedCandidate(
  input: FinalizedDeliveryPlanCandidateIdentity,
): FinalizedDeliveryPlanCandidateIdentity {
  return { candidateId: input.candidateId, candidateHash: input.candidateHash };
}
function admissionView(
  admission: DeliveryPlanExecutionStartAdmission,
): NonNullable<DeliveryPlanMutationView["executionStartAdmission"]> {
  return {
    dial: admission.dial,
    basis: admission.basis,
    admissionId: admission.admissionId,
    approvalId: admission.approvalId,
  };
}
function previewView(input: {
  stage: "draft";
  attempt: SpecDeliveryPlanAttemptRow;
  spec: Spec;
  document: DeliveryPlanDocument;
  launch: WorkflowDefinitionDraft;
  candidate: null;
}): DeliveryPlanPreviewView {
  return {
    stage: input.stage,
    attemptId: input.attempt.id,
    specSlug: input.spec.slug,
    draftRevision: input.attempt.draft_revision,
    pinnedRevisionId: input.attempt.pinned_revision_id,
    candidateHash: null,
    snapshotId: null,
    candidateId: null,
    approvable: false,
    approvability: "Draft bytes must be proposed before approval.",
    launch: input.launch,
    binding: input.document.binding,
  };
}
function initialDocumentForOpen(
  spec: Spec,
  pinnedRevision: SpecRevisionSnapshot,
): SeededDeliveryPlanDraft {
  return {
    launch: {
      name: `${spec.name} delivery launch`,
      description: null,
      definition: {
        schemaVersion: 1,
        workflowConfig: {},
        charter: {
          mission: renderSeededDeliveryPlanMission({ pinnedRevision }),
          sourcesOfTruth: seededDeliveryPlanCharterSources(spec.slug),
        },
        executionContexts: [],
        tasks: [],
        edges: [],
        parameters: [],
        prerequisites: [],
      },
      layout: {
        workflowId: `delivery-plan-${spec.slug}`,
        contextPositions: {},
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
    binding: {
      dispositions: pinnedRevision.elements.flatMap(({ element, version }) =>
        version.payload.kind !== "criterion"
          ? []
          : [
              {
                criterionElementId: element.id,
                disposition: "in_scope" as const,
                deliveredByExecutionId: null,
              },
            ],
      ),
    },
  };
}
/**
 * The authored launch comes from the last finalized candidate; the dispositions
 * do not. They are derived from the delivery delta, so a criterion the previous
 * run actually delivered leaves scope on the evidence rather than on the
 * previous author's word.
 */
async function seededDocumentForOpen(
  plans: SpecDeliveryPlanRepo,
  managedDefinitions: ManagedWorkflowDefinitionService,
  spec: Spec,
  pinnedRevision: SpecRevisionSnapshot,
  basis: DeliveryPlanSeedBasis,
): Promise<PlanResult<SeededDeliveryPlanDraft>> {
  const source = [...plans.findAttemptsBySpecId(spec.id)]
    .reverse()
    .map((attempt) => storedCandidate(attempt, plans))
    .find((candidate) => candidate !== null);
  if (source === undefined) return noSeedCandidate(spec.slug);
  try {
    const definition = await managedDefinitions.getExact({
      projectPath: spec.projectPath,
      workflowDefinitionId: source.record.workflowDefinition.id,
      revision: source.record.workflowDefinition.revision,
      definitionHash: source.record.workflowDefinition.definitionHash,
    });
    return {
      ok: true,
      value: seedDeliveryPlanFromLast({
        source: {
          candidateId: source.identity.candidateId,
          launch: definition,
          binding: source.record.binding,
        },
        dispositions: seedDispositionsFromDelivery({
          basis,
          pinnedCriterionElementIds: pinnedCriterionIds(pinnedRevision),
        }),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      refusal: {
        code: "integrity_mismatch",
        unmetConditions: [
          error instanceof Error ? error.message : String(error),
        ],
        instruction: `Open an unseeded attempt with \`cctl spec plan open ${spec.slug}\` and settle the dispositions in Spec Studio.`,
      },
    };
  }
}

function pinnedCriterionIds(
  pinnedRevision: SpecRevisionSnapshot,
): readonly string[] {
  return pinnedRevision.elements.flatMap(({ element, version }) =>
    version.payload.kind === "criterion" ? [element.id] : [],
  );
}
function noAttempt(slug: string): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "not_found",
      unmetConditions: ["No delivery-plan attempt is open."],
      instruction: `Open one with \`cctl spec plan open ${slug}\`.`,
    },
  };
}
function liveAttemptAlreadyOpen(slug: string): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "plan_status_conflict",
      unmetConditions: ["A delivery-plan attempt is already open."],
      instruction: `Read it with \`cctl spec plan status ${slug}\`; reopen the candidate with \`cctl spec plan reopen ${slug} --reason <why>\` when a new draft is needed, or retire a never-launched attempt with \`cctl spec plan abandon ${slug} --reason <why>\` so a fresh open pins the current approved revision.`,
    },
  };
}
function noApprovedRevision(slug: string): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "gate_blocked",
      unmetConditions: ["A delivery plan must pin an approved spec revision."],
      instruction: `Propose and sign off the current spec revision with \`cctl spec propose ${slug}\` before opening a delivery plan.`,
    },
  };
}
function noSeedCandidate(slug: string): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "not_found",
      unmetConditions: [
        "No finalized direct candidate is available to seed from.",
      ],
      instruction: `Open an authored draft with \`cctl spec plan open ${slug}\`, then provide the complete launch with \`cctl workflow replace <definitionId> --file <plan.json>\`.`,
    },
  };
}
function noAttemptRefusal(slug: string): Refusal {
  return {
    code: "not_found",
    unmetConditions: ["No delivery-plan attempt is open."],
    instruction: `Open one with \`cctl spec plan open ${slug}\`.`,
  };
}
function previewFailure(
  result: PlanResult<never>,
): PlanResult<DeliveryPlanPreviewView> {
  if (!result.ok) return { ok: false, refusal: result.refusal };
  throw new Error("Expected a delivery-plan refusal.");
}
function noCandidate(slug: string): Refusal {
  return {
    code: "plan_status_conflict",
    unmetConditions: ["The plan has no finalized candidate."],
    instruction: `Propose the authored launch with \`cctl spec plan propose ${slug}\`.`,
  };
}
function notDraft(
  slug: string,
  attempt: SpecDeliveryPlanAttemptRow,
): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "plan_status_conflict",
      unmetConditions: [
        `Attempt ${attempt.id} is ${attempt.status}, not draft.`,
      ],
      instruction: `Read the finalized candidate with \`cctl spec plan preview ${slug} --stage proposed\`.`,
    },
  };
}
function stalePreview(
  slug: string,
  attempt: SpecDeliveryPlanAttemptRow,
  expected: number,
): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "stale_plan_draft",
      unmetConditions: [
        `Attempt ${attempt.id} is draft revision ${attempt.draft_revision}, not ${expected}.`,
      ],
      instruction: `Re-read \`cctl spec plan status ${slug}\` and retry.`,
    },
  };
}
function unknownSnapshots(slug: string): Refusal {
  return {
    code: "not_found",
    unmetConditions: [
      "One or both snapshots do not belong to the live attempt.",
    ],
    instruction: `Read the attempt snapshots with \`cctl spec plan status ${slug}\`.`,
  };
}
function invalidCandidate(
  slug: string,
  detail = "The stored candidate is not a valid finalized launch and binding envelope.",
): Refusal {
  return {
    code: "integrity_mismatch",
    unmetConditions: [detail],
    instruction: `Reopen and propose a new candidate with \`cctl spec plan reopen ${slug}\`.`,
  };
}
function approvalIntegrityFailure(
  slug: string,
  approval: FinalizedDeliveryPlanApproval,
  candidate: FinalizedDeliveryPlanCandidateIdentity,
): Refusal {
  return {
    code: "integrity_mismatch",
    unmetConditions: [
      `The stored approval names candidate ${approval.candidateId} at ${approval.candidateHash}, but the proposed snapshot names ${candidate.candidateId} at ${candidate.candidateHash}.`,
    ],
    instruction: `Nothing was started. Reopen and propose a new candidate with \`cctl spec plan reopen ${slug}\`.`,
  };
}
function notApproved(
  slug: string,
  attempt: SpecDeliveryPlanAttemptRow,
): Refusal {
  return {
    code: "gate_blocked",
    unmetConditions: [
      `Attempt ${attempt.id} is ${attempt.status} and not signed off.`,
    ],
    instruction: `Sign the candidate with \`cctl spec plan sign-off ${slug}\`.`,
  };
}
function staleCandidate(
  slug: string,
  attempt: SpecDeliveryPlanAttemptRow,
  stated: FinalizedDeliveryPlanCandidateIdentity,
  stored: FinalizedDeliveryPlanCandidateIdentity | null,
): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "plan_status_conflict",
      unmetConditions: [
        `Attempt ${attempt.id} no longer carries stated candidate ${stated.candidateId} at ${stated.candidateHash}.`,
        `Current candidate: ${stored === null ? "none" : `${stored.candidateId} at ${stored.candidateHash}`}.`,
      ],
      instruction: `Re-read \`cctl spec plan status ${slug}\` and use its identity.`,
    },
  };
}
function humanSignoff(slug: string): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "human_act_required",
      unmetConditions: [
        "The execution-start policy requires a human sign-off.",
      ],
      rationale: HUMAN_ACT_REQUIRED_RATIONALE,
      instruction: `Sign off the candidate in Spec Studio before starting ${slug}.`,
    },
  };
}
function humanReaffirmation(slug: string): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "human_act_required",
      unmetConditions: [
        "A pending reaffirmation must be confirmed by a human.",
      ],
      rationale: HUMAN_ACT_REQUIRED_RATIONALE,
      instruction: `Reaffirm the criterion in Spec Studio, then re-read \`cctl spec plan status ${slug}\`.`,
    },
  };
}
function admissionRefusal(
  slug: string,
  conditions: readonly string[],
): Refusal {
  return {
    code: "validation",
    unmetConditions: [...conditions],
    instruction: `Correct the graph launch for ${slug} with \`cctl workflow replace <definitionId> --file <plan.json>\`.`,
  };
}
function seededOpenAdmissionRefusal(
  slug: string,
  conditions: readonly string[],
): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "validation",
      unmetConditions: [...conditions],
      instruction: `Open an unseeded attempt with \`cctl spec plan open ${slug}\`, then correct the graph launch in \`cctl workflow replace <definitionId> --file <plan.json>\`.`,
    },
  };
}
function unreadableDeliveryBasis(
  slug: string,
  message: string,
): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "not_found",
      unmetConditions: [message],
      instruction: `Read what the next plan is measured against with \`cctl spec delta ${slug}\`, then open the attempt again.`,
    },
  };
}
/**
 * A compare-and-swap loss is its own refusal: the caller acted on bytes that
 * moved, and the recovery is a re-read and one retry rather than a state
 * correction.
 */
function planFailure(error: unknown, slug: string): PlanResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof StaleDeliveryPlanDraftError
    ? {
        ok: false,
        refusal: {
          code: "stale_plan_draft",
          unmetConditions: [message],
          instruction: `Re-read \`cctl spec plan status ${slug}\` and retry at the draft revision it reports.`,
        },
      }
    : {
        ok: false,
        refusal: {
          code: "plan_status_conflict",
          unmetConditions: [message],
          instruction: `Read \`cctl spec plan status ${slug}\` and correct the attempt state.`,
        },
      };
}
