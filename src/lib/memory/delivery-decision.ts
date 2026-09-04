import type { MemoryIndexDeliveryKind } from "./schemas";

export interface MemoryIndexDeliveryDecisionInput {
  readonly hasDeliveryState: boolean;
  readonly runtimeCreatedWithoutResume: boolean;
  readonly backendReportedCompactionLastTurn: boolean;
}

export interface MemoryIndexDeliveryDecision {
  readonly mode: MemoryIndexDeliveryKind;
  readonly reset: boolean;
}

/**
 * The runtime-continuity half of the context-loss signal (D4), owned HERE
 * because two callers ask it and they must not disagree: the turn seam, which
 * is about to create the runtime, and the index preview, which claims to print
 * the block that turn will inject.
 *
 * A conversation that has never completed a turn is not CONTINUING — its first
 * block is full anyway — and a stored resume handle means the new runtime picks
 * up where the old one left off. Neither is a context loss. The handle is only
 * ever tested for presence; its shape belongs to the owning backend adapter.
 */
export interface MemoryRuntimeContinuityInput {
  /** The next turn has no live runtime to reuse and must create one. */
  readonly willCreateRuntime: boolean;
  /** Turns this conversation has already completed. */
  readonly promptCount: number;
  /** A stored backend handle the new runtime could resume from. */
  readonly hasResumeHandle: boolean;
}

export function isRuntimeCreatedWithoutResume(
  input: MemoryRuntimeContinuityInput,
): boolean {
  return (
    input.willCreateRuntime && input.promptCount > 0 && !input.hasResumeHandle
  );
}

export function decideMemoryIndexDelivery(
  input: MemoryIndexDeliveryDecisionInput,
): MemoryIndexDeliveryDecision {
  if (
    input.runtimeCreatedWithoutResume ||
    input.backendReportedCompactionLastTurn
  ) {
    return { mode: "full", reset: true };
  }
  if (!input.hasDeliveryState) {
    return { mode: "full", reset: false };
  }
  return { mode: "delta", reset: false };
}
