/**
 * Types for the Rebase XState machine.
 *
 * Models replaying a session branch onto another branch with automatic,
 * per-commit conflict resolution:
 *
 *   verify branch → check clean → resolve onto → rebase
 *     → (conflicts) resolve → continue → …loop… → completed
 *     → (resolution fails / too many rounds) abort → failed
 *
 * Unlike Smart Merge, nothing here lands into or otherwise touches the target
 * branch — a rebase only rewrites the session branch's own history.
 */

import type { BaseWorkflowContext } from "../types";
import type { RebaseOnto } from "@/lib/git/rebase";

/** Phase tracking for SSE broadcast. */
export type RebasePhase =
  | "checking-branch"
  | "checking-clean"
  | "resolving-onto"
  | "rebasing"
  | "resolving-conflicts"
  | "continuing"
  | "aborting";

/** Machine context for the Rebase workflow. */
export interface RebaseContext extends BaseWorkflowContext {
  /** Unique job identifier for registry/notification tracking. */
  jobId: string;

  /** Branch being rebased (the session branch). */
  branchName: string;

  /** Path to the session worktree. */
  worktreePath: string;

  /**
   * Conversation the conflict-resolution agent turns bind to. Null falls back
   * to the session's most-recently-active conversation (user-driven rebase,
   * where every conversation shares the session worktree).
   */
  conversationId: string | null;

  /** Where to replay the session's commits onto (parsed from `/rebase` args). */
  onto: RebaseOnto;

  /** Concrete ref handed to `git rebase`, resolved from {@link onto}. */
  ontoRef: string | null;

  /** Human label for the target (`main` / `origin/main`) for notices and logs. */
  ontoLabel: string | null;

  /** Files reported as conflicted by the current rebase step. */
  conflictFiles: string[];

  /**
   * Number of resolve rounds attempted. Bounds the resolve/continue loop: a
   * rebase conflicts once per replayed commit, so a healthy loop advances every
   * round; the cap stops a pathological non-advancing loop.
   */
  conflictRound: number;

  /** Maximum resolve rounds before aborting (default 50). */
  maxConflictRounds: number;

  /** Current phase for SSE broadcast. */
  phase: RebasePhase | null;

  /** Error message if the workflow failed. */
  error: string | null;

  /** Explicit terminal status set by final state entry actions. */
  finalStatus: "completed" | "failed" | null;
}

/** Input required to create a rebase workflow actor. */
export interface RebaseInput {
  jobId: string;
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  onto: RebaseOnto;
  /** See {@link RebaseContext.conversationId}. */
  conversationId?: string;
  maxConflictRounds?: number;
}

/** Events the rebase machine can receive. */
export type RebaseEvent = { type: "ABORT" };

/** Output produced when the machine reaches a terminal state. */
export interface RebaseOutput {
  status: "completed" | "failed";
  error: string | null;
  conflictFiles: string[];
  /** The resolved target label, for the terminal notification. */
  ontoLabel: string | null;
  phase: string | null;
}
