// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import CollabFinalAnswerMessage from "@/features/session/conversation/collab/CollabFinalAnswerMessage";
import { makeFinalAnswer } from "@/lib/workflows/collaboration/test-fixtures";

describe("CollabFinalAnswerMessage", () => {
  it("renders the manifest summary and artifact references", async () => {
    const finalAnswer = makeFinalAnswer({
      summary: "Ship the migration in three phases.",
    });
    render(
      <CollabFinalAnswerMessage
        agent="claude"
        summary={finalAnswer.summary}
        artifacts={finalAnswer.artifacts}
        answer_artifact_id={finalAnswer.answer_artifact_id}
      />,
    );

    // MarkdownContent is loaded via next/dynamic — cold-load of the
    // dynamic chunk can exceed the default timeout under parallel
    // test-suite load.
    expect(
      await screen.findByText(
        /Ship the migration in three phases\./,
        undefined,
        {
          timeout: 15000,
        },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/answer\.md/)).toBeInTheDocument();
  }, 30000);

  it("applies a per-agent left rail via data-agent", () => {
    const finalAnswer = makeFinalAnswer();
    const { container, rerender } = render(
      <CollabFinalAnswerMessage
        agent="claude"
        summary={finalAnswer.summary}
        artifacts={finalAnswer.artifacts}
        answer_artifact_id={finalAnswer.answer_artifact_id}
      />,
    );
    expect(
      container
        .querySelector('[data-kind="final_answer"]')
        ?.getAttribute("data-agent"),
    ).toBe("claude");

    rerender(
      <CollabFinalAnswerMessage
        agent="codex"
        summary={finalAnswer.summary}
        artifacts={finalAnswer.artifacts}
        answer_artifact_id={finalAnswer.answer_artifact_id}
      />,
    );
    expect(
      container
        .querySelector('[data-kind="final_answer"]')
        ?.getAttribute("data-agent"),
    ).toBe("codex");
  });
});
