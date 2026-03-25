/**
 * Actor logic (fromPromise) for the Optimistic Sessions workflow.
 *
 * Each actor wraps an existing function and provides typed input/output
 * for the XState machine to invoke.
 */

import { fromPromise } from "xstate";
import type { ImagePayload, SessionState } from "@/types";

// ============================================================
// Actor Input/Output Types
// ============================================================

export interface ExecutePromptInput {
  projectPath: string;
  session: SessionState;
  instructions: string;
  images: ImagePayload[];
}

export interface ExecutePromptOutput {
  conversationId: string;
}

export interface DispatchMergeInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  instructions: string;
  targetBranch?: string;
  targetWorktreePath?: string;
}

export interface DispatchMergeOutput {
  jobId: string;
}

// ============================================================
// Actor Definitions
// ============================================================

/**
 * Execute a prompt via executePromptStream in autonomous mode.
 * Wraps the existing function from src/lib/prompt.ts.
 */
export const executePrompt = fromPromise<
  ExecutePromptOutput,
  ExecutePromptInput
>(async ({ input }) => {
  // Lazy import to avoid circular dependencies
  const { executePromptStream } = await import("@/lib/prompt");

  const autonomousSession: SessionState = {
    ...input.session,
    objective: `Complete the following task autonomously. Do not ask the user any questions. Begin work immediately.\n\n${input.instructions}`,
  };

  const noopEmit = () => {};
  const conversationId = input.session.conversations[0]?.id;

  const result = await executePromptStream(
    input.projectPath,
    autonomousSession,
    input.instructions,
    noopEmit,
    conversationId,
    undefined,
    input.images.length > 0 ? input.images : undefined,
    { autonomous: true },
  );

  return { conversationId: result.conversationId };
});

/**
 * Dispatch a merge job with auto-resolve.
 * Wraps dispatchMergeJob from src/lib/background-jobs.ts.
 */
export const dispatchMerge = fromPromise<
  DispatchMergeOutput,
  DispatchMergeInput
>(async ({ input }) => {
  const { dispatchMergeJob } = await import("@/lib/background-jobs");

  // Brief delay to allow state persistence to settle (matches existing behavior)
  await new Promise((resolve) => setTimeout(resolve, 500));

  const result = dispatchMergeJob({
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionName: input.sessionName,
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    message: `Optimistic: ${input.instructions}`,
    autoResolve: true,
    targetBranch: input.targetBranch,
    targetWorktreePath: input.targetWorktreePath,
  });

  if (!result.ok) {
    throw new Error(`Merge dispatch failed: ${result.error}`);
  }

  return { jobId: result.value.jobId };
});
