import { specDeliveryBasisSchema } from "./schemas";
import { createLogger } from "@/lib/logging";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import type { SpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";
import type { WriteQueue } from "@/lib/state-store/write-queue";
import type { GraphExecutionLifecycleContext } from "@/lib/workflow-graph/execution-lifecycle-port";
import type {
  GraphWorkflowAbandonment,
  GraphWorkflowExecutionOrigin,
  GraphWorkflowStatus,
  SeededWorkflowDocument,
} from "@/lib/workflow-graph/spec-bridge";
import {
  INITIAL_ABANDON_CLEANUP_PHASE,
  abandonFinalizationAllowed,
  nextAbandonCleanupStep,
  type AbandonCleanupAct,
  type LinkedWorkflowObservation,
} from "./abandon-coordinator";
import {
  liveDeliveryPlanAttempt,
  type FinalizedDeliveryPlanCandidateIdentity,
} from "./delivery-plan";
import type {
  DeliveryPlanLaunchCandidate,
  DeliveryPlanLaunchResolution,
  ParkDeliveryPlanServiceInput,
  PlanResult,
} from "./delivery-plan-service";
import { deliveryPlanCandidateHashFromBytes } from "./delivery-plan-hash";
import type { DeliveryPlanNextAct } from "./delivery-plan-views";
import {
  danglingReferenceRefusal,
  guardedElements,
  stageRevisionWrite,
  validateStagedWrite,
} from "./element-write-guard";
import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import {
  prepareSpecExecutionStartAttachment,
  type SpecExecutionStartAttachment,
} from "./execution-start-attachment";
import { specExecutionBindingSnapshotV2Schema } from "./execution-binding";
import { resolveSpecExecutionByWorkflowId } from "./execution-id-resolution";
import type { SpecMeasureEventPayload } from "./measures";
import { resolveDial } from "./policy";
import type { SpecApprovalRequestsClosedNotice } from "./attention-records";
import {
  recordPolicyGateAdmissionInTransaction,
  type SpecExecutionGateAdmissionNotifier,
  type SpecPolicyAdmissionNotice,
} from "./policy-admissions";
import {
  specGateDialSchema,
  type ActorProvenance,
  type Refusal,
  type Spec,
  type DiscoveredTask,
  type SpecDeliveryPlanAttemptRow,
  type SpecExecutionCleanupPhase,
  type SpecExecutionRow,
  type SpecRevisionSnapshot,
  type SpecWorkflowLaneStatus,
} from "./schemas";
import { executionScopeSchema } from "./scope-validation";
import type { TransitionRefusal } from "./transitions";

const logger = createLogger("specs.execution-service");

export interface ExecutionServiceDeps {
  specsRepo: SpecsRepo;
  deliveryRepo: SpecDeliveryRepo;
  bindingRepo: SpecExecutionBindingRepo;
  linksRepo: SpecLinksRepo;
  eventsRepo: SpecEventsRepo;
  /**
   * Gate-admission bookkeeping: policy-admitted transitions (Notify/Off
   * dials) land as `spec_gate_admissions` rows with a policy basis so the
   * admission record is complete regardless of dial (R10.2, R11.2).
   */
  reviewRepo: Pick<
    SpecReviewRepo,
    "insertGateAdmission" | "findGateAdmissionsByRevision"
  >;
  events: SpecEventsPublisher;
  writeQueue: WriteQueue;
  nextId(
    kind:
      | "execution"
      | "link"
      | "revision"
      | "element"
      | "admission"
      | "discovery",
  ): string;
  now(): string;
  /**
   * Whether the named session resolves in this project. Launch and merge are
   * both session-scoped, so the pin is validated before it is persisted.
   */
  sessionExists(sessionName: string): Promise<boolean>;
  getWorkflowExecutionStatus(
    workflowExecutionId: string,
  ): Promise<SpecWorkflowLaneStatus | null>;
  getPublishedMergeBySpecExecutionId(
    specExecutionId: string,
  ): Promise<{ mergeHash: string; deliveryGatePassed: boolean } | null>;
  getPublishedMerge(workflowExecutionId: string): Promise<{
    mergeHash: string;
    deliveryGatePassed: boolean;
  } | null>;
  runInImmediateTransaction<T>(fn: () => T): T;
  /** The production one-off graph-launch seam, injected at composition. */
  executionStartGate?: ExecutionStartGatePort;
  /**
   * Post-hoc review notices for Notify-dial policy admissions (R11.2), and
   * the closing of the requests such an admission answers (#108).
   */
  policyNotifier?: SpecExecutionGateAdmissionNotifier;
  /**
   * Abandoning an execution or spec resolves its open spec attention rows so
   * Needs You never shows requests for a terminal run (R19.3). Scope
   * "execution" clears only execution-scoped requests (execution_start,
   * delivery, waivers); authoring-gate requests for a revision still in
   * review survive execution abandonment (R3.6 concurrent authoring).
   */
  attentionNotifier?: SpecAttentionNotifier;
  /**
   * The forward half of the spec↔workflow handoff. `executionAborted` reports
   * a workflow abort INTO the spec side; this port drives the workflow FROM
   * it. Abandonment needs the forward direction: without it `spec abandon
   * --execution` leaves the run it launched holding the session's execution
   * slot, and every `cctl validate` call in that session stays refused
   * (ticket #47 note 9e5ba960).
   *
   * Optional because compositions with no workflow side exist; a linked run
   * with no port wired is refused, never silently stranded.
   */
  workflowCleanup?: SpecWorkflowCleanupPort;
  /**
   * The delivery-plan attempt a spec launches from. Production compositions
   * always wire it; a composition without the port refuses start explicitly.
   */
  deliveryPlanLaunch?: SpecDeliveryPlanLaunchPort;
  /**
   * The plan side of a blocking capture. Separate from `deliveryPlanLaunch`
   * because it runs at the other end of a run's life, and optional for the
   * same reason: a composition with no plan surface still captures a durable
   * discovery, it just cannot open the replacement itself.
   */
  deliveryPlanCapture?: SpecDeliveryPlanCapturePort;
  /**
   * Delivery-plan attempts and their discoveries. Capture reads the attempt
   * to decide whether there is a launched run at all, and writes the
   * discovery it records.
   */
  plansRepo: Pick<
    SpecDeliveryPlanRepo,
    | "findAttemptById"
    | "findAttemptsBySpecId"
    | "recordDiscovery"
    | "recordTransition"
  >;
}

/**
 * The replacement a blocking capture opens. It goes through the same seeded
 * open `cctl spec plan open` performs, so the discovery is
 * placed by the one seed that knows how (design §11).
 */
export interface SpecDeliveryPlanCapturePort {
  abandonLaunchedAttempt(input: {
    spec: Spec;
    executionId: string;
    reason: string;
    actor: ActorProvenance;
  }): Promise<PlanResult<{ attemptId: string }>>;
  openSeededReplacement(input: {
    spec: Spec;
    actor: ActorProvenance;
  }): Promise<PlanResult<{ attemptId: string }>>;
}

/**
 * The delivery-plan side of a spec launch. It is a port rather than a direct
 * dependency because the plan service composes over the same repositories this
 * one does, and the two are created in one factory — the seam keeps the
 * direction one-way (execution asks the plan; the plan never asks back).
 */
export interface SpecDeliveryPlanLaunchPort {
  resolveLaunch(input: { spec: Spec }): Promise<DeliveryPlanLaunchResolution>;
  park(
    input: ParkDeliveryPlanServiceInput,
  ): Promise<PlanResult<{ nextAct: DeliveryPlanNextAct }>>;
}

/** The pinned cleanup target — never re-resolved from the session's slot. */
export interface SpecWorkflowCleanupTarget {
  projectPath: string;
  sessionName: string;
  workflowExecutionId: string;
}

/**
 * Where the pinned run stands. `leaseHeld` is the live-work answer: an
 * `aborted` record still physically in the active row holds nothing, while a
 * resumably halted one is work the coordinator must not step over.
 */
export type SpecWorkflowCleanupObservation =
  | { kind: "missing" }
  | { kind: "archived"; status: GraphWorkflowStatus }
  | { kind: "active"; status: GraphWorkflowStatus; leaseHeld: boolean };

/**
 * Whether the named act actually took effect. `ok: false` is the honest answer
 * when the pinned run no longer owns the slot or the lifecycle contract refused
 * it — the coordinator must never record a completed phase over a no-op.
 */
export type SpecWorkflowCleanupOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export interface SpecWorkflowCleanupPort {
  /**
   * Re-resolved at every phase — and again before `abandoned` — so a retry
   * sees the world as it is now rather than as the previous attempt left it.
   */
  observe(
    target: SpecWorkflowCleanupTarget,
  ): Promise<SpecWorkflowCleanupObservation>;
  /**
   * Abort the pinned run through the production workflow abort seam. `aborted`
   * releases the lease automatically, so no separate release step exists to
   * leave half-done.
   */
  abort(
    target: SpecWorkflowCleanupTarget & { reason: string },
  ): Promise<SpecWorkflowCleanupOutcome>;
  /**
   * End a resumably halted run through the audited abandon act instead. Abort
   * would answer the lease just as well, and that is precisely the mistake:
   * it rewrites the run's final engine state to `aborted`, while abandon
   * preserves the halt reason and records who ended the tenure and why (R4).
   */
  abandon(
    target: SpecWorkflowCleanupTarget & {
      reason: string;
      actor: GraphWorkflowAbandonment["actor"];
    },
  ): Promise<SpecWorkflowCleanupOutcome>;
}

export interface SpecAttentionClearInput {
  specId: string;
  scope: "execution" | "spec";
  reason: string;
  occurredAt: string;
}

export interface SpecAttentionNotifier {
  specAttentionCleared(input: SpecAttentionClearInput): void;
}

export interface DefinitionGateRefusal {
  code: string;
  unmetConditions: string[];
  instruction: string;
}

/** A run parked awaiting definition approval, as this domain finds it. */
export interface PendingDefinitionApproval {
  executionId: string;
  /** What the parked run records about where it came from. */
  origin: GraphWorkflowExecutionOrigin;
}

/**
 * Whether a park found by session is the run this spec execution is waiting to
 * start.
 *
 * The session's lease says only that SOME run holds it. Approving execution A
 * while unrelated run B holds the park would start B and leave A unapproved, so
 * the two are correlated the same way the lifecycle callbacks correlate an
 * admission: by the link once one exists, and otherwise by the compiled
 * definition the execution pins against the origin the park recorded. A one-off
 * park pins no definition and therefore never belongs to a spec execution.
 */
export function parkBelongsToExecution(
  park: PendingDefinitionApproval,
  execution: SpecExecutionRow,
): boolean {
  if (execution.workflow_execution_id !== null) {
    return execution.workflow_execution_id === park.executionId;
  }
  if (park.origin.kind !== "template") return false;
  return (
    park.origin.definitionId === execution.workflow_definition_id &&
    park.origin.definitionRevision === execution.workflow_definition_revision
  );
}

export interface ExecutionStartGatePort {
  /**
   * Launch a signed candidate's graph through the production spec-delivery
   * start+kickoff seam.
   *
   * `ownerConversationId` is the authenticated conversation that ran
   * `spec start`, resolved server-side by the caller and threaded to the
   * persisted execution so validation can resolve it before any lane exists.
   */
  launchApprovedLaunch(input: {
    projectName: string;
    sessionName: string;
    definitionId: string;
    definitionRevision: number;
    specSlug: string;
    candidateId: string;
    ownerConversationId: string | null;
    parameters?: Record<string, unknown>;
    transactionAttachment(context: { executionId: string }): void;
    /**
     * The pinned spec revision, rendered by the spec layer and handed to the
     * workflow engine as opaque bytes to seed into every lane worktree. The
     * plan's #1-ranked source of truth is only readable because this rides
     * along with the launch.
     */
    seededDocuments: readonly SeededWorkflowDocument[];
  }): Promise<
    | {
        ok: true;
        workflowExecutionId: string;
        resolvedDefinitionHash: string;
      }
    | { ok: false; reason: string; code?: "validation" }
  >;
}

/**
 * The review seam the lifecycle callbacks use when the workflow side reports
 * a parked or approved definition: `requestApproval` opens the durable Needs
 * You request for the waiting execution-start gate; `grantApproval` records
 * the execution-scoped human approval when the definition is approved from
 * the workflow surface (transport human-act enforcement is the caller's).
 */
export interface ExecutionLifecycleGatePort {
  requestApproval(input: {
    specId: string;
    revisionId: string;
    executionId: string;
    actor: ActorProvenance;
  }): Promise<void>;
  grantApproval(input: {
    specId: string;
    revisionId: string;
    executionId: string;
    actor: ActorProvenance;
    approver: string;
  }): Promise<
    | { ok: true; value: { id: string } }
    | { ok: false; refusal: TransitionRefusal }
  >;
}

export type ExecutionLifecycleDeps = Pick<
  ExecutionServiceDeps,
  | "specsRepo"
  | "deliveryRepo"
  | "bindingRepo"
  | "linksRepo"
  | "eventsRepo"
  | "reviewRepo"
  | "events"
  | "writeQueue"
  | "nextId"
  | "now"
  | "getPublishedMerge"
  | "getPublishedMergeBySpecExecutionId"
  | "runInImmediateTransaction"
  | "policyNotifier"
  | "attentionNotifier"
  | "workflowCleanup"
  | "deliveryPlanCapture"
> & {
  lifecycleGate?: ExecutionLifecycleGatePort;
};

export interface ExecutionLifecycleCallbacks {
  markRunning(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin: GraphWorkflowExecutionOrigin,
  ): Promise<void>;
  markDelivered(
    workflowExecutionId: string | undefined,
    mergeHash: string,
    specExecutionId?: string,
  ): Promise<void>;
  awaitingDefinitionApproval(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin: GraphWorkflowExecutionOrigin,
  ): Promise<void>;
  /**
   * A refusal MUST be write-free: the graph answers one by handing its
   * reservation back, which reopens the park to a rejection or an abort. Once
   * anything durable has been committed the only sound answer is to throw, so
   * the reservation is kept and the saga is finished forward instead.
   */
  admitDefinitionApproval(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin: GraphWorkflowExecutionOrigin,
  ): Promise<{ ok: true } | ({ ok: false } & DefinitionGateRefusal)>;
  /**
   * An aborted workflow can never deliver the immutable pin, so the linked
   * active spec execution abandons immediately on the system's authority —
   * the spec leaves "executing" without waiting for a read-path reconcile.
   */
  executionAborted(workflowExecutionId: string): Promise<void>;
}

export interface StartSpecExecutionInput {
  specId: string;
  revisionId: string;
  actor: ActorProvenance;
  sessionName: string | null;
  /** The project this launch runs in, for the workflow start seam. */
  projectName?: string;
  parameters?: Record<string, unknown>;
  /**
   * Hold a proposed or approved candidate for spec-side prelaunch review
   * instead of launching it. No workflow execution is created and no session
   * slot is taken, so a parked plan can never block session validation.
   */
  park?: boolean;
}

export type StartSpecExecutionResult =
  | {
      ok: true;
      execution: SpecExecutionRow;
      workflowDefinition: { id: string; revision: number };
      /** The pinned revision's number, so the receipt needs no second read. */
      revisionNumber: number;
      /**
       * The approved candidate this launch ran. The receipt prints it so
       * `exact-approval` is observable from the command that performed it.
       */
      deliveryPlan: {
        attemptId: string;
        candidateId: string;
        candidateHash: string;
        workflowExecutionId: string;
        resolvedDefinitionHash: string;
      };
    }
  | { ok: false; refusal: TransitionRefusal };

/** What `spec start --park` held; no execution was launched or reported. */
export interface ParkedDeliveryPlanResult {
  attemptId: string;
  candidateId: string;
  candidateHash: string;
  nextAct: DeliveryPlanNextAct;
}

export interface ExecutionService {
  start(input: StartSpecExecutionInput): Promise<StartSpecExecutionResult>;
  /**
   * Hold a proposed or approved candidate for spec-side prelaunch review.
   * Deliberately NOT an arm of `start`: parking launches nothing, so a result
   * that had to be narrowed before every `execution` read would make every
   * caller pay for a state most of them never reach.
   */
  parkDeliveryPlan(
    input: StartSpecExecutionInput,
  ): Promise<LifecycleResult<ParkedDeliveryPlanResult>>;
  linkWorkflowExecution(
    specExecutionId: string,
    workflowExecutionId: string,
  ): Promise<LifecycleResult<SpecExecutionRow>>;
  markRunning(
    workflowExecutionId: string,
  ): Promise<LifecycleResult<SpecExecutionRow | null>>;
  markDelivered(
    specExecutionId: string,
    mergeHash: string,
  ): Promise<LifecycleResult<SpecExecutionRow>>;
  getStatus(
    specExecutionId: string,
  ): Promise<LifecycleResult<ReconciledSpecExecution>>;
  abandonExecution(
    input: AbandonExecutionInput,
  ): Promise<LifecycleResult<SpecExecutionRow>>;
  retireDelivery(
    input: AbandonExecutionInput & { specId: string },
  ): Promise<LifecycleResult<SpecExecutionRow>>;
  abandonSpec(input: AbandonSpecInput): Promise<LifecycleResult<Spec>>;
  captureScopeAmendment(
    input: CaptureScopeAmendmentInput,
  ): Promise<LifecycleResult<CapturedScopeAmendment>>;
}

export type LifecycleResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: TransitionRefusal };

