import { describe, expect, it } from "vitest";

import {
  liveProposalProjection,
  liveProposals,
  liveSiblingProposals,
  proposalsStrandedBySignOff,
  supersedingRevision,
} from "./proposal-integrity";
import type { SpecRevision } from "./schemas";

const SPEC_ID = "spec-1";

function revision(
  number: number,
  state: SpecRevision["state"],
  basedOnRevisionId: string | null,
): SpecRevision {
  return {
    id: `revision-${number}`,
    specId: SPEC_ID,
    number,
    state,
    authoringStage: "plan",
    basedOnRevisionId,
    contentHash: state === "draft" ? null : `hash-${number}`,
    proposedAt: state === "draft" ? null : "2026-08-01T10:00:00.000Z",
    approvedAt: state === "approved" ? "2026-08-01T11:00:00.000Z" : null,
    createdAt: "2026-08-01T09:00:00.000Z",
  };
}

/**
 * Ticket #50's live shape: rev 5 proposed, rev 6 created from rev 3 and
 * approved. Rev 6 is numbered above rev 5 but does not descend from it.
 */
function strandedLineage(): SpecRevision[] {
  return [
    revision(1, "approved", null),
    revision(2, "approved", "revision-1"),
    revision(3, "approved", "revision-2"),
    revision(4, "withdrawn", "revision-3"),
    revision(5, "proposed", "revision-3"),
    revision(6, "approved", "revision-3"),
  ];
}

describe("liveProposals", () => {
  it("lists every proposed revision oldest first", () => {
    const revisions = [
      revision(1, "approved", null),
      revision(3, "proposed", "revision-1"),
      revision(2, "proposed", "revision-1"),
    ];

    expect(liveProposals(revisions).map((entry) => entry.number)).toEqual([
      2, 3,
    ]);
  });

  it("excludes the named revision from its own siblings", () => {
    const revisions = [
      revision(1, "approved", null),
      revision(2, "proposed", "revision-1"),
      revision(3, "proposed", "revision-1"),
    ];

    expect(
      liveSiblingProposals(revisions, "revision-2").map((entry) => entry.id),
    ).toEqual(["revision-3"]);
  });
});

describe("supersedingRevision", () => {
  it("names the approved revision that forked past the proposal", () => {
    expect(supersedingRevision(strandedLineage(), "revision-5")?.id).toBe(
      "revision-6",
    );
  });

  it("returns null for the newest proposal with nothing approved above it", () => {
    const revisions = [
      revision(1, "approved", null),
      revision(2, "proposed", "revision-1"),
    ];

    expect(supersedingRevision(revisions, "revision-2")).toBeNull();
  });

  it("returns null when the later approved revision descends from the proposal", () => {
    // Direct-parent inequality is not the test: rev 7 is based on rev 6, and
    // rev 6 on the proposal, so the proposal's content IS carried forward.
    const revisions = [
      revision(1, "approved", null),
      revision(2, "proposed", "revision-1"),
      revision(3, "withdrawn", "revision-2"),
      revision(4, "approved", "revision-3"),
    ];

    expect(supersedingRevision(revisions, "revision-2")).toBeNull();
  });

  it("returns null for a revision that is not a live proposal", () => {
    expect(supersedingRevision(strandedLineage(), "revision-4")).toBeNull();
    expect(supersedingRevision(strandedLineage(), "revision-3")).toBeNull();
  });

  it("names the newest forking-past approval when several exist", () => {
    const revisions = [
      revision(1, "approved", null),
      revision(2, "proposed", "revision-1"),
      revision(3, "approved", "revision-1"),
      revision(4, "approved", "revision-3"),
    ];

    expect(supersedingRevision(revisions, "revision-2")?.id).toBe("revision-4");
  });
});

describe("proposalsStrandedBySignOff", () => {
  it("names the live sibling a sign-off would fork past", () => {
    const revisions = [
      revision(1, "approved", null),
      revision(2, "proposed", "revision-1"),
      revision(3, "proposed", "revision-1"),
    ];

    expect(
      proposalsStrandedBySignOff(revisions, "revision-3").map(
        (entry) => entry.id,
      ),
    ).toEqual(["revision-2"]);
  });

  it("leaves an ancestor proposal alone — signing off its descendant carries it forward", () => {
    const revisions = [
      revision(1, "approved", null),
      revision(2, "proposed", "revision-1"),
      revision(3, "proposed", "revision-2"),
    ];

    expect(proposalsStrandedBySignOff(revisions, "revision-3")).toEqual([]);
  });

  it("leaves a higher-numbered proposal alone — the sign-off is not newer than it", () => {
    const revisions = [
      revision(1, "approved", null),
      revision(2, "proposed", "revision-1"),
      revision(3, "proposed", "revision-1"),
    ];

    expect(proposalsStrandedBySignOff(revisions, "revision-2")).toEqual([]);
  });
});

describe("liveProposalProjection", () => {
  it("carries the supersession verdict for every live proposal", () => {
    const revisions = [
      ...strandedLineage(),
      revision(7, "proposed", "revision-6"),
    ];

    expect(
      liveProposalProjection(revisions).map((entry) => ({
        id: entry.revision.id,
        supersededBy: entry.supersededBy?.id ?? null,
      })),
    ).toEqual([
      { id: "revision-5", supersededBy: "revision-6" },
      { id: "revision-7", supersededBy: null },
    ]);
  });

  it("is empty when nothing is proposed", () => {
    expect(liveProposalProjection([revision(1, "approved", null)])).toEqual([]);
  });
});
