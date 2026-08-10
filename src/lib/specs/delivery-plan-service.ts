import { z } from "zod";

import { createLogger } from "@/lib/logging";
import { stableStringify } from "@/lib/state-store/serialization";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  DeliveryPlanApprovalIdentityMismatchError,
  DeliveryPlanAttemptNotFoundError,
  DeliveryPlanCandidateMismatchError,
  DeliveryPlanStatusConflictError,
  StaleDeliveryPlanDraftError,
  type SpecDeliveryPlanRepo,
} from "@/lib/state-store/spec-delivery-plan-repo";
import {
  workflowSemanticDefinitionSchema,
  type WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";

import type { DeliveryDeltaCriterion } from "./delivery-delta";
import type { DeliveryDeltaQueryResult } from "./delivery-delta-query";
import type { EarlierMergedDeliveryVerdict } from "./delivery-gate";
import {
  deliveryPlanApprovalSchema,
  deliveryPlanDocumentSchema,
  deliveryPlanPrelaunchSchema,
  emptyDeliveryPlanDocument,
  liveDeliveryPlanAttempt,
  type DeliveryPlanApproval,
  type DeliveryPlanCandidateIdentity,
  type DeliveryPlanDisposition,
  type DeliveryPlanDocument,
  type DeliveryPlanPrelaunch,
} from "./delivery-plan";
import {
  admitExecutionStartForAttemptInTransaction,
  type DeliveryPlanExecutionStartAdmission,
} from "./delivery-plan-approval";
import type { SpecEventsPublisher } from "./events";
import { dialRequiresHumanApproval, resolveDial } from "./policy";
import type { SpecPolicyAdmissionNotifier } from "./policy-admissions";
import {
  deliveryPlanDraftHealth,
  deliveryPlanProposeRefusal,
  wiringOwnershipForContext,
  type DeliveryPlanLintInput,
  type PlanLintCriterion,
} from "./delivery-plan-lint";
import {
  DELIVERY_PLAN_METADATA_KEYS,
  deliveryPlanMaterializationCriteria,
  materializeDeliveryPlan,
  type DeliveryPlanMaterialization,
  type DeliveryPlanMaterializationCriterion,
  type DeliveryPlanMaterializationDefaults,
} from "./delivery-plan-materializer";
import {
  deliveryPlanReviewView,
  type DeliveryPlanReviewStoredComment,
  type DeliveryPlanReviewView,
} from "./delivery-plan-review";
import {
  discoveryTaskId,
  seedDeliveryPlanDocument,
  type PlanSeedDiscovery,
} from "./delivery-plan-seed";
import { deliveryPlanDocumentDiff } from "./delivery-plan-diff";
import type {
  DeliveryPlanAttemptView,
  DeliveryPlanLegacyImportView,
  DeliveryPlanMutationView,
  DeliveryPlanNextAct,
  DeliveryPlanPreviewStage,
  DeliveryPlanPreviewView,
  DeliveryPlanSnapshotDiffView,
  DeliveryPlanSnapshotView,
  DeliveryPlanUnresolvedView,
  DeliveryPlanView,
} from "./delivery-plan-views";
import {
  importLegacyDeliveryPlan,
  LegacyDeliverySourceDamagedError,
  type LegacyDeliverySource,
} from "./legacy-plan-import";
import { actorProvenanceSchema } from "./schemas";
import type {
  ActorProvenance,
  Refusal,
  Spec,
  SpecCriterionDisposition,
  SpecDeliveryPlanAttemptRow,
  SpecDeliveryPlanCandidateRow,
  SpecDeliveryPlanSnapshotRow,
  SpecRevisionSnapshot,
} from "./schemas";
import type { ExecutionScope } from "./scope-validation";
import type { DraftHealth } from "./draft-health";

/**
 * The `spec plan` verbs' one owner. It composes three things that already
 * exist rather than re-deciding any of them: the attempt repository (durable
 * state and its audit rows), the delivery-delta projection (which criterion is
 * fresh, stale, or never delivered), and the plan lint projection (what
 * refuses a proposal). Nothing here re-derives a classification.
 *
 * Attempt addressing is by spec, not by id: a spec has at most one attempt
 * that is still live, so the verbs take a slug and this module resolves it —
 * an author never has to carry an attempt id between two commands.
 */

const logger = createLogger("specs.delivery-plan");

export interface DeliveryPlanServiceDeps {
  plans: SpecDeliveryPlanRepo;
  /**
   * The approval and gate-admission rows a plan sign-off writes. The plan
   * sign-off is also the `execution_start` admission (design §5), and both
   * land inside `runInTransaction` with the attempt's own status write.
   */
  reviewRepo: Pick<SpecReviewRepo, "saveApproval" | "insertGateAdmission">;
  events: SpecEventsPublisher;
  /** Post-hoc review notices for Notify-dial policy admissions. */
  policyNotifier?: SpecPolicyAdmissionNotifier;
  /**
   * One immediate transaction around a whole act. Sign-off, park, and launch
   * each move the attempt AND write a gate or execution record, and a partial
   * commit would leave an approval with no admission behind it
   * (`audited-transitions`).
   */
  runInTransaction<T>(operation: () => T): T;
  /**
   * The revision a NEW attempt pins: the spec's current approved revision.
   * Read exactly once, at open — after that the attempt's own
   * `pinned_revision_id` is the answer, and re-resolving "current" would let a
   * later amendment silently move a live plan's scope.
   */
  currentApprovedRevision(specId: string): Promise<SpecRevisionSnapshot | null>;
  /** The exact revision an existing attempt pinned, by id. */
  revisionSnapshot(revisionId: string): Promise<SpecRevisionSnapshot | null>;
  /**
   * The projection the seed and every freshness judgment read, computed
   * against a stated basis. `sinceExecutionId` is the attempt's immutable
   * `delta_basis_execution_id` for an existing attempt, and null only while
   * opening one — so a delivery that lands after the attempt opened never
   * re-grades the criteria the plan already judged.
   */
  deliveryDelta(input: {
    spec: Spec;
    pinned: SpecRevisionSnapshot;
    sinceExecutionId: string | null;
  }): Promise<DeliveryDeltaQueryResult>;
  /**
   * Every discovery `cctl spec capture` has recorded for this spec, oldest
   * first. Deliberately not scoped to the delta-basis execution: a blocking
   * capture abandons the run it was found in, so that run never becomes a
   * delta basis and a scoped read would drop the one discovery the
   * replacement plan exists to carry. The seed decides which are still
   * pending by reading the plan it carries forward.
   */
  capturedDiscoveries(input: { specId: string }): Promise<PlanSeedDiscovery[]>;
  /**
   * The spec's most recent LEGACY delivery source — a `spec_executions` row
   * compiled straight from an approved evergreen plan revision — or null when
   * this spec has never delivered that way.
   *
   * A seeded open consults it only when no earlier `DeliveryPlanAttempt` has
   * launched, which is exactly the "the latest delivery source is a legacy
   * approved plan" case: once an attempt has launched, its own document is the
   * plan to carry forward and the legacy row is history behind it.
   */
  latestLegacyDeliverySource(
    specId: string,
  ): Promise<LegacyDeliverySource | null>;
  /**
   * The delivery gate's verdict on a claimed `delivered_elsewhere` base. The
   * plan never re-derives "earlier merged delivery"; it asks the gate, so a
   * claim the gate would refuse cannot read as legal in a plan.
   */
  classifyDeliveredElsewhere(input: {
    claim: { id: string; specId: string; createdAt: string };
    criterionElementId: string;
    deliveredByExecutionId: string | null;
  }): EarlierMergedDeliveryVerdict;
  /**
   * Everything materialization needs beyond the plan document: the pinned
   * revision's criteria, the project's registered validation command names, and
   * the inherited workflow defaults. It is resolved once per materialization
   * and pinned into the candidate, which is what makes a later change to a
   * global default unable to move a stored candidate or its hash.
   */
  compilationContext(input: {
    spec: Spec;
    pinnedRevisionId: string;
  }): Promise<DeliveryPlanCompilationContext | null>;
  nextId(): string;
  now(): string;
}

export type { LegacyDeliverySource };

export interface DeliveryPlanCompilationContext {
  readonly criteria: readonly DeliveryPlanMaterializationCriterion[];
  readonly registeredValidationCommandNames: readonly string[];
  readonly defaults: DeliveryPlanMaterializationDefaults;
}

export type PlanResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: Refusal };

/**
 * What one pass over an attempt resolved: the lint input, the pinned revision
 * it read, and the delta's per-criterion classification. Every projection an
 * attempt has is built from this one object so a status receipt, the propose
 * gate, and the Studio review surface cannot be looking at three different
 * gradings of the same criteria.
 */
interface PlanProjectionContext {
  readonly lintInput: DeliveryPlanLintInput;
  readonly pinned: SpecRevisionSnapshot;
  readonly deltaCriteria: readonly DeliveryDeltaCriterion[];
}

export interface OpenDeliveryPlanInput {
  spec: Spec;
  /** Carry the last delivery forward instead of starting from an empty plan. */
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
  /** CAS token for a draft preview; a proposed preview reads a frozen row. */
  expectedDraftRevision?: number;
}

/**
 * The candidate identity the caller read and is acting on. Stating it is what
 * makes the act bind to specific bytes rather than to "whatever is proposed
 * when the write lands" (`exact-approval`).
 */
