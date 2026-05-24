// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import CollabFinalAnswerMessage from "@/features/session/conversation/collab/CollabFinalAnswerMessage";

describe("CollabFinalAnswerMessage", () => {
  it("renders the answer body", async () => {
    render(
      <CollabFinalAnswerMessage
        agent="claude"
        answer="Ship the migration in three phases."
      />,
    );

    // MarkdownContent is loaded via next/dynamic — wait for first paint.
    expect(
      await screen.findByText(/Ship the migration in three phases\./),
    ).toBeInTheDocument();
  });

  it("applies a per-agent left rail via data-agent", () => {
    const { container, rerender } = render(
      <CollabFinalAnswerMessage agent="claude" answer="x" />,
    );
    expect(
      container
        .querySelector(".collab-final-answer-message")
        ?.getAttribute("data-agent"),
    ).toBe("claude");

    rerender(<CollabFinalAnswerMessage agent="codex" answer="x" />);
    expect(
      container
        .querySelector(".collab-final-answer-message")
        ?.getAttribute("data-agent"),
    ).toBe("codex");
  });
});
