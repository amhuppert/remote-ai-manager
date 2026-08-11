import { describe, expect, it } from "vitest";

import {
  specStatusViewSchema as clientSpecStatusViewSchema,
  specSummaryViewSchema as clientSpecSummaryViewSchema,
} from "./queries";
import {
  specStatusViewSchema as canonicalSpecStatusViewSchema,
  specSummaryViewSchema as canonicalSpecSummaryViewSchema,
} from "./view-schemas";

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
        deliveredCount: 0,
        provenCount: 0,
        deliveredExternallyCriterionIds: [],
        totalInScope: 1,
      },
      imported: false,
    };

    const canonicalStatus = canonicalSpecStatusViewSchema.parse(status);

    expect(clientSpecStatusViewSchema.parse(status)).toEqual(canonicalStatus);
  });

  /**
   * The inventory reads the summary the list route builds. A second copy of
   * its schema on the client is how a field the server started sending —
   * `imported` — becomes an unrecognized key the strict client parse rejects,
   * so the summary is pinned to the one canonical schema rather than restated.
   */
  it("parses the summary the list route builds, import provenance included", () => {
    expect(clientSpecSummaryViewSchema).toBe(canonicalSpecSummaryViewSchema);

    const summary = {
      spec: {
        id: "spec-1",
        projectPath: "/repos/command-center",
        slug: "imported-feature",
        name: "Imported feature",
        gatePolicy: { preset: "contract-bearing" },
        abandonedAt: null,
        abandonedReason: null,
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
      phase: { primary: "delivered" },
      currentRevision: null,
      counts: { requirements: 1, criteria: 1, decisions: 0, tasks: 0 },
      pendingApprovalCount: 0,
      approvalState: "complete",
      delivery: {
        allWaived: false,
        deliveredCount: 1,
        deliveredExternallyCriterionIds: ["criterion-1"],
        provenCount: 0,
        totalInScope: 1,
      },
      linkedWork: {
        tickets: 0,
        conversations: 0,
        sessions: 0,
        workflowExecutions: 0,
        mergeJobs: 0,
      },
      imported: true,
    };

    expect(clientSpecSummaryViewSchema.parse(summary)).toMatchObject({
      imported: true,
      delivery: { deliveredExternallyCriterionIds: ["criterion-1"] },
    });
  });

  /**
   * A default on either field would be fail-open in the one direction that
   * matters: an omitted `imported` parses as natively authored and an omitted
   * `deliveredExternallyCriterionIds` parses as nothing delivered externally,
   * so a truncated payload would present imported content as human-authored
   * rather than refusing to render. The strict parse has to refuse instead.
   */
  it.each([
    ["imported", "imported"],
    ["deliveredExternallyCriterionIds", "delivery"],
  ])("refuses a summary payload missing %s", (field, container) => {
    const summary: Record<string, unknown> = {
      spec: {
        id: "spec-1",
        projectPath: "/repos/command-center",
        slug: "imported-feature",
        name: "Imported feature",
        gatePolicy: { preset: "contract-bearing" },
        abandonedAt: null,
        abandonedReason: null,
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
      phase: { primary: "delivered" },
      currentRevision: null,
      counts: { requirements: 1, criteria: 1, decisions: 0, tasks: 0 },
      pendingApprovalCount: 0,
      approvalState: "complete",
      delivery: {
        allWaived: false,
        deliveredCount: 1,
        deliveredExternallyCriterionIds: ["criterion-1"],
        provenCount: 0,
        totalInScope: 1,
      },
      linkedWork: {
        tickets: 0,
        conversations: 0,
        sessions: 0,
        workflowExecutions: 0,
        mergeJobs: 0,
      },
      imported: true,
    };
    if (container === "imported") {
      delete summary[field];
    } else {
      const delivery = { ...(summary.delivery as Record<string, unknown>) };
      delete delivery[field];
      summary.delivery = delivery;
    }

    expect(clientSpecSummaryViewSchema.safeParse(summary).success).toBe(false);
  });
});