export interface SignOffDeliveryPlanServiceInput extends DeliveryPlanCandidateIdentity {
  spec: Spec;
  actor: ActorProvenance;
  approver: string;
}

export interface ParkDeliveryPlanServiceInput extends DeliveryPlanCandidateIdentity {
  spec: Spec;
  reason: string | null;
  actor: ActorProvenance;
}

/** What a launch needs from the plan, resolved once and then run unchanged. */
export interface DeliveryPlanLaunchCandidate {
  attemptId: string;
  pinnedRevisionId: string;
  candidate: DeliveryPlanCandidateIdentity;
  /** The stored bytes, read — never re-materialized (`exact-approval`). */
  definition: WorkflowSemanticDefinition;
  /** The pinned scope the plan's dispositions state, for the execution row. */
  scope: ExecutionScope;
  /** Every criterion's disposition, so the run's rows mirror the plan exactly. */
  dispositions: readonly {
    criterionElementId: string;
    disposition: SpecCriterionDisposition;
    deliveredByExecutionId: string | null;
  }[];
}

/** Whether this spec has an approved delivery-plan candidate ready to run. */
export type DeliveryPlanLaunchResolution =
  | { readonly kind: "ready"; readonly value: DeliveryPlanLaunchCandidate }
  /**
   * A compiled candidate exists but nothing has approved it. Distinct from
   * `refused` because the two callers differ: a launch refuses with the named
   * next act, while `spec start --park` may hold exactly this candidate for
   * the review that produces the approval.
   */
  | {
      readonly kind: "unapproved";
      readonly attemptId: string;
      readonly candidate: DeliveryPlanCandidateIdentity;
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
  /**
   * The same projection resolved for review: the plan view plus its pinned
   * criteria in full. Studio reads this rather than the plan view because a
   * reviewer needs the criterion text a CLI receipt would only have to
   * truncate.
   */
  review(input: { spec: Spec }): Promise<PlanResult<DeliveryPlanReviewView>>;
  /**
   * Anchor a review note to one context of the live attempt. It returns the
   * review projection rather than the stored row so the caller sees the note
   * in the same shape a reload would show it — including whether its anchor
   * still resolves.
   */
  comment(
    input: CommentOnDeliveryPlanInput,
  ): Promise<PlanResult<DeliveryPlanReviewView>>;
  /**
   * The audited human act behind a `reaffirmed` disposition. It is a first-class
   * verb rather than a document edit because the plan lint refuses a
   * reaffirmation an author asserted for themselves: only this path records the
   * actor, the basis revision, and the exact basis hashes the human judged.
   */
  reaffirm(
    input: ReaffirmDeliveryPlanCriterionInput,
  ): Promise<PlanResult<DeliveryPlanReviewView>>;
  /**
   * The semantic diff between two frozen snapshots of this spec's attempt. It
   * reads the stored documents rather than re-deriving them, so the comparison
   * is over exactly the bytes each proposal froze.
   */
  diffSnapshots(
    input: DiffDeliveryPlanSnapshotsInput,
  ): Promise<PlanResult<DeliveryPlanSnapshotDiffView>>;
  preview(
    input: PreviewDeliveryPlanServiceInput,
  ): Promise<PlanResult<DeliveryPlanPreviewView>>;
  /**
   * The one default approval (design §5). It approves the stored candidate and
   * admits `execution_start` in a single act, so nothing else stands between a
   * proposal and its launch. Under a dial that requires a human it refuses an
   * agent outright; under Notify/Off it records a policy-basis admission in
   * place of the human approval — never a second gate.
   */
  signOff(
    input: SignOffDeliveryPlanServiceInput,
  ): Promise<PlanResult<DeliveryPlanMutationView>>;
  /**
   * Hold the candidate for spec-side prelaunch review. No workflow execution
   * is created and no session slot is taken, which is what makes the parked
   * state unable to block session validation (ticket #47 note 9e5ba960).
   */
  park(
    input: ParkDeliveryPlanServiceInput,
  ): Promise<PlanResult<DeliveryPlanMutationView>>;
  /** The launch precondition: an approved candidate, or the act that owes one. */
  resolveLaunch(input: { spec: Spec }): Promise<DeliveryPlanLaunchResolution>;
  /**
   * Move the attempt to `launched` against the execution that now runs it.
   * Separate from `resolveLaunch` because the workflow launch happens between
   * the two, and the attempt must record the execution that actually exists.
   */
  recordLaunch(input: {
    spec: Spec;
    executionId: string;
    candidate: DeliveryPlanCandidateIdentity;
    actor: ActorProvenance;
  }): Promise<PlanResult<DeliveryPlanMutationView>>;
}

const OPEN_ACT = (slug: string) =>
  `cctl spec plan open ${slug} --seed-from last`;

