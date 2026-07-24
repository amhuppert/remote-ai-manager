// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { getModelsForBackend } from "@/lib/agent-backends/catalog";
import ModelSelector from "./ModelSelector";

afterEach(cleanup);

function renderSelector(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("getModelsForBackend (catalog)", () => {
  it("includes the Fable model for the claude backend", () => {
    const ids = getModelsForBackend("claude").map((m) => m.id);
    expect(ids).toContain("fable");
    expect(ids).toEqual(expect.arrayContaining(["opus", "sonnet", "haiku"]));
  });

  it("does not offer Fable for the codex backend", () => {
    const ids = getModelsForBackend("codex").map((m) => m.id);
    expect(ids).not.toContain("fable");
  });

  it("offers the GPT-5.6 Sol, Terra, and Luna models for the codex backend", () => {
    const ids = getModelsForBackend("codex").map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
    );
  });
});

describe("ModelSelector", () => {
  it("identifies the opus alias as Opus 5", () => {
    renderSelector(
      <ModelSelector value="opus" backend="claude" onChange={vi.fn()} />,
    );

    expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
      "Opus 5",
    );
    expect(screen.getByTestId("model-selector-trigger")).toHaveAttribute(
      "title",
      expect.stringContaining("Opus 5"),
    );
  });

  it("shows the selected model label + descriptive title in the trigger", () => {
    renderSelector(
      <ModelSelector value="sonnet" backend="claude" onChange={vi.fn()} />,
    );
    expect(screen.getByTestId("model-selector-label").textContent).toBe(
      "Sonnet",
    );
    expect(
      screen.getByTestId("model-selector-trigger").getAttribute("title"),
    ).toContain("Sonnet");
  });

  it("opens the listbox and reports the chosen model via onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSelector(
      <ModelSelector value="sonnet" backend="claude" onChange={onChange} />,
    );

    await user.click(screen.getByTestId("model-selector-trigger"));
    const haiku = screen
      .getAllByTestId("model-selector-option")
      .find((o) => o.textContent?.startsWith("Haiku"));
    expect(haiku).toBeTruthy();
    await user.click(haiku!);

    expect(onChange).toHaveBeenCalledWith("haiku");
  });

  it("offers backend-specific options (codex has no Fable)", async () => {
    const user = userEvent.setup();
    renderSelector(
      <ModelSelector value="gpt-5.4" backend="codex" onChange={vi.fn()} />,
    );

    await user.click(screen.getByTestId("model-selector-trigger"));
    const labels = screen
      .getAllByTestId("model-selector-option")
      .map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.startsWith("GPT-5.5"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Fable"))).toBe(false);
  });

  it("shows a configured custom Codex model as the selected option", async () => {
    const user = userEvent.setup();
    renderSelector(
      <ModelSelector
        value="custom-codex-model"
        backend="codex"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
      "custom-codex-model",
    );
    expect(screen.getByTestId("model-selector-trigger")).toHaveAttribute(
      "title",
      expect.stringContaining("custom-codex-model"),
    );

    await user.click(screen.getByTestId("model-selector-trigger"));
    expect(
      screen.getByRole("option", { name: /custom-codex-model/i }),
    ).toHaveAttribute("data-state", "checked");
  });

  it("does not add an unknown Claude model to the catalog options", async () => {
    const user = userEvent.setup();
    renderSelector(
      <ModelSelector
        value="custom-claude-model"
        backend="claude"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("model-selector-label")).not.toHaveTextContent(
      "custom-claude-model",
    );
    await user.click(screen.getByTestId("model-selector-trigger"));
    expect(
      screen.queryByRole("option", { name: /custom-claude-model/i }),
    ).not.toBeInTheDocument();
  });

  it("fails loudly for an unknown backend id instead of coercing to Claude", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      renderSelector(
        <ModelSelector
          value="sonnet"
          backend={"mystery" as AgentBackendId}
          onChange={vi.fn()}
        />,
      ),
    ).toThrow(/unknown agent backend/i);
    spy.mockRestore();
  });

  it("disables the trigger when disabled", () => {
    renderSelector(
      <ModelSelector
        value="sonnet"
        backend="claude"
        disabled
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("model-selector-trigger")).toBeDisabled();
  });
});
