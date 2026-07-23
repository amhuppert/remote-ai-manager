import { describe, expect, it } from "vitest";

import type {
  DeliveryCriterion,
  RequirementStatus,
  RequirementStatusInput,
  SpecPhaseInput,
  TaskWorkStatusInput,
} from "./phase";
import {
  projectDeliveryDisplay,
  projectRequirementStatus,
  projectSpecPhase,
  projectTaskWorkStatus,
} from "./phase";

function phaseInput(overrides: Partial<SpecPhaseInput> = {}): SpecPhaseInput {
  return {
    abandoned: false,
    revisions: [revision("approved")],
    executionStates: [],
    deliveryCriteria: [{ state: "pending" }],
    deliveryPending: false,
    ...overrides,
  };
}

function revision(
  state: SpecPhaseInput["revisions"][number]["state"],
  authoringStage: SpecPhaseInput["revisions"][number]["authoringStage"] = "plan",
): SpecPhaseInput["revisions"][number] {
  return { state, authoringStage };
}

describe("spec phase projection", () => {
  it("3.1 derives the lifecycle phase instead of accepting a stored phase", () => {
    expect(
      projectSpecPhase(
        phaseInput({
          revisions: [revision("draft")],
          deliveryCriteria: [],
        }),
      ),
    ).toEqual({ primary: "draft", authoringStage: "plan" });
  });

  it("3.2 projects the ordinary Draft, In review, Approved, and Executing states", () => {
    expect(
      projectSpecPhase(phaseInput({ revisions: [revision("draft")] })).primary,
    ).toBe("draft");
    expect(
      projectSpecPhase(phaseInput({ revisions: [revision("proposed")] }))
        .primary,
    ).toBe("in_review");
    expect(projectSpecPhase(phaseInput()).primary).toBe("approved");
    expect(
      projectSpecPhase(phaseInput({ executionStates: ["definition_review"] }))
        .primary,
    ).toBe("executing");
  });

  it("3.3 gives a proposed revision precedence over an editable draft", () => {
    expect(
      projectSpecPhase(
        phaseInput({ revisions: [revision("draft"), revision("proposed")] }),
      ),
    ).toEqual({ primary: "in_review", authoringStage: "plan" });
  });

  it("3.4 reports Approved from an approved revision when no higher state matches", () => {
    expect(projectSpecPhase(phaseInput())).toEqual({ primary: "approved" });
  });

  it("3.5 treats definition review and running as active but terminal executions as inactive", () => {
    expect(
      projectSpecPhase(phaseInput({ executionStates: ["definition_review"] }))
        .primary,
    ).toBe("executing");
    expect(
      projectSpecPhase(phaseInput({ executionStates: ["running"] })).primary,
    ).toBe("executing");
    expect(
      projectSpecPhase(
        phaseInput({ executionStates: ["delivered", "abandoned"] }),
      ).primary,
    ).toBe("approved");
  });

  it("3.6 keeps Executing primary and exposes concurrent review as an authoring facet", () => {
    expect(
      projectSpecPhase(
        phaseInput({
          revisions: [revision("approved"), revision("proposed")],
          executionStates: ["running"],
        }),
      ),
    ).toEqual({ primary: "executing", authoringFacet: "in_review" });
  });

  it("3.7 reports Delivered only when every current criterion is satisfied and no delivery is pending", () => {
    const satisfied = phaseInput({
      deliveryCriteria: [{ state: "proven_and_merged" }, { state: "waived" }],
    });

    expect(projectSpecPhase(satisfied).primary).toBe("delivered");
    expect(
      projectSpecPhase({
        ...satisfied,
        deliveryCriteria: [...satisfied.deliveryCriteria, { state: "pending" }],
      }).primary,
    ).toBe("approved");
    expect(
      projectSpecPhase({ ...satisfied, deliveryPending: true }).primary,
    ).toBe("approved");
  });

  it("3.8 flags a revision delivered entirely through waivers", () => {
    expect(
      projectDeliveryDisplay([{ state: "waived" }, { state: "waived" }]),
    ).toEqual({ allWaived: true, provenCount: 0, totalInScope: 2 });
  });

  it("3.9 returns amendments against Approved or Delivered to Draft and In review", () => {
    const deliverySets: DeliveryCriterion[][] = [
      [{ state: "pending" }],
      [{ state: "proven_and_merged" }],
    ];

    for (const deliveryCriteria of deliverySets) {
      expect(
        projectSpecPhase(
          phaseInput({
            revisions: [revision("approved"), revision("draft")],
            deliveryCriteria,
          }),
        ).primary,
      ).toBe("draft");
      expect(
        projectSpecPhase(
          phaseInput({
            revisions: [revision("approved"), revision("proposed")],
            deliveryCriteria,
          }),
        ).primary,
      ).toBe("in_review");
    }
  });

  it("3.10 gives stored Abandoned terminal precedence over every other state", () => {
    expect(
      projectSpecPhase(
        phaseInput({
          abandoned: true,
          revisions: [
            revision("approved"),
            revision("proposed"),
            revision("draft"),
          ],
          executionStates: ["running"],
          deliveryCriteria: [{ state: "proven_and_merged" }],
        }),
      ),
    ).toEqual({ primary: "abandoned" });
  });

  it("3.11 exposes partial delivery as a proven/total roll-up", () => {
    expect(
      projectDeliveryDisplay([
        { state: "proven_and_merged" },
        { state: "pending" },
        { state: "waived" },
      ]),
    ).toEqual({ allWaived: false, provenCount: 1, totalInScope: 3 });
  });

  it("3.12 projects the current authoring stage until a plan-stage approval exists", () => {
    expect(
      projectSpecPhase(
        phaseInput({ revisions: [revision("approved", "requirements")] }),
      ),
    ).toEqual({ primary: "approved", authoringStage: "requirements" });
    expect(
      projectSpecPhase(
        phaseInput({
          revisions: [
            revision("approved", "requirements"),
            revision("draft", "design"),
          ],
        }),
      ),
    ).toEqual({ primary: "draft", authoringStage: "design" });
    expect(
      projectSpecPhase(
        phaseInput({
          revisions: [
            revision("approved", "requirements"),
            revision("approved", "design"),
          ],
        }),
      ),
    ).toEqual({ primary: "approved", authoringStage: "design" });
    expect(
      projectSpecPhase(
        phaseInput({
          revisions: [revision("approved", "plan"), revision("draft", "plan")],
        }),
      ),
    ).toEqual({ primary: "draft" });
  });
});

