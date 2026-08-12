import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";
import type { WriteQueue } from "@/lib/state-store/write-queue";
import type {
  GraphWorkflowStatus,
  GraphWorkflowVisualLayout,
  WorkflowDefinitionRecord,
} from "@/lib/workflow-graph/definition-schemas";
import type {
  WorkflowDefinitionDraft,
  WorkflowDefinitionSummary,
  WorkflowScope,
} from "@/lib/workflow-graph/storage";
import type { GraphExecutionLifecycleContext } from "@/lib/workflow-graph/execution-lifecycle-port";
import type { SeededWorkflowDocument } from "@/lib/workflow-graph/shared-documents";
import { buildPinnedSpecDocument } from "./export";
import {
  INITIAL_ABANDON_CLEANUP_PHASE,
  abandonFinalizationAllowed,
  nextAbandonCleanupStep,
  type LinkedWorkflowObservation,
} from "./abandon-coordinator";
import {
  liveDeliveryPlanAttempt,
  type DeliveryPlanCandidateIdentity,
} from "./delivery-plan";
import { deliveryPlanCompiledHash } from "./delivery-plan-materializer";
import type {
  DeliveryPlanLaunchCandidate,
  DeliveryPlanLaunchResolution,
  ParkDeliveryPlanServiceInput,
  PlanResult,
} from "./delivery-plan-service";
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
import type { SpecMeasureEventPayload } from "./measures";
import { resolveDial } from "./policy";
import {
  recordPolicyGateAdmissionInTransaction,
  type SpecPolicyAdmissionNotice,
  type SpecPolicyAdmissionNotifier,
} from "./policy-admissions";
import {
  refusalCodeSchema,
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
import { executionScopeSchema, type ExecutionScope } from "./scope-validation";
import type { TransitionRefusal } from "./transitions";

const logger = createLogger("specs.execution-service");

export interface ExecutionWorkflowDefinitions {
  findByOrigin(sourceUri: string): Promise<WorkflowDefinitionRecord | null>;
  create(draft: WorkflowDefinitionDraft): Promise<WorkflowDefinitionRecord>;
  update(
    workflowId: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord>;
}

export interface WorkflowDefinitionStoragePort {
  list(scope: WorkflowScope): Promise<WorkflowDefinitionSummary[]>;
  get(
    scope: WorkflowScope,
    workflowId: string,
  ): Promise<WorkflowDefinitionRecord | null>;
  create(
    scope: WorkflowScope,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord>;
  update(
    scope: WorkflowScope,
    workflowId: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord>;
}

export function bindExecutionWorkflowDefinitions(
  storage: WorkflowDefinitionStoragePort,
  scope: WorkflowScope,
): ExecutionWorkflowDefinitions {
  return {
    async findByOrigin(sourceUri) {
      const summaries = await storage.list(scope);
      for (const summary of summaries) {
        const record = await storage.get(scope, summary.id);
        if (record?.definition.origin?.sourceUri === sourceUri) return record;
      }
      return null;
    },
    create(draft) {
      return storage.create(scope, draft);
    },
    update(workflowId, draft) {
      return storage.update(scope, workflowId, draft);
    },
  };
}

export interface ExecutionServiceDeps {
  specsRepo: SpecsRepo;
  deliveryRepo: SpecDeliveryRepo;
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
  workflowDefinitions: ExecutionWorkflowDefinitions;
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
  ingestExecutionEvidence(executionId: string): Promise<unknown>;
  /**
   * Whether the named session resolves in this project. Launch and merge are
   * both session-scoped, so the pin is validated before it is persisted.
   */
  sessionExists(sessionName: string): Promise<boolean>;
  getWorkflowExecutionStatus(
    workflowExecutionId: string,
  ): Promise<SpecWorkflowLaneStatus | null>;
  getPublishedMerge(workflowExecutionId: string): Promise<{
    mergeHash: string;
    deliveryGatePassed: boolean;
  } | null>;
  runInImmediateTransaction<T>(fn: () => T): T;
  /**
   * The execution-start gate's review and workflow ports, injected at
   * composition. `hasPendingDefinitionApproval` probes whether the session's
   * workflow execution is actually parked awaiting definition approval;
   * `ensurePendingDefinitionApproval` launches the prepared definition through
   * the production workflow seam when the Studio approval is the first launch
   * act;
   * `grantApproval` records the human execution-start approval (spec approval
   * + gate admission + durable event); `approveWorkflowDefinition` approves
   * the session's pending compiled definition and starts the run through the
   * graph-workflow seam. The review port serializes through the shared write
   * queue, so it must never be called while this service already holds it.
   */
  executionStartGate?: ExecutionStartGatePort;
  /** Post-hoc review notices for Notify-dial policy admissions (R11.2). */
  policyNotifier?: SpecPolicyAdmissionNotifier;
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
    "findAttemptsBySpecId" | "recordDiscovery"
  >;
}

/**
 * The replacement a blocking capture opens. It goes through the same seeded
 * open `cctl spec plan open --seed-from last` performs, so the discovery is
 * placed by the one seed that knows how (design §11).
 */
export interface SpecDeliveryPlanCapturePort {
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
  recordLaunch(input: {
    spec: Spec;
    executionId: string;
    candidate: DeliveryPlanCandidateIdentity;
    actor: ActorProvenance;
  }): Promise<PlanResult<unknown>>;
}

/** The pinned cleanup target — never re-resolved from the session's slot. */
export interface SpecWorkflowCleanupTarget {
  projectPath: string;
  sessionName: string;
  workflowExecutionId: string;
}

/**
 * Where the pinned run stands. `active` means it is still the session's live
 * row and owns the slot whatever its status; `archived` means it has been
 * moved out and owns nothing. The distinction is what separates "aborted but
 * still holding the slot" from "released".
 */
export type SpecWorkflowCleanupObservation =
  | { kind: "missing" }
  | { kind: "archived"; status: GraphWorkflowStatus }
  | { kind: "active"; status: GraphWorkflowStatus };

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
  /** Abort the pinned run through the production workflow abort seam. */
  abort(
    target: SpecWorkflowCleanupTarget & { reason: string },
  ): Promise<SpecWorkflowCleanupOutcome>;
  /** The explicit audited archive act that releases the session's slot. */
  release(
    target: SpecWorkflowCleanupTarget & { reason: string },
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

export interface ExecutionStartGatePort {
  /**
   * Launch a definition the human already approved, through the production
   * start+kickoff seam. Distinct from `ensurePendingDefinitionApproval`, which
   * exists to PARK a run at definition review: a delivery-plan candidate
   * carries `approvalRequired: false` because the plan sign-off already
   * admitted `execution_start`, so it must start rather than park (design §5).
   *
   * `ownerConversationId` is the authenticated conversation that ran
   * `spec start`, resolved server-side by the caller and threaded to the
   * persisted execution so validation can resolve it before any lane exists.
   */
  launchApprovedDefinition(input: {
    projectName: string;
    sessionName: string;
    definitionId: string;
    definitionRevision: number;
    ownerConversationId: string | null;
    /**
     * The pinned spec revision, rendered by the spec layer and handed to the
     * workflow engine as opaque bytes to seed into every lane worktree. The
     * plan's #1-ranked source of truth is only readable because this rides
     * along with the launch.
     */
    seededDocuments: readonly SeededWorkflowDocument[];
  }): Promise<
    { ok: true; workflowExecutionId: string } | { ok: false; reason: string }
  >;
  hasPendingDefinitionApproval(input: {
    projectName: string;
    sessionName: string;
    definitionId: string;
    definitionRevision: number;
  }): Promise<string | null>;
  ensurePendingDefinitionApproval(input: {
    projectName: string;
    sessionName: string;
    definitionId: string;
    definitionRevision: number;
    /**
     * Owner conversation for the launched run. Required (not optional) so this
     * seam has to state what it captured: today's Studio grant is human-only
     * and therefore has no conversation identity, which is an honest `null`
     * rather than a forgotten field. An unowned run keeps validation
     * fail-closed until it has lanes.
     */
    ownerConversationId: string | null;
    /**
     * The pinned spec revision, same shape and same purpose as on
     * {@link ExecutionStartGatePort.launchApprovedDefinition}. Carried here too
     * so a run's seeded documents never depend on which launch path fired.
     */
    seededDocuments: readonly SeededWorkflowDocument[];
  }): Promise<
    { ok: true; workflowExecutionId: string } | { ok: false; reason: string }
  >;
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
  approveWorkflowDefinition(input: {
    projectName: string;
    sessionName: string;
    workflowExecutionId: string;
    definitionId: string;
    definitionRevision: number;
  }): Promise<
    | { ok: true }
    | {
        ok: false;
        reason:
          | "unavailable"
          | "no_active_execution"
          | "not_awaiting_approval"
          | "already_decided"
          | "definition_mismatch"
          | "definition_revision_mismatch"
          | "execution_mismatch";
      }
    | { ok: false; reason: "gate_refused"; refusal: DefinitionGateRefusal }
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
  | "linksRepo"
  | "eventsRepo"
  | "reviewRepo"
  | "events"
  | "writeQueue"
  | "nextId"
  | "now"
  | "ingestExecutionEvidence"
  | "getPublishedMerge"
  | "runInImmediateTransaction"
  | "policyNotifier"
  | "attentionNotifier"
  | "workflowCleanup"
> & {
  lifecycleGate?: ExecutionLifecycleGatePort;
};

export interface ExecutionLifecycleCallbacks {
  markRunning(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    definitionId?: string,
    definitionRevision?: number,
  ): Promise<void>;
  markDelivered(workflowExecutionId: string, mergeHash: string): Promise<void>;
  awaitingDefinitionApproval(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    definitionId: string,
    definitionRevision: number,
  ): Promise<void>;
  admitDefinitionApproval(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    definitionId: string,
    definitionRevision: number,
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
      definition: WorkflowDefinitionRecord;
      /** The pinned revision's number, so the receipt needs no second read. */
      revisionNumber: number;
      /**
       * The approved candidate this launch ran. The receipt prints it so
       * `exact-approval` is observable from the command that performed it.
       */
      deliveryPlan: {
        attemptId: string;
        candidateId: string;
        planHash: string;
        compiledDefinitionHash: string;
      };
    }
  | { ok: false; refusal: TransitionRefusal };

/** What `spec start --park` held; no execution was launched or reported. */
export interface ParkedDeliveryPlanResult {
  attemptId: string;
  candidateId: string;
  planHash: string;
  compiledDefinitionHash: string;
  nextAct: DeliveryPlanNextAct;
}

export interface ApproveExecutionStartInput {
  specId: string;
  executionId: string;
  actor: ActorProvenance;
  approver: string;
  projectName: string;
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
  approveExecutionStart(
    input: ApproveExecutionStartInput,
  ): Promise<LifecycleResult<SpecExecutionRow>>;
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
   * already knows which execution it launched; naming one matters only for a
   * legacy compiled run, which has no attempt behind it.
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
    /** Null when the run came from the legacy compiled path. */
    attemptId: string | null;
    title: string;
  };
  /** True when `--blocking-reason` retired the run the work was found in. */
  restartRequired: boolean;
  /** The blocking path's outcome: what it retired and what it opened. */
  replacement: {
    abandonedExecutionId: string;
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
    async approveExecutionStart(input) {
      return approveExecutionStart(deps, input);
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
    abandonExecution(input) {
      return abandonExecution(deps, input);
    },
    abandonSpec(input) {
      return abandonSpec(deps, input);
    },
    captureScopeAmendment(input) {
      return captureScopeAmendment(deps, input);
    },
  };
}

export function createExecutionLifecycleCallbacks(
  deps: ExecutionLifecycleDeps,
): ExecutionLifecycleCallbacks {
  function findExecutionForWorkflow(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    definitionId: string | undefined,
    definitionRevision: number | undefined,
  ): SpecExecutionRow | null {
    const linked =
      deps.deliveryRepo.findExecutionByWorkflowExecutionIdInSession(
        context.projectPath,
        context.sessionName,
        workflowExecutionId,
      );
    if (linked !== null) {
      const definitionMatches =
        definitionId === undefined ||
        linked.workflow_definition_id === definitionId;
      const revisionMatches =
        definitionRevision === undefined ||
        linked.workflow_definition_revision === null ||
        linked.workflow_definition_revision === definitionRevision;
      if (definitionMatches && revisionMatches) {
        if (
          definitionRevision !== undefined &&
          linked.workflow_definition_revision === null
        ) {
          logger.warn(
            "specs.execution.workflow-correlation-linked-without-revision",
            {
              projectPath: context.projectPath,
              sessionName: context.sessionName,
              workflowExecutionId,
              specExecutionId: linked.id,
              reportedDefinitionId: definitionId,
              reportedDefinitionRevision: definitionRevision,
              pinnedDefinitionId: linked.workflow_definition_id,
            },
          );
        }
        return linked;
      }
      logger.warn("specs.execution.workflow-correlation-refused", {
        projectPath: context.projectPath,
        sessionName: context.sessionName,
        workflowExecutionId,
        specExecutionId: linked.id,
        reportedDefinitionId: definitionId,
        reportedDefinitionRevision: definitionRevision,
        pinnedDefinitionId: linked.workflow_definition_id,
        pinnedDefinitionRevision: linked.workflow_definition_revision,
      });
      return null;
    }
    if (definitionId === undefined || definitionRevision === undefined) {
      return null;
    }
    return deps.deliveryRepo.findExecutionAwaitingWorkflowByDefinitionIdInSession(
      context.projectPath,
      context.sessionName,
      definitionId,
      definitionRevision,
    );
  }

  return {
    async markRunning(
      context,
      workflowExecutionId,
      definitionId,
      definitionRevision,
    ) {
      const execution = findExecutionForWorkflow(
        context,
        workflowExecutionId,
        definitionId,
        definitionRevision,
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
    async markDelivered(workflowExecutionId, mergeHash) {
      const execution =
        deps.deliveryRepo.findExecutionByWorkflowExecutionId(
          workflowExecutionId,
        );
      if (execution === null) return;
      const result = await markDelivered(deps, execution.id, mergeHash);
      if (!result.ok) throw new Error(result.refusal.unmetConditions.join(" "));
    },
    /**
     * A compiled definition parked awaiting approval: link the awaiting spec
     * execution to its workflow execution and open the durable Needs You
     * request — the point where a human grant has real waiting work to
     * unblock (R10.9).
     */
    async awaitingDefinitionApproval(
      context,
      workflowExecutionId,
      definitionId,
      definitionRevision,
    ) {
      const awaiting = findExecutionForWorkflow(
        context,
        workflowExecutionId,
        definitionId,
        definitionRevision,
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
     */
    async admitDefinitionApproval(
      context,
      workflowExecutionId,
      definitionId,
      definitionRevision,
    ) {
      const execution = findExecutionForWorkflow(
        context,
        workflowExecutionId,
        definitionId,
        definitionRevision,
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
      if (execution.workflow_execution_id === null) {
        const linked = await linkWorkflowExecution(
          deps,
          execution.id,
          workflowExecutionId,
        );
        if (!linked.ok) return definitionGateRefusal(linked.refusal);
      }
      const gate = deps.lifecycleGate;
      if (gate === undefined) {
        return {
          ok: false,
          code: "gate_blocked",
          unmetConditions: [
            "The spec execution-start gate is not wired into this composition.",
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
      return { ok: true };
    },
    async executionAborted(workflowExecutionId) {
      const execution =
        deps.deliveryRepo.findExecutionByWorkflowExecutionId(
          workflowExecutionId,
        );
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

/**
 * Rebuild the pinned-spec document from an execution row's own pin, for the
 * launch paths that resolve the snapshot after the launch was prepared. `null`
 * means the pin cannot be read — the caller must refuse rather than launch a
 * run whose plan cites a source of truth no lane will have.
 */
async function resolvePinnedSpecDocuments(
  deps: ExecutionServiceDeps,
  execution: SpecExecutionRow,
): Promise<readonly SeededWorkflowDocument[] | null> {
  const spec = await deps.specsRepo.findById(execution.spec_id);
  if (spec === null) return null;
  const pinned = await deps.specsRepo.getRevisionSnapshot(
    execution.revision_id,
  );
  if (pinned === null) return null;
  return [buildPinnedSpecDocument(spec, pinned)];
}

/**
 * The human execution-start grant launches the prepared definition when the
 * Studio action is the first workflow-side act, records the human-only gate
 * approval, then approves the parked definition through the graph-workflow
 * seam. Launching before the grant preserves the invariant that an admission
 * is written only when a concrete workflow execution is waiting to consume it.
 */
async function approveExecutionStart(
  deps: ExecutionServiceDeps,
  input: ApproveExecutionStartInput,
): Promise<LifecycleResult<SpecExecutionRow>> {
  if (input.actor.kind !== "human") {
    return lifecycleRefused(
      "human_act_required",
      ["Execution-start approval is a human-only act."],
      "Approve the execution start from Spec Studio.",
    );
  }
  const gate = deps.executionStartGate;
  if (gate === undefined) {
    throw new Error(
      "The execution-start gate port is not wired into this composition",
    );
  }
  const execution = deps.deliveryRepo.findExecutionById(input.executionId);
  if (execution === null) return lifecycleNotFound(input.executionId);
  if (execution.spec_id !== input.specId) {
    return lifecycleRefused(
      "validation",
      ["The execution does not belong to this spec."],
      "Approve the execution from its own spec's Studio page.",
    );
  }
  if (execution.state === "abandoned" || execution.state === "delivered") {
    return lifecycleRefused(
      "gate_blocked",
      [`A ${execution.state} execution cannot be start-approved.`],
      await seededDeliveryPlanInstruction(deps, execution.spec_id),
    );
  }
  if (execution.session_name === null) {
    return lifecycleRefused(
      "gate_blocked",
      ["The execution is not pinned to a session."],
      "Start the compiled workflow from a session before approving execution start.",
    );
  }
  if (execution.workflow_definition_revision === null) {
    logger.warn("specs.execution.start-definition-revision-missing", {
      specId: input.specId,
      specExecutionId: execution.id,
      workflowDefinitionId: execution.workflow_definition_id,
    });
    return lifecycleRefused(
      "gate_blocked",
      ["The execution predates immutable workflow-definition revision pins."],
      await seededDeliveryPlanInstruction(
        deps,
        execution.spec_id,
        execution.id,
      ),
    );
  }

  let workflowExecutionId = await gate.hasPendingDefinitionApproval({
    projectName: input.projectName,
    sessionName: execution.session_name,
    definitionId: execution.workflow_definition_id,
    definitionRevision: execution.workflow_definition_revision,
  });
  if (workflowExecutionId === null) {
    const seededDocuments = await resolvePinnedSpecDocuments(deps, execution);
    if (seededDocuments === null) {
      return lifecycleRefused(
        "gate_blocked",
        [
          `The execution pins revision ${execution.revision_id}, which cannot be read, so the pinned spec cannot be seeded into its lanes.`,
        ],
        await seededDeliveryPlanInstruction(
          deps,
          execution.spec_id,
          execution.id,
        ),
      );
    }
    const ensured = await gate.ensurePendingDefinitionApproval({
      projectName: input.projectName,
      sessionName: execution.session_name,
      definitionId: execution.workflow_definition_id,
      definitionRevision: execution.workflow_definition_revision,
      // Human-only act (every agent actor is refused above), and a human
      // approver has no conversation identity — so this launch is genuinely
      // unowned. Stated explicitly rather than omitted so the null is a
      // decision the seam records, not a field someone forgot.
      ownerConversationId: null,
      seededDocuments,
    });
    if (!ensured.ok) {
      logger.warn("specs.execution.start-launch-refused", {
        specId: input.specId,
        specExecutionId: execution.id,
        workflowDefinitionId: execution.workflow_definition_id,
        workflowDefinitionRevision: execution.workflow_definition_revision,
        sessionName: execution.session_name,
        reason: ensured.reason,
      });
      return lifecycleRefused(
        "gate_blocked",
        [ensured.reason],
        "Resolve the workflow start condition, then approve execution start again.",
      );
    }
    workflowExecutionId = ensured.workflowExecutionId;
  }

  const grant = await gate.grantApproval({
    specId: input.specId,
    revisionId: execution.revision_id,
    executionId: execution.id,
    actor: input.actor,
    approver: input.approver,
  });
  if (!grant.ok) return { ok: false, refusal: grant.refusal };

  const approved = await gate.approveWorkflowDefinition({
    projectName: input.projectName,
    sessionName: execution.session_name,
    workflowExecutionId,
    definitionId: execution.workflow_definition_id,
    definitionRevision: execution.workflow_definition_revision,
  });
  if (!approved.ok && approved.reason !== "already_decided") {
    if (approved.reason === "unavailable") {
      return lifecycleRefused(
        "gate_blocked",
        ["Workflow definition approval is not available on this server."],
        "Retry once the graph-workflow definition gate is available.",
      );
    }
    if (approved.reason === "gate_refused") {
      const parsedCode = refusalCodeSchema.safeParse(approved.refusal.code);
      return lifecycleRefused(
        parsedCode.success ? parsedCode.data : "gate_blocked",
        [...approved.refusal.unmetConditions],
        approved.refusal.instruction,
      );
    }
    return lifecycleRefused(
      "gate_blocked",
      [
        "The workflow execution stopped awaiting definition approval before the grant completed.",
      ],
      "Start the compiled workflow from the session — the human approval stays recorded — then approve again.",
    );
  }

  const updated =
    deps.deliveryRepo.findExecutionById(execution.id) ?? execution;
  logger.info("specs.execution.start-approved", {
    specId: input.specId,
    specExecutionId: execution.id,
    approvalId: grant.value.id,
    workflowApproval: approved.ok ? "approved" : "already_decided",
    state: updated.state,
  });
  return { ok: true, value: updated };
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
          snapshot_json: JSON.stringify({
            specExecutionId,
            workflowDefinitionId: current.workflow_definition_id,
          }),
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
      const notices: SpecPolicyAdmissionNotice[] = [];
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
      for (const notice of notices) deps.policyNotifier?.policyAdmitted(notice);
      return result;
    },
  );
}

/**
 * A definition-review -> running transition admitted without a human gate is
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
  notices: SpecPolicyAdmissionNotice[],
): void {
  const spec = deps.specsRepo.findByIdInTransaction(execution.spec_id);
  if (spec === null) return;
  if (execution.execution_start_dial === null) {
    logger.warn("specs.execution.start-policy-unavailable", {
      specExecutionId: execution.id,
      workflowDefinitionId: execution.workflow_definition_id,
      workflowDefinitionRevision: execution.workflow_definition_revision,
    });
    return;
  }
  const recorded = recordPolicyGateAdmissionInTransaction(
    {
      reviewRepo: deps.reviewRepo,
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
  prepared.push(recorded.prepared);
  if (recorded.notice !== null) notices.push(recorded.notice);
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
  if (candidate.workflow_execution_id === null) {
    return lifecycleRefused(
      "gate_blocked",
      ["Delivered requires a linked workflow execution."],
      "Link and start the workflow execution before publishing delivery.",
    );
  }
  const published = await deps.getPublishedMerge(
    candidate.workflow_execution_id,
  );
  if (
    published === null ||
    published.mergeHash !== mergeHash ||
    !published.deliveryGatePassed
  ) {
    return lifecycleRefused(
      "gate_blocked",
      [
        "The linked workflow has no matching successfully published, delivery-gate-passed merge.",
      ],
      "Complete the delivery gate and publish the linked workflow candidate before recording Delivered.",
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
  await deps.ingestExecutionEvidence(specExecutionId);

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
  if (delivered.ok) {
    // The pre-flip ingest above ran while both the spec execution and (on the
    // publish path) the graph workflow were still running, so a followerless
    // final validation stayed deferred. Now that Delivered is durable the
    // stamp is decidable — no sealing commit can ever follow a published
    // merge — so fold once more; the append-once ingest key makes a replay
    // free. A failure here must not un-deliver: ingest re-runs at every
    // later claim/gate/status touchpoint.
    try {
      await deps.ingestExecutionEvidence(specExecutionId);
    } catch (error) {
      logger.warn("specs.execution.delivered-evidence-ingest-failed", {
        specExecutionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
  if (
    workflowStatus === "completed" &&
    publishedMerge?.deliveryGatePassed !== true
  ) {
    await deps.ingestExecutionEvidence(specExecutionId);
    logger.info("specs.execution.evidence-reconciled", {
      specExecutionId,
      workflowExecutionId,
      workflowStatus,
    });
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
      `No graph-workflow cleanup port is wired into this composition, so execution ${target.workflowExecutionId} cannot be released here.`,
      "Abort and release it with 'cctl workflow live abort --reason <reason>' and 'cctl workflow live release --reason <reason>', then retry this command.",
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
      return await finalizeAbandon(deps, current, input, reason);
    }

    if (act.kind !== "skip") {
      // `target` is non-null on every path that reaches an abort/release act:
      // both are produced only from an `active` observation, which requires a
      // pinned workflow.
      if (target === null || deps.workflowCleanup === undefined) {
        throw new Error(
          `Abandon coordinator produced ${act.kind} with no cleanup target`,
        );
      }
      const remedy =
        act.kind === "abort_workflow"
          ? "Abort it with 'cctl workflow live abort --reason <reason>', then retry this command."
          : "Release the slot with 'cctl workflow live release --reason <reason>', then retry this command.";
      let outcome: SpecWorkflowCleanupOutcome;
      try {
        outcome =
          act.kind === "abort_workflow"
            ? await deps.workflowCleanup.abort({ ...target, reason })
            : await deps.workflowCleanup.release({ ...target, reason });
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
      // writing `..._aborted` / `..._slot_released` over a no-op is exactly the
      // false receipt this coordinator exists to prevent. Parking here instead
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
      kind:
        act.kind === "abort_workflow"
          ? "execution_cleanup_workflow_aborted"
          : act.kind === "release_slot"
            ? "execution_cleanup_slot_released"
            : "execution_cleanup_skipped",
      payload:
        act.kind === "skip"
          ? { phase, note: act.note }
          : { phase, workflowExecutionId: act.workflowExecutionId },
    });
  }
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
        if (current === null) return lifecycleNotFound(input.executionId);
        if (current.state === "abandoned" || current.state === "delivered") {
          return lifecycleRefused(
            "gate_blocked",
            [`Execution ${input.executionId} is terminal (${current.state}).`],
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

async function finalizeAbandon(
  deps: ExecutionLifecycleDeps,
  execution: SpecExecutionRow,
  input: AbandonExecutionInternalInput,
  reason: string,
): Promise<LifecycleResult<SpecExecutionRow>> {
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
      ? `cctl spec plan edit ${slug} --file <plan.json>`
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
export function notRunningCaptureRefusal(
  slug: string,
  execution: SpecExecutionRow,
): LifecycleResult<never> {
  const remedy =
    execution.state === "abandoning"
      ? `Nothing was captured. Execution ${execution.id} is mid-abandon: resume its cleanup with \`cctl spec abandon --execution ${execution.id} --reason <why>\` (it continues from the phase it reached), then open the replacement with \`cctl spec plan open ${slug} --seed-from last\` — any discovery already captured against it is durable and the seed places it.`
      : `Nothing was captured. Plan the work directly instead: \`cctl spec plan open ${slug} --seed-from last\`.`;
  return lifecycleRefused(
    "gate_blocked",
    [
      `Execution ${execution.id} is ${execution.state}, and discovered work can be captured only while it runs.`,
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
      `Nothing was captured. Open a plan with \`cctl spec plan open ${spec.slug} --seed-from last\`, or name the run with \`cctl spec capture ${spec.slug} --execution <execution-id> --file <task.json>\`.`,
    );
  }

  const execution = deps.deliveryRepo.findExecutionById(executionId);
  if (execution === null) return lifecycleNotFound(executionId);
  if (execution.spec_id !== spec.id) {
    return lifecycleRefused(
      "gate_blocked",
      [`Execution ${executionId} belongs to a different spec.`],
      `Nothing was captured. Re-run against the run this spec launched — \`cctl spec status ${spec.slug}\` names it.`,
    );
  }
  if (execution.state !== "running") {
    return notRunningCaptureRefusal(spec.slug, execution);
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
      if (current === null) return lifecycleNotFound(execution.id);
      if (current.state !== "running") {
        return notRunningCaptureRefusal(spec.slug, current);
      }
      // The pin is what the discovery's ids were judged against; a run that
      // re-pinned mid-capture would make that judgment stale.
      if (current.revision_id !== execution.revision_id) {
        return lifecycleRefused(
          "gate_blocked",
          [
            `Execution ${current.id} re-pinned from revision ${execution.revision_id} to ${current.revision_id} while the capture was being judged.`,
          ],
          `Nothing was captured. Re-run \`cctl spec capture ${spec.slug} --file <task.json>\` so the discovered task is judged against the run's current pin.`,
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
            `Discovery ${discovery.id} is already durable against execution ${execution.id}, so the work is not lost.`,
          ],
          instruction: `${abandoned.refusal.instruction} Then finish this capture's two remaining acts, in order: resume the abandon with \`cctl spec abandon --execution ${execution.id} --reason ${JSON.stringify(blockingReason)}\`, then open the replacement with \`cctl spec plan open ${spec.slug} --seed-from last\` — it places discovery ${discovery.id}. Do not re-run \`cctl spec capture\`: it would record the same work twice.`,
        },
      };
    }
    const opened = await deps.deliveryPlanCapture?.openSeededReplacement({
      spec,
      actor: input.actor,
    });
    if (opened === undefined) {
      return lifecycleRefused(
        "gate_blocked",
        [
          `Execution ${execution.id} was abandoned, but no delivery-plan port is wired into this composition, so no replacement plan could be opened.`,
        ],
        `The discovery is durable. Open the replacement yourself with \`cctl spec plan open ${spec.slug} --seed-from last\` — the seed places it.`,
      );
    }
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
 * records are already committed; only the workflow start remains, and it must
 * happen outside the queue because the lifecycle port re-enters it to link and
 * mark the execution running.
 */
interface PreparedDeliveryPlanLaunch {
  spec: Spec;
  execution: SpecExecutionRow;
  definition: WorkflowDefinitionRecord;
  revisionNumber: number;
  attemptId: string;
  candidate: DeliveryPlanCandidateIdentity;
  sessionName: string;
  projectName: string;
  ownerConversationId: string | null;
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
      "The delivery-plan launch service is not wired into this composition.",
    ],
    instruction: `Nothing was ${act}. Open and inspect the candidate with \`cctl spec plan open ${slug} --seed-from last\`, then retry in a Command Center composition that supports delivery-plan launch.`,
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
      planHash: target.candidate.planHash,
      compiledDefinitionHash: target.candidate.compiledDefinitionHash,
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
        instruction: `Nothing was started. Inspect the pin with \`cctl spec plan status ${spec.slug}\`, then open a fresh attempt with \`cctl spec plan open ${spec.slug} --seed-from last\`.`,
      },
    });
  }

  const definitionValue = launch.definition;
  const originSourceUri = definitionValue.origin?.sourceUri ?? null;
  if (originSourceUri === null) {
    throw new Error(
      `Approved candidate ${launch.candidate.candidateId} carries no origin source uri`,
    );
  }
  const definitionDraft = workflowDraft(
    spec.name,
    pinned.revision.number,
    definitionValue,
  );
  const orphan = await deps.workflowDefinitions.findByOrigin(originSourceUri);
  const definition =
    orphan === null
      ? await deps.workflowDefinitions.create(definitionDraft)
      : isDeepStrictEqual(orphan.definition, definitionValue)
        ? orphan
        : await deps.workflowDefinitions.update(orphan.id, definitionDraft);

  // The exactness contract, checked rather than assumed: what the storage
  // round-trip produced has to still hash to the bytes the human approved
  // (`exact-approval`). A refusal here means the definition store altered the
  // candidate, which no launch may paper over.
  const persistedHash = deliveryPlanCompiledHash(definition.definition);
  if (persistedHash !== launch.candidate.compiledDefinitionHash) {
    return done({
      ok: false,
      refusal: {
        code: "integrity_mismatch",
        unmetConditions: [
          `The stored workflow definition hashes to ${persistedHash}, but the approved candidate is ${launch.candidate.compiledDefinitionHash}.`,
        ],
        instruction: `Nothing was started. Re-read the approved candidate with \`cctl spec plan preview ${spec.slug} --stage proposed\`, then re-run \`cctl spec plan propose ${spec.slug}\` and sign the fresh candidate off.`,
      },
    });
  }

  const prepared: PreparedSpecEventPublication[] = [];
  const createdAt = deps.now();
  const execution: SpecExecutionRow = deps.runInImmediateTransaction(() => {
    const row: SpecExecutionRow = {
      id: deps.nextId("execution"),
      spec_id: spec.id,
      revision_id: launch.pinnedRevisionId,
      scope_json: JSON.stringify(launch.scope),
      // Transient: the run has no approval left to wait for, and the
      // registered lifecycle port flips it to `running` the moment the
      // workflow reports its start.
      state: "definition_review",
      execution_start_dial: specGateDialSchema.parse(
        resolveDial(spec.gatePolicy, "execution_start"),
      ),
      workflow_definition_id: definition.id,
      workflow_definition_revision: definition.revision,
      workflow_execution_id: null,
      session_name: input.sessionName,
      delivered_at: null,
      abandoned_reason: null,
      cleanup_phase: null,
      linked_workflow_execution_id: null,
      cleanup_last_error: null,
      cleanup_last_error_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    deps.deliveryRepo.insertExecution(row);
    for (const entry of launch.dispositions) {
      deps.deliveryRepo.saveCriterionDisposition({
        execution_id: row.id,
        criterion_element_id: entry.criterionElementId,
        disposition: entry.disposition,
        waiver_id: null,
        delivered_by_execution_id: entry.deliveredByExecutionId,
        created_at: createdAt,
        updated_at: createdAt,
      });
    }
    deps.linksRepo.insertLink({
      id: deps.nextId("link"),
      spec_id: spec.id,
      object_kind: "workflow_execution",
      object_ref_json: JSON.stringify({
        workflowDefinitionId: definition.id,
        workflowDefinitionRevision: definition.revision,
        workflowExecutionId: null,
      }),
      direction: "outbound",
      category: "source",
      snapshot_json: JSON.stringify({
        revisionId: launch.pinnedRevisionId,
        deliveryPlanAttemptId: launch.attemptId,
        planHash: launch.candidate.planHash,
        compiledDefinitionHash: launch.candidate.compiledDefinitionHash,
      }),
      element_ids_json: JSON.stringify(launch.scope.selectedCriterionIds),
      actor_json: JSON.stringify(input.actor),
      created_at: createdAt,
    });
    prepared.push(
      deps.events.appendInTransaction({
        actor: input.actor,
        durableEventType: "spec-execution-changed",
        durablePayload: {
          kind: "execution_started",
          executionId: row.id,
          revisionId: launch.pinnedRevisionId,
          workflowDefinitionId: definition.id,
          workflowDefinitionRevision: definition.revision,
          deliveryPlanAttemptId: launch.attemptId,
          candidateId: launch.candidate.candidateId,
          planHash: launch.candidate.planHash,
          compiledDefinitionHash: launch.candidate.compiledDefinitionHash,
        },
        sseEvent: {
          type: "spec-execution-changed",
          kind: "execution_started",
          projectPath: spec.projectPath,
          specId: spec.id,
          specSlug: spec.slug,
          occurredAt: createdAt,
          revisionId: launch.pinnedRevisionId,
          executionId: row.id,
        },
      }),
    );
    return row;
  });
  publishPrepared(deps, prepared);

  const recorded = await planPort.recordLaunch({
    spec,
    executionId: execution.id,
    candidate: launch.candidate,
    actor: input.actor,
  });
  if (!recorded.ok) {
    // The execution row is already committed, and plan mutations do not share
    // this write queue — so a reopen landing while the definition was being
    // persisted rejects the candidate here, after the row exists. Leaving it
    // would strand an ACTIVE execution that blocks every retry, so it is
    // retired audibly rather than abandoned in place (`audited-transitions`).
    const rolledBack = rollBackUnlaunchedExecution(
      deps,
      spec,
      execution,
      input.actor,
      `The approved candidate was rejected at launch: ${recorded.refusal.unmetConditions.join(" ")}`,
    );
    const refusal = asTransitionRefusal(recorded.refusal);
    return done({
      ok: false,
      refusal: {
        ...refusal,
        unmetConditions: [
          ...refusal.unmetConditions,
          `Execution ${execution.id} was created for this launch and has been ${rolledBack ? "retired" : "left in place"}; no workflow ran.`,
        ],
        instruction: `${refusal.instruction} Nothing is running${rolledBack ? "" : `; abandon execution ${execution.id} with \`cctl spec abandon ${spec.slug} --execution ${execution.id}\` before retrying`}.`,
      },
    });
  }

  // Everything spec-side is committed; the workflow start is handed back to
  // the caller so it runs with the write queue released.
  return {
    kind: "launch",
    pending: {
      spec,
      execution,
      definition,
      revisionNumber: pinned.revision.number,
      attemptId: launch.attemptId,
      candidate: launch.candidate,
      sessionName: input.sessionName,
      projectName: input.projectName ?? "",
      // The authenticated conversation that ran `spec start`. It is threaded
      // to the persisted execution so validation resolves the launching
      // planner before any lane exists (lifecycle contract, design §10).
      ownerConversationId:
        input.actor.kind === "agent" ? input.actor.conversationId : null,
      seededDocuments: [buildPinnedSpecDocument(spec, pinned)],
    },
  };
}

/**
 * Retire a spec execution that was created for a launch which then refused,
 * before any workflow existed to run it. Nothing external needs reaping — the
 * graph-workflow execution is created only after this point — so the row is
 * finalized straight to `abandoned` with its reason and audit event in one
 * transaction rather than entering the cleanup coordinator, which exists for
 * runs that DID launch. Returns false when the retirement itself fails, so the
 * refusal can name the manual remedy instead of claiming a rollback happened.
 */
function rollBackUnlaunchedExecution(
  deps: ExecutionServiceDeps,
  spec: Spec,
  execution: SpecExecutionRow,
  actor: ActorProvenance,
  reason: string,
): boolean {
  const prepared: PreparedSpecEventPublication[] = [];
  try {
    deps.runInImmediateTransaction(() => {
      const row = deps.deliveryRepo.saveExecutionCleanupState({
        executionId: execution.id,
        state: "abandoned",
        cleanupPhase: null,
        linkedWorkflowExecutionId: null,
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
          { reason, rolledBackBeforeLaunch: true },
          actor,
        ),
      );
    });
  } catch (error) {
    logger.error("specs.execution.launch-rollback-failed", {
      specId: spec.id,
      specExecutionId: execution.id,
      error: getErrorMessage(error),
    });
    return false;
  }
  publishPrepared(deps, prepared);
  logger.info("specs.execution.launch-rolled-back", {
    specId: spec.id,
    specExecutionId: execution.id,
  });
  return true;
}

/**
 * The launch itself, outside the write queue. The workflow start reports back
 * through the registered lifecycle port, which links the spec execution and
 * marks it running through that same queue — doing this inside it deadlocks.
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
          "This composition has no workflow start seam wired, so the approved candidate cannot be launched.",
        ],
        instruction: `Execution ${pending.execution.id} exists but nothing is running. Launch the compiled definition with \`cctl workflow start ${pending.definition.id}\`, or abandon the run with \`cctl spec abandon ${pending.spec.slug} --execution ${pending.execution.id}\`.`,
      },
    };
  }
  const launched = await gate.launchApprovedDefinition({
    projectName: pending.projectName,
    sessionName: pending.sessionName,
    definitionId: pending.definition.id,
    definitionRevision: pending.definition.revision,
    ownerConversationId: pending.ownerConversationId,
    seededDocuments: pending.seededDocuments,
  });
  if (!launched.ok) {
    return {
      ok: false,
      refusal: {
        code: "workflow_unavailable",
        unmetConditions: [
          `The approved candidate did not start: ${launched.reason}`,
        ],
        instruction: `Execution ${pending.execution.id} exists but nothing is running. Retry with \`cctl workflow start ${pending.definition.id}\`, or abandon the run with \`cctl spec abandon ${pending.spec.slug} --execution ${pending.execution.id}\`.`,
      },
    };
  }

  logger.info("specs.execution.delivery-plan-launched", {
    specId: pending.spec.id,
    executionId: pending.execution.id,
    attemptId: pending.attemptId,
    workflowDefinitionId: pending.definition.id,
    workflowExecutionId: launched.workflowExecutionId,
    compiledDefinitionHash: pending.candidate.compiledDefinitionHash,
  });
  return {
    ok: true,
    execution:
      deps.deliveryRepo.findExecutionById(pending.execution.id) ??
      pending.execution,
    definition: pending.definition,
    revisionNumber: pending.revisionNumber,
    deliveryPlan: {
      attemptId: pending.attemptId,
      candidateId: pending.candidate.candidateId,
      planHash: pending.candidate.planHash,
      compiledDefinitionHash: pending.candidate.compiledDefinitionHash,
    },
  };
}

/**
 * A scope's canonical identity, order-insensitive so two scopes selecting the
 * same work hash alike. Retained for the read-only legacy preview and its
 * captured compatibility contracts; active launch has no scope-file hash.
 */
export function hashExecutionScope(scope: ExecutionScope): string {
  const canonical = {
    selectedTaskIds: [...scope.selectedTaskIds].sort(),
    selectedCriterionIds: [...scope.selectedCriterionIds].sort(),
    exclusionDispositions: [...scope.exclusionDispositions]
      .map((entry) => ({ ...entry }))
      .sort(
        (left, right) =>
          left.criterionId.localeCompare(right.criterionId) ||
          left.disposition.localeCompare(right.disposition),
      ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function workflowDraft(
  specName: string,
  revisionNumber: number,
  definition: WorkflowDefinitionRecord["definition"],
): WorkflowDefinitionDraft {
  const layout: GraphWorkflowVisualLayout = {
    workflowId: "compiled-spec-definition",
    contextPositions: Object.fromEntries(
      definition.executionContexts.map((context, index) => [
        context.id,
        { x: index * 360, y: 0 },
      ]),
    ),
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  return {
    name: `${specName} revision ${revisionNumber}`,
    description: `Compiled execution plan for ${specName} revision ${revisionNumber}.`,
    definition,
    layout,
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
  abandonExecutionId?: string,
): Promise<string> {
  const spec = await deps.specsRepo.findById(specId);
  const target = spec?.slug ?? specId;
  const abandon =
    abandonExecutionId === undefined
      ? ""
      : `Abandon execution ${abandonExecutionId} with \`cctl spec abandon ${target} --execution ${abandonExecutionId} --reason <reason>\`, then `;
  return `${abandon}open a seeded attempt with \`cctl spec plan open ${target} --seed-from last\`, propose and sign its candidate off, then launch it with \`cctl spec start ${target}\`.`;
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
    [`Execution ${execution.id} is ${execution.state}, not running.`],
    execution.state === "abandoned"
      ? "The execution is terminal; start a future execution only if the spec remains active."
      : "Start the linked workflow before recording successful delivery.",
  );
}
