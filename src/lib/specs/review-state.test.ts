import { describe, expect, it } from "vitest";

import { lint } from "./lint";
import {
  elementHandleInSnapshot,
  toLintAssumptionRecords,
  toLintSnapshot,
} from "./review-state";
import type {
  Spec,
  SpecAssumptionRow,
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
  citationContractVersion: 2,
  citationVersion: 1,
  citationHash: "a".repeat(64),
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
  return { revision: REVISION, elements, assumptionCitations: [] };
}

function assumptionRow(
  id: string,
  number: number,
  disposition: SpecAssumptionRow["disposition"],
): SpecAssumptionRow {
  return {
    id,
    spec_id: SPEC_ID,
    number,
    element_id: null,
    text: "An assumption recorded against the spec.",
    proposed_by_json: JSON.stringify({
      kind: "agent",
      conversationId: "conversation-review-state",
    }),
    record_version: 1,
    disposition,
    disposed_at: disposition === "proposed" ? null : NOW,
    withdrawn_at: null,
    supersedes_assumption_id: null,
    supersession_operation_id: null,
    supersession_request_hash: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

const SPEC: Spec = {
  id: SPEC_ID,
  projectPath: "/repos/review-state",
  slug: "review-state",
  name: "Review state",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

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

describe("revision-owned lint premises", () => {
  it("uses the frozen cited disposition rather than a mutable current assumption", () => {
    const snapshot = snapshotOf([
      row("requirement-a", "requirement", 1, requirementPayload),
    ]);
    snapshot.assumptionCitations.push({
      revisionId: REVISION_ID,
      specId: SPEC_ID,
      elementId: "requirement-a",
      assumptionId: "assumption-a",
      snapshot: {
        schemaVersion: 1,
        captureKind: "native",
        capturedAt: NOW,
        assumptionId: "assumption-a",
        number: 3,
        recordVersion: 2,
        text: "The mutable row may now say confirmed.",
        elementId: "requirement-a",
        proposedBy: {
          kind: "agent",
          conversationId: "conversation-review-state",
        },
        disposition: "rejected",
        disposedAt: NOW,
        withdrawnAt: null,
        supersedesAssumptionId: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(
      lint(toLintSnapshot(SPEC, snapshot), {
        // The mutable row now says confirmed; the frozen citation must win.
        assumptions: toLintAssumptionRecords(snapshot, [
          assumptionRow("assumption-a", 3, "confirmed"),
        ]),
      }),
    ).toContainEqual({
      ruleId: "9.8.rejected-cited-assumption",
      severity: "blocks_signoff",
      elementHandle: "R1",
      message: "A3 was rejected but R1 still cites it.",
    });
  });

  /**
   * An assumption may be recorded against the spec with no element attachment,
   * so it never produces a citation. It is still real and still addressable as
   * `A<n>`, and prose that references it must resolve rather than be reported
   * as a dangling handle.
   */
  it("carries an uncited spec assumption so prose references to it resolve", () => {
    const snapshot = snapshotOf([
      row("requirement-a", "requirement", 1, {
        kind: "requirement",
        statement: "The importer rests on A4.",
        priority: "must",
        risk: "high",
      }),
    ]);

    const proseFindings = (specAssumptions: SpecAssumptionRow[]) =>
      lint(toLintSnapshot(SPEC, snapshot), {
        assumptions: toLintAssumptionRecords(snapshot, specAssumptions),
      }).filter((finding) => finding.message.includes("prose references"));

    expect(
      proseFindings([assumptionRow("assumption-d", 4, "proposed")]),
    ).toEqual([]);
    // Without the row the same prose is misreported — the gap this closes.
    expect(proseFindings([])).toEqual([
      {
        ruleId: "9.6.dangling-handle",
        severity: "blocks_propose",
        elementHandle: "R1",
        message: "R1 prose references unknown handle A4 in statement.",
      },
    ]);
  });
});
