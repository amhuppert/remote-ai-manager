import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createLogger } from "@/lib/logging";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type { SpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type {
  CreateDraftElementResult,
  SpecsRepo,
} from "@/lib/state-store/specs-repo";
import type { WriteQueue } from "@/lib/state-store/write-queue";
import type {
  GraphWorkflowVisualLayout,
  WorkflowDefinitionRecord,
} from "@/lib/workflow-graph/definition-schemas";
import type {
  WorkflowDefinitionDraft,
  WorkflowDefinitionSummary,
  WorkflowScope,
} from "@/lib/workflow-graph/storage";
import type { GraphExecutionLifecycleContext } from "@/lib/workflow-graph/execution-lifecycle-port";
import {
  compileSpecExecutionPlan,
  scopePlanFromRevision,
  specExecutionOriginSourceUri,
} from "./compiler";
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
  type Spec,
  type SpecCriterionDisposition,
  type SpecExecutionRow,
  type SpecRevision,
  type SpecWorkflowLaneStatus,
  type TaskElementPayload,
} from "./schemas";
import {
  executionScopeSchema,
  type ExecutionScope,
  type ScopePlan,
} from "./scope-validation";
import {
  openDraftAuthoringStage,
  startExecution as decideStartExecution,
  type TransitionRefusal,
} from "./transitions";

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
    kind: "execution" | "link" | "revision" | "element" | "admission",
  ): string;
  now(): string;
  ingestExecutionEvidence(executionId: string): Promise<unknown>;
  /**
   * Whether the named session resolves in this project. `start` records the
   * session durably on the execution and `workflow start` is session-scoped,
   * so an unvalidated name would dead-end one command later as a bare
   * "Session not found" with the unresolvable pin already persisted.
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
  afterDefinitionPrepared?(definition: WorkflowDefinitionRecord): Promise<void>;
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
  scope: ExecutionScope;
  actor: ActorProvenance;
  sessionName: string | null;
}

export type StartSpecExecutionResult =
  | {
      ok: true;
      execution: SpecExecutionRow;
      definition: WorkflowDefinitionRecord;
      /** The pinned revision's number, so the receipt needs no second read. */
      revisionNumber: number;
    }
  | { ok: false; refusal: TransitionRefusal };

export interface ApproveExecutionStartInput {
  specId: string;
  executionId: string;
  actor: ActorProvenance;
  approver: string;
  projectName: string;
}

export interface ExecutionService {
  start(input: StartSpecExecutionInput): Promise<StartSpecExecutionResult>;
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
  executionId: string;
  actor: ActorProvenance;
  discoveredTask: Omit<TaskElementPayload, "kind">;
  blockingReason?: string;
}