/**
 * A reconciled run together with its linked lane's live status. The spec
 * execution stays `running` between workflow completion and the session's
 * delivering merge, so the row alone cannot tell "lanes are working" from
 * "everything finished; only the merge remains" — the status read reports
 * both so no caller has to re-derive the lane's position.
 */
export interface ReconciledSpecExecution {
  execution: SpecExecutionRow;
  /** Null when no lane is linked or the run is already terminal. */
  workflowStatus: SpecWorkflowLaneStatus | null;
}

export interface AbandonExecutionInput {
  executionId: string;
  reason: string;
  actor: ActorProvenance;
}

/**
 * Reconciliation abandons on the system's own authority (no human or agent
 * initiated the transition), so the internal path admits the system actor the
 * public API never accepts from callers.
 */
type AbandonExecutionInternalInput = Omit<AbandonExecutionInput, "actor"> & {
  actor: ActorProvenance | { kind: "system" };
};

export interface AbandonSpecInput {
  specId: string;
  reason: string;
  actor: ActorProvenance;
}

export interface CaptureScopeAmendmentInput {
  specId: string;
  /**
   * The run to capture against. Optional because the spec's live attempt
   * already knows which execution it launched; naming one addresses a run
   * whose spec the caller cannot name by slug.
   */
  executionId?: string;
  actor: ActorProvenance;
  discoveredTask: DiscoveredTask;
  blockingReason?: string;
}

export interface CapturedScopeAmendment {
  discovery: {
    id: string;
    executionId: string;
    /**
     * The id every receipt names and every verb accepts (design 3.5, D-B).
     * `executionId` beside it is the internal row id, kept as data for the
     * Spec Studio surfaces that already render it.
     */
    workflowExecutionId: string;
    /** Null when the run came from the legacy compiled path. */
    attemptId: string | null;
    title: string;
  };
  /** True when `--blocking-reason` retired the run the work was found in. */
  restartRequired: boolean;
  /** The blocking path's outcome: what it retired and what it opened. */
  replacement: {
    abandonedExecutionId: string;
    abandonedWorkflowExecutionId: string;
    replacementAttemptId: string;
  } | null;
}

export function createExecutionService(
  deps: ExecutionServiceDeps,
): ExecutionService {
  return {
    async start(input) {
      // The durable Needs You request for a Gate-dial start opens when the
      // compiled workflow actually parks awaiting definition approval (the
      // lifecycle port's awaitingDefinitionApproval report), not here — at
      // spec-start time there is no waiting workflow execution a grant could
      // unblock yet.
      const staged = await deps.writeQueue.withWriteQueue(
        `spec-execution-start[${input.specId}]`,
        async () => startWithinQueue(deps, cloneStartInput(input)),
      );
      if (staged.kind === "done") return staged.result;
      // Deliberately outside the write queue: the workflow start reports back
      // through the lifecycle port, which links and marks the spec execution
      // running through the SAME queue. Launching while holding it deadlocks.
      return completeDeliveryPlanLaunch(deps, staged.pending);
    },
    async parkDeliveryPlan(input) {
      return deps.writeQueue.withWriteQueue(
        `spec-execution-park[${input.specId}]`,
        async () => parkWithinQueue(deps, cloneStartInput(input)),
      );
    },
    linkWorkflowExecution(specExecutionId, workflowExecutionId) {
      return linkWorkflowExecution(deps, specExecutionId, workflowExecutionId);
    },
    markRunning(workflowExecutionId) {
      return markRunning(deps, workflowExecutionId);
    },
    markDelivered(specExecutionId, mergeHash) {
      return markDelivered(deps, specExecutionId, mergeHash);
    },
    getStatus(specExecutionId) {
      return reconcileStatus(deps, specExecutionId);
    },
    // `--execution` on both verbs takes the WORKFLOW execution id, resolved
    // here rather than deeper down: the internal callers below (reconciliation
    // and the capture path's own abandon) legitimately hold spec-side row ids,
    // and pushing the resolution inward would make the boundary accept both.
    async abandonExecution(input) {
      const resolved = resolveSpecExecutionByWorkflowId(
        deps,
        input.executionId,
      );
      if (!resolved.ok) return { ok: false, refusal: resolved.refusal };
      return abandonExecution(deps, {
        ...input,
        executionId: resolved.execution.id,
      });
    },
    async retireDelivery(input) {
      if (input.actor.kind !== "human")
        return lifecycleRefused(
          "human_act_required",
          ["Delivery continuation requires a human in Spec Studio."],
          "Open the delivery review in Spec Studio.",
        );
      const current = deps.deliveryRepo.findExecutionById(input.executionId);
      if (current?.spec_id !== input.specId)
        return lifecycleExecutionNotFound();
      return abandonExecution(deps, input);
    },
    abandonSpec(input) {
      return abandonSpec(deps, input);
    },
    async captureScopeAmendment(input) {
      if (input.executionId === undefined) {
        return captureScopeAmendment(deps, input);
      }
      const resolved = resolveSpecExecutionByWorkflowId(
        deps,
        input.executionId,
      );
      if (!resolved.ok) return { ok: false, refusal: resolved.refusal };
      return captureScopeAmendment(deps, {
        ...input,
        executionId: resolved.execution.id,
      });
    },
  };
}

/**
 * The readers the binding-authority decision is allowed to consult. It names
 * no execution lookup keyed on the workflow execution id, because that lookup
 * is exactly how a run without a binding used to be adopted: the row alone
 * cannot say which candidate it was launched from.
 */
export interface BoundSpecExecutionReaders {
  bindingRepo: Pick<
    SpecExecutionBindingRepo,
    "findByWorkflowExecutionId" | "requireByWorkflowExecutionId"
  >;
  deliveryRepo: Pick<SpecDeliveryRepo, "findExecutionById">;
}

/**
 * The spec execution a graph run is bound to, or null when it is not a
 * native-SDD run. The typed binding is the only authority: no binding, no
 * spec-bound behavior. A binding that names an execution which disagrees with
 * it is corruption, not a legacy shape, so it throws rather than degrading.
 */
export function resolveBoundSpecExecution(
  readers: BoundSpecExecutionReaders,
  workflowExecutionId: string,
): SpecExecutionRow | null {
  const unresolvedBinding =
    readers.bindingRepo.findByWorkflowExecutionId(workflowExecutionId);
  if (unresolvedBinding === null) return null;

  const linkedBinding =
    readers.bindingRepo.requireByWorkflowExecutionId(workflowExecutionId);
  const execution = readers.deliveryRepo.findExecutionById(
    linkedBinding.specExecutionId,
  );
  if (
    execution === null ||
    execution.workflow_execution_id !== workflowExecutionId ||
    execution.revision_id !== linkedBinding.binding.pinnedRevisionId
  ) {
    throw new Error(
      `Workflow execution ${workflowExecutionId} has a stale native-SDD execution link`,
    );
  }
  return execution;
}

