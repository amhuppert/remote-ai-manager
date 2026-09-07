import { requireRunningExecution } from "./execution-transitions";
import { accountContextAction } from "./context-accounting";
import { unchanged } from "@/lib/workflow-graph/execution-mutation";
import { mutationValue } from "@/lib/workflow-graph/execution-mutation";
import { changed, refused } from "@/lib/workflow-graph/execution-mutation";
import { transitionToNonRunningState } from "./execution-transitions";
import {
  WorkflowStartGuardError,
  leaseHeldStartGuardError,
  sessionFinalizingStartGuardError,
  type SessionFinalizingMerge,
} from "./start-guards";
import type { GraphWorkflowExecutionRepository } from "./execution-repository";
import { seededWorkflowDocumentsSchema } from "./seeded-documents";
import { randomUUID } from "node:crypto";
import { getErrorMessage } from "@/lib/shared/errors";

import {
  collectLandingProbeTargets,
  reconcileLandingIntents,
} from "@/lib/workflow-graph/route-runtime";
import {
  createLandingEvidenceProber,
  type LandingEvidenceProber,
} from "@/lib/workflow-graph/landing-evidence";

import {
  awaitsDefinitionApproval,
  evaluateLeaseAdmission,
  holdsExecutionLease,
} from "@/lib/workflow-graph/lifecycle-classifier";

import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createLogger } from "@/lib/logging";
import {
  createExecutionLogger,
  registerExecutionLogger,
  unregisterExecutionLogger,
  getExecutionLogger,
} from "@/lib/workflow-graph/execution-logger";
import {
  ResetExecutionContextError,
  resetExecutionContext,
} from "@/lib/workflow-graph/reset-context";
import {
  ResetAssignmentError,
  resetExecutionContextAssignment,
} from "@/lib/workflow-graph/reset-assignment";

import type { SeededWorkflowDocument } from "@/lib/workflow-graph/shared-documents";
import type { GraphWorkflowArchiveOutcome } from "@/lib/state-store/setters";
import { settleLoops } from "./loop-settlement";

import type { SessionState } from "@/lib/sessions/schemas";
import type { DirtyPath } from "@/lib/workflow-graph/errors";
import type { ConflictDecisionInput } from "@/lib/jobs/schemas";
import {
  buildLifecycleSnapshot,
  resetJoinForRetry,
  resetRunningJoinsToPending,
  transitionContextMergeStatus,
  transitionContextStatus,
} from "@/lib/workflow-graph/context-transitions";
import { readWorktreeDirtyPaths } from "@/lib/git/worktree";
import { defaultGitClient } from "@/lib/git/client";
import { getFinalizingSessionMergeJob } from "@/lib/jobs/queue";
import {
  validateLaunchInputs,
  WorkflowStartInputError,
  type LaunchInputError,
} from "@/lib/workflow-graph/start-input-service";

import type { TemplateTier } from "@/lib/workflow-graph/template-library-service";
import {
  computeUsedBackends,
  resolveWorkflowDefinition,
} from "@/lib/workflow-graph/resolve-config";
import { isWholeRunLiveSessionReadOnly } from "@/lib/workflow-graph/live-session-read-only";

import {
  createPreflightPrerequisiteService,
  type MissingPrerequisite,
  type PreflightPrerequisiteService,
} from "@/lib/workflow-graph/preflight-prerequisite-service";
import { readConfig } from "@/lib/config/loader";
import { parkedQuestionConversationIds } from "@/lib/workflow-graph/pending-user-input";
import {
  createUserInputGateService,
  type UserInputGateService,
} from "@/lib/workflow-graph/user-input-gate";
import { clearConversationQuestion } from "@/lib/workflows/conversation/manager";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { WorkflowPlanIssue } from "@/lib/workflows/plan-validation";
import { lintCommittedSourceLocators as defaultLintCommittedSourceLocators } from "@/lib/workflows/committed-source-locator-lint";
import { locatePlanIssues } from "@/lib/workflows/plan-issue-locator";
import type {
  GraphWorkflowAbandonment,
  GraphWorkflowDefinitionApprovalClaim,
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowLaunchDocument,
} from "@/lib/workflow-graph/schemas";
import type { AgentFailureClassification } from "@/lib/agent-backends/errors";
import type {
  GraphWorkflowStatus,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  assertGraphExecutionContractAccepted,
  type GraphExecutionContract,
} from "@/lib/workflow-graph/execution-contract-port";
import {
  describeLaunchSource,
  type GraphWorkflowLaunchSource,
} from "./execution-origin";
import type { WorkflowDefinitionDraft } from "./storage";
// The seed is a DATA contract, imported rather than restated: a local copy of
// its shape is how a launch field (an origin, a bound input) ends up recorded on
// one path and silently dropped on another.
import { type GraphWorkflowExecutionSeed } from "./execution-repository";
import {
  concludeValidationRound,
  isValidationRoundOpen,
  resetValidationRoundAttempts,
  validationRoundResumeDispositions,
} from "@/lib/workflow-graph/validation-round";
export interface GraphWorkflowStartInput {
  projectPath: string;
  sessionName: string;
  definitionId: string;
  expectedDefinitionRevision?: number;
  /**
   * Template tier to resolve the definition from. Omitted defaults to
   * `"project"`, preserving every current caller (the per-project load).
   */
  tier?: TemplateTier;
  /**
   * Raw supplied launch values (parameter name → unvalidated value). Validated
   * by `validateLaunchInputs` inside the shared start path; omitted/empty is a
   * behavior-neutral zero-input launch.
   */
  parameters?: Record<string, unknown>;
  /**
   * The launching conversation, already resolved SERVER-SIDE by the calling
   * start seam (HTTP start verifies the token-gated caller header against the
   * session's conversations; in-process seams pass an id they own). This path
   * never derives it from a request body, so a client-supplied claim cannot
   * reach the seed. Omitted/null is an unowned launch.
   */
  ownerConversationId?: string | null;
  /**
   * Documents the launching tier already rendered, seeded into the run before
   * its first iteration so every lane materializes them. In-process only: no
   * HTTP body reaches this field, because it authorizes a worktree write.
   * Omitted is a launch that seeds nothing.
   */
  seededDocuments?: readonly SeededWorkflowDocument[];
}

/** Everything an inline (`workflow run`) launch supplies (D7 R1). */
export interface GraphWorkflowRunInput {
  projectPath: string;
  sessionName: string;
  /**
   * The authored plan, ALREADY through the accept-time gate at the route
   * boundary (schema, structural, placement, reference, command-selector). The
   * manager never re-parses a raw body, and never persists this document as a
   * template.
   */
  plan: WorkflowDefinitionDraft;
  /**
   * Raw supplied launch values, from the inputs document — a channel distinct
   * from `plan`, so a plan file can never smuggle a binding and an inputs file
   * can never redefine the graph.
   */
  inputs?: Record<string, unknown>;
  /** As {@link GraphWorkflowStartInput.ownerConversationId}. */
  ownerConversationId?: string | null;
  /** As {@link GraphWorkflowStartInput.seededDocuments}. */
  seededDocuments?: readonly SeededWorkflowDocument[];
}

/**
 * A native SDD spec delivery riding the shared gauntlet. The plan is the
 * signed candidate's launch document, already admitted at proposal time and
 * re-checked by the gauntlet exactly as a template start is (the TOCTOU
 * recheck between sign-off and launch). Spec provenance travels as origin
 * fields only; the typed spec-execution link is the authoritative binding.
 */
export interface GraphWorkflowSpecDeliveryInput {
  projectPath: string;
  sessionName: string;
  definitionId: string;
  expectedDefinitionRevision: number;
  specSlug: string;
  candidateId: string;
  /** As {@link GraphWorkflowRunInput.inputs}. */
  inputs?: Record<string, unknown>;
  /** As {@link GraphWorkflowStartInput.ownerConversationId}. */
  ownerConversationId?: string | null;
  /** As {@link GraphWorkflowStartInput.seededDocuments}. */
  seededDocuments?: readonly SeededWorkflowDocument[];
  /** As {@link GraphWorkflowExecutionSeed.transactionAttachment}. */
  transactionAttachment?: (input: { executionId: string }) => void;
}

/**
 * How a launch names the definition content it will run — the ONE difference
 * between `workflow start` and `workflow run`. Explicitly discriminated rather
 * than inferred from which fields happen to be set, so every downstream branch
 * reads an origin the caller stated (D7 decision D2).
 */
export type WorkflowLaunchSourceRequest =
  | {
      kind: "template";
      definitionId: string;
      expectedRevision?: number;
      tier?: TemplateTier;
    }
  | { kind: "one_off"; plan: WorkflowDefinitionDraft }
  | {
      kind: "spec_delivery";
      definitionId: string;
      expectedRevision: number;
      specSlug: string;
      candidateId: string;
    };

/**
 * What a resolved launch source yields: provenance, the definition content the
 * gauntlet runs on, and the authored document the run is snapshotted from.
 */
export interface ResolvedLaunchSource {
  source: GraphWorkflowLaunchSource;
  definition: WorkflowSemanticDefinition;
  launchDocument: GraphWorkflowLaunchDocument;
}

/** The shared gauntlet's input: a source plus everything origin-blind. */
export interface GraphWorkflowLaunchInput {
  projectPath: string;
  sessionName: string;
  source: WorkflowLaunchSourceRequest;
  parameters?: Record<string, unknown>;
  ownerConversationId?: string | null;
  /** As {@link GraphWorkflowExecutionSeed.transactionAttachment}. */
  transactionAttachment?: (input: { executionId: string }) => void;
  seededDocuments?: readonly SeededWorkflowDocument[];
}

/**
 * What an ACCEPTED launch returns. Both dispositions are successes: a run that
 * began, and a run parked awaiting definition approval which is durable and
 * holds the session's lease (D7 R14). Carrying the park in the outcome rather
 * than raising it is what lets both transports answer 202 with a receipt
 * instead of decoding a refusal.
 */
export interface GraphWorkflowLaunchOutcome {
  execution: GraphWorkflowExecution;
  awaitingDefinitionApproval: boolean;
  warnings?: WorkflowPlanIssue[];
}

/**
 * The production reader behind the session-finalizing launch guard. Narrowed to
 * the two facts the refusal names, so the manager never holds a whole job.
 */
function defaultReadSessionFinalizingMerge(
  projectPath: string,
  sessionName: string,
): SessionFinalizingMerge | null {
  const job = getFinalizingSessionMergeJob(projectPath, sessionName);
  return job === null ? null : { jobId: job.jobId, branchName: job.branchName };
}

// The ONE start-input refusal class, owned by the pure start-input-service
// module so client-safe surfaces (the spec bridge) can share the identity
// without importing this server-side manager. Re-exported for the transports
// that already import it from here.
export { WorkflowStartInputError };

export class WorkflowDefinitionApprovalRequiredError extends Error {
  readonly code = "definition_approval_required" as const;
  readonly instruction: string;

  constructor(
    readonly executionId: string,
    readonly definitionId: string,
    readonly definitionRevision: number,
  ) {
    super(
      `Workflow execution ${executionId} was created and parked awaiting definition approval`,
    );
    this.name = "WorkflowDefinitionApprovalRequiredError";
    this.instruction = `Approve the pending workflow definition to resume execution ${executionId}.`;
  }
}

export type RecordDefinitionApprovalResult =
  | { ok: true; execution: GraphWorkflowExecution }
  | {
      ok: false;
      reason:
        | "no_active_execution"
        | "not_awaiting_approval"
        | "already_decided"
        | "execution_mismatch"
        // Finalization without a reservation the gate then admitted. The
        // reservation is the approval saga's arbiter, so a finalize that never
        // held one is a caller skipping the admission it exists to sequence.
        | "not_reserved"
        // The park is reserved by a different act. This caller's reservation
        // was reclaimed as stranded and replaced while it was away, so the
        // decision belongs to that holder now.
        | "claim_superseded";
    };

/**
 * Why reserving a definition decision was declined. The same questions
 * approval asks, plus the one the reservation itself answers: somebody else is
 * already deciding this park.
 */
export type ClaimDefinitionApprovalResult =
  | {
      ok: true;
      execution: GraphWorkflowExecution;
      /**
       * The reservation's identity, and the only credential its remaining moves
       * are accepted on. Held by the act, never re-read from the row: a caller
       * that reads back "whatever is reserved now" would act on a stranger's
       * reservation.
       */
      claimId: string;
    }
  | {
      ok: false;
      reason:
        | "no_active_execution"
        | "not_awaiting_approval"
        | "already_decided"
        | "execution_mismatch"
        | "decision_in_flight";
    };

export interface ClaimDefinitionApprovalInput {
  projectPath: string;
  sessionName: string;
  /** The parked run the caller read. Never "whatever holds the lease now". */
  expectedExecutionId?: string;
}

export interface ReleaseDefinitionApprovalClaimInput {
  projectPath: string;
  sessionName: string;
  /** The run whose reservation this caller holds. */
  expectedExecutionId: string;
  /** The reservation this caller made, as returned when it was granted. */
  claimId: string;
}

/**
 * Releasing is only ever a reservation holder undoing its own act, so its
 * refusals are diagnostics rather than decisions: whatever the reason, the
 * park is not left reserved by a caller that has gone away.
 * `claim_superseded` is the one that matters: the park is reserved, but by
 * somebody else, and freeing it would break that holder's saga rather than
 * this one's.
 */
export type ReleaseDefinitionApprovalClaimResult =
  | { ok: true; execution: GraphWorkflowExecution }
  | {
      ok: false;
      reason:
        | "no_active_execution"
        | "execution_mismatch"
        | "not_reserved"
        | "claim_superseded";
    };

/**
 * Why a definition rejection was declined. The same three questions approval
 * asks, minus `already_decided`: a decided park is no longer awaiting one
 * (D7 decision D17). `decision_in_flight` is the reservation's: a rejection
 * landing under an in-flight approval would strand that act's admission.
 */
