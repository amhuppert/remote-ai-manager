import { createLogger } from "@/lib/logging";
import { stableStringify } from "@/lib/state-store/serialization";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  StaleDeliveryPlanDraftError,
  type SpecDeliveryPlanRepo,
} from "@/lib/state-store/spec-delivery-plan-repo";
import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";
import type { AuthoredAccountabilityCoverageGroup } from "@/lib/workflow-graph/spec-bridge";
import {
  type WorkflowDefinitionDraft,
  type WorkflowDefinitionMutation,
} from "@/lib/workflow-graph/definition-schemas";

import {
  canonicalDeliveryPlanEnvelopeBytes,
  deliveryPlanAttemptBlocksReplacement,
  deliveryPlanCandidateRecordSchema,
  deliveryPlanDocumentSchema,
  exclusionDispositionFromDeliveryPlan,
  executionDispositionFromDeliveryPlan,
  finalizedDeliveryPlanApprovalSchema,
  finalizedDeliveryPlanPrelaunchSchema,
  liveDeliveryPlanAttempt,
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
import { deliveryPlanBindingAccountabilityGroups } from "./delivery-plan-binding-lint";
import {
  deliveryPlanCandidateHash,
  deliveryPlanCandidateHashFromBytes,
} from "./delivery-plan-hash";
import type { SpecEventsPublisher } from "./events";
import { dialRequiresHumanApproval, resolveDial } from "./policy";
import type { SpecPolicyAdmissionNotifier } from "./policy-admissions";
import {
  deliveryPlanDocumentDiff,
  type DeliveryPlanDocumentDiff,
} from "./delivery-plan-diff";
import {
  finalizeAndAdmitDeliveryPlanLaunch,
  finalizeDeliveryPlanLaunch,
} from "./delivery-plan-finalization";
import {
  projectDeliveryPlanDraftHealth,
  type DeliveryPlanDraftHealth,
} from "./delivery-plan-health";
import {
  seedDeliveryPlanFromLast,
  seedDispositionsFromDelivery,
  type DeliveryPlanSeedBasis,
  type DeliveryPlanSeedBasisResult,
} from "./delivery-plan-seed";
import { draftHealth } from "./draft-health";
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
  Refusal,
  Spec,
  SpecDeliveryPlanAttemptRow,
  SpecDeliveryPlanSnapshotRow,
  SpecCriterionDisposition,
  SpecExecutionState,
  SpecRevisionSnapshot,
} from "./schemas";
import type { ExecutionScope } from "./scope-validation";

const logger = createLogger("specs.delivery-plan");

