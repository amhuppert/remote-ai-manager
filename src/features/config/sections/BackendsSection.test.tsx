// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
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
      screen.getByText("Defaults used to initialize new Codex conversations."),
    ).toBeVisible();
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
      screen.getByText("Codex fast mode").closest("[data-field]"),
    ).toHaveAttribute("data-field", "agentBackends.codex.fastMode");
    expect(
      screen.getByRole("switch", { name: "Codex fast mode" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByText("Codex timeout").closest("[data-field]"),
    ).toHaveAttribute("data-field", "agentBackends.codex.timeoutMs");
    expect(screen.queryByText("Enable Codex")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/SDK is bundled and ready/),
    ).not.toBeInTheDocument();
  });

  it("renders a profile subsection for every registered backend", () => {
    const { controller } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    for (const entry of listBackendCatalogEntries()) {
      expect(
        screen.getByText(`${entry.label} model`).closest("[data-field]"),
      ).toHaveAttribute("data-field", `agentBackends.${entry.id}.model`);
      expect(
        screen.getByText(`${entry.label} timeout`).closest("[data-field]"),
      ).toHaveAttribute("data-field", `agentBackends.${entry.id}.timeoutMs`);
    }
  });

  it("gives the Cursor profile a model and a timeout only", () => {
    const { controller } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    expect(screen.getByText("Cursor model")).toBeVisible();
    expect(screen.getByText("Cursor timeout")).toBeVisible();
    // Composer takes no reasoning effort and Cursor has no fast mode; the
    // catalog says so, so neither field is rendered.
    expect(screen.queryByText("Cursor effort")).not.toBeInTheDocument();
    expect(screen.queryByText("Cursor fast mode")).not.toBeInTheDocument();
  });

  // The Cursor credential is read from the server environment and is never a
  // settings field — a rendered input would invite an operator to paste a
  // secret into a document Command Center persists (spec R12.2).
  it("renders no credential field for any backend", () => {
    const { controller } = makeController();
    const { container } = renderWithQuery(
      <BackendsSection controller={controller} />,
    );

    expect(
      screen.queryByText(/api key|apikey|credential|token|secret/i),
    ).not.toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('[data-field*="apiKey" i]')).toBeNull();
  });

  it("stores a Cursor timeout edit in the Cursor profile path", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    const cursorInput = document.querySelector(
      '[data-field="agentBackends.cursor.timeoutMs"] input',
    );
    if (!(cursorInput instanceof HTMLInputElement)) {
      throw new Error("no agentBackends.cursor.timeoutMs input");
    }
    fireEvent.change(cursorInput, { target: { value: "30" } });

    expect(getState().agentBackends.cursor.timeoutMs).toBe(1_800_000);
    expect(getState().agentBackends.claude.timeoutMs).toBe(3_600_000);
  });

  it("renders the catalog model labels while preserving alias values", () => {
    const { controller, getState } = makeController();
    renderWithQuery(<BackendsSection controller={controller} />);

    const opus5 = screen.getByRole("button", { name: "Opus 5" });
    expect(opus5).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Sonnet" }));

    expect(getState().agentBackends.claude.model).toBe("sonnet");
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
      (button) => button.textContent === "Sonnet",
    )!;
    fireEvent.click(sonnetButton);

    const codexField = screen
      .getByText("Codex model")
      .closest('[data-field="agentBackends.codex.model"]')!;
    const miniButton = [...codexField.querySelectorAll("button")].find(
      (button) => button.textContent === "GPT-5.4 Mini",
    )!;
    fireEvent.click(miniButton);

    expect(getState().agentBackends.claude.model).toBe("sonnet");
    expect(getState().agentBackends.codex.model).toBe("gpt-5.4-mini");
  });

  it("stores the Codex fast mode default in the Codex backend profile", () => {
    const { controller, getState } = makeController();
    const view = renderWithQuery(<BackendsSection controller={controller} />);

    fireEvent.click(screen.getByRole("switch", { name: "Codex fast mode" }));

    expect(getState().agentBackends.codex.fastMode).toBe(true);
    view.unmount();
    renderWithQuery(<BackendsSection controller={controller} />);
    expect(
      screen.getByRole("switch", { name: "Codex fast mode" }),
    ).toHaveAttribute("aria-checked", "true");
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
          fastMode: false,
          model: "custom-codex-model",
          reasoningEffort: "ultra",
          timeoutMs: null,
        },
        cursor: { model: "composer-2.5", timeoutMs: null },
      },
    });
    renderWithQuery(<BackendsSection controller={controller} />);

    const customModel = screen.getByRole("button", {
      name: "custom-codex-model",
    });
    expect(customModel).toHaveAttribute("aria-pressed", "true");
    expect(getState().agentBackends.codex.model).toBe("custom-codex-model");
  });

  it("selects Spark and keeps its effort field, which it supports", () => {
    const { controller, getState } = makeController();
    const view = renderWithQuery(<BackendsSection controller={controller} />);

    const codexField = screen
      .getByText("Codex model")
      .closest('[data-field="agentBackends.codex.model"]')!;
    const sparkButton = [...codexField.querySelectorAll("button")].find(
      (button) => button.textContent === "GPT-5.3 Codex Spark",
    )!;
    fireEvent.click(sparkButton);
    view.unmount();
    renderWithQuery(<BackendsSection controller={controller} />);

    expect(getState().agentBackends.codex.model).toBe("gpt-5.3-codex-spark");
    expect(screen.getByText("Codex effort")).toBeVisible();
  });

  it("omits Claude effort for Haiku and restores high for an effort-capable model", () => {
    const { controller, getState } = makeController();
    const view = renderWithQuery(<BackendsSection controller={controller} />);

    const claudeField = screen
      .getByText("Claude model")
      .closest('[data-field="agentBackends.claude.model"]')!;
    const haikuButton = [...claudeField.querySelectorAll("button")].find(
      (button) => button.textContent === "Haiku",
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
    ].find((button) => button.textContent === "Sonnet")!;
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
          fastMode: false,
          model: "gpt-5.4",
          reasoningEffort: "high",
          timeoutMs: null,
        },
        cursor: { model: "composer-2.5", timeoutMs: null },
      },
    });
    renderWithQuery(<BackendsSection controller={controller} />);

    const claudeField = screen
      .getByText("Claude model")
      .closest('[data-field="agentBackends.claude.model"]')!;
    fireEvent.click(
      [...claudeField.querySelectorAll("button")].find(
        (button) => button.textContent === "Sonnet",
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
