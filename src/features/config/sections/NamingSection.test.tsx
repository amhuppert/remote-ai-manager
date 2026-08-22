// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import { NamingSection } from "./NamingSection";
import { makeController } from "./test-controller";

function pillIn(fieldPath: string, text: string): HTMLButtonElement {
  const field = document.querySelector(`[data-field="${fieldPath}"]`);
  if (!(field instanceof HTMLElement)) {
    throw new Error(`no field ${fieldPath}`);
  }
  const btn = [...field.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  if (!btn) throw new Error(`no "${text}" pill in ${fieldPath}`);
  return btn;
}

function timeoutInput(): HTMLInputElement {
  const input = document.querySelector(
    '[data-field="conversationNaming.timeoutMs"] input',
  );
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("no conversationNaming.timeoutMs input");
  }
  return input;
}

describe("NamingSection", () => {
  it("renders the Conversation naming heading with enabled, backend and model", () => {
    const { controller } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    expect(
      screen.getByRole("heading", { name: /Conversation naming/i }),
    ).toBeVisible();
    expect(screen.getByText("Backend")).toBeVisible();
    expect(screen.getByText("Model")).toBeVisible();
    expect(screen.getByText("Timeout")).toBeVisible();
  });

  // Naming is a one-shot task run, so its backend must register a task facet.
  // The option stays visible and explains itself rather than being hidden or
  // silently accepted and failing at generation time (spec R15.1).
  it("refuses a backend with no task facet and keeps the configured one", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    const cursor = pillIn("conversationNaming.backend", "cursor");
    expect(cursor.getAttribute("aria-disabled")).toBe("true");
    expect(cursor.getAttribute("title")).toContain("task");

    fireEvent.click(cursor);
    expect(getState().conversationNaming?.backend).toBeUndefined();

    fireEvent.click(pillIn("conversationNaming.backend", "codex"));
    expect(getState().conversationNaming?.backend).toBe("codex");
  });

  it("defaults to the claude haiku model when config has no naming block", () => {
    const { controller } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    expect(pillIn("conversationNaming.model", "Haiku")).toBeTruthy();
  });

  it("hides the effort field when the model has no effort levels (haiku)", () => {
    const { controller } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    expect(
      document.querySelector('[data-field="conversationNaming.effort"]'),
    ).toBeNull();
  });

  it("shows effort pills when the selected model supports effort levels", () => {
    const { controller, getState } = makeController({
      conversationNaming: {
        enabled: true,
        backend: "claude",
        model: "sonnet",
        effort: "low",
      },
    });
    renderWithQuery(<NamingSection controller={controller} />);

    fireEvent.click(pillIn("conversationNaming.effort", "high"));

    expect(getState().conversationNaming?.effort).toBe("high");
  });

  it("switching to the codex backend sets the codex default model and clears effort", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    fireEvent.click(pillIn("conversationNaming.backend", "codex"));

    const state = getState();
    expect(state.conversationNaming?.backend).toBe("codex");
    expect(state.conversationNaming?.model).toBe("gpt-5.4");
    expect(state.conversationNaming?.effort).toBeUndefined();
  });

  it("selecting a model updates only that field", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    fireEvent.click(pillIn("conversationNaming.model", "Sonnet"));

    expect(getState().conversationNaming?.model).toBe("sonnet");
    expect(getState().conversationNaming?.backend).toBeUndefined();
  });

  it("toggling enabled writes conversationNaming.enabled", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    fireEvent.click(screen.getByRole("switch", { name: /automatic naming/i }));

    expect(getState().conversationNaming?.enabled).toBe(false);
  });

  it("renders a timeout field that stores entered minutes as milliseconds", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<NamingSection controller={controller} />);

    fireEvent.change(timeoutInput(), { target: { value: "5" } });

    expect(getState().conversationNaming?.timeoutMs).toBe(300_000);
  });

  it("clearing the timeout stores null (service falls back to the 1 minute default)", () => {
    const { controller, getState } = makeController({
      conversationNaming: {
        enabled: true,
        backend: "claude",
        model: "haiku",
        effort: "low",
        timeoutMs: 300_000,
      },
    });
    renderWithQuery(<NamingSection controller={controller} />);

    fireEvent.change(timeoutInput(), { target: { value: "" } });

    expect(getState().conversationNaming?.timeoutMs).toBeNull();
  });
});
