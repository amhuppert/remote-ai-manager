import type {
  RevisionCitation,
  RevisionCitationDiffContext,
  RevisionElement,
} from "./revision-diff";
import type { SpecRevisionSnapshot } from "./schemas";

export function toDiffRows(snapshot: SpecRevisionSnapshot): RevisionElement[] {
  return snapshot.elements.map(({ element, version }) => ({
    elementId: element.id,
    parentElementId: element.parentElementId,
    payloadHash: version.payloadHash,
    payload: version.payload,
  }));
}

export function toDiffCitations(
  snapshot: SpecRevisionSnapshot,
): RevisionCitation[] {
  return snapshot.assumptionCitations.map(
    ({ elementId, assumptionId, snapshot: assumptionSnapshot }) => ({
      elementId,
      assumptionId,
      snapshot: assumptionSnapshot,
    }),
  );
}

export function toCitationDiffContext(
  base: SpecRevisionSnapshot | null,
  draft: SpecRevisionSnapshot,
): RevisionCitationDiffContext {
  return {
    baseCitationContractVersion:
      base?.revision.citationContractVersion ??
      draft.revision.citationContractVersion,
    draftCitationContractVersion: draft.revision.citationContractVersion,
    baseCitations: base === null ? [] : toDiffCitations(base),
    draftCitations: toDiffCitations(draft),
  };
}
