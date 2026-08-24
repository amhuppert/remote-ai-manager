// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  SpecAssumptionView,
  SpecDetailView,
  SpecQuestionView,
} from "@/lib/specs/view-schemas";

import SpecQuestionsAssumptionsPanel, {
  blockingAssumptionIdsFromLint,
  SpecQuestionsAssumptions,
} from "./SpecQuestionsAssumptions";
import { SpecDetailContent } from "./SpecDetailPage";
import {
  SPEC_CONTROLS_FIXTURE_NOW as NOW,
  importedDeliveredSpecDetailFixture,
  specControlsDetailFixture as detailFixture,
} from "./SpecControls.fixtures";

function questionFixture(
  overrides: Partial<SpecQuestionView> = {},
): SpecQuestionView {
  const status = overrides.status ?? "open";
  return {
    id: "question-1",
    number: 1,
    handle: "Q1",
    elementId: null,
    text: "Which retention window applies?",
    recordVersion: 1,
    status,
    answer: null,
    answeredAt: null,
    withdrawnAt: null,
    provenance: { kind: "agent", conversationId: "conversation-1" },
    presentation:
      overrides.presentation ??
      (status === "open"
        ? {
            state: "current",
            attentionActive: true,
            lastMutation: null,
            humanCapability: { kind: "answer", allowed: true },
          }
        : {
            state: status === "withdrawn" ? "history" : "current",
            attentionActive: false,
            lastMutation: null,
            humanCapability: {
              kind: "answer",
              allowed: false,
              code: "terminal",
              blockingRevisionId: null,
              instruction: "This question is terminal.",
            },
          }),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function assumptionFixture(
  overrides: Partial<SpecAssumptionView> = {},
): SpecAssumptionView {
  const disposition = overrides.disposition ?? "proposed";
  return {
    id: "assumption-1",
    number: 1,
    handle: "A1",
    elementId: "requirement-1",
    text: "Retention defaults to 30 days.",
    recordVersion: 1,
    disposition,
    disposedAt: null,
    withdrawnAt: null,
    proposedBy: { kind: "agent", conversationId: "conversation-1" },
    supersedesHandle: null,
    supersededByHandle: null,
    currentDraftCitations: null,
    presentation:
      overrides.presentation ??
      (disposition === "proposed"
        ? {
            state: "current",
            attentionActive: true,
            lastMutation: null,
            humanCapability: { kind: "dispose", allowed: true },
          }
        : {
            state: disposition === "withdrawn" ? "history" : "current",
            attentionActive: false,
            lastMutation: null,
            humanCapability: {
              kind: "dispose",
              allowed: false,
              code: "terminal",
              blockingRevisionId: null,
              instruction: "This assumption is terminal.",
            },
          }),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function citedAssumptionFixture(
  overrides: Partial<SpecAssumptionView> = {},
): SpecAssumptionView {
  const fixture = assumptionFixture(overrides);
  return {
    ...fixture,
    currentDraftCitations: {
      revisionId: "revision-draft",
      citationVersion: 4,
      citationHash: "a".repeat(64),
      citations: [
        {
          revisionId: "revision-draft",
          specId: "spec-1",
          elementId: "requirement-1",
          elementHandle: "R1",
          assumptionId: fixture.id,
          snapshot: {
            schemaVersion: 1,
            captureKind: "native",
            capturedAt: NOW,
            assumptionId: fixture.id,
            number: fixture.number,
            recordVersion: fixture.recordVersion,
            text: fixture.text,
            elementId: fixture.elementId,
            proposedBy: fixture.proposedBy ?? {
              kind: "agent",
              conversationId: "conversation-1",
            },
            disposition: fixture.disposition,
            disposedAt: fixture.disposedAt,
            withdrawnAt: fixture.withdrawnAt,
            supersedesAssumptionId: null,
            createdAt: fixture.createdAt,
            updatedAt: fixture.updatedAt,
          },
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    },
  };
}

function renderStudio(
  overrides: Partial<Parameters<typeof SpecQuestionsAssumptions>[0]> = {},
): {
  onAnswerQuestion: ReturnType<typeof vi.fn>;
  onDisposeAssumption: ReturnType<typeof vi.fn>;
} {
  const onAnswerQuestion = vi.fn(
    overrides.onAnswerQuestion ?? (async () => undefined),
  );
  const onDisposeAssumption = vi.fn(
    overrides.onDisposeAssumption ?? (async () => undefined),
  );
  const { importedAt = null, ...rest } = overrides;
  render(
    <SpecQuestionsAssumptions
      questions={[questionFixture()]}
      assumptions={[assumptionFixture()]}
      projectName="command-center"
      slug="native-sdd"
      revision={1}
      phase={{ primary: "draft", authoringStage: "requirements" }}
      elementHandlesById={new Map([["requirement-1", "R1"]])}
      importedAt={importedAt}
      onAnswerQuestion={onAnswerQuestion}
      onDisposeAssumption={onDisposeAssumption}
      {...rest}
    />,
  );
  return { onAnswerQuestion, onDisposeAssumption };
}

describe("SpecQuestionsAssumptions", () => {
  it("keeps the requirements lock visible while requirements are active", () => {
    renderStudio();

    expect(screen.getByText("Requirements active")).toBeVisible();
    expect(
      screen.getByText(
        "Design remains locked until the requirements stage is settled.",
      ),
    ).toBeVisible();
  });

  it("partitions current records from ordered record history", async () => {
    const user = userEvent.setup();
    renderStudio({
      questions: [
        questionFixture({
          id: "question-3",
          number: 3,
          handle: "Q3",
          status: "answered",
          answer: "Thirty days.",
          answeredAt: NOW,
        }),
        questionFixture({
          id: "question-2",
          number: 2,
          handle: "Q2",
          status: "withdrawn",
          withdrawnAt: NOW,
          updatedAt: "2026-07-20T12:00:00.000Z",
        }),
        questionFixture(),
      ],
      assumptions: [
        assumptionFixture({
          id: "assumption-4",
          number: 4,
          handle: "A4",
          disposition: "confirmed",
          disposedAt: NOW,
          supersededByHandle: "A8",
          updatedAt: "2026-07-19T12:00:00.000Z",
          presentation: {
            state: "history",
            attentionActive: false,
            lastMutation: null,
            humanCapability: {
              kind: "dispose",
              allowed: false,
              code: "terminal",
              blockingRevisionId: null,
              instruction: "This assumption was superseded.",
            },
          },
        }),
        assumptionFixture({
          id: "assumption-2",
          number: 2,
          handle: "A2",
          disposition: "deferred",
          disposedAt: NOW,
        }),
        assumptionFixture(),
      ],
    });

    const questions = screen.getByRole("region", { name: "Questions" });
    const assumptions = screen.getByRole("region", { name: "Assumptions" });
    expect(
      within(questions)
        .getAllByRole("article")
        .map((article) => article.id),
    ).toEqual(["Q1", "Q3"]);
    expect(
      within(assumptions)
        .getAllByRole("article")
        .map((article) => article.id),
    ).toEqual(["A1", "A2"]);
    expect(document.getElementById("Q2")).toBeNull();
    expect(document.getElementById("A4")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Record history · 2" }),
    );
    expect(
      screen
        .getAllByRole("article")
        .slice(-2)
        .map((article) => article.id),
    ).toEqual(["Q2", "A4"]);
  });

  it("renders a non-interactive empty-history count", () => {
    renderStudio();

    expect(screen.getByText("Record history · 0")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Record history/ }),
    ).not.toBeInTheDocument();
  });

  it("never renders human controls for terminal records", () => {
    renderStudio({
      questions: [
        questionFixture({
          status: "answered",
          answer: "Thirty days.",
          answeredAt: NOW,
        }),
      ],
      assumptions: [
        assumptionFixture({
          disposition: "rejected",
          disposedAt: NOW,
        }),
      ],
    });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Reject assumption for A1" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Record decision for A1" }),
    ).not.toBeInTheDocument();
  });

  it("submits record and citation CAS versions through explicit human commits", async () => {
    const user = userEvent.setup();
    const onAnswerQuestion = vi.fn(async () => undefined);
    const onDisposeAssumption = vi.fn(async () => undefined);
    renderStudio({
      questions: [questionFixture({ recordVersion: 3 })],
      assumptions: [citedAssumptionFixture({ recordVersion: 2 })],
      onAnswerQuestion,
      onDisposeAssumption,
    });

    await user.type(
      screen.getByRole("textbox", { name: "Answer for Q1" }),
      "Thirty days.",
    );
    await user.click(
      screen.getByRole("button", { name: "Record answer for Q1" }),
    );
    expect(onAnswerQuestion).toHaveBeenCalledWith({
      questionId: "question-1",
      recordVersion: 3,
      answer: "Thirty days.",
    });

    const confirm = screen.getByRole("radio", { name: "Confirm" });
    await user.click(confirm);
    await user.keyboard("{ArrowRight}");
    await user.keyboard(" ");
    expect(screen.getByRole("radio", { name: "Reject" })).toBeChecked();
    await user.click(
      screen.getByRole("button", { name: "Reject assumption for A1" }),
    );
    expect(onDisposeAssumption).toHaveBeenCalledWith({
      assumptionId: "assumption-1",
      recordVersion: 2,
      citationVersion: 4,
      disposition: "rejected",
    });
  });

  it("renders Q/A records with bare-handle DOM ids, status, and attachment", () => {
    renderStudio({
      questions: [
        questionFixture(),
        questionFixture({
          id: "question-2",
          number: 2,
          handle: "Q2",
          status: "answered",
          answer: "Thirty days, per the charter.",
          answeredAt: NOW,
        }),
      ],
      assumptions: [
        assumptionFixture(),
        assumptionFixture({
          id: "assumption-2",
          number: 2,
          handle: "A2",
          elementId: null,
          disposition: "rejected",
          disposedAt: NOW,
        }),
      ],
    });

    const q1 = document.getElementById("Q1");
    const q2 = document.getElementById("Q2");
    const a1 = document.getElementById("A1");
    const a2 = document.getElementById("A2");
    expect(q1).not.toBeNull();
    expect(a1).not.toBeNull();
    if (q1 === null || q2 === null || a1 === null || a2 === null) {
      throw new Error("Expected bare-handle DOM ids for Q/A records");
    }

    expect(
      within(q1).getByText("Which retention window applies?"),
    ).toBeVisible();
    expect(within(q1).getByText("Open")).toBeInTheDocument();
    expect(within(q2).getByText("Answered")).toBeInTheDocument();
    expect(
      within(q2).getByText("Thirty days, per the charter."),
    ).toBeInTheDocument();

    expect(within(a1).getByText("Proposed")).toBeInTheDocument();
    expect(within(a1).getByText("Attached to R1")).toBeInTheDocument();
    // A disposed assumption shows its disposition both as the status pill and
    // as the current value of the disposition select.
    expect(within(a2).getAllByText("Rejected")).not.toHaveLength(0);
    expect(within(a2).getByText("Spec-level")).toBeInTheDocument();
  });

  it("renders question, answer, and assumption prose as markdown", async () => {
    renderStudio({
      questions: [
        questionFixture({ text: "Which **retention** window applies?" }),
        questionFixture({
          id: "question-2",
          number: 2,
          handle: "Q2",
          text: "Which environments are covered?",
          status: "answered",
          answer: "- Production\n- **Staging**",
          answeredAt: NOW,
        }),
      ],
      assumptions: [
        assumptionFixture({ text: "Retention defaults to `30 days`." }),
      ],
    });

    const q1 = document.getElementById("Q1");
    const q2 = document.getElementById("Q2");
    const a1 = document.getElementById("A1");
    if (q1 === null || q2 === null || a1 === null) {
      throw new Error("Expected Q/A cards");
    }

    expect(
      await within(q1).findByText("retention", { selector: "strong" }),
    ).toBeVisible();
    expect(await within(q2).findAllByRole("listitem")).toHaveLength(2);
    expect(
      await within(q2).findByText("Staging", { selector: "strong" }),
    ).toBeVisible();
    expect(
      await within(a1).findByText("30 days", { selector: "code" }),
    ).toBeVisible();
  });

  it("fires dispose-assumption with the chosen disposition", async () => {
    const user = userEvent.setup();
    const { onDisposeAssumption } = renderStudio();

    expect(
      screen.queryByRole("combobox", { name: "Disposition for A1" }),
    ).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Reject" }));
    await user.click(
      screen.getByRole("button", { name: "Reject assumption for A1" }),
    );

    expect(onDisposeAssumption).toHaveBeenCalledWith({
      assumptionId: "assumption-1",
      recordVersion: 1,
      disposition: "rejected",
    });
  });

  it("records an inline answer for an open question", async () => {
    const user = userEvent.setup();
    const { onAnswerQuestion } = renderStudio();

    const answerButton = screen.getByRole("button", {
      name: "Record answer for Q1",
    });
    expect(answerButton).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Answer for Q1" }),
      "Thirty days.",
    );
    await user.click(answerButton);

    expect(onAnswerQuestion).toHaveBeenCalledWith({
      questionId: "question-1",
      recordVersion: 1,
      answer: "Thirty days.",
    });
  });

  /**
   * An imported answer was written in the external source and an imported
   * disposition was taken there too. Neither is an act anybody performed on
   * this surface, so both name the import (R9.7).
   */
  describe("import provenance", () => {
    const IMPORTED_AT = "2026-07-18T09:00:00.000Z";
    const ANSWERED_HERE_AT = "2026-07-19T09:00:00.000Z";

    it("attributes an answer and a disposition that arrived with the import to the import", () => {
      renderStudio({
        importedAt: IMPORTED_AT,
        questions: [
          questionFixture({
            status: "answered",
            answer: "Thirty days, per the source spec.",
            answeredAt: IMPORTED_AT,
            createdAt: IMPORTED_AT,
          }),
        ],
        assumptions: [
          assumptionFixture({
            disposition: "confirmed",
            disposedAt: IMPORTED_AT,
            createdAt: IMPORTED_AT,
          }),
        ],
      });

      const q1 = document.getElementById("Q1");
      const a1 = document.getElementById("A1");
      if (q1 === null || a1 === null) throw new Error("Expected Q/A cards");

      expect(within(q1).getByText("Answered at import")).toBeVisible();
      expect(within(q1).queryByText("Answer")).not.toBeInTheDocument();
      expect(
        within(q1).getByText("Thirty days, per the source spec."),
      ).toBeVisible();
      expect(within(a1).getByText("Confirmed at import")).toBeVisible();
      // The register never claims a person: an operator attribution here would
      // present imported content as a human decision.
      expect(screen.queryByText(/Operator/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^Confirmed$/)).not.toBeInTheDocument();
    });

    it("leaves an answer and a disposition recorded here after the import unmarked", () => {
      renderStudio({
        importedAt: IMPORTED_AT,
        questions: [
          questionFixture({
            status: "answered",
            answer: "Thirty days, decided here.",
            answeredAt: ANSWERED_HERE_AT,
            createdAt: IMPORTED_AT,
          }),
        ],
        assumptions: [
          assumptionFixture({
            disposition: "confirmed",
            disposedAt: ANSWERED_HERE_AT,
            createdAt: IMPORTED_AT,
          }),
        ],
      });

      expect(screen.queryByText("Answered at import")).not.toBeInTheDocument();
      expect(screen.queryByText("Confirmed at import")).not.toBeInTheDocument();
      expect(screen.getByText("Answer")).toBeVisible();
      expect(screen.getByText("Confirmed")).toBeVisible();
    });

    it("marks nothing on a spec that was never imported", () => {
      renderStudio({
        questions: [
          questionFixture({
            status: "answered",
            answer: "Thirty days.",
            answeredAt: NOW,
            createdAt: NOW,
          }),
        ],
        assumptions: [
          assumptionFixture({
            disposition: "confirmed",
            disposedAt: NOW,
            createdAt: NOW,
          }),
        ],
      });

      expect(screen.queryByText(/at import/)).not.toBeInTheDocument();
    });
  });

  it("renders the server-projected amendment capability instead of controls", () => {
    const instruction = "Open an amendment before recording the disposition.";
    renderStudio({
      assumptions: [
        assumptionFixture({
          presentation: {
            state: "current",
            attentionActive: true,
            lastMutation: null,
            humanCapability: {
              kind: "dispose",
              allowed: false,
              code: "amendment_required",
              blockingRevisionId: "revision-1",
              instruction,
            },
          },
        }),
      ],
    });

    expect(screen.getByText(instruction)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Review" })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?view=review",
    );
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("marks rejected cited assumptions from the canonical sign-off finding", () => {
    const assumption = citedAssumptionFixture({
      disposition: "rejected",
      disposedAt: NOW,
    });
    const blockingAssumptionIds = blockingAssumptionIdsFromLint(
      [assumption],
      [
        {
          ruleId: "9.8.rejected-cited-assumption",
          severity: "blocks_signoff",
          elementHandle: "R1",
          message: "A1 was rejected but R1 still cites it.",
        },
      ],
    );

    renderStudio({
      assumptions: [assumption],
      blockingAssumptionIds,
    });

    expect(screen.getByText("Blocks sign-off")).toBeVisible();
    expect(
      screen.getByText(/supersede this premise before requesting sign-off/i),
    ).toBeVisible();
  });

  it("keeps pending state local to the submitted card", async () => {
    const user = userEvent.setup();
    let finish: (() => void) | undefined;
    const onAnswerQuestion = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderStudio({
      questions: [
        questionFixture(),
        questionFixture({
          id: "question-2",
          number: 2,
          handle: "Q2",
          text: "Which environments are covered?",
        }),
      ],
      onAnswerQuestion,
    });

    const q1Answer = screen.getByRole("textbox", { name: "Answer for Q1" });
    const q2Answer = screen.getByRole("textbox", { name: "Answer for Q2" });
    await user.type(q1Answer, "Thirty days.");
    await user.type(q2Answer, "Production.");
    await user.click(
      screen.getByRole("button", { name: "Record answer for Q1" }),
    );

    expect(q1Answer).toBeDisabled();
    expect(q2Answer).not.toBeDisabled();
    expect(q2Answer).toHaveValue("Production.");
    finish?.();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Answer recorded",
    );
  });

  it("retains a failed answer draft and reports the refusal on its card", async () => {
    const user = userEvent.setup();
    const refusal = "The question changed. Refresh and try again.";
    renderStudio({
      onAnswerQuestion: vi.fn(async () => {
        throw new Error(refusal);
      }),
    });

    const answer = screen.getByRole("textbox", { name: "Answer for Q1" });
    await user.type(answer, "Thirty days.");
    await user.click(
      screen.getByRole("button", { name: "Record answer for Q1" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
    expect(answer).toHaveValue("Thirty days.");
  });

  it("renders conversation provenance, citations, and lineage as separate links", () => {
    renderStudio({
      questions: [
        questionFixture({
          provenance: {
            kind: "agent",
            backend: "claude",
            conversationId: "conversation-1",
          },
        }),
      ],
      assumptions: [
        citedAssumptionFixture({
          supersedesHandle: "A4",
          supersededByHandle: "A8",
        }),
      ],
    });

    expect(
      screen.getByRole("link", {
        name: /Open conversation from Claude agent \(conversation-1\)/,
      }),
    ).toHaveAttribute("href", "/conversations?c=conversation-1");
    expect(screen.getByText("Attached to R1")).toBeVisible();
    expect(screen.getByRole("link", { name: "Cited by R1" })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=R1",
    );
    expect(screen.getByRole("link", { name: "Supersedes A4" })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=A4",
    );
    expect(
      screen.getByRole("link", { name: "Superseded by A8" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?el=A8");
  });

  it("opens history and focuses a historical deep-link target", async () => {
    renderStudio({
      targetHandle: "Q2",
      questions: [
        questionFixture(),
        questionFixture({
          id: "question-2",
          number: 2,
          handle: "Q2",
          status: "withdrawn",
          withdrawnAt: NOW,
        }),
      ],
    });

    const target = await waitFor(() => {
      const candidate = document.getElementById("Q2");
      expect(candidate).not.toBeNull();
      return candidate;
    });
    await waitFor(() => expect(target).toHaveFocus());
  });

  it("opens history and focuses a superseded predecessor from its current successor", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?view=questions",
    );
    renderStudio({
      assumptions: [
        assumptionFixture({
          id: "assumption-4",
          number: 4,
          handle: "A4",
          disposition: "confirmed",
          disposedAt: NOW,
          supersededByHandle: "A8",
          presentation: {
            state: "history",
            attentionActive: false,
            lastMutation: null,
            humanCapability: {
              kind: "dispose",
              allowed: false,
              code: "terminal",
              blockingRevisionId: null,
              instruction: "This assumption was superseded.",
            },
          },
        }),
        assumptionFixture({
          id: "assumption-8",
          number: 8,
          handle: "A8",
          supersedesHandle: "A4",
        }),
      ],
    });

    expect(document.getElementById("A4")).toBeNull();
    const predecessorLink = screen.getByRole("link", {
      name: "Supersedes A4",
    });
    expect(predecessorLink).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=A4",
    );
    await user.click(predecessorLink);

    const predecessor = await waitFor(() => {
      const candidate = document.getElementById("A4");
      if (candidate === null) throw new Error("A4 did not mount from history");
      return candidate;
    });
    await waitFor(() => expect(predecessor).toHaveFocus());
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/specs/command-center/native-sdd?el=A4",
    );
    const successorLink = within(predecessor).getByRole("link", {
      name: "Superseded by A8",
    });
    expect(successorLink).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=A8",
    );
    await user.click(successorLink);
    await waitFor(() => expect(document.getElementById("A8")).toHaveFocus());
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/specs/command-center/native-sdd?el=A8",
    );
    expect(
      within(predecessor).getByRole("link", { name: "Superseded by A8" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?el=A8");
    window.history.replaceState({}, "", "/");
  });

  it("reports success and restores focus to the submitted record", async () => {
    const user = userEvent.setup();
    renderStudio();

    await user.type(
      screen.getByRole("textbox", { name: "Answer for Q1" }),
      "Thirty days.",
    );
    await user.click(
      screen.getByRole("button", { name: "Record answer for Q1" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Answer recorded",
    );
    expect(document.getElementById("Q1")).toHaveFocus();
  });
});

describe("SpecQuestionsAssumptionsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function panelDetail(): SpecDetailView {
    return {
      ...detailFixture(),
      questions: [questionFixture()],
      assumptions: [assumptionFixture()],
    };
  }

  it("does not announce a requirements lock after authoring has advanced", () => {
    const detail = panelDetail();
    detail.status.phase = { primary: "approved", authoringStage: "design" };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpecQuestionsAssumptionsPanel
          detail={detail}
          projectName="command-center"
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByText("Requirements active")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Design remains locked until the requirements stage is settled.",
      ),
    ).not.toBeInTheDocument();
  });

  it("shows the durable withdrawal reason in record history", async () => {
    const user = userEvent.setup();
    const detail = panelDetail();
    const withdrawnAt = "2026-07-20T12:00:00.000Z";
    const withdrawn = questionFixture({
      status: "withdrawn",
      recordVersion: 2,
      withdrawnAt,
      updatedAt: withdrawnAt,
      presentation: {
        state: "history",
        attentionActive: false,
        lastMutation: {
          operation: "withdrawn",
          actor: { kind: "agent", conversationId: "conversation-2" },
          occurredAt: withdrawnAt,
        },
        humanCapability: {
          kind: "answer",
          allowed: false,
          code: "terminal",
          blockingRevisionId: null,
          instruction: "This question was withdrawn.",
        },
      },
    });
    detail.questions = [withdrawn];
    detail.assumptions = [];
    detail.attentionAuditEvents = [
      {
        kind: "record",
        eventId: 7,
        occurredAt: withdrawnAt,
        actor: { kind: "agent", conversationId: "conversation-2" },
        payload: {
          schemaVersion: 1,
          recordKind: "question",
          recordId: withdrawn.id,
          recordNumber: withdrawn.number,
          attentionId: withdrawn.id,
          operation: "withdrawn",
          reason: "The requirement no longer depends on this unknown.",
          active: false,
          before: {
            kind: "question",
            recordId: withdrawn.id,
            number: withdrawn.number,
            recordVersion: 1,
            text: withdrawn.text,
            elementId: withdrawn.elementId,
            provenance: {
              kind: "agent",
              conversationId: "conversation-1",
            },
            status: "open",
            answer: null,
            answeredAt: null,
            withdrawnAt: null,
            createdAt: withdrawn.createdAt,
            updatedAt: withdrawn.createdAt,
          },
          after: {
            kind: "question",
            recordId: withdrawn.id,
            number: withdrawn.number,
            recordVersion: withdrawn.recordVersion,
            text: withdrawn.text,
            elementId: withdrawn.elementId,
            provenance: {
              kind: "agent",
              conversationId: "conversation-1",
            },
            status: withdrawn.status,
            answer: withdrawn.answer,
            answeredAt: withdrawn.answeredAt,
            withdrawnAt: withdrawn.withdrawnAt,
            createdAt: withdrawn.createdAt,
            updatedAt: withdrawn.updatedAt,
          },
        },
      },
    ];

    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpecQuestionsAssumptionsPanel
          detail={detail}
          projectName="command-center"
        />
      </QueryClientProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Record history · 1" }),
    );
    const card = document.getElementById("Q1");
    expect(card).not.toBeNull();
    if (card === null) throw new Error("Withdrawn question card is missing");
    expect(
      within(card).getByText(
        "The requirement no longer depends on this unknown.",
      ),
    ).toBeVisible();
  });

  it("keeps abandoned Q/A readable without exposing mutation controls", () => {
    const detail = panelDetail();
    detail.spec = {
      ...detail.spec,
      abandonedAt: NOW,
      abandonedReason: "The product direction was withdrawn.",
    };
    detail.status.phase = {
      primary: "abandoned",
      authoringStage: "plan",
    };
    detail.questions = detail.questions.map((question) => ({
      ...question,
      presentation: {
        ...question.presentation,
        humanCapability: {
          kind: "answer",
          allowed: false,
          code: "read_only",
          blockingRevisionId: null,
          instruction: "This spec is read-only.",
        },
      },
    }));
    detail.assumptions = detail.assumptions.map((assumption) => ({
      ...assumption,
      presentation: {
        ...assumption.presentation,
        humanCapability: {
          kind: "dispose",
          allowed: false,
          code: "read_only",
          blockingRevisionId: null,
          instruction: "This spec is read-only.",
        },
      },
    }));

    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpecQuestionsAssumptionsPanel
          detail={detail}
          projectName="command-center"
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "Abandoned spec — read-only" }),
    ).toBeVisible();
    expect(screen.getByText("Which retention window applies?")).toBeVisible();
    expect(screen.getByText("Retention defaults to 30 days.")).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "Answer for Q1" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Confirm" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Record decision for A1" }),
    ).not.toBeInTheDocument();
  });

  /**
   * The import instant comes from the basis-`import` gate admissions, not from
   * the `spec_imported` event: that event's projection is null whenever its
   * payload is unreadable, and attribution that vanishes with the event detail
   * would silently re-present imported answers as acts taken here.
   */
  it.each([
    ["the import event is readable", true],
    ["the import event's detail is unreadable", false],
  ])(
    "reads the import instant off the admissions when %s",
    (_case, withRecord) => {
      const imported = importedDeliveredSpecDetailFixture();
      const detail = {
        ...imported,
        importRecord: withRecord ? imported.importRecord : null,
      };

      render(
        <QueryClientProvider client={new QueryClient()}>
          <SpecQuestionsAssumptionsPanel
            detail={detail}
            projectName="command-center"
          />
        </QueryClientProvider>,
      );

      expect(screen.getByText("Answered at import")).toBeVisible();
      expect(screen.getByText("Confirmed at import")).toBeVisible();
    },
  );

  it("marks nothing when no gate was admitted by import", () => {
    const imported = importedDeliveredSpecDetailFixture();

    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpecQuestionsAssumptionsPanel
          detail={{ ...imported, gateAdmissions: [] }}
          projectName="command-center"
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByText(/at import/)).not.toBeInTheDocument();
  });

  it("posts dispose-assumption through the spec action route", async () => {
    const fetchSpy = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json(
        assumptionFixture({
          disposition: "confirmed",
          disposedAt: NOW,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpecQuestionsAssumptionsPanel
          detail={panelDetail()}
          projectName="command-center"
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("radio", { name: "Confirm" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm assumption for A1" }),
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const call = fetchSpy.mock.calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    const [url, init] = call;
    expect(url).toBe(
      "/api/specs/command-center/native-sdd/actions/dispose-assumption",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      assumptionId: "assumption-1",
      recordVersion: 1,
      disposition: "confirmed",
    });
  });

  it("renders the amendment_required refusal from the route", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        {
          code: "amendment_required",
          unmetConditions: [
            "A1 is cited by approved content and cannot change in place.",
          ],
          instruction:
            "Open an amendment and update the cited content before changing this disposition.",
        },
        { status: 409 },
      ),
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpecQuestionsAssumptionsPanel
          detail={panelDetail()}
          projectName="command-center"
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("radio", { name: "Reject" }));
    await user.click(
      screen.getByRole("button", { name: "Reject assumption for A1" }),
    );

    expect(
      await screen.findByText(
        /A1 is cited by approved content and cannot change in place/,
      ),
    ).toBeInTheDocument();
  });
});