export function createDeliveryPlanService(
  deps: DeliveryPlanServiceDeps,
): DeliveryPlanService {
  function liveAttempt(specId: string): SpecDeliveryPlanAttemptRow | null {
    return liveDeliveryPlanAttempt(deps.plans.findAttemptsBySpecId(specId));
  }

  /**
   * Every task id any LAUNCHED plan carried. A discovery is consumed the
   * moment a plan launched carrying it — not merely while the newest plan
   * still carries it forward. Carry-forward drops a context once its criteria
   * deliver, so dedupe against the carried document alone would resurrect
   * every past discovery as fresh unowned work on the plan after delivery.
   *
   * Read at plan-open time over immutable launched history; nothing is
   * persisted to mark a discovery consumed.
   */
  function launchedTaskIds(specId: string): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const attempt of deps.plans.findAttemptsBySpecId(specId)) {
      if (attempt.launched_execution_id === null) continue;
      const parsed = deliveryPlanDocumentSchema.safeParse(
        JSON.parse(attempt.content_json),
      );
      if (!parsed.success) continue;
      for (const task of parsed.data.tasks) ids.add(task.taskId);
    }
    return ids;
  }

  /** The captured discoveries no launched plan has taken up yet. */
  async function pendingDiscoveries(
    specId: string,
  ): Promise<PlanSeedDiscovery[]> {
    const consumed = launchedTaskIds(specId);
    const captured = await deps.capturedDiscoveries({ specId });
    return captured.filter(
      (discovery) => !consumed.has(discoveryTaskId(discovery.discoveryId)),
    );
  }

  function lastLaunchedDocument(specId: string): DeliveryPlanDocument | null {
    const launched = deps.plans
      .findAttemptsBySpecId(specId)
      .filter((attempt) => attempt.status === "launched");
    const last = launched[launched.length - 1];
    if (last === undefined) return null;
    return deliveryPlanDocumentSchema.parse(JSON.parse(last.content_json));
  }

  /**
   * The legacy plan lifted into the graph vocabulary, or null when this spec
   * has no legacy delivery source to lift. A revision the import cannot read
   * refuses rather than falling through to an empty plan: silently opening an
   * unseeded attempt would look like "this spec has never delivered".
   */
  async function importedLegacyPlan(spec: Spec): Promise<
    PlanResult<{
      document: DeliveryPlanDocument;
      view: DeliveryPlanLegacyImportView;
    } | null>
  > {
    // A source that cannot be read is not a spec without a legacy delivery:
    // reading damage as absence would seed an empty document and report it as
    // a fresh plan, which is the one outcome an author cannot detect.
    let source: LegacyDeliverySource | null;
    try {
      source = await deps.latestLegacyDeliverySource(spec.id);
    } catch (error) {
      if (error instanceof LegacyDeliverySourceDamagedError) {
        return { ok: false, refusal: damagedLegacySourceRefusal(spec, error) };
      }
      throw error;
    }
    if (source === null) return { ok: true, value: null };
    try {
      const imported = importLegacyDeliveryPlan({
        specSlug: spec.slug,
        specName: spec.name,
        sourceExecutionId: source.executionId,
        snapshot: source.snapshot,
        scope: source.scope,
      });
      return {
        ok: true,
        value: {
          document: imported.document,
          view: {
            sourceExecutionId: source.executionId,
            sourceRevisionId: source.snapshot.revision.id,
            contextCount: imported.document.contexts.length,
            taskCount: imported.document.tasks.length,
            requiresHumanSplit: imported.requiresHumanSplit.map((entry) => ({
              criterionElementId: entry.criterionElementId,
              handle: entry.handle,
              contextIds: [...entry.contextIds],
              resolution: entry.resolution,
            })),
            notes: [...imported.notes],
          },
        },
      };
    } catch (error) {
      return {
        ok: false,
        refusal: legacyImportFailureRefusal(spec, source, error),
      };
    }
  }

  async function lintInputFor(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
    document: DeliveryPlanDocument,
  ): Promise<PlanResult<PlanProjectionContext>> {
    // The attempt's OWN pins, never the current head: a plan judges the
    // criteria of the revision it pinned against the delivery it was seeded
    // from, so a revision approved or a delivery merged after it opened
    // changes nothing about what this plan is judged against
    // (`computed-projections`).
    const pinned = await deps.revisionSnapshot(attempt.pinned_revision_id);
    if (pinned === null) {
      return { ok: false, refusal: unreadablePinRefusal(attempt, spec.slug) };
    }
    const delta = await deps.deliveryDelta({
      spec,
      pinned,
      sinceExecutionId: attempt.delta_basis_execution_id,
    });
    if (!delta.ok) {
      return {
        ok: false,
        refusal: {
          code: "not_found",
          unmetConditions: [delta.message],
          instruction: delta.message,
        },
      };
    }
    const pinnedCriteria: PlanLintCriterion[] = delta.projection.criteria.map(
      (criterion) => ({
        criterionElementId: criterion.criterionElementId,
        handle: criterion.handle,
        deliveryClass: criterion.class,
        freshness: criterion.freshness,
      }),
    );
    return {
      ok: true,
      value: {
        pinned,
        deltaCriteria: delta.projection.criteria,
        lintInput: {
          pinnedRevisionId: attempt.pinned_revision_id,
          document,
          pinnedCriteria,
          deliveredElsewhereVerdicts: document.dispositions
            .filter((entry) => entry.disposition === "delivered_elsewhere")
            .map((entry) => ({
              criterionElementId: entry.criterionElementId,
              verdict: deps.classifyDeliveredElsewhere({
                claim: {
                  id: attempt.id,
                  specId: spec.id,
                  createdAt: attempt.created_at,
                },
                criterionElementId: entry.criterionElementId,
                deliveredByExecutionId: entry.deliveredByExecutionId,
              }),
            })),
        },
      },
    };
  }

  /**
   * The one projection of an attempt. It hands back the `DraftHealth` beside
   * the view so the propose gate refuses from exactly the object the receipt
   * reported (`single-lint-projection`) rather than re-linting the same
   * document a second time and hoping the two agree.
   */
  async function project(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
  ): Promise<
    PlanResult<{
      view: DeliveryPlanView;
      health: DraftHealth;
      context: PlanProjectionContext;
    }>
  > {
    const document = deliveryPlanDocumentSchema.parse(
      JSON.parse(attempt.content_json),
    );
    const lintInput = await lintInputFor(attempt, spec, document);
    if (!lintInput.ok) return lintInput;
    const health = deliveryPlanDraftHealth(lintInput.value.lintInput);
    const snapshots = deps.plans
      .findSnapshotsByAttemptId(attempt.id)
      .map((snapshot) => ({
        id: snapshot.id,
        draftRevision: snapshot.draft_revision,
        planHash: snapshot.plan_hash,
        proposedAt: snapshot.proposed_at,
      }));
    const approval = readApproval(attempt);
    const candidate =
      attempt.proposed_snapshot_id === null
        ? null
        : deps.plans.findCandidateBySnapshotId(attempt.proposed_snapshot_id);
    return {
      ok: true,
      value: {
        health,
        context: lintInput.value,
        view: {
          attempt: attemptView(attempt, spec, snapshots, candidate),
          approval,
          prelaunch: prelaunchView(attempt, candidate),
          document,
          health: {
            total: health.total,
            blocking: health.blocking,
            counts: [...health.counts],
            findings: [...health.ordered],
          },
          dispositionCounts: dispositionCounts(document),
          unresolved: unresolvedDispositions(
            document,
            lintInput.value.lintInput.pinnedCriteria,
          ),
          snapshots,
          nextAct: nextAct(attempt, spec, health),
          wiringByContext: document.contexts.map((context) => ({
            contextId: context.contextId,
            entries: wiringOwnershipForContext(document, context.contextId),
          })),
        },
      },
    };
  }

  /**
   * The attempt's current document compiled to its executed definition. Both
   * the propose path and the draft preview go through here, so the bytes a
   * planner reviews and the bytes a proposal freezes are produced by one call
   * site rather than by two that agree today.
   */
  async function materialize(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
  ): Promise<PlanResult<DeliveryPlanMaterialization>> {
    const context = await deps.compilationContext({
      spec,
      pinnedRevisionId: attempt.pinned_revision_id,
    });
    if (context === null) {
      return { ok: false, refusal: unreadablePinRefusal(attempt, spec.slug) };
    }
    const result = materializeDeliveryPlan({
      spec: { id: spec.id, slug: spec.slug, name: spec.name },
      attemptId: attempt.id,
      pinnedRevisionId: attempt.pinned_revision_id,
      draftRevision: attempt.draft_revision,
      document: deliveryPlanDocumentSchema.parse(
        JSON.parse(attempt.content_json),
      ),
      criteria: context.criteria,
      registeredValidationCommandNames:
        context.registeredValidationCommandNames,
      defaults: context.defaults,
    });
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, refusal: result.refusal };
  }

  /**
   * Every mutation reports the same thing: the state it produced and what it
   * moved. Running the projection after the write (rather than assembling one
   * from the write's return) is what keeps a receipt and a subsequent status
   * read from ever disagreeing.
   */
  async function mutationView(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
    previousHealth: { total: number; blocking: number } | null,
    invalidatedApproval: { snapshotId: string; planHash: string } | null,
    legacyImport: DeliveryPlanLegacyImportView | null = null,
    executionStartAdmission: DeliveryPlanMutationView["executionStartAdmission"] = null,
  ): Promise<PlanResult<DeliveryPlanMutationView>> {
    const projected = await project(attempt, spec);
    if (!projected.ok) return projected;
    return {
      ok: true,
      value: {
        ...projected.value.view,
        previousHealth,
        invalidatedApproval,
        legacyImport,
        executionStartAdmission,
      },
    };
  }

  /**
   * The review read-model for one attempt. Both the read and the comment act
   * go through here so a receipt and a reload cannot disagree about which
   * anchors still resolve.
   */
  async function reviewOf(
    attempt: SpecDeliveryPlanAttemptRow,
    spec: Spec,
  ): Promise<PlanResult<DeliveryPlanReviewView>> {
    const projected = await project(attempt, spec);
    if (!projected.ok) return projected;
    return {
      ok: true,
      value: deliveryPlanReviewView({
        plan: projected.value.view,
        // The pinned revision's own criteria, read through the same derivation
        // materialization uses, so the text a reviewer approves is the text a
        // context pack will carry.
        pinnedCriteria: deliveryPlanMaterializationCriteria(
          projected.value.context.pinned,
        ),
        deltaCriteria: projected.value.context.deltaCriteria,
        comments: storedComments(attempt.id),
      }),
    };
  }

  function storedComments(
    attemptId: string,
  ): DeliveryPlanReviewStoredComment[] {
    return deps.plans.findCommentsByAttemptId(attemptId).map((row) => ({
      id: row.id,
      contextId: row.context_id,
      body: row.body,
      author: actorProvenanceSchema.parse(JSON.parse(row.author_json)),
      createdAt: row.created_at,
    }));
  }

  /**
   * The candidate an act names, checked against the attempt before anything is
   * written. The repository re-checks it inside its own transaction — this is
   * the fast path that keeps the refusal readable, naming both hashes so the
   * caller can tell a stale read from a candidate that moved underneath.
   */
  function liveCandidate(
    attempt: SpecDeliveryPlanAttemptRow,
  ): DeliveryPlanCandidateIdentity | null {
    const snapshotId = attempt.proposed_snapshot_id;
    if (snapshotId === null) return null;
    const snapshot = deps.plans.findSnapshotById(snapshotId);
    const candidate = deps.plans.findCandidateBySnapshotId(snapshotId);
    if (snapshot === null || candidate === null) return null;
    return {
      candidateId: candidate.id,
      planHash: snapshot.plan_hash,
      compiledDefinitionHash: candidate.compiled_definition_hash,
    };
  }

  return {
    async open(input) {
      const existing = liveAttempt(input.spec.id);
      if (existing !== null && existing.status !== "launched") {
        return { ok: false, refusal: attemptAlreadyOpenRefusal(existing) };
      }
      const pinned = await deps.currentApprovedRevision(input.spec.id);
      if (pinned === null) {
        return { ok: false, refusal: noPinnedRevisionRefusal(input.spec.slug) };
      }

      let document = emptyDeliveryPlanDocument();
      let deltaBasisExecutionId: string | null = null;
      let legacyImport: DeliveryPlanLegacyImportView | null = null;
      if (input.seedFromLast) {
        // Only here is the basis unstated: opening is exactly the moment the
        // attempt CHOOSES which delivery it is measured against, and the
        // choice is then frozen onto the row.
        const delta = await deps.deliveryDelta({
          spec: input.spec,
          pinned,
          sinceExecutionId: null,
        });
        if (!delta.ok) {
          return {
            ok: false,
            refusal: {
              code: "not_found",
              unmetConditions: [delta.message],
              instruction: `${delta.message} Open an unseeded attempt with \`cctl spec plan open ${input.spec.slug}\` to author from an empty plan instead.`,
            },
          };
        }
        deltaBasisExecutionId =
          delta.projection.comparedExecution?.executionId ?? null;

        // The plan to carry forward: the last launched attempt's document, or
        // — when this spec has only ever delivered through the legacy compiled
        // path — that plan lifted into the graph vocabulary. Seeding then does
        // what it always does, so the disposition law has one owner either way.
        let priorPlan = lastLaunchedDocument(input.spec.id);
        if (priorPlan === null) {
          const imported = await importedLegacyPlan(input.spec);
          if (!imported.ok) return imported;
          if (imported.value !== null) {
            priorPlan = imported.value.document;
            legacyImport = imported.value.view;
          }
        }

        document = seedDeliveryPlanDocument({
          pinnedRevisionId: pinned.revision.id,
          criteria: delta.projection.criteria.map((criterion) => ({
            criterionElementId: criterion.criterionElementId,
            handle: criterion.handle,
            deliveryClass: criterion.class,
          })),
          deliveredByExecutionId: deltaBasisExecutionId,
          priorPlan,
          discoveries: await pendingDiscoveries(input.spec.id),
        });
      }

      const validated = deliveryPlanDocumentSchema.safeParse(document);
      if (!validated.success) {
        return {
          ok: false,
          refusal: seededDocumentRefusal(
            input.spec,
            legacyImport,
            validated.error,
          ),
        };
      }

      const occurredAt = deps.now();
      try {
        // The check above is a fast path for the receipt's sake; the
        // repository re-decides admission inside its own transaction, which is
        // what makes two concurrent opens produce one attempt rather than two.
        const attempt = deps.plans.open({
          attempt: {
            id: deps.nextId(),
            spec_id: input.spec.id,
            pinned_revision_id: pinned.revision.id,
            delta_basis_execution_id: deltaBasisExecutionId,
            status: "draft",
            draft_revision: 1,
            content_json: JSON.stringify(document),
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
        logger.info("specs.delivery-plan.opened", {
          specId: input.spec.id,
          attemptId: attempt.id,
          seeded: input.seedFromLast,
          criterionCount: document.dispositions.length,
          legacyImportSourceExecutionId: legacyImport?.sourceExecutionId,
          requiresHumanSplit: legacyImport?.requiresHumanSplit.length,
        });
        return mutationView(attempt, input.spec, null, null, legacyImport);
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async edit(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }
      const before = await project(attempt, input.spec);
      if (!before.ok) return before;
      try {
        const next = deps.plans.saveDraft({
          attemptId: attempt.id,
          expectedDraftRevision: input.expectedDraftRevision,
          document: input.document,
          updatedAt: deps.now(),
        });
        return mutationView(
          next,
          input.spec,
          {
            total: before.value.view.health.total,
            blocking: before.value.view.health.blocking,
          },
          null,
        );
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    /**
     * Lint, materialize, preflight, then one commit boundary. The order is the
     * point: everything that can refuse runs before anything is written, so a
     * refusal leaves the attempt exactly as editable as it was — no proposal
     * row, no candidate row, no audit event.
     */
    async propose(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }
      const before = await project(attempt, input.spec);
      if (!before.ok) return before;
      // The propose gate refuses from the SAME projection the edit receipt
      // reported (`single-lint-projection`), so a receipt saying nothing blocks
      // and a propose that refuses cannot coexist.
      const refusal = deliveryPlanProposeRefusal(before.value.health);
      if (refusal !== null) return { ok: false, refusal };

      const compiled = await materialize(attempt, input.spec);
      if (!compiled.ok) return compiled;

      try {
        const proposed = deps.plans.propose({
          attemptId: attempt.id,
          expectedDraftRevision: attempt.draft_revision,
          snapshotId: deps.nextId(),
          proposedAt: deps.now(),
          actor: input.actor,
          candidate: {
            id: deps.nextId(),
            compiledDefinitionHash: compiled.value.compiledDefinitionHash,
            definitionJson: stableStringify(compiled.value.definition),
            planHash: compiled.value.planHash,
          },
        });
        logger.info("specs.delivery-plan.proposed", {
          specId: input.spec.id,
          attemptId: proposed.attempt.id,
          planHash: proposed.snapshot.plan_hash,
          candidateId: proposed.candidate.id,
          compiledDefinitionHash: proposed.candidate.compiled_definition_hash,
        });
        return mutationView(
          proposed.attempt,
          input.spec,
          {
            total: before.value.view.health.total,
            blocking: before.value.view.health.blocking,
          },
          null,
        );
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async reopen(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }
      const before = await project(attempt, input.spec);
      if (!before.ok) return before;
      try {
        const reopened = deps.plans.reopen({
          attemptId: attempt.id,
          reopenedAt: deps.now(),
          actor: input.actor,
          reason: input.reason,
        });
        logger.info("specs.delivery-plan.reopened", {
          specId: input.spec.id,
          attemptId: reopened.attempt.id,
          invalidatedApproval: reopened.invalidatedApproval !== null,
        });
        return mutationView(
          reopened.attempt,
          input.spec,
          {
            total: before.value.view.health.total,
            blocking: before.value.view.health.blocking,
          },
          reopened.invalidatedApproval,
        );
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async read(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }
      const projected = await project(attempt, input.spec);
      return projected.ok
        ? { ok: true, value: projected.value.view }
        : projected;
    },

    async review(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }
      return reviewOf(attempt, input.spec);
    },

    async diffSnapshots(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }
      const sides = [input.fromSnapshotId, input.toSnapshotId].map(
        (snapshotId) => deps.plans.findSnapshotById(snapshotId),
      );
      const [from, to] = sides;
      if (
        from === null ||
        from === undefined ||
        to === null ||
        to === undefined ||
        from.attempt_id !== attempt.id ||
        to.attempt_id !== attempt.id
      ) {
        return {
          ok: false,
          refusal: unknownSnapshotRefusal(input.spec, attempt, [
            input.fromSnapshotId,
            input.toSnapshotId,
          ]),
        };
      }
      return {
        ok: true,
        value: {
          from: snapshotView(from),
          to: snapshotView(to),
          diff: deliveryPlanDocumentDiff(
            deliveryPlanDocumentSchema.parse(JSON.parse(from.content_json)),
            deliveryPlanDocumentSchema.parse(JSON.parse(to.content_json)),
          ),
        },
      };
    },

    async reaffirm(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }
      if (input.actor.kind !== "human") {
        return {
          ok: false,
          refusal: agentReaffirmationRefusal(input.spec, attempt),
        };
      }
      if (attempt.status !== "draft") {
        return {
          ok: false,
          refusal: reaffirmOutsideDraftRefusal(input.spec, attempt),
        };
      }
      const document = deliveryPlanDocumentSchema.parse(
        JSON.parse(attempt.content_json),
      );
      const context = await lintInputFor(attempt, input.spec, document);
      if (!context.ok) return context;
      const graded = context.value.deltaCriteria.find(
        (criterion) =>
          criterion.criterionElementId === input.criterionElementId,
      );
      const entry = document.dispositions.find(
        (disposition) =>
          disposition.criterionElementId === input.criterionElementId,
      );
      if (graded === undefined || entry === undefined) {
        return {
          ok: false,
          refusal: unknownCriterionRefusal(
            input.spec,
            attempt,
            input.criterionElementId,
          ),
        };
      }
      if (graded.class !== "soft_stale") {
        return {
          ok: false,
          refusal: notSoftStaleRefusal(input.spec, attempt, graded),
        };
      }
      const reaffirmation = {
        actor: input.actor,
        at: deps.now(),
        basisRevisionId: attempt.pinned_revision_id,
        basis: (graded.freshness?.basis ?? []).map((basis) => ({
          elementId: basis.elementId,
          reason: basis.reason,
          baseHash: basis.baseHash,
          currentHash: basis.currentHash,
        })),
      };
      const next = deliveryPlanDocumentSchema.parse({
        ...document,
        dispositions: document.dispositions.map((disposition) =>
          disposition.criterionElementId === input.criterionElementId
            ? { ...disposition, disposition: "reaffirmed", reaffirmation }
            : disposition,
        ),
      });
      const updated = deps.plans.recordReaffirmation({
        attemptId: attempt.id,
        expectedDraftRevision: attempt.draft_revision,
        document: next,
        updatedAt: reaffirmation.at,
        criterionElementId: input.criterionElementId,
        reaffirmation,
      });
      return reviewOf(updated, input.spec);
    },

    async comment(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }
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
      return reviewOf(attempt, input.spec);
    },

    async signOff(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }
      const dial = resolveDial(input.spec.gatePolicy, "execution_start");
      if (dialRequiresHumanApproval(dial) && input.actor.kind !== "human") {
        return {
          ok: false,
          refusal: agentSignOffRefusal(input.spec, attempt, dial),
        };
      }
      const stated: DeliveryPlanCandidateIdentity = {
        candidateId: input.candidateId,
        planHash: input.planHash,
        compiledDefinitionHash: input.compiledDefinitionHash,
      };
      const stored = liveCandidate(attempt);
      if (stored === null || !sameCandidate(stated, stored)) {
        return {
          ok: false,
          refusal: candidateIdentityRefusal(
            input.spec.slug,
            attempt.id,
            stated,
            stored,
          ),
        };
      }

      const occurredAt = deps.now();
      let admission: DeliveryPlanExecutionStartAdmission;
      let approved: SpecDeliveryPlanAttemptRow;
      try {
        ({ admission, approved } = deps.runInTransaction(() => {
          const next = deps.plans.recordTransition({
            attemptId: attempt.id,
            transition: { kind: "approve", ...stated },
            occurredAt,
            actor: input.actor,
          });
          return {
            approved: next,
            admission: admitExecutionStartForAttemptInTransaction(
              {
                reviewRepo: deps.reviewRepo,
                events: deps.events,
                nextId: deps.nextId,
              },
              {
                spec: input.spec,
                pinnedRevisionId: next.pinned_revision_id,
                attemptId: next.id,
                candidate: stated,
                actor: input.actor,
                approver: input.approver,
                occurredAt,
              },
            ),
          };
        }));
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
      deps.events.publishAfterCommit(admission.prepared);
      if (admission.notice !== null) {
        deps.policyNotifier?.policyAdmitted(admission.notice);
      }
      logger.info("specs.delivery-plan.signed-off", {
        specId: input.spec.id,
        attemptId: approved.id,
        candidateId: stated.candidateId,
        compiledDefinitionHash: stated.compiledDefinitionHash,
        executionStartDial: admission.dial,
        admissionBasis: admission.basis,
      });
      return mutationView(approved, input.spec, null, null, null, {
        dial: admission.dial,
        basis: admission.basis,
        admissionId: admission.admissionId,
        approvalId: admission.approvalId,
      });
    },

    async park(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }
      const stated: DeliveryPlanCandidateIdentity = {
        candidateId: input.candidateId,
        planHash: input.planHash,
        compiledDefinitionHash: input.compiledDefinitionHash,
      };
      const stored = liveCandidate(attempt);
      if (stored === null || !sameCandidate(stated, stored)) {
        return {
          ok: false,
          refusal: candidateIdentityRefusal(
            input.spec.slug,
            attempt.id,
            stated,
            stored,
          ),
        };
      }
      try {
        const parked = deps.plans.recordTransition({
          attemptId: attempt.id,
          transition: { kind: "park", reason: input.reason, ...stated },
          occurredAt: deps.now(),
          actor: input.actor,
        });
        logger.info("specs.delivery-plan.parked", {
          specId: input.spec.id,
          attemptId: parked.id,
          candidateId: stated.candidateId,
          approvedAtPark: parked.approval_json !== null,
        });
        return mutationView(parked, input.spec, null, null);
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async resolveLaunch(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { kind: "refused", refusal: noAttemptRefusal(input.spec.slug) };
      }
      if (attempt.status === "launched") {
        return {
          kind: "refused",
          refusal: alreadyLaunchedRefusal(input.spec.slug, attempt),
        };
      }
      const approval = readApproval(attempt);
      const stored = liveCandidate(attempt);
      const unapproved = (refusal: Refusal): DeliveryPlanLaunchResolution =>
        stored === null
          ? { kind: "refused", refusal }
          : {
              kind: "unapproved",
              attemptId: attempt.id,
              candidate: stored,
              refusal,
            };
      if (approval === null || stored === null) {
        return unapproved(
          prematureStartRefusal(
            input.spec.slug,
            attempt,
            stored,
            readPrelaunch(attempt),
          ),
        );
      }
      if (!sameCandidate(approval, stored)) {
        return unapproved(
          reapprovalRefusal(input.spec.slug, attempt, approval, stored),
        );
      }
      const candidateRow = deps.plans.findCandidateBySnapshotId(
        attempt.proposed_snapshot_id ?? "",
      );
      if (candidateRow === null) {
        return {
          kind: "refused",
          refusal: missingCandidateRefusal(
            attempt,
            input.spec,
            attempt.proposed_snapshot_id ?? "",
          ),
        };
      }
      const document = deliveryPlanDocumentSchema.parse(
        JSON.parse(attempt.content_json),
      );
      return {
        kind: "ready",
        value: {
          attemptId: attempt.id,
          pinnedRevisionId: attempt.pinned_revision_id,
          candidate: stored,
          // Read, never recompiled: these are the approved bytes.
          definition: workflowSemanticDefinitionSchema.parse(
            JSON.parse(candidateRow.definition_json),
          ),
          scope: deliveryPlanExecutionScope(document),
          dispositions: deliveryPlanRunDispositions(document),
        },
      };
    },

    async recordLaunch(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }
      try {
        const launched = deps.plans.recordTransition({
          attemptId: attempt.id,
          transition: {
            kind: "launch",
            executionId: input.executionId,
            ...input.candidate,
          },
          occurredAt: deps.now(),
          actor: input.actor,
        });
        logger.info("specs.delivery-plan.launched", {
          specId: input.spec.id,
          attemptId: launched.id,
          executionId: input.executionId,
          compiledDefinitionHash: input.candidate.compiledDefinitionHash,
        });
        return mutationView(launched, input.spec, null, null);
      } catch (error) {
        return planFailure(error, input.spec.slug);
      }
    },

    async preview(input) {
      const attempt = liveAttempt(input.spec.id);
      if (attempt === null) {
        return { ok: false, refusal: noAttemptRefusal(input.spec.slug) };
      }

      if (input.stage === "proposed") {
        const snapshotId = attempt.proposed_snapshot_id;
        if (snapshotId === null) {
          return { ok: false, refusal: noProposalRefusal(attempt, input.spec) };
        }
        const snapshot = deps.plans.findSnapshotById(snapshotId);
        const candidate = deps.plans.findCandidateBySnapshotId(snapshotId);
        if (snapshot === null || candidate === null) {
          return {
            ok: false,
            refusal: missingCandidateRefusal(attempt, input.spec, snapshotId),
          };
        }
        // Read, never recompile: this is the exact object an approval binds to.
        const definition = workflowSemanticDefinitionSchema.parse(
          JSON.parse(candidate.definition_json),
        );
        return {
          ok: true,
          value: {
            stage: "proposed",
            attemptId: attempt.id,
            specSlug: input.spec.slug,
            draftRevision: snapshot.draft_revision,
            pinnedRevisionId: snapshot.pinned_revision_id,
            planHash: snapshot.plan_hash,
            snapshotId: snapshot.id,
            candidateId: candidate.id,
            compiledDefinitionHash: candidate.compiled_definition_hash,
            approvable: true,
            approvability: `This is the stored candidate for snapshot ${snapshot.id}. Approving the plan approves exactly these bytes, and starting the spec execution launches them unchanged.`,
            definition,
            packManifests: packManifestsOf(definition),
          },
        };
      }

      if (attempt.status !== "draft") {
        return {
          ok: false,
          refusal: {
            code: "plan_status_conflict",
            unmetConditions: [
              `Delivery plan attempt ${attempt.id} is ${attempt.status}, so it has no editable draft to preview.`,
            ],
            instruction: `Read the frozen candidate with \`cctl spec plan preview ${input.spec.slug} --stage proposed\`, or return the attempt to draft with \`cctl spec plan reopen ${input.spec.slug}\` first.`,
            details: { attemptId: attempt.id, status: attempt.status },
          },
        };
      }
      if (
        input.expectedDraftRevision !== undefined &&
        input.expectedDraftRevision !== attempt.draft_revision
      ) {
        return {
          ok: false,
          refusal: {
            code: "stale_plan_draft",
            unmetConditions: [
              `Delivery plan attempt ${attempt.id} is at draft revision ${attempt.draft_revision}, not ${input.expectedDraftRevision}.`,
            ],
            instruction: `Nothing was compiled. Re-read the attempt with \`cctl spec plan status ${input.spec.slug}\` and re-run the preview at draft revision ${attempt.draft_revision}.`,
            details: {
              attemptId: attempt.id,
              expectedDraftRevision: input.expectedDraftRevision,
              currentDraftRevision: attempt.draft_revision,
            },
          },
        };
      }

      const compiled = await materialize(attempt, input.spec);
      if (!compiled.ok) return compiled;
      return {
        ok: true,
        value: {
          stage: "draft",
          attemptId: attempt.id,
          specSlug: input.spec.slug,
          draftRevision: attempt.draft_revision,
          pinnedRevisionId: attempt.pinned_revision_id,
          planHash: compiled.value.planHash,
          snapshotId: null,
          candidateId: null,
          compiledDefinitionHash: compiled.value.compiledDefinitionHash,
          approvable: false,
          approvability: `Draft revision ${attempt.draft_revision} has frozen nothing, so there is no candidate to approve. Run \`cctl spec plan propose ${input.spec.slug}\` to freeze these bytes, then approve the proposal.`,
          definition: compiled.value.definition,
          packManifests: [...compiled.value.packManifests],
        },
      };
    },
  };
}

/**
 * The manifest read back off a compiled definition rather than carried beside
 * it, so a proposed preview reports what its stored candidate actually says
 * instead of recomputing what the pack would be today.
 */
function packManifestsOf(
  definition: WorkflowSemanticDefinition,
): DeliveryPlanPreviewView["packManifests"] {
  return definition.executionContexts.map((context) => {
    const raw = context.metadata?.[DELIVERY_PLAN_METADATA_KEYS.packManifest];
    const parsed =
      raw === undefined ? null : packManifestSchema.safeParse(JSON.parse(raw));
    return {
      contextId: context.id,
      total: parsed?.success === true ? parsed.data.total : 0,
      included: parsed?.success === true ? parsed.data.included : 0,
      omitted: parsed?.success === true ? parsed.data.omitted : 0,
    };
  });
}

const packManifestSchema = z
  .object({
    total: z.number().int().nonnegative(),
    included: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
  })
  .strict();

function attemptView(
  attempt: SpecDeliveryPlanAttemptRow,
  spec: Spec,
  snapshots: readonly { id: string; planHash: string }[],
  candidate: SpecDeliveryPlanCandidateRow | null,
): DeliveryPlanAttemptView {
  return {
    compiledDefinitionHash: candidate?.compiled_definition_hash ?? null,
    candidateId: candidate?.id ?? null,
    id: attempt.id,
    specSlug: spec.slug,
    status: attempt.status,
    draftRevision: attempt.draft_revision,
    pinnedRevisionId: attempt.pinned_revision_id,
    deltaBasisExecutionId: attempt.delta_basis_execution_id,
    proposedSnapshotId: attempt.proposed_snapshot_id,
    planHash:
      snapshots.find((snapshot) => snapshot.id === attempt.proposed_snapshot_id)
        ?.planHash ?? null,
    launchedExecutionId: attempt.launched_execution_id,
    createdAt: attempt.created_at,
    updatedAt: attempt.updated_at,
  };
}

function readApproval(
  attempt: SpecDeliveryPlanAttemptRow,
): DeliveryPlanApproval | null {
  if (attempt.approval_json === null) return null;
  return deliveryPlanApprovalSchema.parse(JSON.parse(attempt.approval_json));
}

function readPrelaunch(
  attempt: SpecDeliveryPlanAttemptRow,
): DeliveryPlanPrelaunch | null {
  if (attempt.prelaunch_json === null) return null;
  return deliveryPlanPrelaunchSchema.parse(JSON.parse(attempt.prelaunch_json));
}

function sameCandidate(
  left: DeliveryPlanCandidateIdentity,
  right: DeliveryPlanCandidateIdentity,
): boolean {
  return (
    left.candidateId === right.candidateId &&
    left.planHash === right.planHash &&
    left.compiledDefinitionHash === right.compiledDefinitionHash
  );
}

/**
 * The plan's dispositions in the execution vocabulary. `reaffirmed` maps to
 * `delivered_elsewhere` because both say the same thing about this run: the
 * criterion is not being re-delivered here, and an existing delivery is what
 * it rests on. `pending_reaffirmation` cannot reach a launch — plan lint
 * refuses to propose while one stands — so it has no mapping to invent.
 */
function deliveryPlanRunDispositions(
  document: DeliveryPlanDocument,
): DeliveryPlanLaunchCandidate["dispositions"] {
  return document.dispositions.flatMap((entry) => {
    const disposition: SpecCriterionDisposition | null =
      entry.disposition === "selected"
        ? "in_scope"
        : entry.disposition === "deferred"
          ? "deferred"
          : entry.disposition === "waived"
            ? "waived"
            : entry.disposition === "delivered_elsewhere" ||
                entry.disposition === "reaffirmed"
              ? "delivered_elsewhere"
              : null;
    return disposition === null
      ? []
      : [
          {
            criterionElementId: entry.criterionElementId,
            disposition,
            deliveredByExecutionId: entry.deliveredByExecutionId,
          },
        ];
  });
}

/**
 * The run's scope, read off the plan rather than off a scope file: the plan IS
 * the scope (design §4), so a DPA launch takes no `--file`. Task selections are
 * empty because a delivery plan's tasks are graph tasks authored in the plan,
 * not evergreen task elements.
 */
function deliveryPlanExecutionScope(
  document: DeliveryPlanDocument,
): ExecutionScope {
  const dispositions = deliveryPlanRunDispositions(document);
  return {
    selectedTaskIds: [],
    selectedCriterionIds: dispositions
      .filter((entry) => entry.disposition === "in_scope")
      .map((entry) => entry.criterionElementId),
    exclusionDispositions: dispositions.flatMap((entry) =>
      entry.disposition === "in_scope"
        ? []
        : [
            {
              criterionId: entry.criterionElementId,
              disposition: entry.disposition,
            },
          ],
    ),
  };
}

/**
 * The dial makes this a human act and an agent asked for it. It names Studio
 * rather than a `cctl` verb because there is no agent-side act that can
 * substitute — telling the agent to retry differently would be a dead end.
 */
function agentSignOffRefusal(
  spec: Spec,
  attempt: SpecDeliveryPlanAttemptRow,
  dial: string,
): Refusal {
  return {
    code: "human_act_required",
    unmetConditions: [
      `The execution_start dial is ${dial} for ${spec.slug}, so signing off delivery plan attempt ${attempt.id} is a human act.`,
    ],
    instruction: `Nothing was approved. Ask for the approval with \`cctl spec request-approval ${spec.slug} --gate execution_start\`; a human signs the candidate off in Spec Studio, which also admits the execution_start gate.`,
    details: { attemptId: attempt.id, executionStartDial: dial },
  };
}

function snapshotView(
  snapshot: SpecDeliveryPlanSnapshotRow,
): DeliveryPlanSnapshotView {
  return {
    id: snapshot.id,
    draftRevision: snapshot.draft_revision,
    planHash: snapshot.plan_hash,
    proposedAt: snapshot.proposed_at,
  };
}

function unknownSnapshotRefusal(
  spec: Spec,
  attempt: SpecDeliveryPlanAttemptRow,
  snapshotIds: readonly string[],
): Refusal {
  return {
    code: "not_found",
    unmetConditions: [
      `Delivery plan attempt ${attempt.id} did not freeze both of the snapshots ${snapshotIds.join(" and ")}.`,
    ],
    instruction: `Nothing was compared. List the attempt's frozen snapshots with \`cctl spec plan status ${spec.slug}\` and name two of them.`,
    details: { attemptId: attempt.id, snapshotIds: [...snapshotIds] },
  };
}

/**
 * Every reaffirmation refusal names both the act that IS available and the id
 * it addresses, because a reviewer told only "refused" is back in the dead end
 * this workstream exists to remove (`refusals-name-remedy`).
 */
function agentReaffirmationRefusal(
  spec: Spec,
  attempt: SpecDeliveryPlanAttemptRow,
): Refusal {
  return {
    code: "human_act_required",
    unmetConditions: [
      `Reaffirming a soft-stale criterion on delivery plan attempt ${attempt.id} is a human judgment; an agent cannot attest to it for itself.`,
    ],
    instruction: `Nothing was written. A human reaffirms the criterion in Spec Studio on the ${spec.slug} delivery-plan surface, or the plan sets it to selected with \`cctl spec plan edit ${spec.slug}\` to re-deliver it.`,
    details: { attemptId: attempt.id },
  };
}

function reaffirmOutsideDraftRefusal(
  spec: Spec,
  attempt: SpecDeliveryPlanAttemptRow,
): Refusal {
  return {
    code: "plan_status_conflict",
    unmetConditions: [
      `Delivery plan attempt ${attempt.id} is ${attempt.status}, and a disposition lives in the editable document.`,
    ],
    instruction: `Nothing was written. Reopen the attempt with \`cctl spec plan reopen ${spec.slug} --reason "<why>"\`, reaffirm the criterion, then re-propose with \`cctl spec plan propose ${spec.slug}\`.`,
    details: { attemptId: attempt.id, status: attempt.status },
  };
}

function unknownCriterionRefusal(
  spec: Spec,
  attempt: SpecDeliveryPlanAttemptRow,
  criterionElementId: string,
): Refusal {
  return {
    code: "not_found",
    unmetConditions: [
      `Delivery plan attempt ${attempt.id} disposes no criterion ${criterionElementId} against pinned revision ${attempt.pinned_revision_id}.`,
    ],
    instruction: `Nothing was written. Re-read the attempt with \`cctl spec plan status ${spec.slug}\` and name a criterion it carries.`,
    details: { attemptId: attempt.id, criterionElementId },
  };
}

function notSoftStaleRefusal(
  spec: Spec,
  attempt: SpecDeliveryPlanAttemptRow,
  graded: DeliveryDeltaCriterion,
): Refusal {
  return {
    code: "invalid_scope",
    unmetConditions: [
      `${graded.handle} (${graded.criterionElementId}) is ${graded.class}, and only a soft_stale criterion can be reaffirmed.`,
    ],
    instruction:
      graded.class === "hard_stale"
        ? `Nothing was written. Its text or validation strategy changed, so select it and re-prove it with \`cctl spec plan edit ${spec.slug}\`.`
        : `Nothing was written. Give ${graded.handle} the disposition its class allows with \`cctl spec plan edit ${spec.slug}\`.`,
    details: {
      attemptId: attempt.id,
      criterionElementId: graded.criterionElementId,
      deliveryClass: graded.class,
    },
  };
}

/**
 * The caller named a candidate the attempt does not carry. Both identities are
 * printed because the recovery depends on which moved: a stale read re-reads
 * the preview, while a candidate re-proposed underneath needs a fresh sign-off
 * of the bytes that exist now.
 */
function candidateIdentityRefusal(
  slug: string,
  attemptId: string,
  stated: DeliveryPlanCandidateIdentity,
  stored: DeliveryPlanCandidateIdentity | null,
): Refusal {
  return {
    code: "integrity_mismatch",
    unmetConditions: [
      stored === null
        ? `Delivery plan attempt ${attemptId} has no stored compiled candidate to act on.`
        : `Delivery plan attempt ${attemptId} stores candidate ${stored.candidateId} (plan ${stored.planHash}, compiled ${stored.compiledDefinitionHash}), not the named candidate ${stated.candidateId} (plan ${stated.planHash}, compiled ${stated.compiledDefinitionHash}).`,
    ],
    instruction:
      stored === null
        ? `Nothing was written. Freeze a candidate with \`cctl spec plan propose ${slug}\`, read it with \`cctl spec plan preview ${slug} --stage proposed\`, and approve exactly those bytes.`
        : `Nothing was written. Re-read the stored candidate with \`cctl spec plan preview ${slug} --stage proposed\` and approve compiled hash ${stored.compiledDefinitionHash}, or re-run \`cctl spec plan propose ${slug}\` and approve the candidate it stores.`,
    details: {
      attemptId,
      statedCandidateId: stated.candidateId,
      statedCompiledDefinitionHash: stated.compiledDefinitionHash,
      ...(stored === null
        ? {}
        : {
            storedCandidateId: stored.candidateId,
            storedCompiledDefinitionHash: stored.compiledDefinitionHash,
          }),
    },
  };
}

/**
 * A start with nothing approved. The refusal names the exact next act in the
 * open/propose/sign-off chain rather than "the plan is not approved", because
 * which act is owed depends on where the attempt actually stands.
 */
export function prematureStartRefusal(
  slug: string,
  attempt: SpecDeliveryPlanAttemptRow,
  stored: DeliveryPlanCandidateIdentity | null,
  prelaunch: DeliveryPlanPrelaunch | null,
): Refusal {
  const nextAct =
    stored === null
      ? `Freeze the draft with \`cctl spec plan propose ${slug}\`, then sign the candidate off with \`cctl spec plan sign-off ${slug}\`.`
      : `Sign candidate ${stored.candidateId} (compiled ${stored.compiledDefinitionHash}) off with \`cctl spec plan sign-off ${slug}\` — read it first with \`cctl spec plan preview ${slug} --stage proposed\`.`;
  // An attempt that was parked and then tuned is the case where the caller has
  // already reviewed something: naming only the current hash would leave them
  // unable to see what the re-approval replaces (design §5).
  const parkedTuning =
    prelaunch === null ||
    stored === null ||
    prelaunch.candidate.compiledDefinitionHash === stored.compiledDefinitionHash
      ? []
      : [
          `This attempt was parked for prelaunch review at compiled hash ${prelaunch.candidate.compiledDefinitionHash} and now carries compiled hash ${stored.compiledDefinitionHash}.`,
        ];
  return {
    code: "gate_blocked",
    unmetConditions: [
      `Delivery plan attempt ${attempt.id} is ${attempt.status} and carries no approval, so there is no approved candidate to launch.`,
      ...parkedTuning,
    ],
    instruction: `Nothing was started. ${nextAct}`,
    details: {
      attemptId: attempt.id,
      status: attempt.status,
      ...(stored === null ? {} : { candidateId: stored.candidateId }),
      ...(prelaunch === null
        ? {}
        : {
            parkedCompiledDefinitionHash:
              prelaunch.candidate.compiledDefinitionHash,
          }),
      ...(stored === null
        ? {}
        : { currentCompiledDefinitionHash: stored.compiledDefinitionHash }),
    },
  };
}

/**
 * The approval on the attempt no longer names the candidate the attempt
 * carries — the parked-and-tuned case. Old and new compiled hashes are both
 * printed: without the old one the caller cannot tell what the re-approval is
 * replacing (design §5).
 */
export function reapprovalRefusal(
  slug: string,
  attempt: SpecDeliveryPlanAttemptRow,
  approval: DeliveryPlanApproval,
  stored: DeliveryPlanCandidateIdentity,
): Refusal {
  return {
    code: "gate_blocked",
    unmetConditions: [
      `Delivery plan attempt ${attempt.id} was approved at compiled hash ${approval.compiledDefinitionHash} (candidate ${approval.candidateId}), but now carries compiled hash ${stored.compiledDefinitionHash} (candidate ${stored.candidateId}).`,
    ],
    instruction: `Nothing was started. The tuning after the approval changed the candidate, so the new bytes need their own sign-off: read them with \`cctl spec plan preview ${slug} --stage proposed\` and sign off compiled hash ${stored.compiledDefinitionHash}.`,
    details: {
      attemptId: attempt.id,
      approvedCompiledDefinitionHash: approval.compiledDefinitionHash,
      currentCompiledDefinitionHash: stored.compiledDefinitionHash,
    },
  };
}

function alreadyLaunchedRefusal(
  slug: string,
  attempt: SpecDeliveryPlanAttemptRow,
): Refusal {
  return {
    code: "plan_status_conflict",
    unmetConditions: [
      `Delivery plan attempt ${attempt.id} already launched as execution ${attempt.launched_execution_id ?? "an execution"}.`,
    ],
    instruction: `Nothing was started. Read the run with \`cctl spec status ${slug}\`, capture a discovery for the next plan with \`cctl spec capture ${slug} --execution ${attempt.launched_execution_id ?? "<executionId>"}\`, or abandon it with \`cctl spec abandon ${slug} --execution ${attempt.launched_execution_id ?? "<executionId>"}\`.`,
    details: {
      attemptId: attempt.id,
      launchedExecutionId: attempt.launched_execution_id,
    },
  };
}

/**
 * The prelaunch inventory: what was parked, and whether the candidate has
 * moved since. `candidateChanged` is computed here at read time from the two
 * immutable identities rather than persisted (`computed-projections`), which
 * is what lets a receipt state old and new hashes side by side after a reopen
 * has already cleared the approval that named the old one.
 */
function prelaunchView(
  attempt: SpecDeliveryPlanAttemptRow,
  candidate: SpecDeliveryPlanCandidateRow | null,
): DeliveryPlanView["prelaunch"] {
  const prelaunch = readPrelaunch(attempt);
  if (prelaunch === null) return null;
  const currentCompiledDefinitionHash =
    candidate?.compiled_definition_hash ?? null;
  return {
    parkedAt: prelaunch.parkedAt,
    parkedBy: prelaunch.parkedBy,
    reason: prelaunch.reason,
    approvedAtPark: prelaunch.approvedAtPark,
    parkedCandidateId: prelaunch.candidate.candidateId,
    parkedPlanHash: prelaunch.candidate.planHash,
    parkedCompiledDefinitionHash: prelaunch.candidate.compiledDefinitionHash,
    currentCompiledDefinitionHash,
    candidateChanged:
      currentCompiledDefinitionHash !==
      prelaunch.candidate.compiledDefinitionHash,
  };
}

function dispositionCounts(
  document: DeliveryPlanDocument,
): { disposition: DeliveryPlanDisposition; count: number }[] {
  const counts = new Map<DeliveryPlanDisposition, number>();
  for (const entry of document.dispositions) {
    counts.set(entry.disposition, (counts.get(entry.disposition) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([disposition, count]) => ({ disposition, count }))
    .sort((left, right) => left.disposition.localeCompare(right.disposition));
}

/**
 * The criteria whose disposition still owes an act. `pending_reaffirmation` is
 * the whole list today, and it is enumerated separately from the lint findings
 * because it is a worklist a human works through, not a sentence that refuses
 * a transition.
 */
function unresolvedDispositions(
  document: DeliveryPlanDocument,
  pinnedCriteria: readonly PlanLintCriterion[],
): DeliveryPlanUnresolvedView[] {
  const handles = new Map(
    pinnedCriteria.map((criterion) => [
      criterion.criterionElementId,
      criterion.handle,
    ]),
  );
  return document.dispositions
    .filter((entry) => entry.disposition === "pending_reaffirmation")
    .map((entry) => ({
      criterionElementId: entry.criterionElementId,
      handle: handles.get(entry.criterionElementId) ?? entry.criterionElementId,
      disposition: entry.disposition,
      resolution:
        "Reaffirm it in Spec Studio (the audited human act), or set it to selected to re-deliver it.",
    }))
    .sort((left, right) => left.handle.localeCompare(right.handle));
}

function nextAct(
  attempt: SpecDeliveryPlanAttemptRow,
  spec: Spec,
  health: DraftHealth,
): DeliveryPlanNextAct {
  switch (attempt.status) {
    case "draft":
      return health.blocking === 0
        ? {
            actor: "agent",
            command: `cctl spec plan propose ${spec.slug}`,
            reason: "Nothing in the draft refuses a proposal.",
          }
        : {
            actor: "agent",
            command: `cctl spec plan edit ${spec.slug} --file <plan.json>`,
            reason: `${health.blocking} finding${health.blocking === 1 ? "" : "s"} refuse propose; \`cctl spec plan status ${spec.slug}\` lists them.`,
          };
    case "proposed": {
      const dial = resolveDial(spec.gatePolicy, "execution_start");
      return dialRequiresHumanApproval(dial)
        ? {
            actor: "human",
            command: `cctl spec plan sign-off ${spec.slug}`,
            reason:
              "A human signs the frozen candidate off — one act that approves these bytes and admits the execution_start gate. `cctl spec plan reopen` takes it back to draft.",
          }
        : {
            actor: "agent",
            command: `cctl spec plan sign-off ${spec.slug}`,
            reason: `The execution_start dial is ${dial}, so signing the candidate off records a policy-basis admission rather than a human approval.`,
          };
    }
    case "approved":
      return {
        actor: "agent",
        command: `cctl spec start ${spec.slug}`,
        reason:
          "The approved candidate launches exactly as previewed; `cctl spec start --park` holds it for prelaunch review instead.",
      };
    case "parked": {
      // Parking accepts an unapproved proposal, because prelaunch review is
      // where the missing approval gets decided. Pointing such an attempt at
      // `spec start` would send the caller straight into the premature-start
      // refusal, so the owed act is the sign-off it still lacks.
      if (attempt.approval_json !== null) {
        return {
          actor: "agent",
          command: `cctl spec start ${spec.slug}`,
          reason:
            "The candidate is parked for prelaunch review: start it when the review is done, or `cctl spec plan reopen` to tune it, which invalidates its approval.",
        };
      }
      const dial = resolveDial(spec.gatePolicy, "execution_start");
      return dialRequiresHumanApproval(dial)
        ? {
            actor: "human",
            command: `cctl spec plan sign-off ${spec.slug}`,
            reason:
              "This candidate is parked for review but carries no approval, so a launch would refuse: a human signs the parked bytes off, and `cctl spec start` then runs them.",
          }
        : {
            actor: "agent",
            command: `cctl spec plan sign-off ${spec.slug}`,
            reason: `This candidate is parked for review but carries no approval, so a launch would refuse. The execution_start dial is ${dial}, so signing it off records a policy-basis admission.`,
          };
    }
    case "launched":
      return {
        actor: "agent",
        command: `cctl spec capture ${spec.slug} --execution ${attempt.launched_execution_id ?? "<executionId>"} --file <task.json>`,
        reason:
          "The plan is running, so its scope is pinned: capture a discovery for the next plan, abandon the run, or amend the live definition.",
      };
    case "abandoned":
      return {
        actor: "agent",
        command: OPEN_ACT(spec.slug),
        reason: "This attempt is history; a fresh one seeds from the last one.",
      };
  }
}

function noAttemptRefusal(slug: string): Refusal {
  return {
    code: "not_found",
    unmetConditions: [`Spec ${slug} has no delivery plan attempt.`],
    instruction: `Open one with \`${OPEN_ACT(slug)}\`, or with \`cctl spec plan open ${slug}\` to author from an empty plan.`,
  };
}

/**
 * The attempt names a revision that cannot be read. The plan is not re-pinned
 * to whatever is current — that would silently move its scope — so the refusal
 * names the pin and points at the integrity report instead.
 */
function unreadablePinRefusal(
  attempt: SpecDeliveryPlanAttemptRow,
  slug: string,
): Refusal {
  return {
    code: "integrity_mismatch",
    unmetConditions: [
      `Delivery plan attempt ${attempt.id} pins revision ${attempt.pinned_revision_id}, which cannot be read.`,
    ],
    instruction: `Nothing was read. This plan's scope is fixed to revision ${attempt.pinned_revision_id} and is never re-pinned to a newer one. Run \`cctl spec verify ${slug}\` to report the damaged revision, or abandon this attempt and open a replacement with \`${OPEN_ACT(slug)}\`.`,
    details: {
      attemptId: attempt.id,
      pinnedRevisionId: attempt.pinned_revision_id,
    },
  };
}

function noProposalRefusal(
  attempt: SpecDeliveryPlanAttemptRow,
  spec: Spec,
): Refusal {
  return {
    code: "plan_status_conflict",
    unmetConditions: [
      `Delivery plan attempt ${attempt.id} is ${attempt.status} and has frozen no proposal, so there is no stored candidate to read.`,
    ],
    instruction: `Preview the editable draft with \`cctl spec plan preview ${spec.slug} --stage draft\`, or freeze one with \`cctl spec plan propose ${spec.slug}\` and re-run this command.`,
    details: { attemptId: attempt.id, status: attempt.status },
  };
}

/**
 * A proposal exists but its compiled candidate does not. Nothing is recompiled
 * to paper over it: the bytes an approval would have bound to are gone, so the
 * only honest recovery is a reopen and a fresh propose (`exact-approval`).
 */
function missingCandidateRefusal(
  attempt: SpecDeliveryPlanAttemptRow,
  spec: Spec,
  snapshotId: string,
): Refusal {
  return {
    code: "integrity_mismatch",
    unmetConditions: [
      `Delivery plan snapshot ${snapshotId} has no stored compiled candidate.`,
    ],
    instruction: `Nothing was compiled — a preview never re-materializes a proposal, because recompiled bytes are not the bytes anyone approved. Return the attempt to draft with \`cctl spec plan reopen ${spec.slug}\` and re-run \`cctl spec plan propose ${spec.slug}\` to compile a fresh candidate.`,
    details: { attemptId: attempt.id, snapshotId },
  };
}

/**
 * The legacy plan named by an execution cannot be read as a plan. Nothing is
 * opened, because an unseeded attempt would silently claim this spec has no
 * delivery behind it.
 */
function damagedLegacySourceRefusal(
  spec: Spec,
  error: LegacyDeliverySourceDamagedError,
): Refusal {
  return {
    code: "integrity_mismatch",
    unmetConditions: [
      `The last legacy delivery of ${spec.slug} — execution ${error.executionId}, revision ${error.revisionId} — cannot be read: ${error.problem}.`,
    ],
    instruction: `Nothing was opened. Run \`cctl spec verify ${spec.slug}\` to report revision ${error.revisionId}, or open an unseeded attempt with \`cctl spec plan open ${spec.slug}\` to author from an empty plan instead.`,
    details: {
      executionId: error.executionId,
      revisionId: error.revisionId,
    },
  };
}

/**
 * The seeded document has to satisfy the attempt's own bounds BEFORE the row
 * is written: an approved revision's titles and instructions are unbounded, so
 * a legal evergreen plan can exceed them, and committing first would leave an
 * active attempt and its audit event behind a failure the author only meets
 * later, at projection time.
 */
function seededDocumentRefusal(
  spec: Spec,
  legacyImport: DeliveryPlanLegacyImportView | null,
  error: z.ZodError,
): Refusal {
  const where = error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .slice(0, 5);
  const provenance =
    legacyImport === null
      ? `The plan seeded from the last delivery of ${spec.slug}`
      : `The plan imported from legacy execution ${legacyImport.sourceExecutionId} (revision ${legacyImport.sourceRevisionId})`;
  return {
    // The same family as a legacy plan that cannot be imported: the source the
    // attempt was seeded from does not fit what an attempt can hold.
    code: "integrity_mismatch",
    unmetConditions: [
      `${provenance} does not fit the delivery-plan document bounds: ${where.join("; ")}.`,
    ],
    instruction: `Nothing was opened. Open an unseeded attempt with \`cctl spec plan open ${spec.slug}\` and author the plan from an empty document, or shorten the offending text in the source revision and re-run \`cctl spec plan open ${spec.slug} --seed-from last\`.`,
    ...(legacyImport === null
      ? {}
      : {
          details: {
            executionId: legacyImport.sourceExecutionId,
            revisionId: legacyImport.sourceRevisionId,
          },
        }),
  };
}

function legacyImportFailureRefusal(
  spec: Spec,
  source: LegacyDeliverySource,
  error: unknown,
): Refusal {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: "integrity_mismatch",
    unmetConditions: [
      `The legacy plan of execution ${source.executionId} (revision ${source.snapshot.revision.id}) could not be imported: ${reason}`,
    ],
    instruction: `Nothing was opened. Run \`cctl spec verify ${spec.slug}\` to report the damaged revision ${source.snapshot.revision.id}, or open an unseeded attempt with \`cctl spec plan open ${spec.slug}\` and author the plan from an empty document.`,
    details: {
      executionId: source.executionId,
      revisionId: source.snapshot.revision.id,
    },
  };
}

function noPinnedRevisionRefusal(slug: string): Refusal {
  return {
    code: "revision_not_approved",
    unmetConditions: [
      `Spec ${slug} has no approved revision for a plan to pin.`,
    ],
    instruction: `A delivery plan is authored against an approved revision. Run \`cctl spec status ${slug}\` to see what the current draft still owes, then retry.`,
  };
}

function attemptAlreadyOpenRefusal(
  attempt: SpecDeliveryPlanAttemptRow,
): Refusal {
  return {
    code: "plan_status_conflict",
    unmetConditions: [
      `Delivery plan attempt ${attempt.id} is ${attempt.status}.`,
    ],
    instruction: `Nothing was opened. Attempt ${attempt.id} is ${attempt.status}: edit it with \`cctl spec plan edit\`, return it to draft with \`cctl spec plan reopen\`, or read it with \`cctl spec plan status\`.`,
    details: { attemptId: attempt.id, status: attempt.status },
  };
}

/**
 * The repository's typed errors carried out as refusals with their remedy
 * intact. Every one of them already names the act available from that state,
 * so this maps rather than rewrites (`refusals-name-remedy`).
 */
function planFailure(
  error: unknown,
  slug: string,
): { ok: false; refusal: Refusal } {
  if (error instanceof StaleDeliveryPlanDraftError) {
    return {
      ok: false,
      refusal: {
        code: "stale_plan_draft",
        unmetConditions: [error.message],
        instruction: error.message,
        details: {
          attemptId: error.attemptId,
          expectedDraftRevision: error.expectedDraftRevision,
          currentDraftRevision: error.currentDraftRevision,
        },
      },
    };
  }
  if (error instanceof DeliveryPlanStatusConflictError) {
    return {
      ok: false,
      refusal: {
        code: "plan_status_conflict",
        unmetConditions: [error.message],
        instruction: error.remedy,
        details: { attemptId: error.attemptId, status: error.status },
      },
    };
  }
  if (error instanceof DeliveryPlanCandidateMismatchError) {
    return {
      ok: false,
      refusal: {
        code: "integrity_mismatch",
        unmetConditions: [error.message],
        instruction: error.message,
        details: {
          attemptId: error.attemptId,
          expectedPlanHash: error.expectedPlanHash,
          candidatePlanHash: error.candidatePlanHash,
        },
      },
    };
  }
  if (error instanceof DeliveryPlanApprovalIdentityMismatchError) {
    return {
      ok: false,
      refusal: candidateIdentityRefusal(
        slug,
        error.attemptId,
        error.stated,
        error.stored,
      ),
    };
  }
  if (error instanceof DeliveryPlanAttemptNotFoundError) {
    return { ok: false, refusal: noAttemptRefusal(slug) };
  }
  throw error;
}
