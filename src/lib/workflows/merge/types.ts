/**
 * Types for the Smart Merge XState machine.
 *
 * Models the full merge pipeline: commit uncommitted → merge main →
 * detect/resolve conflicts → validate → fix validation → squash merge.
 */

import type { BaseWorkflowContext } from "../types";
import type { ConflictEntry, ConflictDecisionInput } from "@/lib/jobs/schemas";
import type { AgentSessionRef } from "@/lib/agent-backends/types";

/** Phase tracking for SSE broadcast. */
export type MergePhase =
  | "committing-uncommitted"
  | "merging-main"
  | "analyzing-conflicts"
  | "resolving-conflicts"
  | "validating"
  | "fixing-validation"
  | "re-validating"
  | "squash-merging";

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

  /** Session ref from the fix agent, used to resume the conversation on retry. */
  fixSessionRef: AgentSessionRef | null;

  /** Explicit terminal status set by final state entry actions. */
  finalStatus: "completed" | "failed" | "conflicts" | null;

  /** Target branch for merge operations (default "main"). */
  targetBranch: string;

  /** Parent worktree path for non-main squash merges (null when targeting main). */
  targetWorktreePath: string | null;
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
  decisions?: ConflictDecisionInput[];
  validationTimeoutMs?: number;
  maxFixAttempts?: number;
  targetBranch?: string;
  targetWorktreePath?: string;
}

/** Events the merge machine can receive. */
export type MergeEvent = { type: "ABORT" };

/** Output produced when the machine reaches a terminal state. */
export interface MergeOutput {
  status: "completed" | "failed" | "conflicts";
  mergeHash: string | null;
  commitHash: string | null;
  error: string | null;
  conflictFiles: string[];
  conflictAnalysis: ConflictEntry[] | null;
}
