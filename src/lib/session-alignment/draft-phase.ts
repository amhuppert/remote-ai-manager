import type { AlignmentVersion } from "./schemas";

/**
 * What an open draft row means to the reader — the one owner of that decision.
 *
 * `/align` inserts an empty draft row when the command runs and the agent fills
 * it a turn (or several minutes) later, so an unfilled row is authoring still in
 * flight, not something the user can act on. Every surface that says "pending"
 * reads this, so the header chip, the alignment panel, and the Approve-Charter
 * gate cannot disagree about which drafts are the user's to resolve.
 */
export type AlignmentDraftPhase =
  | "authoring"
  | "incorporating"
  | "awaiting_approval";

export function alignmentDraftPhase(
  draft: AlignmentVersion | null | undefined,
): AlignmentDraftPhase | null {
  if (!draft) return null;
  // `autoActivate` outranks emptiness: a decision draft is already approved and
  // activates the moment its content lands, so it is never the user's to
  // approve — the same precedence the service's resolution guard applies.
  if (draft.autoActivate) return "incorporating";
  if (draft.content.trim().length === 0) return "authoring";
  return "awaiting_approval";
}
