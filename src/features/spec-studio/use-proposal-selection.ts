"use client";

import { useState } from "react";

import type { SpecDetailView } from "@/lib/specs/queries";

import { selectProposal, type ProposalSelection } from "./live-proposals";

/**
 * Holds which live proposal a Studio surface is showing. The Studio
 * integrations that compose onto review (notes rendering, plan preview) select
 * through this hook rather than keeping their own idea of the viewed
 * revision — one selection model, one answer (#50).
 */
export function useProposalSelection(
  detail: SpecDetailView,
  /** The revision a link addressed, owned by the URL (`?revision=`). */
  addressedRevisionId: string | null = null,
): ProposalSelection {
  const [pickedRevisionId, setPickedRevisionId] = useState<string | null>(null);
  return {
    proposals: detail.liveProposals,
    // Resolved every render rather than stored: a proposal that was signed off
    // or dismissed leaves the projection, and a selection held in state would
    // keep naming a revision the server no longer lists. An in-page pick wins
    // over the address that opened the surface.
    selected: selectProposal(detail, pickedRevisionId ?? addressedRevisionId),
    select: setPickedRevisionId,
  };
}
