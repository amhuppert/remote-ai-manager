/**
 * Types for the Smart Merge XState machine.
 *
 * Models the full merge pipeline: commit uncommitted → merge main →
 * detect/resolve conflicts → validate → fix validation → squash merge.
 */

import type { BaseWorkflowContext } from "../types";
import type { ConflictEntry, ConflictDecisionInput } from "@/lib/jobs/schemas";

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

  /** Job type (merge, commit, or resolve-conflicts). */
  jobType: "merge" | "commit" | "resolve-conflicts";

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

  /** Whether to auto-resolve conflicts via Claude. */
  autoResolve: boolean;

  /** Whether to use squash merge. */
  squashMerge: boolean;

  /** Conflict files detected during merge. */
  conflictFiles: string[];

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

  /** Parent worktree path for non-main squash merges (null when targeting main). */
  targetWorktreePath: string | null;

  /** Whether the machine is running a merge, a Land, or a Discard. */
  entryMode: MergeEntryMode;

  /** Prepared (but not yet published) squash commit SHA. */
  preparedSha: string | null;

  /** Target branch tip captured immediately before prepareSquashMerge — used for CAS. */
  expectedTargetSha: string | null;

  /** Ref under refs/cc-merges/ where the prepared commit is parked. */
  parkedRef: string | null;

  /** Best-effort warning when refreshing the target worktree failed after CAS. */
  refreshWarning: string | null;

  /** Current CAS attempt number (1-based; incremented on each re-prepare). */
  casAttempt: number;

  /** Maximum number of CAS attempts before giving up (default 3). */
  maxCasAttempts: number;

  /**
   * Whether the publish step should also run session finalization
   * (setSessionFinished + dev-server stop + retargetOrphanedChildren).
   * False for graph fan-in publishes; true for user-driven Smart Merge.
   * Defaults to true via MergeInput.
   */
  finalizeSessionOnPublish: boolean;
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
  jobType?: "merge" | "commit" | "resolve-conflicts";
  /** See {@link MergeContext.conversationId}. */
  conversationId?: string;
  decisions?: ConflictDecisionInput[];
  /** See {@link MergeContext.resolutionContext}. */
  resolutionContext?: string;
  validationTimeoutMs?: number;
  maxFixAttempts?: number;
  targetBranch?: string;
  targetWorktreePath?: string;
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
}

/** Events the merge machine can receive. */
export type MergeEvent = { type: "ABORT" };

/** Output produced when the machine reaches a terminal state. */
export interface MergeOutput {
  status: "completed" | "failed" | "conflicts" | "ready-to-land" | "discarded";
  mergeHash: string | null;
  commitHash: string | null;
  error: string | null;
  conflictFiles: string[];
  conflictAnalysis: ConflictEntry[] | null;
  preparedSha: string | null;
  expectedTargetSha: string | null;
  parkedRef: string | null;
  refreshWarning: string | null;
  /**
   * Phase to retain on the terminal job record. Null for terminal statuses
   * that clear phase (completed/failed/conflicts/discarded); "awaiting-land"
   * for ready-to-land.
   */
  phase: string | null;
}
