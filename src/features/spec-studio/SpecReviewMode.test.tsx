// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";
import { renderWithQuery } from "@/test/component-mocks";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
import SpecReviewMode from "./SpecReviewMode";

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
                dependsOnTaskElementIds: [],
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
      position: 3,
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
      screen.getByRole("heading", { name: "Review revision 2" }),
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

  it("groups semantic changes into compact expandable rows and keeps raw diff secondary", async () => {
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
    ).not.toBeVisible();
    await user.click(
      within(requirement).getByRole("button", {
        name: /modified requirement/i,
      }),
    );
    expect(
      within(requirement).getByText("Every execution pins scope."),
    ).toBeVisible();

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
