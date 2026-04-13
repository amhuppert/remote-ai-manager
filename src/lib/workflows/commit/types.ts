/**
 * Types for the Smart Commit XState machine.
 *
 * Models the commit pipeline: commit user changes → validate →
 * auto-fix validation errors → re-validate → completed.
 */

import type { BaseWorkflowContext } from "../types";
import type { AgentSessionRef } from "@/lib/agent-backends/types";

/** Phase tracking for SSE broadcast. */
export type CommitPhase =
  | "committing"
  | "validating"
  | "fixing-validation"
  | "re-validating";

/** Machine context for the Smart Commit workflow. */
export interface CommitContext extends BaseWorkflowContext {
  /** Unique job identifier for registry/notification tracking. */
  jobId: string;

  /** The commit message provided by the user. */
  message: string;

  /** Branch being committed to. */
  branchName: string;

  /** Path to the worktree. */
  worktreePath: string;

  /** Current phase for SSE broadcast. */
  phase: CommitPhase | null;

  /** Error message if the workflow failed. */
  error: string | null;

  /** Hash of the user's commit (set after successful commit). */
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
  finalStatus: "completed" | "failed" | null;
}

/** Input required to create a commit workflow actor. */
export interface CommitInput {
  jobId: string;
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  message: string;
  validationTimeoutMs?: number;
  maxFixAttempts?: number;
}

/** Output produced when the machine reaches a terminal state. */
export interface CommitOutput {
  status: "completed" | "failed";
  commitHash: string | null;
  error: string | null;
}
