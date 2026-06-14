// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AskQuestionPanel from "@/components/AskQuestionPanel";
import type { AskQuestionItem } from "@/lib/conversations/schemas";

function makeQuestion(
  overrides: Partial<AskQuestionItem> = {},
): AskQuestionItem {
  return {
    id: "storage",
    question: "Which store?",
    header: "Architecture",
    required: true,
    multiSelect: false,
    allowNote: true,
    options: [
      { label: "SQLite", recommended: true },
      { label: "Redis", recommended: false },
    ],
    ...overrides,
  };
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^send/i }) as HTMLButtonElement;
}

describe("AskQuestionPanel", () => {
  it("renders the active question and reflects the asking agent as the accent", () => {
    render(
      <AskQuestionPanel
        questions={[makeQuestion()]}
        questionId="batch-1"
        currentIndex={0}
        onNavigate={vi.fn()}
        onSubmit={vi.fn()}
        agent="codex"
      />,
    );
    expect(screen.getAllByText("Which store?").length).toBeGreaterThan(0);
    expect(screen.getByRole("dialog").getAttribute("data-agent")).toBe("codex");
  });

  it("gates submit on required questions and emits a structured, id-keyed payload", () => {
    const onSubmit = vi.fn();
    render(
      <AskQuestionPanel
        questions={[makeQuestion()]}
        questionId="batch-1"
        currentIndex={0}
        onNavigate={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    // Required + unanswered → submit disabled.
    expect(submitButton().disabled).toBe(true);

    fireEvent.click(screen.getByText("SQLite"));
    expect(submitButton().disabled).toBe(false);

    fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledWith("batch-1", {
      storage: {
        selected: ["SQLite"],
        note: null,
        skipped: false,
        question: "Which store?",
      },
    });
  });

  it("attaches a clarifying note to the selection", () => {
    const onSubmit = vi.fn();
    render(
      <AskQuestionPanel
        questions={[makeQuestion()]}
        questionId="batch-1"
        currentIndex={0}
        onNavigate={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByText("SQLite"));
    fireEvent.click(screen.getByText(/add a note/i));
    fireEvent.change(screen.getByPlaceholderText(/go with sqlite/i), {
      target: { value: "gate behind a flag" },
    });
    fireEvent.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith("batch-1", {
      storage: {
        selected: ["SQLite"],
        note: "gate behind a flag",
        skipped: false,
        question: "Which store?",
      },
    });
  });

  it("minimizes to a banner on Escape and restores when expanded", () => {
    render(
      <AskQuestionPanel
        questions={[makeQuestion()]}
        questionId="batch-1"
        currentIndex={0}
        onNavigate={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Which store?").length).toBeGreaterThan(0);

    fireEvent.keyDown(document.body, { key: "Escape" });

    // Banner view: question hidden, conversation readable behind it.
    expect(screen.queryByText("Which store?")).toBeNull();
    expect(screen.getByText("Agent needs your input")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /expand question panel/i }),
    );
    expect(screen.getAllByText("Which store?").length).toBeGreaterThan(0);
  });

  it("drives the active question through onNavigate (controlled), not internal state", () => {
    const onNavigate = vi.fn();
    const questions = [
      makeQuestion({ id: "a", question: "First?" }),
      makeQuestion({ id: "b", question: "Second?" }),
    ];
    render(
      <AskQuestionPanel
        questions={questions}
        questionId="batch-1"
        currentIndex={0}
        onNavigate={onNavigate}
        onSubmit={vi.fn()}
      />,
    );

    // The rail lists both; clicking the inactive one navigates via the prop.
    fireEvent.click(screen.getByText("Second?"));
    expect(onNavigate).toHaveBeenCalledWith(1);
  });
});
