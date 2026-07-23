import { describe, expect, it } from "vitest";

import type { RevisionElement as LintRevisionElement } from "./lint";
import type { RevisionElement as DiffRevisionElement } from "./revision-diff";
import type {
  ActorProvenance,
  SpecGate,
  SpecGateDial,
  SpecGatePolicy,
  SpecGatePreset,
} from "./schemas";
import type { ExecutionScope, ScopePlan } from "./scope-validation";
import {
  admitDraftWrite,
  advanceAuthoringStage,
  approveElement,
  changePolicy,
  claimTaskComplete,
  consultedAuthoringGates,
  evaluateDeliveryGate,
  grantWaiver,
  openDraftAuthoringStage,
  propose,
  signOffRevision,
  startExecution,
  type SignOffReviewSnapshot,
} from "./transitions";
import { resolveDial } from "./policy";

const human: ActorProvenance = { kind: "human" };
const agent: ActorProvenance = {
  kind: "agent",
  conversationId: "conversation-1",
};

const requirementPayload = {
  kind: "requirement" as const,
  statement: "Transitions cannot bypass the floor.",
  priority: "must" as const,
  risk: "high" as const,
};
const criterionPayload = {
  kind: "criterion" as const,
  text: "Every floor rule is enforced.",
  validationStrategy: { kinds: ["test_run" as const] },
};
const decisionPayload = {
  kind: "decision" as const,
  title: "Pure predicates",
  chosenApproach: "Use fully loaded snapshots.",
  rejectedAlternatives: [],
  reason: "One authority prevents bypasses.",
  tracedRequirementElementIds: ["requirement-1"],
};
const taskPayload = {
  kind: "task" as const,
  title: "Implement predicates",
  instructions: "Implement the pure transition predicates.",
  tracedRequirementElementIds: ["requirement-1"],
  tracedDecisionElementIds: ["decision-1"],
  coveredCriterionElementIds: ["criterion-1"],
  dependsOnTaskElementIds: [],
};

function lintElement(
  id: string,
  handle: string,
  payload:
    | typeof requirementPayload
    | typeof criterionPayload
    | typeof decisionPayload
    | typeof taskPayload,
  parentElementId?: string,
): LintRevisionElement {
  return {
    id,
    handle,
    parentElementId,
    payloadHash: `${id}-hash`,
    payload,
  };
}

const lintElements = (): LintRevisionElement[] => [
  lintElement("requirement-1", "R1", requirementPayload),
  lintElement("criterion-1", "R1.1", criterionPayload, "requirement-1"),
  lintElement("decision-1", "D1", decisionPayload),
  lintElement("task-1", "T1", taskPayload),
];

function diffElement(
  elementId: string,
  payload:
    | typeof requirementPayload
    | typeof criterionPayload
    | typeof decisionPayload
    | typeof taskPayload,
  parentElementId: string | null = null,
): DiffRevisionElement {
  return {
    elementId,
    parentElementId,
    payloadHash: `${elementId}-hash`,
    payload,
  };
}

const revisionRows = (): DiffRevisionElement[] => [
  diffElement("requirement-1", requirementPayload),
  diffElement("criterion-1", criterionPayload, "requirement-1"),
  diffElement("decision-1", decisionPayload),
  diffElement("task-1", taskPayload),
];

const plan: ScopePlan = {
  tasks: [
    {
      id: "task-1",
      handle: "T1",
      dependsOnTaskIds: [],
      coveredCriterionIds: ["criterion-1"],
    },
  ],
  criteria: [{ id: "criterion-1", handle: "R1.1" }],
};

const scope: ExecutionScope = {
  selectedTaskIds: ["task-1"],
  selectedCriterionIds: ["criterion-1"],
  exclusionDispositions: [],
};

const contractPolicy: SpecGatePolicy = { preset: "contract-bearing" };

function reviewSnapshot(): SignOffReviewSnapshot {
  return {
    revisionId: "revision-2",
    baseRevisionRows: revisionRows(),
    revisionRows: revisionRows(),
    blockingThreads: [],
    approvals: [
      {
        subjectKind: "requirement" as const,
        elementId: "requirement-1",
        revisionId: "revision-1",
        validity: "valid" as const,
      },
      {
        subjectKind: "decision" as const,
        elementId: "decision-1",
        revisionId: "revision-1",
        validity: "valid" as const,
      },
      {
        subjectKind: "plan" as const,
        revisionId: "revision-1",
        validity: "valid" as const,
      },
    ],
  };
}

