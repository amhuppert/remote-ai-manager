/**
 * Types for the Smart Merge XState machine.
 *
 * Models the full merge pipeline: commit uncommitted → merge main →
 * detect/resolve conflicts → validate → fix validation → squash merge.
 */

import type { BaseWorkflowContext } from "../types";
import type {
  ConflictEntry,
  ConflictDecisionInput,
  MergeHaltReason as PersistedMergeHaltReason,
} from "@/lib/jobs/schemas";
import type { AgentFailureClassification } from "@/lib/agent-backends/errors";
import type { AgentTurnDispatch } from "@/lib/workflows/conversation/execute-fresh-task-run";
import type {
  MergeValidationMode,
  ValidationWorkflowRef,
} from "@/lib/workflows/validation-fix/types";

export interface CriterionOutcome {
  criterionId: string;
  criterionHandle: string;
  outcome: string;
  reason?: string;
  automated?: string[];
}

export interface CandidateValidationFact {
  validationRef: string;
  validatedSha: string;
  validatedTreeHash: string;
  commandIdentity: string;
  outcome: "pass" | "fail";
}

export interface DeliveryGateEvaluateInput {
  workflowExecutionId?: string;
  specExecutionId?: string;
  readOnly?: boolean;
  preparedSha: string;
  expectedTargetSha: string;
  projectPath: string;
  candidateValidation?: CandidateValidationFact;
}

/**
 * Where the halted run's human remedy lives: the owning spec's Studio page.
 * Set on every spec-linked delivery-gate refusal so halt surfaces can deep
 * link to the spec's Controls view (`?el=delivery`).
 */
export interface DeliveryGateSpecPresentation {
  specSlug: string;
  specName: string;
  projectName: string;
}

export type DeliveryGateEvaluation =
  | {
      status: "pass";
      satisfied: CriterionOutcome[];
      deferred: string[];
    }
  | {
      status: "refused";
      unmet: CriterionOutcome[];
      satisfied?: CriterionOutcome[];
      instruction: string;
      /**
       * Present only when the refusal is the delivery gate waiting on a human
       * delivery approval — the one refusal a Studio approval clears.
       */
      refusalCode?: "approval_required";
      spec?: DeliveryGateSpecPresentation;
    };

export interface DeliveryGateEvaluator {
  evaluate(input: DeliveryGateEvaluateInput): Promise<DeliveryGateEvaluation>;
}

export interface DeliveryGateHaltReason {
  type: "delivery_gate_failed";
  unmet: CriterionOutcome[];
  instruction: string;
  /** See {@link DeliveryGateEvaluation}'s refused branch. */
  refusalCode?: "approval_required";
  spec?: DeliveryGateSpecPresentation;
}

/**
 * The conflict resolver could not run to a verdict: the turn failed on the
 * backend (quota, transport), was aborted, timed out, or produced nothing
 * schema-valid. Distinct from a delivery-gate refusal, which is a decision
 * about work that did happen. `conflictFiles` is the merge's context — the
 * files nothing examined — so a halt surface can say what was pending without
 * attributing the failure to their content.
 */
export interface ResolutionInfrastructureHaltReason {
  type: "resolution_infrastructure";
  failure: AgentFailureClassification;
  conflictFiles: string[];
}

/** Every machine-readable refusal a merge run can terminate with. */
export type MergeHaltReason =
  | DeliveryGateHaltReason
  | ResolutionInfrastructureHaltReason;

/**
 * Compile-level drift guard (do not export): the merge-domain interface above
 * and the persisted Zod shape in `@/lib/jobs/schemas` carry the same halt
 * payload across three contracts (evaluation, machine context/output, SSE +
 * runtime_json rows). The constraint chain compiles only while the two types
 * stay mutually assignable, so extending one without the other is a type
 * error here rather than a silently dropped field at the boundary.
 */
type MutuallyAssignable<A extends B, B extends C, C = A> = [A, B, C];
type _MergeHaltReasonSchemaParity = MutuallyAssignable<
  MergeHaltReason,
  PersistedMergeHaltReason
>;
// Reference the guard so it is not an unused type alias.
/** @public */
export type { _MergeHaltReasonSchemaParity as MergeHaltReasonSchemaParity };

/** Phase tracking for SSE broadcast. */
export type MergePhase =
  | "committing-uncommitted"
  | "merging-main"
  | "analyzing-conflicts"
  | "resolving-conflicts"
  | "validating"
  | "fixing-validation"
  | "re-validating"
  | "preparing"
  | "publishing"
  | "awaiting-land";

/** Entry mode controlling which branch of the machine runs at start. */
export type MergeEntryMode = "merge" | "land" | "discard";

/**
 * What the machine may do with a worktree it finds mid-merge with conflicts
 * still unresolved.
 *
 * `"abort"` belongs to machinery re-entering a tree its own earlier run left
 * behind (graph joins and fan-in merges); `"refuse"` belongs to every
 * user-driven dispatch, where the unfinished merge may be a human's and
 * discarding it without consent would destroy their work. Neither policy may
 * abort a merge whose conflicts are already resolved — see the machine's
 * `classifyingWorktree` routing.
 */
