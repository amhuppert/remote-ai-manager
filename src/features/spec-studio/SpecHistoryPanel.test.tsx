// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";

import {
  SPEC_CONTROLS_FIXTURE_NOW,
  importedDeliveredSpecDetailFixture,
  policyAdmissionViewFixture,
  specControlsDetailFixture,
  strandedProposalDetailFixture,
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

  it("attributes an import-basis admission to import provenance rather than a human approval", () => {
    const detail = specControlsDetailFixture("running");
    const events = buildSpecHistory({
      ...detail,
      gateAdmissions: [policyAdmissionViewFixture({ basis: "import" })],
    });

    const admission = events.find((event) => event.kind === "admission");
    expect(admission).toMatchObject({ emphasis: "policy", tone: "amber" });
    expect(admission?.label).toContain("import");
    expect(admission?.label).not.toContain("approval");
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

  it("builds attention history only from typed durable mutation events", () => {
    const detail = specControlsDetailFixture();
    const events = buildSpecHistory({
      ...detail,
      questions: [],
      assumptions: [],
      attentionAuditEvents: [
        {
          kind: "record",
          eventId: 41,
          occurredAt: "2026-07-18T12:09:00.000Z",
          actor: {
            kind: "agent",
            conversationId: "conversation-later",
            backend: "codex",
          },
          payload: {
            schemaVersion: 1,
            recordKind: "question",
            recordId: "question-1",
            recordNumber: 1,
            attentionId: "question-1",
            operation: "answered",
            active: false,
            before: {
              kind: "question",
              recordId: "question-1",
              number: 1,
              recordVersion: 1,
              text: "Which retention window applies?",
              elementId: null,
              provenance: {
                kind: "agent",
                conversationId: "conversation-origin",
              },
              status: "open",
              answer: null,
              answeredAt: null,
              withdrawnAt: null,
              createdAt: "2026-07-18T12:01:00.000Z",
              updatedAt: "2026-07-18T12:01:00.000Z",
            },
            after: {
              kind: "question",
              recordId: "question-1",
              number: 1,
              recordVersion: 2,
              text: "Which retention window applies?",
              elementId: null,
              provenance: {
                kind: "agent",
                conversationId: "conversation-origin",
              },
              status: "answered",
              answer: "Thirty days.",
              answeredAt: "2026-07-18T12:09:00.000Z",
              withdrawnAt: null,
              createdAt: "2026-07-18T12:01:00.000Z",
              updatedAt: "2026-07-18T12:09:00.000Z",
            },
          },
        },
      ],
    });

    expect(events.filter((event) => event.kind === "attention")).toEqual([
      expect.objectContaining({
        id: "attention:41",
        label: "Q1 answered",
        occurredAt: "2026-07-18T12:09:00.000Z",
        href: "/specs/command-center/native-sdd?view=requirements&el=Q1",
        audit: expect.objectContaining({
          operation: "answered",
          changes: expect.arrayContaining([
            { field: "Status", before: "open", after: "answered" },
            { field: "Answer", before: "—", after: "Thirty days." },
          ]),
        }),
      }),
    ]);
    expect(events.some((event) => event.id === "question-1:created")).toBe(
      false,
    );
  });

  it("offers APG radio history-kind filters and isolates policy admissions", async () => {
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
      "Attention records",
      "Gate changes",
      "Executions",
    ]);
    expect(
      within(filters).getByRole("radio", { name: "Gate changes" }),
    ).toBeEnabled();

    const all = within(filters).getByRole("radio", { name: "All" });
    await user.click(all);
    await user.keyboard("{ArrowRight}");
    expect(
      within(filters).getByRole("radio", { name: "Human approvals" }),
    ).toHaveFocus();

    expect(screen.getByText("human act")).toBeVisible();
    expect(screen.getByText("policy admission")).toBeVisible();

    await user.click(
      within(filters).getByRole("radio", { name: "Policy admissions" }),
    );
    expect(screen.getByText(/admitted by notify policy/i)).toBeVisible();
    expect(screen.queryByText(/Execution started/i)).not.toBeInTheDocument();
  });

  /**
   * An imported spec crossed its authoring gates on an external document's
   * word. History is where that has to be legible: the admissions say import,
   * and the import itself is a row of its own naming the source and what it
   * brought in (R9.5, R9.6).
   */
  function importedDetailFixture(): SpecDetailView {
    const detail = specControlsDetailFixture();
    return {
      ...detail,
      approvals: [],
      gateAdmissions: [
        policyAdmissionViewFixture({
          id: "admission-import-requirements",
          basis: "import",
          gate: "requirements",
        }),
        policyAdmissionViewFixture({
          id: "admission-import-design",
          basis: "import",
          gate: "design",
        }),
      ],
      importRecord: {
        occurredAt: SPEC_CONTROLS_FIXTURE_NOW,
        sourceLabel: "kiro:.kiro/specs/shipped-feature",
        counts: {
          sections: 2,
          requirements: 3,
          criteria: 5,
          decisions: 1,
          questions: 2,
          assumptions: 0,
        },
      },
    };
  }

  it("renders both import-basis admissions as admitted by import, naming no approver", async () => {
    const user = userEvent.setup();
    render(
      <SpecHistoryPanel
        detail={importedDetailFixture()}
        projectName="command-center"
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Policy admissions" }));

    expect(
      screen.getByText("Requirements admitted by import provenance"),
    ).toBeVisible();
    expect(
      screen.getByText("Design admitted by import provenance"),
    ).toBeVisible();
    expect(screen.queryByText("Human approval")).not.toBeInTheDocument();
    expect(screen.queryByText(/approved/i)).not.toBeInTheDocument();
  });

  it("renders the spec-imported event once with its source label and imported-content counts", () => {
    render(
      <SpecHistoryPanel
        detail={importedDetailFixture()}
        projectName="command-center"
      />,
    );

    // One row per import: the record is a single durable event, and a feed that
    // repeated it would read as two imports.
    expect(screen.getAllByText("Spec imported")).toHaveLength(1);
    const row = screen.getByText("Spec imported").closest("article");
    if (row === null) throw new Error("The imported row has no history entry");
    expect(
      within(row).getByText(/kiro:\.kiro\/specs\/shipped-feature/),
    ).toBeVisible();
    expect(within(row).getByText(/3 requirements/)).toBeVisible();
    expect(within(row).getByText(/5 criteria/)).toBeVisible();
    // Nothing arrived under that heading, so the summary does not invent one.
    expect(within(row).queryByText(/assumption/)).not.toBeInTheDocument();
  });

  /**
   * The imported revision is born approved without a human ever signing it
   * off. History's legend reads a filled marker as "human act", so presenting
   * that revision as a sign-off is the honest-provenance failure this row is
   * closest to committing (R9.1).
   */
  it("records the imported revision as import provenance rather than a human sign-off", () => {
    render(
      <SpecHistoryPanel
        detail={importedDetailFixture()}
        projectName="command-center"
      />,
    );

    expect(screen.queryByText(/signed off/i)).not.toBeInTheDocument();
    const row = screen
      .getByText("Revision 1 admitted by import")
      .closest("article");
    if (row === null) throw new Error("The imported revision has no row");
    expect(row).toHaveAttribute("data-emphasis", "policy");
    expect(within(row).getByText(/no human signed/i)).toBeVisible();
  });

  /**
   * The sweep R9.1 asks for, stated as one assertion: for a spec that entered
   * by import, the filter that selects human acts has nothing to show. Every
   * settled thing about it — the revision, the answers, the dispositions —
   * arrived on the source document's word.
   */
  it("leaves an imported spec with no human act to filter to", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SpecHistoryPanel
        detail={importedDeliveredSpecDetailFixture()}
        projectName="command-center"
      />,
    );

    const answered = screen
      .getByText("Q1 answered at import")
      .closest("article");
    const disposed = screen
      .getByText("A1 confirmed at import")
      .closest("article");
    if (answered === null || disposed === null) {
      throw new Error("Imported Q/A rows are missing from history");
    }
    expect(answered).toHaveAttribute("data-emphasis", "policy");
    expect(disposed).toHaveAttribute("data-emphasis", "policy");
    expect(
      screen.queryByText(/A human disposition was recorded/),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Human approvals" }));

    expect(
      screen.getByText("No recorded activity matches this filter."),
    ).toBeVisible();
    expect(
      container.querySelectorAll('article[data-emphasis="human"]'),
    ).toHaveLength(0);
  });

  /**
   * `importRecordView` returns null when the `spec_imported` payload is
   * unreadable, but the admissions that crossed the gates are still there and
   * still say import. Deriving attribution from the event would fail open in
   * exactly that state: the revision would read as a human sign-off and the
   * dispositions as human acts, which is the honest-provenance failure.
   */
  it("attributes to the import when the import event's detail is unreadable", () => {
    const detail = importedDeliveredSpecDetailFixture();
    detail.importRecord = null;

    render(<SpecHistoryPanel detail={detail} projectName="command-center" />);

    expect(screen.queryByText(/signed off/i)).not.toBeInTheDocument();
    expect(screen.getByText("Revision 1 admitted by import")).toBeVisible();
    expect(screen.getByText("Q1 answered at import")).toBeVisible();
    expect(screen.getByText("A1 confirmed at import")).toBeVisible();
    // The detail is what was lost, so the row that reports it stays away.
    expect(screen.queryByText("Spec imported")).not.toBeInTheDocument();
  });

  it("renders durable attention actor, operation, before/after fields, and subject link", async () => {
    const user = userEvent.setup();
    render(
      <SpecHistoryPanel
        detail={importedDeliveredSpecDetailFixture()}
        projectName="command-center"
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Attention records" }));

    const row = screen.getByText("Q1 answered at import").closest("article");
    if (row === null) throw new Error("Question audit row is missing");
    expect(within(row).getByText("Imported by")).toBeVisible();
    expect(within(row).getByText("Agent")).toBeVisible();
    expect(
      within(row).getByRole("link", { name: /conversation-1/ }),
    ).toHaveAttribute("href", "/conversations?c=conversation-1");
    expect(
      within(row).getByRole("link", { name: "Open subject →" }),
    ).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?view=requirements&el=Q1",
    );
    const changes = within(row).getByLabelText(
      "Q1 answered at import field changes",
    );
    expect(within(changes).getByText("Status")).toBeVisible();
    expect(within(changes).getByText("answered")).toBeVisible();
    expect(within(changes).getByText("Answer")).toBeVisible();
    expect(
      within(changes).getByText("Thirty days, per the source spec."),
    ).toBeVisible();
  });

  it("keeps a natively settled revision, answer, and disposition human acts", () => {
    const detail = importedDeliveredSpecDetailFixture();
    detail.importRecord = null;
    detail.gateAdmissions = [];
    const questionEvent = detail.attentionAuditEvents.find(
      (event) =>
        event.kind === "record" && event.payload.recordKind === "question",
    );
    const assumptionEvent = detail.attentionAuditEvents.find(
      (event) =>
        event.kind === "record" && event.payload.recordKind === "assumption",
    );
    if (
      questionEvent?.kind !== "record" ||
      questionEvent.payload.after.kind !== "question" ||
      assumptionEvent?.kind !== "record" ||
      assumptionEvent.payload.after.kind !== "assumption"
    ) {
      throw new Error("Imported attention audit fixtures are missing");
    }
    const questionAfter = {
      ...questionEvent.payload.after,
      recordVersion: 2,
    };
    const assumptionAfter = {
      ...assumptionEvent.payload.after,
      recordVersion: 2,
    };
    detail.attentionAuditEvents = [
      {
        ...questionEvent,
        actor: { kind: "human" },
        payload: {
          ...questionEvent.payload,
          operation: "answered",
          before: {
            ...questionAfter,
            recordVersion: 1,
            status: "open",
            answer: null,
            answeredAt: null,
            updatedAt: questionAfter.createdAt,
          },
          after: questionAfter,
        },
      },
      {
        ...assumptionEvent,
        actor: { kind: "human" },
        payload: {
          ...assumptionEvent.payload,
          operation: "disposed",
          before: {
            ...assumptionAfter,
            recordVersion: 1,
            disposition: "proposed",
            disposedAt: null,
            updatedAt: assumptionAfter.createdAt,
          },
          after: assumptionAfter,
        },
      },
    ];

    render(<SpecHistoryPanel detail={detail} projectName="command-center" />);

    for (const label of [
      "Revision 1 signed off",
      "Q1 answered",
      "A1 confirmed",
    ]) {
      const row = screen.getByText(label).closest("article");
      if (row === null) throw new Error(`${label} has no history row`);
      expect(row).toHaveAttribute("data-emphasis", "human");
    }
  });

  it("links a proposal row to the Review entry that can act on it", () => {
    const events = buildSpecHistory(
      strandedProposalDetailFixture(),
      "command-center",
    );

    // History is where a reader meets a stranded proposal; a row that reads as
    // plain text leaves them where #50 left them — informed and stuck.
    expect(
      events.find((event) => event.id === "revision-2:proposed")?.href,
    ).toBe(
      "/specs/command-center/native-sdd?view=requirements&revision=revision-2",
    );
  });

  it("drops the link once the proposal is no longer live", () => {
    const detail = strandedProposalDetailFixture();
    // The dismissal this context added ends the proposal: the row stays as the
    // durable record, but Review selects out of liveProposals, so keeping the
    // link would send a reader to a different proposal or an empty tab.
    const dismissed = {
      ...detail,
      revisions: detail.revisions.map((revision) =>
        revision.id === "revision-2"
          ? { ...revision, state: "withdrawn" as const }
          : revision,
      ),
      liveProposals: [],
    };

    const events = buildSpecHistory(dismissed, "command-center");

    const row = events.find((event) => event.id === "revision-2:proposed");
    expect(row).toBeDefined();
    expect(row?.href).toBeNull();
  });

  it("renders the stranded proposal row as a link a reader can follow", () => {
    render(
      <SpecHistoryPanel
        detail={strandedProposalDetailFixture()}
        projectName="command-center"
      />,
    );

    // The projection carrying an href only helps if the row actually renders
    // one — the reachability #50 lacked is the rendered anchor, not the field.
    const row = screen.getByText("Revision 2 proposed").closest("li");
    if (!(row instanceof HTMLElement)) {
      throw new Error("the proposal row did not render as a feed item");
    }
    expect(
      within(row).getByRole("link", { name: /Open subject/i }),
    ).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?view=requirements&revision=revision-2",
    );
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
