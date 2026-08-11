// @vitest-environment jsdom
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  importedDeliveredSpecDetailFixture,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import SpecDetailViews, { type DetailView } from "./SpecDetailViews";

/**
 * Stands in for the address bar that owns the active surface in production, so
 * these tests exercise route and back-control selection without a router.
 */
function AddressBarHarness({
  initialView,
  detail = specControlsDetailFixture(),
}: {
  initialView: DetailView;
  detail?: ReturnType<typeof specControlsDetailFixture>;
}): React.JSX.Element {
  const [view, setView] = useState(initialView);
  return (
    <SpecDetailViews
      detail={detail}
      projectName="command-center"
      view={view}
      onViewChange={setView}
    >
      <div>Overview document</div>
    </SpecDetailViews>
  );
}

function renderDetailViews(
  initialView: DetailView = "overview",
  detail = specControlsDetailFixture(),
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AddressBarHarness initialView={initialView} detail={detail} />
    </QueryClientProvider>,
  );
}

function appearsBefore(first: Element, second: Element): boolean {
  return Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

function attentionDetailFixture(): ReturnType<
  typeof specControlsDetailFixture
> {
  const detail = specControlsDetailFixture();
  const approvedSnapshot = detail.currentRevision;
  if (approvedSnapshot === null) {
    throw new Error("Expected the fixture to include an approved revision");
  }
  const proposedRevision = {
    ...approvedSnapshot.revision,
    id: "revision-2",
    number: 2,
    state: "proposed" as const,
    basedOnRevisionId: approvedSnapshot.revision.id,
    contentHash: "revision-2-hash",
    approvedAt: null,
  };
  detail.baseRevision = approvedSnapshot;
  detail.currentRevision = {
    revision: proposedRevision,
    elements: approvedSnapshot.elements.map((entry) => ({
      ...entry,
      version: { ...entry.version, revisionId: proposedRevision.id },
    })),
  };
  detail.revisions = [...detail.revisions, proposedRevision];
  detail.status.phase = { primary: "in_review", authoringStage: "plan" };
  // The plan stage is the revision's own, so its gate is consulted and its
  // subject is what the server still owes.
  detail.status.applicableGates = ["plan"];
  detail.status.pendingApprovals = [
    { gate: "plan", subject: "plan", elementId: null },
  ];
  detail.questions = [
    {
      id: "question-1",
      number: 1,
      handle: "Q1",
      elementId: null,
      text: "Which retention window applies?",
      status: "open",
      answer: null,
      answeredAt: null,
      provenance: { kind: "agent", conversationId: "conversation-1" },
      createdAt: approvedSnapshot.revision.createdAt,
      updatedAt: approvedSnapshot.revision.createdAt,
    },
  ];
  detail.assumptions = [
    {
      id: "assumption-1",
      number: 1,
      handle: "A1",
      elementId: "requirement-1",
      text: "Retention defaults to 30 days.",
      disposition: "proposed",
      disposedAt: null,
      proposedBy: { kind: "agent", conversationId: "conversation-1" },
      createdAt: approvedSnapshot.revision.createdAt,
      updatedAt: approvedSnapshot.revision.createdAt,
    },
  ];
  return detail;
}

describe("SpecDetailViews", () => {
  it("models the primary strip as route navigation on inspection surfaces", () => {
    renderDetailViews("evidence");

    const navigation = screen.getByRole("navigation", { name: "Spec views" });
    expect(navigation).toHaveAttribute("data-appearance", "underline");
    expect(
      within(navigation).getByRole("button", { name: "Overview" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(
        screen.getByRole("navigation", { name: "Spec inspection" }),
      ).getByRole("button", { name: "Evidence" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.queryByRole("tablist", { name: "Spec views" }),
    ).not.toBeInTheDocument();
  });

  it("surfaces the approved Review and Q&A attention counts", () => {
    renderDetailViews("overview", attentionDetailFixture());

    const navigation = screen.getByRole("navigation", { name: "Spec views" });
    expect(
      within(
        within(navigation).getByRole("button", { name: "Review" }),
      ).getByText("3"),
    ).toBeVisible();
    const reviewButton = within(navigation).getByRole("button", {
      name: "Review",
    });
    const questionsButton = within(navigation).getByRole("button", {
      name: "Questions & assumptions",
    });
    expect(reviewButton).toHaveAccessibleDescription("3 items need attention");
    expect(questionsButton).toHaveAccessibleDescription(
      "2 items need attention",
    );
    expect(within(questionsButton).getByText("2")).toBeVisible();
  });

  it("asks for nothing on a fully-disposed delivered import", () => {
    renderDetailViews("overview", importedDeliveredSpecDetailFixture());

    const navigation = screen.getByRole("navigation", { name: "Spec views" });
    expect(
      within(navigation).getByRole("button", { name: "Review" }),
    ).not.toHaveAccessibleDescription();
    expect(
      within(navigation).getByRole("button", {
        name: "Questions & assumptions",
      }),
    ).not.toHaveAccessibleDescription();
  });

  /**
   * Import provenance is not an exemption from the badge: a bundle may arrive
   * with a question it never answered, and that answer is owed here.
   */
  it("still asks for a question the import left open", () => {
    const detail = importedDeliveredSpecDetailFixture();
    const question = detail.questions[0];
    if (question === undefined) throw new Error("Import fixture needs a Q");
    detail.questions = [
      { ...question, status: "open", answer: null, answeredAt: null },
    ];

    renderDetailViews("overview", detail);

    expect(
      within(screen.getByRole("navigation", { name: "Spec views" })).getByRole(
        "button",
        { name: "Questions & assumptions" },
      ),
    ).toHaveAccessibleDescription("1 item needs attention");
  });

  it("suppresses actionable attention counts on abandoned specs", () => {
    const detail = attentionDetailFixture();
    detail.spec = {
      ...detail.spec,
      abandonedAt: detail.spec.updatedAt,
      abandonedReason: "The product direction was withdrawn.",
    };
    detail.status.phase = { primary: "abandoned", authoringStage: "plan" };

    renderDetailViews("overview", detail);

    const navigation = screen.getByRole("navigation", { name: "Spec views" });
    expect(
      within(navigation).getByRole("button", { name: "Review" }),
    ).not.toHaveAccessibleDescription();
    expect(
      within(navigation).getByRole("button", {
        name: "Questions & assumptions",
      }),
    ).not.toHaveAccessibleDescription();
  });

  it("keeps the approved six-stage navigation available on every surface", async () => {
    const user = userEvent.setup();
    renderDetailViews();

    const navigation = screen.getByRole("navigation", { name: "Spec views" });
    expect(
      within(navigation)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Overview",
      "Review",
      "Questions & assumptions",
      "Delivery plan",
      "Execution",
      "Gate policy",
      "History",
    ]);
    expect(navigation).toContainElement(
      screen.getByRole("button", { name: "Overview" }),
    );
    expect(screen.getByText("Overview document")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Spec inspection" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("heading", { name: "History" })).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "Spec views" }),
    ).toBeVisible();
  });

  it("navigates to distinct Execution and Gate policy surfaces", async () => {
    const user = userEvent.setup();
    renderDetailViews();

    await user.click(screen.getByRole("button", { name: "Execution" }));
    expect(
      screen.getByRole("region", { name: "Execution and merge" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Gate policy" })).toBeNull();
    expect(
      screen.getByRole("navigation", { name: "Spec views" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Gate policy" }));
    expect(screen.getByRole("heading", { name: "Gate policy" })).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Execution and merge" }),
    ).toBeNull();
    expect(
      screen.getByRole("navigation", { name: "Spec views" }),
    ).toBeVisible();
  });

  it("gives the primary view navigation an accessible name", () => {
    renderDetailViews();

    expect(
      screen.getByRole("navigation", { name: "Spec views" }),
    ).toBeVisible();
  });

  it("identifies the primary view navigation as the prototype's underline strip", () => {
    renderDetailViews();

    expect(
      screen.getByRole("navigation", { name: "Spec views" }),
    ).toHaveAttribute("data-appearance", "underline");
  });

  it.each([
    [
      "evidence",
      "Evidence by acceptance criterion",
      "Proof is evaluated against each criterion's approved validation strategy.",
    ],
    ["traceability", "Traceability", "Requirement → criteria → tasks"],
    [
      "history",
      "History",
      "Human decisions are recorded separately from policy admissions and execution lifecycle events.",
    ],
  ] as const)(
    "keeps the shared navigation ahead of the %s surface",
    (initialView, title, subtitle) => {
      renderDetailViews(initialView);

      const heading = screen.getByRole("heading", { name: title });
      const description = screen.getByText(subtitle);
      const navigation = screen.getByRole("navigation", {
        name: "Spec views",
      });

      expect(screen.getAllByRole("heading", { name: title })).toHaveLength(1);
      expect(appearsBefore(navigation, heading)).toBe(true);
      expect(appearsBefore(heading, description)).toBe(true);
    },
  );

  it("uses the evidence panel title as the single subscreen title", () => {
    renderDetailViews("evidence");

    expect(
      screen.queryByRole("heading", { name: "Evidence" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", {
        name: "Evidence by acceptance criterion",
      }),
    ).toHaveLength(1);
  });

  it("returns from a subscreen through the persistent Overview view", async () => {
    const user = userEvent.setup();
    renderDetailViews("history");

    await user.click(screen.getByRole("button", { name: "Overview" }));

    expect(screen.getByText("Overview document")).toBeVisible();
  });

  it("deep-links an inspected trace node to its element", async () => {
    const user = userEvent.setup();
    renderDetailViews("traceability");

    await user.click(
      screen.getByRole("button", { name: "Select requirement R1" }),
    );

    expect(screen.getByRole("link", { name: "Open R1" })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=R1",
    );
  });

  it("gives spec integrity a focused surface separate from gate policy", () => {
    renderDetailViews("integrity");

    expect(
      screen.getByRole("heading", { name: "Spec integrity" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Gate policy" })).toBeNull();
  });
});