export function createExecutionLifecycleCallbacks(
  deps: ExecutionLifecycleDeps,
): ExecutionLifecycleCallbacks {
  function findLinkedExecution(
    workflowExecutionId: string,
  ): SpecExecutionRow | null {
    return resolveBoundSpecExecution(deps, workflowExecutionId);
  }

  function findExecutionForWorkflow(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin: GraphWorkflowExecutionOrigin,
  ): SpecExecutionRow | null {
    // Every native-SDD run is a spec delivery launched from a signed
    // candidate. Any other origin cannot name a spec execution, so it is not
    // correlated at all rather than resolved through a second path.
    if (origin.kind !== "spec_delivery") return null;

    const unresolvedBinding =
      deps.bindingRepo.findByWorkflowExecutionId(workflowExecutionId);
    if (unresolvedBinding === null) return null;
    const linkedBinding = deps.bindingRepo.requireByWorkflowExecutionId(
      workflowExecutionId,
      { candidateId: origin.candidateId },
    );
    const execution = deps.deliveryRepo.findExecutionById(
      linkedBinding.specExecutionId,
    );
    const spec =
      execution === null
        ? null
        : deps.specsRepo.findByIdInTransaction(execution.spec_id);
    if (
      execution !== null &&
      spec !== null &&
      execution.workflow_execution_id === workflowExecutionId &&
      execution.revision_id === linkedBinding.binding.pinnedRevisionId &&
      execution.session_name === context.sessionName &&
      spec.projectPath === context.projectPath
    ) {
      return execution;
    }
    logger.warn("specs.execution.typed-workflow-correlation-refused", {
      projectPath: context.projectPath,
      sessionName: context.sessionName,
      workflowExecutionId,
      specExecutionId: linkedBinding.specExecutionId,
      candidateId: linkedBinding.binding.candidateId,
    });
    return null;
  }

  return {
    async markRunning(context, workflowExecutionId, origin) {
      const execution = findExecutionForWorkflow(
        context,
        workflowExecutionId,
        origin,
      );
      if (execution === null) return;
      if (execution !== null && execution.workflow_execution_id === null) {
        const linked = await linkWorkflowExecution(
          deps,
          execution.id,
          workflowExecutionId,
        );
        if (!linked.ok) {
          throw new Error(linked.refusal.unmetConditions.join(" "));
        }
      }
      const result = await markRunning(deps, workflowExecutionId);
      if (!result.ok) throw new Error(result.refusal.unmetConditions.join(" "));
    },
    async markDelivered(workflowExecutionId, mergeHash, specExecutionId) {
      const execution = specExecutionId
        ? deps.deliveryRepo.findExecutionById(specExecutionId)
        : workflowExecutionId
          ? findLinkedExecution(workflowExecutionId)
          : null;
      if (execution === null) return;
      const result = await markDelivered(deps, execution.id, mergeHash);
      if (!result.ok) throw new Error(result.refusal.unmetConditions.join(" "));
    },
    /**
     * A graph run parked awaiting approval links its immutable spec execution
     * and opens the durable Needs You request — the point where a human grant
     * has real waiting work to unblock (R10.9).
     */
    async awaitingDefinitionApproval(context, workflowExecutionId, origin) {
      const awaiting = findExecutionForWorkflow(
        context,
        workflowExecutionId,
        origin,
      );
      if (awaiting === null) return;
      if (awaiting.workflow_execution_id === null) {
        const linked = await linkWorkflowExecution(
          deps,
          awaiting.id,
          workflowExecutionId,
        );
        if (!linked.ok) {
          throw new Error(linked.refusal.unmetConditions.join(" "));
        }
      }
      await deps.lifecycleGate?.requestApproval({
        specId: awaiting.spec_id,
        revisionId: awaiting.revision_id,
        executionId: awaiting.id,
        actor: {
          kind: "agent",
          conversationId: `workflow:${workflowExecutionId}`,
        },
      });
    },
    /**
     * A human approving the definition from the workflow surface is the same
     * human execution-start act Spec Studio records: grant the execution-
     * scoped approval (spec approval + gate admission + durable event +
     * notification grant) before the workflow side records its approval, or
     * refuse machine-readably so the run cannot start unadmitted (R10.2,
     * R11.2). Definitions this domain did not prepare admit by default.
     *
     * Every REFUSAL is taken before the first durable write, because the graph
     * answers a refusal by releasing its reservation and reopening the park:
     * a refusal reported after this domain had written would leave those
     * records on a run the next rejection can end. So the grant — which refuses
     * write-free — goes first, and the backstop link (normally already made at
     * park time) follows it. A link that then fails THROWS rather than refusing,
     * because the human grant behind it is already durable.
     */
    async admitDefinitionApproval(context, workflowExecutionId, origin) {
      const execution = findExecutionForWorkflow(
        context,
        workflowExecutionId,
        origin,
      );
      if (execution === null) return { ok: true };
      if (execution.state === "abandoned" || execution.state === "delivered") {
        return {
          ok: false,
          code: "gate_blocked",
          unmetConditions: [
            `The linked spec execution is terminal (${execution.state}).`,
          ],
          instruction: await seededDeliveryPlanInstruction(
            deps,
            execution.spec_id,
          ),
        };
      }
      const gate = deps.lifecycleGate;
      if (gate === undefined) {
        return {
          ok: false,
          code: "gate_blocked",
          unmetConditions: [
            "The spec execution-start gate is unavailable in this composition.",
          ],
          instruction: "Approve execution start from Spec Studio instead.",
        };
      }
      const grant = await gate.grantApproval({
        specId: execution.spec_id,
        revisionId: execution.revision_id,
        executionId: execution.id,
        actor: { kind: "human" },
        approver: "operator",
      });
      if (!grant.ok) return definitionGateRefusal(grant.refusal);
      if (execution.workflow_execution_id === null) {
        const linked = await linkWorkflowExecution(
          deps,
          execution.id,
          workflowExecutionId,
        );
        if (!linked.ok) {
          throw new Error(linked.refusal.unmetConditions.join(" "));
        }
      }
      return { ok: true };
    },
    async executionAborted(workflowExecutionId) {
      const execution = findLinkedExecution(workflowExecutionId);
      if (
        execution === null ||
        execution.state === "abandoned" ||
        execution.state === "delivered" ||
        // An abort raised BY the abandon coordinator must not re-enter it: the
        // coordinator owns the rest of this chain (release, then finalize) and
        // is holding the write queue while this hook runs.
        execution.state === "abandoning"
      ) {
        return;
      }
      const abandoned = await abandonExecution(deps, {
        executionId: execution.id,
        reason: "The linked graph workflow execution was aborted.",
        actor: { kind: "system" },
      });
      if (!abandoned.ok) {
        // A concurrent terminal transition is the only sanctioned refusal;
        // the row is already out of the active set either way.
        logger.warn("specs.execution.abort-report-refused", {
          specExecutionId: execution.id,
          workflowExecutionId,
          code: abandoned.refusal.code,
        });
      }
    },
  };
}

function definitionGateRefusal(
  refusal: TransitionRefusal,
): { ok: false } & DefinitionGateRefusal {
  return {
    ok: false,
    code: refusal.code,
    unmetConditions: [...refusal.unmetConditions],
    instruction: refusal.instruction,
  };
}

async function linkWorkflowExecution(
  deps: ExecutionLifecycleDeps,
  specExecutionId: string,
  workflowExecutionId: string,
): Promise<LifecycleResult<SpecExecutionRow>> {
  return deps.writeQueue.withWriteQueue(
    `spec-execution-link[${specExecutionId}]`,
    async () => {
      const prepared: PreparedSpecEventPublication[] = [];
      const result = deps.runInImmediateTransaction<
        LifecycleResult<SpecExecutionRow>
      >(() => {
        const current = deps.deliveryRepo.findExecutionById(specExecutionId);
        if (current === null) return lifecycleNotFound(specExecutionId);
        if (
          current.workflow_execution_id !== null &&
          current.workflow_execution_id !== workflowExecutionId
        ) {
          return lifecycleRefused(
            "gate_blocked",
            ["The spec execution is linked to a different workflow execution."],
            "Use the workflow execution already linked to this immutable execution pin.",
          );
        }
        if (current.workflow_execution_id === workflowExecutionId) {
          return { ok: true, value: current };
        }

        const updated = deps.deliveryRepo.linkWorkflowExecution(
          specExecutionId,
          workflowExecutionId,
          deps.now(),
        );
        deps.linksRepo.insertLink({
          id: deps.nextId("link"),
          spec_id: current.spec_id,
          object_kind: "workflow_execution",
          object_ref_json: JSON.stringify({ workflowExecutionId }),
          direction: "outbound",
          category: "source",
          snapshot_json: JSON.stringify({ specExecutionId }),
          element_ids_json: null,
          actor_json: systemActorJson(),
          created_at: updated.updated_at,
        });
        prepared.push(
          appendExecutionEvent(deps, updated, "workflow_execution_linked", {
            workflowExecutionId,
          }),
        );
        logger.info("specs.execution.workflow-linked", {
          specExecutionId,
          workflowExecutionId,
        });
        return { ok: true, value: updated };
      });
      publishPrepared(deps, prepared);
      return result;
    },
  );
}

async function markRunning(
  deps: ExecutionLifecycleDeps,
  workflowExecutionId: string,
): Promise<LifecycleResult<SpecExecutionRow | null>> {
  return deps.writeQueue.withWriteQueue(
    `spec-execution-running[${workflowExecutionId}]`,
    async () => {
      const prepared: PreparedSpecEventPublication[] = [];
      const notices: PolicyStartAdmissionNotices = {
        admitted: [],
        requestsClosed: [],
      };
      const result = deps.runInImmediateTransaction<
        LifecycleResult<SpecExecutionRow | null>
      >(() => {
        const current =
          deps.deliveryRepo.findExecutionByWorkflowExecutionId(
            workflowExecutionId,
          );
        if (current === null) return { ok: true, value: null };
        if (current.state !== "definition_review") {
          return { ok: true, value: current };
        }
        const updated = deps.deliveryRepo.updateExecutionLifecycle({
          executionId: current.id,
          state: "running",
          deliveredAt: null,
          abandonedReason: null,
          updatedAt: deps.now(),
        });
        recordPolicyStartAdmission(deps, updated, prepared, notices);
        prepared.push(
          appendExecutionEvent(deps, updated, "execution_running", {
            workflowExecutionId,
          }),
        );
        logger.info("specs.execution.running", {
          specExecutionId: updated.id,
          workflowExecutionId,
        });
        return { ok: true, value: updated };
      });
      publishPrepared(deps, prepared);
      for (const notice of notices.admitted) {
        deps.policyNotifier?.policyAdmitted(notice);
      }
      for (const notice of notices.requestsClosed) {
        deps.policyNotifier?.approvalRequestsClosed(notice);
      }
      return result;
    },
  );
}

interface PolicyStartAdmissionNotices {
  admitted: SpecPolicyAdmissionNotice[];
  requestsClosed: SpecApprovalRequestsClosedNotice[];
}

/**
 * A workflow-review -> running transition admitted without a human gate is
 * still an admitted execution-start transition: under the Notify/Off dials
 * the admission lands with a policy basis plus its typed gate event so
 * `spec_gate_admissions` and the event log are a complete record of why
 * every start was admitted (R10.2, R19.1); under Notify the human is told
 * post hoc (R11.2). Under the Gate dial the human grant already wrote the
 * admission. Runs inside the transition's transaction; the caller publishes
 * the event and forwards the notice after commit.
 */
function recordPolicyStartAdmission(
  deps: ExecutionLifecycleDeps,
  execution: SpecExecutionRow,
  prepared: PreparedSpecEventPublication[],
  notices: PolicyStartAdmissionNotices,
): void {
  const spec = deps.specsRepo.findByIdInTransaction(execution.spec_id);
  if (spec === null) return;
  if (execution.execution_start_dial === null) {
    logger.warn("specs.execution.start-policy-unavailable", {
      specExecutionId: execution.id,
    });
    return;
  }
  const recorded = recordPolicyGateAdmissionInTransaction(
    {
      reviewRepo: deps.reviewRepo,
      attention: deps.eventsRepo,
      events: deps.events,
      newAdmissionId: () => deps.nextId("admission"),
      now: deps.now,
    },
    {
      spec,
      gate: "execution_start",
      execution,
      frozenDial: execution.execution_start_dial,
    },
  );
  if (recorded === null) return;
  prepared.push(...recorded.prepared);
  if (recorded.notice !== null) notices.admitted.push(recorded.notice);
  if (recorded.requestsClosed !== null) {
    notices.requestsClosed.push(recorded.requestsClosed);
  }
}

