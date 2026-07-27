import { describe, expect, it } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
import {
  initialDetailViewForDeepLink,
  selectEvidenceRevision,
} from "./SpecDetailViews";

describe("initialDetailViewForDeepLink", () => {
  it("routes Q/A deep links to the questions tab so their DOM targets mount", () => {
    expect(initialDetailViewForDeepLink("Q1", "native-sdd")).toBe("questions");
    expect(initialDetailViewForDeepLink("A2", "native-sdd")).toBe("questions");
    expect(initialDetailViewForDeepLink("native-sdd/A1", "native-sdd")).toBe(
      "questions",
    );
  });

  it("keeps element handles on overview and execution_start on controls", () => {
    expect(initialDetailViewForDeepLink("R1", "native-sdd")).toBe("overview");
    expect(initialDetailViewForDeepLink("R1.2", "native-sdd")).toBe("overview");
    expect(initialDetailViewForDeepLink("execution_start", "native-sdd")).toBe(
      "controls",
    );
    expect(initialDetailViewForDeepLink(null, "native-sdd")).toBe("overview");
    expect(initialDetailViewForDeepLink("Q1", undefined)).toBe("overview");
    expect(initialDetailViewForDeepLink("not a handle", "native-sdd")).toBe(
      "overview",
    );
  });

  it("routes the delivery gate deep link to controls so the merge gate mounts", () => {
    expect(initialDetailViewForDeepLink("delivery", "native-sdd")).toBe(
      "controls",
    );
  });
});

describe("selectEvidenceRevision", () => {
  it("targets an active execution's pinned approved revision over a concurrent proposal", () => {
    const detail = specControlsDetailFixture("definition_review");
    const approvedSnapshot = detail.currentRevision;
    if (approvedSnapshot === null) throw new Error("Fixture revision missing");
    const proposedSnapshot = {
      revision: {
        ...approvedSnapshot.revision,
        id: "revision-2",
        number: 2,
        state: "proposed" as const,
        basedOnRevisionId: "revision-1",
        contentHash: "proposed-hash",
        approvedAt: null,
      },
      elements: approvedSnapshot.elements.map((entry) => ({
        ...entry,
        version: {
          ...entry.version,
          revisionId: "revision-2",
          ...(entry.version.payload.kind === "criterion"
            ? {
                payload: {
                  ...entry.version.payload,
                  validationStrategy: { kinds: ["validator_verdict" as const] },
                },
              }
            : {}),
        },
      })),
    };
    const concurrentDetail = {
      ...detail,
      revisions: [approvedSnapshot.revision, proposedSnapshot.revision],
      baseRevision: null,
      currentRevision: proposedSnapshot,
      currentApprovedRevision: approvedSnapshot,
      executionRevisionSnapshots: [approvedSnapshot],
    } as SpecDetailView;

    const target = selectEvidenceRevision(concurrentDetail);

    expect(target?.snapshot.revision.id).toBe("revision-1");
    expect(target?.source).toBe("pinned");
    expect(
      target?.snapshot.elements.find(
        (entry) => entry.version.payload.kind === "criterion",
      )?.version.payload,
    ).toMatchObject({ validationStrategy: { kinds: ["test_run"] } });
  });
});
