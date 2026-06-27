import type { AlignmentState } from "@/lib/session-alignment/schemas";

/** The four mutually-exclusive states the session-header alignment chip shows. */
export type AlignmentChipState = "none" | "active" | "pending" | "stale";

/**
 * Derive the chip state from the aggregate alignment state and the version this
 * conversation last ran a turn under (`null` until it has run under an active
 * charter). Precedence is intentional: a pending draft outranks everything so a
 * pending update is always surfaced, even when an active charter governs and the
 * conversation has already seen it.
 */
export function deriveAlignmentChipState(
  state: AlignmentState | null | undefined,
  conversationSeenVersion: number | null,
): AlignmentChipState {
  if (state?.draft) return "pending";
  if (!state?.active) return "none";
  if (
    conversationSeenVersion != null &&
    state.active.version != null &&
    conversationSeenVersion < state.active.version
  ) {
    return "stale";
  }
  return "active";
}
