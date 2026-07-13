// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CollabFinalAnswerMessage from "@/features/session/conversation/collab/CollabFinalAnswerMessage";
import { makeFinalAnswer } from "@/lib/workflows/collaboration/test-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

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

    // The canonical adapter is lazy-loaded — cold-load of the deferred chunk
    // can exceed the default timeout under parallel test-suite load.
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

  it("renders the final answer through the canonical message adapter", async () => {
    const finalAnswer = makeFinalAnswer({ summary: "Canonical **body**." });
    const { container } = render(
      <CollabFinalAnswerMessage
        agent="claude"
        summary={finalAnswer.summary}
        artifacts={finalAnswer.artifacts}
        answer_artifact_id={finalAnswer.answer_artifact_id}
      />,
    );

    await waitFor(
      () => {
        expect(
          container.querySelector('[data-markdown-intent="message"]'),
        ).not.toBeNull();
      },
      { timeout: 15000 },
    );
    const strong = await screen.findByText("body", undefined, {
      timeout: 15000,
    });
    expect(strong.tagName).toBe("STRONG");
  }, 30000);

  it("prefers the fetched artifact body, falling back to the summary with failure copy when the fetch fails", async () => {
    const finalAnswer = makeFinalAnswer({
      summary: "Manifest summary fallback.",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("Full artifact body loaded."),
      })
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <CollabFinalAnswerMessage
        agent="claude"
        summary={finalAnswer.summary}
        artifacts={finalAnswer.artifacts}
        answer_artifact_id={finalAnswer.answer_artifact_id}
        artifactFileUrl={() => "/artifacts/answer.md"}
      />,
    );

    // Success: the fetched artifact body replaces the manifest summary.
    expect(
      await screen.findByText(/Full artifact body loaded\./, undefined, {
        timeout: 15000,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Full answer artifact could not be loaded\./),
    ).not.toBeInTheDocument();

    // Failure: falls back to the manifest summary and shows the failure copy.
    rerender(
      <CollabFinalAnswerMessage
        agent="codex"
        summary={finalAnswer.summary}
        artifacts={finalAnswer.artifacts}
        answer_artifact_id={finalAnswer.answer_artifact_id}
        artifactFileUrl={() => "/artifacts/answer-2.md"}
      />,
    );

    expect(
      await screen.findByText(/Manifest summary fallback\./, undefined, {
        timeout: 15000,
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Full answer artifact could not be loaded\./,
        undefined,
        {
          timeout: 15000,
        },
      ),
    ).toBeInTheDocument();
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
