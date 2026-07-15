/**
 * Async debug cleanup verification.
 *
 * When a cleanup_instrumentation turn produces a structured report, the debug
 * workflow — not the conversation machine — cross-checks it against the
 * persisted instrumentation manifest. The machine's finalize branch starts
 * this runner fire-and-forget; the outcome flows back into the machine as a
 * `DEBUG_COMMAND` (`cleanup_verified` / `cleanup_verification_failed`), so
 * the machine needs no dedicated verification state. This function never
 * rejects: any verifier failure is contained as a failed-verification command
 * so the conversation always lands back in a retryable debug state.
 */

import { createLogger } from "@/lib/logging";
import { debugCleanupResultZodSchema } from "@/lib/workflows/conversation/debug-schemas";
import type {
  VerifyCleanupInput,
  VerifyCleanupOutput,
} from "@/lib/workflows/conversation/types";
import type { DebugCommand } from "./commands";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("debug-workflow");

export interface DebugCleanupVerificationDeps {
  verifyCleanup(
    input: VerifyCleanupInput,
    signal?: AbortSignal,
  ): Promise<VerifyCleanupOutput>;
}

async function defaultDeps(): Promise<DebugCleanupVerificationDeps> {
  const { verifyCleanupForMachine } =
    await import("@/lib/workflows/conversation/actor-implementations");
  return { verifyCleanup: verifyCleanupForMachine };
}

export interface DebugCleanupVerificationRequest {
  worktreePath: string;
  conversationId: string;
  /** The cleanup turn's structured output (the agent's cleanup report). */
  structuredOutput: unknown;
  /** Stable identity of the debug session that launched this verification. */
  debugSessionId: string;
  /**
   * The `cleanupVerificationAttempt` current when this verification started.
   * Stamped on the result command so the reducer can reject the result once
   * a newer cleanup attempt supersedes this one.
   */
  attempt: number;
  /** Aborted when the owning debug session exits or is superseded. */
  signal?: AbortSignal;
}

export async function runDebugCleanupVerification(
  request: DebugCleanupVerificationRequest,
  deps?: DebugCleanupVerificationDeps,
): Promise<DebugCommand | null> {
  if (request.signal?.aborted) return null;
  const parsed = debugCleanupResultZodSchema.safeParse(
    request.structuredOutput,
  );
  const cleanup = parsed.success
    ? parsed.data
    : {
        removedInstrumentation: false,
        filesModified: [],
        grepVerificationPassed: false,
        acknowledgesManifestDeletionContract: false,
        notes: "Cleanup payload failed schema validation.",
      };

  try {
    const resolved = deps ?? (await defaultDeps());
    const output = await resolved.verifyCleanup(
      {
        worktreePath: request.worktreePath,
        conversationId: request.conversationId,
        cleanup,
      },
      request.signal,
    );

    if (request.signal?.aborted) return null;

    if (output.ok) {
      logger.info("debug-workflow.cleanup_verified", {
        conversationId: request.conversationId,
        debugSessionId: request.debugSessionId,
        attempt: request.attempt,
      });
      return {
        kind: "cleanup_verified",
        debugSessionId: request.debugSessionId,
        attempt: request.attempt,
      };
    }

    logger.warn("debug-workflow.cleanup_verification_failed", {
      conversationId: request.conversationId,
      debugSessionId: request.debugSessionId,
      attempt: request.attempt,
      failedConditions: output.failedConditions,
      missingFiles: output.missingFiles,
    });
    return {
      kind: "cleanup_verification_failed",
      debugSessionId: request.debugSessionId,
      message: output.remediationPrompt ?? "Cleanup verification failed",
      attempt: request.attempt,
    };
  } catch (err) {
    if (request.signal?.aborted) return null;
    const message = getErrorMessage(err);
    logger.error("debug-workflow.cleanup_verification_errored", {
      conversationId: request.conversationId,
      debugSessionId: request.debugSessionId,
      attempt: request.attempt,
      error: message,
    });
    return {
      kind: "cleanup_verification_failed",
      debugSessionId: request.debugSessionId,
      message: `Cleanup verification failed: ${message}`,
      attempt: request.attempt,
    };
  }
}
