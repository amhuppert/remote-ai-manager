import { alignmentDraftPhase } from "@/lib/session-alignment/draft-phase";
import type { AlignmentState } from "@/lib/session-alignment/schemas";

/** The four mutually-exclusive states the session-header alignment chip shows. */
export type AlignmentChipState = "none" | "active" | "pending" | "stale";

/**
 * Derive the chip state from the aggregate alignment state and the version this
 * conversation last ran a turn under (`null` until it has run under an active
 * charter). Precedence is intentional: a pending draft outranks everything so a
 * pending update is always surfaced, even when an active charter governs and the
 * conversation has already seen it.
 *
 * A draft still being authored is not pending anything: `/align` inserts its row
 * when the command runs, so flagging it would promise an update no surface can
 * resolve until the agent submits content.
 */
export function deriveAlignmentChipState(
  state: AlignmentState | null | undefined,
  conversationSeenVersion: number | null,
): AlignmentChipState {
  const draftPhase = alignmentDraftPhase(state?.draft);
  if (draftPhase === "awaiting_approval" || draftPhase === "incorporating") {
    return "pending";
  }
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
