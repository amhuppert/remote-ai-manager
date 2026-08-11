import { describe, expect, it } from "vitest";

import { elementHandleInSnapshot } from "./review-state";
import type {
  SpecElementPayload,
  SpecRevision,
  SpecRevisionSnapshot,
} from "./schemas";

const SPEC_ID = "spec-review-state";
const REVISION_ID = "revision-1";
const NOW = "2026-07-25T09:00:00.000Z";

const REVISION: SpecRevision = {
  id: REVISION_ID,
  specId: SPEC_ID,
  number: 1,
  state: "draft",
  authoringStage: "plan",
  basedOnRevisionId: null,
  contentHash: null,
  proposedAt: null,
  approvedAt: null,
  externalDelivery: null,
  createdAt: NOW,
};

function row(
  id: string,
  kind: "requirement" | "criterion" | "decision" | "task" | "section",
  number: number | null,
  payload: SpecElementPayload,
  parentElementId: string | null = null,
): SpecRevisionSnapshot["elements"][number] {
  return {
    element: {
      id,
      specId: SPEC_ID,
      kind,
      number,
      parentElementId,
      createdAt: NOW,
    },
    version: {
      revisionId: REVISION_ID,
      elementId: id,
      position: 0,
      payload,
      payloadHash: `${id}-hash`,
      elementVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

const requirementPayload: SpecElementPayload = {
  kind: "requirement",
  statement: "Handles have one owner.",
  priority: "must",
  risk: "high",
};
const criterionPayload: SpecElementPayload = {
  kind: "criterion",
  text: "The handle grammar is rendered in one place.",
  validationStrategy: { kinds: ["test_run"] },
};
const decisionPayload: SpecElementPayload = {
  kind: "decision",
  title: "One owner for the grammar",
  chosenApproach: "Format through the handle module.",
  rejectedAlternatives: [],
  reason: "A second renderer drifts from the parser.",
  tracedRequirementElementIds: [],
};
const taskPayload: SpecElementPayload = {
  kind: "task",
  title: "Fold the duplicate renderer",
  instructions: "Call the formatter.",
  tracedRequirementElementIds: [],
  tracedDecisionElementIds: [],
  coveredCriterionElementIds: [],
  dependsOnTaskElementIds: [],
};
const sectionPayload: SpecElementPayload = {
  kind: "section",
  role: "context",
  title: "Context",
  body: "Sections are addressed by element id.",
};

function snapshotOf(
  elements: SpecRevisionSnapshot["elements"],
): SpecRevisionSnapshot {
  return { revision: REVISION, elements };
}

describe("elementHandleInSnapshot", () => {
  it("derives each kind's handle from the numbers the snapshot carries", () => {
    const snapshot = snapshotOf([
      row("requirement-a", "requirement", 3, requirementPayload),
      row("criterion-a", "criterion", 2, criterionPayload, "requirement-a"),
      row("decision-a", "decision", 4, decisionPayload),
      row("task-a", "task", 5, taskPayload),
    ]);

    expect(
      snapshot.elements.map(({ element }) =>
        elementHandleInSnapshot(snapshot, element.id),
      ),
    ).toEqual(["R3", "R3.2", "D4", "T5"]);
  });

  it("has no handle for a section, an unnumbered row, or a criterion under an unnumbered parent", () => {
    const snapshot = snapshotOf([
      row("section-a", "section", null, sectionPayload),
      row("requirement-a", "requirement", null, requirementPayload),
      row("criterion-a", "criterion", 1, criterionPayload, "requirement-a"),
      row("criterion-orphan", "criterion", 1, criterionPayload, "missing"),
    ]);

    expect(
      snapshot.elements.map(({ element }) =>
        elementHandleInSnapshot(snapshot, element.id),
      ),
    ).toEqual([null, null, null, null]);
    expect(elementHandleInSnapshot(snapshot, "absent")).toBeNull();
  });

  it("refuses a number outside the handle grammar instead of minting an unaddressable handle", () => {
    const snapshot = snapshotOf([
      row("requirement-a", "requirement", 0, requirementPayload),
      row("criterion-a", "criterion", 0, criterionPayload, "requirement-a"),
      row("task-a", "task", -1, taskPayload),
    ]);

    expect(
      snapshot.elements.map(({ element }) =>
        elementHandleInSnapshot(snapshot, element.id),
      ),
    ).toEqual([null, null, null]);
  });
});