describe("Spec detail questions and assumptions rail", () => {
  it("keeps a read-only questions and assumptions summary on the overview", () => {
    const detail: SpecDetailView = {
      ...detailFixture(),
      questions: [questionFixture()],
      assumptions: [assumptionFixture()],
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpecDetailContent
          detail={detail}
          projectName="command-center"
          requestedSlug="native-sdd"
          view="overview"
          onViewChange={() => undefined}
        />
      </QueryClientProvider>,
    );

    const structure = screen.getByRole("complementary", {
      name: "Spec structure",
    });
    const heading = within(structure).getByRole("heading", {
      name: "Questions & assumptions",
    });
    const questionsSection = heading.closest("section");
    expect(questionsSection).not.toBeNull();
    if (questionsSection === null) {
      throw new Error("Questions & assumptions section was not rendered");
    }

    expect(within(questionsSection).getByText("2")).toBeInTheDocument();
    expect(
      within(questionsSection).getByText("Which retention window applies?"),
    ).toBeInTheDocument();
    expect(
      within(questionsSection).getByText("Retention defaults to 30 days."),
    ).toBeInTheDocument();
    expect(within(questionsSection).getAllByText("Open")).not.toHaveLength(0);
    expect(within(questionsSection).getByText("Proposed")).toBeInTheDocument();
    expect(
      within(questionsSection).queryByRole("button", { name: "Confirm A1" }),
    ).not.toBeInTheDocument();
    expect(
      within(questionsSection).getByRole("link", {
        name: "Open Questions & assumptions",
      }),
    ).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?view=questions",
    );
  });

  it("removes overview disposition controls after abandonment", () => {
    const detail: SpecDetailView = {
      ...detailFixture(),
      spec: {
        ...detailFixture().spec,
        abandonedAt: NOW,
        abandonedReason: "The product direction was withdrawn.",
      },
      questions: [questionFixture()],
      assumptions: [assumptionFixture()],
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpecDetailContent
          detail={detail}
          projectName="command-center"
          requestedSlug="native-sdd"
          view="overview"
          onViewChange={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Retention defaults to 30 days.")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Confirm A1" }),
    ).not.toBeInTheDocument();
  });
});
