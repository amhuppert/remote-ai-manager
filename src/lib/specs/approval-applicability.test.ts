import { describe, expect, it } from "vitest";

import {
  approvalAppliesToRevision,
  createApprovalApplicability,
  sameSubjectFingerprint,
  subjectFingerprint,
  type ApprovalApplicabilityContext,
  type ApprovalRecord,
} from "./approval-applicability";
import {
  diffRevisions,
  type RevisionCitation,
  type RevisionElement,
} from "./revision-diff";

const requirementPayload = {
  kind: "requirement" as const,
  statement: "Approvals name the content a human read.",
  priority: "must" as const,
  risk: "high" as const,
};
const criterionPayload = {
  kind: "criterion" as const,
  text: "A carried approval covers identical content.",
  validationStrategy: { kinds: ["test_run" as const] },
};
const decisionPayload = {
  kind: "decision" as const,
  title: "Keyed fingerprints",
  chosenApproach: "Compare (element id, payload hash) pairs.",
  rejectedAlternatives: [],
  reason: "A bare hash list cannot see a replacement element.",
  tracedRequirementElementIds: ["requirement-1"],
};
const taskPayload = {
  kind: "task" as const,
  title: "Fold the approval authority",
  instructions: "Route every approval read through one predicate.",
  tracedRequirementElementIds: ["requirement-1"],
  tracedDecisionElementIds: ["decision-1"],
  coveredCriterionElementIds: ["criterion-1"],
  dependsOnTaskElementIds: [],
};

function row(
  elementId: string,
  payload: RevisionElement["payload"],
  parentElementId: string | null = null,
  payloadHash = `${elementId}-hash`,
): RevisionElement {
  return { elementId, parentElementId, payloadHash, payload };
}

const baseRows = (): RevisionElement[] => [
  row("requirement-1", requirementPayload),
  row("criterion-1", criterionPayload, "requirement-1"),
  row("criterion-2", criterionPayload, "requirement-1"),
  row("decision-1", decisionPayload),
  row("task-1", taskPayload),
];

const emptyCitationState = {
  citationContractVersion: 2 as const,
  citations: [] as RevisionCitation[],
};

function premiseCitation(
  elementId: string,
  assumptionId = "assumption-1",
): RevisionCitation {
  return {
    elementId,
    assumptionId,
    snapshot: {
      schemaVersion: 1,
      captureKind: "native",
      capturedAt: "2026-08-23T10:00:00.000Z",
      assumptionId,
      number: 1,
      recordVersion: 1,
      text: "The premise remains stable.",
      elementId,
      proposedBy: { kind: "agent", conversationId: "conversation-approval" },
      disposition: "confirmed",
      disposedAt: "2026-08-23T09:30:00.000Z",
      withdrawnAt: null,
      supersedesAssumptionId: null,
      createdAt: "2026-08-23T09:00:00.000Z",
      updatedAt: "2026-08-23T09:30:00.000Z",
    },
  };
}

function context(
  overrides: Partial<ApprovalApplicabilityContext> = {},
): ApprovalApplicabilityContext {
  const rows = overrides.revisionRows ?? baseRows();
  return {
    revisionId: "revision-2",
    basedOnRevisionId: "revision-1",
    ancestorRevisionIds: new Set(["revision-1"]),
    revisionRows: rows,
    ...emptyCitationState,
    stateForRevision: (revisionId) =>
      revisionId === "revision-1"
        ? { rows: baseRows(), ...emptyCitationState }
        : null,
    ...overrides,
  };
}

const approval = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  subjectKind: "requirement",
  elementId: "requirement-1",
  revisionId: "revision-1",
  validity: "valid",
  ...overrides,
});