async function markDelivered(
  deps: ExecutionLifecycleDeps,
  specExecutionId: string,
  mergeHash: string,
): Promise<LifecycleResult<SpecExecutionRow>> {
  if (mergeHash.trim().length === 0) {
    return lifecycleRefused(
      "validation",
      ["Delivered requires the successful merge hash."],
      "Provide the merge hash returned by the successful publish operation.",
    );
  }
  const candidate = deps.deliveryRepo.findExecutionById(specExecutionId);
  if (candidate === null) return lifecycleNotFound(specExecutionId);
  if (
    candidate.state === "delivered" &&
    findExecutionMergeLink(
      deps.linksRepo.findBySpecId(candidate.spec_id),
      specExecutionId,
      mergeHash,
    )
  ) {
    return { ok: true, value: candidate };
  }
  if (candidate.state !== "running") {
    return deliveryStateRefusal(candidate);
  }
  const sessionDelivery = candidate.delivery_basis_json
    ? specDeliveryBasisSchema.parse(JSON.parse(candidate.delivery_basis_json))
        .kind === "session"
    : false;
  const published =
    candidate.workflow_execution_id !== null
      ? await deps.getPublishedMerge(candidate.workflow_execution_id)
      : sessionDelivery
        ? await deps.getPublishedMergeBySpecExecutionId(candidate.id)
        : null;
  if (
    published === null ||
    published.mergeHash !== mergeHash ||
    !published.deliveryGatePassed
  ) {
    return lifecycleRefused(
      "gate_blocked",
      [
        "This execution has no matching successfully published, delivery-gate-passed merge.",
      ],
      "Complete the delivery review and publish the associated session merge before recording Delivered.",
    );
  }
  const deliveryMeasures = await buildDeliveryMeasureEvents(deps, candidate);
  if (deliveryMeasures === null) {
    return lifecycleRefused(
      "validation",
      ["The pinned execution traceability state is incomplete."],
      "Repair the pinned revision or scope before recording delivery.",
    );
  }
  const delivered = await deps.writeQueue.withWriteQueue(
    `spec-execution-delivered[${specExecutionId}]`,
    async () => {
      const prepared: PreparedSpecEventPublication[] = [];
      const result = deps.runInImmediateTransaction<
        LifecycleResult<SpecExecutionRow>
      >(() => {
        const current = deps.deliveryRepo.findExecutionById(specExecutionId);
        if (current === null) return lifecycleNotFound(specExecutionId);
        const existingMerge = findExecutionMergeLink(
          deps.linksRepo.findBySpecId(current.spec_id),
          specExecutionId,
          mergeHash,
        );
        if (current.state === "delivered" && existingMerge) {
          return { ok: true, value: current };
        }
        if (current.state !== "running") {
          return deliveryStateRefusal(current);
        }
        if (current.workflow_execution_id !== candidate.workflow_execution_id) {
          return lifecycleRefused(
            "gate_blocked",
            ["The workflow execution linkage changed before delivery commit."],
            "Reconcile the linked workflow execution and retry delivery.",
          );
        }

        const deliveredAt = deps.now();
        for (const disposition of deps.deliveryRepo.findCriterionDispositionsByExecution(
          specExecutionId,
        )) {
          if (disposition.disposition !== "in_scope") continue;
          deps.deliveryRepo.saveCriterionDisposition({
            ...disposition,
            delivered_by_execution_id: specExecutionId,
            updated_at: deliveredAt,
          });
        }
        const updated = deps.deliveryRepo.updateExecutionLifecycle({
          executionId: specExecutionId,
          state: "delivered",
          deliveredAt,
          abandonedReason: null,
          updatedAt: deliveredAt,
        });
        deps.linksRepo.insertLink({
          id: deps.nextId("link"),
          spec_id: current.spec_id,
          object_kind: "merge_job",
          object_ref_json: JSON.stringify({ specExecutionId, mergeHash }),
          direction: "outbound",
          category: "source",
          snapshot_json: JSON.stringify({
            revisionId: current.revision_id,
            workflowExecutionId: current.workflow_execution_id,
          }),
          element_ids_json: null,
          actor_json: systemActorJson(),
          created_at: deliveredAt,
        });
        prepared.push(
          appendExecutionEvent(deps, updated, "execution_delivered", {
            mergeHash,
            measureEvents: deliveryMeasures,
          }),
        );
        logger.info("specs.execution.delivered", {
          specExecutionId,
          mergeHash,
        });
        return { ok: true, value: updated };
      });
      publishPrepared(deps, prepared);
      return result;
    },
  );
  return delivered;
}

async function buildDeliveryMeasureEvents(
  deps: Pick<ExecutionLifecycleDeps, "specsRepo">,
  execution: SpecExecutionRow,
): Promise<SpecMeasureEventPayload[] | null> {
  let decodedScope: unknown;
  try {
    decodedScope = JSON.parse(execution.scope_json);
  } catch {
    return null;
  }
  const scope = executionScopeSchema.safeParse(decodedScope);
  const snapshot = await deps.specsRepo.getRevisionSnapshot(
    execution.revision_id,
  );
  if (!scope.success || snapshot === null) return null;

  const tasks = new Map(
    snapshot.elements.flatMap(({ element, version }) =>
      version.payload.kind === "task"
        ? [[element.id, version.payload] as const]
        : [],
    ),
  );
  const criteria = new Map(
    snapshot.elements.flatMap(({ element, version }) =>
      version.payload.kind === "criterion"
        ? [[element.id, element] as const]
        : [],
    ),
  );
  const events: SpecMeasureEventPayload[] = [];
  for (const criterionId of scope.data.selectedCriterionIds) {
    const criterion = criteria.get(criterionId);
    if (criterion?.parentElementId === null || criterion === undefined) {
      return null;
    }
    const taskIds = scope.data.selectedTaskIds.filter((taskId) =>
      tasks.get(taskId)?.coveredCriterionElementIds.includes(criterionId),
    );
    events.push({
      kind: "criterion-delivered-in-scope",
      criterionId,
      requirementId: criterion.parentElementId,
      revisionId: execution.revision_id,
      executionId: execution.id,
      taskIds,
    });
  }
  return events;
}

async function reconcileStatus(
  deps: ExecutionServiceDeps,
  specExecutionId: string,
): Promise<LifecycleResult<ReconciledSpecExecution>> {
  const withLane = (
    result: LifecycleResult<SpecExecutionRow>,
    workflowStatus: SpecWorkflowLaneStatus | null,
  ): LifecycleResult<ReconciledSpecExecution> =>
    result.ok
      ? { ok: true, value: { execution: result.value, workflowStatus } }
      : result;

  let current = deps.deliveryRepo.findExecutionById(specExecutionId);
  if (current === null) return lifecycleNotFound(specExecutionId);
  if (current.state === "delivered" || current.state === "abandoned") {
    return { ok: true, value: { execution: current, workflowStatus: null } };
  }
  const workflowExecutionId = current.workflow_execution_id;
  if (workflowExecutionId === null) {
    const published =
      current.state === "running" && current.delivery_basis_json
        ? await deps.getPublishedMergeBySpecExecutionId(current.id)
        : null;
    if (published?.deliveryGatePassed)
      return withLane(
        await markDelivered(deps, current.id, published.mergeHash),
        null,
      );
    return { ok: true, value: { execution: current, workflowStatus: null } };
  }

  const [workflowStatus, publishedMerge] = await Promise.all([
    deps.getWorkflowExecutionStatus(workflowExecutionId),
    deps.getPublishedMerge(workflowExecutionId),
  ]);
  // An aborted workflow — or one whose active and archived records are both
  // gone — can never deliver this immutable pin, so the execution abandons on
  // system authority and the spec leaves "executing" for a future run. A
  // gate-passed published merge still wins: delivery is the truthful record
  // when the workflow vanished after publishing.
  if (workflowStatus === "aborted" || workflowStatus === null) {
    if (
      publishedMerge?.deliveryGatePassed === true &&
      current.state === "running"
    ) {
      return withLane(
        await markDelivered(deps, specExecutionId, publishedMerge.mergeHash),
        workflowStatus,
      );
    }
    const abandoned = await abandonExecution(deps, {
      executionId: specExecutionId,
      reason:
        workflowStatus === "aborted"
          ? "The linked graph workflow execution was aborted."
          : "The linked graph workflow execution no longer exists.",
      actor: { kind: "system" },
    });
    if (abandoned.ok) return withLane(abandoned, workflowStatus);
    // A concurrent transition beat the abandon; the fresh row is the truth.
    const fresh = deps.deliveryRepo.findExecutionById(specExecutionId);
    return fresh === null
      ? lifecycleNotFound(specExecutionId)
      : { ok: true, value: { execution: fresh, workflowStatus } };
  }
  if (
    current.state === "definition_review" &&
    (workflowStatus !== "pending" ||
      publishedMerge?.deliveryGatePassed === true)
  ) {
    const running = await markRunning(deps, workflowExecutionId);
    if (!running.ok) return running;
    if (running.value !== null) current = running.value;
  }
  if (publishedMerge?.deliveryGatePassed === true) {
    return withLane(
      await markDelivered(deps, specExecutionId, publishedMerge.mergeHash),
      workflowStatus,
    );
  }
  return { ok: true, value: { execution: current, workflowStatus } };
}

async function abandonExecution(
  deps: ExecutionLifecycleDeps,
  input: AbandonExecutionInternalInput,
): Promise<LifecycleResult<SpecExecutionRow>> {
  const reason = input.reason.trim();
  if (reason.length === 0) return abandonReasonRefusal();
  // Deliberately NOT wrapped in the write queue. The coordinator awaits the
  // workflow abort/archive ports, and those re-enter the SAME shared queue
  // through the graph-workflow setters — holding it here would deadlock the
  // first live abandonment. Each phase acquires the queue for its own atomic
  // commit instead, which is also what the queue's contract requires (a
  // critical section is a repo write plus pure computation, never external
  // I/O). Concurrent invocations are safe by construction: entry into
  // `abandoning` is idempotent, every phase re-observes the world before
  // acting, and each commit is a single transaction.
  return runAbandonCoordinator(deps, input, reason);
}

/**
 * The abandon coordinator's durable half (design §10). The decision at every
 * step comes from the pure transition table in `abandon-coordinator.ts`; this
 * function only observes the world, performs the act, and persists the phase
 * with its audit event in one transaction.
 *
 * Every phase commits before the next begins, so a fault anywhere leaves the
 * reached phase durable and re-running the SAME command resumes from it. The
 * loop terminates because a non-blocked step always advances the phase and a
 * blocked one returns.
 */