export type RejectDefinitionResult =
  | { ok: true; execution: GraphWorkflowExecution }
  | { ok: false; reason: "no_active_execution" }
  | { ok: false; reason: "execution_mismatch"; activeExecutionId: string }
  | { ok: false; reason: "not_awaiting_approval"; status: GraphWorkflowStatus }
  | { ok: false; reason: "decision_in_flight" };

export interface RejectDefinitionInput {
  projectPath: string;
  sessionName: string;
  /** The parked run the human reviewed. Never "whatever holds the lease now". */
  executionId: string;
}

/**
 * Why an abandon was declined. `not_lease_holding_halt` is deliberately one
 * reason rather than three: a running run, a non-resumable halt, and a run
 * already abandoned all fail the SAME question — does this record still hold
 * the lease as a halt — and splitting it would invite a caller to re-derive
 * tenure from the status it carries.
 */
export type AbandonExecutionResult =
  | { ok: true; execution: GraphWorkflowExecution }
  | { ok: false; reason: "no_active_execution" }
  | { ok: false; reason: "execution_mismatch"; activeExecutionId: string }
  | {
      ok: false;
      reason: "not_lease_holding_halt";
      status: GraphWorkflowStatus;
      abandoned: boolean;
    };

export interface AbandonExecutionInput {
  projectPath: string;
  sessionName: string;
  /** The run the caller means. Never "whatever holds the lease right now". */
  executionId: string;
  reason: string;
  actor: GraphWorkflowAbandonment["actor"];
}

/** How the released audit row names who abandoned the run. */
export function abandonmentActorAuditLabel(
  actor: GraphWorkflowAbandonment["actor"],
): string {
  return actor.kind === "human"
    ? "human"
    : `conversation:${actor.conversationId}`;
}

/**
 * Read a refused abandon back out of the archive outcome.
 *
 * The archive's guard cannot carry a reason out of the transaction, but it
 * hands back the row it actually saw — so the refusal is classified from that
 * row rather than from a second read that could see a different one.
 */
function declineAbandon(
  requestedExecutionId: string,
  outcome: Extract<GraphWorkflowArchiveOutcome, { archived: false }>,
): Exclude<AbandonExecutionResult, { ok: true }> {
  if (outcome.reason === "no_active") {
    return { ok: false, reason: "no_active_execution" };
  }
  return outcome.execution.id === requestedExecutionId
    ? {
        ok: false,
        reason: "not_lease_holding_halt",
        status: outcome.execution.status,
        abandoned: outcome.execution.abandonment !== null,
      }
    : {
        ok: false,
        reason: "execution_mismatch",
        activeExecutionId: outcome.execution.id,
      };
}

export interface RecordDefinitionApprovalInput {
  projectPath: string;
  sessionName: string;
  /**
   * The run the caller means. The only identity the act carries: a one-off
   * launch has no saved-definition id to co-guard with, and a template park's
   * definition identity is already pinned by the immutable snapshot the
   * execution holds (D7 decision D17).
   */
  expectedExecutionId?: string;
  /**
   * The reservation this act made and the admission consumer accepted.
   * Required, because finalizing is the second half of one saga: a caller that
   * cannot name a reservation it still holds is a caller starting a run the
   * consumer was never asked about.
   */
  claimId: string;
}

/**
 * Raised by the shared start path when the requested template does not exist in
 * the indicated tier (R3.4). Carries the `definitionId` + `tier` so a surface
 * can identify the missing template distinctly from every other rejection class.
 * The definition identity and tier distinguish a missing source independently
 * of the display message.
 */
export class WorkflowDefinitionNotFoundError extends Error {
  readonly definitionId: string;
  readonly tier: TemplateTier;

  constructor(definitionId: string, tier: TemplateTier) {
    super(`Workflow definition "${definitionId}" was not found`);
    this.name = "WorkflowDefinitionNotFoundError";
    this.definitionId = definitionId;
    this.tier = tier;
  }
}

export class WorkflowDefinitionRevisionMismatchError extends Error {
  readonly code = "definition_revision_mismatch" as const;

