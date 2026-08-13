// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";
import type { SpecRevisionElement } from "@/lib/specs/schemas";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";

import {
  importedDeliveredSpecDetailFixture,
  liveProposalsFixture,
  planPreviewRequestRevisionId,
  planPreviewResponseFixture,
  specControlsDetailFixture,
  strandedProposalDetailFixture,
} from "./SpecControls.fixtures";
import SpecReviewMode, {
  bulkApprovalSubjects,
  reviewAttentionCount,
} from "./SpecReviewMode";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const NOW = "2026-07-18T12:00:00.000Z";

const PLAN_PREVIEW_PATH = "/api/specs/command-center/native-sdd/plan-preview";

/**
 * Review compiles a plan preview for whichever proposal is selected, so every
 * render in this file reaches the network. The fixture is installed for all of
 * them — a test that only cares about the diff cards still has to answer the
 * preview request, or the surface it renders is not the surface production
 * renders.
 */
let api: FetchFixture;

beforeEach(() => {
  api = installFetchFixture();
  api.reply("POST", PLAN_PREVIEW_PATH, (request) => ({
    json: planPreviewResponseFixture(request.jsonBody),
  }));
});

afterEach(() => {
  cleanup();
  api.restore();
});

/** The revision ids the panel asked the server to compile, in request order. */
function previewedRevisionIds(): string[] {
  return api
    .requestsTo("POST", PLAN_PREVIEW_PATH)
    .map((request) => planPreviewRequestRevisionId(request.jsonBody));
}

