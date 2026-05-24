/**
 * Shared utilities for the asymmetric collaboration slice.
 *
 * These are pure or near-pure helpers that the orchestrator (`envelope.ts`)
 * and the phase files (`initial-draft.ts`, `cross-review.ts`,
 * `counter-proposal.ts`, `resolution.ts`) all consume. Lifting them here
 * keeps the phase files from reaching back into `envelope.ts` for utility
 * code; the orchestrator-state mutation entry points (`failRun`,
 * `persistArtifactsSnapshot`, `finalizeFinal`) stay in `envelope.ts`
 * because they depend on private orchestration glue.
 */

import { getErrorMessage } from "@/lib/shared/errors";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type {
  AsymmetricCollaborationSliceDeps,
  AsymmetricCollaborationSliceInput,
} from "./envelope";
import type { BuiltCollaborationPrompt } from "./prompt-builders";
import type {
  CollaborationAgent,
  CollaborationArtifact,
  CollaborationFlowAgent,
} from "./types";

export interface ArtifactTracker {
  artifacts: CollaborationArtifact[];
  negotiationRoundsCompleted: number;
}

export function trackArtifact(
  tracker: ArtifactTracker,
  artifact: CollaborationArtifact,
): void {
  tracker.artifacts.push(artifact);
}

// ============================================================
// Structured-output parser.
// ============================================================

export type ParseSuccess<T> = { success: true; value: T };
export type ParseFailure = { success: false; error: string };
export type ParseOutcome<T> = ParseSuccess<T> | ParseFailure;

export interface ParseSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: {
          issues: ReadonlyArray<{
            path: ReadonlyArray<unknown>;
            message: string;
          }>;
        };
      };
}

export function parseStructured<T>(
  artifactKind: string,
  flowAgent: CollaborationFlowAgent,
  result: AgentCallResult,
  schema: ParseSchema<T>,
): ParseOutcome<T> {
  if (result.outcome.kind !== "completed") {
    return {
      success: false,
      error: `${artifactKind} (${flowAgent}) did not complete (outcome=${result.outcome.kind})`,
    };
  }
  const parsed = schema.safeParse(result.outcome.structuredOutput);
  if (parsed.success) {
    return { success: true, value: parsed.data };
  }
  const summary = parsed.error.issues
    .map((i) => `${(i.path.join(".") || "$") as string}: ${i.message}`)
    .join("; ");
  return {
    success: false,
    error: `${artifactKind} (${flowAgent}) schema_validation: ${summary}`,
  };
}

// ============================================================
// AgentCall facade with lane scheduling and structured-output parse.
// ============================================================

export interface CallPrimitiveContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  flowAgent: CollaborationFlowAgent;
  backend: CollaborationAgent;
  prompt: BuiltCollaborationPrompt;
  /**
   * Defaults to `write_capable`. Use `read_only` for planning calls that
   * emit structured output without modifying the worktree — `read_only`
   * lets the lane scheduler bypass the per-session write lock so multiple
   * agents can run in parallel.
   */
  writeCapability?: "read_only" | "write_capable";
}

export type CallPrimitiveOutcome =
  | { kind: "ok"; result: AgentCallResult }
  | { kind: "failed"; errorSummary: string };

export async function callPrimitive(
  ctx: CallPrimitiveContext,
): Promise<CallPrimitiveOutcome> {
  const { input, deps, backend, prompt } = ctx;
  const writeCapability = ctx.writeCapability ?? "write_capable";
  const laneRef = { workflowId: input.workflowId, laneId: backend };
  const request: AgentCallRequest =
    backend === "claude"
      ? {
          kind: "conversation_turn",
          backend: "claude",
          prompt: prompt.prompt,
          laneRef,
          writeCapability,
          outputSchema: prompt.outputSchema,
        }
      : {
          kind: "task_run",
          backend: "codex",
          prompt: prompt.prompt,
          laneRef,
          writeCapability,
          outputSchema: prompt.outputSchema,
        };

  let result: AgentCallResult;
  try {
    result = await deps.laneScheduler.schedule(
      {
        sessionKey: input.sessionKey,
        writeCapability,
        workflowId: input.workflowId,
        laneId: backend,
      },
      () => deps.callAgent(request),
    );
  } catch (err) {
    return { kind: "failed", errorSummary: getErrorMessage(err) };
  }

  if (result.outcome.kind === "failed") {
    return {
      kind: "failed",
      errorSummary: `${result.outcome.error.failureKind}: ${result.outcome.error.message}`,
    };
  }
  if (result.outcome.kind === "paused") {
    return {
      kind: "failed",
      errorSummary: `unexpected pause from lane (pauseKind=${result.outcome.pauseKind}, resumeToken=${result.outcome.resumeToken})`,
    };
  }

  await deps.laneService.recordOutcome(
    laneRef,
    backend === "claude"
      ? {
          backend: "claude",
          ...(result.backendRef && result.backendRef.backend === "claude"
            ? { conversationId: result.backendRef.sessionId }
            : {}),
        }
      : {
          backend: "codex",
          ...(result.backendRef && result.backendRef.backend === "codex"
            ? { threadId: result.backendRef.threadId }
            : {}),
        },
  );

  return { kind: "ok", result };
}
