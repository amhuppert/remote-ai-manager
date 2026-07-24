// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import { CompactionSection } from "./CompactionSection";
import { makeController } from "./test-controller";

function pillIn(fieldPath: string, text: string): HTMLButtonElement {
  const field = document.querySelector(`[data-field="${fieldPath}"]`)!;
  const btn = [...field.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  if (!btn) throw new Error(`no "${text}" pill in ${fieldPath}`);
  return btn as HTMLButtonElement;
}

describe("CompactionSection", () => {
  it("renders the Conversation compaction heading with backend, both models and effort", () => {
    const { controller } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />);

    expect(
      screen.getByRole("heading", { name: /Conversation compaction/i }),
    ).toBeVisible();
    expect(screen.getByText("Conversation model")).toBeVisible();
    expect(screen.getByText("Message model")).toBeVisible();
    expect(screen.getByText("Effort")).toBeVisible();
  });

  it("defaults to the claude sonnet models when config has no compaction block", () => {
    const { controller } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />);

    // The claude model pills are present (sonnet is the compaction default).
    expect(pillIn("compaction.conversationModel", "Sonnet")).toBeTruthy();
    expect(pillIn("compaction.messageModel", "Sonnet")).toBeTruthy();
  });

  it("switching to the codex backend sets codex models and clears effort", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />);

    fireEvent.click(pillIn("compaction.backend", "codex"));

    const state = getState();
    expect(state.compaction?.backend).toBe("codex");
    expect(state.compaction?.conversationModel).toBe("gpt-5.4");
    expect(state.compaction?.messageModel).toBe("gpt-5.4");
    expect(state.compaction?.effort).toBeUndefined();
  });

  it("selecting a conversation model updates only that field", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />);

    fireEvent.click(pillIn("compaction.conversationModel", "Opus 5"));

    expect(getState().compaction?.conversationModel).toBe("opus");
    // Message model is untouched (defaults to sonnet, not yet materialized).
    expect(getState().compaction?.messageModel).toBeUndefined();
  });

  it("selecting an effort updates compaction.effort", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />);

    fireEvent.click(pillIn("compaction.effort", "high"));

    expect(getState().compaction?.effort).toBe("high");
  });

  it("renders a timeout field that stores entered minutes as milliseconds", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<CompactionSection controller={controller} />);

    expect(screen.getByText("Timeout")).toBeVisible();
    const input = document.querySelector(
      '[data-field="compaction.timeoutMs"] input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });

    expect(getState().compaction?.timeoutMs).toBe(300_000);
  });

  it("clearing the timeout stores null (no timeout applied)", () => {
    const { controller, getState } = makeController({
      compaction: {
        backend: "claude",
        conversationModel: "sonnet",
        messageModel: "sonnet",
        effort: "medium",
        timeoutMs: 300_000,
      },
    });
    renderWithQuery(<CompactionSection controller={controller} />);

    const input = document.querySelector(
      '[data-field="compaction.timeoutMs"] input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });

    expect(getState().compaction?.timeoutMs).toBeNull();
  });
});
