import { describe, expect, it } from "vitest";

import type { SpecRevision } from "./schemas";
import {
  ancestorIds,
  nearestApprovedAncestor,
  selectOrdinaryContinuation,
  SpecRevisionLineageError,
} from "./revision-lineage";

const SPEC_ID = "spec-1";

function revision(
  input: Pick<SpecRevision, "id" | "number"> & Partial<SpecRevision>,
): SpecRevision {
  return {
    specId: SPEC_ID,
    state: "draft",
    authoringStage: "requirements",
    basedOnRevisionId: null,
    contentHash: null,
    citationContractVersion: 2,
    citationVersion: 1,
    citationHash: "0".repeat(64),
    proposedAt: null,
    approvedAt: null,
    externalDelivery: null,
    createdAt: "2026-07-18T12:00:00.000Z",
    ...input,
  };
}

describe("ancestorIds", () => {
  it("walks basedOnRevisionId and excludes the starting revision", () => {
    const revisions = [
      revision({ id: "rev-1", number: 1, state: "approved" }),
      revision({ id: "rev-2", number: 2, basedOnRevisionId: "rev-1" }),
      revision({ id: "rev-3", number: 3, basedOnRevisionId: "rev-2" }),
    ];

    expect(ancestorIds(revisions, "rev-3")).toEqual(
      new Set(["rev-2", "rev-1"]),
    );
    expect(ancestorIds(revisions, "rev-1")).toEqual(new Set());
  });

  it("terminates on a lineage cycle without counting the start as its own ancestor", () => {
    const revisions = [
      revision({ id: "rev-a", number: 1, basedOnRevisionId: "rev-b" }),
      revision({ id: "rev-b", number: 2, basedOnRevisionId: "rev-a" }),
    ];

    expect(ancestorIds(revisions, "rev-a")).toEqual(new Set(["rev-b"]));
  });

  it("fails closed when a parent revision is missing", () => {
    const revisions = [
      revision({ id: "rev-2", number: 2, basedOnRevisionId: "rev-1" }),
    ];

    expect(() => ancestorIds(revisions, "rev-2")).toThrow(
      SpecRevisionLineageError,
    );
    try {
      ancestorIds(revisions, "rev-2");
      expect.unreachable("missing parent must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(SpecRevisionLineageError);
      if (!(error instanceof SpecRevisionLineageError)) throw error;
      expect(error.reason).toBe("missing_parent");
      expect(error.revisionId).toBe("rev-1");
      expect(error.childRevisionId).toBe("rev-2");
    }
  });

  it("fails closed when the starting revision is unknown", () => {
    const revisions = [revision({ id: "rev-1", number: 1 })];

    try {
      ancestorIds(revisions, "rev-missing");
      expect.unreachable("unknown revision must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(SpecRevisionLineageError);
      if (!(error instanceof SpecRevisionLineageError)) throw error;
      expect(error.reason).toBe("unknown_revision");
      expect(error.revisionId).toBe("rev-missing");
      expect(error.childRevisionId).toBeNull();
    }
  });

  it("fails closed when a parent belongs to another spec", () => {
    const revisions = [
      revision({ id: "rev-foreign", number: 1, specId: "spec-2" }),
      revision({ id: "rev-2", number: 2, basedOnRevisionId: "rev-foreign" }),
    ];

    try {
      ancestorIds(revisions, "rev-2");
      expect.unreachable("cross-spec parent must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(SpecRevisionLineageError);
      if (!(error instanceof SpecRevisionLineageError)) throw error;
      expect(error.reason).toBe("cross_spec_parent");
      expect(error.revisionId).toBe("rev-foreign");
      expect(error.childRevisionId).toBe("rev-2");
    }
  });
});

describe("nearestApprovedAncestor", () => {
  it("skips a withdrawn revision to reach the approved base", () => {
    const revisions = [
      revision({ id: "rev-1", number: 1, state: "approved" }),
      revision({
        id: "rev-2",
        number: 2,
        state: "withdrawn",
        basedOnRevisionId: "rev-1",
      }),
      revision({
        id: "rev-3",
        number: 3,
        state: "proposed",
        basedOnRevisionId: "rev-2",
      }),
    ];

    expect(nearestApprovedAncestor(revisions, "rev-3")?.id).toBe("rev-1");
  });

  it("returns the closest approved ancestor, not the highest numbered one", () => {
    const revisions = [
      revision({ id: "rev-1", number: 1, state: "approved" }),
      revision({
        id: "rev-2",
        number: 2,
        state: "approved",
        basedOnRevisionId: "rev-1",
      }),
      revision({
        id: "rev-3",
        number: 3,
        state: "proposed",
        basedOnRevisionId: "rev-1",
      }),
    ];

    expect(nearestApprovedAncestor(revisions, "rev-3")?.id).toBe("rev-1");
  });

  it("returns null when no ancestor was ever approved", () => {
    const revisions = [revision({ id: "rev-1", number: 1, state: "proposed" })];

    expect(nearestApprovedAncestor(revisions, "rev-1")).toBeNull();
  });

  // A revision is not a base for itself: answering with the start revision on a
  // cycle would hand the caller its own content as the approved base to copy.
  it("does not answer with the starting revision when a cycle leads back to it", () => {
    const revisions = [
      revision({
        id: "rev-a",
        number: 1,
        state: "approved",
        basedOnRevisionId: "rev-b",
      }),
      revision({
        id: "rev-b",
        number: 2,
        state: "proposed",
        basedOnRevisionId: "rev-a",
      }),
    ];

    expect(nearestApprovedAncestor(revisions, "rev-a")).toBeNull();
  });

  it("returns null instead of looping on a cycle with no approved ancestor", () => {
    const revisions = [
      revision({ id: "rev-a", number: 1, basedOnRevisionId: "rev-b" }),
      revision({
        id: "rev-b",
        number: 2,
        state: "proposed",
        basedOnRevisionId: "rev-a",
      }),
    ];

    expect(nearestApprovedAncestor(revisions, "rev-b")).toBeNull();
  });
});

describe("selectOrdinaryContinuation", () => {
  it("reports unavailable for a spec with no revisions", () => {
    expect(selectOrdinaryContinuation([])).toEqual({ kind: "unavailable" });
  });

  it("reports unavailable when only withdrawn revisions remain", () => {
    const revisions = [
      revision({ id: "rev-1", number: 1, state: "withdrawn" }),
    ];

    expect(selectOrdinaryContinuation(revisions)).toEqual({
      kind: "unavailable",
    });
  });

  it("reuses the open draft when nothing is under review", () => {
    const approved = revision({ id: "rev-1", number: 1, state: "approved" });
    const draft = revision({
      id: "rev-2",
      number: 2,
      basedOnRevisionId: "rev-1",
    });

    expect(selectOrdinaryContinuation([approved, draft])).toEqual({
      kind: "reuse_draft",
      draft,
    });
  });

  it("clones the latest approved revision when there is no draft", () => {
    const first = revision({ id: "rev-1", number: 1, state: "approved" });
    const second = revision({
      id: "rev-2",
      number: 2,
      state: "approved",
      basedOnRevisionId: "rev-1",
    });

    expect(selectOrdinaryContinuation([first, second])).toEqual({
      kind: "clone_approved",
      approved: second,
      skippedWithdrawn: [],
    });
  });

  /**
   * A human withdraw ends a review without opening a follow-up draft, so the
   * next continuation clones the approved base and leaves the withdrawn
   * revision's content behind. The drop is legal but must not be silent.
   */
  it("names the withdrawn revisions the approved clone leaves behind", () => {
    const approved = revision({ id: "rev-1", number: 1, state: "approved" });
    const withdrawn = revision({
      id: "rev-2",
      number: 2,
      state: "withdrawn",
      basedOnRevisionId: "rev-1",
    });
    const alsoWithdrawn = revision({
      id: "rev-3",
      number: 3,
      state: "withdrawn",
      basedOnRevisionId: "rev-2",
    });

    expect(
      selectOrdinaryContinuation([approved, alsoWithdrawn, withdrawn]),
    ).toEqual({
      kind: "clone_approved",
      approved,
      skippedWithdrawn: [withdrawn, alsoWithdrawn],
    });
  });

  // A withdrawn revision the approved base does not descend from was already
  // left behind when that base was written; repeating it on every later
  // amendment would report a drop this continuation is not making.
  it("omits a withdrawn revision that is not below the cloned base", () => {
    const first = revision({ id: "rev-1", number: 1, state: "approved" });
    const withdrawn = revision({
      id: "rev-2",
      number: 2,
      state: "withdrawn",
      basedOnRevisionId: "rev-1",
    });
    const second = revision({
      id: "rev-3",
      number: 3,
      state: "approved",
      basedOnRevisionId: "rev-1",
    });

    expect(selectOrdinaryContinuation([first, withdrawn, second])).toEqual({
      kind: "clone_approved",
      approved: second,
      skippedWithdrawn: [],
    });
  });

  it("blocks on a proposal and names its approved base", () => {
    const approved = revision({ id: "rev-1", number: 1, state: "approved" });
    const proposed = revision({
      id: "rev-2",
      number: 2,
      state: "proposed",
      basedOnRevisionId: "rev-1",
    });

    expect(selectOrdinaryContinuation([approved, proposed])).toEqual({
      kind: "blocked_by_proposal",
      proposals: [proposed],
      approved,
    });
  });

  // Execution scope capture legitimately drafts against the pinned revision
  // while a later revision is under review, so a coexisting draft cannot be
  // read as an ordinary authoring line: the proposal still blocks.
  it("blocks on the proposal even when a capture-style draft coexists", () => {
    const approved = revision({ id: "rev-1", number: 1, state: "approved" });
    const proposed = revision({
      id: "rev-2",
      number: 2,
      state: "proposed",
      basedOnRevisionId: "rev-1",
    });
    const captureDraft = revision({
      id: "rev-3",
      number: 3,
      basedOnRevisionId: "rev-1",
    });

    expect(
      selectOrdinaryContinuation([approved, proposed, captureDraft]),
    ).toEqual({
      kind: "blocked_by_proposal",
      proposals: [proposed],
      approved,
    });
  });

  it("blocks with every outstanding proposal ordered by revision number", () => {
    const approved = revision({ id: "rev-1", number: 1, state: "approved" });
    const laterProposal = revision({
      id: "rev-3",
      number: 3,
      state: "proposed",
      basedOnRevisionId: "rev-1",
    });
    const earlierProposal = revision({
      id: "rev-2",
      number: 2,
      state: "proposed",
      basedOnRevisionId: "rev-1",
    });

    expect(
      selectOrdinaryContinuation([approved, laterProposal, earlierProposal]),
    ).toEqual({
      kind: "blocked_by_proposal",
      proposals: [earlierProposal, laterProposal],
      approved,
    });
  });

  it("blocks with a null approved base when the first revision is under review", () => {
    const proposed = revision({ id: "rev-1", number: 1, state: "proposed" });

    expect(selectOrdinaryContinuation([proposed])).toEqual({
      kind: "blocked_by_proposal",
      proposals: [proposed],
      approved: null,
    });
  });

  it("fails closed when the proposal's lineage is broken", () => {
    const proposed = revision({
      id: "rev-2",
      number: 2,
      state: "proposed",
      basedOnRevisionId: "rev-1",
    });

    expect(() => selectOrdinaryContinuation([proposed])).toThrow(
      SpecRevisionLineageError,
    );
  });
});