function signOffContext(
  overrides: Partial<Parameters<typeof signOffRevision>[0]> = {},
): Parameters<typeof signOffRevision>[0] {
  const authoringStage = overrides.authoringStage ?? "plan";
  return {
    actor: human,
    revisionState: "proposed",
    authoringStage,
    policy: contractPolicy,
    draft: {
      specHandle: "native-sdd",
      authoringStage,
      elements: lintElements(),
    },
    records: {},
    review: reviewSnapshot(),
    ...overrides,
  };
}

function startContext(
  policy: SpecGatePolicy,
  overrides: Partial<Parameters<typeof startExecution>[0]> = {},
): Parameters<typeof startExecution>[0] {
  return {
    policy,
    specAbandoned: false,
    revisionId: "revision-2",
    revisionState: "approved",
    authoringStage: "plan",
    scope,
    plan,
    activeExecution: false,
    ...overrides,
  };
}

function claimContext(
  policy: SpecGatePolicy,
  hasEvidence = true,
): Parameters<typeof claimTaskComplete>[0] {
  return {
    policy,
    draft: {
      specHandle: "native-sdd",
      authoringStage: "plan",
      elements: lintElements(),
    },
    records: {
      pendingTaskClaims: [{ taskElementId: "task-1" }],
      evidence: hasEvidence
        ? [{ evidenceId: "evidence-1", criterionElementId: "criterion-1" }]
        : [],
    },
  };
}

function deliveryContext(
  policy: SpecGatePolicy,
  overrides: Partial<Parameters<typeof evaluateDeliveryGate>[0]> = {},
): Parameters<typeof evaluateDeliveryGate>[0] {
  return {
    policy,
    executionState: "running",
    pinnedRevisionId: "revision-2",
    pinnedScope: scope,
    deliveryApprovalGranted: true,
    criteria: [
      {
        criterionId: "criterion-1",
        handle: "R1.1",
        validProof: true,
        waiver: null,
        deliveredByMergedExecution: false,
      },
    ],
    ...overrides,
  };
}

const gates: SpecGate[] = [
  "requirements",
  "design",
  "plan",
  "execution_start",
  "delivery",
];
const presets: SpecGatePreset[] = [
  "contract-bearing",
  "exploratory",
  "fast-path",
];
const overrideValues: Array<SpecGateDial | undefined> = [
  undefined,
  "gate",
  "notify",
  "off",
];

function allPolicies(): SpecGatePolicy[] {
  const policies: SpecGatePolicy[] = [];

  for (const preset of presets) {
    const visit = (
      gateIndex: number,
      overrides: Partial<Record<SpecGate, SpecGateDial>>,
    ): void => {
      if (gateIndex === gates.length) {
        policies.push({
          preset,
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
        });
        return;
      }

      const gate = gates[gateIndex]!;
      for (const value of overrideValues) {
        if (value === undefined) {
          visit(gateIndex + 1, overrides);
          continue;
        }
        visit(gateIndex + 1, { ...overrides, [gate]: value });
      }
    };

    visit(0, {});
  }

  return policies;
}

const policyCases = allPolicies();

