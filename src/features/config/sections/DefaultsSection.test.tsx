// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import { DefaultsSection } from "./DefaultsSection";
import { makeController } from "./test-controller";

describe("DefaultsSection", () => {
  it("renders the Agent defaults heading and default backend group", () => {
    const { controller } = makeController();
    renderWithQuery(<DefaultsSection controller={controller} />);
    expect(
      screen.getByRole("heading", { name: /Agent defaults/i }),
    ).toBeVisible();
    expect(screen.getByText(/Default backend/i)).toBeVisible();
    expect(screen.getByText(/Model & reasoning/i)).toBeVisible();
  });

  it("clicking the codex pill switches the backend and clears claude model/effort", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<DefaultsSection controller={controller} />);
    const backendField = screen
      .getByText("Backend")
      .closest('[data-field="defaultAgentBackend"]')!;
    const codexBtn = [...backendField.querySelectorAll("button")].find(
      (b) => b.textContent === "codex",
    )!;
    fireEvent.click(codexBtn);
    const state = getState();
    expect(state.defaultAgentBackend).toBe("codex");
    expect(state.defaultModel).toBeUndefined();
    expect(state.defaultEffort).toBeUndefined();
  });
});
