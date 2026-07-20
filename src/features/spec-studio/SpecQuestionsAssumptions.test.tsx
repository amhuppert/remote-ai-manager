// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  SpecAssumptionView,
  SpecDetailView,
  SpecQuestionView,
} from "@/lib/specs/queries";

import SpecQuestionsAssumptionsPanel, {
  SpecQuestionsAssumptions,
} from "./SpecQuestionsAssumptions";
import SpecDetailViews from "./SpecDetailViews";
import {
  SPEC_CONTROLS_FIXTURE_NOW as NOW,
  specControlsDetailFixture as detailFixture,
} from "./SpecControls.fixtures";

function questionFixture(
  overrides: Partial<SpecQuestionView> = {},
): SpecQuestionView {
  return {
    id: "question-1",
    number: 1,
    handle: "Q1",
    elementId: null,
    text: "Which retention window applies?",
    status: "open",
    answer: null,
    answeredAt: null,
    provenance: { kind: "agent", conversationId: "conversation-1" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function assumptionFixture(
  overrides: Partial<SpecAssumptionView> = {},
): SpecAssumptionView {
  return {
    id: "assumption-1",
    number: 1,
    handle: "A1",
    elementId: "requirement-1",
    text: "Retention defaults to 30 days.",
    disposition: "proposed",
    disposedAt: null,
    proposedBy: { kind: "agent", conversationId: "conversation-1" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function renderStudio(
  overrides: Partial<Parameters<typeof SpecQuestionsAssumptions>[0]> = {},
): {
  onAnswerQuestion: ReturnType<typeof vi.fn>;
  onDisposeAssumption: ReturnType<typeof vi.fn>;
} {
  const onAnswerQuestion = vi.fn();
  const onDisposeAssumption = vi.fn();
  render(
    <SpecQuestionsAssumptions
      questions={[questionFixture()]}
      assumptions={[assumptionFixture()]}
      projectName="command-center"
      slug="native-sdd"
      revision={1}
      elementHandlesById={new Map([["requirement-1", "R1"]])}
      pendingAction={null}
      error={null}
      onAnswerQuestion={onAnswerQuestion}
      onDisposeAssumption={onDisposeAssumption}
      {...overrides}
    />,
  );
  return { onAnswerQuestion, onDisposeAssumption };
}

describe("SpecQuestionsAssumptions", () => {
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
    ).toBeInTheDocument();
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

  it("fires dispose-assumption with the chosen disposition", async () => {
    const user = userEvent.setup();
    const { onDisposeAssumption } = renderStudio();

    await user.click(
      screen.getByRole("combobox", { name: "Disposition for A1" }),
    );
    await user.click(screen.getByRole("option", { name: "Rejected" }));
    await user.click(
      screen.getByRole("button", { name: "Save disposition for A1" }),
    );

    expect(onDisposeAssumption).toHaveBeenCalledWith({
      assumptionId: "assumption-1",
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
      answer: "Thirty days.",
    });
  });

  it("surfaces the server refusal verbatim", () => {
    const refusal =
      "A1 is cited by approved content and cannot change in place. " +
      "Open an amendment and update the cited content before changing this disposition.";
    renderStudio({ error: refusal });

    expect(screen.getByRole("alert")).toHaveTextContent(refusal);
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

  it("posts dispose-assumption through the spec action route", async () => {
    const fetchSpy = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({
        id: "assumption-1",
        spec_id: "spec-1",
        number: 1,
        element_id: "requirement-1",
        text: "Retention defaults to 30 days.",
        proposed_by_json: JSON.stringify({
          kind: "agent",
          conversationId: "conversation-1",
        }),
        disposition: "confirmed",
        disposed_at: NOW,
        created_at: NOW,
        updated_at: NOW,
      }),
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

    await user.click(
      screen.getByRole("combobox", { name: "Disposition for A1" }),
    );
    await user.click(screen.getByRole("option", { name: "Confirmed" }));
    await user.click(
      screen.getByRole("button", { name: "Save disposition for A1" }),
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

    await user.click(
      screen.getByRole("combobox", { name: "Disposition for A1" }),
    );
    await user.click(screen.getByRole("option", { name: "Rejected" }));
    await user.click(
      screen.getByRole("button", { name: "Save disposition for A1" }),
    );

    expect(
      await screen.findByText(
        /A1 is cited by approved content and cannot change in place/,
      ),
    ).toBeInTheDocument();
  });
});

describe("SpecDetailViews questions tab", () => {
  it("shows the attention count and renders the Q/A studio", async () => {
    const user = userEvent.setup();
    const detail: SpecDetailView = {
      ...detailFixture(),
      questions: [questionFixture()],
      assumptions: [assumptionFixture()],
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpecDetailViews detail={detail} projectName="command-center">
          <div />
        </SpecDetailViews>
      </QueryClientProvider>,
    );

    const questionsTab = screen.getByRole("tab", { name: /Questions/ });
    // One open question + one proposed assumption await human attention.
    expect(questionsTab).toHaveTextContent("2");
    await user.click(questionsTab);

    expect(
      await screen.findByText("Which retention window applies?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Retention defaults to 30 days."),
    ).toBeInTheDocument();
  });
});
