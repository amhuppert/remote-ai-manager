/**
 * Post-turn step: failure and abort fallback results.
 *
 * Hides the shape of a turn result that carries no adapter-built outcome
 * (dispatch threw, pre-turn validation rejected, or the turn was aborted):
 * all usage fields are null. Callers retain the prior continuation unless an
 * adapter result explicitly declares it unusable.
 * Aborted turns report through `aborted` with `continuationDisposition:
 * "retain"`, never as an error surface.
 */

import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { ContinuationDisposition } from "@/lib/agent-backends/errors";
import type { PromptActorResult } from "../types";

const NULL_USAGE_FIELDS = {
  backendRef: null,
  costUsd: null,
  durationMs: null,
  numTurns: null,
  contextTokens: null,
  contextWindow: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
} as const;

/** Failure result for a turn with no adapter-built outcome. */
export function buildFailedTurnResult(input: {
  contentBlocks: MessageContentBlock[];
  error: string;
  continuationDisposition: ContinuationDisposition;
}): PromptActorResult {
  return {
    ...NULL_USAGE_FIELDS,
    contentBlocks: input.contentBlocks,
    aborted: false,
    compacted: false,
    error: input.error,
    continuationDisposition: input.continuationDisposition,
  };
}

/** Aborted-turn result (user cancel, safety-net timeout, or stall). */
export function buildAbortedTurnResult(input: {
  contentBlocks: MessageContentBlock[];
  timeoutFired: boolean;
  timeoutMs: number;
  stallFired?: boolean;
  stallTimeoutMs?: number;
}): PromptActorResult {
  return {
    ...NULL_USAGE_FIELDS,
    contentBlocks: input.contentBlocks,
    aborted: true,
    compacted: false,
    ...(input.timeoutFired
      ? { abortReason: "timeout" as const, timeoutMs: input.timeoutMs }
      : input.stallFired
        ? {
            abortReason: "stalled" as const,
            timeoutMs: input.stallTimeoutMs ?? 0,
          }
        : {}),
    error: null,
    continuationDisposition: "retain",
  };
}