export interface CapturedScopeAmendment {
  revision: SpecRevision;
  task: Awaited<ReturnType<SpecsRepo["createDraftElement"]>>;
  restartRequired: boolean;
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
      return deps.writeQueue.withWriteQueue(
        `spec-execution-start[${input.specId}]`,
        async () => startWithinQueue(deps, cloneStartInput(input)),
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
          instruction:
            "Start a new execution from the approved revision instead.",
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
        execution.state === "delivered"
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
      "Start a new execution from the approved revision instead.",
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
      "Abandon this execution and start a new one from the approved revision before approving execution start.",
    );
  }

  let workflowExecutionId = await gate.hasPendingDefinitionApproval({
    projectName: input.projectName,
    sessionName: execution.session_name,
    definitionId: execution.workflow_definition_id,
    definitionRevision: execution.workflow_definition_revision,
  });
  if (workflowExecutionId === null) {
    const ensured = await gate.ensurePendingDefinitionApproval({
      projectName: input.projectName,
      sessionName: execution.session_name,
      definitionId: execution.workflow_definition_id,
      definitionRevision: execution.workflow_definition_revision,
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
  return deps.writeQueue.withWriteQueue(
    `spec-execution-abandon[${input.executionId}]`,
    async () => {
      const prepared: PreparedSpecEventPublication[] = [];
      const result = deps.runInImmediateTransaction<
        LifecycleResult<SpecExecutionRow>
      >(() => {
        const current = deps.deliveryRepo.findExecutionById(input.executionId);
        if (current === null) return lifecycleNotFound(input.executionId);
        if (current.state === "abandoned" || current.state === "delivered") {
          return lifecycleRefused(
            "gate_blocked",
            [`Execution ${input.executionId} is terminal (${current.state}).`],
            "Use the terminal execution history or start a future execution from an approved revision.",
          );
        }
        const updated = deps.deliveryRepo.updateExecutionLifecycle({
          executionId: input.executionId,
          state: "abandoned",
          deliveredAt: null,
          abandonedReason: reason,
          updatedAt: deps.now(),
        });
        prepared.push(
          appendExecutionEvent(
            deps,
            updated,
            "execution_abandoned",
            { reason },
            input.actor,
          ),
        );
        logger.info("specs.execution.abandoned", {
          specExecutionId: input.executionId,
          reasonLength: reason.length,
        });
        return { ok: true, value: updated };
      });
      publishPrepared(deps, prepared);
      if (result.ok) {
        deps.attentionNotifier?.specAttentionCleared({
          specId: result.value.spec_id,
          scope: "execution",
          reason,
          occurredAt: deps.now(),
        });
      }
      return result;
    },
  );
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

async function captureScopeAmendment(
  deps: ExecutionServiceDeps,
  input: CaptureScopeAmendmentInput,
): Promise<LifecycleResult<CapturedScopeAmendment>> {
  const blockingReason = input.blockingReason?.trim();
  if (input.blockingReason !== undefined && blockingReason?.length === 0) {
    return abandonReasonRefusal();
  }
  const execution = deps.deliveryRepo.findExecutionById(input.executionId);
  if (execution === null) return lifecycleNotFound(input.executionId);
  if (execution.state !== "running") {
    return lifecycleRefused(
      "gate_blocked",
      [
        "Discovered execution work can be captured only while the execution is running.",
      ],
      "Start the linked workflow or create a normal amendment outside execution.",
    );
  }
  const spec = await deps.specsRepo.findById(execution.spec_id);
  if (spec === null) return lifecycleNotFound(execution.spec_id);
  const baseRevision = await deps.specsRepo.findRevision(execution.revision_id);
  if (baseRevision === null) return lifecycleNotFound(execution.revision_id);
  const existingDraft = await deps.specsRepo.findDraftRevisionBySpecId(
    execution.spec_id,
  );
  if (
    existingDraft !== null &&
    existingDraft.basedOnRevisionId !== execution.revision_id
  ) {
    return lifecycleRefused(
      "amendment_required",
      ["The existing draft is based on a different approved revision."],
      "Resolve the existing draft before capturing discovered work from this execution.",
    );
  }
  // The draft the task lands in carries whatever its base carries, so the
  // discovered task is judged against that content before the draft, the task
  // and the event are committed together. Capturing first and validating after
  // would leave an empty amendment draft behind whenever the task is bad.
  const taskElementId = deps.nextId("element");
  const draftRevisionId = deps.nextId("revision");
  const captured = await deps.specsRepo.transaction(
    "specs.execution.capture-scope-amendment",
    (
      repo,
    ): LifecycleResult<{
      revision: SpecRevision;
      task: CreateDraftElementResult;
      prepared: PreparedSpecEventPublication;
    }> => {
      const staged = stageRevisionWrite(
        guardedElements(
          repo.getRevisionSnapshot(existingDraft?.id ?? execution.revision_id),
        ),
        [
          {
            op: "write",
            elementId: taskElementId,
            payload: { kind: "task", ...input.discoveredTask },
            parentElementId: null,
          },
        ],
      );
      const issues = validateStagedWrite(staged);
      if (issues.length > 0) {
        const refusal = danglingReferenceRefusal(issues);
        logger.warn("specs.execution.scope-amendment-refused", {
          specExecutionId: execution.id,
          refusalCode: refusal.code,
          referenceCount: issues.length,
        });
        return { ok: false, refusal };
      }

      const revision =
        existingDraft ??
        repo.createDraftFromBase({
          id: draftRevisionId,
          specId: execution.spec_id,
          baseRevisionId: execution.revision_id,
          authoringStage: openDraftAuthoringStage({
            policy: spec.gatePolicy,
            baseRevision: {
              state: "approved",
              authoringStage: baseRevision.authoringStage,
            },
          }),
          createdAt: deps.now(),
        });
      const task = repo.createDraftElement({
        id: taskElementId,
        specId: execution.spec_id,
        revisionId: revision.id,
        kind: "task",
        parentElementId: null,
        position: staged.finalSnapshot.length - 1,
        payload: { kind: "task", ...input.discoveredTask },
        createdAt: deps.now(),
        updatedAt: deps.now(),
      });
      return {
        ok: true,
        value: {
          revision,
          task,
          prepared: deps.events.appendInTransaction({
            actor: input.actor,
            durableEventType: "spec-revision-changed",
            durablePayload: {
              kind: "scope_amendment_captured",
              revisionId: revision.id,
              sourceExecutionId: execution.id,
              taskElementId: task.element.id,
              taskNumber: task.element.number,
            },
            sseEvent: {
              type: "spec-revision-changed",
              kind: "scope_amendment_captured",
              projectPath: spec.projectPath,
              specId: spec.id,
              specSlug: spec.slug,
              occurredAt: deps.now(),
              revisionId: revision.id,
              elementIds: [task.element.id],
            },
          }),
        },
      };
    },
  );
  if (!captured.ok) return captured;
  const { revision, task } = captured.value;
  deps.events.publishAfterCommit(captured.value.prepared);

  if (blockingReason !== undefined) {
    const abandoned = await abandonExecution(deps, {
      executionId: execution.id,
      reason: blockingReason,
      actor: input.actor,
    });
    if (!abandoned.ok) return abandoned;
  }
  logger.info("specs.execution.scope-amendment-captured", {
    specExecutionId: execution.id,
    revisionId: revision.id,
    taskElementId: task.element.id,
    restartRequired: blockingReason !== undefined,
  });
  return {
    ok: true,
    value: {
      revision,
      task,
      restartRequired: blockingReason !== undefined,
    },
  };
}

async function startWithinQueue(
  deps: ExecutionServiceDeps,
  input: StartSpecExecutionInput,
): Promise<StartSpecExecutionResult> {
  const spec = await deps.specsRepo.findById(input.specId);
  if (spec === null) {
    return refusedNotFound("The target spec does not exist.");
  }
  const snapshot = await deps.specsRepo.getRevisionSnapshot(input.revisionId);
  if (snapshot === null || snapshot.revision.specId !== spec.id) {
    return refusedNotFound("The target revision does not belong to the spec.");
  }
  if (
    input.sessionName !== null &&
    !(await deps.sessionExists(input.sessionName))
  ) {
    return {
      ok: false,
      refusal: {
        code: "not_found",
        unmetConditions: [
          `Session ${JSON.stringify(input.sessionName)} does not exist in this project.`,
        ],
        instruction:
          "Create or select a session first, then rerun spec start from it — the execution pins the session it will launch and merge through, and cctl binds the one CC_SESSION names.",
      },
    };
  }

  const plan = scopePlanFromRevision(spec.slug, snapshot);
  const preflight = decideStartExecution({
    policy: spec.gatePolicy,
    specAbandoned: spec.abandonedAt !== null,
    revisionId: input.revisionId,
    revisionState: snapshot.revision.state,
    authoringStage: snapshot.revision.authoringStage,
    scope: input.scope,
    plan,
    activeExecution:
      deps.deliveryRepo.findActiveExecutionBySpecId(spec.id) !== null,
  });
  if (!preflight.ok) {
    recordStartRefusal(deps, spec.id, input.actor, preflight.refusal);
    return preflight;
  }

  const scopeHash = hashExecutionScope(input.scope);
  const executionStartDial = specGateDialSchema.parse(
    resolveDial(spec.gatePolicy, "execution_start"),
  );
  const definitionValue = compileSpecExecutionPlan({
    spec: { id: spec.id, slug: spec.slug, name: spec.name },
    revisionSnapshot: snapshot,
    scope: input.scope,
    scopeHash,
    approvalRequired: executionStartDial === "gate",
  });
  const definitionDraft = workflowDraft(
    spec.name,
    snapshot.revision.number,
    definitionValue,
  );
  const originSourceUri = specExecutionOriginSourceUri(
    spec.id,
    snapshot.revision.id,
    scopeHash,
  );
  const orphan = await deps.workflowDefinitions.findByOrigin(originSourceUri);
  const definition =
    orphan === null
      ? await deps.workflowDefinitions.create(definitionDraft)
      : isDeepStrictEqual(orphan.definition, definitionValue)
        ? orphan
        : await deps.workflowDefinitions.update(orphan.id, definitionDraft);

  logger.info("specs.execution.definition-prepared", {
    specId: spec.id,
    revisionId: snapshot.revision.id,
    workflowDefinitionId: definition.id,
    workflowDefinitionRevision: definition.revision,
    executionStartDial,
    reused: orphan !== null,
  });
  await deps.afterDefinitionPrepared?.(definition);

  const prepared: PreparedSpecEventPublication[] = [];
  const startResult = deps.runInImmediateTransaction<StartSpecExecutionResult>(
    () => {
      const decision = decideStartExecution({
        policy: spec.gatePolicy,
        specAbandoned: spec.abandonedAt !== null,
        revisionId: input.revisionId,
        revisionState: snapshot.revision.state,
        authoringStage: snapshot.revision.authoringStage,
        scope: input.scope,
        plan,
        activeExecution:
          deps.deliveryRepo.findActiveExecutionBySpecId(spec.id) !== null,
      });
      if (!decision.ok) {
        recordStartRefusal(deps, spec.id, input.actor, decision.refusal);
        return decision;
      }

      const createdAt = deps.now();
      const execution: SpecExecutionRow = {
        id: deps.nextId("execution"),
        spec_id: spec.id,
        revision_id: snapshot.revision.id,
        scope_json: JSON.stringify(input.scope),
        state: "definition_review",
        execution_start_dial: executionStartDial,
        workflow_definition_id: definition.id,
        workflow_definition_revision: definition.revision,
        workflow_execution_id: null,
        session_name: input.sessionName,
        delivered_at: null,
        abandoned_reason: null,
        created_at: createdAt,
        updated_at: createdAt,
      };
      deps.deliveryRepo.insertExecution(execution);
      persistDispositions(
        deps.deliveryRepo,
        execution.id,
        input.scope,
        plan,
        createdAt,
      );
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
          revisionId: snapshot.revision.id,
          scopeHash,
          executionStartDial,
        }),
        element_ids_json: JSON.stringify([
          ...input.scope.selectedTaskIds,
          ...input.scope.selectedCriterionIds,
        ]),
        actor_json: JSON.stringify(input.actor),
        created_at: createdAt,
      });
      prepared.push(
        deps.events.appendInTransaction({
          actor: input.actor,
          durableEventType: "spec-execution-changed",
          durablePayload: {
            kind: "execution_started",
            executionId: execution.id,
            revisionId: snapshot.revision.id,
            workflowDefinitionId: definition.id,
            workflowDefinitionRevision: definition.revision,
            executionStartDial,
            scopeHash,
          },
          sseEvent: {
            type: "spec-execution-changed",
            kind: "execution_started",
            projectPath: spec.projectPath,
            specId: spec.id,
            specSlug: spec.slug,
            occurredAt: createdAt,
            revisionId: snapshot.revision.id,
            executionId: execution.id,
          },
        }),
      );

      logger.info("specs.execution.start-committed", {
        specId: spec.id,
        revisionId: snapshot.revision.id,
        executionId: execution.id,
        workflowDefinitionId: definition.id,
        workflowDefinitionRevision: definition.revision,
        executionStartDial,
        selectedTaskCount: input.scope.selectedTaskIds.length,
        selectedCriterionCount: input.scope.selectedCriterionIds.length,
      });
      return {
        ok: true,
        execution,
        definition,
        revisionNumber: snapshot.revision.number,
      };
    },
  );
  publishPrepared(deps, prepared);
  return startResult;
}

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

