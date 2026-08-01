// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";
import type { SectionRole, SpecRevisionElement } from "@/lib/specs/schemas";
import { renderWithQuery } from "@/test/component-mocks";

import {
  SPEC_CONTROLS_FIXTURE_NOW,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import { SpecDetailContent } from "./SpecDetailPage";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

vi.mock(
  "next/navigation",
  async () => (await import("@/test/component-mocks")).nextNavigationMock,
);

function sectionElement(
  detail: SpecDetailView,
  role: SectionRole,
  title: string,
  body: string,
  position: number,
): SpecRevisionElement {
  const snapshot = detail.currentRevision;
  if (snapshot === null) throw new Error("Fixture requires a current revision");
  const elementId = `section-${role}`;
  return {
    element: {
      id: elementId,
      specId: detail.spec.id,
      kind: "section",
      number: null,
      parentElementId: null,
      createdAt: SPEC_CONTROLS_FIXTURE_NOW,
    },
    version: {
      revisionId: snapshot.revision.id,
      elementId,
      position,
      payload: { kind: "section", role, title, body },
      payloadHash: `${elementId}-hash`,
      elementVersion: 1,
      createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
    },
  };
}

function prototypeDetailFixture(): SpecDetailView {
  const detail = specControlsDetailFixture();
  const snapshot = detail.currentRevision;
  if (snapshot === null) throw new Error("Fixture requires a current revision");
  const sections = [
    sectionElement(
      detail,
      "intent_problem",
      "Intent",
      "Specs are durable product objects with stable identities.",
      0,
    ),
    sectionElement(
      detail,
      "design_narrative",
      "Design narrative",
      "Humans review and approve; agents author each revision.",
      1,
    ),
  ];
  const elements = [...sections, ...snapshot.elements];
  return {
    ...detail,
    currentRevision: { ...snapshot, elements },
    currentApprovedRevision:
      detail.currentApprovedRevision === null
        ? null
        : { ...detail.currentApprovedRevision, elements },
    assumptions: [
      {
        id: "assumption-2",
        number: 2,
        handle: "A2",
        elementId: null,
        text: "Approval controls can reuse the review surface.",
        disposition: "rejected",
        disposedAt: SPEC_CONTROLS_FIXTURE_NOW,
        proposedBy: {
          kind: "agent",
          conversationId: "conversation-1",
          backend: "claude",
        },
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    ],
  };
}

function renderPrototypeDetail(): void {
  renderWithQuery(
    <SpecDetailContent
      detail={prototypeDetailFixture()}
      projectName="command-center"
      requestedSlug="native-sdd"
      view="overview"
      onViewChange={() => undefined}
    />,
  );
}

function appearsBefore(first: Element, second: Element): boolean {
  return Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

describe("Spec detail prototype structure", () => {
  it("orders the underline views before the revision banner", () => {
    renderPrototypeDetail();

    const views = screen.getByRole("navigation", { name: "Spec views" });
    const banner = screen.getByRole("region", { name: "Spec status" });

    expect(appearsBefore(views, banner)).toBe(true);
  });

  it("flows prose sections through one narrative surface without an invented document wrapper", () => {
    renderPrototypeDetail();

    const narrative = screen.getByRole("region", { name: "Spec narrative" });
    expect(within(narrative).getByText("Intent")).toBeVisible();
    expect(within(narrative).getByText("Design narrative")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Spec document" })).toBeNull();
    expect(screen.getByTestId("spec-prose-body-intent_problem")).toHaveClass(
      "[&_[data-markdown-intent=document]]:px-0",
      "[&_[data-markdown-intent=document]]:py-0",
      "[&_[data-markdown-intent=document]]:text-[0.875rem]",
      "[&_[data-markdown-viewport]>div]:pl-0",
    );
  });

  it("presents each structured-contract group as its own rail region", () => {
    renderPrototypeDetail();

    const rail = screen.getByRole("complementary", {
      name: "Spec structure",
    });
    for (const group of [
      "Requirements",
      "Decisions",
      "Questions & assumptions",
      "Tasks",
    ]) {
      expect(within(rail).getByRole("region", { name: group })).toBeVisible();
    }
    expect(within(rail).queryByText("Structured contract")).toBeNull();
  });

  it("expands rail summaries into complete content and links to full readers", async () => {
    const user = userEvent.setup();
    renderPrototypeDetail();

    const requirements = screen.getByRole("region", { name: "Requirements" });
    expect(
      within(requirements).getByRole("link", { name: "Open Requirements" }),
    ).toHaveAttribute("href", expect.stringContaining("?view=requirements"));
    expect(
      within(requirements).queryByText(
        "The selected task and criterion are pinned.",
      ),
    ).toBeNull();

    await user.click(
      within(requirements).getByRole("button", { name: "Expand R1" }),
    );

    expect(
      within(requirements).getByText(
        "The selected task and criterion are pinned.",
      ),
    ).toBeVisible();
    expect(
      within(requirements).getByRole("button", { name: "Collapse R1" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("offers one expand-all control for the internally scrollable rail", async () => {
    const user = userEvent.setup();
    renderPrototypeDetail();

    const rail = screen.getByRole("complementary", { name: "Spec structure" });
    await user.click(
      within(rail).getByRole("button", { name: "Expand all structure items" }),
    );

    expect(
      within(rail).getByRole("button", {
        name: "Collapse all structure items",
      }),
    ).toBeVisible();
    expect(
      within(rail).getByText("The selected task and criterion are pinned."),
    ).toBeVisible();
  });

  it("does not reserve comment gutters or render empty comment placeholders", () => {
    renderPrototypeDetail();

    expect(screen.queryAllByText("No comments on this section")).toHaveLength(
      0,
    );
    expect(screen.queryAllByRole("group", { name: /comments$/i })).toHaveLength(
      0,
    );
  });

  it("keeps obsolete utility actions out of the prototype header", () => {
    renderPrototypeDetail();

    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("keeps every linked-context lane visible and exposes inline assumption dispositions", () => {
    renderPrototypeDetail();

    const narrative = screen.getByRole("region", { name: "Spec narrative" });
    expect(within(narrative).getByText("Tickets")).toBeVisible();
    expect(within(narrative).getByText("Conversations")).toBeVisible();

    const questions = screen.getByRole("region", {
      name: "Questions & assumptions",
    });
    expect(
      within(questions).getByRole("button", { name: "Confirm A2" }),
    ).toBeVisible();
    expect(
      within(questions).getByRole("button", { name: "Reject A2" }),
    ).toBeVisible();
    expect(
      within(questions).getByRole("button", { name: "Defer A2" }),
    ).toBeVisible();
  });
});