describe("transition predicates", () => {
  describe("staged authoring", () => {
    it.each([
      ["requirements", "requirement", undefined],
      ["requirements", "section", "context"],
      ["design", "decision", undefined],
      ["design", "section", "design_narrative"],
      ["plan", "task", undefined],
      ["plan", "requirement", undefined],
    ] as const)(
      "admits %s-stage writes of %s",
      (stage, elementKind, sectionRole) => {
        expect(
          admitDraftWrite(stage, elementKind, sectionRole, {
            requirements: "gate",
            design: "gate",
            plan: "gate",
          }),
        ).toEqual({ ok: true });
      },
    );

    it("refuses a downstream write and phrases the next step from the current dial", () => {
      expect(
        admitDraftWrite("requirements", "task", undefined, {
          requirements: "gate",
          design: "gate",
          plan: "gate",
        }),
      ).toEqual({
        ok: false,
        refusal: {
          code: "stage_blocked",
          unmetConditions: [
            "A task cannot be authored during the requirements stage.",
          ],
          instruction:
            "Propose the requirements stage and obtain sign-off before authoring task content.",
        },
      });
      expect(
        admitDraftWrite("design", "task", undefined, {
          requirements: "notify",
          design: "notify",
          plan: "notify",
        }),
      ).toMatchObject({
        ok: false,
        refusal: {
          instruction: expect.stringContaining("Advance"),
        },
      });
    });

    it("opens stages from policy and base revision state", () => {
      expect(
        openDraftAuthoringStage({ policy: { preset: "contract-bearing" } }),
      ).toBe("requirements");
      expect(openDraftAuthoringStage({ policy: { preset: "fast-path" } })).toBe(
        "plan",
      );
      expect(
        openDraftAuthoringStage({
          policy: {
            preset: "fast-path",
            overrides: { design: "notify" },
          },
        }),
      ).toBe("requirements");
      expect(
        openDraftAuthoringStage({
          policy: contractPolicy,
          baseRevision: { state: "approved", authoringStage: "requirements" },
        }),
      ).toBe("design");
      expect(
        openDraftAuthoringStage({
          policy: contractPolicy,
          baseRevision: { state: "approved", authoringStage: "plan" },
        }),
      ).toBe("plan");
      expect(
        openDraftAuthoringStage({
          policy: contractPolicy,
          baseRevision: { state: "withdrawn", authoringStage: "design" },
        }),
      ).toBe("design");
    });

    it("advances only under Notify or Off and refuses advancing past plan", () => {
      expect(
        advanceAuthoringStage("requirements", contractPolicy),
      ).toMatchObject({
        ok: false,
        refusal: { code: "human_act_required" },
      });
      expect(
        advanceAuthoringStage("requirements", { preset: "exploratory" }),
      ).toEqual({ ok: true });
      expect(
        advanceAuthoringStage("plan", { preset: "exploratory" }),
      ).toMatchObject({
        ok: false,
        refusal: { code: "gate_blocked" },
      });
    });

    it("consults the revision stage plus every modified earlier stage", () => {
      const base = revisionRows();
      const draft = revisionRows();
      draft[0] = { ...draft[0]!, payloadHash: "requirement-changed" };

      expect(consultedAuthoringGates("plan", base, draft)).toEqual([
        "requirements",
        "plan",
      ]);
      expect(consultedAuthoringGates("design", base, base)).toEqual(["design"]);
    });

    it("counts added and removed earlier-stage elements as modifications", () => {
      const base = revisionRows();
      const withoutDecision = base.filter(
        (row) => row.elementId !== "decision-1",
      );
      const withAddedRequirement = [
        ...withoutDecision,
        diffElement("requirement-2", requirementPayload),
      ];

      expect(
        consultedAuthoringGates("plan", base, withAddedRequirement),
      ).toEqual(["requirements", "design", "plan"]);
    });
  });

  describe("propose", () => {
    it("returns the lint panel findings when blocking lint refuses a draft", () => {
      const decision = propose({
        revisionState: "draft",
        authoringStage: "plan",
        policy: contractPolicy,
        draft: {
          specHandle: "native-sdd",
          authoringStage: "plan",
          elements: [],
        },
        records: {},
        review: reviewSnapshot(),
      });

      expect(decision).toEqual({
        ok: false,
        refusal: {
          code: "lint_blocked",
          unmetConditions: ["Empty spec — nothing to review."],
          findings: [
            {
              ruleId: "9.2.empty-spec",
              severity: "blocks_propose",
              elementHandle: "native-sdd",
              message: "Empty spec — nothing to review.",
            },
          ],
          instruction: "Resolve the blocking lint findings and propose again.",
        },
      });
    });

    it("refuses proposing a non-draft revision", () => {
      expect(
        propose({
          revisionState: "proposed",
          authoringStage: "plan",
          policy: contractPolicy,
          draft: {
            specHandle: "native-sdd",
            authoringStage: "plan",
            elements: lintElements(),
          },
          records: {},
          review: reviewSnapshot(),
        }),
      ).toMatchObject({
        ok: false,
        refusal: { code: "gate_blocked" },
      });
    });

    it.each([
      {
        name: "the default fast-path policy",
        policy: { preset: "fast-path" } satisfies SpecGatePolicy,
      },
      {
        name: "an overridden fast-path policy that retains a Combined Gate",
        policy: {
          preset: "fast-path",
          overrides: { plan: "notify" },
        } satisfies SpecGatePolicy,
      },
    ])("allows $name to reach human combined review", ({ policy }) => {
      expect(
        propose({
          revisionState: "draft",
          authoringStage: "plan",
          policy,
          draft: {
            specHandle: "native-sdd",
            authoringStage: "plan",
            elements: lintElements(),
          },
          records: {},
          review: reviewSnapshot(),
        }),
      ).toEqual({ ok: true });
    });

    it("absorbs sign-off only when fast-path overrides make every proposal dial Notify or Off", () => {
      const review = reviewSnapshot();
      review.blockingThreads.push({ handle: "thread-1", resolved: false });

      expect(
        propose({
          revisionState: "draft",
          authoringStage: "plan",
          policy: {
            preset: "fast-path",
            overrides: {
              requirements: "notify",
              design: "off",
              plan: "notify",
            },
          },
          draft: {
            specHandle: "native-sdd",
            authoringStage: "plan",
            elements: lintElements(),
          },
          records: {},
          review,
        }),
      ).toMatchObject({
        ok: false,
        refusal: {
          code: "gate_blocked",
          unmetConditions: ["Blocking thread thread-1 is unresolved."],
        },
      });
    });
  });

  describe("approveElement", () => {
    it("refuses an agent even when policy says off", () => {
      expect(
        approveElement({
          actor: agent,
          revisionState: "proposed",
          subjectKind: "requirement",
        }),
      ).toEqual({
        ok: false,
        refusal: {
          code: "human_act_required",
          unmetConditions: ["Element approval is a human-only act."],
          instruction: "Ask a human to approve the element in Spec Studio.",
        },
      });
    });

    it("refuses element approval outside review", () => {
      expect(
        approveElement({
          actor: human,
          revisionState: "draft",
          subjectKind: "requirement",
        }),
      ).toMatchObject({
        ok: false,
        refusal: { code: "gate_blocked" },
      });
    });
  });

  describe("signOffRevision", () => {
    it("refuses unresolved blocking threads", () => {
      const review = reviewSnapshot();
      review.blockingThreads.push({ handle: "thread-1", resolved: false });

      expect(signOffRevision(signOffContext({ review }))).toMatchObject({
        ok: false,
        refusal: {
          code: "gate_blocked",
          unmetConditions: ["Blocking thread thread-1 is unresolved."],
        },
      });
    });

    it("refuses a rejected assumption still cited by content", () => {
      const elements = lintElements();
      elements[2] = {
        ...elements[2]!,
        citations: [
          { kind: "assumption", assumptionId: "assumption-1", handle: "A1" },
        ],
      };

      expect(
        signOffRevision(
          signOffContext({
            draft: {
              specHandle: "native-sdd",
              authoringStage: "plan",
              elements,
            },
            records: {
              assumptions: [
                {
                  assumptionId: "assumption-1",
                  handle: "A1",
                  disposition: "rejected",
                },
              ],
            },
          }),
        ),
      ).toMatchObject({
        ok: false,
        refusal: {
          code: "lint_blocked",
          findings: [
            {
              ruleId: "9.8.rejected-cited-assumption",
              severity: "blocks_signoff",
            },
          ],
        },
      });
    });

    it.each([
      ["requirements", "requirement"],
      ["design", "decision"],
      ["plan", "plan"],
    ] as const)(
      "refuses missing %s approvals configured as Gate",
      (authoringStage, subjectKind) => {
        const review = reviewSnapshot();
        review.approvals = review.approvals.filter(
          (approval) => approval.subjectKind !== subjectKind,
        );

        expect(
          signOffRevision(signOffContext({ authoringStage, review })),
        ).toMatchObject({
          ok: false,
          refusal: { code: "gate_blocked" },
        });
      },
    );

    it("treats a human sign-off as the fast-path combined approval", () => {
      const review = reviewSnapshot();
      review.approvals = [];

      expect(
        signOffRevision(
          signOffContext({ policy: { preset: "fast-path" }, review }),
        ),
      ).toEqual({ ok: true });
    });

    it("refuses a fast-path sign-off by an agent", () => {
      expect(
        signOffRevision(
          signOffContext({ policy: { preset: "fast-path" }, actor: agent }),
        ),
      ).toMatchObject({
        ok: false,
        refusal: { code: "human_act_required" },
      });
    });

    it("requires a current approval after a direct revision change", () => {
      const review = reviewSnapshot();
      review.revisionRows[0] = {
        ...review.revisionRows[0]!,
        payloadHash: "requirement-1-changed",
      };

      expect(signOffRevision(signOffContext({ review }))).toMatchObject({
        ok: false,
        refusal: {
          code: "gate_blocked",
          unmetConditions: [
            "Requirement R1 needs a valid approval for revision-2.",
          ],
        },
      });
    });

    it("requires plan approval only for a plan-stage revision", () => {
      const review = reviewSnapshot();
      review.approvals = review.approvals.filter(
        (approval) => approval.subjectKind !== "plan",
      );

      expect(
        signOffRevision(signOffContext({ authoringStage: "design", review })),
      ).toEqual({ ok: true });
      expect(
        signOffRevision(signOffContext({ authoringStage: "plan", review })),
      ).toMatchObject({
        ok: false,
        refusal: {
          unmetConditions: [
            "Execution plan needs a valid approval for revision-2.",
          ],
        },
      });
    });

    it("re-consults an earlier gate when that stage's content changed", () => {
      const review = reviewSnapshot();
      review.revisionRows[0] = {
        ...review.revisionRows[0]!,
        payloadHash: "requirement-changed",
      };
      review.approvals = review.approvals.filter(
        (approval) => approval.subjectKind !== "requirement",
      );

      expect(
        signOffRevision(signOffContext({ authoringStage: "design", review })),
      ).toMatchObject({
        ok: false,
        refusal: {
          unmetConditions: [
            "Requirement R1 needs a valid approval for revision-2.",
          ],
        },
      });
    });
  });

  describe("startExecution", () => {
    it("refuses an abandoned spec as terminal", () => {
      expect(
        startExecution(startContext(contractPolicy, { specAbandoned: true })),
      ).toMatchObject({
        ok: false,
        refusal: { code: "gate_blocked" },
      });
    });

    it("refuses an unapproved revision", () => {
      expect(
        startExecution(
          startContext(contractPolicy, { revisionState: "proposed" }),
        ),
      ).toMatchObject({
        ok: false,
        refusal: { code: "revision_not_approved" },
      });
    });

    it("refuses an approved revision that has not completed plan authoring", () => {
      expect(
        startExecution(
          startContext(contractPolicy, { authoringStage: "design" }),
        ),
      ).toEqual({
        ok: false,
        refusal: {
          code: "gate_blocked",
          unmetConditions: [
            "The pinned revision has not completed plan-stage authoring.",
          ],
          instruction:
            "Complete plan-stage authoring and sign off that revision before starting execution.",
        },
      });
    });

    it("refuses a second active execution including definition review", () => {
      expect(
        startExecution(startContext(contractPolicy, { activeExecution: true })),
      ).toMatchObject({
        ok: false,
        refusal: { code: "execution_active" },
      });
    });

    it("returns scope-validation defects under the shared refusal shape", () => {
      const invalidScope = { ...scope, selectedCriterionIds: [] };

      expect(
        startExecution(startContext(contractPolicy, { scope: invalidScope })),
      ).toMatchObject({
        ok: false,
        refusal: {
          code: "invalid_scope",
          unmetConditions: [
            "Execution scope selects no criteria to deliver.",
            "Excluded criterion R1.1 needs a deferred, delivered_elsewhere, or waived disposition.",
          ],
        },
      });
    });
  });

  describe("claimTaskComplete", () => {
    it("returns blocks-claim lint findings", () => {
      expect(
        claimTaskComplete(claimContext(contractPolicy, false)),
      ).toMatchObject({
        ok: false,
        refusal: {
          code: "lint_blocked",
          findings: [
            { ruleId: "9.7.claim-without-evidence", severity: "blocks_claim" },
          ],
        },
      });
    });
  });

  describe("grantWaiver", () => {
    it("refuses an agent and an empty reason", () => {
      expect(
        grantWaiver({
          actor: agent,
          reason: "  ",
          existingWaiver: false,
        }),
      ).toEqual({
        ok: false,
        refusal: {
          code: "human_act_required",
          unmetConditions: [
            "Waiver grant is a human-only act.",
            "A waiver requires a reason.",
          ],
          instruction:
            "Ask a human to grant the waiver with a reason in Spec Studio.",
        },
      });
    });

    it("refuses a duplicate criterion-revision waiver", () => {
      expect(
        grantWaiver({
          actor: human,
          reason: "Accepted risk.",
          existingWaiver: true,
        }),
      ).toMatchObject({
        ok: false,
        refusal: { code: "gate_blocked" },
      });
    });
  });

  describe("changePolicy", () => {
    it("is human-only", () => {
      expect(
        changePolicy({
          actor: agent,
          currentPolicy: contractPolicy,
          proposedPolicy: { preset: "exploratory" },
          hardConfirmed: true,
        }),
      ).toMatchObject({
        ok: false,
        refusal: { code: "human_act_required" },
      });
    });

    it("requires hard confirmation for a preset switch or loosening", () => {
      expect(
        changePolicy({
          actor: human,
          currentPolicy: contractPolicy,
          proposedPolicy: { preset: "exploratory" },
          hardConfirmed: false,
        }),
      ).toMatchObject({
        ok: false,
        refusal: { code: "human_act_required" },
      });
    });

    it("refuses a delivery Off value rather than storing a misleading override", () => {
      expect(
        changePolicy({
          actor: human,
          currentPolicy: contractPolicy,
          proposedPolicy: {
            preset: "contract-bearing",
            overrides: { delivery: "off" },
          },
          hardConfirmed: true,
        }),
      ).toMatchObject({
        ok: false,
        refusal: { code: "gate_blocked" },
      });
    });
  });

  describe("evaluateDeliveryGate", () => {
    it("refuses a terminal execution before evaluating otherwise-satisfied criteria", () => {
      expect(
        evaluateDeliveryGate(
          deliveryContext(contractPolicy, { executionState: "abandoned" }),
        ),
      ).toMatchObject({
        ok: false,
        refusal: { code: "gate_blocked" },
      });
    });

    it("refuses a selected criterion without proof, a valid waiver, or prior delivery", () => {
      expect(
        evaluateDeliveryGate(
          deliveryContext(contractPolicy, {
            criteria: [
              {
                criterionId: "criterion-1",
                handle: "R1.1",
                validProof: false,
                waiver: null,
                deliveredByMergedExecution: false,
              },
            ],
          }),
        ),
      ).toEqual({
        ok: false,
        refusal: {
          code: "delivery_gate_failed",
          unmetConditions: [
            "R1.1 needs valid proof, a valid human waiver for revision-2, or prior merged delivery.",
          ],
          instruction:
            "Re-dispatch validation against the prepared candidate, obtain any required human waiver, or repair the delivery scope before merging.",
        },
      });
    });

    it("accepts a valid human waiver for the pinned revision", () => {
      expect(
        evaluateDeliveryGate(
          deliveryContext(contractPolicy, {
            criteria: [
              {
                criterionId: "criterion-1",
                handle: "R1.1",
                validProof: false,
                waiver: {
                  revisionId: "revision-2",
                  grantedByHuman: true,
                  reason: "Accepted risk.",
                  stale: false,
                },
                deliveredByMergedExecution: false,
              },
            ],
          }),
        ),
      ).toEqual({ ok: true });
    });
  });

  describe("floor unreachability", () => {
    it(`holds for every one of ${policyCases.length} preset/override combinations`, () => {
      for (const policy of policyCases) {
        expect(resolveDial(policy, "delivery")).not.toBe("off");

        expect(
          startExecution(startContext(policy, { revisionId: undefined })),
        ).toMatchObject({ ok: false, refusal: { code: "invalid_scope" } });
        expect(
          startExecution(startContext(policy, { scope: undefined })),
        ).toMatchObject({ ok: false, refusal: { code: "invalid_scope" } });

        expect(
          grantWaiver({
            actor: agent,
            reason: "Agent-requested exception.",
            existingWaiver: false,
          }),
        ).toMatchObject({
          ok: false,
          refusal: { code: "human_act_required" },
        });

        expect(
          evaluateDeliveryGate(
            deliveryContext(policy, {
              criteria: [
                {
                  criterionId: "criterion-1",
                  handle: "R1.1",
                  validProof: false,
                  waiver: null,
                  deliveredByMergedExecution: false,
                },
              ],
            }),
          ).ok,
        ).toBe(false);

        if (policy.preset === "exploratory") {
          expect(claimTaskComplete(claimContext(policy)).ok).toBe(false);
          expect(evaluateDeliveryGate(deliveryContext(policy)).ok).toBe(false);
        }
      }
    });
  });

  it("is deterministic and leaves a loaded snapshot unchanged", () => {
    const input = signOffContext();
    const before = structuredClone(input);

    const first = signOffRevision(input);
    const second = signOffRevision(input);

    expect(first).toEqual(second);
    expect(input).toEqual(before);
  });
});
