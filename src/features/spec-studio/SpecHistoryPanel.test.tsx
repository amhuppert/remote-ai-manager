// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";

import {
  SPEC_CONTROLS_FIXTURE_NOW,
  policyAdmissionViewFixture,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import SpecHistoryPanel, { buildSpecHistory } from "./SpecHistoryPanel";

describe("buildSpecHistory", () => {
  it("distinguishes human approvals from policy admissions and orders newest activity first", () => {
    const detail = specControlsDetailFixture("running");
    const historyDetail: SpecDetailView = {
      ...detail,
      approvals: [
        {
          id: "approval-1",
          spec_id: detail.spec.id,
          subject_kind: "requirement",
          element_id: "requirement-1",
          revision_id: "revision-1",
          approver: "alex",
          granted_at: "2026-07-18T12:03:00.000Z",
          validity: "valid",
        },
      ],
      gateAdmissions: [
        policyAdmissionViewFixture({
          createdAt: "2026-07-18T12:04:00.000Z",
        }),
      ],
      waivers: [
        {
          id: "waiver-1",
          spec_id: detail.spec.id,
          criterion_element_id: "criterion-1",
          revision_id: "revision-1",
          reason: "Covered by an external conformance run.",
          waived_at: "2026-07-18T12:05:00.000Z",
          stale: 0,
        },
      ],
    };

    const events = buildSpecHistory(historyDetail);

    expect(events.map((event) => event.label)).toEqual([
      "R1.1 waived",
      "Requirements admitted by notify policy",
      "R1 approved",
      "Execution started",
      "Revision 1 signed off",
      "Revision 1 created",
      "Spec created",
    ]);
    expect(events.find((event) => event.kind === "approval")).toMatchObject({
      emphasis: "human",
      tone: "green",
    });
    expect(events.find((event) => event.kind === "admission")).toMatchObject({
      emphasis: "policy",
      tone: "amber",
    });
  });

  it("does not duplicate a creation timestamp when a revision is proposed at creation", () => {
    const detail = specControlsDetailFixture();
    const snapshot = detail.currentRevision;
    if (snapshot === null) throw new Error("Fixture revision missing");
    const proposedAtCreation = {
      ...snapshot.revision,
      state: "proposed" as const,
      approvedAt: null,
      proposedAt: SPEC_CONTROLS_FIXTURE_NOW,
    };

    const events = buildSpecHistory({
      ...detail,
      revisions: [proposedAtCreation],
      currentRevision: { ...snapshot, revision: proposedAtCreation },
      currentApprovedRevision: null,
    });

    expect(events.map((event) => event.label)).toEqual([
      "Revision 1 proposed",
      "Spec created",
    ]);
  });

  it("records the available spec, question, and assumption lifecycle moments", () => {
    const detail = specControlsDetailFixture();
    const events = buildSpecHistory({
      ...detail,
      spec: {
        ...detail.spec,
        abandonedAt: "2026-07-18T12:08:00.000Z",
        abandonedReason: "Superseded by the platform contract.",
      },
      questions: [
        {
          id: "question-1",
          number: 1,
          handle: "Q1",
          elementId: null,
          text: "Which retention window applies?",
          status: "answered",
          answer: "Thirty days.",
          answeredAt: "2026-07-18T12:06:00.000Z",
          provenance: null,
          createdAt: "2026-07-18T12:01:00.000Z",
          updatedAt: "2026-07-18T12:06:00.000Z",
        },
      ],
      assumptions: [
        {
          id: "assumption-1",
          number: 1,
          handle: "A1",
          elementId: null,
          text: "Retention defaults to 30 days.",
          disposition: "confirmed",
          disposedAt: "2026-07-18T12:07:00.000Z",
          proposedBy: { kind: "agent", conversationId: "conversation-1" },
          createdAt: "2026-07-18T12:02:00.000Z",
          updatedAt: "2026-07-18T12:07:00.000Z",
        },
      ],
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Spec abandoned",
          tone: "red",
        }),
        expect.objectContaining({
          label: "Q1 answered",
          emphasis: "human",
        }),
        expect.objectContaining({
          label: "A1 confirmed",
          emphasis: "human",
        }),
      ]),
    );
  });

  it("offers the prototype history-kind filters and isolates policy admissions", async () => {
    const user = userEvent.setup();
    const detail = specControlsDetailFixture("running");
    render(
      <SpecHistoryPanel
        detail={{
          ...detail,
          gateAdmissions: [policyAdmissionViewFixture()],
        }}
        projectName="command-center"
      />,
    );

    const filters = screen.getByRole("radiogroup", {
      name: "Filter spec history",
    });
    expect(
      within(filters)
        .getAllByRole("radio")
        .map((control) => control.textContent),
    ).toEqual([
      "All",
      "Human approvals",
      "Policy admissions",
      "Gate changes",
      "Executions",
    ]);
    expect(
      within(filters).getByRole("radio", { name: "Gate changes" }),
    ).toBeEnabled();

    expect(screen.getByText("human act")).toBeVisible();
    expect(screen.getByText("policy admission")).toBeVisible();

    await user.click(
      within(filters).getByRole("radio", { name: "Policy admissions" }),
    );
    expect(screen.getByText(/admitted by notify policy/i)).toBeVisible();
    expect(screen.queryByText(/Execution started/i)).not.toBeInTheDocument();
  });

  it("uses one flat chronological feed instead of a card for every event", () => {
    render(
      <SpecHistoryPanel
        detail={specControlsDetailFixture("running")}
        projectName="command-center"
      />,
    );

    const feed = screen.getByRole("list", { name: "Spec history" });
    expect(feed).toHaveClass(
      "overflow-hidden",
      "rounded-lg",
      "border",
      "border-border-subtle",
      "bg-bg-base",
    );
    expect(feed).not.toHaveClass("grid", "gap-sm");

    const executionRow = screen
      .getByRole("heading", { name: "Execution started" })
      .closest("article");
    expect(executionRow).not.toBeNull();
    expect(executionRow).not.toHaveClass("rounded-lg", "border", "p-md");
    expect(executionRow).toHaveClass("border-b", "py-sm");
  });

  it("keeps immutable sign-off detail readable on its green status tint", () => {
    render(
      <SpecHistoryPanel
        detail={specControlsDetailFixture("running")}
        projectName="command-center"
      />,
    );

    expect(
      screen.getByText(
        "The approved revision is immutable and can anchor execution scope.",
      ),
    ).toHaveClass("text-text-primary");
  });

  it("provides the prototype's post-hoc review loop on policy admissions", async () => {
    const user = userEvent.setup();
    const detail = specControlsDetailFixture("running");
    render(
      <SpecHistoryPanel
        detail={{
          ...detail,
          gateAdmissions: [policyAdmissionViewFixture()],
        }}
        projectName="command-center"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Review admission…" }));

    expect(
      screen.getByText(
        /post-hoc review — nothing here rewinds the transition/i,
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Object — request amendment" }),
    ).toBeVisible();
  });
});
