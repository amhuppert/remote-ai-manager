import { describe, expect, it } from "vitest";
import { evaluateMergeInitiation } from "./initiation";

describe("merge initiation", () => {
  it("returns the pinned delivery review and every known blocker before a merge is dispatched", async () => {
    const result = await evaluateMergeInitiation({
      projectPath: "/project",
      projectName: "project",
      sessionName: "session",
      surface: "merge-command",
      readActiveExecution: async () => null,
      association: {
        resolve: () => ({
          kind: "linked",
          specExecutionId: "spec-execution",
          finalPublish: true,
        }),
      },
      gate: {
        evaluate: async () => ({
          status: "refused",
          spec: {
            specSlug: "delivery",
            specName: "Delivery",
            projectName: "Project",
          },
          unmet: [
            {
              criterionId: "approval",
              criterionHandle: "delivery",
              outcome: "approval_required",
              reason: "Delivery approval is required.",
            },
            {
              criterionId: "criterion",
              criterionHandle: "AC1",
              outcome: "missing",
              reason: "AC1 needs review.",
            },
          ],
          instruction: "Review delivery.",
        }),
      },
    });
    expect(result).toMatchObject({
      admitted: false,
      refusal: {
        code: "SPEC_DELIVERY_REVIEW_REQUIRED",
        reviewUrl:
          "/specs/project/delivery?el=delivery&execution=spec-execution&mergeSession=session",
        blockers: ["Delivery approval is required.", "AC1 needs review."],
      },
    });
  });
});

it("links an unlaunched execution directly to its delivery continuation review", async () => {
  const result = await evaluateMergeInitiation({
    projectPath: "/project",
    projectName: "project",
    sessionName: "session",
    surface: "merge-command",
    readActiveExecution: async () => null,
    association: {
      resolve: () => ({
        kind: "refused",
        specExecutionId: "unlaunched",
        reason: "No delivery path selected.",
        instruction: "Choose a delivery path.",
      }),
    },
    gate: {
      async evaluate() {
        return {
          status: "refused",
          spec: {
            specSlug: "delivery",
            specName: "Delivery",
            projectName: "Project",
          },
          unmet: [
            {
              criterionId: "unlaunched",
              criterionHandle: "delivery",
              outcome: "execution_not_started",
              reason: "Choose session delivery or launch the graph.",
            },
          ],
          instruction: "Open delivery review.",
        };
      },
    },
  });
  expect(result).toMatchObject({
    admitted: false,
    refusal: {
      reviewUrl:
        "/specs/project/delivery?el=delivery&execution=unlaunched&mergeSession=session",
    },
  });
});
