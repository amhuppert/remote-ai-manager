// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyApprovalLedger } from "@/lib/specs/approval-ledger";
import { useSpecDetailQuery, type SpecDetailView } from "@/lib/specs/queries";
import type { SpecRevisionElement } from "@/lib/specs/schemas";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";

import {
  importedDeliveredSpecDetailFixture,
  liveProposalsFixture,
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

let api: FetchFixture;

beforeEach(() => {
  api = installFetchFixture();
});

afterEach(() => {
  cleanup();
  api.restore();
});

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
    assumptionCitations: [],
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
        recordVersion: 1,
        status: blocked ? "open" : "answered",
        answer: blocked ? null : "The execution-start gate.",
        answeredAt: blocked ? null : NOW,
        withdrawnAt: null,
        provenance: { kind: "human" },
        presentation: {
          state: "current",
          attentionActive: blocked,
          lastMutation: null,
          humanCapability: blocked
            ? { kind: "answer", allowed: true }
            : {
                kind: "answer",
                allowed: false,
                code: "terminal",
                blockingRevisionId: null,
                instruction: "This question has a terminal answer.",
              },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "question-2",
        number: 2,
        handle: "Q2",
        elementId: null,
        text: "Does the review preserve raw diff access?",
        recordVersion: 1,
        status: "answered",
        answer: "Yes, as a secondary view.",
        answeredAt: NOW,
        withdrawnAt: null,
        provenance: { kind: "agent", conversationId: "conversation-1" },
        presentation: {
          state: "current",
          attentionActive: false,
          lastMutation: null,
          humanCapability: {
            kind: "answer",
            allowed: false,
            code: "terminal",
            blockingRevisionId: null,
            instruction: "This question has a terminal answer.",
          },
        },
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
        recordVersion: 1,
        disposition: blocked ? "rejected" : "confirmed",
        disposedAt: NOW,
        withdrawnAt: null,
        proposedBy: { kind: "agent", conversationId: "conversation-1" },
        supersedesHandle: null,
        supersededByHandle: null,
        currentDraftCitations: null,
        presentation: {
          state: "current",
          attentionActive: false,
          lastMutation: null,
          humanCapability: {
            kind: "dispose",
            allowed: false,
            code: "terminal",
            blockingRevisionId: null,
            instruction: "This assumption is terminal.",
          },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "assumption-2",
        number: 2,
        handle: "A2",
        elementId: "requirement-1",
        text: "The gate screen can reuse the pinned scope projection.",
        recordVersion: 1,
        disposition: blocked ? "proposed" : "confirmed",
        disposedAt: blocked ? null : NOW,
        withdrawnAt: null,
        proposedBy: { kind: "agent", conversationId: "conversation-1" },
        supersedesHandle: null,
        supersededByHandle: null,
        currentDraftCitations: null,
        presentation: {
          state: "current",
          attentionActive: blocked,
          lastMutation: null,
          humanCapability: blocked
            ? { kind: "dispose", allowed: true }
            : {
                kind: "dispose",
                allowed: false,
                code: "terminal",
                blockingRevisionId: null,
                instruction: "This assumption is terminal.",
              },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "assumption-3",
        number: 3,
        handle: "A3",
        elementId: null,
        text: "Historical raw diffs use the same formatter.",
        recordVersion: 1,
        disposition: "deferred",
        disposedAt: NOW,
        withdrawnAt: null,
        proposedBy: { kind: "human" },
        supersedesHandle: null,
        supersededByHandle: null,
        currentDraftCitations: null,
        presentation: {
          state: "current",
          attentionActive: false,
          lastMutation: null,
          humanCapability: {
            kind: "dispose",
            allowed: false,
            code: "terminal",
            blockingRevisionId: null,
            instruction: "This assumption is terminal.",
          },
        },
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

describe("SpecReviewMode revision premises", () => {
  it("renders the selected revision citation snapshot instead of mutable current-row text", () => {
    const detail = reviewDetailFixture(false);
    const current = detail.currentRevision;
    if (current === null) throw new Error("Review fixture requires a proposal");
    current.assumptionCitations = [
      {
        revisionId: current.revision.id,
        specId: detail.spec.id,
        elementId: "requirement-1",
        assumptionId: "assumption-1",
        snapshot: {
          schemaVersion: 1,
          captureKind: "native",
          capturedAt: NOW,
          assumptionId: "assumption-1",
          number: 1,
          recordVersion: 1,
          text: "Pinned premise from revision 2.",
          elementId: "requirement-1",
          proposedBy: { kind: "agent", conversationId: "conversation-1" },
          disposition: "confirmed",
          disposedAt: NOW,
          withdrawnAt: null,
          supersedesAssumptionId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    detail.assumptions[0] = {
      ...detail.assumptions[0]!,
      text: "Mutable current-row premise.",
      recordVersion: 2,
    };

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const premises = screen.getByRole("region", { name: "Revision premises" });
    expect(
      within(premises).getByText("Pinned premise from revision 2."),
    ).toBeVisible();
    expect(
      within(premises).queryByText("Mutable current-row premise."),
    ).toBeNull();
    expect(within(premises).getByText("A1")).toBeVisible();
    expect(within(premises).getByText("Cited by R1")).toBeVisible();
  });
});

function ReviewDetailQueryHarness(): React.JSX.Element {
  const detail = useSpecDetailQuery("command-center", "native-sdd").data;
  if (detail === undefined) return <span>Loading review</span>;
  return (
    <SpecReviewMode
      detail={detail}
      projectName="command-center"
      highlightedChangeId={null}
    />
  );
}

function persistedCommentRow(comment: SpecDetailView["comments"][number]) {
  return {
    id: comment.id,
    spec_id: "spec-1",
    thread_id: comment.threadId,
    parent_comment_id: comment.parentCommentId,
    element_id: comment.elementId,
    anchor_json: JSON.stringify(comment.anchor),
    revision_id: comment.revisionId,
    body: comment.body,
    author_json: JSON.stringify(comment.author),
    blocking: comment.blocking ? 1 : 0,
    resolution: comment.resolution,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

describe("SpecReviewMode", () => {
  it("compares a resubmitted proposal with its nearest approved ancestor", () => {
    const detail = reviewDetailFixture();
    const entry = detail.liveProposals[0];
    if (!entry || entry.governanceBaseSnapshot === null) {
      throw new Error("Review fixture requires an approved baseline");
    }
    const unapprovedBase = {
      ...entry.snapshot,
      revision: {
        ...entry.snapshot.revision,
        id: "revision-2-unapproved",
        number: 2,
        state: "proposed" as const,
        approvedAt: null,
      },
    };
    const resubmitted = {
      ...entry.snapshot,
      revision: {
        ...entry.snapshot.revision,
        id: "revision-3",
        number: 3,
        basedOnRevisionId: unapprovedBase.revision.id,
      },
    };
    detail.liveProposals = [
      {
        ...entry,
        revision: resubmitted.revision,
        snapshot: resubmitted,
        baseSnapshot: unapprovedBase,
      },
    ];

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const title = screen.getByRole("heading", {
      name: "Review plan-stage revision 3",
    });
    expect(title.parentElement).toHaveTextContent("over approved revision 1");
    expect(title.parentElement).not.toHaveTextContent("over revision 2");
  });

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

  it("keeps both review comment controls at least 44px tall at every viewport", async () => {
    const user = userEvent.setup();
    renderReview();

    const requirement = screen.getByTestId("review-change-requirement-1");
    const openComposer = within(requirement).getByRole("button", {
      name: "Comment",
    });
    expect(openComposer).toHaveClass("min-h-[44px]");

    await user.click(openComposer);

    const submit = within(requirement).getByRole("button", {
      name: "Record comment",
    });
    expect(submit).toHaveClass("min-h-[44px]", "min-w-[44px]");
  });

  it("logs a recorded root with the returned thread identity and no comment content", async () => {
    const detail = reviewDetailFixture(false);
    const root = detail.comments[0]!;
    api.json(
      "POST",
      "/api/specs/command-center/native-sdd/actions/comment",
      persistedCommentRow({
        ...root,
        id: "comment-recorded",
        threadId: "thread-returned-by-server",
        body: "Server-normalized body",
      }),
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const requirement = screen.getByTestId("review-change-requirement-1");
    await user.click(
      within(requirement).getByRole("button", { name: "Comment" }),
    );
    await user.type(
      within(requirement).getByRole("textbox", { name: "Comment on R1" }),
      "Sensitive reviewer rationale",
    );
    await user.click(
      within(requirement).getByRole("button", { name: "Record comment" }),
    );

    await waitFor(() =>
      expect(info).toHaveBeenCalledWith("spec_studio.comment.root.completed", {
        module: "spec-studio-comments",
        specId: detail.spec.id,
        revisionId: detail.currentRevision!.revision.id,
        elementId: "requirement-1",
        threadId: "thread-returned-by-server",
      }),
    );
    info.mockRestore();
  });

  it("logs a failed root write with a safe error and no comment content", async () => {
    const detail = reviewDetailFixture(false);
    api.reply("POST", "/api/specs/command-center/native-sdd/actions/comment", {
      status: 409,
      json: { error: "Comment persistence unavailable" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const requirement = screen.getByTestId("review-change-requirement-1");
    await user.click(
      within(requirement).getByRole("button", { name: "Comment" }),
    );
    await user.type(
      within(requirement).getByRole("textbox", { name: "Comment on R1" }),
      "Sensitive reviewer rationale",
    );
    await user.click(
      within(requirement).getByRole("button", { name: "Record comment" }),
    );

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith("spec_studio.comment.root.failed", {
        module: "spec-studio-comments",
        specId: detail.spec.id,
        revisionId: detail.currentRevision!.revision.id,
        elementId: "requirement-1",
        threadId: expect.any(String),
        error: "Comment persistence unavailable",
      }),
    );
    warn.mockRestore();
  });

  it("assembles reply-before-root rows into one attributed actionable thread", () => {
    const detail = reviewDetailFixture(false);
    const root = {
      ...detail.comments[0]!,
      id: "comment-z-root",
      blocking: false,
      resolution: "open" as const,
    };
    detail.comments = [
      {
        ...root,
        id: "comment-a-reply",
        parentCommentId: root.id,
        body: "The gate now reads the same pinned scope.",
        author: {
          kind: "agent",
          conversationId: "conversation/review-reply",
          backend: "claude",
        },
      },
      root,
    ];

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const thread = screen.getByTestId("review-thread-thread-1");
    const messages = within(thread).getAllByRole("listitem");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toHaveTextContent("Root");
    expect(messages[0]).toHaveTextContent(
      "Confirm the gate screen uses the same scope.",
    );
    expect(messages[1]).toHaveTextContent("Reply");
    expect(messages[1]).toHaveTextContent("Claude agent");
    expect(within(thread).getAllByText(/Every execution/)).toHaveLength(1);
    expect(
      within(thread).getByRole("link", {
        name: "Open conversation from Claude agent (conversation/review-reply)",
      }),
    ).toHaveAttribute("href", "/conversations?c=conversation%2Freview-reply");
    expect(within(thread).getByRole("button", { name: "Reply" })).toBeVisible();
    expect(
      within(thread).getByRole("button", { name: "Resolve" }),
    ).toBeVisible();
  });

  it("posts shared Reply and Resolve actions and refreshes readiness from detail", async () => {
    let detail = reviewDetailFixture(false);
    detail = {
      ...detail,
      comments: detail.comments.map((comment) => ({
        ...comment,
        blocking: true,
        resolution: "open" as const,
      })),
    };
    api.reply("GET", "/api/specs/command-center/native-sdd", () => ({
      json: detail,
    }));
    api.reply(
      "POST",
      "/api/specs/command-center/native-sdd/actions/reply",
      (request) => {
        const body = request.jsonBody as { threadId: string; body: string };
        const root = detail.comments[0]!;
        return {
          json: persistedCommentRow({
            ...root,
            id: "comment-reply",
            threadId: body.threadId,
            parentCommentId: root.id,
            body: body.body,
            author: { kind: "human" },
          }),
        };
      },
    );
    api.reply(
      "POST",
      "/api/specs/command-center/native-sdd/actions/resolve-thread",
      () => {
        detail = {
          ...detail,
          comments: detail.comments.map((comment) => ({
            ...comment,
            resolution: "resolved" as const,
          })),
        };
        return { json: detail.comments.map(persistedCommentRow) };
      },
    );
    const user = userEvent.setup();
    renderWithQuery(<ReviewDetailQueryHarness />);

    const thread = await screen.findByTestId("review-thread-thread-1");
    const readiness = screen.getByTestId("review-readiness");
    expect(within(readiness).getByText("1 blocking thread")).toBeVisible();
    await user.click(within(thread).getByRole("button", { name: "Reply" }));
    await user.type(
      within(thread).getByRole("textbox", {
        name: "Reply to review thread",
      }),
      "The shared scope is confirmed.",
    );
    await user.click(
      within(thread).getByRole("button", { name: "Send reply" }),
    );
    await waitFor(() =>
      expect(
        api.requestsTo(
          "POST",
          "/api/specs/command-center/native-sdd/actions/reply",
        )[0]?.jsonBody,
      ).toEqual({
        threadId: "thread-1",
        body: "The shared scope is confirmed.",
      }),
    );

    await user.click(within(thread).getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(
        api.requestsTo(
          "POST",
          "/api/specs/command-center/native-sdd/actions/resolve-thread",
        )[0]?.jsonBody,
      ).toEqual({
        revisionId: "revision-2",
        threadId: "thread-1",
        resolution: "resolved",
      }),
    );
    expect(
      await within(readiness).findByText("Threads resolved"),
    ).toBeVisible();
    expect(
      within(readiness).getByRole("button", { name: "Sign off revision 2" }),
    ).toBeEnabled();
  });

  it("keeps Reply but hides Resolve on an open historical root", () => {
    const detail = reviewDetailFixture(false);
    const base = detail.baseRevision;
    if (base === null) throw new Error("Fixture requires a base revision");
    base.revision.state = "withdrawn";
    detail.comments = detail.comments.map((comment) => ({
      ...comment,
      revisionId: base.revision.id,
      revisionNumber: base.revision.number,
      resolution: "open" as const,
    }));

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const fallback = screen.getByRole("heading", {
      name: "Historical & orphaned review threads",
    }).parentElement!;
    const thread = within(fallback).getByTestId("review-thread-thread-1");
    expect(within(thread).getByRole("button", { name: "Reply" })).toBeVisible();
    expect(
      within(thread).queryByRole("button", { name: "Resolve" }),
    ).toBeNull();
  });

  it("places a criterion thread inside its parent requirement region", () => {
    const detail = reviewDetailFixture(false);
    const current = detail.currentRevision;
    if (current === null) throw new Error("Fixture requires a revision");
    const criterion = current.elements.find(
      ({ element }) => element.id === "criterion-1",
    );
    if (criterion?.version.payload.kind !== "criterion") {
      throw new Error("Fixture requires a criterion");
    }
    const quote = criterion.version.payload.text.slice(0, 18);
    detail.comments = [
      {
        ...detail.comments[0]!,
        id: "criterion-comment",
        threadId: "criterion-thread",
        elementId: criterion.element.id,
        handle: "R1.1",
        anchor: {
          sectionId: "R1.1",
          headingLabel: "R1.1",
          line: 1,
          charStart: 0,
          charEnd: quote.length,
          quote,
          prefix: "",
          suffix: criterion.version.payload.text.slice(
            quote.length,
            quote.length + 32,
          ),
          docRevision: current.revision.contentHash,
        },
        quote,
        body: "Keep this criterion measurable.",
        blocking: false,
        resolution: "open",
      },
    ];

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const requirement = screen.getByTestId("review-change-requirement-1");
    const criterionRegion = within(requirement).getByTestId(
      "review-criterion-criterion-1",
    );
    expect(
      within(criterionRegion).getByTestId("review-thread-criterion-thread"),
    ).toBeVisible();
    expect(
      screen.getAllByTestId("review-thread-criterion-thread"),
    ).toHaveLength(1);
  });

  it("promotes a current unchanged commented subject to a review card", () => {
    const detail = reviewDetailFixture(false);
    const base = detail.baseRevision;
    const current = detail.currentRevision;
    if (base === null || current === null) {
      throw new Error("Fixture requires both revisions");
    }
    const currentRequirement = current.elements.find(
      ({ element }) => element.id === "requirement-1",
    );
    if (currentRequirement === undefined) {
      throw new Error("Fixture requires a requirement");
    }
    base.elements = base.elements.map((entry) =>
      entry.element.id === "requirement-1"
        ? {
            ...currentRequirement,
            version: {
              ...currentRequirement.version,
              revisionId: base.revision.id,
            },
          }
        : entry,
    );

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Commented unchanged" }),
    ).toBeVisible();
    const requirement = screen.getByTestId("review-change-requirement-1");
    expect(
      within(requirement).getByRole("button", {
        name: "Unchanged requirement",
      }),
    ).toBeVisible();
    expect(
      within(requirement).getByTestId("review-thread-thread-1"),
    ).toBeVisible();
  });

  it("co-locates a current section root and falls back historical and removed roots exactly once", () => {
    const detail = reviewDetailFixture(false);
    const base = detail.baseRevision;
    const current = detail.currentRevision;
    if (base === null || current === null) {
      throw new Error("Fixture requires both revisions");
    }
    const historical = {
      ...detail.comments[0]!,
      id: "historical-root",
      threadId: "historical-thread",
      revisionId: base.revision.id,
      revisionNumber: base.revision.number,
    };
    const removed = {
      ...detail.comments[0]!,
      id: "removed-root",
      threadId: "removed-thread",
      elementId: "removed-element",
      handle: null,
    };
    const section: SpecRevisionElement = {
      element: {
        id: "section-review-context",
        specId: detail.spec.id,
        kind: "section",
        number: null,
        parentElementId: null,
        createdAt: NOW,
      },
      version: {
        revisionId: current.revision.id,
        elementId: "section-review-context",
        position: current.elements.length,
        payload: {
          kind: "section",
          role: "context",
          title: "Review context",
          body: "Review context remains narrative prose.",
        },
        payloadHash: "review-context-hash",
        elementVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    };
    current.elements.push(section);
    const sectionRoot = {
      ...detail.comments[0]!,
      id: "section-root",
      threadId: "section-thread",
      elementId: section.element.id,
      handle: null,
    };
    detail.comments = [historical, removed, sectionRoot];

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const heading = screen.getByRole("heading", {
      name: "Historical & orphaned review threads",
    });
    const fallback = heading.closest("section")!;
    for (const threadId of ["historical-thread", "removed-thread"]) {
      expect(
        within(fallback).getAllByTestId(`review-thread-${threadId}`),
      ).toHaveLength(1);
      expect(screen.getAllByTestId(`review-thread-${threadId}`)).toHaveLength(
        1,
      );
    }
    const sectionCard = screen.getByTestId(
      "review-change-section-review-context",
    );
    expect(
      within(sectionCard).getByTestId("review-thread-section-thread"),
    ).toBeVisible();
    expect(screen.getAllByTestId("review-thread-section-thread")).toHaveLength(
      1,
    );
    expect(
      within(fallback).queryByTestId("review-thread-section-thread"),
    ).toBeNull();
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
      within(requirement).queryByRole("button", { name: "Comment" }),
    ).not.toBeInTheDocument();
    expect(
      within(requirement).queryByText("Covered by sign-off"),
    ).not.toBeInTheDocument();
  });

  it("keeps sign-off available when Q&A are the only active attention", () => {
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
    question.presentation.attentionActive = true;
    question.presentation.humanCapability = {
      kind: "answer",
      allowed: true,
    };
    assumption.disposition = "proposed";
    assumption.disposedAt = null;
    assumption.presentation.attentionActive = true;
    assumption.presentation.humanCapability = {
      kind: "dispose",
      allowed: true,
    };

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
    expect(signOff).toBeEnabled();
    expect(signOff).toHaveAttribute(
      "title",
      "Approve the remaining subjects and freeze this revision",
    );
    expect(screen.getByText("2 active attention")).toBeVisible();
    expect(screen.queryByText(/blocks sign-off/i)).not.toBeInTheDocument();
    expect(reviewAttentionCount(detail)).toBe(0);
  });

  it("uses the canonical server lint count as the sign-off authority", () => {
    const detail = reviewDetailFixture(false);
    detail.status.draftHealth = {
      revisionId: "revision-2",
      total: 1,
      blocking: 1,
      counts: [{ severity: "blocks_signoff", count: 1 }],
      top: [
        {
          ruleId: "9.8.rejected-cited-assumption",
          severity: "blocks_signoff",
          elementHandle: "R1",
          message: "A rejected premise remains cited.",
        },
      ],
    };

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
      "Sign-off blocked — 1 server lint finding",
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
        // The reopened draft's approval account travels with the act.
        approvalLedger: emptyApprovalLedger(),
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
    assumptionCitations: base.assumptionCitations,
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

  it("places the selected superseded revision's structured threads with their cards and renders fallback threads once", async () => {
    const detail = strandedAndCurrentProposalFixture();
    const selected = detail.liveProposals.find(
      ({ supersededBy }) => supersededBy !== null,
    );
    const base = detail.baseRevision;
    const requirementRoot = detail.comments[0];
    if (
      selected === undefined ||
      base === null ||
      requirementRoot === undefined
    ) {
      throw new Error("Fixture requires a superseded proposal with comments");
    }
    const decisionRoot = {
      ...requirementRoot,
      id: "selected-decision-root",
      threadId: "selected-decision-thread",
      elementId: "decision-1",
      handle: "D1",
      body: "Keep the selected proposal's decision context visible.",
      revisionId: selected.revision.id,
      revisionNumber: selected.revision.number,
    };
    const criterionRoot = {
      ...requirementRoot,
      id: "selected-criterion-root",
      threadId: "selected-criterion-thread",
      elementId: "criterion-1",
      handle: "R1.1",
      body: "Keep the unchanged criterion beside its requirement.",
      revisionId: selected.revision.id,
      revisionNumber: selected.revision.number,
    };
    const unchangedTaskRoot = {
      ...requirementRoot,
      id: "selected-unchanged-task-root",
      threadId: "selected-unchanged-task-thread",
      elementId: "task-prerequisite",
      handle: "T2",
      body: "Keep this unchanged task visible in the selected proposal.",
      revisionId: selected.revision.id,
      revisionNumber: selected.revision.number,
    };
    const historicalRoot = {
      ...requirementRoot,
      id: "historical-root",
      threadId: "historical-thread",
      body: "This root belongs to the proposal's base revision.",
      revisionId: base.revision.id,
      revisionNumber: base.revision.number,
    };
    const removedRoot = {
      ...requirementRoot,
      id: "removed-root",
      threadId: "removed-thread",
      elementId: "removed-element",
      handle: null,
      body: "This selected-revision root has no remaining element host.",
      revisionId: selected.revision.id,
      revisionNumber: selected.revision.number,
    };
    detail.comments = [
      {
        ...requirementRoot,
        body: "Keep the selected proposal's requirement context visible.",
        revisionId: selected.revision.id,
        revisionNumber: selected.revision.number,
      },
      decisionRoot,
      criterionRoot,
      unchangedTaskRoot,
      historicalRoot,
      removedRoot,
    ];
    const user = userEvent.setup();
    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    await user.click(
      screen.getByRole("radio", { name: /Revision 2 — superseded/i }),
    );

    const superseded = screen.getByTestId("superseded-proposal-review");
    const expectedCardHosts = [
      ["requirement-1", ["thread-1", "selected-criterion-thread"]],
      ["decision-1", ["selected-decision-thread"]],
      ["task-prerequisite", ["selected-unchanged-task-thread"]],
    ] as const;
    for (const [elementId, threadIds] of expectedCardHosts) {
      const card = within(superseded).getByTestId(
        `superseded-change-${elementId}`,
      );
      for (const threadId of threadIds) {
        expect(
          within(card).getByTestId(`review-thread-${threadId}`),
        ).toBeVisible();
        expect(screen.getAllByTestId(`review-thread-${threadId}`)).toHaveLength(
          1,
        );
      }
    }
    expect(
      within(superseded).getByRole("heading", { name: "Commented unchanged" }),
    ).toBeVisible();

    const fallback = within(superseded)
      .getByRole("heading", {
        name: "Historical & orphaned review threads",
      })
      .closest("section");
    if (fallback === null) throw new Error("Expected a fallback thread region");
    for (const threadId of ["historical-thread", "removed-thread"]) {
      expect(
        within(fallback).getByTestId(`review-thread-${threadId}`),
      ).toBeVisible();
      expect(screen.getAllByTestId(`review-thread-${threadId}`)).toHaveLength(
        1,
      );
    }
    expect(
      within(superseded).queryByRole("button", { name: "Comment" }),
    ).not.toBeInTheDocument();
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
    assumptionCitations: forkedPast.assumptionCitations,
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
    assumptionCitations: strandedProposal.snapshot.assumptionCitations,
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
