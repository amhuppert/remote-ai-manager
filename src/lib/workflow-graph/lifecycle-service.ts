import type {
  LifecycleAbandonResult,
  LifecycleDefinitionRejectionResult,
  LifecycleDefinitionApprovalResult,
} from "./lifecycle-outcomes";
import type { GraphExecutionContract } from "./execution-contract-port";
import {
  lifecycleResult,
  type LifecycleLaunchAcceptance,
} from "./lifecycle-outcomes";
import { listArchivedGraphWorkflowExecutions } from "@/lib/state-store";

import { createLogger } from "@/lib/logging";

import {
  awaitsDefinitionApproval,
  holdsExecutionLease,
} from "@/lib/workflow-graph/lifecycle-classifier";

import type {
  GraphWorkflowExecutionOrigin,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";

import type { SeededWorkflowDocument } from "@/lib/workflow-graph/shared-documents";

import type { GraphWorkflowArchiveOutcome } from "@/lib/state-store/setters";

import {
  WorkflowDefinitionApprovalRequiredError,
  interruptedDefinitionDecision,
  type AbandonExecutionInput,
  type AbandonExecutionResult,
  type RecordPendingHaltReasonInput,
  type RecordPendingHaltReasonResult,
  type RecordDefinitionApprovalInput,
  type RecordDefinitionApprovalResult,
  type ClaimDefinitionApprovalInput,
  type ClaimDefinitionApprovalResult,
  type ReleaseDefinitionApprovalClaimInput,
  type ReleaseDefinitionApprovalClaimResult,
  type RejectDefinitionResult,
  type DrainAndHaltInput,
  type GraphWorkflowLaunchOutcome,
  type GraphWorkflowResumeOptions,
} from "@/lib/workflow-graph/workflow-manager";

import type { WorkflowDefinitionDraft } from "./storage";

import {
  type DefinitionApprovalGateDecision,
  type GraphExecutionLifecycleContext,
} from "@/lib/workflow-graph/execution-lifecycle-port";

import { runWithLoopFence } from "./loop-fence";
import { toHaltReason } from "@/lib/workflow-graph/errors";

import { getErrorMessage } from "@/lib/shared/errors";

import { assertGraphExecutionContractAccepted } from "./execution-contract-port";

import {
  runWithExecutionPrincipalFence,
  type GraphWorkflowPrincipalFence,
} from "./principal-fence";

interface LifecycleAddress {
  projectPath: string;
  projectName: string;
  sessionName: string;
  fence?: GraphWorkflowPrincipalFence | null;
}

export interface GraphWorkflowLifecycleDeps {
  executionContract: GraphExecutionContract;
  /**
   * Wall clock for the one question this layer asks of time: whether a
   * definition decision has been reserved long enough that its holder is no
   * longer plausibly live. Defaults to the real clock.
   */
  now?(): string;

  startExecution(input: {
    projectPath: string;
    sessionName: string;
    definitionId: string;
    expectedDefinitionRevision?: number;
    tier?: "project" | "global";
    parameters?: Record<string, unknown>;
    ownerConversationId?: string | null;
    seededDocuments?: readonly SeededWorkflowDocument[];
  }): Promise<GraphWorkflowLaunchOutcome>;

  /**
   * The inline (`workflow run`) launch, riding the SAME manager gauntlet as
   * `startExecution` with a one-off source (D7 R1, R2). It receives the plan
   * already parsed by the accept-time gate, never the raw request body.
   */
  runExecution(input: {
    projectPath: string;
    sessionName: string;
    plan: WorkflowDefinitionDraft;
    inputs?: Record<string, unknown>;
    ownerConversationId?: string | null;
  }): Promise<GraphWorkflowLaunchOutcome>;

  /**
   * The native-SDD spec-delivery launch, riding the SAME manager gauntlet with
   * a `spec_delivery` source. It receives the signed candidate's launch
   * document (admitted at proposal, TOCTOU-rechecked by the gauntlet) plus the
   * spec bridge's atomic attachment. In-process only — no HTTP transport.
   */
  launchSpecDeliveryExecution(input: {
    projectPath: string;
    sessionName: string;
    definitionId: string;
    expectedDefinitionRevision: number;
    specSlug: string;
    candidateId: string;
    inputs?: Record<string, unknown>;
    ownerConversationId?: string | null;
    seededDocuments?: readonly SeededWorkflowDocument[];
    transactionAttachment?: (input: { executionId: string }) => void;
  }): Promise<GraphWorkflowLaunchOutcome>;

  markRunning?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin?: GraphWorkflowExecutionOrigin,
  ): Promise<void>;

  /**
   * Reports an execution that started but parked awaiting definition
   * approval, so the registered lifecycle consumer can open its own review
   * request for the pending definition. Defaults to the registered port.
   */
  awaitingDefinitionApproval?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin: GraphWorkflowExecutionOrigin,
  ): Promise<void>;

  /**
   * Consulted before a pending definition approval is recorded so the
   * registered lifecycle consumer can record its own execution-scoped
   * admission for work it prepared, or refuse with a machine-readable reason.
   * Consulted for every parked run whatever its origin. Defaults to the
   * registered port (admit when nobody claims it).
   *
   * A REFUSAL MUST BE WRITE-FREE. It is answered by handing the reservation
   * back, which reopens the park to a rejection or an abort, so a consumer that
   * has already committed anything durable may not report it as a refusal — it
   * throws instead, and the reservation is kept for a settlement that finishes
   * the saga forward. Idempotence is what makes that re-offer safe.
   */
  admitDefinitionApproval?(
    context: GraphExecutionLifecycleContext,
    workflowExecutionId: string,
    origin: GraphWorkflowExecutionOrigin,
  ): Promise<DefinitionApprovalGateDecision>;

  /**
   * Reports a successful abort so the registered lifecycle consumer can
   * terminalize work pinned to the run. Defaults to the registered port.
   */
  executionAborted?(workflowExecutionId: string): Promise<void>;

  pauseExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution>;

  resumeExecution(
    projectPath: string,
    sessionName: string,
    options?: GraphWorkflowResumeOptions,
  ): Promise<GraphWorkflowExecution>;

  abortExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution>;

  /**
   * Write the abandonment audit on the identified resumably halted lease
   * holder. Relocating the run into History stays with the route, which owns
   * the resource teardown that must precede it.
   */
  abandonExecution?(
    input: AbandonExecutionInput,
  ): Promise<AbandonExecutionResult>;

  resetExecutionContext(
    projectPath: string,
    sessionName: string,
    contextId: string,
  ): Promise<GraphWorkflowExecution>;

  resetExecutionContextAssignment(
    projectPath: string,
    sessionName: string,
    contextId: string,
    assignmentId: string,
  ): Promise<GraphWorkflowExecution>;

  /**
   * `audit` is present for an explicit, audited release act (abandon, the
   * definition rejection); absent for internal auto-release, which is not a
   * human act and has nothing to attribute.
   */
  archiveExecution(
    projectPath: string,
    sessionName: string,
    audit?: { reason: string; actor: string | null },
    /**
     * Re-applied inside the archive's own critical section against the row as
     * it is at that moment, so an eligibility or expected-id decision made out
     * here cannot be invalidated by a concurrent resume or slot turnover.
     * Must be pure.
     */
    guard?: (execution: GraphWorkflowExecution) => boolean,
  ): Promise<GraphWorkflowArchiveOutcome>;

  kickOffExecutionLoop(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
  }): Promise<void>;

  getActiveExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;

  recordPendingHaltReason(
    input: RecordPendingHaltReasonInput,
  ): Promise<RecordPendingHaltReasonResult>;

  drainAndHalt(input: DrainAndHaltInput): Promise<GraphWorkflowExecution>;

  /**
   * Approve the pending workflow definition on the session's active execution
   * (the definition-review gate for approval-required definitions). Defaults
   * to the workflow manager's atomic first-approval-wins recording.
   */
  recordDefinitionApproval?(
    input: RecordDefinitionApprovalInput,
  ): Promise<RecordDefinitionApprovalResult>;

  /**
   * Reserve the park's decision for this act without deciding it — the
   * approval saga's arbiter. Defaults to the manager's serialized claim act.
   */
  claimDefinitionApproval?(
    input: ClaimDefinitionApprovalInput,
  ): Promise<ClaimDefinitionApprovalResult>;

  /**
   * Hand an unadmitted reservation back so the park is decidable again.
   * Defaults to the manager's serialized release act.
   */
  releaseDefinitionApprovalClaim?(
    input: ReleaseDefinitionApprovalClaimInput,
  ): Promise<ReleaseDefinitionApprovalClaimResult>;

  /**
   * The human's other decision at the same gate: end the parked run instead of
   * admitting it. Defaults to the workflow manager's serialized reject act.
   */
  rejectDefinition?(input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
  }): Promise<RejectDefinitionResult>;

  /**
   * List the session's archived (terminal, moved-out) graph-workflow
   * executions. Defaults to the real archived-executions repo via the store.
   */
  listArchivedExecutions?(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution[]>;

  /**
   * Stop dev servers running in a terminal execution's lane worktrees before it
   * is cleared/archived. Backstop for the case where halt/abort/merge cleanup
   * did not stop them. Defaults to the real worktree-scoped cleanup.
   */
  stopExecutionLaneDevServers?(input: {
    execution: GraphWorkflowExecution;
    projectPath: string;
  }): Promise<void>;
}

