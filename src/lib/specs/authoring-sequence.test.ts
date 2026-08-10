import { describe, expect, it } from "vitest";

import {
  draftAuthoringSequence,
  remainingAuthoringSequence,
} from "./authoring-sequence";
import type {
  SpecRevision,
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "./schemas";
import { remainingAuthoringSequenceSchema } from "./view-schemas";

const AT = "2026-07-18T00:00:00.000Z";

function revision(
  overrides: Pick<SpecRevision, "id" | "number"> & Partial<SpecRevision>,
): SpecRevision {
  return {
    specId: "spec-1",
    state: "draft",
    authoringStage: "plan",
    basedOnRevisionId: null,
    contentHash: null,
    proposedAt: null,
    approvedAt: null,
    createdAt: AT,
    ...overrides,
  };
}

function requirementElement(
  revisionId: string,
  statement: string,
): SpecRevisionElement {
  return {
    element: {
      id: "requirement-1",
      specId: "spec-1",
      kind: "requirement",
      number: 1,
      parentElementId: null,
      createdAt: AT,
    },
    version: {
      revisionId,
      elementId: "requirement-1",
      position: 0,
      payload: {
        kind: "requirement",
        statement,
        priority: "must",
        risk: "medium",
      },
      payloadHash: `requirement-1-${statement}`,
      elementVersion: 1,
      createdAt: AT,
      updatedAt: AT,
    },
  };
}

describe("R25.5 remaining authoring sequence", () => {
  it("reports every remaining stage with its concluding gate under contract-bearing", () => {
    const sequence = remainingAuthoringSequence({
      policy: { preset: "contract-bearing" },
      revisionId: "revision-1",
      revisionNumber: 1,
      pinnedStage: "requirements",
      governanceConsultedGates: ["requirements"],
    });

    expect(remainingAuthoringSequenceSchema.parse(sequence)).toEqual(sequence);
    expect(sequence.pinnedStage).toBe("requirements");
    expect(sequence.stages).toEqual([
      {
        stage: "requirements",
        gate: "requirements",
        dial: "gate",
        concludedBy: "propose",
        requiresHumanSignOff: true,
      },
      {
        stage: "design",
        gate: "design",
        dial: "gate",
        concludedBy: "propose",
        requiresHumanSignOff: true,
      },
    ]);
    expect(sequence.nextTransition).toEqual({
      stage: "requirements",
      action: "propose",
      requiresHumanSignOff: true,
      consultedGates: [{ gate: "requirements", dial: "gate" }],
      governanceConsultedGates: ["requirements"],
    });
  });

  it("caps a new requirements-pinned fast-path draft at design", () => {
    const sequence = remainingAuthoringSequence({
      policy: { preset: "fast-path" },
      revisionId: "revision-1",
      revisionNumber: 2,
      pinnedStage: "requirements",
      governanceConsultedGates: ["requirements"],
    });

    expect(sequence.stages.map((step) => step.stage)).toEqual([
      "requirements",
      "design",
    ]);
    expect(sequence.stages.every((step) => step.requiresHumanSignOff)).toBe(
      true,
    );
    expect(sequence.stages[0]?.dial).toBe("combined-approval");
    expect(sequence.nextTransition.action).toBe("propose");
  });

  it("reports propose as the concluding transition for the final design stage", () => {
    const sequence = remainingAuthoringSequence({
      policy: { preset: "exploratory" },
      revisionId: "revision-3",
      revisionNumber: 3,
      pinnedStage: "design",
      governanceConsultedGates: ["design"],
    });

    expect(sequence.stages).toEqual([
      {
        stage: "design",
        gate: "design",
        dial: "notify",
        concludedBy: "propose",
        requiresHumanSignOff: false,
      },
    ]);
    expect(sequence.nextTransition).toEqual({
      stage: "design",
      action: "propose",
      requiresHumanSignOff: false,
      consultedGates: [{ gate: "design", dial: "notify" }],
      governanceConsultedGates: ["design"],
    });
  });

  it("names every gate the next propose will consult, including modified earlier stages", () => {
    const sequence = remainingAuthoringSequence({
      policy: { preset: "contract-bearing", overrides: { plan: "notify" } },
      revisionId: "revision-4",
      revisionNumber: 4,
      pinnedStage: "plan",
      governanceConsultedGates: ["requirements", "plan"],
    });

    expect(sequence.stages).toEqual([
      {
        stage: "plan",
        gate: "plan",
        dial: "notify",
        concludedBy: "propose",
        requiresHumanSignOff: false,
      },
    ]);
    expect(sequence.nextTransition).toEqual({
      stage: "plan",
      action: "propose",
      requiresHumanSignOff: true,
      consultedGates: [
        { gate: "requirements", dial: "gate" },
        { gate: "plan", dial: "notify" },
      ],
      governanceConsultedGates: ["requirements", "plan"],
    });
  });
});

describe("draftAuthoringSequence", () => {
  /**
   * The D3 shape: the draft continues an attempt a human withdrew, which
   * already carried the requirement change. Measured against that parent the
   * requirements gate looks untouched; measured against the last approved
   * ancestor it still owes its admission, and the sequence must say so.
   */
  it("names the gates the propose consults against the nearest approved ancestor", () => {
    const approved = revision({
      id: "revision-1",
      number: 1,
      state: "approved",
      authoringStage: "requirements",
      approvedAt: AT,
    });
    const withdrawn = revision({
      id: "revision-2",
      number: 2,
      state: "withdrawn",
      basedOnRevisionId: approved.id,
    });
    const draft = revision({
      id: "revision-3",
      number: 3,
      basedOnRevisionId: withdrawn.id,
    });
    const changed = "Gates survive a withdrawn attempt.";
    const draftSnapshot: SpecRevisionSnapshot = {
      revision: draft,
      elements: [requirementElement(draft.id, changed)],
    };

    const governanceScoped = draftAuthoringSequence({
      policy: { preset: "contract-bearing" },
      snapshot: draftSnapshot,
      governanceBaseSnapshot: {
        revision: approved,
        elements: [requirementElement(approved.id, "Gates are stated.")],
      },
    });
    expect(governanceScoped?.nextTransition.governanceConsultedGates).toEqual([
      "requirements",
      "plan",
    ]);

    // The immediate parent already carries the change, which is exactly why it
    // is the wrong baseline for this question.
    const parentScoped = draftAuthoringSequence({
      policy: { preset: "contract-bearing" },
      snapshot: draftSnapshot,
      governanceBaseSnapshot: {
        revision: withdrawn,
        elements: [requirementElement(withdrawn.id, changed)],
      },
    });
    expect(parentScoped?.nextTransition.governanceConsultedGates).toEqual([
      "plan",
    ]);
  });

  it("reports no sequence for a revision that is not a draft", () => {
    expect(
      draftAuthoringSequence({
        policy: { preset: "contract-bearing" },
        snapshot: {
          revision: revision({
            id: "revision-1",
            number: 1,
            state: "proposed",
          }),
          elements: [],
        },
        governanceBaseSnapshot: null,
      }),
    ).toBeNull();
  });
});
