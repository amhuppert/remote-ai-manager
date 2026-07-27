import { describe, expect, it } from "vitest";

import { remainingAuthoringSequence } from "./authoring-sequence";
import type { RevisionElement } from "./revision-diff";
import { remainingAuthoringSequenceSchema } from "./view-schemas";

function requirementRow(elementId: string, statement: string): RevisionElement {
  return {
    elementId,
    parentElementId: null,
    payloadHash: `${elementId}-${statement}`,
    payload: {
      kind: "requirement",
      statement,
      priority: "must",
      risk: "medium",
    },
  };
}

function taskRow(elementId: string): RevisionElement {
  return {
    elementId,
    parentElementId: null,
    payloadHash: `${elementId}-hash`,
    payload: {
      kind: "task",
      title: "Wire the surface",
      instructions: "Wire the surface end to end.",
      tracedRequirementElementIds: [],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: [],
      dependsOnTaskElementIds: [],
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
      baseRevisionRows: [],
      revisionRows: [requirementRow("requirement-1", "Gates are stated.")],
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
      {
        stage: "plan",
        gate: "plan",
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
    });
  });

  it("still reports three stages for a requirements-pinned draft under fast-path", () => {
    const sequence = remainingAuthoringSequence({
      policy: { preset: "fast-path" },
      revisionId: "revision-1",
      revisionNumber: 2,
      pinnedStage: "requirements",
      baseRevisionRows: [],
      revisionRows: [requirementRow("requirement-1", "Gates are stated.")],
    });

    expect(sequence.stages.map((step) => step.stage)).toEqual([
      "requirements",
      "design",
      "plan",
    ]);
    expect(sequence.stages.every((step) => step.requiresHumanSignOff)).toBe(
      true,
    );
    expect(sequence.stages[0]?.dial).toBe("combined-approval");
    expect(sequence.nextTransition.action).toBe("propose");
  });

  it("reports advance as the concluding transition for a notify stage", () => {
    const sequence = remainingAuthoringSequence({
      policy: { preset: "exploratory" },
      revisionId: "revision-3",
      revisionNumber: 3,
      pinnedStage: "design",
      baseRevisionRows: [],
      revisionRows: [],
    });

    expect(sequence.stages).toEqual([
      {
        stage: "design",
        gate: "design",
        dial: "notify",
        concludedBy: "advance",
        requiresHumanSignOff: false,
      },
      {
        stage: "plan",
        gate: "plan",
        dial: "notify",
        concludedBy: "propose",
        requiresHumanSignOff: false,
      },
    ]);
    expect(sequence.nextTransition).toEqual({
      stage: "design",
      action: "advance",
      requiresHumanSignOff: false,
      consultedGates: [{ gate: "design", dial: "notify" }],
    });
  });

  it("names every gate the next propose will consult, including modified earlier stages", () => {
    const base = requirementRow("requirement-1", "Gates are stated.");
    const sequence = remainingAuthoringSequence({
      policy: { preset: "contract-bearing", overrides: { plan: "notify" } },
      revisionId: "revision-4",
      revisionNumber: 4,
      pinnedStage: "plan",
      baseRevisionRows: [base],
      revisionRows: [
        requirementRow("requirement-1", "Gates are stated and reported."),
        taskRow("task-1"),
      ],
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
    });
  });
});