describe("requirement status projection", () => {
  const cases: Array<{
    name: string;
    input: RequirementStatusInput;
    expected: RequirementStatus;
  }> = [
    {
      name: "unapproved, uncovered, and pending",
      input: {
        approvalValidity: null,
        criteria: [
          { covered: false, proof: "pending" },
          { covered: false, proof: "pending" },
        ],
      },
      expected: {
        approval: "unapproved",
        coverage: "uncovered",
        proof: "pending",
      },
    },
    {
      name: "stale, partially covered, and partially proven",
      input: {
        approvalValidity: "stale",
        criteria: [
          { covered: true, proof: "proven" },
          { covered: false, proof: "pending" },
        ],
      },
      expected: {
        approval: "stale",
        coverage: "partial",
        proof: "partial",
      },
    },
    {
      name: "valid, covered, and satisfied by proof plus waiver",
      input: {
        approvalValidity: "valid",
        criteria: [
          { covered: true, proof: "proven" },
          { covered: true, proof: "waived" },
        ],
      },
      expected: {
        approval: "valid",
        coverage: "covered",
        proof: "proven_and_waived",
      },
    },
  ];

  it.each(cases)("derives $name", ({ input, expected }) => {
    expect(projectRequirementStatus(input)).toEqual(expected);
  });
});

describe("task work status projection", () => {
  it("uses the latest execution task event when no claim exists", () => {
    expect(
      projectTaskWorkStatus({
        executionEvents: [{ status: "pending" }, { status: "running" }],
        latestClaim: null,
      }),
    ).toEqual({ status: "running", claimEvidenceIds: [] });
  });

  it("projects accepted and reopened completion claims with their evidence", () => {
    expect(
      projectTaskWorkStatus({
        executionEvents: [{ status: "completed" }],
        latestClaim: { status: "accepted", evidenceIds: ["evidence-1"] },
      }),
    ).toEqual({ status: "claimed", claimEvidenceIds: ["evidence-1"] });
    expect(
      projectTaskWorkStatus({
        executionEvents: [{ status: "completed" }],
        latestClaim: { status: "reopened", evidenceIds: ["evidence-1"] },
      }),
    ).toEqual({ status: "reopened", claimEvidenceIds: ["evidence-1"] });
  });

  it("never derives task work status from criterion dispositions", () => {
    const input: TaskWorkStatusInput & {
      criterionDispositions: string[];
    } = {
      executionEvents: [{ status: "pending" }],
      latestClaim: null,
      criterionDispositions: ["waived", "delivered_elsewhere"],
    };

    expect(projectTaskWorkStatus(input)).toEqual({
      status: "pending",
      claimEvidenceIds: [],
    });
  });
});