export type StaleMergePolicy = "refuse" | "abort";

/** Machine context for the Smart Merge workflow. */
export interface MergeContext extends BaseWorkflowContext {
  /** Unique job identifier for registry/notification tracking. */
  jobId: string;

  /** The merge commit message. */
  message: string;

  /** Branch being merged. */
  branchName: string;

  /** Path to the worktree. */
  worktreePath: string;

  /** Which merge-family job this run is. Smart Commit is a separate machine. */
  jobType: "merge" | "resolve-conflicts";

  /**
   * Conversation the conflict-resolution / analysis / validation-fix agent
   * turns bind to. Graph joins pass the source lane's implementer
   * conversation — in a parallel workflow the session's most-recently-active
   * conversation can belong to a different lane bound to a different
   * worktree, which would dispatch the agent into the wrong tree. Null falls
   * back to the session's most-recently-active conversation (user-driven
   * Smart Merge, where every conversation shares the session worktree).
   */
  conversationId: string | null;

  /**
   * How every merge agent sub-turn (validation fixes, conflict analysis and
   * resolution) executes; see {@link AgentTurnDispatch}. Null means
   * `conversation` (the user-driven hosts). Graph joins pass `fresh-run`.
   */
  agentTurnDispatch: AgentTurnDispatch | null;

  /** Whether to auto-resolve conflicts via Claude. */
  autoResolve: boolean;

  /**
   * Whether a validation failure dispatches the fix agent. Independent of
   * `autoResolve` because the two answer different questions: a re-entry that
   * resumes a merge's conflicts carries no conflict-resolution mandate of its
   * own, yet it still owes the merge it resumes the fix loop that merge had.
   */
  autoFixValidation: boolean;

  /** Whether to use squash merge. */
  squashMerge: boolean;

  /** How a stale unresolved merge in the worktree is handled at entry. */
  staleMergePolicy: StaleMergePolicy;

  /**
   * Conflict files detected during merge. Seeded from the input on a
   * resolve-conflicts re-entry, whose own run never sees the merge that
   * produced them but must still verify they came back marker-free.
   */
  conflictFiles: string[];

  /**
   * Whether this run ran the merge command in the worktree, and so owns
   * whatever unconcluded merge is found there. A `resolve-conflicts` re-entry
   * never does: it resumes a merge an earlier run opened, which it may finish
   * but not discard.
   */
  openedMerge: boolean;

  /** Conflict analysis from resolution. */
  conflictAnalysis: ConflictEntry[] | null;

  /** User decisions for conflict resolution (when provided). */
  decisions: ConflictDecisionInput[] | null;

  /**
   * Intent notes about the changes on each side of the merge, written by the
   * agents that implemented them. Injected into the conflict resolver's and
   * analyzer's prompts so they understand intent instead of inferring it from
   * conflict markers alone.
   */
  resolutionContext: string | null;

  /** Current phase for SSE broadcast. */
  phase: MergePhase | null;

  /** Error message if the workflow failed. */
  error: string | null;

  /** Final merge hash (set on successful squash merge). */
  mergeHash: string | null;

  /** Final commit hash (set on successful commit). */
  commitHash: string | null;

  /** Pre-merge validation timeout in ms. */
  validationTimeoutMs: number;

  /**
   * Wall-clock bound on each conflict resolution/analysis turn. Null takes the
   * resolver module's own default (`DEFAULT_RESOLUTION_TIMEOUT_MS`), which
   * owns the number — the merge only carries an override.
   */
  resolutionTimeoutMs: number | null;

  /** Per-run validation policy supplied by the owning merge surface. */
  validationMode: MergeValidationMode;

  /** Current fix attempt (0 = not started, incremented on each fixingValidation entry). */
  fixAttempt: number;

  /** Maximum number of fix attempts before giving up (default 2). */
  maxFixAttempts: number;

  /** Explicit terminal status set by final state entry actions. */
  finalStatus:
    | "completed"
    | "failed"
    | "conflicts"
    | "ready-to-land"
    | "discarded"
    | null;

  /** Target branch for merge operations (default "main"). */
  targetBranch: string;

  /** Whether the machine is running a merge, a Land, or a Discard. */
  entryMode: MergeEntryMode;

  /**
   * The prepare found the target already holding everything the branch
   * carries. The run still goes through the delivery gate and the publish step
   * — a no-op merge is a merge the operator asked for, and it finishes the
   * session — but no commit is created and the target ref never moves.
   */
  upToDate: boolean;

  /** Prepared (but not yet published) squash commit SHA. */
  preparedSha: string | null;

  /** Target branch tip captured immediately before prepareSquashMerge — used for CAS. */
  expectedTargetSha: string | null;

  /** Ref under refs/cc-merges/ where the prepared commit is parked. */
  parkedRef: string | null;

  /** Best-effort warning when refreshing target or session worktrees failed after CAS. */
  refreshWarning: string | null;