export interface DeliveryPlanServiceDeps {
  plans: SpecDeliveryPlanRepo;
  reviewRepo: Pick<SpecReviewRepo, "saveApproval" | "insertGateAdmission">;
  events: SpecEventsPublisher;
  policyNotifier?: SpecPolicyAdmissionNotifier;
  runInTransaction<T>(operation: () => T): T;
  currentApprovedRevision(specId: string): Promise<SpecRevisionSnapshot | null>;
  revisionSnapshot(revisionId: string): Promise<SpecRevisionSnapshot | null>;
  /**
   * The delivery a new attempt is measured against, read from the delivery
   * delta at open time. Every attempt records the execution it was measured
   * against; `--seed-from last` also derives its dispositions from it.
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
  admitLaunch(input: {
    spec: Spec;
    launch: WorkflowDefinitionMutation;
    accountabilityGroups: readonly AuthoredAccountabilityCoverageGroup[];
  }): Promise<AuthoredWorkflowLaunchAdmissionResult>;
  nextId(): string;
  now(): string;
}

export type PlanResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: Refusal };

export interface OpenDeliveryPlanInput {
  spec: Spec;
  seedFromLast: boolean;
  actor: ActorProvenance;
}
export interface EditDeliveryPlanInput {
  spec: Spec;
  expectedDraftRevision: number;
  document: DeliveryPlanDocument;
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
export interface ReaffirmDeliveryPlanCriterionInput {
  spec: Spec;
  /**
   * The draft revision the caller reviewed. A reaffirmation is a human judgment
   * about specific bytes, so it refuses rather than lands on a draft that moved
   * between the read and the click.
   */
  expectedDraftRevision: number;
  criterionElementId: string;
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
  launch: WorkflowDefinitionDraft;
  binding: DeliveryPlanBinding;
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
  review(input: { spec: Spec }): Promise<PlanResult<DeliveryPlanReviewView>>;
  comment(
    input: CommentOnDeliveryPlanInput,
  ): Promise<PlanResult<DeliveryPlanReviewView>>;
  reaffirm(
    input: ReaffirmDeliveryPlanCriterionInput,
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
  ): Promise<DeliveryPlanDraftHealth> {
    if (attempt.status !== "draft") {
      return { findings: [], unresolved: [], refusalConditions: [] };
    }
    const pinnedRevision = await deps.revisionSnapshot(
      attempt.pinned_revision_id,
    );
    if (pinnedRevision === null) {
      const message = `Pinned revision ${attempt.pinned_revision_id} is unavailable, so this draft cannot be judged against the criteria it must dispose.`;
      return {
        findings: [
          {
            ruleId: "plan/pinned-revision-unavailable",
            severity: "blocks_propose",
            elementHandle: attempt.pinned_revision_id,
            message,
          },
        ],
        unresolved: [],
        refusalConditions: [message],
      };
    }
    return projectDeliveryPlanDraftHealth({
      pinnedRevision,
      binding: document.binding,
      admission: await deps.admitLaunch({
        spec,
        // The health projection admits exactly the shape proposal will admit.
        // The candidate id reaches only the claims-source locator, so the
        // attempt id stands in for the id proposal allocates: reading a draft
        // never invents a candidate identity.
        launch: finalizeDeliveryPlanLaunch({
          specId: spec.id,
          specSlug: spec.slug,
          attemptId: attempt.id,
          candidateId: attempt.id,
          launch: document.launch,
        }),
        accountabilityGroups: deliveryPlanBindingAccountabilityGroups(
          document.binding,
        ),
      }),
    });
  }