async function runAbandonCoordinator(
  deps: ExecutionLifecycleDeps,
  input: AbandonExecutionInternalInput,
  reason: string,
): Promise<LifecycleResult<SpecExecutionRow>> {
  const entered = await enterAbandoning(deps, input, reason);
  if (!entered.ok) return entered;
  let current = entered.value;

  const spec = await deps.specsRepo.findById(current.spec_id);
  if (spec === null) return lifecycleNotFound(current.spec_id);
  const target = cleanupTarget(current, spec.projectPath);
  if (target !== null && deps.workflowCleanup === undefined) {
    return await recordCleanupFault(
      deps,
      current,
      input,
      reason,
      `No graph-workflow cleanup port is wired into this composition, so execution ${target.workflowExecutionId} cannot be ended here.`,
      "End it yourself — 'cctl workflow live abort --reason <reason>' for a live run, 'cctl workflow abandon --reason <reason>' for a halted one — then retry this command.",
    );
  }

  for (;;) {
    const phase = current.cleanup_phase ?? INITIAL_ABANDON_CLEANUP_PHASE;
    let observation: LinkedWorkflowObservation;
    try {
      observation =
        target === null || deps.workflowCleanup === undefined
          ? { kind: "never_launched" }
          : toLinkedObservation(
              await deps.workflowCleanup.observe(target),
              target.workflowExecutionId,
            );
    } catch (error) {
      return await recordCleanupFault(
        deps,
        current,
        input,
        reason,
        `Could not read the linked graph workflow execution: ${errorText(error)}`,
        "Retry this command once the workflow store is reachable.",
      );
    }

    const step = nextAbandonCleanupStep({ phase, linkedWorkflow: observation });
    const act = step.act;

    if (act.kind === "blocked") {
      return await recordCleanupFault(
        deps,
        current,
        input,
        reason,
        act.reason,
        act.remedy,
      );
    }

    if (act.kind === "finalize") {
      // Belt and braces over the table's own guarantee: `abandoned` is
      // reachable from the final phase and nowhere else.
      if (!abandonFinalizationAllowed(phase)) {
        throw new Error(
          `Abandon coordinator tried to finalize from phase ${phase}`,
        );
      }
      return await finalizeAbandon(deps, spec, current, input, reason);
    }

    if (act.kind !== "skip") {
      // `target` is non-null on every path that reaches an end-the-run act: it
      // is produced only from an `active` observation, which requires a pinned
      // workflow.
      if (target === null || deps.workflowCleanup === undefined) {
        throw new Error(
          `Abandon coordinator produced ${act.kind} with no cleanup target`,
        );
      }
      const cleanup = deps.workflowCleanup;
      const abandoning = act.kind === "abandon_workflow";
      // The remedy names the act that applies to THIS blocker, which is the
      // same act the coordinator just tried: a halted lease holder is ended by
      // abandon, everything else by abort.
      const remedy = abandoning
        ? "Abandon it with 'cctl workflow abandon --reason <reason>', then retry this command."
        : "Abort it with 'cctl workflow live abort --reason <reason>', then retry this command.";
      let outcome: SpecWorkflowCleanupOutcome;
      try {
        outcome = abandoning
          ? await cleanup.abandon({
              ...target,
              reason,
              actor: graphAbandonmentActor(input.actor),
            })
          : await cleanup.abort({ ...target, reason });
      } catch (error) {
        return await recordCleanupFault(
          deps,
          current,
          input,
          reason,
          `Cleanup phase ${phase} failed: ${errorText(error)}`,
          remedy,
        );
      }
      // A port that did nothing must NOT be recorded as a completed phase:
      // writing `..._aborted` over a no-op is exactly the false receipt this
      // coordinator exists to prevent. Parking here instead
      // lets the retry re-observe — a run that really did settle is then seen
      // as archived/missing and skips forward.
      if (!outcome.ok) {
        return await recordCleanupFault(
          deps,
          current,
          input,
          reason,
          `Cleanup phase ${phase} did not take effect: ${outcome.reason}`,
          remedy,
        );
      }
    }

    current = await commitCleanupPhase(deps, current, input, reason, {
      nextPhase: step.nextPhase,
      kind: cleanupPhaseEventKind(act.kind),
      payload:
        act.kind === "skip"
          ? { phase, note: act.note }
          : { phase, workflowExecutionId: act.workflowExecutionId },
    });
  }
}

/**
 * Which act the cleanup audit records. Distinct kinds because the acts are
 * distinct: an abandoned run keeps its halt reason and carries an abandonment
 * record, and a receipt that called that an abort would misdescribe the very
 * History row it points at.
 */
function cleanupPhaseEventKind(actKind: AbandonCleanupAct["kind"]): string {
  switch (actKind) {
    case "abort_workflow":
      return "execution_cleanup_workflow_aborted";
    case "abandon_workflow":
      return "execution_cleanup_workflow_abandoned";
    default:
      return "execution_cleanup_skipped";
  }
}

/**
 * Translate the spec-side actor into the graph audit's two-valued vocabulary.
 *
 * An agent's conversation carries through as the verified principal it is. A
 * system-initiated reconciliation attributes to `human` for the same reason the
 * abandon route does when a caller presents no agent credentials: the act is
 * the server proceeding on the operator's behalf, and inventing a third
 * principal in the audit would name someone who did not decide anything.
 */
function graphAbandonmentActor(
  actor: ActorProvenance | { kind: "system" },
): GraphWorkflowAbandonment["actor"] {
  return actor.kind === "agent"
    ? { kind: "conversation", conversationId: actor.conversationId }
    : { kind: "human" };
}

/**
 * The same translation for the delivery-plan audit, whose persisted
 * `ActorProvenance` has no `system` member either. A reconciliation that
 * abandons a run whose workflow was aborted elsewhere still retires the
 * attempt, and attributing that to `human` reads it as the server acting on
 * the operator's behalf rather than inventing a third principal.
 */
function planTransitionActor(
  actor: ActorProvenance | { kind: "system" },
): ActorProvenance {
  return actor.kind === "system" ? { kind: "human" } : actor;
}

/**
 * Accept the abandonment and pin the cleanup target. Re-entering an execution
 * already in `abandoning` keeps the recorded phase and the pinned id — that is
 * what makes retrying the same command a resume rather than a restart.
 */
async function enterAbandoning(
  deps: ExecutionLifecycleDeps,
  input: AbandonExecutionInternalInput,
  reason: string,
): Promise<LifecycleResult<SpecExecutionRow>> {
  const prepared: PreparedSpecEventPublication[] = [];
  const result = await deps.writeQueue.withWriteQueueSync(
    `spec-execution-abandon-enter[${input.executionId}]`,
    () =>
      deps.runInImmediateTransaction<LifecycleResult<SpecExecutionRow>>(() => {
        const current = deps.deliveryRepo.findExecutionById(input.executionId);
        if (current === null) return lifecycleExecutionNotFound();
        if (current.state === "abandoned" || current.state === "delivered") {
          // `input.executionId` is the INTERNAL row id by the time the
          // coordinator runs — the public boundary resolved the caller's
          // workflow execution id into it — so the refusal re-derives the
          // addressable id from the row rather than echoing the input.
          const named = addressableExecutionId(current);
          return lifecycleRefused(
            "gate_blocked",
            [
              named === null
                ? `This run is terminal (${current.state}).`
                : `Execution ${named} is terminal (${current.state}).`,
            ],
            "Use the terminal execution history or start a future execution from an approved revision.",
          );
        }
        if (current.state === "abandoning") return { ok: true, value: current };
        const updated = deps.deliveryRepo.saveExecutionCleanupState({
          executionId: current.id,
          state: "abandoning",
          cleanupPhase: INITIAL_ABANDON_CLEANUP_PHASE,
          linkedWorkflowExecutionId: current.workflow_execution_id,
          cleanupLastError: null,
          cleanupLastErrorAt: null,
          abandonedReason: reason,
          updatedAt: deps.now(),
        });
        prepared.push(
          appendExecutionEvent(
            deps,
            updated,
            "execution_abandon_started",
            {
              reason,
              linkedWorkflowExecutionId: updated.workflow_execution_id,
            },
            input.actor,
          ),
        );
        return { ok: true, value: updated };
      }),
  );
  publishPrepared(deps, prepared);
  return result;
}

async function commitCleanupPhase(
  deps: ExecutionLifecycleDeps,
  execution: SpecExecutionRow,
  input: AbandonExecutionInternalInput,
  reason: string,
  step: {
    nextPhase: SpecExecutionCleanupPhase | null;
    kind: string;
    payload: Record<string, unknown>;
  },
): Promise<SpecExecutionRow> {
  const prepared: PreparedSpecEventPublication[] = [];
  const updated = await deps.writeQueue.withWriteQueueSync(
    `spec-execution-abandon-phase[${execution.id}]`,
    () =>
      deps.runInImmediateTransaction<SpecExecutionRow>(() => {
        const row = deps.deliveryRepo.saveExecutionCleanupState({
          executionId: execution.id,
          state: "abandoning",
          cleanupPhase: step.nextPhase,
          linkedWorkflowExecutionId: execution.linked_workflow_execution_id,
          cleanupLastError: null,
          cleanupLastErrorAt: null,
          abandonedReason: reason,
          updatedAt: deps.now(),
        });
        prepared.push(
          appendExecutionEvent(deps, row, step.kind, step.payload, input.actor),
        );
        return row;
      }),
  );
  publishPrepared(deps, prepared);
  return updated;
}

/**
 * Record the abandon transition on the attempt that launched this run, so
 * `nextAct` reads `cctl spec plan open` rather than "the immutable launch is
 * running" and `spec start` stops refusing "not signed off" (design 3.5, D-B).
 *
 * A run with no plan attempt behind it — the legacy compiled path, and any
 * execution inserted without one — is not a fault: there is nothing to retire,
 * so `not_found` skips. Every other refusal parks the abandonment, because a
 * live attempt left reading `launched` is the exact stranding this exists to
 * end. Re-entry is safe: `abandonLaunch` reports an already-abandoned attempt
 * without recording a second transition.
 */
async function retireLaunchedAttempt(
  deps: ExecutionLifecycleDeps,
  spec: Spec,
  execution: SpecExecutionRow,
  reason: string,
  actor: ActorProvenance | { kind: "system" },
): Promise<PlanResult<{ attemptId: string } | null>> {
  const capturePort = deps.deliveryPlanCapture;
  if (capturePort === undefined) return { ok: true, value: null };
  const retired = await capturePort.abandonLaunchedAttempt({
    spec,
    executionId: execution.id,
    reason,
    actor: planTransitionActor(actor),
  });
  if (!retired.ok && retired.refusal.code === "not_found") {
    return { ok: true, value: null };
  }
  return retired;
}

async function finalizeAbandon(
  deps: ExecutionLifecycleDeps,
  spec: Spec,
  execution: SpecExecutionRow,
  input: AbandonExecutionInternalInput,
  reason: string,
): Promise<LifecycleResult<SpecExecutionRow>> {
  // Retirement runs BEFORE the execution row commits to `abandoned`, and the
  // ordering is load-bearing: once the row is terminal `enterAbandoning`
  // refuses `gate_blocked`, so a retirement that failed afterwards could never
  // be retried and the attempt would read `launched` forever. Failing here
  // instead parks the run at `finalize`, which the retry re-enters.
  const retired = await retireLaunchedAttempt(
    deps,
    spec,
    execution,
    reason,
    input.actor,
  );
  if (!retired.ok) {
    return await recordCleanupFault(
      deps,
      execution,
      input,
      reason,
      `The launched delivery-plan attempt could not be retired: ${retired.refusal.unmetConditions.join(" ")}`,
      retired.refusal.instruction,
    );
  }
  const prepared: PreparedSpecEventPublication[] = [];
  const updated = await deps.writeQueue.withWriteQueueSync(
    `spec-execution-abandon-finalize[${execution.id}]`,
    () =>
      deps.runInImmediateTransaction<SpecExecutionRow>(() => {
        const row = deps.deliveryRepo.saveExecutionCleanupState({
          executionId: execution.id,
          state: "abandoned",
          cleanupPhase: null,
          linkedWorkflowExecutionId: execution.linked_workflow_execution_id,
          cleanupLastError: null,
          cleanupLastErrorAt: null,
          abandonedReason: reason,
          updatedAt: deps.now(),
        });
        prepared.push(
          appendExecutionEvent(
            deps,
            row,
            "execution_abandoned",
            { reason },
            input.actor,
          ),
        );
        return row;
      }),
  );
  publishPrepared(deps, prepared);
  logger.info("specs.execution.abandoned", {
    specExecutionId: execution.id,
    reasonLength: reason.length,
  });
  deps.attentionNotifier?.specAttentionCleared({
    specId: updated.spec_id,
    scope: "execution",
    reason,
    occurredAt: deps.now(),
  });
  return { ok: true, value: updated };
}

/**
 * Park the run at the phase it reached, recording why it stopped. The phase is
 * left exactly as it was so the retry re-enters here, and the refusal names
 * the verb that unblocks it rather than reporting a clean abandonment over a
 * workflow that is still live or still slot-owning.
 */
