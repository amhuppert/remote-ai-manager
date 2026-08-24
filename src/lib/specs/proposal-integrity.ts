import { HUMAN_ACT_REQUIRED_RATIONALE } from "./refusal-rationale";
import { ancestorIds } from "./revision-lineage";
import type { SpecRevision } from "./schemas";
import type { TransitionRefusal } from "./transitions";

/** The Studio address where a human ends a review attempt. */
export const HUMAN_REVIEW_SURFACE = "Spec Studio → Review";

/** The Studio address every #50 remedy points at. */
export const DISMISS_SUPERSEDED_SURFACE = `${HUMAN_REVIEW_SURFACE}, using "Dismiss superseded proposal"`;

export function dismissSupersededHumanActRefusal(
  revisionId: string,
): TransitionRefusal {
  return {
    code: "human_act_required",
    unmetConditions: [
      "Ending a reviewed proposal as superseded is a human act.",
    ],
    rationale: HUMAN_ACT_REQUIRED_RATIONALE,
    instruction: `Ask the operator to open ${DISMISS_SUPERSEDED_SURFACE} on revision ${revisionId}. An agent cannot dispose of work a human was reviewing.`,
  };
}

export function dismissSupersededIneligibleRefusal(
  revision: SpecRevision,
): TransitionRefusal {
  return {
    code: "gate_blocked",
    unmetConditions: [
      revision.state === "proposed"
        ? `Revision ${revision.number} is the lineage's live proposal: no approved revision has forked past it.`
        : `Revision ${revision.number} is ${revision.state}, and no approved revision has forked past it — there is no proposal to dismiss.`,
    ],
    instruction: `Dismissal is only for a proposal an approved revision left behind. To end this review, use Request Changes in Spec Studio → Review, or have its author run \`cctl spec withdraw-proposal <slug> --revision ${revision.id}\`.`,
  };
}

/**
 * One decision module for "which proposals are live, and which of them has
 * been forked past". Ticket #50's dead end came from three surfaces answering
 * that question differently — the Review tab keyed off the highest-numbered
 * revision, the lifecycle strip off a second rule, and `verify` not at all —
 * so the guard, the dismiss act, the Studio surfaces, and verification all
 * consume these functions rather than re-deriving the shape.
 *
 * Every function here is a pure read over the revision rows: nothing derived
 * here is persisted, so a projection can never drift from the lineage it
 * describes.
 */

function byNumber(revisions: readonly SpecRevision[]): SpecRevision[] {
  return [...revisions].sort((left, right) => left.number - right.number);
}

/**
 * Whether approving `candidate` leaves `proposal` behind: the candidate is
 * numbered above the proposal and the proposal's content is absent from the
 * candidate's lineage.
 *
 * Ancestry, not direct-parent inequality, is the test. A candidate three
 * revisions above a proposal still carries its content when the proposal is
 * anywhere in its ancestor set, and calling that "forked past" would strand a
 * proposal the lineage already folded in.
 */
function forksPast(
  revisions: readonly SpecRevision[],
  candidate: SpecRevision,
  proposal: SpecRevision,
): boolean {
  if (candidate.id === proposal.id) return false;
  if (candidate.number <= proposal.number) return false;
  return !ancestorIds(revisions, candidate.id).has(proposal.id);
}

/** Every revision of the lineage currently under review, oldest first. */
export function liveProposals(
  revisions: readonly SpecRevision[],
): SpecRevision[] {
  return byNumber(revisions).filter(
    (revision) => revision.state === "proposed",
  );
}

/** Live proposals other than `revisionId` — the ones a transition can strand. */
export function liveSiblingProposals(
  revisions: readonly SpecRevision[],
  revisionId: string,
): SpecRevision[] {
  return liveProposals(revisions).filter(
    (revision) => revision.id !== revisionId,
  );
}

/**
 * The approved revision that superseded `proposalId`, or null when the
 * proposal is still the lineage's live head (or is not a proposal at all).
 * The newest forking-past approval is named: it is the content a reader would
 * have to reconcile the stranded proposal against.
 *
 * This is the single eligibility predicate for the dismiss act, the Studio
 * surfaces, and spec verification — a second implementation would let one
 * surface offer a dismissal another refuses.
 */
export function supersedingRevision(
  revisions: readonly SpecRevision[],
  proposalId: string,
): SpecRevision | null {
  const proposal = revisions.find((revision) => revision.id === proposalId);
  if (proposal === undefined || proposal.state !== "proposed") return null;
  return (
    byNumber(revisions)
      .filter((candidate) => candidate.state === "approved")
      .filter((candidate) => forksPast(revisions, candidate, proposal))
      .at(-1) ?? null
  );
}

/**
 * The live proposals that signing off `revisionId` would strand — the same
 * fork-past test the supersession predicate applies, asked before the approval
 * commits rather than after. Sign-off refuses on a non-empty answer instead of
 * disposing of them, so no reviewed work is discarded by a transition a human
 * did not aim at it.
 */
export function proposalsStrandedBySignOff(
  revisions: readonly SpecRevision[],
  revisionId: string,
): SpecRevision[] {
  const target = revisions.find((revision) => revision.id === revisionId);
  if (target === undefined) return [];
  return liveSiblingProposals(revisions, revisionId).filter((proposal) =>
    forksPast(revisions, target, proposal),
  );
}

/**
 * The propose guard's refusal. It names the live proposal by number AND id
 * because the id is the token every remedy below takes, and it lists all three
 * exits — a refusal that only says "no" is how #50's dead end formed one layer
 * up.
 */
export function proposalAlreadyLiveRefusal(
  live: SpecRevision,
): TransitionRefusal {
  return {
    code: "revision_in_review",
    unmetConditions: [
      `This lineage already has a live proposal: revision ${live.number} (${live.id}) is under review.`,
    ],
    instruction: `Conclude that review before proposing again: sign off revision ${live.number} in Spec Studio, have a human request changes on it, or — if an approved revision has already forked past it — dismiss it from ${DISMISS_SUPERSEDED_SURFACE} on revision ${live.id}.`,
  };
}

/**
 * The sign-off recheck's refusal. Sign-off never disposes of the sibling it
 * found: reviewed work ends on a human's terms, and the refusal hands them the
 * act that ends it.
 */
export function strandedProposalSignOffRefusal(
  target: SpecRevision,
  stranded: SpecRevision,
): TransitionRefusal {
  return {
    code: "revision_in_review",
    unmetConditions: [
      `Signing off revision ${target.number} would fork past revision ${stranded.number} (${stranded.id}), which is still proposed and would be left unactionable.`,
    ],
    instruction: `Dispose of revision ${stranded.number} first: dismiss it from ${DISMISS_SUPERSEDED_SURFACE} on revision ${stranded.id}, or have its author run \`cctl spec withdraw-proposal <slug> --revision ${stranded.id}\`. Then sign off revision ${target.number} again.`,
  };
}

export interface LiveProposalEntry {
  readonly revision: SpecRevision;
  /** The approved revision that forked past it; null while it is current. */
  readonly supersededBy: SpecRevision | null;
}

/**
 * Every live proposal with its supersession verdict — the selection model the
 * Review tab, the attention badge, the lifecycle strip, the Overview action,
 * and History all read, so one spec cannot look actionable on one surface and
 * absent on another.
 */
export function liveProposalProjection(
  revisions: readonly SpecRevision[],
): LiveProposalEntry[] {
  return liveProposals(revisions).map((revision) => ({
    revision,
    supersededBy: supersedingRevision(revisions, revision.id),
  }));
}