describe("subjectFingerprint", () => {
  it("keys a requirement on its own pair plus one pair per criterion", () => {
    expect(
      subjectFingerprint(
        baseRows(),
        {
          subjectKind: "requirement",
          elementId: "requirement-1",
        },
        emptyCitationState,
      ),
    ).toMatchObject({
      elements: [
        { elementId: "requirement-1", payloadHash: "requirement-1-hash" },
        { elementId: "criterion-1", payloadHash: "criterion-1-hash" },
        { elementId: "criterion-2", payloadHash: "criterion-2-hash" },
      ],
      citationContractVersion: 2,
      citationCount: 0,
      citationSubhash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("keys the plan on every task, ordered by element id rather than position", () => {
    const reordered = [
      row("task-2", taskPayload),
      row("task-1", taskPayload),
      row("requirement-1", requirementPayload),
    ];

    expect(
      subjectFingerprint(
        reordered,
        { subjectKind: "plan", elementId: null },
        emptyCitationState,
      ),
    ).toMatchObject({
      elements: [
        { elementId: "task-1", payloadHash: "task-1-hash" },
        { elementId: "task-2", payloadHash: "task-2-hash" },
      ],
    });
  });

  it("has no fingerprint for a subject the revision does not carry", () => {
    expect(
      subjectFingerprint(
        baseRows(),
        {
          subjectKind: "decision",
          elementId: "decision-missing",
        },
        emptyCitationState,
      ),
    ).toBeNull();
  });

  it("binds requirement-plus-criteria and decision subjects to only their citation subhash", () => {
    const citations = [
      premiseCitation("requirement-1", "assumption-requirement"),
      premiseCitation("criterion-1", "assumption-criterion"),
      premiseCitation("decision-1", "assumption-decision"),
      premiseCitation("task-1", "assumption-task"),
    ];
    const state = { citationContractVersion: 2 as const, citations };
    const requirementFingerprint = subjectFingerprint(
      baseRows(),
      { subjectKind: "requirement", elementId: "requirement-1" },
      state,
    );
    const decisionFingerprint = subjectFingerprint(
      baseRows(),
      { subjectKind: "decision", elementId: "decision-1" },
      state,
    );

    expect(requirementFingerprint).toMatchObject({ citationCount: 2 });
    expect(decisionFingerprint).toMatchObject({ citationCount: 1 });
    expect(requirementFingerprint?.citationSubhash).not.toBe(
      decisionFingerprint?.citationSubhash,
    );
  });
});

describe("approvalAppliesToRevision", () => {
  it("carries an approval whose subject is byte-identical on the approved revision", () => {
    expect(approvalAppliesToRevision(context(), approval())).toBe(true);
  });

  it("refuses an approval that is no longer valid", () => {
    expect(
      approvalAppliesToRevision(context(), approval({ validity: "stale" })),
    ).toBe(false);
    expect(
      approvalAppliesToRevision(context(), approval({ validity: "closed" })),
    ).toBe(false);
  });

  /**
   * The subject's content matching is not enough: an approval on a revision
   * outside this revision's lineage was given against a different line of
   * content that no human carried forward here.
   */
  it("refuses an approval from a revision the current one does not descend from", () => {
    expect(
      approvalAppliesToRevision(
        context({
          stateForRevision: (revisionId) =>
            revisionId === "revision-1" || revisionId === "revision-sibling"
              ? { rows: baseRows(), ...emptyCitationState }
              : null,
        }),
        approval({ revisionId: "revision-sibling" }),
      ),
    ).toBe(false);
  });

  it("carries an approval recorded on the current revision itself", () => {
    expect(
      approvalAppliesToRevision(
        context({ ancestorRevisionIds: new Set() }),
        approval({ revisionId: "revision-2" }),
      ),
    ).toBe(true);
  });

  it("refuses when the approved revision's content can no longer be read", () => {
    expect(
      approvalAppliesToRevision(
        context({ stateForRevision: () => null }),
        approval(),
      ),
    ).toBe(false);
  });

  it("refuses when a criterion under an unchanged requirement statement changed", () => {
    const rows = baseRows();
    rows[1] = row(
      "criterion-1",
      criterionPayload,
      "requirement-1",
      "criterion-1-reworded",
    );

    expect(
      approvalAppliesToRevision(context({ revisionRows: rows }), approval()),
    ).toBe(false);
  });

  it("refuses when a criterion was added under an otherwise unchanged requirement", () => {
    expect(
      approvalAppliesToRevision(
        context({
          revisionRows: [
            ...baseRows(),
            row("criterion-3", criterionPayload, "requirement-1"),
          ],
        }),
        approval(),
      ),
    ).toBe(false);
  });

  /**
   * `payload_hash` covers the payload alone, so a replacement element repeats
   * the approved hash under a new id. Keyed pairs make that a remove plus an
   * add, which is what the product calls a direct change.
   */
  it("refuses a replacement element that repeats the approved text under a new id", () => {
    const rows = baseRows().filter((entry) => entry.elementId !== "decision-1");
    rows.push(row("decision-2", decisionPayload, null, "decision-1-hash"));

    expect(
      approvalAppliesToRevision(
        context({ revisionRows: rows }),
        approval({ subjectKind: "decision", elementId: "decision-2" }),
      ),
    ).toBe(false);
  });

  it("refuses a plan approval once any task changed", () => {
    const rows = baseRows();
    rows[4] = row("task-1", taskPayload, null, "task-1-respecified");

    expect(
      approvalAppliesToRevision(
        context({ revisionRows: rows }),
        approval({ subjectKind: "plan", elementId: null }),
      ),
    ).toBe(false);
  });

  it("reads each distinct approved revision once however many approvals name it", () => {
    const reads: string[] = [];
    const applies = createApprovalApplicability(
      context({
        ancestorRevisionIds: new Set(["revision-1", "revision-0"]),
        stateForRevision: (revisionId) => {
          reads.push(revisionId);
          return { rows: baseRows(), ...emptyCitationState };
        },
      }),
    );
    const subjects: ApprovalRecord[] = [
      approval(),
      approval({ subjectKind: "decision", elementId: "decision-1" }),
      approval({ subjectKind: "plan", elementId: null }),
    ];
    const manyApprovals = [
      ...subjects,
      ...subjects.map((subject) => ({ ...subject, revisionId: "revision-0" })),
      ...subjects,
      ...subjects.map((subject) => ({ ...subject, revisionId: "revision-0" })),
    ];

    expect(manyApprovals.map(applies)).toEqual(manyApprovals.map(() => true));
    expect([...new Set(reads)]).toEqual(["revision-1", "revision-0"]);
    expect(reads).toEqual(["revision-1", "revision-0"]);
  });

  it("invalidates only the approval subject whose citation set changed", () => {
    const baseCitation = premiseCitation("requirement-1");
    const currentCitation = premiseCitation("requirement-1", "assumption-2");
    const applies = createApprovalApplicability(
      context({
        citations: [baseCitation, currentCitation],
        stateForRevision: (revisionId) =>
          revisionId === "revision-1"
            ? {
                rows: baseRows(),
                citationContractVersion: 2,
                citations: [baseCitation],
              }
            : null,
      }),
    );

    expect(applies(approval())).toBe(false);
    expect(
      applies(approval({ subjectKind: "decision", elementId: "decision-1" })),
    ).toBe(true);
  });

  it("allows only an empty contract-1 subject across the first contract-2 boundary", () => {
    const legacyState = {
      rows: baseRows(),
      citationContractVersion: 1 as const,
      citations: [] as RevisionCitation[],
    };
    expect(
      approvalAppliesToRevision(
        context({
          stateForRevision: (revisionId) =>
            revisionId === "revision-1" ? legacyState : null,
        }),
        approval(),
      ),
    ).toBe(true);

    expect(
      approvalAppliesToRevision(
        context({
          stateForRevision: (revisionId) =>
            revisionId === "revision-1"
              ? {
                  ...legacyState,
                  citations: [premiseCitation("requirement-1")],
                }
              : null,
        }),
        approval(),
      ),
    ).toBe(false);
  });

  it("does not carry a contract-1 approval beyond the first contract-2 revision", () => {
    const states = new Map([
      [
        "revision-1",
        {
          rows: baseRows(),
          citationContractVersion: 1 as const,
          citations: [] as RevisionCitation[],
        },
      ],
      [
        "revision-2",
        {
          rows: baseRows(),
          citationContractVersion: 2 as const,
          citations: [] as RevisionCitation[],
        },
      ],
    ]);

    expect(
      approvalAppliesToRevision(
        context({
          revisionId: "revision-3",
          basedOnRevisionId: "revision-2",
          ancestorRevisionIds: new Set(["revision-1", "revision-2"]),
          stateForRevision: (revisionId) => states.get(revisionId) ?? null,
        }),
        approval({ revisionId: "revision-1" }),
      ),
    ).toBe(false);
  });
});

/**
 * The fingerprint must mean the same thing by "changed" as the diff the review
 * surface and the propose-time approval invalidation already use, or a subject
 * could read as unchanged on one surface and changed on the other.
 */
describe("fingerprint parity with diffRevisions", () => {
  const scenarios: Array<{
    name: string;
    rows: () => RevisionElement[];
  }> = [
    { name: "no change", rows: baseRows },
    {
      name: "requirement statement reworded",
      rows: () => {
        const rows = baseRows();
        rows[0] = row("requirement-1", requirementPayload, null, "restated");
        return rows;
      },
    },
    {
      name: "criterion reworded",
      rows: () => {
        const rows = baseRows();
        rows[1] = row(
          "criterion-1",
          criterionPayload,
          "requirement-1",
          "reworded",
        );
        return rows;
      },
    },
    {
      name: "criterion removed",
      rows: () =>
        baseRows().filter((entry) => entry.elementId !== "criterion-2"),
    },
    {
      name: "criterion added",
      rows: () => [
        ...baseRows(),
        row("criterion-3", criterionPayload, "requirement-1"),
      ],
    },
    {
      name: "decision reworded",
      rows: () => {
        const rows = baseRows();
        rows[3] = row("decision-1", decisionPayload, null, "rechosen");
        return rows;
      },
    },
    {
      name: "unrelated decision added",
      rows: () => [...baseRows(), row("decision-2", decisionPayload)],
    },
    {
      name: "task respecified",
      rows: () => {
        const rows = baseRows();
        rows[4] = row("task-1", taskPayload, null, "respecified");
        return rows;
      },
    },
    {
      name: "task added",
      rows: () => [...baseRows(), row("task-2", taskPayload)],
    },
    {
      name: "task removed",
      rows: () => baseRows().filter((entry) => entry.elementId !== "task-1"),
    },
  ];

  it.each(scenarios)(
    "agrees with the element classification for $name",
    ({ rows }) => {
      const draftRows = rows();
      const diff = diffRevisions(baseRows(), draftRows);
      const classificationOf = (elementId: string) =>
        diff.classifications.find(
          (classification) => classification.elementId === elementId,
        )?.classification;

      for (const subject of [
        { subjectKind: "requirement" as const, elementId: "requirement-1" },
        { subjectKind: "decision" as const, elementId: "decision-1" },
      ]) {
        const carried = sameSubjectFingerprint(
          subjectFingerprint(baseRows(), subject, emptyCitationState),
          subjectFingerprint(draftRows, subject, emptyCitationState),
        );
        expect({ subject: subject.elementId, carried }).toEqual({
          subject: subject.elementId,
          carried: classificationOf(subject.elementId) === "unchanged",
        });
      }
    },
  );

  it.each(scenarios)("agrees with planStale for $name", ({ rows }) => {
    const draftRows = rows();
    const subject = { subjectKind: "plan" as const, elementId: null };

    expect(
      sameSubjectFingerprint(
        subjectFingerprint(baseRows(), subject, emptyCitationState),
        subjectFingerprint(draftRows, subject, emptyCitationState),
      ),
    ).toBe(!diffRevisions(baseRows(), draftRows).planStale);
  });
});
