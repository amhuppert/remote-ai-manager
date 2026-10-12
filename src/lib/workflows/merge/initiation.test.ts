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
      readCurrentRuns: () => [],
      readBackgroundWork: () => [],
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
    readCurrentRuns: () => [],
    readBackgroundWork: () => [],
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

describe("a session one of whose runs is not finished", () => {
  const noDelivery = {
    association: { resolve: () => ({ kind: "none" as const }) },
    gate: {
      async evaluate(): Promise<never> {
        throw new Error("no delivery is associated");
      },
    },
  };

  it("refuses the merge, naming the run and how to clear it", async () => {
    const result = await evaluateMergeInitiation({
      projectPath: "/project",
      sessionName: "session",
      surface: "merge-route",
      readActiveExecution: async () => null,
      readCurrentRuns: (projectPath, sessionName) =>
        projectPath === "/project" && sessionName === "session"
          ? [{ runId: "run-1", sessionName: "session", progress: "paused" }]
          : [],
      readBackgroundWork: () => [],
      ...noDelivery,
    });

    expect(result).toMatchObject({
      admitted: false,
      refusal: { code: "RUN_CURRENT", runId: "run-1", progress: "paused" },
    });
    if (result.admitted) return;
    expect(result.refusal.message).toContain("run-1");
  });

  it("admits the merge once every run of the session has finished", async () => {
    const result = await evaluateMergeInitiation({
      projectPath: "/project",
      sessionName: "session",
      surface: "merge-route",
      readActiveExecution: async () => null,
      readCurrentRuns: () => [],
      readBackgroundWork: () => [],
      ...noDelivery,
    });

    expect(result).toEqual({ admitted: true });
  });
});

describe("a session one of whose conversations keeps background work running (design C5b §5)", () => {
  const noDelivery = {
    association: { resolve: () => ({ kind: "none" as const }) },
    gate: {
      async evaluate(): Promise<never> {
        throw new Error("no delivery is associated");
      },
    },
  };

  it("refuses the merge, naming the conversation and saying to stop it or wait", async () => {
    const result = await evaluateMergeInitiation({
      projectPath: "/project",
      sessionName: "session",
      surface: "merge-route",
      readActiveExecution: async () => null,
      readCurrentRuns: () => [],
      readBackgroundWork: (projectPath, sessionName) =>
        projectPath === "/project" && sessionName === "session"
          ? [
              {
                conversationId: "conv-1",
                conversationName: "Suite runner",
                unconfirmed: null,
              },
              {
                conversationId: "conv-2",
                conversationName: null,
                unconfirmed: null,
              },
            ]
          : [],
      ...noDelivery,
    });

    expect(result).toMatchObject({
      admitted: false,
      refusal: { code: "BACKGROUND_WORK_RUNNING", conversationId: "conv-1" },
    });
    if (result.admitted) return;
    expect(result.refusal.message).toContain('conversation "Suite runner"');
    expect(result.refusal.message).toContain("1 other conversation");
    expect(result.refusal.message).toMatch(/stop it .* or wait/i);
  });

  it("names a conversation without a name by its id", async () => {
    const result = await evaluateMergeInitiation({
      projectPath: "/project",
      sessionName: "session",
      surface: "merge-command",
      readActiveExecution: async () => null,
      readCurrentRuns: () => [],
      readBackgroundWork: () => [
        { conversationId: "conv-2", conversationName: null, unconfirmed: null },
      ],
      ...noDelivery,
    });

    if (result.admitted) throw new Error("admitted");
    expect(result.refusal.message).toContain("conversation conv-2");
  });
});

describe("a session whose conversation's background work could not be confirmed stopped (design C5b §5)", () => {
  it("refuses the merge, saying the processes are unconfirmed and how to collect them", async () => {
    const result = await evaluateMergeInitiation({
      projectPath: "/project",
      sessionName: "session",
      surface: "merge-route",
      readActiveExecution: async () => null,
      readCurrentRuns: () => [],
      readBackgroundWork: () => [
        {
          conversationId: "conv-1",
          conversationName: "Suite runner",
          unconfirmed: "the CLI did not exit",
        },
      ],
      association: { resolve: () => ({ kind: "none" as const }) },
      gate: {
        async evaluate(): Promise<never> {
          throw new Error("no delivery is associated");
        },
      },
    });

    if (result.admitted) throw new Error("admitted");
    expect(result.refusal).toMatchObject({
      code: "BACKGROUND_WORK_RUNNING",
      conversationId: "conv-1",
    });
    expect(result.refusal.message).toContain("could not be confirmed stopped");
    expect(result.refusal.message).toContain("the CLI did not exit");
    expect(result.refusal.message).toMatch(/restart the server/i);
  });
});
