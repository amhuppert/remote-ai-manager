import { describe, expect, it } from "vitest";

import {
  createApprovalApplicability,
  subjectFingerprint,
  type ApprovalApplicability,
  type ApprovalRecord,
  type ApprovalSubject,
} from "./approval-applicability";
import type { RevisionElement as LintRevisionElement } from "./lint";
import type { RevisionElement as DiffRevisionElement } from "./revision-diff";
import type {
  ActorProvenance,
  SpecGate,
  SpecGateDial,
  SpecGatePolicy,
  SpecGatePreset,
} from "./schemas";
import {
  HUMAN_ACT_REQUIRED_RATIONALE,
  LATER_STAGE_RATIONALE,
  PLAN_IN_EVERGREEN_RATIONALE,
} from "./refusal-rationale";
import type { ExecutionScope, ScopePlan } from "./scope-validation";
import {
  admitDraftWrite,
  advanceAuthoringStage,
  approvalUnmetConditions,
  approveElement,
  changePolicy,
  consultedAuthoringGates,
  evaluateDeliveryGate,
  grantWaiver,
  nextAuthoringStage,
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
const emptyCitationState = {
  citationContractVersion: 2 as const,
  citations: [],
};
const emptyCitationDiff = {
  baseCitationContractVersion: 2 as const,
  draftCitationContractVersion: 2 as const,
  baseCitations: [],
  draftCitations: [],
};

/**
 * An approval as the review service records it: the subject's fingerprint over
 * the rows the human read, which may since have been edited in place.
 */
function approvalRecord(
  subject: ApprovalSubject,
  revisionId: string,
  readRows: readonly DiffRevisionElement[] = revisionRows(),
): ApprovalRecord {
  const fingerprint = subjectFingerprint(readRows, subject, emptyCitationState);
  if (fingerprint === null) {
    throw new Error(`the read rows do not carry ${subject.subjectKind}`);
  }
  return { ...subject, revisionId, validity: "valid", fingerprint };
}

function reviewSnapshot(): SignOffReviewSnapshot {
  return {
    revisionId: "revision-2",
    governanceBaseRevisionId: "revision-1",
    governanceBaseRevisionRows: revisionRows(),
    governanceBaseCitationState: emptyCitationState,
    revisionRows: revisionRows(),
    citationContractVersion: 2,
    citations: [],
    importBaselineRows: null,
    importBaselineCitationState: null,
    blockingThreads: [],
    approvals: [
      approvalRecord(
        { subjectKind: "requirement", elementId: "requirement-1" },
        "revision-1",
      ),
      approvalRecord(
        { subjectKind: "decision", elementId: "decision-1" },
        "revision-1",
      ),
      approvalRecord({ subjectKind: "plan", elementId: null }, "revision-1"),
    ],
  };
}

/**
 * The real applicability predicate over the fixture's rows. The default
 * lineage is the ordinary one: the current revision descends from revision-1,
 * whose content is the review base.
 */
function applicabilityFor(
  review: SignOffReviewSnapshot,
  overrides: { ancestorRevisionIds?: ReadonlySet<string> } = {},
): ApprovalApplicability {
  return createApprovalApplicability({
    revisionId: review.revisionId,
    ancestorRevisionIds:
      overrides.ancestorRevisionIds ?? new Set(["revision-1"]),
    revisionRows: review.revisionRows,
    citationContractVersion: review.citationContractVersion,
    citations: review.citations,
    parentCitationContractVersion: 2,
  });
}

/** The review snapshot plus the applicability predicate that reads it. */
function proposeReview(review: SignOffReviewSnapshot = reviewSnapshot()): {
  review: SignOffReviewSnapshot;
  approvalApplies: ApprovalApplicability;
} {
  return { review, approvalApplies: applicabilityFor(review) };
}

function signOffContext(
  overrides: Partial<Parameters<typeof signOffRevision>[0]> = {},
): Parameters<typeof signOffRevision>[0] {
  const authoringStage = overrides.authoringStage ?? "plan";
  const review = overrides.review ?? reviewSnapshot();
  return {
    actor: human,
    revisionState: "draft",
    authoringStage,
    policy: contractPolicy,
    draft: {
      specHandle: "native-sdd",
      authoringStage,
      elements: lintElements(),
    },
    records: {},
    ...overrides,
    review,
    approvalApplies: overrides.approvalApplies ?? applicabilityFor(review),
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

    it("freezes requirements content after the draft advances to design", () => {
      expect(
        admitDraftWrite("design", "requirement", undefined, {
          requirements: "gate",
          design: "gate",
          plan: "gate",
        }),
      ).toEqual({
        ok: false,
        refusal: {
          code: "stage_blocked",
          unmetConditions: [
            "A requirement cannot be authored during the design stage.",
          ],
          rationale: LATER_STAGE_RATIONALE,
          instruction:
            "Return to the requirements stage before authoring requirement content.",
        },
      });
    });

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
            "A task is authored in a delivery plan attempt, not an evergreen revision.",
          ],
          rationale: PLAN_IN_EVERGREEN_RATIONALE,
          instruction:
            "Complete evergreen design review, then run `cctl spec plan open <slug>` and author the graph with `cctl workflow replace <definitionId> --file <plan.json>`.",
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
          instruction: expect.stringContaining("cctl spec plan open"),
        },
      });
    });

    // Staged authoring is designed friction, so both branches say what the
    // ordering buys rather than leaving the agent to read it as an obstacle.
    it("says why the stage ordering exists on both blocked branches", () => {
      expect(
        admitDraftWrite("requirements", "decision", undefined, {
          requirements: "gate",
          design: "gate",
          plan: "gate",
        }),
      ).toEqual({
        ok: false,
        refusal: {
          code: "stage_blocked",
          unmetConditions: [
            "A decision cannot be authored during the requirements stage.",
          ],
          rationale: LATER_STAGE_RATIONALE,
          instruction:
            "Propose the requirements stage and obtain sign-off before authoring decision content.",
        },
      });
      expect(
        admitDraftWrite("requirements", "section", "design_narrative", {
          requirements: "notify",
          design: "notify",
          plan: "notify",
        }),
      ).toMatchObject({
        ok: false,
        refusal: { rationale: LATER_STAGE_RATIONALE },
      });
    });

    it("opens stages from policy and base revision state", () => {
      expect(
        openDraftAuthoringStage({ policy: { preset: "contract-bearing" } }),
      ).toBe("requirements");
      expect(openDraftAuthoringStage({ policy: { preset: "fast-path" } })).toBe(
        "requirements",
      );
      expect(
        openDraftAuthoringStage({
          policy: {
            preset: "fast-path",
            overrides: { plan: "notify" },
          },
        }),
      ).toBe("requirements");
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
          baseRevision: { state: "approved", authoringStage: "design" },
        }),
      ).toBe("design");
      expect(
        openDraftAuthoringStage({
          policy: contractPolicy,
          baseRevision: { state: "approved", authoringStage: "plan" },
        }),
      ).toBe("design");
      expect(
        openDraftAuthoringStage({
          policy: contractPolicy,
          baseRevision: { state: "withdrawn", authoringStage: "design" },
        }),
      ).toBe("design");
    });

    it("ends active authoring at design while retaining plan as a legacy stage", () => {
      expect(nextAuthoringStage("requirements")).toBe("design");
      expect(nextAuthoringStage("design")).toBeNull();
      expect(nextAuthoringStage("plan")).toBeNull();

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
        advanceAuthoringStage("design", { preset: "exploratory" }),
      ).toMatchObject({
        ok: false,
        refusal: {
          code: "gate_blocked",
          instruction: expect.stringContaining("cctl spec plan open"),
        },
      });
    });

    it("consults the revision stage plus every modified earlier stage", () => {
      const base = revisionRows();
      const draft = revisionRows();
      draft[0] = { ...draft[0]!, payloadHash: "requirement-changed" };

      expect(
        consultedAuthoringGates("plan", base, draft, emptyCitationDiff),
      ).toEqual(["requirements", "plan"]);
      expect(
        consultedAuthoringGates("design", base, base, emptyCitationDiff),
      ).toEqual(["design"]);
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
        consultedAuthoringGates(
          "plan",
          base,
          withAddedRequirement,
          emptyCitationDiff,
        ),
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
        ...proposeReview(),
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
          instruction:
            "Nothing was proposed for revision revision-2. Run `cctl spec lint native-sdd`, resolve every blocking finding it reports, then re-run `cctl spec propose native-sdd --notes-file <notes.md>`.",
        },
      });
    });

    /**
     * Prose is a reference surface too: renumbering leaves a citation in a
     * requirement statement pointing at nothing, and propose must refuse it
     * through the same lint panel it refuses a dangling id array with.
     */
    it("returns the lint panel findings when prose references a handle the draft lost", () => {
      const elements = lintElements();
      elements[0] = lintElement("requirement-1", "R1", {
        ...requirementPayload,
        statement: "Transitions cannot bypass the floor described in R12.2.",
      });

      const decision = propose({
        revisionState: "draft",
        authoringStage: "plan",
        policy: contractPolicy,
        draft: { specHandle: "native-sdd", authoringStage: "plan", elements },
        records: {},
        ...proposeReview(),
      });

      expect(decision).toEqual({
        ok: false,
        refusal: {
          code: "lint_blocked",
          unmetConditions: [
            "R1 prose references unknown handle R12.2 in statement.",
          ],
          findings: [
            {
              ruleId: "9.6.dangling-handle",
              severity: "blocks_propose",
              elementHandle: "R1",
              message: "R1 prose references unknown handle R12.2 in statement.",
            },
          ],
          instruction:
            "Nothing was proposed for revision revision-2. Run `cctl spec lint native-sdd`, resolve every blocking finding it reports, then re-run `cctl spec propose native-sdd --notes-file <notes.md>`.",
        },
      });
    });

    it.each(["approved", "withdrawn"] as const)(
      "refuses proposing a %s revision",
      (revisionState) => {
        expect(
          propose({
            revisionState,
            authoringStage: "plan",
            policy: contractPolicy,
            draft: {
              specHandle: "native-sdd",
              authoringStage: "plan",
              elements: lintElements(),
            },
            records: {},
            ...proposeReview(),
          }),
        ).toMatchObject({
          ok: false,
          refusal: { code: "gate_blocked" },
        });
      },
    );

    /**
     * A Gate dial means a human act follows the review request, so propose
     * owes none of the sign-off's preconditions: the human approves and signs
     * off the same draft later.
     */
    it("allows a review request under a Gate dial while sign-off conditions are still unmet", () => {
      const review = reviewSnapshot();
      review.approvals = [];
      review.blockingThreads.push({ handle: "thread-1", resolved: false });

      expect(
        propose({
          revisionState: "draft",
          authoringStage: "plan",
          policy: contractPolicy,
          draft: {
            specHandle: "native-sdd",
            authoringStage: "plan",
            elements: lintElements(),
          },
          records: {},
          ...proposeReview(review),
        }),
      ).toEqual({ ok: true });
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
          ...proposeReview(),
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
          ...proposeReview(review),
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
          revisionState: "draft",
          subjectKind: "requirement",
        }),
      ).toEqual({
        ok: false,
        refusal: {
          code: "human_act_required",
          unmetConditions: ["Element approval is a human-only act."],
          rationale: HUMAN_ACT_REQUIRED_RATIONALE,
          instruction: "Ask a human to approve the element in Spec Studio.",
        },
      });
    });

    it("allows a human to approve an element on the open draft", () => {
      expect(
        approveElement({
          actor: human,
          revisionState: "draft",
          subjectKind: "requirement",
        }),
      ).toEqual({ ok: true });
    });

    it.each(["approved", "withdrawn"] as const)(
      "refuses element approval on a %s revision",
      (revisionState) => {
        expect(
          approveElement({
            actor: human,
            revisionState,
            subjectKind: "requirement",
          }),
        ).toMatchObject({
          ok: false,
          refusal: { code: "gate_blocked" },
        });
      },
    );
  });

  describe("signOffRevision", () => {
    it("signs off the open draft once its preconditions hold", () => {
      expect(signOffRevision(signOffContext())).toEqual({ ok: true });
    });

    /**
     * Sign-off is the only act that freezes content, so repeating it on the
     * revision it froze answers the same way rather than refusing a retry.
     */
    it("treats a repeated sign-off of an approved revision as already done", () => {
      const review = reviewSnapshot();
      review.approvals = [];
      review.blockingThreads.push({ handle: "thread-1", resolved: false });

      expect(
        signOffRevision(signOffContext({ revisionState: "approved", review })),
      ).toEqual({ ok: true });
    });

    it("refuses signing off a withdrawn revision", () => {
      expect(
        signOffRevision(signOffContext({ revisionState: "withdrawn" })),
      ).toMatchObject({
        ok: false,
        refusal: {
          code: "gate_blocked",
          unmetConditions: ["Only the open draft can be signed off."],
        },
      });
    });

    /**
     * The author's review request refuses on a `blocks_propose` finding, but a
     * human can sign off without one ever being filed. Sign-off freezes the
     * draft, so it owes every non-advisory finding itself.
     */
    it("refuses while a propose-blocking lint finding exists", () => {
      const elements = lintElements();
      elements[0] = lintElement("requirement-1", "R1", {
        ...requirementPayload,
        statement: "Transitions cannot bypass the floor described in R12.2.",
      });

      expect(
        signOffRevision(
          signOffContext({
            draft: {
              specHandle: "native-sdd",
              authoringStage: "plan",
              elements,
            },
          }),
        ),
      ).toEqual({
        ok: false,
        refusal: expect.objectContaining({
          code: "lint_blocked",
          unmetConditions: [
            "R1 prose references unknown handle R12.2 in statement.",
          ],
          findings: [
            expect.objectContaining({
              ruleId: "9.6.dangling-handle",
              severity: "blocks_propose",
            }),
          ],
        }),
      });
    });

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

    /**
     * An approval names the revision whose content a human read. A revision
     * the current one does not descend from is a different line of content, so
     * its approval says nothing about what is being signed off here.
     */
    it("refuses an approval recorded on a revision the current one does not descend from", () => {
      const review = reviewSnapshot();
      review.approvals = review.approvals.map((approval) =>
        approval.subjectKind === "requirement"
          ? { ...approval, revisionId: "revision-sibling" }
          : approval,
      );

      expect(
        signOffRevision(
          signOffContext({
            authoringStage: "requirements",
            review,
            // The sibling approval's fingerprint is identical, so only its
            // absence from this revision's lineage can refuse it.
            approvalApplies: applicabilityFor(review, {
              ancestorRevisionIds: new Set(["revision-1"]),
            }),
          }),
        ),
      ).toMatchObject({
        ok: false,
        refusal: {
          code: "gate_blocked",
          unmetConditions: [
            "Requirement R1 needs a valid approval for revision-2.",
          ],
        },
      });
    });

    /**
     * A draft is edited in place while it is reviewed, so an approval granted
     * on it is judged by the fingerprint the human read, never by the rows the
     * draft carries now. Editing the approved subject unapproves it; editing
     * anything else leaves it approved.
     */
    it("unapproves a subject edited on the draft after its approval and keeps it through an unrelated edit", () => {
      const readRows = revisionRows();
      const approvedOnDraft = (): SignOffReviewSnapshot => {
        const review = reviewSnapshot();
        review.approvals = [
          approvalRecord(
            { subjectKind: "requirement", elementId: "requirement-1" },
            "revision-2",
            readRows,
          ),
        ];
        return review;
      };

      const editedSubject = approvedOnDraft();
      editedSubject.revisionRows[0] = {
        ...editedSubject.revisionRows[0]!,
        payloadHash: "requirement-1-edited-after-approval",
      };
      expect(
        signOffRevision(
          signOffContext({
            authoringStage: "requirements",
            review: editedSubject,
          }),
        ),
      ).toMatchObject({
        ok: false,
        refusal: {
          code: "gate_blocked",
          unmetConditions: [
            "Requirement R1 needs a valid approval for revision-2.",
          ],
        },
      });

      const editedElsewhere = approvedOnDraft();
      editedElsewhere.revisionRows[2] = {
        ...editedElsewhere.revisionRows[2]!,
        payloadHash: "decision-1-edited-after-approval",
      };
      expect(
        signOffRevision(
          signOffContext({
            authoringStage: "requirements",
            review: editedElsewhere,
          }),
        ),
      ).toEqual({ ok: true });
    });

    /**
     * Review semantics stay on the immediate parent: a subject a human
     * approved during an attempt that was later withdrawn, and that nothing
     * has touched since, is not asked for again.
     */
    it("carries an approval given during a withdrawn ancestor when the subject is unchanged since", () => {
      const review = reviewSnapshot();
      review.approvals = review.approvals.map((approval) => ({
        ...approval,
        revisionId: "revision-withdrawn",
      }));

      expect(
        signOffRevision(
          signOffContext({
            review,
            approvalApplies: applicabilityFor(review, {
              ancestorRevisionIds: new Set([
                "revision-withdrawn",
                "revision-1",
              ]),
            }),
          }),
        ),
      ).toEqual({ ok: true });
    });

    it("stops carrying a requirement approval when only one of its criteria changed", () => {
      const review = reviewSnapshot();
      review.revisionRows[1] = {
        ...review.revisionRows[1]!,
        payloadHash: "criterion-1-reworded",
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

    /**
     * `payload_hash` covers the payload alone, so a replacement element that
     * repeats the approved text carries the approved hash under a new id. The
     * product treats that as a remove plus an add, and the approval does not
     * travel with the text.
     */
    it("does not carry an approval to a replacement element that repeats the approved text", () => {
      const review = reviewSnapshot();
      const replaced = review.revisionRows[0]!;
      review.revisionRows[0] = { ...replaced, elementId: "requirement-2" };
      review.revisionRows[1] = {
        ...review.revisionRows[1]!,
        parentElementId: "requirement-2",
      };
      // Sign-off owes every blocking finding, so the replacement is complete:
      // everything that traced the removed requirement traces its successor.
      const tracesReplacement = {
        tracedRequirementElementIds: ["requirement-2"],
      };

      expect(
        signOffRevision(
          signOffContext({
            review,
            draft: {
              specHandle: "native-sdd",
              authoringStage: "plan",
              elements: [
                lintElement("requirement-2", "R2", requirementPayload),
                lintElement(
                  "criterion-1",
                  "R2.1",
                  criterionPayload,
                  "requirement-2",
                ),
                lintElement("decision-1", "D1", {
                  ...decisionPayload,
                  ...tracesReplacement,
                }),
                lintElement("task-1", "T1", {
                  ...taskPayload,
                  ...tracesReplacement,
                }),
              ],
            },
          }),
        ),
      ).toMatchObject({
        ok: false,
        refusal: {
          code: "gate_blocked",
          unmetConditions: [
            "Requirement R2 needs a valid approval for revision-2.",
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
          startContext(contractPolicy, { revisionState: "draft" }),
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
          rationale: HUMAN_ACT_REQUIRED_RATIONALE,
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
            "Repair or replace the graph execution until each required authored claimant has valid proof, obtain any required human waiver, or repair the delivery scope before merging.",
        },
      });
    });

    it("marks the missing-human-approval refusal with the approval_required reason and the Delivery-view instruction", () => {
      expect(
        evaluateDeliveryGate(
          deliveryContext(contractPolicy, { deliveryApprovalGranted: false }),
        ),
      ).toEqual({
        ok: false,
        refusal: {
          code: "gate_blocked",
          reason: "approval_required",
          unmetConditions: ["The delivery gate requires human approval."],
          instruction:
            "Open the spec’s Delivery view in Spec Studio, settle the listed acceptance criteria, and approve delivery to continue merge.",
        },
      });
    });

    it("sets no approval_required reason on any other refusal branch, even when approval is also missing", () => {
      const decisions = [
        evaluateDeliveryGate(
          deliveryContext(contractPolicy, {
            executionState: "abandoned",
            deliveryApprovalGranted: false,
          }),
        ),
        evaluateDeliveryGate(
          deliveryContext(
            { preset: "exploratory" },
            { deliveryApprovalGranted: false },
          ),
        ),
        evaluateDeliveryGate(
          deliveryContext(contractPolicy, {
            pinnedRevisionId: undefined,
            deliveryApprovalGranted: false,
          }),
        ),
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
      ];

      for (const decision of decisions) {
        expect(decision.ok).toBe(false);
        if (!decision.ok) {
          expect(decision.refusal.reason).toBeUndefined();
        }
      }
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
          expect(evaluateDeliveryGate(deliveryContext(policy)).ok).toBe(false);
        }
      }
    });
  });

  /**
   * An imported revision is born past its authoring gates on import basis, so
   * no approval row backs any of its elements. Without carry-forward the first
   * amendment would hand a human every imported requirement and decision to
   * re-approve; with it, only what the amendment actually changed is owed.
   */
  describe("approval carry-forward from an import baseline", () => {
    const importedRows = (): DiffRevisionElement[] => [
      diffElement("requirement-1", requirementPayload),
      diffElement("criterion-1", criterionPayload, "requirement-1"),
      diffElement("decision-1", decisionPayload),
    ];

    const edited = (row: DiffRevisionElement): DiffRevisionElement => ({
      ...row,
      payloadHash: `${row.elementId}-hash-edited`,
    });

    const addedRequirement = (): DiffRevisionElement =>
      diffElement("requirement-2", requirementPayload);

    const addedCriterion = (): DiffRevisionElement =>
      diffElement("criterion-2", criterionPayload, "requirement-1");

    const handles = new Map([
      ["requirement-1", "R1"],
      ["requirement-2", "R2"],
      ["decision-1", "D1"],
    ]);

    function conditionsFor(
      revisionRows: DiffRevisionElement[],
      importBaselineRows: DiffRevisionElement[] | null,
    ): string[] {
      return approvalUnmetConditions({
        policy: contractPolicy,
        authoringStage: "design",
        revisionId: "revision-2",
        governanceBaseRevisionRows: importedRows(),
        governanceBaseCitationState: emptyCitationState,
        revisionRows,
        revisionCitationState: emptyCitationState,
        // An import writes no approval rows at all — that is the whole point
        // of the basis — so the amendment starts from an empty approval set.
        approvals: [],
        handles,
        approvalApplies: createApprovalApplicability({
          revisionId: "revision-2",
          ancestorRevisionIds: new Set(["revision-1"]),
          revisionRows,
          citationContractVersion: 2,
          citations: [],
          parentCitationContractVersion: 2,
        }),
        importBaselineRows,
        importBaselineCitationState:
          importBaselineRows === null ? null : emptyCitationState,
      });
    }

    it("owes approval only for the element the amendment changed", () => {
      const conditions = conditionsFor(
        [edited(importedRows()[0]!), ...importedRows().slice(1)],
        importedRows(),
      );

      expect(conditions).toEqual([
        "Requirement R1 needs a valid approval for revision-2.",
      ]);
    });

    it("owes approval for an element the import baseline never carried", () => {
      const conditions = conditionsFor(
        [...importedRows(), addedRequirement()],
        importedRows(),
      );

      expect(conditions).toEqual([
        "Requirement R2 needs a valid approval for revision-2.",
      ]);
    });

    /**
     * Approving a requirement approves what would satisfy it, so its criteria
     * are part of the subject a human read — exactly what `subjectFingerprint`
     * says of a native approval. A carry-forward that compared the requirement
     * payload alone would let an amendment rewrite, add, or delete criteria
     * under an untouched statement and owe nobody anything.
     */
    it("owes approval for a requirement whose criterion the amendment rewrote", () => {
      const conditions = conditionsFor(
        [
          importedRows()[0]!,
          edited(importedRows()[1]!),
          ...importedRows().slice(2),
        ],
        importedRows(),
      );

      expect(conditions).toEqual([
        "Requirement R1 needs a valid approval for revision-2.",
      ]);
    });

    it("owes approval for a requirement the amendment added a criterion to", () => {
      const conditions = conditionsFor(
        [...importedRows(), addedCriterion()],
        importedRows(),
      );

      expect(conditions).toEqual([
        "Requirement R1 needs a valid approval for revision-2.",
      ]);
    });

    it("owes approval for a requirement the amendment deleted a criterion from", () => {
      const conditions = conditionsFor(
        importedRows().filter((row) => row.elementId !== "criterion-1"),
        importedRows(),
      );

      expect(conditions).toEqual([
        "Requirement R1 needs a valid approval for revision-2.",
      ]);
    });

    it("leaves a natively authored spec owing every consulted subject", () => {
      const conditions = conditionsFor(
        [...importedRows(), addedRequirement()],
        null,
      );

      expect(conditions).toEqual([
        "Requirement R1 needs a valid approval for revision-2.",
        "Requirement R2 needs a valid approval for revision-2.",
        "Decision D1 needs a valid approval for revision-2.",
      ]);
    });
  });

  // An agent meets this class one member at a time — a sign-off here, a waiver
  // there — so every member states the same boundary. A predicate that raised
  // the code without the sentence would teach the agent that some human-only
  // acts are arbitrary and worth retrying.
  it("gives every human_act_required refusal the same reason", () => {
    const decisions = [
      advanceAuthoringStage("requirements", contractPolicy),
      approveElement({
        actor: agent,
        revisionState: "draft",
        subjectKind: "requirement",
      }),
      signOffRevision(
        signOffContext({ policy: { preset: "fast-path" }, actor: agent }),
      ),
      grantWaiver({
        actor: agent,
        reason: "Agent-requested exception.",
        existingWaiver: false,
      }),
      changePolicy({
        actor: agent,
        currentPolicy: contractPolicy,
        proposedPolicy: { preset: "exploratory" },
        hardConfirmed: true,
      }),
      changePolicy({
        actor: human,
        currentPolicy: contractPolicy,
        proposedPolicy: { preset: "exploratory" },
        hardConfirmed: false,
      }),
    ];

    const rationales = decisions.map((decision) =>
      decision.ok
        ? "unexpectedly allowed"
        : `${decision.refusal.code}: ${decision.refusal.rationale ?? "no rationale"}`,
    );
    expect(rationales).toEqual(
      decisions.map(
        () => `human_act_required: ${HUMAN_ACT_REQUIRED_RATIONALE}`,
      ),
    );
  });

  it("is deterministic and leaves a loaded snapshot unchanged", () => {
    const input = signOffContext();
    // The approval authority is a function, so only the data it reads can be
    // cloned; leaving that data untouched is what the assertion is about.
    const data = (context: typeof input) => ({
      ...context,
      approvalApplies: null,
    });
    const before = structuredClone(data(input));

    const first = signOffRevision(input);
    const second = signOffRevision(input);

    expect(first).toEqual(second);
    expect(data(input)).toEqual(before);
  });
});
