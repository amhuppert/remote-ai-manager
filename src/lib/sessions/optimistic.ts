import type { ImagePayload } from "@/lib/images/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { executePromptStream } from "../prompt/sdk-driver";
import type { dispatchMergeJob } from "../jobs/queue";
import type { createJobNotification } from "../notifications/service";
import type { MergeInitiation as SessionMergeAdmission } from "@/lib/workflows/merge/initiation";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "../logging";

const logger = createLogger("optimistic");

/**
 * The optimistic workflow turn enters through `executePromptStream`, which
 * hands it to whichever engine runs the conversation (the conversation core or
 * the conversation actor), so the turn keeps that conversation's lifecycle:
 * transcript, single-flight admission and the state the optimistic-mode UI
 * shows. Calling an agent directly from this orchestrator would bypass it. The
 * chain is asserted via the wire-contract tests in
 * `src/lib/workflows/primitives/status-bus-wire-contract.test.ts`.
 */

// No-op emitter for fire-and-forget execution (no SSE client connected)
const noopEmit = () => {};

// ============================================================
// Types
// ============================================================

export interface OptimisticDeps {
  executePromptStream: typeof executePromptStream;
  dispatchMergeJob: typeof dispatchMergeJob;
  createNotification: typeof createJobNotification;
  sleep(ms: number): Promise<void>;
  /** Whether the session's merge may start; see the merge-admission module. */
  evaluateSessionMergeAdmission(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<SessionMergeAdmission>;
}

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
  },
  deps: OptimisticDeps,
): Promise<void> {
  const { projectPath, projectName, session, instructions, images } = params;
  const conversationId = session.conversations[0]?.id;

  logger.info("optimistic.workflow_start", {
    projectName,
    sessionName: session.sessionName,
    instructionsLength: instructions.length,
  });

  try {
    // The autonomous directive rides on the kickoff prompt: the optimistic
    // instructions ARE the prompt.
    const autonomousPrompt = `Complete the following task autonomously. Do not ask the user any questions. Begin work immediately.\n\n${instructions}`;

    const kickoff = await deps.executePromptStream(
      projectPath,
      session,
      autonomousPrompt,
      noopEmit,
      conversationId,
      undefined,
      images,
      { autonomous: true },
    );
    // A turn that was refused, failed or stopped left nothing to merge as finished work.
    if (kickoff.error || kickoff.aborted === true)
      throw new Error(
        kickoff.error ??
          `The task's turn was stopped (${kickoff.abortReason ?? "unknown reason"})`,
      );

    logger.info("optimistic.prompt_complete", {
      projectName,
      sessionName: session.sessionName,
    });

    // Brief delay to allow state persistence to settle
    await deps.sleep(500);

    // The publish would refuse under the project lock anyway; asking here keeps
    // an optimistic run from spending a whole merge pipeline on the answer.
    const admission = await deps.evaluateSessionMergeAdmission({
      projectPath,
      sessionName: session.sessionName,
    });
    if (!admission.admitted) {
      deps.createNotification({
        type: "merge-failed",
        title: "Optimistic merge not dispatched",
        message: `Optimistic task "${instructions}" finished but its merge was not dispatched: ${admission.refusal.message}`,
        projectName,
        sessionName: session.sessionName,
        branchName: session.branchName,
        jobId: "optimistic-" + session.sessionName,
        jobType: "merge",
      });
      return;
    }

    // Dispatch smart merge with auto-resolve
    const merge = deps.dispatchMergeJob({
      projectPath,
      projectName,
      sessionName: session.sessionName,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      message: `Optimistic: ${instructions}`,
      autoResolve: true,
      targetBranch: session.targetBranch,
    });

    if (!merge.ok) {
      const reason =
        typeof merge.error === "string"
          ? merge.error
          : `${merge.error.reason} ${merge.error.instruction}`;
      logger.warn("optimistic.merge_dispatch_refused", {
        projectName,
        sessionName: session.sessionName,
        reason,
      });
      deps.createNotification({
        type: "merge-failed",
        title: "Optimistic merge not dispatched",
        message: `Optimistic task "${instructions}" finished but its merge was not dispatched: ${reason}`,
        projectName,
        sessionName: session.sessionName,
        branchName: session.branchName,
        jobId: "optimistic-" + session.sessionName,
        jobType: "merge",
      });
      return;
    }

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