const logger = createLogger("graph-workflow-lifecycle");

export function createGraphWorkflowLifecycleService(
  deps: GraphWorkflowLifecycleDeps,
) {
  const executionContract = deps.executionContract;

  async function markExecutionRunning(
    context: GraphExecutionLifecycleContext,
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    if (deps.markRunning === undefined) return;
    try {
      await deps.markRunning(context, execution.id, execution.origin);
    } catch (error) {
      logger.warn("graph-workflow.execution_mark_running_failed", {
        workflowExecutionId: execution.id,
        origin: execution.origin.kind,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Reports a start that parked awaiting definition approval through the
   * lifecycle port so the registered consumer can open its review request.
   * Reporting is best-effort: a consumer failure must not mask the
   * machine-readable `definition_approval_required` response.
   */
  async function reportAwaitingDefinitionApproval(
    context: GraphExecutionLifecycleContext,
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    if (deps.awaitingDefinitionApproval === undefined) return;
    try {
      await deps.awaitingDefinitionApproval(
        context,
        execution.id,
        execution.origin,
      );
    } catch (error) {
      logger.warn("graph-workflow.execution_awaiting_approval_report_failed", {
        workflowExecutionId: execution.id,
        origin: execution.origin.kind,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Auto-release (D7 decision D3): a settled run that no longer holds the
   * session's lease is archived the moment it settles rather than waiting for
   * an operator to clear it. The lease — not a status set — is the test, so a
   * non-resumable halt releases here exactly as R4 says it does, while a
   * resumable halt or a paused run is deliberately left holding: releasing one
   * would admit unrelated validation and race a resume.
   *
   * Best-effort by design: a failed archive must not turn a successful abort or
   * a finished run into an error, and admission normalizes whatever this
   * misses without any explicit clear act.
   */
  async function autoReleaseSettledExecution(
    projectPath: string,
    sessionName: string,
    audit?: { reason: string; actor: string | null },
  ): Promise<void> {
    try {
      const active = await deps.getActiveExecution(projectPath, sessionName);
      if (
        !active ||
        holdsExecutionLease(
          active.status,
          active.haltReason,
          active.abandonment,
        )
      ) {
        return;
      }
      // No operator act stops lane dev servers that survived earlier cleanup,
      // and completion is the one terminal transition the manager runs no
      // cleanup for — so the automatic release carries the backstop itself.
      await deps.stopExecutionLaneDevServers?.({
        execution: active,
        projectPath,
      });
      // An operator-initiated abort carries its reason here: `aborted`
      // auto-releases, so this IS the release that ends the run's ownership,
      // and the reason belongs on its durable audit row rather than nowhere.
      const outcome = await deps.archiveExecution(
        projectPath,
        sessionName,
        audit,
        (execution) =>
          execution.id === active.id &&
          !holdsExecutionLease(
            execution.status,
            execution.haltReason,
            execution.abandonment,
          ),
      );
      if (!outcome.archived) {
        logger.info("graph-workflow.execution.auto_release_skipped", {
          projectPath,
          sessionName,
          executionId: active.id,
          reason: outcome.reason,
        });
        return;
      }
      logger.info("graph-workflow.execution.archived", {
        projectPath,
        sessionName,
        executionId: active.id,
        status: active.status,
        reason: "auto_release",
      });
    } catch (error) {
      logger.warn("graph-workflow.execution.auto_release_failed", {
        projectPath,
        sessionName,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Kick off the execution loop and release the slot once it settles. Every
   * loop start goes through here so the completion transition auto-releases
   * identically no matter which surface launched or resumed the run.
   */
  async function kickOffAndAutoRelease(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
  }): Promise<void> {
    try {
      await deps.kickOffExecutionLoop(input);
    } finally {
      await autoReleaseSettledExecution(input.projectPath, input.sessionName);
    }
  }

  async function reportExecutionLoopFailure(input: {
    projectPath: string;
    sessionName: string;
    expectedExecutionId: string;
    expectedLoopEpoch: number;
    error: unknown;
    phase: "start" | "resume";
  }): Promise<void> {
    const reason = toHaltReason(input.error, { cause: "unknown" });
    let active: GraphWorkflowExecution | null = null;
    try {
      active = await deps.getActiveExecution(
        input.projectPath,
        input.sessionName,
      );
    } catch (lookupError) {
      logger.error("graph-workflow.execution_loop_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        phase: input.phase,
        haltReasonType: reason.type,
        lookupError:
          lookupError instanceof Error
            ? lookupError.message
            : String(lookupError),
      });
      return;
    }
    if (
      !active ||
      active.id !== input.expectedExecutionId ||
      active.loopEpoch !== input.expectedLoopEpoch ||
      active.status !== "running"
    ) {
      logger.error("graph-workflow.execution_loop_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        phase: input.phase,
        haltReasonType: reason.type,
        hasActiveExecution: active !== null,
        expectedExecutionId: input.expectedExecutionId,
        activeExecutionId: active?.id ?? null,
        expectedLoopEpoch: input.expectedLoopEpoch,
        activeLoopEpoch: active?.loopEpoch ?? null,
        executionStatus: active?.status ?? null,
        haltRecovery:
          active !== null && active.id !== input.expectedExecutionId
            ? "execution_mismatch"
            : "not_applicable",
      });
      return;
    }
    try {
      await runWithLoopFence(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          executionId: input.expectedExecutionId,
          loopEpoch: input.expectedLoopEpoch,
        },
        async () => {
          const recorded = await deps.recordPendingHaltReason({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            expectedExecutionId: input.expectedExecutionId,
            reason,
          });
          if (!recorded.accepted) {
            logger.error("graph-workflow.execution_loop_failed", {
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              phase: input.phase,
              haltReasonType: reason.type,
              hasActiveExecution: true,
              executionStatus: recorded.execution.status,
              haltRecovery: "rejected",
            });
            return;
          }
          await deps.drainAndHalt({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            expectedExecutionId: input.expectedExecutionId,
          });
          logger.error("graph-workflow.execution_loop_failed", {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            phase: input.phase,
            haltReasonType: reason.type,
            hasActiveExecution: true,
            haltRecovery: "completed",
          });
        },
      );
    } catch (haltError) {
      logger.error("graph-workflow.execution_loop_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        phase: input.phase,
        haltReasonType: reason.type,
        hasActiveExecution: true,
        haltError: getErrorMessage(haltError),
      });
    }
  }

  /**
   * Production start+kickoff seam shared by the HTTP START handler and the MCP
   * `start_graph_workflow` tool. Both surfaces must launch identically: run the
   * shared start path (guards + input validation + substitution + seed via
   * `startExecution`), then fire-and-forget kick off the execution loop exactly
   * as START does so the run actually executes. Guard/input/not-found errors
   * from the shared start path propagate to the caller (which maps them to its
   * surface's error shape); nothing is seeded on a rejection, so the loop is
   * never engaged for a rejected launch.
   */
  async function launchSavedRunning(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    definitionId: string;
    expectedDefinitionRevision?: number;
    tier?: "project" | "global";
    parameters?: Record<string, unknown>;
    /**
     * The launching conversation, resolved by the in-process caller (the spec
     * execution-start gate, the MCP start tool). `null` is an explicit "this
     * seam has no conversation identity" — a Studio-driven spec grant, for
     * instance — and leaves the run unowned.
     */
    ownerConversationId?: string | null;
    /**
     * Documents the launching tier rendered for this run. Threaded only
     * through this in-process seam, never through `startExecutionSchema`: an
     * HTTP body that could supply it would be an arbitrary write into the
     * session worktree's `.cc` namespace.
     */
    seededDocuments?: readonly SeededWorkflowDocument[];
  }): Promise<GraphWorkflowExecution> {
    return requireRunningLaunch(
      await launch({
        source: "saved",
        projectName: input.projectName,
        command: {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          definitionId: input.definitionId,
          ...(input.expectedDefinitionRevision !== undefined
            ? { expectedDefinitionRevision: input.expectedDefinitionRevision }
            : {}),
          ...(input.tier !== undefined ? { tier: input.tier } : {}),
          ...(input.parameters !== undefined
            ? { parameters: input.parameters }
            : {}),
          ...(input.ownerConversationId !== undefined &&
          input.ownerConversationId !== null
            ? { ownerConversationId: input.ownerConversationId }
            : {}),
          ...(input.seededDocuments !== undefined
            ? { seededDocuments: input.seededDocuments }
            : {}),
        },
      }),
    );
  }

  /**
   * The spec-delivery sibling of `launch`: same running-execution contract,
   * different source. Sign-off already served as the human definition approval
   * (the finalized candidate carries `approvalRequired: false`), so a park here
   * is a caller error surfaced as the same raised approval, not a state to
   * wait on.
   */
  async function launchSpecDelivery(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    definitionId: string;
    expectedDefinitionRevision: number;
    specSlug: string;
    candidateId: string;
    inputs?: Record<string, unknown>;
    ownerConversationId?: string | null;
    seededDocuments?: readonly SeededWorkflowDocument[];
    transactionAttachment?: (input: { executionId: string }) => void;
  }): Promise<GraphWorkflowExecution> {
    return requireRunningLaunch(
      await launch({
        source: "spec_prepared",
        projectName: input.projectName,
        command: {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          definitionId: input.definitionId,
          expectedDefinitionRevision: input.expectedDefinitionRevision,
          specSlug: input.specSlug,
          candidateId: input.candidateId,
          ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
          ...(input.ownerConversationId !== undefined &&
          input.ownerConversationId !== null
            ? { ownerConversationId: input.ownerConversationId }
            : {}),
          ...(input.seededDocuments !== undefined
            ? { seededDocuments: input.seededDocuments }
            : {}),
          ...(input.transactionAttachment !== undefined
            ? { transactionAttachment: input.transactionAttachment }
            : {}),
        },
      }),
    );
  }

  function executionAwaitsDefinitionApproval(
    execution: GraphWorkflowExecution | null,
  ): execution is GraphWorkflowExecution {
    return (
      execution !== null &&
      awaitsDefinitionApproval(execution.status, execution.definitionApproval)
    );
  }

  /**
   * The session's parked execution and the origin it recorded, or null when
   * nothing is parked. Callers outside this domain (the spec-side
   * execution-start act) use it to establish WHICH run holds the park before
   * deciding it: a session's lease says only that some run holds it, and
   * approving a run one does not mean starts the wrong workflow.
   */
  async function findPendingDefinitionApproval(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<{
    executionId: string;
    origin: GraphWorkflowExecutionOrigin;
  } | null> {
    const active = await deps.getActiveExecution(
      input.projectPath,
      input.sessionName,
    );
    return executionAwaitsDefinitionApproval(active)
      ? { executionId: active.id, origin: active.origin }
      : null;
  }

  /**
   * Undo this act's own reservation. Best-effort by construction: the caller
   * is already returning a refusal, and a release that cannot land means the
   * park turned over — restart normalization releases whatever is stranded.
   */
  async function releaseReservation(
    input: { projectPath: string; sessionName: string },
    executionId: string,
    claimId: string,
  ): Promise<void> {
    if (deps.releaseDefinitionApprovalClaim === undefined) return;
    const released = await deps.releaseDefinitionApprovalClaim({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      expectedExecutionId: executionId,
      claimId,
    });
    if (!released.ok) {
      logger.warn("graph-workflow.definition_approval.claim_release_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId,
        reason: released.reason,
      });
    }
  }

  /**
   * Non-HTTP definition-approval seam: records the approval on the session's
   * active execution and, on success, reports the started run through the
   * lifecycle port and engages the loop exactly like a gate-free START. The
   * HTTP handler and human-only server-side callers (e.g. the spec-side
   * execution-start grant) share this path so approval always starts the run
   * the same way. The registered lifecycle consumer records its own
   * execution-scoped admission for a definition it prepared, or refuses
   * machine-readably.
   *
   * A SAGA in three steps, because the act spans two authorities — this graph's
   * serialized row and the consumer's own durable records — and neither
   * two-write order is sound alone: approving before the gate leaves a refused
   * act with an irreversibly approved run whose only remedy would be a resume
   * that never consults the gate, while admitting before any reservation leaves
   * a losing act's admission behind (charter `reserve-before-side-effects`).
   * So: reserve (decides nothing, arbitrates everything), admit (the
   * reservation holder's alone), then finalize. Only write-free admission refusal releases the reservation. Once admission
   * may have committed, the claim remains available for forward settlement.
   */
  async function approveDefinition(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    expectedExecutionId?: string;
  }): Promise<LifecycleDefinitionApprovalResult> {
    if (
      deps.recordDefinitionApproval === undefined ||
      deps.claimDefinitionApproval === undefined
    ) {
      return { ok: false, reason: "unavailable" };
    }
    // An interrupted decision on THIS run is finished before a new one is
    // taken: its reservation stands until the saga it belongs to ends, so a
    // fresh act would only be refused behind it. Fenced to the named execution
    // so a stale act never settles — and so never starts — a successor.
    await settleInterruptedDefinitionDecision(input);
    const active = await deps.getActiveExecution(
      input.projectPath,
      input.sessionName,
    );
    if (
      executionAwaitsDefinitionApproval(active) &&
      input.expectedExecutionId !== undefined &&
      active.id !== input.expectedExecutionId
    ) {
      logger.warn("graph-workflow.definition_approval.guard_failed", {
        executionId: active.id,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: "execution_mismatch",
        expectedExecutionId: input.expectedExecutionId,
      });
      return { ok: false, reason: "execution_mismatch" };
    }
    // ONE act for both origins (D7 R14.2): the park is validated and offered
    // to the admission consumer by execution identity and recorded origin,
    // never by a stored-definition identity a one-off run does not have.
    // Whether a consumer claims this run — and how it correlates one it does —
    // is its own decision, downstream of the origin it receives.
    const parked = executionAwaitsDefinitionApproval(active);
    if (parked) {
      // Pure: a contract verdict on bytes already in hand writes nothing, so it
      // stays ahead of the reservation and refuses an invalid plan without ever
      // reserving anything.
      const contractDecision = executionContract.validateDefinition(
        active.workingDefinition,
      );
      if (!contractDecision.ok) {
        logger.warn(
          "graph-workflow.definition_approval.execution_contract_rejected",
          {
            executionId: active.id,
            origin: active.origin.kind,
            code: contractDecision.code,
            issueCount: contractDecision.issues.length,
          },
        );
      }
      assertGraphExecutionContractAccepted(contractDecision);
    }
    // COMMIT ONE — the reservation, and the act's arbiter. It decides nothing:
    // the run stays parked and unapproved, so a caller the gate goes on to
    // refuse has an act it can hand back whole, and a caller that loses this
    // race never reaches the gate to write anything at all.
    const reserved = await deps.claimDefinitionApproval({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      ...(input.expectedExecutionId === undefined
        ? {}
        : { expectedExecutionId: input.expectedExecutionId }),
    });
    if (!reserved.ok) return reserved;

    return completeReservedApproval(input, {
      executionId: reserved.execution.id,
      origin: reserved.execution.origin,
      claimId: reserved.claimId,
    });
  }

  /**
   * The second half of the approval saga, from a reservation this server holds.
   *
   * Split out because a reservation has exactly two ways to end and both run
   * this code: the act that took it finishes here, and an act INTERRUPTED
   * before it could finish is finished here too, from the reservation it left
   * on the row. Nothing else may end a reservation — see
   * {@link settleInterruptedDefinitionDecision}.
   *
   * THE ADMISSION comes first and is still ahead of any approval this graph has
   * recorded. A consumer that REFUSES is answered by releasing the reservation,
   * which restores the park byte for byte: nothing was approved, nothing was
   * materialized, nothing started, and the gate's "fix this, then approve
   * again" remedy is literally true. That release is why a refusal is the one
   * answer the consumer contract requires to be write-free.
   *
   * Every other unhappy end KEEPS the reservation, because past the refusal the
   * consumer's records may be durable: a thrown consumer failure carries no
   * promise about what committed before it (the production spec consumer grants
   * its approval, admission and event before the notification work that can
   * throw), and a finalize that refuses does so behind an admission that already
   * landed. Handing the reservation back there would reopen the park for a
   * rejection or abort while those records stand — written and lost, which
   * `reserve-before-side-effects` forbids. A kept reservation refuses every
   * decision act until {@link settleInterruptedDefinitionDecision} finishes the
   * saga forward, which is the only end that strands nothing.
   */
  async function completeReservedApproval(
    input: { projectPath: string; projectName: string; sessionName: string },
    reservation: {
      executionId: string;
      origin: GraphWorkflowExecutionOrigin;
      claimId: string;
    },
  ): Promise<
    | RecordDefinitionApprovalResult
    | { ok: false; reason: "unavailable" }
    | {
        ok: false;
        reason: "gate_refused";
        refusal: Exclude<DefinitionApprovalGateDecision, { ok: true }>;
      }
  > {
    if (deps.recordDefinitionApproval === undefined) {
      return { ok: false, reason: "unavailable" };
    }
    let result: RecordDefinitionApprovalResult;
    try {
      if (deps.admitDefinitionApproval !== undefined) {
        const admitted = await deps.admitDefinitionApproval(
          {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
          },
          reservation.executionId,
          reservation.origin,
        );
        if (!admitted.ok) {
          logger.warn("graph-workflow.definition_approval.gate_refused", {
            executionId: reservation.executionId,
            origin: reservation.origin.kind,
            code: admitted.code,
          });
          await releaseReservation(
            input,
            reservation.executionId,
            reservation.claimId,
          );
          return { ok: false, reason: "gate_refused", refusal: admitted };
        }
      }

      // COMMIT TWO — the approval itself, admitted and only now recorded. The
      // manager refuses a finalize that holds no reservation, so this cannot be
      // reached by a caller that skipped the gate.
      result = await deps.recordDefinitionApproval({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        expectedExecutionId: reservation.executionId,
        claimId: reservation.claimId,
      });
    } catch (error) {
      // Kept, not released: a failure carries no promise about what the
      // consumer committed before it, and freeing the park under a durable
      // admission is the one outcome this saga exists to prevent.
      logger.warn("graph-workflow.definition_approval.reservation_kept", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: reservation.executionId,
        origin: reservation.origin.kind,
        error: getErrorMessage(error),
      });
      throw error;
    }
    if (!result.ok) {
      // Only a run that left the park underneath an admitted act reaches here,
      // and no act can do that while a reservation stands — so this is the
      // narrow case of a park that turned over between the reservation and the
      // finalize. The admission behind it is already durable, so the
      // reservation is kept rather than handed back to whatever would end the
      // run next.
      logger.warn("graph-workflow.definition_approval.reservation_kept", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: reservation.executionId,
        origin: reservation.origin.kind,
        reason: result.reason,
      });
      return result;
    }

    await markExecutionRunning(
      { projectPath: input.projectPath, sessionName: input.sessionName },
      result.execution,
    );
    void Promise.resolve()
      .then(() =>
        kickOffAndAutoRelease({
          projectPath: input.projectPath,
          projectName: input.projectName,
          sessionName: input.sessionName,
          execution: result.execution,
        }),
      )
      .catch(async (error) => {
        await reportExecutionLoopFailure({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          expectedExecutionId: result.execution.id,
          expectedLoopEpoch: result.execution.loopEpoch,
          error,
          phase: "start",
        });
      });
    return result;
  }

  /**
   * Finish a decision whose holder went away, before acting on the park it
   * holds.
   *
   * A reservation is taken BEFORE the admission consumer is called, so a
   * reservation that outlives its holder may already have that consumer's
   * durable records behind it. Freeing it and then ending the run would strand
   * those records on a run this server killed — the interrupted act would have
   * written and lost, which `reserve-before-side-effects` forbids. So an
   * interrupted decision is FINISHED instead: the admission is re-offered
   * (consumers make it idempotent for exactly this) and the reservation is
   * either finalized into the approval it was taken for, or released because
   * the gate refused it. Either way nothing is left behind, and the park is
   * decidable again.
   *
   * Only a reservation aged past a plausible live holder qualifies; a live
   * holder finishes its own act, and every decision act refuses while it does.
   *
   * FENCED to the execution the caller named, because finishing a decision can
   * admit, approve and start the run it finishes. An act addressed to a run that
   * has already turned over would otherwise decide its successor and then refuse
   * — a refusal that changed another execution, which is exactly what
   * `reserve-before-side-effects` forbids. A session-addressed caller (abort)
   * names no execution and settles whatever holds the session, which is the run
   * it is acting on.
   */
  async function settleInterruptedDefinitionDecision(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    expectedExecutionId?: string;
  }): Promise<void> {
    if (
      deps.recordDefinitionApproval === undefined ||
      deps.releaseDefinitionApprovalClaim === undefined
    ) {
      return;
    }
    const active = await deps.getActiveExecution(
      input.projectPath,
      input.sessionName,
    );
    if (active === null) return;
    if (
      input.expectedExecutionId !== undefined &&
      active.id !== input.expectedExecutionId
    ) {
      return;
    }
    const interrupted = interruptedDefinitionDecision(
      active,
      deps.now?.() ?? new Date().toISOString(),
    );
    if (interrupted === null) return;
    logger.warn("graph-workflow.definition_approval.settling_interrupted", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      executionId: active.id,
      origin: active.origin.kind,
    });
    try {
      await completeReservedApproval(input, {
        executionId: active.id,
        origin: active.origin,
        claimId: interrupted.claimId,
      });
    } catch (error) {
      // A settlement that cannot finish leaves the reservation standing, which
      // is the safe end: every decision act refuses behind a live reservation,
      // so the caller is answered with a write-free conflict instead of a
      // failure that looks like it acted.
      logger.warn("graph-workflow.definition_approval.settlement_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: active.id,
        error: getErrorMessage(error),
      });
    }
  }
  async function withCommandFence<Value>(
    input: LifecycleAddress,
    run: () => Promise<Value>,
  ): Promise<Value> {
    return input.fence
      ? runWithExecutionPrincipalFence(input.fence, run)
      : run();
  }

  function startDetached(
    input: LifecycleAddress & { execution: GraphWorkflowExecution },
    phase: "start" | "resume",
  ): void {
    void Promise.resolve()
      .then(() =>
        kickOffAndAutoRelease({
          projectPath: input.projectPath,
          projectName: input.projectName,
          sessionName: input.sessionName,
          execution: input.execution,
        }),
      )
      .catch(async (error) => {
        logger.warn(
          phase === "start"
            ? "graph-workflow.execution_loop_start_failed"
            : "graph-workflow.execution_loop_resume_failed",
          {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            error: getErrorMessage(error),
          },
        );
        await reportExecutionLoopFailure({
          ...input,
          expectedExecutionId: input.execution.id,
          expectedLoopEpoch: input.execution.loopEpoch,
          error,
          phase,
        });
      });
  }

  async function pause(
    input: LifecycleAddress,
  ): Promise<GraphWorkflowExecution> {
    return withCommandFence(input, () =>
      deps.pauseExecution(input.projectPath, input.sessionName),
    );
  }

  async function resume(
    input: LifecycleAddress & { options?: GraphWorkflowResumeOptions },
  ): Promise<GraphWorkflowExecution> {
    const execution = await withCommandFence(input, async () => {
      return deps.resumeExecution(
        input.projectPath,
        input.sessionName,
        input.options,
      );
    });
    startDetached({ ...input, execution }, "resume");
    return execution;
  }

  async function abort(
    input: LifecycleAddress & {
      audit?: { reason: string; actor: string | null };
    },
  ): Promise<GraphWorkflowExecution> {
    const execution = await withCommandFence(input, async () => {
      await settleInterruptedDefinitionDecision(input);
      return deps.abortExecution(input.projectPath, input.sessionName);
    });
    try {
      await deps.executionAborted?.(execution.id);
    } catch (error) {
      logger.warn("graph-workflow.execution_abort_report_failed", {
        workflowExecutionId: execution.id,
        error: getErrorMessage(error),
      });
    }
    await autoReleaseSettledExecution(
      input.projectPath,
      input.sessionName,
      input.audit,
    );
    return execution;
  }

  async function reset(
    input: LifecycleAddress &
      (
        | { kind: "context"; contextId: string }
        | { kind: "assignment"; contextId: string; assignmentId: string }
      ),
  ): Promise<GraphWorkflowExecution> {
    return withCommandFence(input, () =>
      input.kind === "context"
        ? deps.resetExecutionContext(
            input.projectPath,
            input.sessionName,
            input.contextId,
          )
        : deps.resetExecutionContextAssignment(
            input.projectPath,
            input.sessionName,
            input.contextId,
            input.assignmentId,
          ),
    );
  }

  async function launch(
    input: LifecycleLaunchInput,
  ): Promise<GraphWorkflowLaunchOutcome> {
    let outcome: GraphWorkflowLaunchOutcome;
    switch (input.source) {
      case "saved":
        outcome = await deps.startExecution(input.command);
        break;
      case "inline":
        outcome = await deps.runExecution(input.command);
        break;
      case "spec_prepared":
        outcome = await deps.launchSpecDeliveryExecution(input.command);
        break;
    }
    const address = {
      projectPath: input.command.projectPath,
      sessionName: input.command.sessionName,
      projectName: input.projectName,
    };
    if (outcome.awaitingDefinitionApproval) {
      await reportAwaitingDefinitionApproval(
        { projectPath: address.projectPath, sessionName: address.sessionName },
        outcome.execution,
      );
      return outcome;
    }
    await markExecutionRunning(
      { projectPath: address.projectPath, sessionName: address.sessionName },
      outcome.execution,
    );
    startDetached({ ...address, execution: outcome.execution }, "start");
    return outcome;
  }

  function requireRunningLaunch(
    outcome: GraphWorkflowLaunchOutcome,
  ): GraphWorkflowExecution {
    if (outcome.awaitingDefinitionApproval) {
      throw new WorkflowDefinitionApprovalRequiredError(
        outcome.execution.id,
        outcome.execution.seedDefinitionId,
        outcome.execution.seedDefinitionRevision,
      );
    }
    return outcome.execution;
  }

  async function rejectDefinition(
    input: LifecycleAddress & { executionId: string },
  ): Promise<LifecycleDefinitionRejectionResult> {
    if (!deps.rejectDefinition) return { ok: false, reason: "unavailable" };

    // Same reason as the abort: a rejection may not discard a reservation whose
    // admission may already have landed, so an interrupted decision is finished
    // before this one is attempted. If that settlement admits and starts the
    // run, this rejection arrives too late and is refused as such. Fenced to the
    // rejected execution: a rejection naming a run that has turned over must not
    // start its successor on the way to refusing.
    await settleInterruptedDefinitionDecision({
      projectPath: input.projectPath,
      projectName: input.projectName,
      sessionName: input.sessionName,
      expectedExecutionId: input.executionId,
    });

    const outcome = await deps.rejectDefinition({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      executionId: input.executionId,
    });

    if (!outcome.ok) return outcome;

    // Rejection ends the run exactly as an abort does, so whatever a consumer
    // pinned to it terminalizes the same way — a linked delivery left
    // nonterminal is the one difference between the two ends that would matter.
    // Origin-aware by construction: the consumer decides whether this execution
    // is its business, which is where template-specific behavior belongs.
    // Best-effort like ABORT's report: a consumer failure must not mask a
    // rejection that has already committed.
    if (deps.executionAborted !== undefined) {
      try {
        await deps.executionAborted(outcome.execution.id);
      } catch (error) {
        logger.warn("graph-workflow.definition_rejection.report_failed", {
          workflowExecutionId: outcome.execution.id,
          error: getErrorMessage(error),
        });
      }
    }

    await deps.stopExecutionLaneDevServers?.({
      execution: outcome.execution,
      projectPath: input.projectPath,
    });

    const archiveOutcome = await deps.archiveExecution(
      input.projectPath,
      input.sessionName,
      { reason: "definition_rejected", actor: "human" },
      (current) =>
        current.id === outcome.execution.id && current.status === "aborted",
    );

    if (!archiveOutcome.archived) {
      logger.warn("graph-workflow.definition_rejection.archive_skipped", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: outcome.execution.id,
        reason: archiveOutcome.reason,
      });
    }
    return { ...outcome, archived: archiveOutcome.archived };
  }

  async function abandon(
    input: AbandonExecutionInput & {
      fence?: GraphWorkflowPrincipalFence | null;
    },
  ): Promise<LifecycleAbandonResult> {
    const abandonExecution = deps.abandonExecution;
    if (!abandonExecution) return { ok: false, reason: "unavailable" };
    const run = () =>
      abandonExecution({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: input.executionId,
        reason: input.reason,
        actor: input.actor,
      });
    const outcome = await (input.fence
      ? runWithExecutionPrincipalFence(input.fence, run)
      : run());
    if (!outcome.ok) return outcome;
    await deps.stopExecutionLaneDevServers?.({
      execution: outcome.execution,
      projectPath: input.projectPath,
    });
    return outcome;
  }

  async function abortDeliveryExecution(input: {
    projectPath: string;
    sessionName: string;
    workflowExecutionId: string;
  }): Promise<GraphWorkflowExecution | null> {
    const active = await deps.getActiveExecution(
      input.projectPath,
      input.sessionName,
    );
    if (active === null || active.id !== input.workflowExecutionId) return null;
    const aborted = await deps.abortExecution(
      input.projectPath,
      input.sessionName,
    );
    await deps.executionAborted?.(input.workflowExecutionId);
    return aborted;
  }

  async function locateExecution(input: {
    projectPath: string;
    sessionName: string;
    workflowExecutionId: string;
  }): Promise<GraphWorkflowExecutionPlacement> {
    const active = await deps.getActiveExecution(
      input.projectPath,
      input.sessionName,
    );
    if (active !== null && active.id === input.workflowExecutionId)
      return {
        kind: "active",
        status: active.status,
        leaseHeld: holdsExecutionLease(
          active.status,
          active.haltReason,
          active.abandonment,
        ),
      };
    const archived = (
      await (
        deps.listArchivedExecutions ?? listArchivedGraphWorkflowExecutions
      )(input.projectPath, input.sessionName)
    ).find((execution) => execution.id === input.workflowExecutionId);
    return archived === undefined
      ? { kind: "missing" }
      : { kind: "archived", status: archived.status };
  }

  return {
    launch: (input: LifecycleLaunchInput) =>
      lifecycleResult(async (): Promise<LifecycleLaunchAcceptance> => {
        const outcome = await launch(input);
        return {
          execution: outcome.execution,
          disposition: outcome.awaitingDefinitionApproval
            ? "awaiting_definition_approval"
            : "running",
          ...(outcome.warnings === undefined
            ? {}
            : { warnings: outcome.warnings }),
        };
      }),
    pause: (input: Parameters<typeof pause>[0]) =>
      lifecycleResult(() => pause(input)),
    resume: (input: Parameters<typeof resume>[0]) =>
      lifecycleResult(() => resume(input)),
    abort: (input: Parameters<typeof abort>[0]) =>
      lifecycleResult(() => abort(input)),
    reset: (input: Parameters<typeof reset>[0]) =>
      lifecycleResult(() => reset(input)),
    abandon,
    abortDeliveryExecution,
    locateExecution,
    rejectDefinition,
    launchSavedRunning,
    launchSpecDelivery,
    findPendingDefinitionApproval,
    approveDefinition,
  };
}

export type LifecycleLaunchInput = { projectName: string } & (
  | {
      source: "saved";
      command: Parameters<GraphWorkflowLifecycleDeps["startExecution"]>[0];
    }
  | {
      source: "inline";
      command: Parameters<GraphWorkflowLifecycleDeps["runExecution"]>[0];
    }
  | {
      source: "spec_prepared";
      command: Parameters<
        GraphWorkflowLifecycleDeps["launchSpecDeliveryExecution"]
      >[0];
    }
);

export type GraphWorkflowExecutionPlacement =
  | { kind: "missing" }
  | { kind: "archived"; status: GraphWorkflowExecution["status"] }
  | {
      kind: "active";
      status: GraphWorkflowExecution["status"];
      leaseHeld: boolean;
    };
