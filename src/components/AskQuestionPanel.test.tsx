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

  it("submits a clarifying note through the multiline primary chord", () => {
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
    const note = screen.getByRole("textbox", { name: /your note/i });
    fireEvent.change(note, { target: { value: "gate behind a flag" } });
    fireEvent.keyDown(note, { key: "Enter", ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledOnce();
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

  it("preserves the submit chord in the Other single-line field", () => {
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
    fireEvent.click(screen.getByText(/something else/i));
    const input = screen.getByPlaceholderText(/type your own answer/i);
    fireEvent.change(input, { target: { value: "Use Postgres" } });

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledOnce();
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

describe("AskQuestionPanel context disclosure (canonical Markdown)", () => {
  // GFM constructs (strikethrough, links, tables) plus raw HTML — none of which
  // the removed markdown-lite parser could produce or neutralize.
  const RICH_CONTEXT = [
    "Uses ~~legacy~~ **canonical** rendering. See [the design](https://example.com/design).",
    "",
    "| Store | TTL |",
    "| --- | --- |",
    "| Redis | yes |",
    "",
    '<button data-injected onclick="alert(1)">danger</button>',
  ].join("\n");

  function compactRoot(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-markdown-intent="compact"]',
    );
  }

  function renderWithContext(context = RICH_CONTEXT) {
    return render(
      <AskQuestionPanel
        questions={[makeQuestion({ context })]}
        questionId="batch-1"
        currentIndex={0}
        onNavigate={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
  }

  it("renders the context through the compact canonical adapter with full GFM", async () => {
    const { container } = renderWithContext();

    await waitFor(() => expect(compactRoot(container)).not.toBeNull());

    // Strikethrough, bold, and safe links — GFM the markdown-lite parser lacked.
    expect(screen.getByText("legacy").tagName).toBe("DEL");
    expect(screen.getByText("canonical").tagName).toBe("STRONG");
    const link = screen.getByRole("link", { name: "the design" });
    expect(link).toHaveAttribute("href", "https://example.com/design");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));

    // A GFM table renders as a real, accessible table.
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Store" }),
    ).toBeInTheDocument();
  });

  it("displays raw HTML in the context as text and never executes it", async () => {
    const { container } = renderWithContext();
    await waitFor(() => expect(compactRoot(container)).not.toBeNull());

    expect(container.querySelector("button[data-injected]")).toBeNull();
    expect(compactRoot(container)?.textContent).toContain(
      "<button data-injected",
    );
  });

  it("keeps the disclosure host-owned: toggling hides then re-reveals the canonical body", async () => {
    const { container } = renderWithContext();
    const toggle = screen.getByRole("button", { name: /context/i });

    // Open by default.
    await waitFor(() => expect(compactRoot(container)).not.toBeNull());
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(compactRoot(container)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(compactRoot(container)).not.toBeNull());
  });

  it("preserves option selection and answer serialization when a context is present", () => {
    const onSubmit = vi.fn();
    render(
      <AskQuestionPanel
        questions={[makeQuestion({ context: RICH_CONTEXT })]}
        questionId="batch-1"
        currentIndex={0}
        onNavigate={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByText("SQLite"));
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));

    expect(onSubmit).toHaveBeenCalledWith("batch-1", {
      storage: {
        selected: ["SQLite"],
        note: null,
        skipped: false,
        question: "Which store?",
      },
    });
  });
});