  async function project(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
  ): Promise<DeliveryPlanView> {
    const candidate = candidateIdentity(attempt);
    const frozenCandidate = candidateRecord(attempt, deps.plans);
    const document =
      frozenCandidate?.document ??
      deliveryPlanDocumentSchema.parse(JSON.parse(attempt.content_json));
    const approval = parseApproval(attempt);
    const current = candidate;
    const prelaunch = parsePrelaunch(attempt);
    const health = await healthOf(attempt, spec, document);
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
      health: healthView(health),
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

  return {
    async open(input) {
      const blocking = liveAttempt(input.spec.id);
      if (blocking !== null && blocksReplacement(blocking)) {
        return liveAttemptAlreadyOpen(input.spec.slug);
      }
      const pinnedRevision = await deps.currentApprovedRevision(input.spec.id);
      if (pinnedRevision === null) return noApprovedRevision(input.spec.slug);
      const basis = await deps.lastDeliveryBasis({
        spec: input.spec,
        pinnedRevision,
      });
      if (!basis.ok)
        return unreadableDeliveryBasis(input.spec.slug, basis.message);
      const document = input.seedFromLast
        ? seededDocumentForOpen(
            deps.plans,
            input.spec,
            pinnedRevision,
            basis.basis,
          )
        : {
            ok: true as const,
            value: initialDocumentForOpen(input.spec, pinnedRevision),
          };
      if (!document.ok) return document;
      const occurredAt = deps.now();
      try {
        const opened = deps.plans.open({
          attempt: {
            id: deps.nextId(),
            spec_id: input.spec.id,
            pinned_revision_id: pinnedRevision.revision.id,
            delta_basis_execution_id: basis.basis.comparedExecutionId,
            status: "draft",
            draft_revision: 1,
            content_json: canonicalDeliveryPlanEnvelopeBytes(document.value),
            proposed_snapshot_id: null,
            approval_json: null,
            prelaunch_json: null,
            launched_execution_id: null,
            created_at: occurredAt,
            updated_at: occurredAt,
          },
          occurredAt,
          actor: input.actor,
        });
        const view = await project(opened, input.spec);
        logger.info("specs.delivery-plan.opened", {
          specId: input.spec.id,
          attemptId: opened.id,
          seedFromLast: input.seedFromLast,
          deltaBasisExecutionId: basis.basis.comparedExecutionId,
          blockingFindingCount: view.health.blocking,
        });
        publishPlanChange(input.spec, view, "opened");
        return mutation(view, null, null);
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async edit(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      // Read before the write: the receipt reports the blocking count the edit
      // moved from, which is what makes a partial correction legible.
      const before = await healthOf(
        attempt,
        input.spec,
        deliveryPlanDocumentSchema.parse(JSON.parse(attempt.content_json)),
      );
      try {
        const edited = deps.plans.saveDraft({
          attemptId: attempt.id,
          expectedDraftRevision: input.expectedDraftRevision,
          document: input.document,
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
      const document = deliveryPlanDocumentSchema.parse(
        JSON.parse(attempt.content_json),
      );
      const pinnedRevision = await deps.revisionSnapshot(
        attempt.pinned_revision_id,
      );
      if (pinnedRevision === null) {
        return {
          ok: false,
          refusal: {
            code: "not_found",
            unmetConditions: [
              `Pinned revision ${attempt.pinned_revision_id} is unavailable.`,
            ],
            instruction: `Open a fresh attempt for ${input.spec.slug}.`,
          },
        };
      }
      const finalized = await finalizeAndAdmitDeliveryPlanLaunch(
        {
          specId: input.spec.id,
          specSlug: input.spec.slug,
          attemptId: attempt.id,
          launch: document.launch,
        },
        {
          allocateCandidateId: deps.nextId,
          admitLaunch: (launch) =>
            deps.admitLaunch({
              spec: input.spec,
              launch,
              accountabilityGroups: deliveryPlanBindingAccountabilityGroups(
                document.binding,
              ),
            }),
        },
      );
      const admitted = finalized.admission;
      // The refusal and `plan status` read the same projection, so a draft that
      // reads proposable cannot refuse here and a refusal always shows up on
      // the next status.
      const health = projectDeliveryPlanDraftHealth({
        pinnedRevision,
        binding: document.binding,
        admission: admitted,
      });
      if (!admitted.ok) {
        return admissionRefusal(input.spec.slug, health.refusalConditions);
      }
      if (health.refusalConditions.length > 0) {
        logger.info("specs.delivery-plan.binding_lint_refused", {
          specId: input.spec.id,
          attemptId: attempt.id,
          candidateId: finalized.candidateId,
          issueCount: health.refusalConditions.length,
        });
        return {
          ok: false,
          refusal: {
            code: "lint_blocked",
            unmetConditions: [...health.refusalConditions],
            instruction: `Correct the immutable binding in \`cctl spec plan edit ${input.spec.slug} --file <plan.json>\`, then propose again.`,
          },
        };
      }
      const candidateRecord: DeliveryPlanCandidateRecord = {
        protocol: "native-sdd-delivery-candidate/v2",
        schemaVersion: 2,
        specId: input.spec.id,
        attemptId: attempt.id,
        candidateId: finalized.candidateId,
        pinnedRevisionId: attempt.pinned_revision_id,
        draftRevision: attempt.draft_revision,
        document: {
          schemaVersion: 2,
          launch: admitted.launch,
          binding: document.binding,
        },
      };
      const candidateHash = deliveryPlanCandidateHash(candidateRecord);
      try {
        const proposed = deps.plans.propose({
          attemptId: attempt.id,
          expectedDraftRevision: attempt.draft_revision,
          snapshotId: deps.nextId(),
          proposedAt: deps.now(),
          actor: input.actor,
          candidate: { record: candidateRecord, candidateHash },
        });
        logger.info("specs.delivery-plan.proposed", {
          specId: input.spec.id,
          attemptId: attempt.id,
          candidateId: candidateRecord.candidateId,
          candidateHash,
        });
        const view = await project(proposed.attempt, input.spec);
        publishPlanChange(input.spec, view, "proposed");
        return mutation(view, healthTotals(health), null);
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async reopen(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      try {
        const reopened = deps.plans.reopen({
          attemptId: attempt.id,
          reopenedAt: deps.now(),
          actor: input.actor,
          reason: input.reason,
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

    async reaffirm(input) {
      if (input.actor.kind !== "human")
        return humanReaffirmation(input.spec.slug);
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      try {
        const reaffirmed = deps.plans.reaffirmDraft({
          attemptId: attempt.id,
          expectedDraftRevision: input.expectedDraftRevision,
          criterionElementId: input.criterionElementId,
          reaffirmedAt: deps.now(),
          actor: input.actor,
        });
        const result = await reviewOf(reaffirmed, input.spec);
        if (result.ok) {
          logger.info("specs.delivery-plan.reaffirmed", {
            specId: input.spec.id,
            attemptId: reaffirmed.id,
            criterionElementId: input.criterionElementId,
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
      const diff: DeliveryPlanDocumentDiff = deliveryPlanDocumentDiff(
        deliveryPlanCandidateRecordSchema.parse(JSON.parse(from.content_json))
          .document,
        deliveryPlanCandidateRecordSchema.parse(JSON.parse(to.content_json))
          .document,
      );
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
        return {
          ok: true,
          value: previewView({
            stage: "draft",
            attempt,
            spec: input.spec,
            document,
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
          launch: stored.record.document.launch,
          binding: stored.record.document.binding,
        },
      };
    },

    async signOff(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      const candidate = statedCandidate(input);
      const stored = candidateIdentity(attempt);
      if (stored === null || !sameCandidate(candidate, stored))
        return staleCandidate(input.spec.slug, attempt, candidate, stored);
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
        const view = await project(outcome.approved, input.spec);
        publishPlanChange(input.spec, view, "signed-off");
        return mutation(view, null, null, admissionView(outcome.admission));
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async park(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
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
        const view = await project(parked, input.spec);
        publishPlanChange(input.spec, view, "parked");
        return mutation(view, null, null);
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async resolveLaunch(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null)
        return { kind: "refused", refusal: noAttemptRefusal(input.spec.slug) };
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
      const launch = stored.record.document.launch;
      const binding = stored.record.document.binding;
      return {
        kind: "ready",
        value: {
          attemptId: attempt.id,
          pinnedRevisionId: attempt.pinned_revision_id,
          launchRevision: attempt.draft_revision,
          candidate,
          candidateRecord: stored.record,
          candidateBytes: stored.candidateBytes,
          launch,
          binding,
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

    async recordLaunch(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
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
        const view = await project(launched, input.spec);
        publishPlanChange(input.spec, view, "launched");
        return mutation(view, null, null);
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async abandonLaunch(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) return noAttempt(input.spec.slug);
      if (
        attempt.status !== "launched" ||
        attempt.launched_execution_id !== input.executionId
      ) {
        return {
          ok: false,
          refusal: {
            code: "plan_status_conflict",
            unmetConditions: [
              `Attempt ${attempt.id} does not own launched execution ${input.executionId}.`,
            ],
            instruction: `Read the active attempt with \`cctl spec plan status ${input.spec.slug}\`.`,
          },
        };
      }
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
  switch (attempt.status) {
    case "draft":
      return {
        actor: "agent",
        command: `cctl spec plan edit ${spec.slug} --file <plan.json>`,
        reason:
          "Author one graph launch and its immutable accountability binding.",
      };
    case "proposed":
      return {
        actor: dialRequiresHumanApproval(
          resolveDial(spec.gatePolicy, "execution_start"),
        )
          ? "human"
          : "agent",
        command: `cctl spec plan sign-off ${spec.slug}`,
        reason: "Sign the finalized launch envelope.",
      };
    case "approved":
      return {
        actor: "agent",
        command: `cctl spec start ${spec.slug}`,
        reason: "Start the signed one-off graph launch.",
      };
    case "parked":
      return parseApproval(attempt) === null
        ? {
            actor: dialRequiresHumanApproval(
              resolveDial(spec.gatePolicy, "execution_start"),
            )
              ? "human"
              : "agent",
            command: `cctl spec plan sign-off ${spec.slug}`,
            reason: "The parked candidate still needs sign-off.",
          }
        : {
            actor: "agent",
            command: `cctl spec start ${spec.slug}`,
            reason: "The signed candidate is parked for prelaunch review.",
          };
    case "launched":
      return {
        actor: "agent",
        command: `cctl spec status ${spec.slug}`,
        reason: "The immutable launch is running.",
      };
    case "abandoned":
      return {
        actor: "agent",
        command: `cctl spec plan open ${spec.slug}`,
        reason: "Open a fresh attempt.",
      };
  }
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
    launch: input.document.launch,
    binding: input.document.binding,
  };
}
function initialDocumentForOpen(
  spec: Spec,
  pinnedRevision: SpecRevisionSnapshot,
): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    schemaVersion: 2,
    launch: {
      name: `${spec.name} delivery launch`,
      description: null,
      definition: {
        schemaVersion: 1,
        charter: {
          mission: `Author the delivery launch for ${spec.slug}.`,
          sourcesOfTruth: [
            {
              rank: 1,
              id: "delivery-plan-authoring",
              label: "Delivery plan authoring",
              type: "document",
              locator: ".cc/graph-workflow-docs/delivery-plan-authoring.md",
              description:
                "The authored launch envelope is completed before proposal.",
              accessPolicy: "worktree-relative",
            },
          ],
        },
        executionContexts: [],
        tasks: [],
        edges: [],
      },
      layout: {
        workflowId: `delivery-plan-${spec.slug}`,
        contextPositions: {},
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
      claims: [],
    },
  });
}
/**
 * The authored launch comes from the last finalized candidate; the dispositions
 * do not. They are derived from the delivery delta, so a criterion the previous
 * run actually delivered leaves scope on the evidence rather than on the
 * previous author's word.
 */
function seededDocumentForOpen(
  plans: SpecDeliveryPlanRepo,
  spec: Spec,
  pinnedRevision: SpecRevisionSnapshot,
  basis: DeliveryPlanSeedBasis,
): PlanResult<DeliveryPlanDocument> {
  const source = [...plans.findAttemptsBySpecId(spec.id)]
    .reverse()
    .map((attempt) => storedCandidate(attempt, plans))
    .find((candidate) => candidate !== null);
  if (source === undefined) return noSeedCandidate(spec.slug);
  try {
    return {
      ok: true,
      value: seedDeliveryPlanFromLast({
        source: {
          candidateId: source.identity.candidateId,
          launch: source.record.document.launch,
          binding: source.record.document.binding,
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
        instruction: `Open an unseeded attempt with \`cctl spec plan open ${spec.slug}\` and state the dispositions in \`cctl spec plan edit ${spec.slug} --file <plan.json>\`.`,
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
      instruction: `Read it with \`cctl spec plan status ${slug}\`, or reopen the candidate when a new draft is needed.`,
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
      instruction: `Open an authored draft with \`cctl spec plan open ${slug}\`, then provide the complete launch in \`cctl spec plan edit ${slug} --file <plan.json>\`.`,
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
      instruction: `Reaffirm the criterion in Spec Studio, then re-read \`cctl spec plan status ${slug}\`.`,
    },
  };
}
function admissionRefusal(
  slug: string,
  conditions: readonly string[],
): PlanResult<never> {
  return {
    ok: false,
    refusal: {
      code: "validation",
      unmetConditions: [...conditions],
      instruction: `Correct the graph launch in \`cctl spec plan edit ${slug} --file <plan.json>\`.`,
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
