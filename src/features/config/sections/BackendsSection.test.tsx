// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import { BackendsSection } from "./BackendsSection";
import { makeController } from "./test-controller";

describe("BackendsSection", () => {
  it("renders the default backend selector and both configurable backend profiles", () => {
    const { controller } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    expect(
      screen.getByRole("heading", { name: /Agent backends/i }),
    ).toBeVisible();
    expect(screen.getByText(/^Default backend$/)).toBeVisible();
    expect(screen.getByText(/^Claude$/)).toBeVisible();
    expect(screen.getByText(/^Codex$/)).toBeVisible();
    expect(
      screen.getByText("Claude model").closest("[data-field]"),
    ).toHaveAttribute("data-field", "agentBackends.claude.model");
    expect(
      screen.getByText("Claude effort").closest("[data-field]"),
    ).toHaveAttribute("data-field", "agentBackends.claude.reasoningEffort");
    expect(
      screen.getByText("Claude timeout").closest("[data-field]"),
    ).toHaveAttribute("data-field", "agentBackends.claude.timeoutMs");
    expect(
      screen.getByText("Codex model").closest("[data-field]"),
    ).toHaveAttribute("data-field", "agentBackends.codex.model");
    expect(
      screen.getByText("Codex effort").closest("[data-field]"),
    ).toHaveAttribute("data-field", "agentBackends.codex.reasoningEffort");
    expect(
      screen.getByText("Codex timeout").closest("[data-field]"),
    ).toHaveAttribute("data-field", "agentBackends.codex.timeoutMs");
    expect(screen.queryByText("Enable Codex")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/SDK is bundled and ready/),
    ).not.toBeInTheDocument();
  });

  it("switches only the default backend and preserves both backend profiles", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    const before = structuredClone(getState().agentBackends);
    const backendField = screen
      .getByText("Backend")
      .closest('[data-field="defaultAgentBackend"]')!;
    const codexButton = [...backendField.querySelectorAll("button")].find(
      (button) => button.textContent === "codex",
    )!;
    fireEvent.click(codexButton);

    expect(getState().defaultAgentBackend).toBe("codex");
    expect(getState().agentBackends).toEqual(before);
  });

  it("stores backend model edits in their independent normalized paths", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    const claudeField = screen
      .getByText("Claude model")
      .closest('[data-field="agentBackends.claude.model"]')!;
    const sonnetButton = [...claudeField.querySelectorAll("button")].find(
      (button) => button.textContent === "sonnet",
    )!;
    fireEvent.click(sonnetButton);

    const codexField = screen
      .getByText("Codex model")
      .closest('[data-field="agentBackends.codex.model"]')!;
    const miniButton = [...codexField.querySelectorAll("button")].find(
      (button) => button.textContent === "gpt-5.4-mini",
    )!;
    fireEvent.click(miniButton);

    expect(getState().agentBackends.claude.model).toBe("sonnet");
    expect(getState().agentBackends.codex.model).toBe("gpt-5.4-mini");
  });

  it("keeps a configured custom Codex model visible and selected", () => {
    const { controller, getState } = makeController({
      agentBackends: {
        claude: {
          model: "opus",
          reasoningEffort: "high",
          timeoutMs: 3_600_000,
        },
        codex: {
          model: "custom-codex-model",
          reasoningEffort: "ultra",
          timeoutMs: null,
        },
      },
    });
    renderWithQuery(<BackendsSection controller={controller} />);

    const customModel = screen.getByRole("button", {
      name: "custom-codex-model",
    });
    expect(customModel).toHaveAttribute("aria-pressed", "true");
    expect(getState().agentBackends.codex.model).toBe("custom-codex-model");
  });

  it("omits Claude effort for Haiku and restores high for an effort-capable model", () => {
    const { controller, getState } = makeController();
    const view = renderWithQuery(<BackendsSection controller={controller} />);

    const claudeField = screen
      .getByText("Claude model")
      .closest('[data-field="agentBackends.claude.model"]')!;
    const haikuButton = [...claudeField.querySelectorAll("button")].find(
      (button) => button.textContent === "haiku",
    )!;
    fireEvent.click(haikuButton);
    view.unmount();
    const haikuView = renderWithQuery(
      <BackendsSection controller={controller} />,
    );

    expect(getState().agentBackends.claude).toEqual({
      model: "haiku",
      reasoningEffort: undefined,
      timeoutMs: 3_600_000,
    });
    expect(screen.queryByText("Claude effort")).not.toBeInTheDocument();

    const rerenderedModelField = screen
      .getByText("Claude model")
      .closest('[data-field="agentBackends.claude.model"]')!;
    const sonnetButton = [
      ...rerenderedModelField.querySelectorAll("button"),
    ].find((button) => button.textContent === "sonnet")!;
    fireEvent.click(sonnetButton);
    haikuView.unmount();
    renderWithQuery(<BackendsSection controller={controller} />);

    expect(getState().agentBackends.claude.reasoningEffort).toBe("high");
    expect(screen.getByText("Claude effort")).toBeVisible();
  });

  it("clamps an unsupported effort to high when the model changes", () => {
    const { controller, getState } = makeController({
      agentBackends: {
        claude: {
          model: "opus",
          reasoningEffort: "max",
          timeoutMs: 3_600_000,
        },
        codex: {
          model: "gpt-5.4",
          reasoningEffort: "high",
          timeoutMs: null,
        },
      },
    });
    renderWithQuery(<BackendsSection controller={controller} />);

    const claudeField = screen
      .getByText("Claude model")
      .closest('[data-field="agentBackends.claude.model"]')!;
    fireEvent.click(
      [...claudeField.querySelectorAll("button")].find(
        (button) => button.textContent === "sonnet",
      )!,
    );

    expect(getState().agentBackends.claude).toEqual({
      model: "sonnet",
      reasoningEffort: "high",
      timeoutMs: 3_600_000,
    });
  });

  it("uses nullable minute inputs for each backend timeout", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    const claudeInput = screen
      .getByText("Claude timeout")
      .closest('[data-field="agentBackends.claude.timeoutMs"]')!
      .querySelector("input")!;
    const codexInput = screen
      .getByText("Codex timeout")
      .closest('[data-field="agentBackends.codex.timeoutMs"]')!
      .querySelector("input")!;

    fireEvent.change(claudeInput, { target: { value: "" } });
    fireEvent.change(codexInput, { target: { value: "45" } });

    expect(getState().agentBackends.claude.timeoutMs).toBeNull();
    expect(getState().agentBackends.codex.timeoutMs).toBe(2_700_000);
  });
});