function persistDispositions(
  repo: SpecDeliveryRepo,
  executionId: string,
  scope: ExecutionScope,
  plan: ScopePlan,
  timestamp: string,
): void {
  const selectedCriteria = new Set(scope.selectedCriterionIds);
  const exclusions = new Map(
    scope.exclusionDispositions.map((entry) => [
      entry.criterionId,
      entry.disposition,
    ]),
  );
  for (const criterion of plan.criteria) {
    const disposition: SpecCriterionDisposition = selectedCriteria.has(
      criterion.id,
    )
      ? "in_scope"
      : requireExclusionDisposition(exclusions, criterion.id);
    repo.saveCriterionDisposition({
      execution_id: executionId,
      criterion_element_id: criterion.id,
      disposition,
      waiver_id: null,
      delivered_by_execution_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
}

function requireExclusionDisposition(
  exclusions: ReadonlyMap<
    string,
    Exclude<SpecCriterionDisposition, "in_scope">
  >,
  criterionId: string,
): Exclude<SpecCriterionDisposition, "in_scope"> {
  const disposition = exclusions.get(criterionId);
  if (disposition === undefined) {
    throw new Error(
      `Validated execution scope has no disposition for excluded criterion ${criterionId}.`,
    );
  }
  return disposition;
}

function cloneStartInput(
  input: StartSpecExecutionInput,
): StartSpecExecutionInput {
  return {
    ...input,
    scope: {
      selectedTaskIds: [...input.scope.selectedTaskIds],
      selectedCriterionIds: [...input.scope.selectedCriterionIds],
      exclusionDispositions: input.scope.exclusionDispositions.map((entry) => ({
        ...entry,
      })),
    },
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
