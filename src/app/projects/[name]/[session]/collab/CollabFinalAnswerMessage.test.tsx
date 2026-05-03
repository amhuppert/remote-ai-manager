// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import CollabFinalAnswerMessage from "./CollabFinalAnswerMessage";

describe("CollabFinalAnswerMessage", () => {
  it("renders the answer body", () => {
    render(
      <CollabFinalAnswerMessage
        agent="claude"
        answer="Ship the migration in three phases."
      />,
    );

    expect(
      screen.getByText(/Ship the migration in three phases\./),
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