async function recordCleanupFault(
  deps: ExecutionLifecycleDeps,
  execution: SpecExecutionRow,
  input: AbandonExecutionInternalInput,
  reason: string,
  cause: string,
  remedy: string,
): Promise<LifecycleResult<SpecExecutionRow>> {
  const prepared: PreparedSpecEventPublication[] = [];
  const at = deps.now();
  await deps.writeQueue.withWriteQueueSync(
    `spec-execution-abandon-fault[${execution.id}]`,
    () =>
      deps.runInImmediateTransaction<void>(() => {
        const row = deps.deliveryRepo.saveExecutionCleanupState({
          executionId: execution.id,
          state: "abandoning",
          cleanupPhase:
            execution.cleanup_phase ?? INITIAL_ABANDON_CLEANUP_PHASE,
          linkedWorkflowExecutionId: execution.linked_workflow_execution_id,
          cleanupLastError: cause,
          cleanupLastErrorAt: at,
          abandonedReason: reason,
          updatedAt: at,
        });
        prepared.push(
          appendExecutionEvent(
            deps,
            row,
            "execution_cleanup_blocked",
            { phase: row.cleanup_phase, cause, remedy },
            input.actor,
          ),
        );
      }),
  );
  publishPrepared(deps, prepared);
  logger.warn("specs.execution.cleanup-blocked", {
    specExecutionId: execution.id,
    phase: execution.cleanup_phase,
  });
  return lifecycleRefused("gate_blocked", [cause], remedy);
}

function cleanupTarget(
  execution: SpecExecutionRow,
  projectPath: string,
): SpecWorkflowCleanupTarget | null {
  const workflowExecutionId = execution.linked_workflow_execution_id;
  if (workflowExecutionId === null || execution.session_name === null) {
    return null;
  }
  return {
    projectPath,
    sessionName: execution.session_name,
    workflowExecutionId,
  };
}