  /**
   * An operator stop that arrived while the publish was in flight. The publish
   * itself cannot be recalled, so the request is held until the run reaches a
   * point where stopping still means something (a lost CAS, which would
   * otherwise re-prepare and publish minutes after the stop was accepted).
   */
  abortRequested: boolean;

  /** Current CAS attempt number (1-based; incremented on each re-prepare). */
  casAttempt: number;

  /** Maximum number of CAS attempts before giving up (default 3). */
  maxCasAttempts: number;

  /**
   * Whether the publish step should also run session finalization
   * (setSessionFinished + dev-server stop + retargetOrphanedChildren).
   * False for graph fan-in publishes; true for user-driven Smart Merge.
   * Defaults to true via MergeInput. skipMarkMerged suppresses the cleanup
   * while retaining the session delivery gate and published merge ancestry.
   */
  finalizeSessionOnPublish: boolean;
  /** Skip completion bookkeeping while retaining session delivery exclusion. */
  skipMarkMerged: boolean;

  /** Workflow execution linkage used by the injected delivery gate. */
  executionId: string | null;
  specExecutionId: string | null;

  /** Workflow attribution stamped on graph-owned validation ledger rows. */
  validationWorkflow: ValidationWorkflowRef | null;

  /** Validation result for the candidate prepared by this merge job. */
  candidateValidation: CandidateValidationFact | null;

  /** Machine-readable refusal emitted when a terminal state carries one. */
  haltReason: MergeHaltReason | null;

  /**
   * Classification of the infrastructure failure that stopped the conflict
   * resolver before it reached a verdict. Null when no resolver turn failed
   * that way — a content-level unresolved conflict leaves it null.
   */
  resolutionFailure: AgentFailureClassification | null;
}

/** Input required to create a merge workflow actor. */
export interface MergeInput {
  jobId: string;
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  message: string;
  autoResolve: boolean;
  /** Defaults to `autoResolve`; see {@link MergeContext.autoFixValidation}. */
  autoFixValidation?: boolean;
  jobType?: "merge" | "resolve-conflicts";
  /** See {@link MergeContext.conversationId}. */
  conversationId?: string;
  /** See {@link MergeContext.agentTurnDispatch}. */
  agentTurnDispatch?: AgentTurnDispatch;
  /** Defaults to "refuse"; see {@link StaleMergePolicy}. */
  staleMergePolicy?: StaleMergePolicy;
  /** Files the merge being resumed reported as conflicted. */
  conflictFiles?: string[];
  decisions?: ConflictDecisionInput[];
  /** See {@link MergeContext.resolutionContext}. */
  resolutionContext?: string;
  /** Explicit per-run validation behavior selected by the owning surface. */
  validationMode: MergeValidationMode;
  validationTimeoutMs?: number;
  /** See {@link MergeContext.resolutionTimeoutMs}. */
  resolutionTimeoutMs?: number;
  maxFixAttempts?: number;
  targetBranch?: string;
  /** Defaults to "merge". "land"/"discard" enter the machine on a parked prepared commit. */
  entryMode?: MergeEntryMode;
  /** Required when entryMode is "land" or "discard". */
  preparedSha?: string;
  /** Required when entryMode is "land" (used for CAS); ignored otherwise. */
  expectedTargetSha?: string;
  /** Required when entryMode is "land" or "discard". */
  parkedRef?: string;
  maxCasAttempts?: number;
  /** Defaults to true; graph fan-in passes false so it doesn't finalize the session. */
  finalizeSessionOnPublish?: boolean;
  skipMarkMerged?: boolean;
  /** Workflow execution linkage for delivery-gate evaluation. */
  executionId?: string;
  specExecutionId?: string;
  /** Workflow attribution for validation accounting; independent of delivery. */
  validationWorkflow?: ValidationWorkflowRef;
  /** This completed merge closes the workflow's final publish join. */
  finalPublish?: boolean;
  /** Persisted validation fact supplied to the delivery-gate evaluator. */
  candidateValidation?: CandidateValidationFact;
}

/** Events the merge machine can receive. */
export type MergeEvent = { type: "ABORT" };

/** Output produced when the machine reaches a terminal state. */
export interface MergeOutput {
  status: "completed" | "failed" | "conflicts" | "ready-to-land" | "discarded";
  mergeHash: string | null;
  /**
   * The prepare found nothing to merge — see {@link MergeContext.upToDate}. A
   * `completed` run with this set published no commit, so `mergeHash` is null.
   * Absent on outputs built outside the machine, which are ordinary merges.
   */
  upToDate?: boolean;
  commitHash: string | null;
  error: string | null;
  conflictFiles: string[];
  conflictAnalysis: ConflictEntry[] | null;
  preparedSha: string | null;
  expectedTargetSha: string | null;
  parkedRef: string | null;
  refreshWarning: string | null;
  candidateValidation: CandidateValidationFact | null;
  haltReason: MergeHaltReason | null;
  /**
   * Phase to retain on the terminal job record. Null for terminal statuses
   * that clear phase (completed/failed/conflicts/discarded); "awaiting-land"
   * for ready-to-land.
   */
  phase: MergePhase | null;
}
