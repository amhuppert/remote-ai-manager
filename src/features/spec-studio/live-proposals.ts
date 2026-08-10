import type { SpecDetailView } from "@/lib/specs/queries";
import type { LiveProposalView } from "@/lib/specs/view-schemas";

/**
 * The one selection model for "which proposal is this surface showing".
 *
 * Ticket #50's dead end was three surfaces answering that question
 * differently — the Review tab keyed off the lineage head, the lifecycle strip
 * off the highest-numbered open revision, History off neither — so a proposal
 * an approved revision had forked past was visible nowhere it could be acted
 * on. Every Studio surface reads the server's `liveProposals` projection
 * through these functions, and the Studio integrations that compose onto
 * review select through `useProposalSelection`.
 *
 * Pure and hook-free on purpose: the lifecycle strip is not a client
 * component, and it reads these too.
 */

/** Proposals an approved revision forked past — dismissal is their only exit. */
export function strandedProposals(detail: SpecDetailView): LiveProposalView[] {
  return detail.liveProposals.filter((entry) => entry.supersededBy !== null);
}

/** The proposal still on the lineage's live line, if one is under review. */
export function currentProposal(
  detail: SpecDetailView,
): LiveProposalView | null {
  return (
    detail.liveProposals.find((entry) => entry.supersededBy === null) ?? null
  );
}

/**
 * The proposal a surface shows for `requestedRevisionId`.
 *
 * An explicit request wins so a deep link into a stranded proposal lands on
 * it. Otherwise the current proposal is shown — that is the review a human
 * came for — and a spec whose only live proposals are stranded shows the
 * newest of them rather than nothing.
 */
export function selectProposal(
  detail: SpecDetailView,
  requestedRevisionId: string | null,
): LiveProposalView | null {
  const requested =
    requestedRevisionId === null
      ? undefined
      : detail.liveProposals.find(
          (entry) => entry.revision.id === requestedRevisionId,
        );
  return (
    requested ?? currentProposal(detail) ?? detail.liveProposals.at(-1) ?? null
  );
}

export interface ProposalSelection {
  /** Every live proposal, oldest first. */
  readonly proposals: LiveProposalView[];
  readonly selected: LiveProposalView | null;
  select(revisionId: string): void;
}