function reviewDetailFixture(blocked = true): SpecDetailView {
  const detail = specControlsDetailFixture();
  const baseSnapshot = detail.currentRevision;
  if (baseSnapshot === null) throw new Error("Review fixture requires a base");

  baseSnapshot.elements.push({
    element: {
      id: "task-prerequisite",
      specId: detail.spec.id,
      kind: "task",
      number: 2,
      parentElementId: null,
      createdAt: NOW,
    },
    version: {
      revisionId: baseSnapshot.revision.id,
      elementId: "task-prerequisite",
      position: 3,
      payload: {
        kind: "task",
        title: "Prepare the persistence boundary",
        instructions: "Expose the storage contract used by scope pinning.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
      },
      payloadHash: "task-prerequisite-hash",
      elementVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  const currentRevision = {
    ...baseSnapshot.revision,
    id: "revision-2",
    number: 2,
    state: "proposed" as const,
    basedOnRevisionId: baseSnapshot.revision.id,
    contentHash: "revision-2-hash",
    proposedAt: NOW,
    approvedAt: null,
  };
  const currentElements = baseSnapshot.elements.map((entry) => ({
    ...entry,
    version: {
      ...entry.version,
      revisionId: currentRevision.id,
      ...(entry.element.id === "requirement-1"
        ? {
            payload: {
              kind: "requirement" as const,
              statement: "Every execution pins the exact selected scope.",
              priority: "must" as const,
              risk: "high" as const,
            },
            payloadHash: "requirement-hash-2",
            elementVersion: 2,
          }
        : entry.element.id === "task-1"
          ? {
              payload: {
                kind: "task" as const,
                title: "Implement immutable scope pinning",
                instructions: "Persist the selected task and criterion set.",
                tracedRequirementElementIds: ["requirement-1"],
                tracedDecisionElementIds: [],
                coveredCriterionElementIds: ["criterion-1"],
                dependsOnTaskElementIds: ["task-prerequisite"],
                laneGroup: "persistence",
                touchedPaths: ["src/lib/specs", "src/lib/state-store"],
              },
              payloadHash: "task-hash-2",
              elementVersion: 2,
            }
          : {}),
    },
  }));
  currentElements.push({
    element: {
      id: "decision-1",
      specId: detail.spec.id,
      kind: "decision",
      number: 1,
      parentElementId: null,
      createdAt: NOW,
    },
    version: {
      revisionId: currentRevision.id,
      elementId: "decision-1",
      position: 4,
      payload: {
        kind: "decision",
        title: "Pin scope at execution start",
        chosenApproach: "Store the complete selected scope.",
        rejectedAlternatives: [],
        reason: "Execution must remain reproducible.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      payloadHash: "decision-hash",
      elementVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  // One snapshot object, referenced by both the projection entry and
  // `currentRevision`: the server emits one snapshot per revision, and a
  // fixture that copied it would let a test edit the review surface reads
  // diverge from the review surface it renders.
  const currentSnapshot = {
    revision: currentRevision,
    elements: currentElements,
  };

  return {
    ...detail,
    revisions: [baseSnapshot.revision, currentRevision],
    liveProposals: liveProposalsFixture(
      [baseSnapshot.revision, currentRevision],
      [baseSnapshot, currentSnapshot],
    ),
    baseRevision: baseSnapshot,
    currentRevision: currentSnapshot,
    currentApprovedRevision: baseSnapshot,
    // The server's projection for this revision, which is the one authority
    // the review surface reads for what a human still owes.
    status: {
      ...detail.status,
      applicableGates: ["requirements", "design", "plan"],
      pendingApprovals: blocked
        ? [
            {
              gate: "requirements" as const,
              subject: "R1",
              elementId: "requirement-1",
            },
            {
              gate: "design" as const,
              subject: "D1",
              elementId: "decision-1",
            },
            { gate: "plan" as const, subject: "plan", elementId: null },
          ]
        : [],
      revisionSignOff: {
        revisionId: currentRevision.id,
        revisionNumber: currentRevision.number,
        state: blocked ? ("blocked" as const) : ("ready" as const),
        outstandingSubjectCount: blocked ? 3 : 0,
        unmetConditions: [],
        approval: null,
      },
    },
    approvals: [
      {
        id: "approval-1",
        spec_id: detail.spec.id,
        subject_kind: "requirement",
        element_id: "requirement-1",
        revision_id: blocked ? baseSnapshot.revision.id : currentRevision.id,
        approver: "alex",
        granted_at: NOW,
        validity: blocked ? "stale" : "valid",
      },
      ...(!blocked
        ? [
            {
              id: "approval-2",
              spec_id: detail.spec.id,
              subject_kind: "decision" as const,
              element_id: "decision-1",
              revision_id: currentRevision.id,
              approver: "alex",
              granted_at: NOW,
              validity: "valid" as const,
            },
            {
              id: "approval-plan",
              spec_id: detail.spec.id,
              subject_kind: "plan" as const,
              element_id: null,
              revision_id: currentRevision.id,
              approver: "alex",
              granted_at: NOW,
              validity: "valid" as const,
            },
          ]
        : []),
    ],
    comments: [
      {
        id: "comment-1",
        threadId: "thread-1",
        parentCommentId: null,
        elementId: "requirement-1",
        handle: "R1",
        revisionId: currentRevision.id,
        revisionNumber: currentRevision.number,
        anchor: {
          sectionId: "R1",
          headingLabel: "R1",
          line: 1,
          charStart: 0,
          charEnd: 15,
          quote: "Every execution",
          prefix: "",
          suffix: " pins scope.",
          docRevision: baseSnapshot.revision.contentHash,
        },
        quote: "Every execution",
        body: "Confirm the gate screen uses the same scope.",
        author: { kind: "human" },
        blocking: blocked,
        resolution: blocked ? "open" : "resolved",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    questions: [
      {
        id: "question-1",
        number: 1,
        handle: "Q1",
        elementId: "requirement-1",
        text: "Which gate owns pinned-scope validation?",
        status: blocked ? "open" : "answered",
        answer: blocked ? null : "The execution-start gate.",
        answeredAt: blocked ? null : NOW,
        provenance: { kind: "human" },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "question-2",
        number: 2,
        handle: "Q2",
        elementId: null,
        text: "Does the review preserve raw diff access?",
        status: "answered",
        answer: "Yes, as a secondary view.",
        answeredAt: NOW,
        provenance: { kind: "agent", conversationId: "conversation-1" },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    assumptions: [
      {
        id: "assumption-1",
        number: 1,
        handle: "A1",
        elementId: "requirement-1",
        text: "Scope can be reconstructed after a run starts.",
        disposition: blocked ? "rejected" : "confirmed",
        disposedAt: NOW,
        proposedBy: { kind: "agent", conversationId: "conversation-1" },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "assumption-2",
        number: 2,
        handle: "A2",
        elementId: "requirement-1",
        text: "The gate screen can reuse the pinned scope projection.",
        disposition: blocked ? "proposed" : "confirmed",
        disposedAt: blocked ? null : NOW,
        proposedBy: { kind: "agent", conversationId: "conversation-1" },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "assumption-3",
        number: 3,
        handle: "A3",
        elementId: null,
        text: "Historical raw diffs use the same formatter.",
        disposition: "deferred",
        disposedAt: NOW,
        proposedBy: { kind: "human" },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

function renderReview(blocked = true): void {
  renderWithQuery(
    <SpecReviewMode
      detail={reviewDetailFixture(blocked)}
      projectName="command-center"
      highlightedChangeId={null}
    />,
  );
}

describe("SpecReviewMode", () => {
  /**
   * An import admission settles a subject without approving it: no human read
   * the content and no approval row exists. The readiness surface derives
   * "approved" from absence in `pendingApprovals`, so it has to subtract what
   * the server reports as import-carried or it credits a human with an act
   * nobody performed.
   */
  it("counts an import-carried subject apart from the approvals a human recorded", () => {
    const fixture = reviewDetailFixture(false);
    const detail: SpecDetailView = {
      ...fixture,
      status: {
        ...fixture.status,
        pendingApprovals: [],
        importCarriedApprovals: [
          { gate: "design", subject: "D1", elementId: "decision-1" },
        ],
      },
      // The decision's approval row is gone: the import carried it, so the
      // fixture must not hand Studio an approval the server never wrote.
      approvals: fixture.approvals.filter(
        (approval) => approval.element_id !== "decision-1",
      ),
    };

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    expect(screen.queryByText("All approved")).not.toBeInTheDocument();
    expect(screen.queryByText("Approvals complete")).not.toBeInTheDocument();
    expect(screen.getByText("2/3 approved")).toBeInTheDocument();
    expect(screen.getAllByText("1 carried from import").length).toBeGreaterThan(
      0,
    );
  });

  /**
   * The unchanged-element panel is the other place absence from
   * `pendingApprovals` reads as an approval: it captions itself "approvals
   * carried forward quietly" and gives every element a green check. An
   * import-carried subject is unchanged and unapproved at once, so it needs its
   * own chip and a caption that does not call it an approval.
   */
  it("marks an unchanged import-carried subject as carried from the import, not approved", async () => {
    const user = userEvent.setup();
    const fixture = reviewDetailFixture(false);
    const base = fixture.baseRevision;
    const current = fixture.currentRevision;
    if (base === null || current === null) {
      throw new Error("Fixture requires both revisions");
    }
    const decision = current.elements.find(
      (entry) => entry.element.id === "decision-1",
    );
    if (decision === undefined)
      throw new Error("Fixture requires the decision");
    // The same decision on both revisions, byte for byte: that is what makes
    // the diff call it unchanged and the import carry it forward.
    const baseWithDecision = {
      ...base,
      elements: [
        ...base.elements,
        {
          ...decision,
          version: { ...decision.version, revisionId: base.revision.id },
        },
      ],
    };
    const detail: SpecDetailView = {
      ...fixture,
      baseRevision: baseWithDecision,
      currentApprovedRevision: baseWithDecision,
      // The review surface diffs the snapshots the proposal selector hands it,
      // so the amended base has to reach it through the live proposals too.
      liveProposals: liveProposalsFixture(
        [baseWithDecision.revision, current.revision],
        [baseWithDecision, current],
      ),
      status: {
        ...fixture.status,
        pendingApprovals: [],
        importCarriedApprovals: [
          { gate: "design", subject: "D1", elementId: "decision-1" },
        ],
      },
      approvals: fixture.approvals.filter(
        (approval) => approval.element_id !== "decision-1",
      ),
    };

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const unchanged = screen.getByRole("button", {
      name: /unchanged element/i,
    });
    expect(unchanged).toHaveTextContent(/carried from the import/i);
    expect(unchanged).not.toHaveTextContent(/approvals carried forward/i);

    await user.click(unchanged);
    expect(screen.getByText("D1 — carried from import")).toBeVisible();
  });

  it("describes an approved revision as having nothing awaiting review", () => {
    const fixture = reviewDetailFixture(false);
    if (fixture.currentRevision === null || fixture.baseRevision === null) {
      throw new Error("Fixture requires a revision");
    }
    const approved = {
      ...fixture.currentRevision,
      revision: {
        ...fixture.currentRevision.revision,
        state: "approved" as const,
      },
    };
    const revisions = [fixture.baseRevision.revision, approved.revision];
    const detail: SpecDetailView = {
      ...fixture,
      revisions,
      // Recomputed rather than emptied by hand: nothing is proposed, so the
      // projection is empty, and the fixture cannot claim otherwise.
      liveProposals: liveProposalsFixture(revisions, [
        fixture.baseRevision,
        approved,
      ]),
      currentRevision: approved,
    };

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    expect(screen.getByText("Nothing awaiting review")).toBeInTheDocument();
    expect(
      screen.queryByText("Review mode unavailable"),
    ).not.toBeInTheDocument();
  });

  it("groups formatted acceptance criteria inside their requirement card and keeps raw diff secondary", async () => {
    const user = userEvent.setup();
    renderReview();

    expect(
      screen.getByRole("heading", { name: "Requirements" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Decisions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Tasks · plan" }),
    ).toBeInTheDocument();

    const requirement = screen.getByTestId("review-change-requirement-1");
    expect(
      within(requirement).getByTestId("review-criterion-criterion-1"),
    ).toBeVisible();
    expect(
      within(requirement).getAllByRole("button", { name: "Approve item" }),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(requirement.querySelector("p")).toHaveTextContent(
        "Every execution pins the exact selected scope.",
      );
    });
    await user.click(
      within(requirement).getByRole("button", {
        name: /modified requirement/i,
      }),
    );
    expect(
      within(requirement).getByTestId("review-criterion-criterion-1"),
    ).not.toBeVisible();

    const unchanged = screen.getByRole("button", {
      name: /1 unchanged element/i,
    });
    expect(unchanged).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("tab", { name: "Raw diff" }));
    expect(
      screen.getByText(/semantic change list is the review contract/i),
    ).toBeVisible();
    expect(screen.getByText(/--- revision-1/)).toBeVisible();
  });

  it("nests newly appended acceptance criteria under their parent requirement", () => {
    const detail = reviewDetailFixture();
    const current = detail.currentRevision;
    if (current === null) throw new Error("Fixture requires a revision");
    const appendedRequirement: SpecRevisionElement = {
      element: {
        id: "requirement-2",
        specId: detail.spec.id,
        kind: "requirement",
        number: 2,
        parentElementId: null,
        createdAt: NOW,
      },
      version: {
        revisionId: current.revision.id,
        elementId: "requirement-2",
        position: 4,
        payload: {
          kind: "requirement",
          statement: "Reviews finish in a single pass.",
          priority: "must",
          risk: "low",
        },
        payloadHash: "requirement-2-hash",
        elementVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    };
    // Appended last, as authoring does — but it belongs to requirement 1.
    const appendedCriterion: SpecRevisionElement = {
      element: {
        id: "criterion-2",
        specId: detail.spec.id,
        kind: "criterion",
        number: 2,
        parentElementId: "requirement-1",
        createdAt: NOW,
      },
      version: {
        revisionId: current.revision.id,
        elementId: "criterion-2",
        position: 5,
        payload: {
          kind: "criterion",
          text: "The pinned scope is visible on the gate screen.",
          validationStrategy: { kinds: ["test_run"] },
        },
        payloadHash: "criterion-2-hash",
        elementVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    };
    current.elements.push(appendedRequirement, appendedCriterion);

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const requirementOne = screen.getByTestId("review-change-requirement-1");
    expect(
      within(requirementOne).getByTestId("review-criterion-criterion-2"),
    ).toHaveTextContent("The pinned scope is visible on the gate screen.");
    expect(
      screen.queryByTestId("review-change-criterion-2"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("review-change-requirement-2")).toBeVisible();
  });

  it("offers unapprove on a validly approved subject and records the removal", async () => {
    api.json(
      "POST",
      "/api/specs/command-center/native-sdd/actions/unapprove-item",
      {
        id: "approval-1",
        spec_id: "spec-1",
        subject_kind: "requirement",
        element_id: "requirement-1",
        revision_id: "revision-2",
        approver: "alex",
        granted_at: NOW,
        validity: "valid",
      },
    );
    const user = userEvent.setup();
    renderReview(false);

    const requirement = screen.getByTestId("review-change-requirement-1");
    expect(
      within(requirement).queryByRole("button", { name: "Approve item" }),
    ).not.toBeInTheDocument();
    await user.click(
      within(requirement).getByRole("button", { name: "Unapprove item" }),
    );

    expect(await screen.findByText("R1 approval removed")).toBeInTheDocument();
    expect(
      api.requestsTo(
        "POST",
        "/api/specs/command-center/native-sdd/actions/unapprove-item",
      )[0]?.jsonBody,
    ).toEqual({
      revisionId: "revision-2",
      subjectKind: "requirement",
      elementId: "requirement-1",
    });
  });

  it("shows a sign-off coverage note instead of an approve action for elements without an approval gate", () => {
    const detail = reviewDetailFixture();
    const current = detail.currentRevision;
    if (current === null) throw new Error("Fixture requires a revision");
    current.elements.push({
      element: {
        id: "section-1",
        specId: detail.spec.id,
        kind: "section",
        number: 1,
        parentElementId: null,
        createdAt: NOW,
      },
      version: {
        revisionId: current.revision.id,
        elementId: "section-1",
        position: 0,
        payload: {
          kind: "section",
          role: "intent_problem",
          title: "Problem",
          body: "Execution scope drifts between runs.",
        },
        payloadHash: "section-hash",
        elementVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const section = screen.getByTestId("review-change-section-1");
    expect(
      within(section).queryByRole("button", { name: "Approve item" }),
    ).not.toBeInTheDocument();
    expect(within(section).getByText("Covered by sign-off")).toHaveAttribute(
      "title",
      "This element has no independent approval gate — revision sign-off approves it",
    );

    const task = screen.getByTestId("review-change-task-1");
    expect(
      within(task).queryByRole("button", { name: "Approve item" }),
    ).not.toBeInTheDocument();
    expect(within(task).getByText("Covered by sign-off")).toBeInTheDocument();
  });

  it("offers no approve action on a removed element", () => {
    const detail = reviewDetailFixture();
    const current = detail.currentRevision;
    if (current === null) throw new Error("Fixture requires a revision");
    current.elements = current.elements.filter(
      (entry) =>
        entry.element.id !== "requirement-1" &&
        entry.element.id !== "criterion-1",
    );

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const requirement = screen.getByTestId("review-change-requirement-1");
    expect(
      within(requirement).queryByRole("button", { name: "Approve item" }),
    ).not.toBeInTheDocument();
    expect(
      within(requirement).queryByText("Covered by sign-off"),
    ).not.toBeInTheDocument();
  });

  it("blocks the UI sign-off affordance when Q&A are the only unresolved items", () => {
    const detail = reviewDetailFixture(false);
    const question = detail.questions[0];
    const assumption = detail.assumptions.find(
      (candidate) => candidate.id === "assumption-2",
    );
    if (question === undefined || assumption === undefined) {
      throw new Error("Fixture requires Q&A records");
    }
    question.status = "open";
    question.answer = null;
    question.answeredAt = null;
    assumption.disposition = "proposed";
    assumption.disposedAt = null;

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const signOff = within(screen.getByTestId("review-readiness")).getByRole(
      "button",
      { name: "Sign off revision 2" },
    );
    expect(signOff).toBeDisabled();
    expect(signOff).toHaveAttribute(
      "title",
      "Sign-off blocked — 1 open question · 1 undisposed assumption",
    );
  });

  it("scopes review approvals to the proposed authoring stage", () => {
    const detail = reviewDetailFixture();
    const current = detail.currentRevision;
    if (current === null) throw new Error("Fixture requires a revision");
    current.revision.authoringStage = "requirements";
    detail.status.applicableGates = ["requirements"];
    detail.status.pendingApprovals = [
      { gate: "requirements", subject: "R1", elementId: "requirement-1" },
    ];
    detail.comments = [];
    detail.assumptions = [];

    expect(bulkApprovalSubjects(detail, "remaining")).toEqual([
      { subjectKind: "requirement", elementId: "requirement-1" },
    ]);

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Review requirements-stage revision 2",
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("review-readiness")).getByText("0/1 approved"),
    ).toBeInTheDocument();
  });

  /**
   * The D3 shape: the immediate parent is a withdrawn attempt that already
   * carried the requirement change, so the requirement is unchanged against it
   * and changed against the nearest approved ancestor. Measuring consultation
   * from the parent hid the subject, showed "All approved", and enabled a
   * sign-off the server refuses.
   */
  it("keeps a subject the server still owes visible when its change arrived through a withdrawn parent", () => {
    const detail = reviewDetailFixture(false);
    const base = detail.baseRevision;
    const current = detail.currentRevision;
    if (base === null || current === null) {
      throw new Error("Fixture requires both revisions");
    }
    base.revision.state = "withdrawn";
    base.elements = base.elements.map((entry) =>
      entry.element.id === "requirement-1"
        ? {
            ...entry,
            version: {
              ...entry.version,
              payload: {
                kind: "requirement" as const,
                statement: "Every execution pins the exact selected scope.",
                priority: "must" as const,
                risk: "high" as const,
              },
              payloadHash: "requirement-hash-2",
            },
          }
        : entry,
    );
    // No one approved R1 during the withdrawn attempt, so the server measures
    // it against the last approved ancestor and still owes the approval.
    detail.approvals = detail.approvals.filter(
      (approval) => approval.subject_kind !== "requirement",
    );
    detail.status.pendingApprovals = [
      { gate: "requirements", subject: "R1", elementId: "requirement-1" },
    ];
    detail.status.revisionSignOff = {
      revisionId: current.revision.id,
      revisionNumber: current.revision.number,
      state: "blocked",
      outstandingSubjectCount: 1,
      unmetConditions: [
        `Requirement R1 needs a valid approval for ${current.revision.id}.`,
      ],
      approval: null,
    };

    expect(bulkApprovalSubjects(detail, "remaining")).toEqual([
      { subjectKind: "requirement", elementId: "requirement-1" },
    ]);

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    expect(screen.getByText("1 awaiting approval")).toBeInTheDocument();
    const readiness = within(screen.getByTestId("review-readiness"));
    expect(readiness.getByText("2/3 approved")).toBeInTheDocument();
    expect(readiness.getByText("Approvals incomplete")).toBeInTheDocument();
    // The outstanding subject no longer blocks the act — the act writes it.
    expect(
      readiness.getByRole("button", {
        name: "Approve 1 remaining and sign off revision 2",
      }),
    ).toBeEnabled();
  });

  /**
   * Ticket #58: after a withdrawn attempt the re-proposed revision carries
   * most elements unchanged, yet no human ever approved them. The review
   * screen must let the reviewer read and approve each one individually —
   * hiding them behind the bulk sign-off act forces approval of everything
   * at once.
   */
  it("offers individual review and approval on an unchanged subject the server still owes", async () => {
    api.json(
      "POST",
      "/api/specs/command-center/native-sdd/actions/approve-item",
      {
        id: "approval-new",
        spec_id: "spec-1",
        subject_kind: "requirement",
        element_id: "requirement-1",
        revision_id: "revision-2",
        approver: "alex",
        granted_at: NOW,
        validity: "valid",
      },
    );
    const user = userEvent.setup();
    const detail = reviewDetailFixture(false);
    const base = detail.baseRevision;
    const current = detail.currentRevision;
    if (base === null || current === null) {
      throw new Error("Fixture requires both revisions");
    }
    base.revision.state = "withdrawn";
    base.elements = base.elements.map((entry) =>
      entry.element.id === "requirement-1"
        ? {
            ...entry,
            version: {
              ...entry.version,
              payload: {
                kind: "requirement" as const,
                statement: "Every execution pins the exact selected scope.",
                priority: "must" as const,
                risk: "high" as const,
              },
              payloadHash: "requirement-hash-2",
            },
          }
        : entry,
    );
    detail.approvals = detail.approvals.filter(
      (approval) => approval.subject_kind !== "requirement",
    );
    detail.status.pendingApprovals = [
      { gate: "requirements", subject: "R1", elementId: "requirement-1" },
    ];

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Awaiting approval" }),
    ).toBeInTheDocument();
    const requirement = screen.getByTestId("review-change-requirement-1");
    expect(
      within(requirement).getByRole("button", {
        name: /unchanged requirement/i,
      }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(requirement.querySelector("p")).toHaveTextContent(
        "Every execution pins the exact selected scope.",
      );
    });
    expect(
      within(requirement).getByTestId("review-criterion-criterion-1"),
    ).toBeVisible();
    // The quiet carried-forward list keeps only elements that are actually
    // approved — the promoted subject no longer hides among them.
    expect(
      screen.getByRole("button", { name: /1 unchanged element/i }),
    ).toBeInTheDocument();

    await user.click(
      within(requirement).getByRole("button", { name: "Approve item" }),
    );

    expect(await screen.findByText("R1 approved")).toBeInTheDocument();
    expect(
      api.requestsTo(
        "POST",
        "/api/specs/command-center/native-sdd/actions/approve-item",
      )[0]?.jsonBody,
    ).toEqual({
      revisionId: "revision-2",
      subjectKind: "requirement",
      elementId: "requirement-1",
    });
  });

  it("surfaces awaiting-approval cards even when the proposed revision matches its base", () => {
    const detail = reviewDetailFixture(false);
    const base = detail.baseRevision;
    const current = detail.currentRevision;
    if (base === null || current === null) {
      throw new Error("Fixture requires both revisions");
    }
    base.revision.state = "withdrawn";
    current.elements = base.elements.map((entry) => ({
      ...entry,
      version: { ...entry.version, revisionId: current.revision.id },
    }));
    detail.approvals = detail.approvals.filter(
      (approval) => approval.subject_kind !== "requirement",
    );
    detail.status.pendingApprovals = [
      { gate: "requirements", subject: "R1", elementId: "requirement-1" },
    ];

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    expect(
      screen.getByText(
        "No semantic changes — the proposed revision matches its base.",
      ),
    ).toBeInTheDocument();
    const requirement = screen.getByTestId("review-change-requirement-1");
    expect(
      within(requirement).getByRole("button", { name: "Approve item" }),
    ).toBeInTheDocument();
  });

  it("enables sign-off immediately under the fast-path combined policy", async () => {
    const user = userEvent.setup();
    const detail = reviewDetailFixture(false);
    renderWithQuery(
      <SpecReviewMode
        detail={{
          ...detail,
          spec: { ...detail.spec, gatePolicy: { preset: "fast-path" } },
        }}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const readiness = screen.getByTestId("review-readiness");
    expect(
      within(readiness).getByText("Sign-off approves all items"),
    ).toBeInTheDocument();
    expect(
      within(readiness).queryByText("0/0 approved"),
    ).not.toBeInTheDocument();
    expect(
      within(readiness).queryByRole("progressbar"),
    ).not.toBeInTheDocument();
    const trigger = within(readiness).getByRole("button", {
      name: "Sign off revision 2",
    });
    expect(trigger).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Approve item" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Unapprove item" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Covered by sign-off").length).toBeGreaterThan(
      0,
    );

    await user.click(trigger);
    expect(
      screen.getByText("Combined approval — this sign-off approves every item"),
    ).toBeInTheDocument();
  });

  it("makes an abandoned proposed revision read-only", () => {
    const detail = reviewDetailFixture(false);
    detail.spec = {
      ...detail.spec,
      abandonedAt: NOW,
      abandonedReason: "The product direction was withdrawn.",
    };
    detail.status.phase = {
      primary: "abandoned",
      authoringStage: "plan",
    };

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Abandoned spec — read-only" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Sign off revision/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve item" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Comment" }),
    ).not.toBeInTheDocument();
  });

  it("explains review termination and records an explicit sign-off acknowledgement", async () => {
    const user = userEvent.setup();
    renderReview(false);

    await user.click(screen.getByRole("button", { name: "Request changes" }));
    expect(
      screen.getByRole("heading", {
        name: "Request changes — end this review?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/It is not a comment/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep reviewing" }));

    await user.click(
      screen.getByRole("button", { name: "Sign off revision 2" }),
    );
    expect(
      screen.getByRole("checkbox", {
        name: /I reviewed the semantic change list/i,
      }),
    ).toBeInTheDocument();
    const confirm = screen.getByRole("button", {
      name: "Sign off — freeze revision 2",
    });
    expect(confirm).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: /I reviewed the semantic change list/i,
      }),
    );
    expect(confirm).toBeEnabled();
  });

  it("reports a successful request-changes transition to the parent shell", async () => {
    const detail = reviewDetailFixture(false);
    const current = detail.currentRevision;
    if (current === null) throw new Error("Fixture requires a revision");
    api.json(
      "POST",
      "/api/specs/command-center/native-sdd/actions/request-changes",
      {
        withdrawn: { ...current.revision, state: "withdrawn" },
        draft: {
          ...current.revision,
          id: "revision-3",
          number: 3,
          state: "draft",
          basedOnRevisionId: current.revision.id,
          proposedAt: null,
        },
      },
    );
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
        onComplete={onComplete}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Request changes" }));
    await user.click(
      screen.getByRole("button", { name: "End review — open draft" }),
    );

    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith("Draft revision 3 opened"),
    );
  });
});

/**
 * Ticket #50's live case: revision 3 was approved from revision 1's content,
 * forking past the still-proposed revision 2. The lineage head is approved, so
 * every surface that keyed off the newest revision reported nothing awaiting
 * review while revision 2 sat unreachable.
 */
function strandedProposalFixture(): SpecDetailView {
  const detail = reviewDetailFixture(false);
  const proposal = detail.currentRevision;
  const base = detail.baseRevision;
  if (proposal === null || base === null) {
    throw new Error(
      "Stranded fixture requires a proposal over an approved base",
    );
  }
  const forkedPast = {
    ...base.revision,
    id: "revision-3",
    number: 3,
    state: "approved" as const,
    basedOnRevisionId: base.revision.id,
    contentHash: "revision-3-hash",
    proposedAt: NOW,
    approvedAt: NOW,
  };
  const forkedPastSnapshot = {
    revision: forkedPast,
    elements: base.elements.map((entry) => ({
      ...entry,
      version: { ...entry.version, revisionId: forkedPast.id },
    })),
  };
  const revisions = [base.revision, proposal.revision, forkedPast];
  return {
    ...detail,
    revisions,
    liveProposals: liveProposalsFixture(revisions, [
      base,
      proposal,
      forkedPastSnapshot,
    ]),
    baseRevision: base,
    currentRevision: forkedPastSnapshot,
    currentApprovedRevision: forkedPastSnapshot,
  };
}

describe("SpecReviewMode stranded proposals", () => {
  it("lists a proposal an approved revision forked past instead of reporting nothing awaiting review", () => {
    renderWithQuery(
      <SpecReviewMode
        detail={strandedProposalFixture()}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    expect(
      screen.queryByText("Nothing awaiting review"),
    ).not.toBeInTheDocument();
    const superseded = screen.getByTestId("superseded-proposal-review");
    expect(within(superseded).getByText(/revision 3/i)).toBeInTheDocument();
    expect(
      within(superseded).getByRole("button", {
        name: /Dismiss superseded proposal/i,
      }),
    ).toBeInTheDocument();
    // Read-only: a proposal the lineage forked past cannot be signed off or
    // approved item by item — dismissal is its only exit.
    expect(
      screen.queryByRole("button", { name: /Sign off revision/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Approve all remaining/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the stranded proposal's own diff against its base", async () => {
    renderWithQuery(
      <SpecReviewMode
        detail={strandedProposalFixture()}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const requirement = screen.getByTestId("superseded-change-requirement-1");
    // The proposal changed R1's statement over revision 1, so the read-only
    // view must show revision 1 → 2 — its own diff, not the approved head's.
    expect(within(requirement).getByText("Revision 1 → 2")).toBeVisible();
    expect(
      await within(requirement).findByText("the exact selected", {
        selector: "ins",
      }),
    ).toBeVisible();
    expect(within(requirement).getByText("Modified requirement")).toBeVisible();
  });

  it("records the dismissal through the production action with the operator's reason", async () => {
    const detail = strandedProposalFixture();
    const stranded = detail.liveProposals[0];
    if (stranded === undefined) throw new Error("Fixture requires a proposal");
    api.json(
      "POST",
      "/api/specs/command-center/native-sdd/actions/dismiss-superseded",
      {
        withdrawn: { ...stranded.revision, state: "withdrawn" },
        supersession: {
          revisionId: stranded.revision.id,
          specId: detail.spec.id,
          supersededByRevisionId: "revision-3",
          reason: "Revision 3 carries this content already.",
          actor: { kind: "human" },
          dismissedAt: NOW,
        },
      },
    );
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
        onComplete={onComplete}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Dismiss superseded proposal/i }),
    );
    await user.type(
      screen.getByRole("textbox", {
        name: /Why this proposal is being ended/i,
      }),
      "Revision 3 carries this content already.",
    );
    await user.click(
      screen.getByRole("button", { name: /Dismiss revision 2/i }),
    );

    await waitFor(() =>
      expect(
        api.requestsTo(
          "POST",
          "/api/specs/command-center/native-sdd/actions/dismiss-superseded",
        )[0]?.jsonBody,
      ).toEqual({
        revisionId: stranded.revision.id,
        reason: "Revision 3 carries this content already.",
      }),
    );
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        "Revision 2 dismissed as superseded",
      ),
    );
  });

  it("keeps the current proposal's full actions while the stranded one stays reachable", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <SpecReviewMode
        detail={strandedAndCurrentProposalFixture()}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    // The current proposal is what a reviewer lands on; today's full actions
    // are unchanged for it.
    expect(
      screen.getByRole("button", { name: "Sign off revision 4" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("radio", { name: /Revision 2 — superseded/i }),
    );
    expect(
      screen.getByTestId("superseded-proposal-review"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Sign off revision/i }),
    ).not.toBeInTheDocument();
  });
});

/**
 * The stranded revision 2 alongside a revision 4 still on the live line, so
 * the surface carries a real choice of proposal to view.
 */
function strandedAndCurrentProposalFixture(): SpecDetailView {
  const stranded = strandedProposalFixture();
  const forkedPast = stranded.currentRevision;
  if (forkedPast === null) throw new Error("Fixture requires an approved head");
  const currentProposal = {
    revision: {
      ...forkedPast.revision,
      id: "revision-4",
      number: 4,
      state: "proposed" as const,
      basedOnRevisionId: forkedPast.revision.id,
      contentHash: "revision-4-hash",
      approvedAt: null,
    },
    elements: forkedPast.elements,
  };
  const revisions = [...stranded.revisions, currentProposal.revision];
  return {
    ...stranded,
    revisions,
    liveProposals: liveProposalsFixture(revisions, [
      ...(stranded.baseRevision === null ? [] : [stranded.baseRevision]),
      ...stranded.liveProposals.map((entry) => entry.snapshot),
      forkedPast,
      currentProposal,
    ]),
    currentRevision: currentProposal,
    status: {
      ...stranded.status,
      revisionSignOff: {
        revisionId: currentProposal.revision.id,
        revisionNumber: currentProposal.revision.number,
        state: "ready" as const,
        outstandingSubjectCount: 0,
        unmetConditions: [],
        approval: null,
      },
    },
  };
}

/**
 * The plan preview is the compiled shape a launch would produce — lane-group
 * collapse, the criterion briefs unioned into each context's contract, and the
 * edges derived from task dependencies. None of it is derivable from the spec
 * content the review surface already holds, which is why these assertions are
 * about the server's answer arriving on the proposal being viewed rather than
 * about anything Studio could compute.
 */
describe("SpecReviewMode plan preview", () => {
  it("embeds the server's compiled preview for the plan-stage proposal under review", async () => {
    renderWithQuery(
      <SpecReviewMode
        detail={reviewDetailFixture(false)}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const panel = await screen.findByTestId("plan-preview-panel");
    // Lane-group collapse and the brief union happen inside the compiler, so a
    // client-side recomputation over the fixture's own elements could not
    // produce this context, its two task handles, or its brief.
    const context = await within(panel).findByTestId(
      "plan-preview-context-persistence",
    );
    expect(within(context).getByText("Persistence lane group")).toBeVisible();
    expect(within(context).getByText(/T1, T2/)).toBeVisible();
    expect(within(context).getByText("R1.1")).toBeVisible();
    expect(
      within(context).getByText(
        "Prove R1.1 with a test_run over the reloaded repository.",
      ),
    ).toBeVisible();
    expect(within(panel).getByText(/persistence → surface/)).toBeVisible();
    // An unproducible evidence kind is the preview's headline finding: the
    // criterion demanding it can never reach a proof.
    expect(
      within(panel).getByTestId("plan-preview-evidence-gaps"),
    ).toHaveTextContent(/Evidence gaps: screenshot/);

    expect(previewedRevisionIds()).toEqual(["revision-2"]);
  });

  it("follows the one selection model that drives the diff cards", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <SpecReviewMode
        detail={strandedAndCurrentProposalFixture()}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    await screen.findByTestId("plan-preview-context-persistence");
    expect(previewedRevisionIds()).toEqual(["revision-4"]);
    // The scope hash is the one rendered fact that comes from the RESPONSE
    // rather than from the revision prop, so it is what distinguishes a
    // re-rendered heading over a stale body from a body the server recompiled.
    expect(screen.getByText(/scope scope-revision-4/)).toBeVisible();

    await user.click(
      screen.getByRole("radio", { name: /Revision 2 — superseded/i }),
    );

    // One pick moves the diff cards and the preview together: a second
    // selection model would leave the preview compiled against revision 4
    // while the cards show revision 2's changes.
    expect(
      screen.getByTestId("superseded-proposal-review"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(previewedRevisionIds()).toEqual(["revision-4", "revision-2"]),
    );
    const panel = await screen.findByTestId("plan-preview-panel");
    expect(
      await within(panel).findByTestId("plan-preview-context-persistence"),
    ).toBeVisible();
    expect(within(panel).getByText(/Revision 2 as the compiler/)).toBeVisible();
    expect(
      await within(panel).findByText(/scope scope-revision-2/),
    ).toBeVisible();
    expect(
      within(panel).queryByText(/scope scope-revision-4/),
    ).not.toBeInTheDocument();
  });

  it("shows the server's refusal, with its remedy, when the plan does not compile", async () => {
    api.reply("POST", PLAN_PREVIEW_PATH, {
      status: 422,
      json: {
        error:
          "Cannot compile lane-group cycle: persistence -> surface -> persistence. Repair the plan elements or the selection in --scope, then re-run cctl spec plan preview native-sdd.",
        code: "plan_preview_uncompilable",
      },
    });
    renderWithQuery(
      <SpecReviewMode
        detail={reviewDetailFixture(false)}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    expect(
      await screen.findByText(/Cannot compile lane-group cycle/),
    ).toBeVisible();
    expect(
      screen.getByText(/Repair the plan elements or the selection/),
    ).toBeVisible();
  });
});

const CURRENT_NOTES = "Round 4 disposition: closed F3 by rebinding the exit.";
const STRANDED_NOTES = "Round 2 disposition: split R1 into R1 and R4.";

/**
 * A lineage carrying both a current proposal and one an approval forked past,
 * each proposed with its own disposition document. The notes must follow the
 * selection rather than the lineage head: the stranded proposal's account of
 * itself is exactly what a human reads before deciding to dismiss it.
 */
function twoProposalsWithNotesFixture(): SpecDetailView {
  const stranded = strandedProposalFixture();
  const forkedPast = stranded.currentRevision;
  const base = stranded.baseRevision;
  if (forkedPast === null || base === null) {
    throw new Error("Fixture requires an approved head over a base");
  }
  const strandedProposal = stranded.liveProposals[0];
  if (strandedProposal === undefined) {
    throw new Error("Fixture requires a stranded proposal");
  }
  // Based on the same revision the approved head was, so it is the lineage's
  // live proposal, and carrying the stranded attempt's content so its own
  // change list is non-empty.
  const currentProposal = {
    revision: {
      ...forkedPast.revision,
      id: "revision-4",
      number: 4,
      state: "proposed" as const,
      basedOnRevisionId: base.revision.id,
      contentHash: "revision-4-hash",
      approvedAt: null,
    },
    elements: strandedProposal.snapshot.elements,
  };
  const revisions = [...stranded.revisions, currentProposal.revision];
  return {
    ...stranded,
    revisions,
    liveProposals: liveProposalsFixture(
      revisions,
      [
        ...(stranded.baseRevision === null ? [] : [stranded.baseRevision]),
        ...stranded.liveProposals.map((entry) => entry.snapshot),
        forkedPast,
        currentProposal,
      ],
      {
        [strandedProposal.revision.id]: STRANDED_NOTES,
        [currentProposal.revision.id]: CURRENT_NOTES,
      },
    ),
    currentRevision: currentProposal,
  };
}

describe("SpecReviewMode proposal notes", () => {
  it("follows the selection to a stranded proposal's own notes", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <SpecReviewMode
        detail={twoProposalsWithNotesFixture()}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    await user.click(
      screen.getByRole("radio", { name: /Revision 2 — superseded/i }),
    );

    const superseded = screen.getByTestId("superseded-proposal-review");
    const notes = within(superseded).getByTestId("proposal-notes");
    expect(within(notes).getByText(STRANDED_NOTES)).toBeInTheDocument();
    expect(screen.queryByText(CURRENT_NOTES)).not.toBeInTheDocument();
    const firstChange =
      within(superseded).getAllByTestId(/^superseded-change-/)[0];
    if (firstChange === undefined) {
      throw new Error("Fixture requires at least one change card");
    }
    expect(
      notes.compareDocumentPosition(firstChange) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

/**
 * The convergence case: threads, questions, and assumptions are all resolved,
 * so the only thing between the reviewer and a signed-off revision is the set
 * of subject approvals the one act writes with the sign-off.
 */
function outstandingApprovalsFixture(): SpecDetailView {
  const detail = reviewDetailFixture(false);
  const signOff = detail.status.revisionSignOff;
  if (signOff === null) throw new Error("Fixture requires a sign-off block");
  return {
    ...detail,
    status: {
      ...detail.status,
      pendingApprovals: [
        {
          gate: "requirements" as const,
          subject: "R1",
          elementId: "requirement-1",
        },
        { gate: "design" as const, subject: "D1", elementId: "decision-1" },
        { gate: "plan" as const, subject: "plan", elementId: null },
      ],
      revisionSignOff: {
        ...signOff,
        state: "blocked" as const,
        outstandingSubjectCount: 3,
      },
    },
    approvals: [],
  };
}

describe("SpecReviewMode combined approve-and-sign-off", () => {
  it("replaces the two-step flow with one act naming the subjects it approves", async () => {
    const api = installFetchFixture();
    // This local fixture shadows the shared one, so it has to answer the
    // preview request too: Review compiles a plan preview for the proposal it
    // shows, and an unanswered one renders a second `role="alert"` beside the
    // refusal this test is about.
    api.reply("POST", PLAN_PREVIEW_PATH, (request) => ({
      json: planPreviewResponseFixture(request.jsonBody),
    }));
    try {
      const detail = outstandingApprovalsFixture();
      const current = detail.currentRevision;
      if (current === null) throw new Error("Fixture requires a revision");
      api.json(
        "POST",
        "/api/specs/command-center/native-sdd/actions/approve-remaining-and-sign-off",
        {
          revision: { ...current.revision, state: "approved", approvedAt: NOW },
          approval: null,
          subjectApprovals: [],
        },
      );
      const onComplete = vi.fn();
      const user = userEvent.setup();
      renderWithQuery(
        <SpecReviewMode
          detail={detail}
          projectName="command-center"
          highlightedChangeId={null}
          onComplete={onComplete}
        />,
      );

      // The separate "approve everything, then sign off" step is gone.
      expect(
        screen.queryByRole("button", { name: /Approve all remaining/i }),
      ).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("button", {
          name: "Approve 3 remaining and sign off revision 2",
        }),
      );

      const subjects = screen.getByTestId("combined-sign-off-subjects");
      expect(subjects).toHaveTextContent("requirementsR1");
      expect(subjects).toHaveTextContent("designD1");
      expect(subjects).toHaveTextContent("planplan");

      await user.click(
        screen.getByRole("checkbox", {
          name: /I reviewed the semantic change list/i,
        }),
      );
      await user.click(
        screen.getByRole("button", {
          name: "Approve 3 and sign off — freeze revision 2",
        }),
      );

      await waitFor(() =>
        expect(onComplete).toHaveBeenCalledWith("Revision 2 signed off"),
      );
      const posted = api.requestsTo(
        "POST",
        "/api/specs/command-center/native-sdd/actions/approve-remaining-and-sign-off",
      );
      expect(posted).toHaveLength(1);
      expect(posted[0]?.jsonBody).toEqual({ revisionId: "revision-2" });
    } finally {
      api.restore();
    }
  });

  it("keeps the per-item approve action for a targeted re-consult", () => {
    renderWithQuery(
      <SpecReviewMode
        detail={outstandingApprovalsFixture()}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    expect(
      screen.getAllByRole("button", { name: "Approve item" }).length,
    ).toBeGreaterThan(0);
  });

  it("surfaces the live-sibling refusal inline with the stranded revision and its remedy", async () => {
    const api = installFetchFixture();
    // This local fixture shadows the shared one, so it has to answer the
    // preview request too: Review compiles a plan preview for the proposal it
    // shows, and an unanswered one renders a second `role="alert"` beside the
    // refusal this test is about.
    api.reply("POST", PLAN_PREVIEW_PATH, (request) => ({
      json: planPreviewResponseFixture(request.jsonBody),
    }));
    try {
      api.reply(
        "POST",
        "/api/specs/command-center/native-sdd/actions/approve-remaining-and-sign-off",
        {
          status: 409,
          json: {
            code: "revision_in_review",
            unmetConditions: [
              "Signing off revision 2 would fork past revision 4 (revision-stranded), which is still proposed and would be left unactionable.",
            ],
            instruction:
              'Dispose of revision 4 first: dismiss it from Spec Studio → Review, using "Dismiss superseded proposal" on revision revision-stranded, or have its author run `cctl spec withdraw-proposal native-sdd --revision revision-stranded`. Then sign off revision 2 again.',
          },
        },
      );
      const user = userEvent.setup();
      renderWithQuery(
        <SpecReviewMode
          detail={outstandingApprovalsFixture()}
          projectName="command-center"
          highlightedChangeId={null}
        />,
      );

      await user.click(
        screen.getByRole("button", {
          name: "Approve 3 remaining and sign off revision 2",
        }),
      );
      await user.click(
        screen.getByRole("checkbox", {
          name: /I reviewed the semantic change list/i,
        }),
      );
      await user.click(
        screen.getByRole("button", {
          name: "Approve 3 and sign off — freeze revision 2",
        }),
      );

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("revision-stranded");
      expect(alert).toHaveTextContent("Dismiss superseded proposal");
    } finally {
      api.restore();
    }
  });
});

describe("reviewAttentionCount", () => {
  /**
   * An import that arrived fully disposed owes the reviewer nothing: every
   * question came answered, every assumption came disposed, and the revision is
   * approved rather than proposed. A non-zero badge here would send a human to
   * a Review screen with no act to perform (R9.7).
   */
  it("is zero for a fully-disposed delivered import", () => {
    expect(reviewAttentionCount(importedDeliveredSpecDetailFixture())).toBe(0);
  });

  /**
   * The zero above is not "imports are exempt": a proposal the import's
   * approved revision forked past is still one dismissal a human owes, and it
   * has to survive the import provenance to stay visible (#50).
   */
  it("still counts a proposal stranded past an imported revision", () => {
    const imported = importedDeliveredSpecDetailFixture();
    const stranded = strandedProposalDetailFixture();

    expect(
      reviewAttentionCount({
        ...stranded,
        importRecord: imported.importRecord,
        gateAdmissions: imported.gateAdmissions,
      }),
    ).toBeGreaterThan(0);
  });
});
