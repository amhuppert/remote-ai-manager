import { describe, expect, it } from "vitest";

import { createApprovalApplicability } from "./approval-applicability";
import { authoringReviewProjection } from "./authoring-review-projection";
import { importBaselineRevisionId } from "./import-baseline";
import type { LintFinding } from "./lint";
import { toDiffRows } from "./review-state";
import { ancestorIds } from "./revision-lineage";
import type {
  SpecApprovalRow,
  SpecGateAdmissionRow,
  SpecGatePolicy,
  SpecRevision,
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "./schemas";

const SPEC_ID = "spec-1";
const AT = "2026-07-18T00:00:00.000Z";

function revision(
  overrides: Pick<SpecRevision, "id" | "number"> & Partial<SpecRevision>,
): SpecRevision {
  return {
    specId: SPEC_ID,
    state: "proposed",
    authoringStage: "design",
    basedOnRevisionId: null,
    contentHash: null,
    proposedAt: AT,
    approvedAt: null,
    externalDelivery: null,
    createdAt: AT,
    ...overrides,
  };
}

function requirement(
  revisionId: string,
  id: string,
  number: number,
  statement: string,
  position: number,
): SpecRevisionElement {
  return {
    element: {
      id,
      specId: SPEC_ID,
      kind: "requirement",
      number,
      parentElementId: null,
      createdAt: AT,
    },
    version: {
      revisionId,
      elementId: id,
      position,
      payload: {
        kind: "requirement",
        statement,
        priority: "must",
        risk: "high",
      },
      payloadHash: `${id}:${statement}`,
      elementVersion: 1,
      createdAt: AT,
      updatedAt: AT,
    },
  };
}

function decision(
  revisionId: string,
  id: string,
  number: number,
  chosenApproach: string,
  position: number,
): SpecRevisionElement {
  return {
    element: {
      id,
      specId: SPEC_ID,
      kind: "decision",
      number,
      parentElementId: null,
      createdAt: AT,
    },
    version: {
      revisionId,
      elementId: id,
      position,
      payload: {
        kind: "decision",
        title: "Transition owner",
        chosenApproach,
        rejectedAlternatives: [],
        reason: "No prompt can bypass the gate.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      payloadHash: `${id}:${chosenApproach}`,
      elementVersion: 1,
      createdAt: AT,
      updatedAt: AT,
    },
  };
}

function criterion(
  revisionId: string,
  id: string,
  number: number,
  text: string,
  parentElementId: string,
  position: number,
): SpecRevisionElement {
  return {
    element: {
      id,
      specId: SPEC_ID,
      kind: "criterion",
      number,
      parentElementId,
      createdAt: AT,
    },
    version: {
      revisionId,
      elementId: id,
      position,
      payload: {
        kind: "criterion",
        text,
        validationStrategy: { kinds: ["test_run"] },
      },
      payloadHash: `${id}:${text}`,
      elementVersion: 1,
      createdAt: AT,
      updatedAt: AT,
    },
  };
}

function approval(
  overrides: Pick<SpecApprovalRow, "id" | "revision_id" | "subject_kind"> &
    Partial<SpecApprovalRow>,
): SpecApprovalRow {
  return {
    spec_id: SPEC_ID,
    element_id: null,
    approver: "alex",
    validity: "valid",
    granted_at: AT,
    ...overrides,
  };
}

function admission(
  overrides: Pick<SpecGateAdmissionRow, "id" | "gate" | "revision_id"> &
    Partial<SpecGateAdmissionRow>,
): SpecGateAdmissionRow {
  return {
    spec_id: SPEC_ID,
    basis: "human_approval",
    approval_id: null,
    execution_id: null,
    actor_json: JSON.stringify({ kind: "human" }),
    created_at: AT,
    ...overrides,
  };
}

interface Chain {
  revisions: SpecRevision[];
  snapshots: SpecRevisionSnapshot[];
}

/**
 * The D3 shape: an approved revision 1, an attempt at revision 2 that a human
 * ended with Request Changes, and a revision 3 whose only edit is a decision.
 * Revision 3 matches its immediate parent on requirements and differs from the
 * last approved ancestor.
 */
function withdrawnAttemptChain(requirementStatement: string): Chain {
  const approved = revision({
    id: "revision-1",
    number: 1,
    state: "approved",
    authoringStage: "requirements",
    approvedAt: AT,
    externalDelivery: null,
  });
  const withdrawn = revision({
    id: "revision-2",
    number: 2,
    state: "withdrawn",
    basedOnRevisionId: approved.id,
  });
  const current = revision({
    id: "revision-3",
    number: 3,
    basedOnRevisionId: withdrawn.id,
  });
  return {
    revisions: [approved, withdrawn, current],
    snapshots: [
      {
        revision: approved,
        elements: [
          requirement(approved.id, "requirement-1", 1, "Gates are durable.", 0),
        ],
      },
      {
        revision: withdrawn,
        elements: [
          requirement(
            withdrawn.id,
            "requirement-1",
            1,
            requirementStatement,
            0,
          ),
        ],
      },
      {
        revision: current,
        elements: [
          requirement(current.id, "requirement-1", 1, requirementStatement, 0),
          decision(current.id, "decision-1", 1, "The server owns gates.", 1),
        ],
      },
    ],
  };
}

/**
 * An imported spec: revision 1 is born approved past the authoring gates on
 * import basis with no approval row anywhere, and revision 2 amends exactly
 * one of its requirements.
 */
function importedAmendmentChain(amendment: {
  statement?: string;
  criterionText?: string;
}): Chain {
  const imported = revision({
    id: "revision-1",
    number: 1,
    state: "approved",
    approvedAt: AT,
  });
  const amended = revision({
    id: "revision-2",
    number: 2,
    basedOnRevisionId: imported.id,
  });
  const elementsFor = (
    revisionId: string,
    statement: string,
    criterionText: string,
  ) => [
    requirement(revisionId, "requirement-1", 1, statement, 0),
    criterion(revisionId, "criterion-1", 1, criterionText, "requirement-1", 1),
    requirement(revisionId, "requirement-2", 2, "Imports stay honest.", 2),
    decision(revisionId, "decision-1", 1, "The server owns gates.", 3),
  ];
  const IMPORTED_STATEMENT = "Imported specs are native.";
  const IMPORTED_CRITERION = "The import writes no approval row.";
  return {
    revisions: [imported, amended],
    snapshots: [
      {
        revision: imported,
        elements: elementsFor(
          imported.id,
          IMPORTED_STATEMENT,
          IMPORTED_CRITERION,
        ),
      },
      {
        revision: amended,
        elements: elementsFor(
          amended.id,
          amendment.statement ?? IMPORTED_STATEMENT,
          amendment.criterionText ?? IMPORTED_CRITERION,
        ),
      },
    ],
  };
}

const importAdmissions = (): SpecGateAdmissionRow[] =>
  (["requirements", "design"] as const).map((gate, index) =>
    admission({
      id: `admission-import-${index + 1}`,
      gate,
      revision_id: "revision-1",
      basis: "import",
      actor_json: JSON.stringify({
        kind: "agent",
        conversationId: "conversation-import",
      }),
    }),
  );

/** The same chain with its latest revision moved to another state. */
function withCurrentState(chain: Chain, state: SpecRevision["state"]): Chain {
  const current = chain.revisions[chain.revisions.length - 1]!;
  const moved: SpecRevision = { ...current, state };
  return {
    revisions: chain.revisions.map((candidate) =>
      candidate.id === moved.id ? moved : candidate,
    ),
    snapshots: chain.snapshots.map((candidate) =>
      candidate.revision.id === moved.id
        ? { ...candidate, revision: moved }
        : candidate,
    ),
  };
}

function project(
  chain: Chain,
  options: {
    policy?: SpecGatePolicy;
    approvals?: SpecApprovalRow[];
    admissions?: SpecGateAdmissionRow[];
    blockingThreads?: Array<{ handle: string; resolved: boolean }>;
    signOffFindings?: LintFinding[];
    openComments?: Array<{
      elementId: string;
      handle: string | null;
      blocking: boolean;
    }>;
    specSlug?: string;
  } = {},
) {
  const snapshot = chain.snapshots[chain.snapshots.length - 1]!;
  const governanceBaseSnapshot =
    chain.snapshots.find(
      ({ revision: candidate }) => candidate.state === "approved",
    ) ?? null;
  const rowsById = new Map(
    chain.snapshots.map((candidate) => [
      candidate.revision.id,
      toDiffRows(candidate),
    ]),
  );
  const approvals = options.approvals ?? [];
  const admissions = options.admissions ?? [];
  // Derived exactly as production does: the import baseline is whichever
  // revision the import-basis admissions name, not simply the governance base.
  const importBaselineRevision = importBaselineRevisionId(admissions);
  const importBaselineSnapshot =
    chain.snapshots.find(
      ({ revision: candidate }) => candidate.id === importBaselineRevision,
    ) ?? null;
  return authoringReviewProjection({
    policy: options.policy ?? { preset: "contract-bearing" },
    snapshot,
    governanceBaseSnapshot,
    approvals,
    admissions,
    importBaselineRows:
      importBaselineSnapshot === null
        ? null
        : toDiffRows(importBaselineSnapshot),
    currentExecution: null,
    revisionNumberById: new Map(
      chain.revisions.map((candidate) => [candidate.id, candidate.number]),
    ),
    applies: createApprovalApplicability({
      revisionId: snapshot.revision.id,
      ancestorRevisionIds: ancestorIds(chain.revisions, snapshot.revision.id),
      revisionRows: toDiffRows(snapshot),
      rowsForRevision: (revisionId) => rowsById.get(revisionId) ?? null,
    }),
    blockingThreads: options.blockingThreads ?? [],
    signOffFindings: options.signOffFindings ?? [],
    openComments: options.openComments,
    specSlug: options.specSlug,
  });
}

const gateOf = (
  projection: ReturnType<typeof project>,
  gate: string,
): (typeof projection)["gates"][number] => {
  const found = projection.gates.find((candidate) => candidate.gate === gate);
  if (found === undefined) throw new Error(`no ${gate} gate in the projection`);
  return found;
};

describe("authoringReviewProjection", () => {
  /**
   * The status read and the sign-off preconditions must answer "what is still
   * outstanding" identically. A pending list that re-asks for an untouched
   * imported requirement would send a human at an approval the sign-off does
   * not want, and one that hides a changed element would hide a real gate.
   */
  describe("an amendment of an imported baseline", () => {
    it("owes only the changed subject, in both the pending list and sign-off", () => {
      const projection = project(
        importedAmendmentChain({ statement: "Imported specs are amendable." }),
        { admissions: importAdmissions() },
      );

      expect(projection.pendingApprovals).toEqual([
        {
          gate: "requirements",
          subject: "R1",
          elementId: "requirement-1",
        },
      ]);
      expect(projection.revisionSignOff?.unmetConditions).toEqual([
        "Requirement R1 needs a valid approval for revision-2.",
      ]);
      expect(projection.revisionSignOff?.outstandingSubjectCount).toBe(1);
      // The gates stay pending — the revision still owes its human sign-off —
      // while the only subject either of them names is the changed one.
      expect(
        projection.pendingBlock?.gates.map(({ gate, subjects }) => [
          gate,
          subjects,
        ]),
      ).toEqual([
        ["requirements", ["R1"]],
        ["design", []],
      ]);
      expect(projection.pendingBlock?.actsNext).toBe("human");
    });

    /**
     * Approving a requirement approves the criteria that would satisfy it, so
     * rewriting one changes the subject a human would have to read — the same
     * rule `subjectFingerprint` applies to a native approval.
     */
    it("owes the parent requirement when only its criterion changed", () => {
      const projection = project(
        importedAmendmentChain({
          criterionText: "The import writes no approval row, ever.",
        }),
        { admissions: importAdmissions() },
      );

      expect(projection.pendingApprovals).toEqual([
        {
          gate: "requirements",
          subject: "R1",
          elementId: "requirement-1",
        },
      ]);
      expect(projection.revisionSignOff?.unmetConditions).toEqual([
        "Requirement R1 needs a valid approval for revision-2.",
      ]);
    });

    /**
     * Honest provenance: a carried-forward subject is settled, not approved. It
     * leaves the pending list — no human is asked for it — but it must stay
     * visible as import-carried, or a surface reading only `pendingApprovals`
     * reports "all approved" about content no human ever read.
     */
    it("reports the untouched imported subjects as import-carried, never as approved", () => {
      const projection = project(
        importedAmendmentChain({ statement: "Imported specs are amendable." }),
        {
          admissions: importAdmissions(),
          approvals: [
            approval({
              id: "approval-1",
              revision_id: "revision-2",
              subject_kind: "requirement",
              element_id: "requirement-1",
            }),
          ],
        },
      );

      expect(projection.pendingApprovals).toEqual([]);
      expect(projection.importCarriedApprovals).toEqual([
        {
          gate: "requirements",
          subject: "R2",
          elementId: "requirement-2",
        },
        {
          gate: "design",
          subject: "D1",
          elementId: "decision-1",
        },
      ]);
      expect(
        projection.pendingBlock?.gates.map(
          ({ gate, subjects, importCarriedSubjects }) => [
            gate,
            subjects,
            importCarriedSubjects,
          ],
        ),
      ).toEqual([
        ["requirements", [], ["R2"]],
        ["design", [], ["D1"]],
      ]);
      // The only subject a human approved is R1; the sentence a surface renders
      // must not extend that act to the two the import carried.
      expect(projection.pendingBlock?.display).not.toContain(
        "every consulted subject approved",
      );
      expect(projection.pendingBlock?.display).toContain(
        "2 carried forward from the import",
      );
      expect(projection.revisionSignOff?.state).toBe("ready");
    });

    it("claims no import carry-forward when every subject was humanly approved", () => {
      const projection = project(
        importedAmendmentChain({ statement: "Imported specs are amendable." }),
        {
          admissions: importAdmissions(),
          approvals: [
            approval({
              id: "approval-1",
              revision_id: "revision-2",
              subject_kind: "requirement",
              element_id: "requirement-1",
            }),
            approval({
              id: "approval-2",
              revision_id: "revision-2",
              subject_kind: "requirement",
              element_id: "requirement-2",
            }),
            approval({
              id: "approval-3",
              revision_id: "revision-2",
              subject_kind: "decision",
              element_id: "decision-1",
            }),
          ],
        },
      );

      expect(projection.importCarriedApprovals).toEqual([]);
      expect(projection.pendingBlock?.display).toContain(
        "every consulted subject approved",
      );
    });

    it("owes every subject when the same amendment carries no import basis", () => {
      const projection = project(
        importedAmendmentChain({ statement: "Imported specs are amendable." }),
        {
          admissions: importAdmissions().map((row) => ({
            ...row,
            basis: "human_approval" as const,
          })),
        },
      );

      expect(projection.pendingApprovals.map(({ subject }) => subject)).toEqual(
        ["R1", "R2", "D1"],
      );
      expect(projection.importCarriedApprovals).toEqual([]);
    });
  });

  it("keeps an earlier stage applicable when its change arrived through a withdrawn ancestor", () => {
    const projection = project(
      withdrawnAttemptChain("Gates survive a withdrawn attempt."),
      {
        admissions: [
          admission({
            id: "admission-1",
            gate: "requirements",
            revision_id: "revision-1",
          }),
        ],
      },
    );

    const requirements = gateOf(projection, "requirements");
    expect(requirements.state).toBe("pending");
    expect(requirements.applicability).toEqual({
      reason: "changed_since_governance_base",
      governanceBaseRevisionId: "revision-1",
    });
    expect(projection.applicableGates).toContain("requirements");
    // The revision-1 row is history and nothing more: it must not appear as a
    // current admission, and it must not move the gate off pending.
    expect(requirements.currentAdmissions).toEqual([]);
    expect(requirements.priorAdmissions).toEqual([
      {
        revisionId: "revision-1",
        revisionNumber: 1,
        executionId: null,
        basis: "human_approval",
        actor: { kind: "human" },
        admittedAt: AT,
      },
    ]);
  });

  it("reads an earlier stage unchanged since the governance base as not required", () => {
    const projection = project(withdrawnAttemptChain("Gates are durable."), {
      admissions: [
        admission({
          id: "admission-1",
          gate: "requirements",
          revision_id: "revision-1",
        }),
      ],
    });

    const requirements = gateOf(projection, "requirements");
    expect(requirements.state).toBe("not_required");
    expect(requirements.applicability.reason).toBe(
      "unchanged_since_governance_base",
    );
    expect(projection.applicableGates).not.toContain("requirements");
    // Requirement 24.13: the earlier admission stays visible as provenance and
    // never as satisfaction of the current revision.
    expect(requirements.currentAdmissions).toEqual([]);
    expect(requirements.priorAdmissions).toHaveLength(1);
    expect(
      projection.pendingApprovals.some(({ gate }) => gate === "requirements"),
    ).toBe(false);
  });

  it("separates the current revision's own admission from history", () => {
    const projection = project(
      withdrawnAttemptChain("Gates survive a withdrawn attempt."),
      {
        admissions: [
          admission({
            id: "admission-1",
            gate: "requirements",
            revision_id: "revision-1",
          }),
          admission({
            id: "admission-2",
            gate: "requirements",
            revision_id: "revision-3",
            created_at: "2026-07-18T01:00:00.000Z",
          }),
        ],
      },
    );

    const requirements = gateOf(projection, "requirements");
    expect(requirements.state).toBe("admitted");
    expect(
      requirements.currentAdmissions.map(
        ({ revisionNumber }) => revisionNumber,
      ),
    ).toEqual([3]);
    expect(
      requirements.priorAdmissions.map(({ revisionNumber }) => revisionNumber),
    ).toEqual([1]);
  });

  it("holds a consulted gate pending after its last subject approval and reports sign-off ready", () => {
    const projection = project(
      withdrawnAttemptChain("Gates survive a withdrawn attempt."),
      {
        approvals: [
          approval({
            id: "approval-1",
            revision_id: "revision-3",
            subject_kind: "requirement",
            element_id: "requirement-1",
          }),
          approval({
            id: "approval-2",
            revision_id: "revision-3",
            subject_kind: "decision",
            element_id: "decision-1",
          }),
        ],
      },
    );

    expect(projection.pendingApprovals).toEqual([]);
    expect(gateOf(projection, "requirements").state).toBe("pending");
    expect(gateOf(projection, "design").state).toBe("pending");
    expect(projection.revisionSignOff).toMatchObject({
      revisionId: "revision-3",
      revisionNumber: 3,
      state: "ready",
      outstandingSubjectCount: 0,
      unmetConditions: [],
    });
    expect(projection.nextAction.kind).toBe("sign_off_revision");
    expect(projection.pendingBlock).not.toBeNull();
    expect(projection.pendingBlock?.signOff?.state).toBe("ready");
  });

  it("never reports a pending applicable gate with nothing outstanding and no sign-off", () => {
    for (const approvals of [
      [],
      [
        approval({
          id: "approval-1",
          revision_id: "revision-3",
          subject_kind: "requirement",
          element_id: "requirement-1",
        }),
      ],
      [
        approval({
          id: "approval-1",
          revision_id: "revision-3",
          subject_kind: "requirement",
          element_id: "requirement-1",
        }),
        approval({
          id: "approval-2",
          revision_id: "revision-3",
          subject_kind: "decision",
          element_id: "decision-1",
        }),
      ],
    ]) {
      const projection = project(
        withdrawnAttemptChain("Gates survive a withdrawn attempt."),
        { approvals },
      );
      const pendingApplicable = projection.gates.filter(
        (gate) =>
          gate.state === "pending" &&
          projection.applicableGates.includes(gate.gate),
      );
      if (pendingApplicable.length === 0) continue;
      expect(
        projection.pendingApprovals.length > 0 ||
          projection.revisionSignOff?.state === "ready",
      ).toBe(true);
      expect(projection.pendingBlock).not.toBeNull();
    }
  });

  it("blocks sign-off on an unresolved blocking thread and on a sign-off lint finding", () => {
    const projection = project(
      withdrawnAttemptChain("Gates survive a withdrawn attempt."),
      {
        approvals: [
          approval({
            id: "approval-1",
            revision_id: "revision-3",
            subject_kind: "requirement",
            element_id: "requirement-1",
          }),
          approval({
            id: "approval-2",
            revision_id: "revision-3",
            subject_kind: "decision",
            element_id: "decision-1",
          }),
        ],
        blockingThreads: [{ handle: "thread-1", resolved: false }],
        signOffFindings: [
          {
            ruleId: "criterion_missing_strategy",
            severity: "blocks_signoff",
            elementHandle: "R1.1",
            message: "R1.1 has no validation strategy.",
          },
        ],
      },
    );

    expect(projection.revisionSignOff?.state).toBe("blocked");
    expect(projection.revisionSignOff?.unmetConditions).toEqual([
      "Blocking thread thread-1 is unresolved.",
      "R1.1 has no validation strategy.",
    ]);
    expect(projection.nextAction.kind).toBe("resolve_conditions");
    // The block carries every unmet condition, not just the subject count.
    expect(projection.pendingBlock?.unmetConditions).toEqual(
      projection.revisionSignOff?.unmetConditions,
    );
  });

  /**
   * The review loop's feedback half (#60): with open comments on an in-review
   * revision, "ask a human to approve" points the wrong way — the reviewer is
   * waiting on answers, and repairs cannot land until a human Requests
   * Changes. The projection must say so instead of steering at approvals the
   * commenter is withholding.
   */
  describe("open review comments", () => {
    it("rolls up open comments and reroutes the approve instruction at the comments and Request Changes", () => {
      const projection = project(
        withdrawnAttemptChain("Gates survive a withdrawn attempt."),
        {
          specSlug: "native-sdd",
          openComments: [
            { elementId: "requirement-1", handle: "R1", blocking: true },
            { elementId: "requirement-1", handle: "R1", blocking: false },
            { elementId: "element-gone", handle: null, blocking: false },
          ],
        },
      );

      expect(projection.openComments).toEqual({
        count: 3,
        blockingCount: 1,
        subjects: ["R1", "element-gone"],
      });
      expect(projection.nextAction.kind).toBe("approve_subject");
      expect(projection.nextAction.actsNext).toBe("human");
      expect(projection.nextAction.instruction).toContain(
        "Open comments on R1, element-gone await a response",
      );
      expect(projection.nextAction.instruction).toContain(
        "cctl spec comments native-sdd --open",
      );
      expect(projection.nextAction.instruction).toContain("Request Changes");
      expect(projection.pendingBlock?.instruction).toContain("Request Changes");
      expect(projection.pendingBlock?.display).toContain(
        "3 open comments await a response",
      );
    });

    it("projects no rollup and keeps the plain instructions when no comments are open", () => {
      const projection = project(
        withdrawnAttemptChain("Gates survive a withdrawn attempt."),
      );

      expect(projection.openComments).toBeNull();
      expect(projection.nextAction.instruction).toBe(
        "Ask a human to approve R1 at the requirements gate in Spec Studio.",
      );
    });

    it("steers a reopened draft at addressing its comments before re-proposing", () => {
      const projection = project(
        withCurrentState(
          withdrawnAttemptChain("Gates survive a withdrawn attempt."),
          "draft",
        ),
        {
          specSlug: "native-sdd",
          openComments: [
            { elementId: "requirement-1", handle: "R1", blocking: false },
          ],
        },
      );

      expect(projection.openComments).toEqual({
        count: 1,
        blockingCount: 0,
        subjects: ["R1"],
      });
      expect(projection.nextAction.kind).toBe("propose");
      expect(projection.nextAction.actsNext).toBe("agent");
      expect(projection.nextAction.instruction).toContain(
        "Open comments on R1 await a response",
      );
      expect(projection.nextAction.instruction).toContain(
        "then propose it again",
      );
    });

    it("leads the sign-off ask with the open comments when nothing else is pending", () => {
      const projection = project(
        withdrawnAttemptChain("Gates survive a withdrawn attempt."),
        {
          approvals: [
            approval({
              id: "approval-1",
              revision_id: "revision-3",
              subject_kind: "requirement",
              element_id: "requirement-1",
            }),
            approval({
              id: "approval-2",
              revision_id: "revision-3",
              subject_kind: "decision",
              element_id: "decision-1",
            }),
          ],
          specSlug: "native-sdd",
          openComments: [
            { elementId: "decision-1", handle: "D1", blocking: false },
          ],
        },
      );

      expect(projection.revisionSignOff?.state).toBe("ready");
      expect(projection.nextAction.kind).toBe("sign_off_revision");
      expect(projection.nextAction.instruction).toContain(
        "Open comments on D1 await a response",
      );
      expect(projection.nextAction.instruction).toContain(
        "cctl spec comments native-sdd --open",
      );
      expect(projection.nextAction.instruction).toContain("sign revision 3");
    });
  });

  it("names the next action by gate order rather than by the revision's authoring stage", () => {
    const projection = project(
      withdrawnAttemptChain("Gates survive a withdrawn attempt."),
      {
        approvals: [
          approval({
            id: "approval-2",
            revision_id: "revision-3",
            subject_kind: "decision",
            element_id: "decision-1",
          }),
        ],
      },
    );

    expect(projection.nextAction).toMatchObject({
      kind: "approve_subject",
      gate: "requirements",
      subject: "R1",
      elementId: "requirement-1",
      actsNext: "human",
    });
    expect(projection.pendingBlock?.outstandingSubjects).toEqual([
      { gate: "requirements", subject: "R1", elementId: "requirement-1" },
    ]);
    expect(projection.pendingBlock?.gates.map(({ gate }) => gate)).toEqual([
      "requirements",
      "design",
    ]);
    // The block's instruction names the subject the request needs, which is
    // exactly what a stage-derived blocker cannot know.
    expect(projection.pendingBlock?.instruction).toContain("R1");
    expect(projection.pendingBlock?.instruction).toContain("requirements");
  });

  it("names one whole-gate approval action when the next gate has multiple subjects", () => {
    const chain = withdrawnAttemptChain(
      "Every outstanding requirement stays addressable.",
    );
    const current = chain.snapshots.at(-1);
    if (current === undefined) {
      throw new Error("withdrawn attempt fixture requires a current snapshot");
    }
    current.elements.push(
      requirement(
        current.revision.id,
        "requirement-2",
        2,
        "Whole-gate requests cover every subject.",
        2,
      ),
    );

    const projection = project(chain);

    expect(projection.nextAction).toMatchObject({
      kind: "approve_gate",
      gate: "requirements",
      subject: null,
      elementId: null,
      actsNext: "human",
    });
    expect(projection.nextAction.instruction).toContain(
      "approve all 2 outstanding subjects at the requirements gate",
    );
    expect(projection.pendingBlock?.instruction).toContain(
      "request the requirements gate without a subject",
    );
  });

  /**
   * R11.5: under the combined dial the sign-off act IS the approval of every
   * item, which is why `approvalUnmetConditions` requires no per-element
   * approval. A projection that still lists the elements as outstanding sends
   * the caller at `request-approval` for an act the policy collapsed.
   */
  it("collapses every authoring subject into the sign-off act under the combined dial", () => {
    const projection = project(
      withdrawnAttemptChain("Gates survive a withdrawn attempt."),
      { policy: { preset: "fast-path" } },
    );

    expect(projection.pendingApprovals).toEqual([]);
    expect(projection.revisionSignOff).toMatchObject({
      state: "ready",
      outstandingSubjectCount: 0,
      unmetConditions: [],
    });
    expect(projection.nextAction).toMatchObject({
      kind: "sign_off_revision",
      actsNext: "human",
      subject: null,
    });
    expect(projection.pendingBlock?.outstandingSubjects).toEqual([]);
    expect(projection.pendingBlock?.display).toContain("sign-off");
  });

  /**
   * A withdrawn revision is terminal: `approveItem` refuses on it, so naming a
   * subject would mint a Needs You entry no human act can clear. The agent
   * amends.
   */
  it("asks nothing of a withdrawn revision and names the amendment as the next act", () => {
    const projection = project(
      withCurrentState(
        withdrawnAttemptChain("Gates survive a withdrawn attempt."),
        "withdrawn",
      ),
    );

    expect(projection.pendingApprovals).toEqual([]);
    expect(projection.applicableGates).toEqual([]);
    expect(gateOf(projection, "requirements").state).toBe("not_required");
    expect(projection.revisionSignOff).toBeNull();
    expect(projection.pendingBlock).toBeNull();
    expect(projection.nextAction).toMatchObject({
      kind: "amend",
      actsNext: "agent",
      gate: null,
      subject: null,
    });
  });

  /**
   * The execution gates are per-run. With no run in a position to receive the
   * act they ask nothing, so calling them pending contradicts the
   * applicability the same row reports and puts a pending gate beside an empty
   * outstanding list on every spec that has not started.
   */
  it("reads an execution gate with no run in position as not required", () => {
    const projection = project(
      withdrawnAttemptChain("Gates survive a withdrawn attempt."),
    );

    for (const gate of ["execution_start", "delivery"] as const) {
      const status = gateOf(projection, gate);
      expect(status.dial).toBe("gate");
      expect(status.state).toBe("not_required");
      expect(status.applicability.reason).toBe("dial_off");
      expect(projection.applicableGates).not.toContain(gate);
    }
  });

  it("reports a signed-off revision with the approval that signed it", () => {
    const chain = withdrawnAttemptChain("Gates survive a withdrawn attempt.");
    const signedOff = chain.snapshots[chain.snapshots.length - 1]!;
    const approvedRevision: SpecRevision = {
      ...signedOff.revision,
      state: "approved",
      approvedAt: AT,
    };
    const approvedChain: Chain = {
      revisions: chain.revisions.map((candidate) =>
        candidate.id === approvedRevision.id ? approvedRevision : candidate,
      ),
      snapshots: chain.snapshots.map((candidate) =>
        candidate.revision.id === approvedRevision.id
          ? { ...candidate, revision: approvedRevision }
          : candidate,
      ),
    };
    const revisionApproval = approval({
      id: "approval-revision",
      revision_id: approvedRevision.id,
      subject_kind: "revision",
    });

    const projection = project(approvedChain, {
      approvals: [
        revisionApproval,
        approval({
          id: "approval-1",
          revision_id: approvedRevision.id,
          subject_kind: "requirement",
          element_id: "requirement-1",
        }),
        approval({
          id: "approval-2",
          revision_id: approvedRevision.id,
          subject_kind: "decision",
          element_id: "decision-1",
        }),
      ],
      admissions: [
        admission({
          id: "admission-2",
          gate: "requirements",
          revision_id: approvedRevision.id,
        }),
        admission({
          id: "admission-3",
          gate: "design",
          revision_id: approvedRevision.id,
        }),
      ],
    });

    expect(projection.revisionSignOff).toMatchObject({
      state: "signed_off",
      approval: { id: "approval-revision" },
    });
    expect(projection.pendingBlock).toBeNull();
    expect(projection.nextAction.kind).toBe("none");
  });
});