function toLinkedObservation(
  observation: SpecWorkflowCleanupObservation,
  workflowExecutionId: string,
): LinkedWorkflowObservation {
  return observation.kind === "missing"
    ? { kind: "missing", workflowExecutionId }
    : { ...observation, workflowExecutionId };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function abandonSpec(
  deps: ExecutionServiceDeps,
  input: AbandonSpecInput,
): Promise<LifecycleResult<Spec>> {
  const reason = input.reason.trim();
  if (reason.length === 0) return abandonReasonRefusal();
  return deps.writeQueue.withWriteQueue(
    `spec-abandon[${input.specId}]`,
    async () => {
      const current = await deps.specsRepo.findById(input.specId);
      if (current === null) return lifecycleNotFound(input.specId);
      if (current.abandonedAt !== null) {
        return lifecycleRefused(
          "gate_blocked",
          ["The spec is already abandoned and terminal."],
          "Use the abandoned spec history rather than attempting another transition.",
        );
      }
      const prepared: PreparedSpecEventPublication[] = [];
      const result = deps.runInImmediateTransaction<LifecycleResult<Spec>>(
        () => {
          const abandonedAt = deps.now();
          const spec = deps.specsRepo.abandonInTransaction({
            specId: input.specId,
            abandonedAt,
            reason,
            updatedAt: abandonedAt,
          });
          const active = deps.deliveryRepo.findActiveExecutionBySpecId(
            input.specId,
          );
          if (active !== null) {
            const execution = deps.deliveryRepo.updateExecutionLifecycle({
              executionId: active.id,
              state: "abandoned",
              deliveredAt: null,
              abandonedReason: reason,
              updatedAt: abandonedAt,
            });
            prepared.push(
              appendExecutionEvent(
                deps,
                execution,
                "execution_abandoned",
                { reason, abandonedWithSpec: true },
                input.actor,
              ),
            );
          }
          prepared.push(
            deps.events.appendInTransaction({
              actor: input.actor,
              durableEventType: "spec-changed",
              durablePayload: { kind: "spec_abandoned", reason },
              sseEvent: {
                type: "spec-changed",
                kind: "spec_abandoned",
                projectPath: spec.projectPath,
                specId: spec.id,
                specSlug: spec.slug,
                occurredAt: abandonedAt,
              },
            }),
          );
          logger.info("specs.execution.spec-abandoned", {
            specId: input.specId,
            reasonLength: reason.length,
          });
          return { ok: true, value: spec };
        },
      );
      publishPrepared(deps, prepared);
      if (result.ok) {
        deps.attentionNotifier?.specAttentionCleared({
          specId: input.specId,
          scope: "spec",
          reason,
          occurredAt: deps.now(),
        });
      }
      return result;
    },
  );
}

/** The prelaunch redirect: nothing is captured, and the plan verb is named. */
export function prelaunchRedirectRefusal(
  slug: string,
  attempt: SpecDeliveryPlanAttemptRow,
): LifecycleResult<never> {
  const act =
    attempt.status === "draft"
      ? `cctl workflow replace <definitionId> --file <plan.json>`
      : `cctl spec plan reopen ${slug} --reason <why>`;
  return lifecycleRefused(
    "gate_blocked",
    [
      `Delivery plan attempt ${attempt.id} is ${attempt.status} and has launched no execution, so there is no run to capture against.`,
    ],
    `Nothing was captured. Add the discovered work to the plan itself with \`${act}\`.`,
  );
}

/**
 * A run that is not running has no capture against it — but `abandoning` is
 * not a dead end, it is a cleanup that stopped partway (a faulted coordinator
 * phase). Sending that operator to `plan open` would leave the run holding its
 * session slot forever, so the refusal names the act that RESUMES the
 * coordinator from its durable phase instead.
 */
/**
 * The run re-pinned between the guard that judged the discovery's ids and the
 * write that would have recorded it, so the judgment is stale.
 *
 * Named by `addressableExecutionId` rather than by `current.id`: the row id is
 * internal, and a refusal that printed it would hand back an id no verb
 * accepts (design 3.5, D-B).
 */
export function rePinnedCaptureRefusal(
  slug: string,
  judgedRevisionId: string,
  current: SpecExecutionRow,
): LifecycleResult<never> {
  const named = addressableExecutionId(current);
  return lifecycleRefused(
    "gate_blocked",
    [
      `${named === null ? "The run" : `Execution ${named}`} re-pinned from revision ${judgedRevisionId} to ${current.revision_id} while the capture was being judged.`,
    ],
    `Nothing was captured. Re-run \`cctl spec capture ${slug} --file <task.json>\` so the discovered task is judged against the run's current pin.`,
  );
}

export function notRunningCaptureRefusal(
  slug: string,
  execution: SpecExecutionRow,
): LifecycleResult<never> {
  const named = addressableExecutionId(execution) ?? "this run";
  const remedy =
    execution.state === "abandoning"
      ? `Nothing was captured. Execution ${named} is mid-abandon: resume its cleanup with \`cctl spec abandon --execution ${named} --reason <why>\` (it continues from the phase it reached), then open the replacement with \`cctl spec plan open ${slug}\` — any discovery already captured against it is durable and the seed places it.`
      : `Nothing was captured. Plan the work directly instead: \`cctl spec plan open ${slug}\`.`;
  return lifecycleRefused(
    "gate_blocked",
    [
      `Execution ${named} is ${execution.state}, and discovered work can be captured only while it runs.`,
    ],
    remedy,
  );
}

/**
 * The discovered task judged against the run's pinned revision without writing
 * anything. The staged write is thrown away: capture records a discovery, not
 * an evergreen amendment, but a discovery that names an element the pinned
 * revision does not carry is still unreadable to the plan that will place it.
 */
function discoveredTaskReferenceIssues(
  snapshot: SpecRevisionSnapshot | null,
  discoveryId: string,
  discoveredTask: DiscoveredTask,
): ReturnType<typeof validateStagedWrite> {
  return validateStagedWrite(
    stageRevisionWrite(guardedElements(snapshot), [
      {
        op: "write",
        elementId: discoveryId,
        payload: { kind: "task", ...discoveredTask },
        parentElementId: null,
      },
    ]),
  );
}

async function captureScopeAmendment(
  deps: ExecutionServiceDeps,
  input: CaptureScopeAmendmentInput,
): Promise<LifecycleResult<CapturedScopeAmendment>> {
  const blockingReason = input.blockingReason?.trim();
  if (input.blockingReason !== undefined && blockingReason?.length === 0) {
    return abandonReasonRefusal();
  }
  const spec = await deps.specsRepo.findById(input.specId);
  if (spec === null) return lifecycleNotFound(input.specId);

  // The attempt decides which run is addressable, so a stale `--execution`
  // cannot point capture at a run the live plan has moved past.
  const attempt = liveDeliveryPlanAttempt(
    deps.plansRepo.findAttemptsBySpecId(spec.id),
  );
  if (attempt !== null && attempt.launched_execution_id === null) {
    return prelaunchRedirectRefusal(spec.slug, attempt);
  }
  const executionId = attempt?.launched_execution_id ?? input.executionId;
  if (executionId === undefined) {
    return lifecycleRefused(
      "gate_blocked",
      ["This spec has no delivery plan attempt and no execution was named."],
      `Nothing was captured. Open a plan with \`cctl spec plan open ${spec.slug}\`, or name the run with \`cctl spec capture ${spec.slug} --execution <execution-id> --file <task.json>\`.`,
    );
  }

  const execution = deps.deliveryRepo.findExecutionById(executionId);
  if (execution === null) return lifecycleExecutionNotFound();
  if (execution.spec_id !== spec.id) {
    // Named by its workflow execution id, the only id the caller passed and
    // the only one any `cctl` verb takes.
    const named = addressableExecutionId(execution);
    return lifecycleRefused(
      "gate_blocked",
      [
        named === null
          ? "The named run belongs to a different spec."
          : `Execution ${named} belongs to a different spec.`,
      ],
      `Nothing was captured. Re-run against the run this spec launched — \`cctl spec status ${spec.slug}\` names it.`,
    );
  }
  if (execution.state !== "running") {
    return notRunningCaptureRefusal(spec.slug, execution);
  }
  const workflowExecutionId = execution.workflow_execution_id;
  if (workflowExecutionId === null) {
    return lifecycleRefused(
      "gate_blocked",
      // The spec-side row id is deliberately unnamed: an agent only ever
      // passes the workflow execution id, and this run has none to give.
      [`This spec's running execution has no workflow lane linked.`],
      `Nothing was captured. Read \`cctl spec status ${spec.slug}\` — a run with no lane is mid-recovery and has no id to capture against.`,
    );
  }

  const discoveryId = deps.nextId("discovery");
  const issues = discoveredTaskReferenceIssues(
    await deps.specsRepo.getRevisionSnapshot(execution.revision_id),
    discoveryId,
    input.discoveredTask,
  );
  if (issues.length > 0) {
    const refusal = danglingReferenceRefusal(issues);
    logger.warn("specs.execution.scope-amendment-refused", {
      specExecutionId: execution.id,
      refusalCode: refusal.code,
      referenceCount: issues.length,
    });
    return { ok: false, refusal };
  }

  const capturedAt = deps.now();
  // The guard above reads the run's state; this writes against it. An abandon
  // committing between the two would leave a discovery filed against a run the
  // receipt then calls running, so the state is re-observed and the row
  // written in ONE critical section — the same queue `enterAbandoning` takes.
  const recorded = await deps.writeQueue.withWriteQueueSync(
    `spec-capture[${execution.id}]`,
    () => {
      const current = deps.deliveryRepo.findExecutionById(execution.id);
      if (current === null) return lifecycleExecutionNotFound();
      if (current.state !== "running") {
        return notRunningCaptureRefusal(spec.slug, current);
      }
      // The pin is what the discovery's ids were judged against; a run that
      // re-pinned mid-capture would make that judgment stale.
      if (current.revision_id !== execution.revision_id) {
        return rePinnedCaptureRefusal(
          spec.slug,
          execution.revision_id,
          current,
        );
      }
      return {
        ok: true as const,
        value: deps.plansRepo.recordDiscovery({
          discovery: {
            id: discoveryId,
            spec_id: spec.id,
            execution_id: current.id,
            attempt_id: attempt?.id ?? null,
            pinned_revision_id: current.revision_id,
            discovered_task_json: JSON.stringify(input.discoveredTask),
            blocking_reason: blockingReason ?? null,
            captured_by_json: JSON.stringify(input.actor),
            captured_at: capturedAt,
          },
          eventType: "spec-execution-changed",
          actor: input.actor,
        }),
      };
    },
  );
  if (!recorded.ok) return recorded;
  const { discovery, event } = recorded.value;
  deps.events.publishAfterCommit({
    durableEvent: event,
    sseEvent: {
      type: "spec-execution-changed",
      kind: "discovery_captured",
      projectPath: spec.projectPath,
      specId: spec.id,
      specSlug: spec.slug,
      occurredAt: capturedAt,
      revisionId: execution.revision_id,
      executionId: execution.id,
    },
  });

  let replacement: CapturedScopeAmendment["replacement"] = null;
  if (blockingReason !== undefined) {
    // The production abandon coordinator, not a local abort: it is the one
    // owner of workflow abort, slot release, and the audited `abandoned`
    // transition (design §10).
    const abandoned = await abandonExecution(deps, {
      executionId: execution.id,
      reason: blockingReason,
      actor: input.actor,
    });
    if (!abandoned.ok) {
      // The coordinator's own remedy says "retry this command", which is true
      // of `spec abandon` but not of `spec capture`: a retry here now meets
      // the not-running guard, having already written the discovery. Restate
      // the exit in terms of the two acts that actually finish the job.
      logger.warn("specs.execution.capture-abandon-blocked", {
        specExecutionId: execution.id,
        discoveryId: discovery.id,
        refusalCode: abandoned.refusal.code,
      });
      return {
        ok: false,
        refusal: {
          code: abandoned.refusal.code,
          unmetConditions: [
            ...abandoned.refusal.unmetConditions,
            `Discovery ${discovery.id} is already durable against execution ${workflowExecutionId}, so the work is not lost.`,
          ],
          instruction: `${abandoned.refusal.instruction} Then finish this capture's two remaining acts, in order: resume the abandon with \`cctl spec abandon --execution ${workflowExecutionId} --reason ${JSON.stringify(blockingReason)}\`, then open the replacement with \`cctl spec plan open ${spec.slug}\` — it places discovery ${discovery.id}. Do not re-run \`cctl spec capture\`: it would record the same work twice.`,
        },
      };
    }
    const capturePort = deps.deliveryPlanCapture;
    if (capturePort === undefined) {
      return lifecycleRefused(
        "gate_blocked",
        [
          `Execution ${workflowExecutionId} was abandoned, but this composition cannot open its replacement plan.`,
        ],
        `The discovery is durable. Open the replacement yourself with \`cctl spec plan open ${spec.slug}\` — the seed places it.`,
      );
    }
    const retiredAttempt = await capturePort.abandonLaunchedAttempt({
      spec,
      executionId: execution.id,
      reason: blockingReason,
      actor: input.actor,
    });
    if (!retiredAttempt.ok) {
      return {
        ok: false,
        refusal: {
          code: retiredAttempt.refusal.code,
          unmetConditions: [...retiredAttempt.refusal.unmetConditions],
          instruction: retiredAttempt.refusal.instruction,
        },
      };
    }
    const opened = await capturePort.openSeededReplacement({
      spec,
      actor: input.actor,
    });
    if (!opened.ok) {
      return {
        ok: false,
        refusal: {
          code: opened.refusal.code,
          unmetConditions: [...opened.refusal.unmetConditions],
          instruction: opened.refusal.instruction,
        },
      };
    }
    replacement = {
      abandonedExecutionId: execution.id,
      abandonedWorkflowExecutionId: workflowExecutionId,
      replacementAttemptId: opened.value.attemptId,
    };
  }

  logger.info("specs.execution.discovery-captured", {
    specExecutionId: execution.id,
    discoveryId: discovery.id,
    attemptId: discovery.attempt_id,
    restartRequired: blockingReason !== undefined,
    replacementAttemptId: replacement?.replacementAttemptId,
  });
  return {
    ok: true,
    value: {
      discovery: {
        id: discovery.id,
        executionId: discovery.execution_id,
        workflowExecutionId,
        attemptId: discovery.attempt_id,
        title: input.discoveredTask.title,
      },
      restartRequired: blockingReason !== undefined,
      replacement,
    },
  };
}

/**
 * What a launch still owes once the write queue is released. The spec-side
 * writes are prepared but uncommitted; the workflow start invokes the generic
 * attachment inside the graph execution insertion transaction.
 */
interface PreparedDeliveryPlanLaunch {
  spec: Spec;
  attachment: SpecExecutionStartAttachment;
  workflowDefinition: { id: string; revision: number };
  revisionNumber: number;
  attemptId: string;
  candidate: FinalizedDeliveryPlanCandidateIdentity;
  sessionName: string;
  projectName: string;
  actor: ActorProvenance;
  ownerConversationId: string | null;
  parameters?: Record<string, unknown>;
  /**
   * Built from the PINNED snapshot inside the queue, where the pin is already
   * resolved, so what a lane reads cannot drift with live spec state between
   * staging and launch.
   */
  seededDocuments: readonly SeededWorkflowDocument[];
}

type StagedStart =
  | { kind: "done"; result: StartSpecExecutionResult }
  | { kind: "launch"; pending: PreparedDeliveryPlanLaunch };

function done(result: StartSpecExecutionResult): StagedStart {
  return { kind: "done", result };
}

async function startWithinQueue(
  deps: ExecutionServiceDeps,
  input: StartSpecExecutionInput,
): Promise<StagedStart> {
  const spec = await deps.specsRepo.findById(input.specId);
  if (spec === null) {
    return done(refusedNotFound("The target spec does not exist."));
  }
  const snapshot = await deps.specsRepo.getRevisionSnapshot(input.revisionId);
  if (snapshot === null || snapshot.revision.specId !== spec.id) {
    return done(
      refusedNotFound("The target revision does not belong to the spec."),
    );
  }
  if (
    input.sessionName !== null &&
    !(await deps.sessionExists(input.sessionName))
  ) {
    return done({
      ok: false,
      refusal: {
        code: "not_found",
        unmetConditions: [
          `Session ${JSON.stringify(input.sessionName)} does not exist in this project.`,
        ],
        instruction:
          "Create or select a session first, then rerun spec start from it — the execution pins the session it will launch and merge through, and cctl binds the one CC_SESSION names.",
      },
    });
  }

  if (deps.deliveryPlanLaunch === undefined) {
    const refusal = unavailableDeliveryPlanPortRefusal(spec.slug, "started");
    recordStartRefusal(deps, spec.id, input.actor, refusal);
    return done({ ok: false, refusal });
  }
  const planLaunch = await deps.deliveryPlanLaunch.resolveLaunch({ spec });
  if (planLaunch.kind === "refused" || planLaunch.kind === "unapproved") {
    const refusal = asTransitionRefusal(planLaunch.refusal);
    recordStartRefusal(deps, spec.id, input.actor, refusal);
    return done({ ok: false, refusal });
  }
  return startFromDeliveryPlan(deps, input, spec, snapshot, planLaunch.value);
}

/**
 * A delivery-plan refusal in the transition vocabulary. `findings` is dropped
 * rather than cast: the two types spell a finding differently, and every plan
 * refusal that reaches a launch states its condition in prose and names its
 * remedy there.
 */
function asTransitionRefusal(refusal: Refusal): TransitionRefusal {
  const { findings: _findings, ...rest } = refusal;
  return rest;
}

function unavailableDeliveryPlanPortRefusal(
  slug: string,
  act: "started" | "parked",
): TransitionRefusal {
  return {
    code: "workflow_unavailable",
    unmetConditions: [
      "The shared graph launch boundary is unavailable in this composition.",
    ],
    instruction: `Nothing was ${act}. Read the signed candidate with \`cctl spec plan status ${slug}\`, then retry in a Command Center composition that supports one-off graph start.`,
  };
}

/**
 * `spec start --park`: the approved (or merely proposed) candidate is held for
 * spec-side prelaunch review. Nothing else happens — no workflow definition is
 * written, no `spec_executions` row is inserted, and no graph-workflow
 * execution or session slot is taken, which is exactly what makes a parked
 * plan unable to block session validation (ticket #47 note 9e5ba960).
 */
async function parkWithinQueue(
  deps: ExecutionServiceDeps,
  input: StartSpecExecutionInput,
): Promise<LifecycleResult<ParkedDeliveryPlanResult>> {
  const spec = await deps.specsRepo.findById(input.specId);
  if (spec === null) {
    return refusedNotFound("The target spec does not exist.");
  }
  const planPort = deps.deliveryPlanLaunch;
  if (planPort === undefined) {
    const refusal = unavailableDeliveryPlanPortRefusal(spec.slug, "parked");
    recordStartRefusal(deps, spec.id, input.actor, refusal);
    return { ok: false, refusal };
  }
  const resolved = await planPort.resolveLaunch({ spec });
  if (resolved.kind === "refused") {
    const refusal = asTransitionRefusal(resolved.refusal);
    recordStartRefusal(deps, spec.id, input.actor, refusal);
    return { ok: false, refusal };
  }
  // An unapproved candidate parks too: prelaunch review is precisely where the
  // approval it lacks gets decided, so refusing here would leave the review
  // with nowhere to happen.
  const target =
    resolved.kind === "ready"
      ? {
          attemptId: resolved.value.attemptId,
          candidate: resolved.value.candidate,
        }
      : { attemptId: resolved.attemptId, candidate: resolved.candidate };
  const parked = await planPort.park({
    spec,
    reason: null,
    ...target.candidate,
    actor: input.actor,
  });
  if (!parked.ok) {
    const refusal = asTransitionRefusal(parked.refusal);
    recordStartRefusal(deps, spec.id, input.actor, refusal);
    return { ok: false, refusal };
  }
  logger.info("specs.execution.delivery-plan-parked", {
    specId: spec.id,
    attemptId: target.attemptId,
    candidateId: target.candidate.candidateId,
  });
  return {
    ok: true,
    value: {
      attemptId: target.attemptId,
      candidateId: target.candidate.candidateId,
      candidateHash: target.candidate.candidateHash,
      nextAct: parked.value.nextAct,
    },
  };
}

/**
 * The delivery-plan launch (design §5): it persists the stored approved
 * candidate byte-for-byte, creates the graph-workflow execution only here at
 * launch, and consumes the execution-start admission plan sign-off recorded.
 */
async function startFromDeliveryPlan(
  deps: ExecutionServiceDeps,
  input: StartSpecExecutionInput,
  spec: Spec,
  snapshot: SpecRevisionSnapshot,
  launch: DeliveryPlanLaunchCandidate,
): Promise<StagedStart> {
  const planPort = deps.deliveryPlanLaunch;
  if (planPort === undefined) {
    throw new Error("A delivery-plan launch resolved with no plan port wired");
  }
  if (spec.abandonedAt !== null) {
    return done({
      ok: false,
      refusal: {
        code: "gate_blocked",
        unmetConditions: [`Spec ${spec.slug} is abandoned.`],
        instruction:
          "Reopen the spec before starting an execution against its plan.",
      },
    });
  }
  if (deps.deliveryRepo.findActiveExecutionBySpecId(spec.id) !== null) {
    return done({
      ok: false,
      refusal: {
        code: "execution_active",
        unmetConditions: [`Spec ${spec.slug} already has an active execution.`],
        instruction: `Finish or abandon it with \`cctl spec abandon ${spec.slug} --execution <executionId>\` before launching this plan.`,
      },
    });
  }
  if (input.sessionName === null) {
    return done({
      ok: false,
      refusal: {
        code: "validation",
        unmetConditions: [
          "A delivery-plan launch pins the session it runs and merges through.",
        ],
        instruction:
          "Run `cctl spec start` from a session conversation, not a project conversation.",
      },
    });
  }

  // The plan's own pin, not the revision the request happened to name. The
  // launch persists `launch.pinnedRevisionId`, so reporting the requested
  // revision's number would pair an old revision id with a newer number on the
  // receipt whenever a revision was approved after the attempt opened.
  const pinned =
    launch.pinnedRevisionId === snapshot.revision.id
      ? snapshot
      : await deps.specsRepo.getRevisionSnapshot(launch.pinnedRevisionId);
  if (pinned === null) {
    return done({
      ok: false,
      refusal: {
        code: "not_found",
        unmetConditions: [
          `Delivery plan attempt ${launch.attemptId} pins revision ${launch.pinnedRevisionId}, which cannot be read.`,
        ],
        instruction: `Nothing was started. Inspect the pin with \`cctl spec plan status ${spec.slug}\`, then open a fresh attempt with \`cctl spec plan open ${spec.slug}\`.`,
      },
    });
  }

  const origin: GraphWorkflowExecutionOrigin = {
    kind: "spec_delivery",
    specSlug: spec.slug,
    candidateId: launch.candidate.candidateId,
  };

  const persistedHash = deliveryPlanCandidateHashFromBytes(
    launch.candidateBytes,
  );
  if (persistedHash !== launch.candidate.candidateHash) {
    return done({
      ok: false,
      refusal: {
        code: "integrity_mismatch",
        unmetConditions: [
          `The stored candidate bytes hash to ${persistedHash}, but the approved candidate identity is ${launch.candidate.candidateHash}.`,
        ],
        instruction: `Nothing was started. Re-read the approved candidate with \`cctl spec plan preview ${spec.slug} --stage proposed\`, then re-run \`cctl spec plan propose ${spec.slug}\` and sign the fresh candidate off.`,
      },
    });
  }

  const createdAt = deps.now();
  const binding = specExecutionBindingSnapshotV2Schema.parse({
    schemaVersion: 2,
    candidateId: launch.candidate.candidateId,
    candidateHash: launch.candidate.candidateHash,
    pinnedRevisionId: launch.pinnedRevisionId,
    dispositions: launch.binding.dispositions,
    claims: launch.claims,
  });
  const attachment = prepareSpecExecutionStartAttachment(
    {
      deliveryRepo: deps.deliveryRepo,
      bindingRepo: deps.bindingRepo,
      linksRepo: deps.linksRepo,
      plansRepo: deps.plansRepo,
      events: deps.events,
      nextLinkId: () => deps.nextId("link"),
    },
    {
      spec,
      specExecutionId: deps.nextId("execution"),
      attemptId: launch.attemptId,
      sessionName: input.sessionName,
      executionStartDial: specGateDialSchema.parse(
        resolveDial(spec.gatePolicy, "execution_start"),
      ),
      scope: launch.scope,
      origin,
      binding,
      workflowDefinition: launch.workflowDefinition,
      actor: input.actor,
      createdAt,
    },
  );

  // Everything spec-side is committed; the workflow start is handed back to
  // the caller so it runs with the write queue released.
  return {
    kind: "launch",
    pending: {
      spec,
      attachment,
      workflowDefinition: {
        id: launch.workflowDefinition.id,
        revision: launch.workflowDefinition.revision,
      },
      revisionNumber: pinned.revision.number,
      attemptId: launch.attemptId,
      candidate: launch.candidate,
      sessionName: input.sessionName,
      projectName: input.projectName ?? "",
      actor: input.actor,
      // The authenticated conversation that ran `spec start`. It is threaded
      // to the persisted execution so validation resolves the launching
      // planner before any lane exists (lifecycle contract, design §10).
      ownerConversationId:
        input.actor.kind === "agent" ? input.actor.conversationId : null,
      ...(input.parameters === undefined
        ? {}
        : { parameters: input.parameters }),
      seededDocuments: [],
    },
  };
}

/**
 * The launch itself, outside the write queue. Its transaction attachment binds
 * the spec execution before the graph execution commits; lifecycle reporting
 * then marks the bound execution running through the same queue.
 */
async function completeDeliveryPlanLaunch(
  deps: ExecutionServiceDeps,
  pending: PreparedDeliveryPlanLaunch,
): Promise<StartSpecExecutionResult> {
  const gate = deps.executionStartGate;
  if (gate === undefined) {
    return {
      ok: false,
      refusal: {
        code: "workflow_unavailable",
        unmetConditions: [
          "This composition has no shared graph start boundary, so the approved candidate cannot be launched.",
        ],
        instruction: `Nothing was written. Retry \`cctl spec start ${pending.spec.slug} --file .cc/temp/inputs.json\` after configuring the shared graph start boundary.`,
      },
    };
  }
  const launched = await gate.launchApprovedLaunch({
    projectName: pending.projectName,
    sessionName: pending.sessionName,
    definitionId: pending.workflowDefinition.id,
    definitionRevision: pending.workflowDefinition.revision,
    specSlug: pending.spec.slug,
    candidateId: pending.candidate.candidateId,
    ownerConversationId: pending.ownerConversationId,
    ...(pending.parameters === undefined
      ? {}
      : { parameters: pending.parameters }),
    seededDocuments: pending.seededDocuments,
    transactionAttachment: pending.attachment.attach,
  });
  if (!launched.ok) {
    const code = launched.code ?? "workflow_unavailable";
    return {
      ok: false,
      refusal: {
        code,
        unmetConditions: [
          `The approved candidate did not start: ${launched.reason}`,
        ],
        instruction:
          code === "validation"
            ? `Nothing was written. Correct the graph launch inputs, then retry \`cctl spec start ${pending.spec.slug} --file .cc/temp/inputs.json\` with the amended --file payload.`
            : `Nothing was written. Retry \`cctl spec start ${pending.spec.slug} --file .cc/temp/inputs.json\` after correcting the launch refusal.`,
      },
    };
  }

  publishPrepared(deps, pending.attachment.publications);
  const execution = deps.deliveryRepo.findExecutionById(
    pending.attachment.specExecutionId,
  );
  if (execution === null) {
    throw new Error(
      `Workflow execution ${launched.workflowExecutionId} committed without spec execution ${pending.attachment.specExecutionId}`,
    );
  }

  logger.info("specs.execution.delivery-plan-launched", {
    specId: pending.spec.id,
    executionId: execution.id,
    attemptId: pending.attemptId,
    candidateId: pending.candidate.candidateId,
    workflowExecutionId: launched.workflowExecutionId,
    candidateHash: pending.candidate.candidateHash,
  });
  return {
    ok: true,
    execution,
    workflowDefinition: pending.workflowDefinition,
    revisionNumber: pending.revisionNumber,
    deliveryPlan: {
      attemptId: pending.attemptId,
      candidateId: pending.candidate.candidateId,
      candidateHash: pending.candidate.candidateHash,
      workflowExecutionId: launched.workflowExecutionId,
      resolvedDefinitionHash: launched.resolvedDefinitionHash,
    },
  };
}

function cloneStartInput(
  input: StartSpecExecutionInput,
): StartSpecExecutionInput {
  return {
    ...input,
    actor: { ...input.actor },
  };
}

function refusedNotFound(condition: string): {
  ok: false;
  refusal: TransitionRefusal;
} {
  return {
    ok: false,
    refusal: {
      code: "not_found",
      unmetConditions: [condition],
      instruction: "Select an existing spec and revision, then start again.",
    },
  };
}

function logRefusal(specId: string, refusal: TransitionRefusal): void {
  logger.warn("specs.execution.start-refused", {
    specId,
    code: refusal.code,
    unmetConditionCount: refusal.unmetConditions.length,
  });
}

/**
 * A refused start is a server enforcement intervention: besides the log it
 * lands in the durable event log with the attempting actor's provenance so
 * release evidence can count refusals (Requirement 21.4).
 */
function recordStartRefusal(
  deps: Pick<ExecutionServiceDeps, "eventsRepo" | "now">,
  specId: string,
  actor: ActorProvenance,
  refusal: TransitionRefusal,
): void {
  logRefusal(specId, refusal);
  deps.eventsRepo.appendInTransaction({
    spec_id: specId,
    occurred_at: deps.now(),
    event_type: "spec-intervention-recorded",
    actor_json: JSON.stringify(actor),
    payload_json: JSON.stringify({
      kind: "transition-refused",
      surface: "execution_start",
      code: refusal.code,
      unmetConditions: refusal.unmetConditions,
      instruction: refusal.instruction,
    }),
  });
}

function appendExecutionEvent(
  deps: Pick<ExecutionServiceDeps, "events" | "specsRepo">,
  execution: SpecExecutionRow,
  kind: string,
  payload: Record<string, unknown>,
  actor: ActorProvenance | { kind: "system" } = { kind: "system" },
): PreparedSpecEventPublication {
  const spec = deps.specsRepo.findByIdInTransaction(execution.spec_id);
  if (spec === null) {
    throw new Error(`Spec ${execution.spec_id} vanished mid-transaction`);
  }
  return deps.events.appendInTransaction({
    actor,
    durableEventType: "spec-execution-changed",
    durablePayload: {
      kind,
      executionId: execution.id,
      revisionId: execution.revision_id,
      ...payload,
    },
    sseEvent: {
      type: "spec-execution-changed",
      kind,
      projectPath: spec.projectPath,
      specId: spec.id,
      specSlug: spec.slug,
      occurredAt: execution.updated_at,
      revisionId: execution.revision_id,
      executionId: execution.id,
    },
  });
}

function publishPrepared(
  deps: Pick<ExecutionServiceDeps, "events">,
  prepared: readonly PreparedSpecEventPublication[],
): void {
  for (const event of prepared) deps.events.publishAfterCommit(event);
}

function systemActorJson(): string {
  return JSON.stringify({ kind: "system" });
}

function findExecutionMergeLink(
  links: ReturnType<SpecLinksRepo["findBySpecId"]>,
  specExecutionId: string,
  mergeHash: string,
): boolean {
  return links.some((link) => {
    if (link.object_kind !== "merge_job") return false;
    try {
      const ref = JSON.parse(link.object_ref_json) as Record<string, unknown>;
      return (
        ref.specExecutionId === specExecutionId && ref.mergeHash === mergeHash
      );
    } catch {
      return false;
    }
  });
}

/**
 * The id an agent can address a run by: the workflow execution id, the only
 * execution id any `cctl` verb takes (design 3.5, D-B). `null` when no lane is
 * linked — the caller then states the fact without an id rather than falling
 * back to the internal spec execution row id, which every input surface
 * refuses and no agent can act on.
 */
function addressableExecutionId(execution: SpecExecutionRow): string | null {
  return (
    execution.workflow_execution_id ?? execution.linked_workflow_execution_id
  );
}

/**
 * A run whose row is gone. Deliberately id-free: the only id in hand at these
 * call sites is the internal spec execution row id, and printing it would
 * offer an id no verb accepts to retry with.
 */
function lifecycleExecutionNotFound(): LifecycleResult<never> {
  return lifecycleRefused(
    "not_found",
    ["The spec execution named was not found."],
    "Read `cctl spec status <slug>` for the runs this spec owns.",
  );
}

function lifecycleNotFound(identifier: string): LifecycleResult<never> {
  return lifecycleRefused(
    "not_found",
    [`Spec execution or spec ${identifier} was not found.`],
    "Select an existing spec execution and try again.",
  );
}

function lifecycleRefused(
  code: TransitionRefusal["code"],
  unmetConditions: string[],
  instruction: string,
): LifecycleResult<never> {
  logger.warn("specs.execution.lifecycle-refused", {
    code,
    unmetConditionCount: unmetConditions.length,
  });
  return {
    ok: false,
    refusal: { code, unmetConditions, instruction },
  };
}

async function seededDeliveryPlanInstruction(
  deps: Pick<ExecutionServiceDeps, "specsRepo">,
  specId: string,
  abandonWorkflowExecutionId?: string,
): Promise<string> {
  const spec = await deps.specsRepo.findById(specId);
  const target = spec?.slug ?? specId;
  const abandon =
    abandonWorkflowExecutionId === undefined
      ? ""
      : `Abandon execution ${abandonWorkflowExecutionId} with \`cctl spec abandon ${target} --execution ${abandonWorkflowExecutionId} --reason <reason>\`, then `;
  return `${abandon}open a seeded attempt with \`cctl spec plan open ${target}\`, propose and sign its candidate off, then launch it with \`cctl spec start ${target} --file .cc/temp/inputs.json\`.`;
}

function abandonReasonRefusal(): LifecycleResult<never> {
  return lifecycleRefused(
    "validation",
    ["Abandonment requires a non-empty reason."],
    "Provide the reason for abandonment and try again.",
  );
}

function deliveryStateRefusal(
  execution: SpecExecutionRow,
): LifecycleResult<never> {
  return lifecycleRefused(
    "gate_blocked",
    [
      `Execution ${execution.workflow_execution_id ?? execution.id} is ${execution.state}, not running.`,
    ],
    execution.state === "abandoned"
      ? "The execution is terminal; start a future execution only if the spec remains active."
      : "Start the linked workflow before recording successful delivery.",
  );
}
