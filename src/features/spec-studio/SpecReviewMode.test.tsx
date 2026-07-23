// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";
import type { SpecRevisionElement } from "@/lib/specs/schemas";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture } from "@/test/fetch-fixture";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
import SpecReviewMode, { bulkApprovalSubjects } from "./SpecReviewMode";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

afterEach(cleanup);

const NOW = "2026-07-18T12:00:00.000Z";

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

  return {
    ...detail,
    revisions: [baseSnapshot.revision, currentRevision],
    baseRevision: baseSnapshot,
    currentRevision: { revision: currentRevision, elements: currentElements },
    currentApprovedRevision: baseSnapshot,
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
        spec_id: detail.spec.id,
        thread_id: "thread-1",
        parent_comment_id: null,
        element_id: "requirement-1",
        anchor_json: JSON.stringify({
          sectionId: "R1",
          headingLabel: "R1",
          line: 1,
          charStart: 0,
          charEnd: 15,
          quote: "Every execution",
          prefix: "",
          suffix: " pins scope.",
          docRevision: baseSnapshot.revision.contentHash,
        }),
        revision_id: currentRevision.id,
        body: "Confirm the gate screen uses the same scope.",
        author_json: JSON.stringify({ kind: "human" }),
        blocking: blocked ? 1 : 0,
        resolution: blocked ? "open" : "resolved",
        created_at: NOW,
        updated_at: NOW,
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
  it("uses the prototype review chrome instead of detail-page facets and cyan tabs", () => {
    renderReview();

    expect(
      screen.getByRole("heading", { name: "Review plan-stage revision 2" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← native-sdd" })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd",
    );
    expect(screen.queryByTestId("spec-phase-facets")).not.toBeInTheDocument();

    const semanticTab = screen.getByRole("tab", {
      name: /Semantic changes/,
    });
    expect(semanticTab).toHaveClass(
      "data-[state=active]:bg-bg-elevated",
      "data-[state=active]:text-text-primary",
    );
    expect(semanticTab).not.toHaveClass("data-[state=active]:bg-cyan");

    const semanticSurface = screen.getByRole("region", {
      name: "Semantic changes",
    });
    expect(semanticSurface).toHaveClass("mt-[14px]");
    expect(
      within(semanticSurface).getByText("3 changes across 3 kinds"),
    ).toBeInTheDocument();
    expect(
      within(semanticSurface).getByRole("button", {
        name: "Approve all requirements",
      }),
    ).toBeInTheDocument();
    expect(
      within(semanticSurface).getByRole("button", {
        name: "Approve all remaining",
      }),
    ).toBeInTheDocument();
  });

  it("groups semantic changes into expanded-by-default rows and keeps raw diff secondary", async () => {
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
      within(requirement).getByText("Every execution pins scope."),
    ).toBeVisible();
    await user.click(
      within(requirement).getByRole("button", {
        name: /modified requirement/i,
      }),
    );
    expect(
      within(requirement).getByText("Every execution pins scope."),
    ).not.toBeVisible();

    const unchanged = screen.getByRole("button", {
      name: /2 unchanged elements/i,
    });
    expect(unchanged).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("tab", { name: "Raw diff" }));
    expect(
      screen.getByText(/semantic change list is the review contract/i),
    ).toBeVisible();
    expect(screen.getByText(/--- revision-1/)).toBeVisible();
  });

  it("presents the approved execution graph metadata for each changed task", async () => {
    const user = userEvent.setup();
    renderReview();

    const task = screen.getByTestId("review-change-task-1");
    const currentRevision = within(task).getByText("Revision 2").parentElement;
    if (currentRevision === null) throw new Error("Current revision missing");
    await waitFor(() => {
      expect(currentRevision).toHaveTextContent("Dependencies: T2");
      expect(currentRevision).toHaveTextContent("Lane group: persistence");
      expect(currentRevision).toHaveTextContent(
        "Touched surfaces: src/lib/specs, src/lib/state-store",
      );
      expect(currentRevision).toHaveTextContent("Criterion coverage: R1.1");
    });

    await user.click(screen.getByRole("tab", { name: "Raw diff" }));
    expect(screen.getByText(/Dependencies:\*\* T2/)).toBeVisible();
    expect(
      screen.getByText(/Touched surfaces:\*\* src\/lib\/specs/),
    ).toBeVisible();
  });

  it("orders acceptance criteria directly under their parent requirement", () => {
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

    const ids = screen
      .getAllByTestId(/^review-change-/)
      .map((card) => card.getAttribute("data-testid"));
    const requirementOne = ids.indexOf("review-change-requirement-1");
    expect(requirementOne).toBeGreaterThanOrEqual(0);
    expect(ids[requirementOne + 1]).toBe("review-change-criterion-2");
    expect(ids[requirementOne + 2]).toBe("review-change-requirement-2");
  });

  it("offers unapprove on a validly approved subject and records the removal", async () => {
    const api = installFetchFixture();
    try {
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

      expect(
        await screen.findByText("R1 approval removed"),
      ).toBeInTheDocument();
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
    } finally {
      api.restore();
    }
  });

  it("keeps the approve action for subjects without a valid approval", () => {
    renderReview();

    const requirement = screen.getByTestId("review-change-requirement-1");
    expect(
      within(requirement).getByRole("button", { name: "Approve item" }),
    ).toBeInTheDocument();
    expect(
      within(requirement).queryByRole("button", { name: "Unapprove item" }),
    ).not.toBeInTheDocument();
  });

  it("renders element content as formatted markdown", async () => {
    const detail = reviewDetailFixture();
    const current = detail.currentRevision;
    if (current === null) throw new Error("Fixture requires a revision");
    const requirementEntry = current.elements.find(
      (entry) => entry.element.id === "requirement-1",
    );
    if (requirementEntry?.version.payload.kind !== "requirement") {
      throw new Error("Fixture requires requirement-1");
    }
    requirementEntry.version.payload.statement =
      "Every execution **pins** the exact selected scope.";

    renderWithQuery(
      <SpecReviewMode
        detail={detail}
        projectName="command-center"
        highlightedChangeId={null}
      />,
    );

    const requirement = screen.getByTestId("review-change-requirement-1");
    expect(
      await within(requirement).findByText("pins", { selector: "strong" }),
    ).toBeVisible();
  });

  it("pins sign-off readiness with approvals, blocking threads, and assumptions", () => {
    renderReview();

    const readiness = screen.getByTestId("review-readiness");
    expect(within(readiness).getByText("0/3 approved")).toBeInTheDocument();
    expect(
      within(readiness).getByText("Approvals incomplete"),
    ).toBeInTheDocument();
    expect(
      within(readiness).getByText("1 blocking thread"),
    ).toBeInTheDocument();
    expect(
      within(readiness).getByText("1 rejected assumption"),
    ).toBeInTheDocument();
    expect(within(readiness).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    expect(
      within(readiness).getByRole("button", {
        name: "Sign off revision 2",
      }),
    ).toBeDisabled();
  });

  it("scopes review approvals to the proposed authoring stage", () => {
    const detail = reviewDetailFixture();
    const current = detail.currentRevision;
    if (current === null) throw new Error("Fixture requires a revision");
    current.revision.authoringStage = "requirements";
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

  it("enables sign-off immediately under the fast-path combined policy", async () => {
    const user = userEvent.setup();
    const detail = reviewDetailFixture(false);
    renderWithQuery(
      <SpecReviewMode
        detail={{
          ...detail,
          spec: { ...detail.spec, gatePolicy: { preset: "fast-path" } },
          approvals: [],
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

    await user.click(trigger);
    expect(
      screen.getByText("Combined approval — this sign-off approves every item"),
    ).toBeInTheDocument();
  });

  it("reflows review rows and preserves touch targets on the mobile spine", () => {
    renderReview();

    const requirement = screen.getByTestId("review-change-requirement-1");
    expect(
      within(requirement).getByRole("button", {
        name: /modified requirement/i,
      }),
    ).toHaveClass("max-768:min-h-[44px]");
    expect(
      within(requirement).getByRole("button", { name: "Comment" }),
    ).toHaveClass("max-768:min-h-[44px]");
    expect(screen.getByTestId("review-readiness")).toHaveClass(
      "max-768:flex-col",
    );
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
});
