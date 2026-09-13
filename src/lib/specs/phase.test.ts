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
  it("counts accepted merged delivery separately from automated proof", () => {
    const display = projectDeliveryDisplay([
      { criterionElementId: "human-criterion", state: "accepted_and_merged" },
    ]);
    expect(display).toMatchObject({
      deliveredCount: 1,
      provenCount: 0,
      deliveredExternallyCriterionIds: [],
    });
  });
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
      projectDeliveryDisplay([
        { criterionElementId: "criterion-1", state: "waived" },
        { criterionElementId: "criterion-2", state: "waived" },
      ]),
    ).toEqual({
      allWaived: true,
      deliveredCount: 0,
      deliveredExternallyCriterionIds: [],
      provenCount: 0,
      totalInScope: 2,
    });
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
        { criterionElementId: "criterion-1", state: "proven_and_merged" },
        { criterionElementId: "criterion-2", state: "pending" },
        { criterionElementId: "criterion-3", state: "waived" },
      ]),
    ).toEqual({
      allWaived: false,
      deliveredCount: 1,
      deliveredExternallyCriterionIds: [],
      provenCount: 1,
      totalInScope: 3,
    });
  });

  /**
   * An imported spec's delivery happened outside this system, so it counts as
   * delivered and never as proven: the two tallies are separate fields exactly
   * so a surface labelled "proof" cannot render external testimony as a merged
   * proof (R9.2).
   */
  it("counts an externally-delivered criterion as delivered but never as proven", () => {
    expect(
      projectDeliveryDisplay([
        { criterionElementId: "criterion-1", state: "delivered_externally" },
        { criterionElementId: "criterion-2", state: "delivered_externally" },
      ]),
    ).toEqual({
      allWaived: false,
      deliveredCount: 2,
      deliveredExternallyCriterionIds: ["criterion-1", "criterion-2"],
      provenCount: 0,
      totalInScope: 2,
    });
    expect(
      projectDeliveryDisplay([
        { criterionElementId: "criterion-1", state: "proven_and_merged" },
        { criterionElementId: "criterion-2", state: "delivered_externally" },
        { criterionElementId: "criterion-3", state: "pending" },
      ]),
    ).toEqual({
      allWaived: false,
      deliveredCount: 2,
      deliveredExternallyCriterionIds: ["criterion-2"],
      provenCount: 1,
      totalInScope: 3,
    });
  });

  /**
   * A tally cannot tell a surface WHICH criterion rests on external testimony,
   * and a surface that had to re-derive that from the tally would be guessing.
   * The display names them so the detail can render exactly those criteria as
   * delivered externally and no others (R9.4).
   */
  it("names the externally-delivered criteria beside the tallies", () => {
    expect(
      projectDeliveryDisplay([
        { criterionElementId: "criterion-1", state: "delivered_externally" },
        { criterionElementId: "criterion-2", state: "proven_and_merged" },
        { criterionElementId: "criterion-3", state: "pending" },
        { criterionElementId: "criterion-4", state: "waived" },
      ]),
    ).toEqual({
      allWaived: false,
      deliveredCount: 2,
      deliveredExternallyCriterionIds: ["criterion-1"],
      provenCount: 1,
      totalInScope: 4,
    });
  });

  it("names no criterion when nothing was delivered externally", () => {
    expect(
      projectDeliveryDisplay([
        { criterionElementId: "criterion-1", state: "proven_and_merged" },
      ]).deliveredExternallyCriterionIds,
    ).toEqual([]);
  });

  it("reports Delivered for a revision whose criteria are all delivered externally", () => {
    expect(
      projectSpecPhase(
        phaseInput({
          deliveryCriteria: [
            { state: "delivered_externally" },
            { state: "delivered_externally" },
          ],
        }),
      ).primary,
    ).toBe("delivered");
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
    {
      name: "valid, covered, and settled entirely by external delivery",
      input: {
        approvalValidity: "valid",
        criteria: [
          { covered: true, proof: "delivered_externally" },
          { covered: true, proof: "delivered_externally" },
        ],
      },
      expected: {
        approval: "valid",
        coverage: "covered",
        proof: "delivered_externally",
      },
    },
    {
      /**
       * The weakest warrant names the rollup. A requirement holding one proven
       * criterion and one that rests on an import's testimony is fully settled,
       * but calling it proven would extend this system's proof to a criterion
       * nothing here ever verified (R9.4).
       */
      name: "valid and covered, mixing merged proof with external delivery",
      input: {
        approvalValidity: "valid",
        criteria: [
          { covered: true, proof: "proven" },
          { covered: true, proof: "delivered_externally" },
        ],
      },
      expected: {
        approval: "valid",
        coverage: "covered",
        proof: "delivered_externally",
      },
    },
    {
      name: "partial while external delivery leaves a criterion unsettled",
      input: {
        approvalValidity: "valid",
        criteria: [
          { covered: true, proof: "delivered_externally" },
          { covered: true, proof: "pending" },
        ],
      },
      expected: {
        approval: "valid",
        coverage: "covered",
        proof: "partial",
      },
    },
  ];

  it.each(cases)("derives $name", ({ input, expected }) => {
    expect(projectRequirementStatus(input)).toEqual(expected);
  });
});

describe("task work status projection", () => {
  it("uses the latest execution task event", () => {
    expect(
      projectTaskWorkStatus({
        executionEvents: [{ status: "pending" }, { status: "running" }],
      }),
    ).toEqual({ status: "running" });
  });

  it("never derives task work status from criterion dispositions", () => {
    const input: TaskWorkStatusInput & {
      criterionDispositions: string[];
    } = {
      executionEvents: [{ status: "pending" }],
      criterionDispositions: ["waived", "delivered_elsewhere"],
    };

    expect(projectTaskWorkStatus(input)).toEqual({ status: "pending" });
  });
});
