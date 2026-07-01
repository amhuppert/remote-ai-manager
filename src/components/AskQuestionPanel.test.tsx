// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

  it("shows a pending state on the submit control while an async submit is in flight", async () => {
    let resolveSubmit: () => void = () => {};
    const onSubmit = vi.fn(
      () => new Promise<void>((resolve) => (resolveSubmit = resolve)),
    );
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
    fireEvent.click(submitButton());

    // In flight: visible progress + disabled control; re-clicks don't resubmit.
    expect(screen.getByText(/sending/i)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);

    resolveSubmit();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    expect(screen.queryByText(/sending/i)).toBeNull();
  });

  it("lets Space type into the Other free-text field instead of toggling the option", () => {
    render(
      <AskQuestionPanel
        questions={[makeQuestion()]}
        questionId="batch-1"
        currentIndex={0}
        onNavigate={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    // Reveal the free-text input by picking "Something else…".
    fireEvent.click(screen.getByText(/something else/i));
    const input = screen.getByPlaceholderText(/type your own answer/i);

    // Space must reach the input as text: not cancelled, and the option
    // (hence the input) must stay selected rather than toggling off.
    const notCancelled = fireEvent.keyDown(input, { key: " " });
    expect(notCancelled).toBe(true);
    expect(
      screen.queryByPlaceholderText(/type your own answer/i),
    ).not.toBeNull();
  });

  it("does not minimize on Escape while a text field is focused", () => {
    render(
      <AskQuestionPanel
        questions={[makeQuestion()]}
        questionId="batch-1"
        currentIndex={0}
        onNavigate={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("SQLite"));
    fireEvent.click(screen.getByText(/add a note/i));
    const note = screen.getByPlaceholderText(/go with sqlite/i);

    fireEvent.keyDown(note, { key: "Escape" });

    // Still maximized — the question is visible and no banner appeared.
    expect(screen.queryAllByText("Which store?").length).toBeGreaterThan(0);
    expect(screen.queryByText("Agent needs your input")).toBeNull();
  });

  it("suppresses selection and navigation hotkeys while a text field is focused", () => {
    const onNavigate = vi.fn();
    render(
      <AskQuestionPanel
        questions={[
          makeQuestion(),
          makeQuestion({ id: "b", question: "Second?" }),
        ]}
        questionId="batch-1"
        currentIndex={0}
        onNavigate={onNavigate}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("SQLite"));
    fireEvent.click(screen.getByText(/add a note/i));
    const note = screen.getByPlaceholderText(/go with sqlite/i);

    fireEvent.keyDown(note, { key: "2" });
    fireEvent.keyDown(note, { key: "j" });
    fireEvent.keyDown(note, { key: "ArrowDown" });

    expect(onNavigate).not.toHaveBeenCalled();
    const redis = screen.getByText("Redis").closest('[role="radio"]');
    expect(redis?.getAttribute("aria-checked")).toBe("false");
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
