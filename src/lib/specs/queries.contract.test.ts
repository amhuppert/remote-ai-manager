import { describe, expect, it } from "vitest";

import { specStatusViewSchema as clientSpecStatusViewSchema } from "./queries";
import { specStatusViewSchema as canonicalSpecStatusViewSchema } from "./view-schemas";

describe("Spec Studio query contracts", () => {
  it("accepts the canonical task plan status returned by the detail route", () => {
    expect(clientSpecStatusViewSchema).toBe(canonicalSpecStatusViewSchema);

    const status = {
      specId: "spec-1",
      slug: "status-line",
      phase: { primary: "draft", authoringStage: "plan" },
      gates: [],
      pendingApprovals: [],
      openQuestions: [],
      assumptions: [],
      taskPlan: [
        {
          elementId: "task-1",
          handle: "T1",
          title: "Implement status line",
          dependsOn: [],
          laneGroup: "status-line",
          executionLane: "status-line-lane",
          touchedPaths: ["src/statusLine.js"],
          criterionCoverage: ["R1.1"],
        },
      ],
      coverage: {
        coveredCriteria: 1,
        totalCriteria: 1,
        percentage: 100,
      },
      delivery: {
        allWaived: false,
        provenCount: 0,
        totalInScope: 1,
      },
    };

    const canonicalStatus = canonicalSpecStatusViewSchema.parse(status);

    expect(clientSpecStatusViewSchema.parse(status)).toEqual(canonicalStatus);
  });
});
