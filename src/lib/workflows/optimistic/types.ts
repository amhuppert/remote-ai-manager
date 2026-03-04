/**
 * Types for the Optimistic Sessions XState machine.
 *
 * The optimistic workflow executes a prompt autonomously and then
 * dispatches a merge job. It's the simplest workflow — used to
 * validate the standard XState pattern.
 */

import type { BaseWorkflowContext } from "../types";
import type { ImagePayload, SessionState } from "@/types";

/** Machine context for the optimistic workflow. */
export interface OptimisticContext extends BaseWorkflowContext {
  /** The instructions to execute. */
  instructions: string;

  /** Optional images attached to the prompt. */
  images: ImagePayload[];

  /** The session state (needed for prompt execution). */
  session: SessionState;

  /** Branch name for merge job dispatch. */
  branchName: string;

  /** Worktree path for merge job dispatch. */
  worktreePath: string;

  /** Error message if the workflow failed. */
  error: string | null;

  /** Conversation ID produced by prompt execution. */
  conversationId: string | null;

  /** Job ID produced by merge dispatch. */
  mergeJobId: string | null;
}

/** Input required to create an optimistic workflow actor. */
export interface OptimisticInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  session: SessionState;
  instructions: string;
  images?: ImagePayload[];
}

/** Events the optimistic machine can receive. */
export type OptimisticEvent = { type: "ABORT" };

/** Output produced when the machine reaches a terminal state. */
export interface OptimisticOutput {
  success: boolean;
  conversationId: string | null;
  mergeJobId: string | null;
  error: string | null;
}