  constructor(
    readonly definitionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Workflow definition "${definitionId}" changed from revision ${expectedRevision} to revision ${actualRevision}`,
    );
    this.name = "WorkflowDefinitionRevisionMismatchError";
  }
}

/**
 * Raised by the shared start path when the deterministic prerequisite gate
 * rejects the launch (a declared path/skill prerequisite is unmet on the target
 * worktree, or its probe errored — fail-closed, R5.10). Carries the itemized
 * `missing` so the thin HTTP/MCP surface can reconstruct the structured
 * `prerequisites_unmet` response (each item's kind, scoped backend for a skill,
 * and `reason` of `absent`|`probe_error`) without re-deriving it from a message
 * string. Distinct from `WorkflowStartGuardError` (active-execution /
 * uncommitted-changes), `WorkflowStartInputError` (missing/invalid input), and
 * the not-found error so the rejection class is unambiguous (R6.2).
 */
export class WorkflowPrerequisitesUnmetError extends Error {
  readonly missing: MissingPrerequisite[];

  constructor(missing: MissingPrerequisite[], message: string) {
    super(message);
    this.name = "WorkflowPrerequisitesUnmetError";
    this.missing = missing;
  }
}

export interface GraphWorkflowRetryableIterationErrorInput {
  contextId: string;
  errorMessage: string;
}

export interface GraphWorkflowResumeOptions {
  /** Per-file operator guidance attached to every failed join reset by this
   *  resume; consumed by the next conflict-resolution attempt. */
  conflictGuidance?: ConflictDecisionInput[];
  /**
   * Resume only if this execution still holds the session's lease. Resume is
   * session-addressed, so a caller that decided to resume from a snapshot it
   * read earlier — plan repair, across an abandon-plus-relaunch — would
   * otherwise resume whichever successor took the slot. Checked inside the
   * serialized reducer, which is the only place the answer cannot go stale.
   */
  expectedExecutionId?: string;
  /**
   * Who is resuming. A resume reschedules every concluded-failed join, which is
   * a retry decision — and some halts are only worth retrying because a human
   * looked at the infrastructure first. Defaults to `"operator"`: a caller that
   * resumes without a human in the loop (plan repair, any future supervisor)
   * declares `"system"` and is refused when the halt names a failure nothing
   * but restored capacity can change.
   */
  initiator?: "operator" | "system";
}

export type GraphWorkflowLifecycleAction =
  | "pause"
  | "resume"
  | "abort"
  | "complete"
  | "halt";

export class GraphWorkflowTransitionConflictError extends Error {
  readonly code = "workflow_transition_conflict" as const;

  constructor(
    readonly action: GraphWorkflowLifecycleAction,
    readonly currentStatus: GraphWorkflowStatus,
    readonly allowedStatuses: readonly GraphWorkflowStatus[],
    message: string,
  ) {
    super(message);
    this.name = "GraphWorkflowTransitionConflictError";
  }
}

function assertLifecycleTransitionAllowed(
  execution: GraphWorkflowExecution,
  action: GraphWorkflowLifecycleAction,
  allowedStatuses: readonly GraphWorkflowStatus[],
  message: string,
): void {
  if (allowedStatuses.includes(execution.status)) return;
  throw new GraphWorkflowTransitionConflictError(
    action,
    execution.status,
    allowedStatuses,
    message,
  );
}

/**
 * The classification of the first halt that says a join's conflict resolver
 * failed on infrastructure nothing but a human can restore, or null when no
 * halt says that.
 *
 * Keyed on `retryable`, not on the failure kind: a schema-validation or
 * timeout failure is worth another attempt, an exhausted quota is not.
 */
function nonRetryableResolutionHalt(
  haltReasons: readonly (GraphWorkflowHaltReason | null | undefined)[],
): AgentFailureClassification | null {
  for (const reason of haltReasons) {
    if (reason?.type !== "join_failure") continue;
    const failure = reason.resolutionFailure;
    if (failure !== undefined && !failure.retryable) return failure;
  }
  return null;
}

export type GraphWorkflowManagerEvent =
  | { type: "pause" }
  | { type: "abort" }
  | { type: "complete" }
  | { type: "halt"; reason: GraphWorkflowHaltReason };

export interface GraphWorkflowManagerDeps {
  executionRepository: GraphWorkflowExecutionRepository;
  loadDefinition(
    projectPath: string,
    definitionId: string,
    tier: TemplateTier,
  ): Promise<WorkflowDefinitionRecord | null>;
  executionContract: GraphExecutionContract;
  now?(): string;
  createExecutionId?(): string;
  eventPublisher?: ReturnType<
    typeof createGraphWorkflowExecutionEventPublisher
  >;
  /** Check if an execution loop is currently running for this session. When true, normalizeAfterRestart skips normalization. */
  isExecutionLoopActive?(projectPath: string, sessionName: string): boolean;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  /**
   * Read the uncommitted (tracked + untracked, non-ignored) changes in a
   * session worktree. The shared start path uses it for the dirty-worktree
   * guard. Defaults to the real `git status --porcelain` reader.
   */
  readSessionWorktreeDirtyPaths?(worktreePath: string): Promise<DirtyPath[]>;
  assertSessionBranchReady?(
    worktreePath: string,
    branchName: string,
  ): Promise<void>;
  /**
   * The session's in-flight merge that will also finalize the session, or null.
   * Backs the launch guard that mirrors the delivery gate (R13). Defaults to the
   * real background-job registry reader.
   *
   * Consulted TWICE per launch — advisorily up front, then again inside the
   * reserving transaction — so it must be synchronous and cheap: the second
   * call runs on the write queue.
   */
  readSessionFinalizingMerge?(
    projectPath: string,
    sessionName: string,
  ): SessionFinalizingMerge | null;
  /**
   * Deterministic pre-flight prerequisite gate. The shared start path invokes
   * it after the dirty-worktree guard + tier resolve and before start-input
   * validation/substitution, so a missing prerequisite halts the launch with a
   * distinct diagnostic and seeds nothing. Defaults to the real report-only
   * service over the production probes.
   */
  preflightService?: PreflightPrerequisiteService;
  /**
   * Read the global config, used to resolve the workflow's used-backend set
   * (per-context implementer + enabled context-validator backends) for the
   * prerequisite gate. Defaults to the real config loader.
   */
  readGlobalConfig?(): Promise<GlobalConfig>;
  lintCommittedSourceLocators?(
    definition: Pick<WorkflowSemanticDefinition, "charter">,
    session: Pick<SessionState, "sessionName" | "branchName" | "worktreePath">,
  ): Promise<WorkflowPlanIssue[]>;
  /**
   * Signal the in-flight Claude Code SDK query for a running task's
   * conversation to abort. Invoked once per unique conversationId across
   * running tasks on pause/abort/halt so the orchestrator does not leave
   * an orphan query running concurrently with the next iteration after
   * resume.
   */
  abortConversation(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): void;
  abortExecutionLoop(projectPath: string, sessionName: string): void;
  /**
   * Stop dev servers running in an execution's lane worktrees. Invoked on
   * abort/halt/drain/reset so a workflow that ends (or has a context reset)
   * never leaves orphaned lane dev servers.
   */
  stopExecutionLaneDevServers(input: {
    execution: GraphWorkflowExecution;
    projectPath: string;
    contextIds?: string[];
  }): Promise<void>;
  /**
   * User-input gate. Pause uses it to end the in-flight validation round and
   * withdraw exactly the validator questions that round parked (pause-to-edit,
   * R9). Defaults to a service over this manager's repository.
   */
  userInputGateService?: UserInputGateService;
  /**
   * Stop a lane conversation's actor (and with it the backend subprocess) when
   * a per-assignment reset retires it. Best-effort: a throw is logged, never a
   * reset failure — the durable state is already committed.
   */
  retireLaneConversation(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): void;
  /**
   * Read the replayable landing evidence off a context's branch (D4 decision
   * D8) so restart reconciliation settles commit-mode intents from what the
   * committer actually left behind. Defaults to the real git-backed prober.
   */
  landingEvidenceProber?: LandingEvidenceProber;
}

export interface RecordPendingHaltReasonInput {
  projectPath: string;
  sessionName: string;
  expectedExecutionId?: string;
  reason: GraphWorkflowHaltReason;
  /**
   * Additional mutation applied to the execution within the same
   * mutateActive transaction that records the pending halt reason.
   *
   * Runs unconditionally — even when first-failure-wins rejects the new
   * `reason` — so callers can persist auxiliary state (e.g., a context's
   * merge failure status) atomically with the pending halt write. This is
   * what makes drain-then-halt restart-safe: a crash between the auxiliary
   * write and the halt write would otherwise leave a failed fan-in without
   * the persisted halt reason needed to resume cleanly.
   */
  applyAdditionalMutation?(execution: GraphWorkflowExecution): void;
}

export interface RecordPendingHaltReasonResult {
  execution: GraphWorkflowExecution;
  accepted: boolean;
}

export interface DrainAndHaltInput {
  projectPath: string;
  sessionName: string;
  expectedExecutionId?: string;
}

const logger = createLogger("graph-workflow-manager");

/**
 * How long a definition-approval reservation may sit before a sweep may
 * conclude its holder is gone.
 *
 * Sized against what it must NOT interrupt: the admission call a live holder is
 * inside lasts milliseconds (a local transaction plus a notification), while
 * the only thing that legitimately strands a reservation is a process that died
 * holding it. Two minutes is far past the former and irrelevant to the latter,
 * which is why an approximate age is the right instrument here.
 */
const DEFINITION_APPROVAL_CLAIM_STRANDED_MS = 2 * 60 * 1000;

/**
 * Whether a reservation has aged past the point where a live holder is a
 * plausible explanation. An unparseable timestamp reads as stranded: a
 * reservation nobody can date is one nobody can be waiting behind.
 */
function isDefinitionApprovalClaimStranded(
  claim: GraphWorkflowDefinitionApprovalClaim,
  now: string,
): boolean {
  const claimedAt = Date.parse(claim.claimedAt);
  const at = Date.parse(now);
  if (Number.isNaN(claimedAt)) return true;
  if (Number.isNaN(at)) return false;
  return at - claimedAt >= DEFINITION_APPROVAL_CLAIM_STRANDED_MS;
}

/**
 * The reservation of a decision whose holder is no longer plausibly live, or
 * `null` when the park has no such debt.
 *
 * The answer is only ever "which act was interrupted", never "you may take this
 * reservation away". Nothing frees a reservation but its holder, because a
 * reservation is taken BEFORE the admission consumer is called and may
 * therefore already have that consumer's durable records behind it. An
 * interrupted decision is FINISHED by whoever holds the admission seam — this
 * is how they find one.
 */
export function interruptedDefinitionDecision(
  execution: GraphWorkflowExecution,
  now: string,
): { claimId: string } | null {
  const claim = execution.definitionApprovalClaim;
  if (claim === null) return null;
  if (!awaitsDefinitionApproval(execution.status, execution.definitionApproval))
    return null;
  if (!isDefinitionApprovalClaimStranded(claim, now)) return null;
  return { claimId: claim.claimId };
}

function describeLaunchInputError(error: LaunchInputError): string {
  switch (error.kind) {
    case "missing_required":
      return `Required parameter "${error.name}" was not supplied`;
    case "invalid_value":
      return `Parameter "${error.name}" is invalid: ${error.message}`;
    case "unknown_parameter":
      return `Unknown parameter "${error.name}" is not declared by this workflow`;
  }
}

function cloneExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return structuredClone(execution);
}

function getNow(deps: GraphWorkflowManagerDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function getExecutionId(deps: GraphWorkflowManagerDeps): string {
  return deps.createExecutionId?.() ?? randomUUID();
}

let defaultLandingEvidenceProber: LandingEvidenceProber | null = null;

/** Built once and only when a restart actually finds an unsettled landing. */
function resolveLandingEvidenceProber(
  deps: GraphWorkflowManagerDeps,
): LandingEvidenceProber {
  if (deps.landingEvidenceProber) return deps.landingEvidenceProber;
  defaultLandingEvidenceProber ??= createLandingEvidenceProber();
  return defaultLandingEvidenceProber;
}

/**
 * Running task conversations, minus any parked on a user question. A parked
 * conversation's machine sits in waitingForInput, which accepts ABORT_TURN and
 * would persist a cleared question while the execution keeps the parked record:
 * subsequent answers would be rejected and the context could never be
 * re-dispatched. A parked conversation has no in-flight turn, so excluding it
 * from cancellation costs nothing.
 */
function collectRunningTaskConversationIds(
  execution: GraphWorkflowExecution,
): string[] {
  const parked = parkedQuestionConversationIds(execution);
  const ids = new Set<string>();
  for (const taskState of Object.values(execution.taskStates)) {
    if (
      taskState.status === "running" &&
      taskState.lastConversationId &&
      !parked.has(taskState.lastConversationId)
    ) {
      ids.add(taskState.lastConversationId);
    }
  }
  return [...ids];
}

/**
 * CC conversation ids of every lane (implementer + validator) tracked on the
 * execution, except conversations parked on a user question. Validator runs
 * live here, NOT in taskStates — collecting only running-task conversations
 * lets a long validator run burn to completion after an abort. Aborting an
 * idle (non-parked) lane conversation is a harmless no-op (abort-registry
 * miss; the actor ignores ABORT_TURN when idle).
 */
function collectLaneConversationIds(
  execution: GraphWorkflowExecution,
): string[] {
  const parked = parkedQuestionConversationIds(execution);
  const ids = new Set<string>();
  for (const lanes of Object.values(execution.laneStates)) {
    for (const laneState of Object.values(lanes)) {
      if (laneState.workflowConversationId) {
        ids.add(laneState.workflowConversationId);
      }
    }
  }
  return [...ids].filter((id) => !parked.has(id));
}

/** Every conversation an active-cancellation transition should abort. */
function collectCancellableConversationIds(
  execution: GraphWorkflowExecution,
): string[] {
  return [
    ...new Set([
      ...collectRunningTaskConversationIds(execution),
      ...collectLaneConversationIds(execution),
    ]),
  ];
}

export function createGraphWorkflowManager(deps: GraphWorkflowManagerDeps) {
  const stopLaneDevServers = deps.stopExecutionLaneDevServers;
  const executionContract = deps.executionContract;
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();
  const userInputGateService =
    deps.userInputGateService ??
    createUserInputGateService({
      getActive: deps.executionRepository.getActive,
      mutateActive: deps.executionRepository.mutateActive,
      publishUserInputPending: eventPublisher.publishUserInputPending,
      publishUserInputResolved: eventPublisher.publishUserInputResolved,
      deliver: eventPublisher.deliver,
      clearConversationQuestion,
      now: () => getNow(deps),
    });

  function abortRunningTaskConversations(
    projectPath: string,
    sessionName: string,
    conversationIds: readonly string[],
  ): void {
    if (conversationIds.length === 0) {
      return;
    }
    for (const conversationId of conversationIds) {
      try {
        deps.abortConversation({
          projectPath,
          sessionName,
          conversationId,
        });
      } catch (err) {
        logger.warn("graph-workflow.abort_conversation.failed", {
          projectPath,
          sessionName,
          conversationId,
          error: getErrorMessage(err),
        });
      }
    }
  }

  async function readStartSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null> {
    return deps.getSession(projectPath, sessionName);
  }

  async function readSessionDirtyPaths(
    projectPath: string,
    sessionName: string,
  ): Promise<DirtyPath[]> {
    const session = await deps.getSession(projectPath, sessionName);
    if (!session) {
      return [];
    }
    const readDirty =
      deps.readSessionWorktreeDirtyPaths ?? readWorktreeDirtyPaths;
    try {
      return (await readDirty(session.worktreePath)) ?? [];
    } catch (error) {
      // Don't wedge a legitimate start if the status probe itself fails; the
      // dirty gate is a guard, not a hard precondition we can always evaluate.
      logger.warn("graph-workflow.start.dirty_check_failed", {
        projectPath,
        sessionName,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  function recordExecutionStarted(
    execution: GraphWorkflowExecution,
    projectPath: string,
    sessionName: string,
  ): void {
    // Attribution comes from the recorded origin, never from the seed
    // projection: on a definition-less row those fields are deliberate filler
    // naming a definition that does not exist (D7 decision D2).
    const attribution = describeLaunchSource(execution.origin);
    const execLogger = createExecutionLogger(execution.id);
    registerExecutionLogger(execLogger);
    execLogger.writeManifest(execution);
    execLogger.lifecycle("execution.started", {
      ...attribution,
      projectPath,
      sessionName,
      contextCount: execution.workingDefinition.executionContexts.length,
      taskCount: execution.workingDefinition.tasks.length,
    });
    logger.info("graph-workflow.execution.started", {
      executionId: execution.id,
      ...attribution,
    });
  }

  /**
   * Resolve a launch request into the definition content it will run and the
   * provenance it will persist.
   *
   * The template arm is the ONLY place a launch reads saved-definition storage;
   * the one-off arm resolves to the document the caller already submitted, so
   * an inline launch provably cannot reach the template library, the builder,
   * or the launcher list (R1.1). Everything after this point is origin-blind.
   */
  async function resolveLaunchSource(
    request: WorkflowLaunchSourceRequest,
    context: { projectPath: string; sessionName: string },
  ): Promise<ResolvedLaunchSource> {
    if (request.kind === "one_off") {
      return {
        source: { kind: "one_off", planName: request.plan.name },
        definition: request.plan.definition,
        launchDocument: {
          name: request.plan.name,
          description: request.plan.description,
          definition: request.plan.definition,
          layout: request.plan.layout,
        },
      };
    }

    if (request.kind === "spec_delivery") {
      const definition = await deps.loadDefinition(
        context.projectPath,
        request.definitionId,
        "project",
      );
      if (!definition) {
        throw new WorkflowDefinitionNotFoundError(
          request.definitionId,
          "project",
        );
      }
      if (definition.revision !== request.expectedRevision) {
        throw new WorkflowDefinitionRevisionMismatchError(
          request.definitionId,
          request.expectedRevision,
          definition.revision,
        );
      }
      return {
        source: {
          kind: "spec_delivery",
          specSlug: request.specSlug,
          candidateId: request.candidateId,
          definitionId: definition.id,
          definitionRevision: definition.revision,
        },
        definition: definition.definition,
        launchDocument: {
          name: definition.name,
          description: definition.description,
          definition: definition.definition,
          layout: definition.layout,
        },
      };
    }

    const tier: TemplateTier = request.tier ?? "project";
    const definition = await deps.loadDefinition(
      context.projectPath,
      request.definitionId,
      tier,
    );
    if (!definition) {
      throw new WorkflowDefinitionNotFoundError(request.definitionId, tier);
    }
    if (
      request.expectedRevision !== undefined &&
      definition.revision !== request.expectedRevision
    ) {
      logger.warn("graph-workflow.start.definition_revision_mismatch", {
        projectPath: context.projectPath,
        sessionName: context.sessionName,
        definitionId: request.definitionId,
        expectedDefinitionRevision: request.expectedRevision,
        actualDefinitionRevision: definition.revision,
      });
      throw new WorkflowDefinitionRevisionMismatchError(
        request.definitionId,
        request.expectedRevision,
        definition.revision,
      );
    }

    return {
      source: {
        kind: "template",
        definitionId: definition.id,
        definitionRevision: definition.revision,
        tier,
      },
      definition: definition.definition,
      // Copied, not referenced: the run must still render its own graph and
      // layout after the template is edited or deleted (R12.3).
      launchDocument: {
        name: definition.name,
        description: definition.description,
        definition: definition.definition,
        layout: definition.layout,
      },
    };
  }

  /**
   * The dirty-worktree exemption's eligibility probe (R8, decision D10).
   *
   * Reached ONLY when the worktree is already known to be dirty, which is what
   * keeps today's guard order intact: an ordinary clean launch resolves nothing
   * extra, and a dirty refusal still outranks the missing-definition 404 behind
   * it. The probe answers with the resolved source it had to build, so an
   * admitted plan is resolved once for both the exemption and the launch.
   *
   * Every failure mode collapses to "not exempt": a definition that is gone, a
   * revision that moved, a config read that failed, a cascade that threw. The
   * ordinary dirty guard stays fail-OPEN on its own probe (a broken `git
   * status` must not wedge a legitimate start), but an exemption is a proof
   * obligation — an unprovable one is refused.
   */
  async function probeDirtyWorktreeExemption(
    input: GraphWorkflowLaunchInput,
  ): Promise<ResolvedLaunchSource | null> {
    try {
      const resolved = await resolveLaunchSource(input.source, {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      const global = await (deps.readGlobalConfig ?? readConfig)();
      // The predicate reads cascade-resolved config (script commands,
      // collaboration), so the cascade has to run before it can be asked.
      // Substitution is deliberately not run first: it rewrites content and
      // charter text, never the operational config this proof quantifies over.
      const cascade = resolveWorkflowDefinition(global, resolved.definition);
      return isWholeRunLiveSessionReadOnly(cascade) ? resolved : null;
    } catch (error) {
      logger.info("graph-workflow.start.dirty_exemption_unprovable", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        originKind: input.source.kind,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * Reserve the lease with the session-finalizing question re-asked INSIDE the
   * reserving transaction (R13).
   *
   * The advisory answer at the top of the gauntlet is stale by the time this
   * runs: source resolution, the prerequisite preflight and input validation
   * all await in between, and a merge that registers anywhere in that window
   * then reads a free lease under its own project lock. Both would be admitted,
   * leaving a Current run in a session the merge is about to finish.
   *
   * The fence is synchronous and the merge's registration is synchronous, so on
   * one event loop the two possible orders are exhaustive: either the lease
   * commits before the merge registers — and the merge's in-lock lease read
   * sees it — or the merge is registered before the fence reads the registry,
   * and this refuses. A refusal is write-free: it declines before the
   * transaction's first write, so no row, no normalization and no artifact
   * record survives it.
   */
  async function reserveWithSessionFinalizingFence(
    input: GraphWorkflowLaunchInput,
    readFinalizingMerge: (
      projectPath: string,
      sessionName: string,
    ) => SessionFinalizingMerge | null,
    seed: GraphWorkflowExecutionSeed,
  ): Promise<GraphWorkflowExecution> {
    try {
      return await deps.executionRepository.create(
        input.projectPath,
        input.sessionName,
        seed,
        () => {
          const merge = readFinalizingMerge(
            input.projectPath,
            input.sessionName,
          );
          if (merge === null) return;
          throw sessionFinalizingStartGuardError(merge);
        },
      );
    } catch (error) {
      // The fence itself cannot log — it runs on the write queue, where
      // `createLogger` would append to disk while every other writer waits.
      if (
        error instanceof WorkflowStartGuardError &&
        error.finalizingMerge !== undefined
      ) {
        logger.info("graph-workflow.start.blocked_session_finalizing", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          jobId: error.finalizingMerge.jobId,
          branchName: error.finalizingMerge.branchName,
          checkpoint: "reservation",
        });
      }
      throw error;
    }
  }

  /**
   * THE launch gauntlet, ridden by every origin (D7 decision D1).
   *
   * `workflow start` and `workflow run` differ in exactly one step — how the
   * definition content is resolved — and that step is `resolveLaunchSource`
   * above. Lease admission, the dirty-worktree guard, the execution contract,
   * the prerequisite preflight, input validation, seeding (substitution,
   * structural re-validation, reference checks, the global → workflow →
   * per-context cascade, assignment snapshots, the selector freeze), the
   * approval park, and the pending → running transition all happen HERE, once,
   * so validation parity between the two verbs is structural rather than
   * aspirational.
   */
  async function launch(
    input: GraphWorkflowLaunchInput,
  ): Promise<GraphWorkflowLaunchOutcome> {
    // Guard order is behavior-preserving and load-bearing: active-execution
    // first, then the dirty-worktree guard, both BEFORE the source is resolved.
    // The dirty 409 must still win over a 404 when both apply (the HTTP handler
    // historically checked dirty before resolving the definition), and the
    // active-execution guard precedes everything so an already-running workflow
    // reports the more specific message.
    const existing = await deps.executionRepository.getActive(
      input.projectPath,
      input.sessionName,
    );
    // ADVISORY half of the two-phase guard: it refuses early, before the long
    // async gauntlet, and mutates nothing — the read above upgrades a
    // legacy-shaped row for this caller without writing it back, so a launch
    // that stops here has touched no store at all (R5.2). The authoritative
    // decision — same `evaluateLeaseAdmission`, so the two can only agree —
    // runs inside the repository's serialized reservation, which also performs
    // the normalization a lease-free incumbent needs. Refusing here therefore
    // leaves the incumbent byte-identical whatever it is (R3.4).
    const admission = evaluateLeaseAdmission(existing);
    if (admission.kind === "refuse") {
      throw leaseHeldStartGuardError({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        refusal: admission,
      });
    }

    // The symmetric half of the delivery gate (R13), ADVISORY half. The merge
    // refuses while a run holds the lease; this refuses while the session is
    // being finalized. Without it the two admit each other in the window
    // between the merge route's advisory lease check and the publish under the
    // project lock: the route sees no lease, the launch sees no merge, and the
    // session gets a fresh run seeded into it as it is marked finished. It runs
    // here so a refusal pays for nothing below — a lease-held incumbent reports
    // the more specific refusal above, which is why that check runs first — and
    // the AUTHORITATIVE half re-asks inside the reserving transaction, because
    // everything between here and there is asynchronous.
    const readFinalizingMerge =
      deps.readSessionFinalizingMerge ?? defaultReadSessionFinalizingMerge;
    const finalizingMerge = readFinalizingMerge(
      input.projectPath,
      input.sessionName,
    );
    if (finalizingMerge !== null) {
      logger.info("graph-workflow.start.blocked_session_finalizing", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        jobId: finalizingMerge.jobId,
        branchName: finalizingMerge.branchName,
        checkpoint: "advisory",
      });
      throw sessionFinalizingStartGuardError(finalizingMerge);
    }

    // Lanes fork from the committed session branch, so any uncommitted change in
    // the session worktree (e.g. a freshly-written, never-committed Kiro spec —
    // which is untracked) would be missing from every lane. Refuse the start,
    // UNLESS the resolved run provably forks no lane at all (R8).
    const dirtyPaths = await readSessionDirtyPaths(
      input.projectPath,
      input.sessionName,
    );
    // Carried out of the guard so an exempted launch reuses the resolution the
    // eligibility probe already paid for.
    let exemptedSource: ResolvedLaunchSource | null = null;
    if (dirtyPaths.length > 0) {
      exemptedSource = await probeDirtyWorktreeExemption(input);
      if (exemptedSource === null) {
        logger.info("graph-workflow.start.blocked_uncommitted_changes", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          dirtyCount: dirtyPaths.length,
        });
        throw new WorkflowStartGuardError(
          "uncommitted_changes",
          `Cannot start the workflow while the session worktree has ${dirtyPaths.length} uncommitted change(s). Workflow lanes are created from the committed branch, so uncommitted files would be missing. Commit your changes and try again.`,
          { dirtyPaths },
        );
      }
      logger.info("graph-workflow.start.dirty_worktree_exempted", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        originKind: input.source.kind,
        dirtyCount: dirtyPaths.length,
      });
    }

    const { source, definition, launchDocument } =
      exemptedSource ??
      (await resolveLaunchSource(input.source, {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      }));
    const attribution = describeLaunchSource(source);

    const contractDecision = executionContract.validateDefinition(definition);
    if (!contractDecision.ok) {
      logger.warn("graph-workflow.start.execution_contract_rejected", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        ...attribution,
        code: contractDecision.code,
        issueCount: contractDecision.issues.length,
      });
    }
    assertGraphExecutionContractAccepted(contractDecision);

    // Deterministic prerequisite gate. It sits AFTER the dirty-worktree guard
    // (mirroring the existing chain — a dirty worktree is reported before a
    // missing prerequisite, both are pre-token gates) and BEFORE start-input
    // validation/substitution, so a prerequisite miss is attributed distinctly
    // and seeds nothing — no conversation, no agent turn (R5.9, R6.1, R6.3).
    const session = await readStartSession(
      input.projectPath,
      input.sessionName,
    );
    if (session) {
      try {
        if (deps.assertSessionBranchReady) {
          await deps.assertSessionBranchReady(
            session.worktreePath,
            session.branchName,
          );
        } else {
          await defaultGitClient.git(
            [
              "rev-parse",
              "--verify",
              "--quiet",
              `refs/heads/${session.branchName}^{commit}`,
            ],
            session.worktreePath,
          );
        }
      } catch (error) {
        logger.warn("graph-workflow.start.session_branch_unavailable", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          branchName: session.branchName,
          worktreePath: session.worktreePath,
          error: getErrorMessage(error),
        });
        throw new WorkflowStartGuardError(
          "session_branch_unavailable",
          `Cannot start the workflow: session branch "${session.branchName}" does not resolve to a commit in the session worktree. Restore the session branch or repair its recorded branch name before launching.`,
        );
      }
      const preflightService =
        deps.preflightService ?? createPreflightPrerequisiteService();
      const global = await (deps.readGlobalConfig ?? readConfig)();
      // Backends are not a parameterizable field, so the used-backend set is
      // resolved from the RAW resolved definition pre-substitution — the same
      // resolution the run uses (per-context → workflow → global). It scopes
      // backend-dependent (skill) prerequisites to the backend(s) that actually
      // run the launch, never a single assumed launch backend (R5.2a, R5.4b).
      const usedBackends = computeUsedBackends(global, definition);
      const preflight = await preflightService.evaluate({
        definition,
        worktreePath: session.worktreePath,
        usedBackends,
      });
      if (preflight.status === "prerequisites_unmet") {
        logger.info("graph-workflow.start.blocked_prerequisites_unmet", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          ...attribution,
          missingCount: preflight.missing.length,
        });
        throw new WorkflowPrerequisitesUnmetError(
          preflight.missing,
          `Cannot start the workflow: ${preflight.missing.length} declared prerequisite(s) are unmet in the session worktree.`,
        );
      }
    }

    const validation = validateLaunchInputs({
      parameters: definition.parameters,
      supplied: input.parameters,
    });
    if (!validation.ok) {
      logger.info("graph-workflow.start.input_rejected", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        ...attribution,
        rejectionKind: validation.error.kind,
        parameterName: validation.error.name,
      });
      throw new WorkflowStartInputError(
        validation.error,
        describeLaunchInputError(validation.error),
      );
    }
    const boundInputs = validation.boundInputs;
    const seededDocuments = seededWorkflowDocumentsSchema.parse([
      ...(definition.seededDocuments ?? []),
      ...(input.seededDocuments ?? []),
    ]);
    logger.debug("graph-workflow.start.documents_validated", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      count: seededDocuments.length,
      bytes: seededDocuments.reduce(
        (total, document) =>
          total + new TextEncoder().encode(document.contents).byteLength,
        0,
      ),
    });

    const pendingExecution = await reserveWithSessionFinalizingFence(
      input,
      readFinalizingMerge,
      {
        definition,
        source,
        launchDocument,
        executionId: getExecutionId(deps),
        startedAt: getNow(deps),
        inputs: boundInputs,
        ownerConversationId: input.ownerConversationId ?? null,
        seededDocuments,
        // Only an admitted dirty launch carries the pin, and it carries it for
        // the execution's whole lifetime: the live-edit frontier re-asserts the
        // property against every later structural mutation (R8.3).
        liveSessionReadOnlyPinned: exemptedSource !== null,
        ...(input.transactionAttachment !== undefined && {
          transactionAttachment: input.transactionAttachment,
        }),
      },
    );

    const authoredDefinition = {
      ...pendingExecution.workingDefinition,
      charter: pendingExecution.charter,
    };
    const sourceWarnings =
      session === null
        ? []
        : locatePlanIssues(
            await (
              deps.lintCommittedSourceLocators ??
              defaultLintCommittedSourceLocators
            )(authoredDefinition, session),
            // The same id-bearing locator `workflow validate` renders (#80
            // design 3.2): a source warning names the charter source it is
            // about, not the position it happens to occupy.
            authoredDefinition,
          );
    logger.info("graph-workflow.start.source_check", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      ...attribution,
      resolutionKind:
        session === null ? "session_unavailable" : "launch_session_head",
      warningCount: sourceWarnings.length,
    });
    const warningFields =
      sourceWarnings.length === 0 ? {} : { warnings: sourceWarnings };

    // An authored `approvalRequired` is an ACCEPTED launch that has not begun
    // (D7 R14): the pending execution is durable and holds the session's lease,
    // so the outcome carries the park rather than raising it. Nothing below this
    // line runs for a parked run — the loop starts only once a human decides.
    if (
      awaitsDefinitionApproval(
        pendingExecution.status,
        pendingExecution.definitionApproval,
      )
    ) {
      logger.info("graph-workflow.definition_approval.pending", {
        executionId: pendingExecution.id,
        ...attribution,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        requestedAt: pendingExecution.definitionApproval?.requestedAt ?? null,
      });
      return {
        execution: pendingExecution,
        awaitingDefinitionApproval: true,
        ...warningFields,
      };
    }

    const nextExecution = await deps.executionRepository
      .mutateActive(input.projectPath, input.sessionName, (execution) => {
        execution.status = "running";
        execution.machineSnapshot = buildLifecycleSnapshot(execution, {
          lifecycleStatus: "running",
          recoveryMode: "none",
          hasLiveIteration: false,
        });
        return changed(execution);
      })
      .then((mutation) => mutation.execution);

    recordExecutionStarted(nextExecution, input.projectPath, input.sessionName);

    return {
      execution: nextExecution,
      awaitingDefinitionApproval: false,
      ...warningFields,
    };
  }

  /**
   * Launch a SAVED definition (`workflow start`). A thin adapter: it names the
   * template source and hands the rest to the shared gauntlet.
   */
  async function start(
    input: GraphWorkflowStartInput,
  ): Promise<GraphWorkflowLaunchOutcome> {
    return launch({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      source: {
        kind: "template",
        definitionId: input.definitionId,
        ...(input.expectedDefinitionRevision !== undefined
          ? { expectedRevision: input.expectedDefinitionRevision }
          : {}),
        ...(input.tier !== undefined ? { tier: input.tier } : {}),
      },
      ...(input.parameters !== undefined
        ? { parameters: input.parameters }
        : {}),
      ...(input.ownerConversationId !== undefined
        ? { ownerConversationId: input.ownerConversationId }
        : {}),
      ...(input.seededDocuments !== undefined
        ? { seededDocuments: input.seededDocuments }
        : {}),
    });
  }

  /**
   * Launch an INLINE plan (`workflow run`). The plan has already passed the
   * accept-time gate at the route boundary; from here it is indistinguishable
   * from a template launch except for its recorded origin, which is exactly
   * R2's parity claim.
   */
  async function run(
    input: GraphWorkflowRunInput,
  ): Promise<GraphWorkflowLaunchOutcome> {
    return launch({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      source: { kind: "one_off", plan: input.plan },
      ...(input.inputs !== undefined ? { parameters: input.inputs } : {}),
      ...(input.ownerConversationId !== undefined
        ? { ownerConversationId: input.ownerConversationId }
        : {}),
      ...(input.seededDocuments !== undefined
        ? { seededDocuments: input.seededDocuments }
        : {}),
    });
  }

  /**
   * The spec-delivery adapter onto the shared gauntlet: identical to `run`
   * except for the recorded provenance. Kept a separate verb so the origin is
   * always the caller's explicit statement, never inferred from which optional
   * fields happen to be set (D7 decision D2).
   */
  async function launchSpecDelivery(
    input: GraphWorkflowSpecDeliveryInput,
  ): Promise<GraphWorkflowLaunchOutcome> {
    return launch({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      source: {
        kind: "spec_delivery",
        definitionId: input.definitionId,
        expectedRevision: input.expectedDefinitionRevision,
        specSlug: input.specSlug,
        candidateId: input.candidateId,
      },
      ...(input.inputs !== undefined ? { parameters: input.inputs } : {}),
      ...(input.ownerConversationId !== undefined
        ? { ownerConversationId: input.ownerConversationId }
        : {}),
      ...(input.seededDocuments !== undefined
        ? { seededDocuments: input.seededDocuments }
        : {}),
      ...(input.transactionAttachment !== undefined
        ? { transactionAttachment: input.transactionAttachment }
        : {}),
    });
  }

  /**
   * Reserve the park's pending decision for one act, WITHOUT deciding it.
   *
   * The first of the approval saga's two commits (D7 decision D17). It writes
   * only the reservation: the run stays `pending`, its approval record stays
   * undecided, and nothing materializes — so a caller that goes on to be
   * refused by the admission gate has an act it can fully undo, and a caller
   * that loses this race never reaches the gate at all. Every refusal branch
   * returns a refusal without committing, advancing the staging fence, or
   * publishing an update for a run this caller did not touch.
   */
  async function claimDefinitionApproval(
    input: ClaimDefinitionApprovalInput,
  ): Promise<ClaimDefinitionApprovalResult> {
    const now = getNow(deps);
    const claimId = randomUUID();
    const outcome = await deps.executionRepository.mutateActive<
      void,
      Exclude<ClaimDefinitionApprovalResult, { ok: true }>["reason"]
    >(input.projectPath, input.sessionName, (execution) => {
      if (
        input.expectedExecutionId !== undefined &&
        execution.id !== input.expectedExecutionId
      ) {
        return refused("execution_mismatch");
      }
      // Ordered so the row's own state outranks a reservation left on it:
      // a run that has left the park answers "not awaiting approval" even
      // if an abort walked away from a reservation nobody can use anymore.
      if (execution.definitionApproval === null) {
        return refused("not_awaiting_approval");
      }
      if (execution.definitionApproval.approvedAt !== null) {
        return refused("already_decided");
      }
      if (execution.status !== "pending") {
        return refused("not_awaiting_approval");
      }
      if (execution.definitionApprovalClaim !== null) {
        return refused("decision_in_flight");
      }
      execution.definitionApprovalClaim = { claimId, claimedAt: now };
      return changed(execution);
    });

    if (outcome.kind === "refused") {
      const reason = outcome.refusal;
      logger.warn("graph-workflow.definition_approval.claim_refused", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        expectedExecutionId: input.expectedExecutionId,
        reason,
      });
      return { ok: false, reason };
    }

    const nextExecution = outcome.execution;

    logger.info("graph-workflow.definition_approval.claimed", {
      executionId: nextExecution.id,
      origin: nextExecution.origin.kind,
      claimId,
      claimedAt: now,
    });
    return { ok: true, execution: nextExecution, claimId };
  }

  /**
   * Hand the park's decision back, undecided — the compensation for a
   * reservation whose admission was refused. The park returns to exactly the
   * state the reviewer found it in, which is what makes the gate's "fix this,
   * then approve again" remedy true.
   */
  async function releaseDefinitionApprovalClaim(
    input: ReleaseDefinitionApprovalClaimInput,
  ): Promise<ReleaseDefinitionApprovalClaimResult> {
    const outcome = await deps.executionRepository.mutateActive<
      void,
      Exclude<ReleaseDefinitionApprovalClaimResult, { ok: true }>["reason"]
    >(input.projectPath, input.sessionName, (execution) => {
      if (execution.id !== input.expectedExecutionId) {
        return refused("execution_mismatch");
      }
      if (execution.definitionApprovalClaim === null) {
        return refused("not_reserved");
      }
      // Bound to the holder, not to "a reservation exists": a sweep can
      // reclaim a stranded reservation and hand the park to a new act while
      // this one is still running, and freeing THAT act's reservation would
      // reopen the park underneath its live admission.
      if (execution.definitionApprovalClaim.claimId !== input.claimId) {
        return refused("claim_superseded");
      }
      execution.definitionApprovalClaim = null;
      return changed(execution);
    });

    if (outcome.kind === "refused") {
      const reason = outcome.refusal;
      logger.warn("graph-workflow.definition_approval.claim_release_refused", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        expectedExecutionId: input.expectedExecutionId,
        reason,
      });
      return { ok: false, reason };
    }

    const nextExecution = outcome.execution;

    logger.info("graph-workflow.definition_approval.claim_released", {
      executionId: nextExecution.id,
    });
    return { ok: true, execution: nextExecution };
  }

  async function recordDefinitionApproval(
    input: RecordDefinitionApprovalInput,
  ): Promise<RecordDefinitionApprovalResult> {
    const active = await deps.executionRepository.getActive(
      input.projectPath,
      input.sessionName,
    );
    if (!active) {
      logger.warn("graph-workflow.definition_approval.guard_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: "no_active_execution",
      });
      return { ok: false, reason: "no_active_execution" };
    }

    if (
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

    if (awaitsDefinitionApproval(active.status, active.definitionApproval)) {
      const contractDecision = executionContract.validateDefinition(
        active.workingDefinition,
      );
      if (!contractDecision.ok) {
        logger.warn(
          "graph-workflow.definition_approval.execution_contract_rejected",
          {
            executionId: active.id,
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            code: contractDecision.code,
            issueCount: contractDecision.issues.length,
          },
        );
      }
      assertGraphExecutionContractAccepted(contractDecision);
    }

    const outcome = await deps.executionRepository.mutateActive<
      void,
      Exclude<RecordDefinitionApprovalResult, { ok: true }>["reason"]
    >(input.projectPath, input.sessionName, (execution) => {
      // The AUTHORITATIVE guard: the read above is advisory, and the row
      // can turn over — or another approval can decide it — in between.
      // Refusals preserve the row and staging fence for the act that wins.
      if (
        input.expectedExecutionId !== undefined &&
        execution.id !== input.expectedExecutionId
      ) {
        return refused("execution_mismatch");
      }
      const approval = execution.definitionApproval;
      if (approval === null) {
        return refused("not_awaiting_approval");
      }
      if (approval.approvedAt !== null) {
        return refused("already_decided");
      }
      if (execution.status !== "pending") {
        return refused("not_awaiting_approval");
      }
      // Finalization is the reservation holder's second commit, never a
      // first move: an approval that starts a run the admission consumer
      // was never asked about is exactly the unadmitted start the gate
      // exists to prevent.
      if (execution.definitionApprovalClaim === null) {
        return refused("not_reserved");
      }
      // The reservation must still be THIS act's. A sweep can reclaim a
      // stranded reservation and grant it to another act, and finalizing
      // on the strength of that act's reservation would start the run on an
      // admission this caller no longer has any claim to.
      if (execution.definitionApprovalClaim.claimId !== input.claimId) {
        return refused("claim_superseded");
      }

      approval.approvedAt = getNow(deps);
      // Consumed by the act it belonged to: the decision is made, so
      // nothing is in flight for the next act to wait behind.
      execution.definitionApprovalClaim = null;
      execution.status = "running";
      execution.machineSnapshot = buildLifecycleSnapshot(execution, {
        lifecycleStatus: "running",
        recoveryMode: "none",
        hasLiveIteration: false,
      });
      return changed(execution);
    });

    if (outcome.kind === "refused") {
      const guardFailure = outcome.refusal;
      logger.warn("graph-workflow.definition_approval.guard_failed", {
        executionId: active.id,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: guardFailure,
        expectedExecutionId: input.expectedExecutionId,
      });
      return { ok: false, reason: guardFailure };
    }

    const nextExecution = outcome.execution;

    // The third kickoff, and the WINNER's alone: an approval-gated launch sits
    // `pending` across an arbitrary wait, so a crash right after its reserving
    // commit surfaces here — the approval is what first hands the run to the
    // loop, and it must not do so over a worktree missing the run's sources.
    // Taken after the commit, like `resume`: a loser that repaired from its
    // stale snapshot would have written files for a decision that never
    // happened, and the repository re-halts the identified run if the repair
    // itself fails.
    await repairPendingArtifacts(
      input.projectPath,
      input.sessionName,
      nextExecution.id,
    );

    logger.info("graph-workflow.definition_approval.recorded", {
      executionId: nextExecution.id,
      definitionId: nextExecution.seedDefinitionId,
      definitionRevision: nextExecution.seedDefinitionRevision,
      approvedAt: nextExecution.definitionApproval?.approvedAt ?? null,
    });
    recordExecutionStarted(nextExecution, input.projectPath, input.sessionName);
    return { ok: true, execution: nextExecution };
  }

  async function send(
    projectPath: string,
    sessionName: string,
    event: GraphWorkflowManagerEvent,
  ): Promise<GraphWorkflowExecution> {
    const now = getNow(deps);

    if (event.type === "pause") {
      const { execution: pausedExecution, conversationIdsToAbort } =
        await deps.executionRepository
          .mutateActive(projectPath, sessionName, (execution) => {
            assertLifecycleTransitionAllowed(
              execution,
              "pause",
              ["running"],
              "Only running graph workflow executions can be paused",
            );
            const conversationIdsToAbort =
              collectCancellableConversationIds(execution);
            return changed(
              transitionToNonRunningState(execution, "paused", null, null),
              { conversationIdsToAbort },
            );
          })
          .then((mutation) => ({
            execution: mutation.execution,
            ...mutationValue(mutation),
          }));
      deps.abortExecutionLoop(projectPath, sessionName);
      abortRunningTaskConversations(
        projectPath,
        sessionName,
        conversationIdsToAbort,
      );
      // Pause is the edit point (doc 06): the in-flight round is abandoned and
      // its parked validator questions go with it, so the edited roster's next
      // round starts with no residue — no stale question the human could still
      // answer into a cohort that no longer exists. An implementer's parked
      // question belongs to no round and survives, as it always has.
      const nextExecution = await userInputGateService.withdrawRoundQuestions({
        projectPath,
        sessionName,
        executionId: pausedExecution.id,
      });
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("execution.paused", { actor: "operator" });
      logger.info("graph-workflow.execution.paused", {
        executionId: nextExecution.id,
      });
      return nextExecution;
    }

    if (event.type === "abort") {
      const { execution: abortedExecution, conversationIdsToAbort } =
        await deps.executionRepository
          .mutateActive(projectPath, sessionName, (execution) => {
            assertLifecycleTransitionAllowed(
              execution,
              "abort",
              ["pending", "running", "paused", "halted"],
              "Completed or aborted graph workflow executions cannot be aborted",
            );
            // A park with a decision in flight is momentarily not abortable. The
            // holder may be at its admission gate right now; ending the run
            // underneath it would strand that consumer's durable admission on a
            // run this abort killed, and leave the admitted act unable to
            // finalize. Age is deliberately not an exception here: an interrupted
            // decision may already have written downstream, so it is finished by
            // the settlement the route layer runs first, never abandoned.
            if (
              execution.definitionApprovalClaim !== null &&
              awaitsDefinitionApproval(
                execution.status,
                execution.definitionApproval,
              )
            ) {
              throw new GraphWorkflowTransitionConflictError(
                "abort",
                execution.status,
                ["running", "paused", "halted"],
                "A definition approval decision is in flight; abort once it settles",
              );
            }
            const conversationIdsToAbort =
              collectCancellableConversationIds(execution);
            return changed(
              transitionToNonRunningState(execution, "aborted", now, {
                type: "aborted",
                cause: null,
                summary: null,
              }),
              { conversationIdsToAbort },
            );
          })
          .then((mutation) => ({
            execution: mutation.execution,
            ...mutationValue(mutation),
          }));
      deps.abortExecutionLoop(projectPath, sessionName);
      abortRunningTaskConversations(
        projectPath,
        sessionName,
        conversationIdsToAbort,
      );
      // A parked question must not dangle as answerable once the execution is
      // aborted (Req 7.4). The withdrawal belongs here, beside the transition,
      // for two reasons: aborting a paused or halted execution has no loop to
      // run cleanup at all, and the transition above retires the running loop's
      // generation — a loop that reacted to the abort itself would be fenced
      // out of the very write the cleanup needs. Pause withdraws only its
      // round's questions; abort ends the execution, so every park goes.
      const nextExecution = await userInputGateService.withdrawAll({
        projectPath,
        sessionName,
        executionId: abortedExecution.id,
      });
      await stopLaneDevServers({ execution: nextExecution, projectPath });
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("execution.aborted", { actor: "operator" });
      execLogger?.writeManifest(nextExecution);
      unregisterExecutionLogger(nextExecution.id);
      logger.info("graph-workflow.execution.aborted", {
        executionId: nextExecution.id,
      });
      return nextExecution;
    }

    if (event.type === "complete") {
      const nextExecution = await deps.executionRepository
        .mutateActive(projectPath, sessionName, (execution) => {
          assertLifecycleTransitionAllowed(
            execution,
            "complete",
            ["running"],
            "Only running graph workflow executions can be completed",
          );
          execution.status = "completed";
          execution.completedAt = now;
          execution.haltReason = null;
          execution.loopEpoch += 1;
          execution.machineSnapshot = buildLifecycleSnapshot(execution, {
            lifecycleStatus: "completed",
            recoveryMode: "none",
            hasLiveIteration: false,
          });
          return changed(execution);
        })
        .then((mutation) => mutation.execution);
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("execution.completed");
      execLogger?.writeManifest(nextExecution);
      unregisterExecutionLogger(nextExecution.id);
      logger.info("graph-workflow.execution.completed", {
        executionId: nextExecution.id,
      });
      return nextExecution;
    }

    const haltReason = event.reason;

    const { execution: nextExecution, conversationIdsToAbort } =
      await deps.executionRepository
        .mutateActive(projectPath, sessionName, (execution) => {
          let conversationIdsToAbort: string[] = [];

          assertLifecycleTransitionAllowed(
            execution,
            "halt",
            ["running"],
            "Only running graph workflow executions can be halted",
          );
          conversationIdsToAbort = collectCancellableConversationIds(execution);
          return changed(
            transitionToNonRunningState(execution, "halted", now, haltReason),
            { conversationIdsToAbort },
          );
        })
        .then((mutation) => ({
          execution: mutation.execution,
          ...mutationValue(mutation),
        }));
    deps.abortExecutionLoop(projectPath, sessionName);
    abortRunningTaskConversations(
      projectPath,
      sessionName,
      conversationIdsToAbort,
    );
    await stopLaneDevServers({ execution: nextExecution, projectPath });
    const execLogger = getExecutionLogger(nextExecution.id);
    execLogger?.lifecycle("execution.halted", {
      haltReason,
      actor: "system",
    });
    execLogger?.writeManifest(nextExecution);
    unregisterExecutionLogger(nextExecution.id);
    logger.info("graph-workflow.execution.halted", {
      executionId: nextExecution.id,
      haltReasonType: haltReason.type,
    });
    return nextExecution;
  }

  async function resume(
    projectPath: string,
    sessionName: string,
    options?: GraphWorkflowResumeOptions,
  ): Promise<GraphWorkflowExecution> {
    const mutation = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        let previousStatus: GraphWorkflowStatus | null = null;
        const resumeCapture: {
          resolvedHaltReason: GraphWorkflowHaltReason | null;
        } = { resolvedHaltReason: null };
        let hasInterrupted = false;
        let mergeRetryContextIds: string[] = [];
        let resetJoinIds: string[] = [];
        let laneConversationIdsToAbort: string[] = [];
        let refilledRoundContextIds: string[] = [];
        let retiredRoundContextIds: string[] = [];

        if (
          options?.expectedExecutionId !== undefined &&
          execution.id !== options.expectedExecutionId
        ) {
          throw new GraphWorkflowTransitionConflictError(
            "resume",
            execution.status,
            ["paused", "halted"],
            `Graph workflow execution ${options.expectedExecutionId} no longer holds this session's execution lease; ${execution.id} does.`,
          );
        }
        assertLifecycleTransitionAllowed(
          execution,
          "resume",
          ["paused", "halted"],
          "Only paused or halted graph workflow executions can be resumed",
        );
        // Status alone cannot answer this (D7 decision D3): a non-resumably
        // halted run and an abandoned one are both `halted`, and neither may be
        // resumed — the lease they no longer hold is what says so. Without this
        // the status gate would resume a run the editability classifier already
        // refuses to edit, and would resurrect a record that History owns.
        if (
          !holdsExecutionLease(
            execution.status,
            execution.haltReason,
            execution.abandonment,
          )
        ) {
          throw new GraphWorkflowTransitionConflictError(
            "resume",
            execution.status,
            ["paused", "halted"],
            execution.abandonment !== null
              ? `Graph workflow execution ${execution.id} was abandoned and belongs to History; launch a new run instead.`
              : `Graph workflow execution ${execution.id} halted for a reason that cannot be resumed; launch a new run instead.`,
          );
        }

        // Resuming reschedules every concluded-failed join. When the halt says
        // the conflict resolver never reached the conflict and the failure is
        // not retryable — an exhausted quota, a revoked key — the rescheduled
        // join runs straight back into it (incident 3edd5fd7 spent three
        // attempts that way). Only a human can know capacity was restored, so
        // the automatic caller is refused and the operator's resume proceeds.
        if ((options?.initiator ?? "operator") === "system") {
          const blocking = nonRetryableResolutionHalt([
            execution.haltReason,
            ...execution.secondaryHaltReasons,
          ]);
          if (blocking !== null) {
            const hint =
              blocking.retryAfterHint === undefined
                ? ""
                : ` (capacity hint: ${blocking.retryAfterHint})`;
            throw new GraphWorkflowTransitionConflictError(
              "resume",
              execution.status,
              ["paused", "halted"],
              `Graph workflow execution ${execution.id} halted because conflict resolution failed on ${blocking.kind}: ${blocking.message}${hint}. ` +
                `An automatic resume would retry the join into the same failure; resume it manually once the backend is available.`,
            );
          }
        }

        if (
          [execution.haltReason, ...execution.secondaryHaltReasons].some(
            (reason) => reason?.type === "loop_limit_reached",
          )
        ) {
          const assessment = settleLoops(structuredClone(execution), {
            now: getNow(deps),
          });
          if (assessment.halt?.type === "loop_limit_reached") {
            return refused({
              halt: assessment.halt,
              error: new GraphWorkflowTransitionConflictError(
                "resume",
                execution.status,
                ["paused", "halted"],
                `Loop ${assessment.halt.loopGroupId} remains exhausted at pass ${assessment.halt.pass}; resume would halt again. ` +
                  "Use cctl workflow live edit with raise-loop-max-passes or amend-loop-predicate so the next decision can change, or abandon the execution. Template-only edits cannot clear an exhausted limit; the execution-wide backstop cannot be raised.",
              ),
            });
          }
        }

        previousStatus = execution.status;
        // Captured before the clear below: the resume event echoes which halt
        // it resolved, so lifecycle.jsonl halt→resume pairs stay verifiable.
        resumeCapture.resolvedHaltReason = execution.haltReason;
        // Captured here for the same reason — the halt reasons are cleared
        // below, and which contexts they named decides what happens to the
        // rounds those halts deliberately left open.
        const roundDispositions = validationRoundResumeDispositions([
          execution.haltReason,
          ...execution.secondaryHaltReasons,
        ]);

        // Resume is a manual retry decision: concluded-failed joins go back to
        // pending (per-lane merge progress survives) so the loop re-runs them,
        // carrying any operator conflict guidance into the next resolution.
        const joinResetAt = new Date().toISOString();
        const joinIdsToReset = Object.values(execution.joins ?? {})
          .filter(
            (join) => join.status === "failed" || join.status === "conflicts",
          )
          .map((join) => join.joinId);
        for (const joinId of joinIdsToReset) {
          execution = resetJoinForRetry(
            execution,
            joinId,
            joinResetAt,
            options?.conflictGuidance,
          );
        }
        resetJoinIds = joinIdsToReset;
        // A zombie loop's in-flight turn is write-fenced but can still hold a
        // lane conversation against the new generation; collect the lanes so
        // any such turn is actively aborted below. Safe: no legitimate turn
        // can be running while the execution is paused/halted, so aborting an
        // idle lane conversation is a no-op.
        laneConversationIdsToAbort = collectLaneConversationIds(execution);
        execution.status = "running";
        execution.completedAt = null;
        execution.haltReason = null;
        execution.secondaryHaltReasons = [];
        // A pending reason recorded by a turn that settled after the
        // pause/halt belongs to the superseded generation; preserving it
        // would drain-halt the replacement loop on its first pass.
        execution.pendingHaltReason = null;
        // Start a loop generation distinct from both the generation that was
        // retired on entry to the quiescent state and any persisted quiescent
        // execution restored without an in-process predecessor.
        execution.loopEpoch += 1;
        // The lane half of the same reservation (Design 3.1, decision D5): a
        // batch fenced out mid-provision cannot release its lane claim any more
        // than its context stamps, and no batch outlives the generation change,
        // so every claim here is stale. Left in place, the claim makes the lane
        // unmintable for every later generation: the resumed scheduler finds
        // nothing schedulable and the loop halts on its completion invariant
        // instead of dispatching the first batch (#80, design 3.8).
        execution.laneReservations = {};

        const retryIds: string[] = [];
        const refilledRoundIds: string[] = [];
        const retiredRoundIds: string[] = [];
        for (const contextState of Object.values(execution.contextStates)) {
          // Starting a new loop generation invalidates any scheduling
          // reservation from the old one: a superseded pass may have stamped a
          // context and then had its finalize fenced out, which would otherwise
          // leave the context permanently ineligible. Clear every stamp so the
          // fresh generation re-schedules from a clean slate (Design 3.1).
          contextState.reservedByBatchId = null;
          // in-progress: the merge's success write was fenced out (resume
          // landed mid-git-operation) or the server died mid-merge. The
          // context is completed so it is never rescheduled and downstream
          // eligibility requires merged-success — without a retry the
          // execution wedges. The merge runner reconciles against whatever
          // actually landed on the branch.
          if (
            contextState.mergeStatus === "merged-failed" ||
            contextState.mergeStatus === "in-progress"
          ) {
            transitionContextMergeStatus(
              execution,
              contextState.contextId,
              "pending",
              { reason: "manager.resume_merge_retry" },
            );
            contextState.lastMergeError = null;
            retryIds.push(contextState.contextId);
            continue;
          }
          // A context that tripped the circuit breaker is active+running at
          // halt, so the halt transition (markActiveContextReady) bumps it to
          // `ready`, not `halted`. Handling only `halted` here would leave its
          // consecutiveFailureCount intact and the breaker would re-trip almost
          // immediately on resume. Resume is a manual retry decision, so clear
          // the failure counter for every retryable context.
          if (contextState.status === "halted") {
            transitionContextStatus(
              execution,
              contextState.contextId,
              "ready",
              {
                reason: "manager.resume_halted_context",
              },
            );
          }
          if (contextState.status === "ready") {
            // The consecutive-mismatch budget is a manual retry decision for
            // the same reason: a context that halted at the bound would come
            // back at the bound and re-halt on its first round, which is a
            // resumable halt in name only.
            Object.assign(
              contextState,
              accountContextAction(contextState, { kind: "manual_resume" }),
            );
          }
          // Resume is the manual retry decision for the two halts that leave a
          // round open, and it owes them opposite things (see
          // `validationRoundResumeDispositions`). An infrastructure halt gets a
          // REFILL: the lanes that never reached a verdict get their attempt
          // budget back, so the round can actually run again — without it the
          // halt is resumable in name only, every unsettled lane coming back at
          // the bound to re-halt on the first pass (D5). A plan defect gets a
          // RETIREMENT: the recovery has rewritten the plan its seats judged, so
          // the round has nothing left to say, and leaving it open would either
          // replay a defect already repaired or lock the implementer out of the
          // tasks the repair just added (#86).
          //
          // Only for the contexts a halt named: a restart-driven resume carries
          // no halt reason at all, and its round is legitimately resumable.
          const round = contextState.validationRound;
          if (round && isValidationRoundOpen(round)) {
            const disposition = roundDispositions.get(contextState.contextId);
            if (disposition === "refill") {
              contextState.validationRound =
                resetValidationRoundAttempts(round);
              refilledRoundIds.push(contextState.contextId);
            } else if (disposition === "retire") {
              // `null`, not a verdict: no validator judged the repaired plan,
              // and the candidate has not necessarily moved. Concluded rather
              // than erased — `seq` outlives the round it numbers, and the
              // frozen candidate and findings stay readable.
              contextState.validationRound = concludeValidationRound(
                round,
                null,
              );
              retiredRoundIds.push(contextState.contextId);
            }
          }
        }
        mergeRetryContextIds = retryIds;
        refilledRoundContextIds = refilledRoundIds;
        retiredRoundContextIds = retiredRoundIds;
        execution.pendingMergeRetry = retryIds;

        hasInterrupted = Object.values(execution.taskStates).some(
          (ts) => ts.status === "interrupted",
        );
        execution.machineSnapshot = buildLifecycleSnapshot(execution, {
          lifecycleStatus: "running",
          recoveryMode: hasInterrupted ? "interrupted_task" : "none",
          hasLiveIteration: false,
        });
        return changed(execution, {
          previousStatus,
          resumeCapture,
          hasInterrupted,
          mergeRetryContextIds,
          resetJoinIds,
          laneConversationIdsToAbort,
          refilledRoundContextIds,
          retiredRoundContextIds,
        });
      },
    );
    if (mutation.kind === "refused") {
      const refusal = mutation.refusal;
      logger.warn("graph-workflow.execution.resume_refused", {
        executionId: mutation.execution.id,
        reason: "loop_limit_unchanged",
        loopGroupId: refusal.halt.loopGroupId,
        scope: refusal.halt.scope,
        pass: refusal.halt.pass,
        maxPasses: refusal.halt.maxPasses,
      });
      throw refusal.error;
    }
    const {
      execution: nextExecution,
      value: {
        previousStatus,
        resumeCapture,
        hasInterrupted,
        mergeRetryContextIds,
        resetJoinIds,
        laneConversationIdsToAbort,
        refilledRoundContextIds,
        retiredRoundContextIds,
      },
    } = mutation;

    // Abort only after the epoch bump is committed: a zombie turn racing the
    // abort is already write-fenced, and the new loop is not kicked until
    // resume returns, so a fresh generation's turn can never be the target.
    if (laneConversationIdsToAbort.length > 0) {
      logger.info("graph-workflow.resume.lane_turns_aborted", {
        executionId: nextExecution.id,
        conversationIds: laneConversationIdsToAbort,
      });
      abortRunningTaskConversations(
        projectPath,
        sessionName,
        laneConversationIdsToAbort,
      );
    }

    // After the transition is ALLOWED (a refused resume must repair nothing)
    // and before the caller drives the loop: resume is the manual retry for a
    // run that may have halted precisely because its artifacts never reached
    // disk, and returning agents to a worktree missing the charter and seeded
    // documents they are pointed at would repeat the failure. A repair failure
    // re-halts the located run and throws, which leaves it reviewable rather
    // than silently unrepaired.
    //
    // Fenced on the run this call committed, never on whoever holds the row by
    // the time it lands (D7 decision D5): the transition is serialized but the
    // repair is a filesystem effect taken after it, so an abandon-plus-relaunch
    // in that window would otherwise write the resumed run's sources into the
    // successor's worktree.
    await repairPendingArtifacts(projectPath, sessionName, nextExecution.id);

    // Re-register execution logger on resume
    const execLogger = createExecutionLogger(nextExecution.id);
    registerExecutionLogger(execLogger);
    execLogger.lifecycle("execution.resumed", {
      previousStatus,
      actor: "operator",
      resolvedHaltType: resumeCapture.resolvedHaltReason?.type ?? null,
      // Not every halt variant carries a contextId (e.g. recovery_error).
      resolvedHaltContextId:
        resumeCapture.resolvedHaltReason !== null &&
        "contextId" in resumeCapture.resolvedHaltReason
          ? (resumeCapture.resolvedHaltReason.contextId ?? null)
          : null,
      hasInterruptedTasks: hasInterrupted,
      resetContextIds: Object.values(nextExecution.contextStates)
        .filter((cs) => cs.status === "ready")
        .map((cs) => cs.contextId),
      // A retired round records `outcome: null`, so the halt→resume pair in
      // lifecycle.jsonl is where an operator reads WHY it ended.
      refilledRoundContextIds,
      retiredRoundContextIds,
    });
    if (mergeRetryContextIds.length > 0) {
      execLogger.lifecycle("resume.merge_retry_scheduled", {
        retryContextIds: mergeRetryContextIds,
      });
      logger.info("graph-workflow.resume.merge_retry_scheduled", {
        executionId: nextExecution.id,
        retryContextIds: mergeRetryContextIds,
      });
    }
    if (resetJoinIds.length > 0) {
      execLogger.lifecycle("resume.join_retry_scheduled", {
        resetJoinIds,
        hasConflictGuidance: (options?.conflictGuidance?.length ?? 0) > 0,
      });
      logger.info("graph-workflow.resume.join_retry_scheduled", {
        executionId: nextExecution.id,
        resetJoinIds,
        hasConflictGuidance: (options?.conflictGuidance?.length ?? 0) > 0,
      });
    }
    logger.info("graph-workflow.execution.resumed", {
      executionId: nextExecution.id,
      previousStatus,
      loopEpoch: nextExecution.loopEpoch,
    });

    return nextExecution;
  }

  /**
   * Settle the artifact debt of whichever execution currently holds the row.
   *
   * Every path that (re)starts driving a run passes through here, because the
   * launch's `.cc` writes are the one part of a start that is NOT covered by
   * the reserving transaction: a crash in between leaves a durable execution
   * whose charter and seeded documents were never written. The repository owns
   * both the durable record of what is owed and the idempotent repair; this is
   * only the kickoff that asks.
   *
   * `expectedExecutionId` narrows "whoever holds the row" to one run, for the
   * callers that mean a particular execution rather than the session: writing a
   * run's sources into the worktree is a filesystem effect, and a caller whose
   * run has already been abandoned and replaced must not take it on the
   * successor.
   */
  async function repairPendingArtifacts(
    projectPath: string,
    sessionName: string,
    expectedExecutionId?: string,
  ): Promise<void> {
    const ensure = deps.executionRepository.ensureArtifactsMaterialized;
    const execution = await deps.executionRepository.getActive(
      projectPath,
      sessionName,
    );
    if (execution === null) return;
    if (
      expectedExecutionId !== undefined &&
      execution.id !== expectedExecutionId
    ) {
      logger.info("graph-workflow.execution.artifact_repair_fenced", {
        projectPath,
        sessionName,
        expectedExecutionId,
        activeExecutionId: execution.id,
      });
      return;
    }
    const repaired = await ensure({
      projectPath,
      sessionName,
      executionId: execution.id,
    });
    if (repaired === null) return;
    logger.info("graph-workflow.execution.artifacts_repaired", {
      projectPath,
      sessionName,
      executionId: execution.id,
    });
  }

  /**
   * `options.expectedExecutionId` fences the whole call on one run.
   *
   * Normalization addresses the SESSION's active row, which is right for the
   * restart sweep that means "whatever is here". A caller that means one
   * particular execution — plan repair normalizing the run it just repaired
   * before resuming it — has to say so: an abandon-plus-relaunch in that window
   * would otherwise let it repair the successor's artifacts and rewrite the
   * successor's running state, which the fenced resume behind it then refuses
   * far too late.
   */
  async function normalizeAfterRestart(
    projectPath: string,
    sessionName: string,
    options?: { expectedExecutionId?: string },
  ): Promise<GraphWorkflowExecution | null> {
    const execution = await deps.executionRepository.getActive(
      projectPath,
      sessionName,
    );
    if (!execution) {
      return null;
    }
    const expectedExecutionId = options?.expectedExecutionId;
    if (
      expectedExecutionId !== undefined &&
      execution.id !== expectedExecutionId
    ) {
      logger.info("graph-workflow.normalize.fenced", {
        projectPath,
        sessionName,
        expectedExecutionId,
        activeExecutionId: execution.id,
      });
      return null;
    }

    // Settled before any status branch, because restart is the only kickoff an
    // ordinary launch ever gets. A launch commits its row as `pending` and
    // writes its `.cc` artifacts after that transaction, so the crash this
    // function exists for strands a run whose charter and seeded documents were
    // never written — and nothing else comes back for it: `resume` refuses a
    // pending run, and approval-gated repair only covers launches that stop for
    // a definition approval. The debt belongs to whoever holds the row, not to
    // one lifecycle state, and settling it is a no-op for a run that owes
    // nothing (the repository has no record to act on).
    await repairPendingArtifacts(projectPath, sessionName, expectedExecutionId);

    // A stranded definition-approval reservation is deliberately NOT swept
    // here. A reservation is taken before the admission consumer is called, so
    // one that outlives its holder may already have that consumer's durable
    // records behind it; freeing it would let a later act end the run and
    // strand those records — the interrupted act would have written and lost.
    // An interrupted decision is finished rather than discarded, which only the
    // act that owns the admission seam can do (see
    // `interruptedDefinitionDecision` and the route layer's settlement).

    if (execution.status !== "running") {
      return execution;
    }

    // If the execution loop is genuinely active in this process, the
    // iteration is still running — skip normalization.
    if (deps.isExecutionLoopActive?.(projectPath, sessionName)) {
      return execution;
    }

    // Probed BEFORE the mutation: reading a branch is I/O and the write queue
    // is not the place for it. Only unlanded commit-mode intents are worth a
    // probe, so an execution that never crashed mid-landing costs nothing.
    const probeTargets = collectLandingProbeTargets(execution);
    const branchEvidence =
      probeTargets.length > 0
        ? await resolveLandingEvidenceProber(deps).probe(probeTargets)
        : undefined;

    const normalized = await deps.executionRepository.mutateActive<
      { normalizedJoinIds: string[]; reconciledIntentContextIds: string[] },
      "superseded"
    >(projectPath, sessionName, (current) => {
      // The probe ran outside the queue. Recheck identity and status so a
      // successor or a run that settled during the probe receives no write.
      if (
        expectedExecutionId !== undefined &&
        current.id !== expectedExecutionId
      ) {
        return refused("superseded");
      }
      if (current.status !== "running") {
        return refused("superseded");
      }

      const normalizedJoinIds: string[] = [];
      const reconciledIntentContextIds: string[] = [];
      const timestamp = getNow(deps);
      const resetRunningJoins = (execution: GraphWorkflowExecution): void => {
        normalizedJoinIds.push(
          ...resetRunningJoinsToPending(execution, timestamp),
        );
      };

      // A crash between a landing and its intent's settlement leaves the
      // intent `pending` over work that is already committed — or over a
      // fan-in merge that failed. Both are decided here from state that
      // outlived the process (decision D8): the join's own record, and the
      // branch evidence probed above. The resumed loop classifies from that
      // durable evidence instead of re-deriving it.
      reconciledIntentContextIds.push(
        ...reconcileLandingIntents(current, {
          now: timestamp,
          branchEvidence,
        }),
      );

      if (current.pendingHaltReason !== null) {
        const haltReason = current.pendingHaltReason;
        const transitioned = transitionToNonRunningState(
          current,
          "halted",
          timestamp,
          haltReason,
        );
        transitioned.pendingHaltReason = null;
        resetRunningJoins(transitioned);
        transitioned.machineSnapshot = buildLifecycleSnapshot(transitioned, {
          lifecycleStatus: "halted",
          recoveryMode: "restart_drain_resumed",
          hasLiveIteration: false,
        });
        return changed(transitioned, {
          normalizedJoinIds,
          reconciledIntentContextIds,
        });
      }

      const nextExecution = transitionToNonRunningState(
        current,
        "paused",
        null,
        null,
      );
      resetRunningJoins(nextExecution);
      nextExecution.machineSnapshot = buildLifecycleSnapshot(nextExecution, {
        lifecycleStatus: "paused",
        recoveryMode: "restart_normalized",
        hasLiveIteration: false,
      });
      return changed(nextExecution, {
        normalizedJoinIds,
        reconciledIntentContextIds,
      });
    });

    // Refused: the run settled itself or the row turned over while the landing
    // probe ran. The caller gets the run as it was read, unnormalized.
    if (normalized.kind === "refused") {
      return expectedExecutionId !== undefined ? null : execution;
    }
    const normalizedExecution = normalized.execution;
    const { normalizedJoinIds, reconciledIntentContextIds } = normalized.value;

    if (reconciledIntentContextIds.length > 0) {
      logger.info("graph-workflow.restart.landing_intents_reconciled", {
        executionId: normalizedExecution.id,
        contextIds: reconciledIntentContextIds,
      });
      getExecutionLogger(normalizedExecution.id)?.lifecycle(
        "restart.landing_intents_reconciled",
        { contextIds: reconciledIntentContextIds },
      );
    }

    if (normalizedJoinIds.length > 0) {
      const execLogger = getExecutionLogger(normalizedExecution.id);
      execLogger?.lifecycle("restart.joins_normalized", {
        joinIds: normalizedJoinIds,
      });
      logger.info("graph-workflow.restart.joins_normalized", {
        executionId: normalizedExecution.id,
        joinIds: normalizedJoinIds,
      });
    }

    if (
      normalizedExecution.status === "halted" &&
      normalizedExecution.haltReason !== null
    ) {
      const execLogger = getExecutionLogger(normalizedExecution.id);
      execLogger?.lifecycle("execution.halted", {
        haltReason: normalizedExecution.haltReason,
        cause: "restart_drain_resumed",
        actor: "system",
      });
      execLogger?.writeManifest(normalizedExecution);
      unregisterExecutionLogger(normalizedExecution.id);
      logger.info("graph-workflow.execution.halted", {
        executionId: normalizedExecution.id,
        haltReasonType: normalizedExecution.haltReason.type,
        cause: "restart_drain_resumed",
      });
    }

    return normalizedExecution;
  }

  async function recoverRetryableIterationError(
    projectPath: string,
    sessionName: string,
    input: GraphWorkflowRetryableIterationErrorInput,
  ): Promise<GraphWorkflowExecution> {
    const now = getNow(deps);

    const { execution: nextExecution, rotationScheduled } =
      await deps.executionRepository
        .mutateActive(projectPath, sessionName, (execution) => {
          let rotationScheduled = false;

          const running = requireRunningExecution(execution);
          const contextState = running.contextStates[input.contextId];
          if (!contextState) {
            throw new Error(
              `Execution context "${input.contextId}" does not exist in runtime state`,
            );
          }

          transitionContextStatus(running, input.contextId, "ready", {
            reason: "manager.recover_retryable_iteration_error",
          });
          if (!running.activeContextIds.includes(input.contextId)) {
            running.activeContextIds = [
              ...running.activeContextIds,
              input.contextId,
            ];
          }
          running.completedAt = null;
          running.haltReason = null;
          running.machineSnapshot = buildLifecycleSnapshot(running, {
            lifecycleStatus: "running",
            recoveryMode: "none",
            hasLiveIteration: false,
          });

          const implementerLane =
            running.laneStates[input.contextId]?.["implementer"];
          rotationScheduled =
            implementerLane?.refKind === "conversation" &&
            implementerLane.contextId === input.contextId;

          if (rotationScheduled && implementerLane) {
            implementerLane.metrics.rotateBeforeNextTurn = true;
            implementerLane.lastUsedAt = now;
          }

          return changed(running, { rotationScheduled });
        })
        .then((mutation) => ({
          execution: mutation.execution,
          ...mutationValue(mutation),
        }));

    const execLogger = getExecutionLogger(nextExecution.id);
    execLogger?.decision("iteration.retryable_error_recovery", {
      contextId: input.contextId,
      error: input.errorMessage,
      rotationScheduled,
    });
    logger.warn("graph-workflow.iteration.retryable_error_recovery", {
      executionId: nextExecution.id,
      contextId: input.contextId,
      error: input.errorMessage,
      rotationScheduled,
    });

    return nextExecution;
  }

  async function recordPendingHaltReason(
    input: RecordPendingHaltReasonInput,
  ): Promise<RecordPendingHaltReasonResult> {
    const { projectPath, sessionName, reason, applyAdditionalMutation } = input;

    const {
      execution: nextExecution,
      rejectedExecutionId,
      rejectedStatus,
      accepted,
    } = await deps.executionRepository
      .mutateActive<{
        rejectedExecutionId: string | null;
        rejectedStatus: GraphWorkflowStatus | null;
        accepted: boolean;
      }>(projectPath, sessionName, (execution) => {
        let accepted = false;
        let rejectedStatus: GraphWorkflowStatus | null = null;
        let rejectedExecutionId: string | null = null;

        if (
          input.expectedExecutionId !== undefined &&
          execution.id !== input.expectedExecutionId
        ) {
          rejectedExecutionId = execution.id;
          return unchanged({ rejectedExecutionId, rejectedStatus, accepted });
        }
        // A pending halt reason is a signal to a running loop's
        // drain-then-halt path. The loop fence rejects writes from a generation
        // retired by pause/halt/abort; this status guard also protects unfenced
        // callers from poisoning suspended state with a late halt signal.
        if (execution.status !== "running") {
          rejectedStatus = execution.status;
          return unchanged({ rejectedExecutionId, rejectedStatus, accepted });
        }
        const next = cloneExecution(execution);
        if (applyAdditionalMutation) {
          applyAdditionalMutation(next);
        }
        if (execution.pendingHaltReason === null) {
          next.pendingHaltReason = reason;
          accepted = true;
        } else if (next.secondaryHaltReasons.length < 10) {
          next.secondaryHaltReasons = [...next.secondaryHaltReasons, reason];
        }
        return changed(next, { rejectedExecutionId, rejectedStatus, accepted });
      })
      .then((mutation) => ({
        execution: mutation.execution,
        ...mutationValue(mutation),
      }));

    if (rejectedExecutionId !== null) {
      logger.warn(
        "graph-workflow.parallel.pending_halt_rejected_execution_mismatch",
        {
          expectedExecutionId: input.expectedExecutionId,
          activeExecutionId: rejectedExecutionId,
          attemptedHaltReasonType: reason.type,
        },
      );
      return { execution: nextExecution, accepted: false };
    }

    if (rejectedStatus !== null) {
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("parallel.pending_halt_rejected_non_running", {
        attemptedHaltReason: reason,
        executionStatus: rejectedStatus,
      });
      logger.warn("graph-workflow.parallel.pending_halt_rejected_non_running", {
        executionId: nextExecution.id,
        attemptedHaltReasonType: reason.type,
        executionStatus: rejectedStatus,
      });
      return { execution: nextExecution, accepted: false };
    }

    if (accepted) {
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("parallel.pending_halt_recorded", {
        haltReason: reason,
      });
      logger.info("graph-workflow.parallel.pending_halt_recorded", {
        executionId: nextExecution.id,
        haltReasonType: reason.type,
      });
    } else {
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("parallel.secondary_failure", {
        attemptedHaltReason: reason,
        existingHaltReason: nextExecution.pendingHaltReason,
      });
      logger.info("graph-workflow.parallel.secondary_failure", {
        executionId: nextExecution.id,
        attemptedHaltReasonType: reason.type,
        existingHaltReasonType: nextExecution.pendingHaltReason?.type ?? null,
      });
    }

    return { execution: nextExecution, accepted };
  }

  async function drainAndHalt(
    input: DrainAndHaltInput,
  ): Promise<GraphWorkflowExecution> {
    const { projectPath, sessionName } = input;
    const now = getNow(deps);

    const mutation = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        if (
          input.expectedExecutionId !== undefined &&
          execution.id !== input.expectedExecutionId
        ) {
          return refused({
            expectedExecutionId: input.expectedExecutionId,
            activeExecutionId: execution.id,
          });
        }
        const haltReason = execution.pendingHaltReason;
        if (haltReason === null) {
          throw new Error(
            "drainAndHalt requires pendingHaltReason to be set before invocation",
          );
        }
        const transitioned = transitionToNonRunningState(
          execution,
          "halted",
          now,
          haltReason,
        );
        transitioned.pendingHaltReason = null;
        return changed(transitioned);
      },
    );
    if (mutation.kind === "refused") {
      logger.warn(
        "graph-workflow.drain_halt.execution_mismatch",
        mutation.refusal,
      );
      throw new Error(
        `Cannot drain execution ${mutation.refusal.expectedExecutionId}: active execution is ${mutation.refusal.activeExecutionId}`,
      );
    }
    const nextExecution = mutation.execution;

    await stopLaneDevServers({ execution: nextExecution, projectPath });

    const execLogger = getExecutionLogger(nextExecution.id);
    execLogger?.lifecycle("execution.halted", {
      haltReason: nextExecution.haltReason,
      cause: "drain_and_halt",
      actor: "system",
    });
    execLogger?.writeManifest(nextExecution);
    unregisterExecutionLogger(nextExecution.id);
    logger.info("graph-workflow.execution.halted", {
      executionId: nextExecution.id,
      haltReasonType: nextExecution.haltReason?.type,
      cause: "drain_and_halt",
    });

    return nextExecution;
  }

  async function hasActive(
    projectPath: string,
    sessionName: string,
  ): Promise<boolean> {
    const execution = await deps.executionRepository.getActive(
      projectPath,
      sessionName,
    );
    return execution !== null;
  }

  async function resetContext(
    projectPath: string,
    sessionName: string,
    contextId: string,
  ): Promise<GraphWorkflowExecution> {
    // Mark every event filed under the context up to the current insertion
    // boundary as pre-reset before the reset write appends its own status-change
    // events, so those new events stay visible post-reset (the old in-memory
    // history.map ran before the reset's appendEvents for the same reason).
    const active = await deps.executionRepository.getActive(
      projectPath,
      sessionName,
    );
    if (active) {
      await deps.executionRepository.markContextEventsPreReset(
        projectPath,
        sessionName,
        active.id,
        contextId,
      );
      // Stop this context's lane dev servers before the reset drops its lane
      // association (resetExecutionContext rebuilds the context's lane state).
      await stopLaneDevServers({
        execution: active,
        projectPath,
        contextIds: [contextId],
      });
      // Reset-intent log emitted BEFORE entering the queue, off the write-queue
      // critical section (`no-slow-work-in-critical-section`).
      logger.info("graph-workflow.context.reset_requested", {
        executionId: active.id,
        contextId,
        status: active.status,
      });
    }

    // The reducer captures the pre-reset status (pure) and returns the reset
    // execution; a rejected reset (ResetExecutionContextError) is logged in the
    // catch below, outside the lock.
    const mutation = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        try {
          return changed(resetExecutionContext(execution, contextId), {
            previousStatus: execution.status,
          });
        } catch (error) {
          if (error instanceof ResetExecutionContextError)
            return refused(error);
          throw error;
        }
      },
    );
    if (mutation.kind === "refused") {
      logger.warn("graph-workflow.context.reset_rejected", {
        executionId: mutation.execution.id,
        contextId,
        status: mutation.execution.status,
        reason: mutation.refusal.message,
      });
      throw mutation.refusal;
    }
    const {
      execution: nextExecution,
      value: { previousStatus },
    } = mutation;

    let execLogger = getExecutionLogger(nextExecution.id);
    if (!execLogger) {
      execLogger = createExecutionLogger(nextExecution.id);
      registerExecutionLogger(execLogger);
    }
    execLogger.lifecycle("context.reset", {
      contextId,
      previousStatus,
    });
    logger.info("graph-workflow.context.reset_applied", {
      executionId: nextExecution.id,
      contextId,
      previousStatus,
    });

    return nextExecution;
  }

  /**
   * Reset ONE validator assignment on a paused or halted execution (R8.3).
   *
   * Narrower than {@link resetContext} by design: the sibling verdicts that
   * judged the same candidate, the implementer's lane, and the context's task
   * state all survive. The reducer is pure, so the two effects it implies —
   * stopping the retired conversation and publishing the withdrawal of a
   * question nobody can answer any more — happen here, post-commit.
   */
  async function resetContextAssignment(
    projectPath: string,
    sessionName: string,
    contextId: string,
    assignmentId: string,
  ): Promise<GraphWorkflowExecution> {
    const mutation = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        try {
          const result = resetExecutionContextAssignment(execution, {
            contextId,
            assignmentId,
          });
          return changed(result.execution, {
            previousStatus: execution.status,
            retiredConversationId: result.retiredConversationId,
            withdrawnQuestion: result.withdrawnQuestion,
          });
        } catch (error) {
          if (error instanceof ResetAssignmentError) return refused(error);
          throw error;
        }
      },
    );
    if (mutation.kind === "refused") {
      logger.warn("graph-workflow.assignment.reset_rejected", {
        executionId: mutation.execution.id,
        contextId,
        assignmentId,
        status: mutation.execution.status,
        reason: mutation.refusal.message,
      });
      throw mutation.refusal;
    }
    const {
      execution: nextExecution,
      value: { previousStatus, retiredConversationId, withdrawnQuestion },
    } = mutation;

    if (retiredConversationId !== null) {
      try {
        deps.retireLaneConversation({
          projectPath,
          sessionName,
          conversationId: retiredConversationId,
        });
      } catch (error) {
        logger.warn("graph-workflow.assignment.retire_lane_failed", {
          executionId: nextExecution.id,
          contextId,
          assignmentId,
          error: getErrorMessage(error),
        });
      }
    }

    if (withdrawnQuestion !== null) {
      const question: { conversationId: string; questionBatchId: string } =
        withdrawnQuestion;
      await clearConversationQuestion(
        projectPath,
        sessionName,
        question.conversationId,
        {
          questionId: question.questionBatchId,
        },
      );
      eventPublisher.deliver(
        eventPublisher.publishUserInputResolved({
          projectPath,
          sessionName,
          execution: nextExecution,
          contextId,
          conversationId: question.conversationId,
          questionBatchId: question.questionBatchId,
          resolution: "withdrawn",
          resolvedAt: getNow(deps),
        }),
      );
    }

    getExecutionLogger(nextExecution.id)?.lifecycle("assignment.reset", {
      contextId,
      assignmentId,
      previousStatus,
    });
    logger.info("graph-workflow.assignment.reset_applied", {
      executionId: nextExecution.id,
      contextId,
      assignmentId,
      retiredConversation: retiredConversationId !== null,
      withdrewQuestion: withdrawnQuestion !== null,
    });

    return nextExecution;
  }

  /**
   * The explicit, audited end of a resumable halt's tenure (D7 decision D5).
   *
   * Admitted for exactly one incumbent: the identified run that still HOLDS the
   * lease as a halt. Everything else already belongs to History — a
   * non-resumable halt and an already-abandoned run are both `halted`, and
   * neither owns anything to release — so the predicate, not the status, is the
   * test. Status and halt reason are deliberately preserved: the run's final
   * engine state is a fact, and the abandonment record is what releases the
   * lease and derives the Abandoned disposition.
   *
   * ONE transaction writes the audit, appends the released boundary event, and
   * relocates the record into History. Stamping the abandonment in a write of
   * its own would release the lease before the boundary was recorded: a crash
   * in between leaves an abandoned run with no boundary event, and a concurrent
   * launch can normalize the now lease-free row into History as
   * `normalized_on_admission` before the relocation this act still owes — after
   * which nothing distinguishes the abandonment from an unattended legacy row,
   * yet the caller was told the act succeeded.
   */
  async function abandon(
    input: AbandonExecutionInput,
  ): Promise<AbandonExecutionResult> {
    const abandonment: GraphWorkflowAbandonment = {
      abandonedAt: getNow(deps),
      actor: input.actor,
      reason: input.reason,
    };
    const outcome = await deps.executionRepository.archiveActive(
      input.projectPath,
      input.sessionName,
      { reason: "abandoned", actor: abandonmentActorAuditLabel(input.actor) },
      // Evaluated inside the archive's critical section against the row as it
      // is there: a concurrent resume or slot turnover between this call and
      // the transaction would otherwise be abandoned in the incumbent's place.
      (execution) =>
        execution.id === input.executionId &&
        execution.status === "halted" &&
        holdsExecutionLease(
          execution.status,
          execution.haltReason,
          execution.abandonment,
        ),
      (execution) => ({ ...execution, abandonment }),
    );

    if (!outcome.archived) {
      const refusal = declineAbandon(input.executionId, outcome);
      logger.warn("graph-workflow.execution.abandon_refused", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: input.executionId,
        reason: refusal.reason,
      });
      return refusal;
    }

    getExecutionLogger(outcome.execution.id)?.lifecycle("execution.abandoned", {
      actor: input.actor.kind,
      reason: input.reason,
    });
    logger.info("graph-workflow.execution.abandoned", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      executionId: outcome.execution.id,
      actor: input.actor.kind,
      haltReasonType: outcome.execution.haltReason?.type ?? null,
    });
    return { ok: true, execution: outcome.execution };
  }

  /**
   * The human's other decision at the definition gate (D7 decision D17): end
   * the parked run instead of admitting it. Addressed by execution identity
   * alone, exactly like the approval it sits beside.
   *
   * The rejection is stamped on the RECORD (`aborted` with cause
   * `definition_rejected`) rather than only on the release audit, because
   * History renders from self-contained execution records — a marker that lived
   * only in the event ledger would leave the archived run indistinguishable
   * from an operator's abort.
   *
   * Relocating the record into History is the caller's audited archive act, for
   * the same reason abandon leaves it there: that step also releases resources
   * the manager does not own.
   */
  async function rejectDefinition(
    input: RejectDefinitionInput,
  ): Promise<RejectDefinitionResult> {
    const active = await deps.executionRepository.getActive(
      input.projectPath,
      input.sessionName,
    );
    if (active === null) {
      return { ok: false, reason: "no_active_execution" };
    }

    const now = getNow(deps);
    const outcome = await deps.executionRepository.mutateActive<
      void,
      Exclude<RejectDefinitionResult, { ok: true }>
    >(input.projectPath, input.sessionName, (execution) => {
      // Re-applied inside the serialized section against the row as it is
      // now: a concurrent approval or launch between the read above and
      // this write would otherwise be rejected in the parked run's place.
      // A race loser must leave the incumbent row and staging fence intact.
      if (execution.id !== input.executionId) {
        return refused({
          ok: false,
          reason: "execution_mismatch",
          activeExecutionId: execution.id,
        });
      }
      if (
        !awaitsDefinitionApproval(
          execution.status,
          execution.definitionApproval,
        )
      ) {
        return refused({
          ok: false,
          reason: "not_awaiting_approval",
          status: execution.status,
        });
      }
      // An approval act is mid-saga on this same park: it has reserved the
      // decision and may already be talking to the admission consumer.
      // Ending the run underneath it would strand that consumer's durable
      // admission on a run this rejection aborted — so the reservation
      // stands whatever its age, and an interrupted one is finished by the
      // route layer's settlement before a rejection is even attempted.
      if (execution.definitionApprovalClaim !== null) {
        return refused({ ok: false, reason: "decision_in_flight" });
      }
      return changed(
        transitionToNonRunningState(execution, "aborted", now, {
          type: "aborted",
          cause: "definition_rejected",
          summary: "A human rejected the definition at the approval gate.",
        }),
      );
    });

    if (outcome.kind === "refused") {
      const refusal = outcome.refusal;
      logger.warn("graph-workflow.definition_rejection.refused", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: input.executionId,
        reason: refusal.reason,
      });
      return refusal;
    }

    const nextExecution = outcome.execution;
    const execLogger = getExecutionLogger(nextExecution.id);
    execLogger?.lifecycle("execution.aborted", { actor: "operator" });
    execLogger?.writeManifest(nextExecution);
    unregisterExecutionLogger(nextExecution.id);
    logger.info("graph-workflow.definition_rejection.recorded", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      executionId: nextExecution.id,
      originKind: nextExecution.origin.kind,
    });
    return { ok: true, execution: nextExecution };
  }

  return {
    start,
    run,
    launchSpecDelivery,
    claimDefinitionApproval,
    releaseDefinitionApprovalClaim,
    recordDefinitionApproval,
    rejectDefinition,
    send,
    resume,
    abandon,
    normalizeAfterRestart,
    recoverRetryableIterationError,
    recordPendingHaltReason,
    drainAndHalt,
    resetContext,
    resetContextAssignment,
    hasActive,
  };
}
