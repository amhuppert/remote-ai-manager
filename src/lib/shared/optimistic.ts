import type { ImagePayload } from "@/lib/images/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { executePromptStream } from "../prompt/sdk-driver";
import { dispatchMergeJob } from "../jobs/queue";
import { createNotification } from "../notifications/repo";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "../logging";

const logger = createLogger("optimistic");

/**
 * The optimistic workflow turn enters the AgentCall primitive through the
 * conversation actor: `executePromptStream` ensures the conversation/actor
 * exists and dispatches a SUBMIT_PROMPT event, and the actor's
 * `executePromptForMachine` routes the underlying turn through
 * `executeAgentCall` (Task 6.1 migration).
 *
 * Calling `executeAgentCall` from this orchestrator directly would bypass the
 * conversation lifecycle (transcript writing, single-flight session lock,
 * machine-state transitions) that the optimistic-mode UI surfaces depend on.
 * The chain is asserted via parity tests in
 * `src/lib/workflows/primitives/section-6-3-merge-optimistic-parity.test.ts`.
 */

// No-op emitter for fire-and-forget execution (no SSE client connected)
const noopEmit = () => {};

// ============================================================
// Types
// ============================================================

export interface OptimisticDeps {
  executePromptStream: typeof executePromptStream;
  dispatchMergeJob: typeof dispatchMergeJob;
  createNotification: typeof createNotification;
}

export const defaultOptimisticDeps: OptimisticDeps = {
  executePromptStream,
  dispatchMergeJob,
  createNotification,
};

/**
 * Fire-and-forget orchestrator for optimistic mode sessions.
 *
 * 1. Executes the user's instructions as a prompt via `executePromptStream()`
 * 2. On success, dispatches a smart merge job with auto-resolve
 * 3. On failure, creates a notification with error details
 *
 * This function never throws — all errors are caught and converted to notifications.
 */
export async function executeOptimisticWorkflow(
  params: {
    projectPath: string;
    projectName: string;
    session: SessionState;
    instructions: string;
    images?: ImagePayload[];
    targetWorktreePath?: string;
  },
  deps: OptimisticDeps = defaultOptimisticDeps,
): Promise<void> {
  const {
    projectPath,
    projectName,
    session,
    instructions,
    images,
    targetWorktreePath,
  } = params;
  const conversationId = session.conversations[0]?.id;

  logger.info("optimistic.workflow_start", {
    projectName,
    sessionName: session.sessionName,
    instructionsLength: instructions.length,
  });

  try {
    // Prepend autonomous directive to session objective
    const autonomousSession: SessionState = {
      ...session,
      objective: `Complete the following task autonomously. Do not ask the user any questions. Begin work immediately.\n\n${instructions}`,
    };

    await deps.executePromptStream(
      projectPath,
      autonomousSession,
      instructions,
      noopEmit,
      conversationId,
      undefined,
      images,
      { autonomous: true },
    );

    logger.info("optimistic.prompt_complete", {
      projectName,
      sessionName: session.sessionName,
    });

    // Brief delay to allow state persistence to settle
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Dispatch smart merge with auto-resolve
    deps.dispatchMergeJob({
      projectPath,
      projectName,
      sessionName: session.sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      message: `Optimistic: ${instructions}`,
      autoResolve: true,
      targetBranch: session.targetBranch,
      targetWorktreePath,
    });

    logger.info("optimistic.merge_dispatched", {
      projectName,
      sessionName: session.sessionName,
    });
  } catch (err) {
    logger.error("optimistic.failed", {
      projectName,
      sessionName: session.sessionName,
      error: getErrorMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    try {
      deps.createNotification({
        type: "merge-failed",
        title: "Optimistic task failed",
        message: `Optimistic task "${instructions}" failed: ${getErrorMessage(err)}`,
        projectName,
        sessionName: session.sessionName,
        branchName: session.branchName,
        jobId: "optimistic-" + session.sessionName,
        jobType: "merge",
      });
    } catch {
      // notification creation failed — nothing more we can do
    }
  }
}
