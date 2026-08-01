import { specDetailViewSchema, type SpecDetailView } from "@/lib/specs/queries";

import {
  SPEC_CONTROLS_FIXTURE_NOW,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";

export function specElementReaderDetailFixture(): SpecDetailView {
  const detail = specControlsDetailFixture();
  const snapshot = detail.currentRevision;
  if (snapshot === null) throw new Error("Reader fixture requires a revision");

  const elements = snapshot.elements.map((entry) => ({
    ...entry,
    handle:
      entry.element.id === "requirement-1"
        ? "R1"
        : entry.element.id === "criterion-1"
          ? "R1.1"
          : entry.element.id === "task-1"
            ? "T1"
            : null,
  }));
  elements.push(
    {
      handle: "D1",
      element: {
        id: "decision-1",
        specId: detail.spec.id,
        kind: "decision",
        number: 1,
        parentElementId: null,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      version: {
        revisionId: snapshot.revision.id,
        elementId: "decision-1",
        position: 3,
        payload: {
          kind: "decision",
          title: "Pin the complete execution scope",
          chosenApproach:
            "Persist the selected tasks and criteria with the execution.",
          rejectedAlternatives: [
            {
              label: "Resolve scope when work starts",
              reason: "The source revision could change before launch.",
            },
          ],
          reason: "A run must remain reproducible after authoring continues.",
          tracedRequirementElementIds: ["requirement-1"],
        },
        payloadHash: "decision-hash",
        elementVersion: 1,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    },
    {
      handle: "T2",
      element: {
        id: "task-2",
        specId: detail.spec.id,
        kind: "task",
        number: 2,
        parentElementId: null,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      version: {
        revisionId: snapshot.revision.id,
        elementId: "task-2",
        position: 4,
        payload: {
          kind: "task",
          title: "Validate immutable scope",
          instructions:
            "Prove that execution reads the snapshot captured at launch.",
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: ["decision-1"],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: ["task-1"],
          laneGroup: "execution-contract",
          touchedPaths: ["src/lib/specs"],
        },
        payloadHash: "task-2-hash",
        elementVersion: 1,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    },
  );

  const populatedSnapshot = { ...snapshot, elements };
  return specDetailViewSchema.parse({
    ...detail,
    currentRevision: populatedSnapshot,
    currentApprovedRevision: populatedSnapshot,
    executionRevisionSnapshots: [populatedSnapshot],
    approvals: [
      {
        id: "approval-requirement-1",
        spec_id: detail.spec.id,
        subject_kind: "requirement",
        element_id: "requirement-1",
        revision_id: snapshot.revision.id,
        approver: "alex",
        granted_at: SPEC_CONTROLS_FIXTURE_NOW,
        validity: "valid",
      },
      {
        id: "approval-decision-1",
        spec_id: detail.spec.id,
        subject_kind: "decision",
        element_id: "decision-1",
        revision_id: snapshot.revision.id,
        approver: "alex",
        granted_at: SPEC_CONTROLS_FIXTURE_NOW,
        validity: "valid",
      },
    ],
    elementStatuses: {
      requirements: [
        {
          elementId: "requirement-1",
          status: {
            approval: "valid",
            coverage: "covered",
            proof: "partial",
          },
        },
      ],
      tasks: [
        {
          elementId: "task-1",
          status: { status: "completed", claimEvidenceIds: [] },
        },
        {
          elementId: "task-2",
          status: { status: "running", claimEvidenceIds: [] },
        },
      ],
    },
  });
}
