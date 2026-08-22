// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

describe("ModelSelector", () => {
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

  it("does not present a Claude model as a custom Codex option", async () => {
    const user = userEvent.setup();
    renderSelector(
      <ModelSelector value="opus" backend="codex" onChange={vi.fn()} />,
    );

    expect(screen.getByTestId("model-selector-label")).not.toHaveTextContent(
      "opus",
    );

    await user.click(screen.getByTestId("model-selector-trigger"));
    expect(screen.queryByRole("option", { name: /^opus$/i })).toBeNull();
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
});

describe("ModelSelector with project-scoped options", () => {
  const projectOptions = {
    backend: "cursor" as const,
    models: [
      {
        id: "composer-1",
        label: "composer-1",
        description: "Configured for this project.",
        effortLevels: [],
      },
    ],
    defaultModelId: "composer-1",
    source: "project" as const,
  };

  it("offers only the project's models", async () => {
    const user = userEvent.setup();
    renderSelector(
      <ModelSelector
        value="composer-1"
        backend="cursor"
        onChange={vi.fn()}
        projectOptions={projectOptions}
      />,
    );

    expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
      "composer-1",
    );
    await user.click(screen.getByTestId("model-selector-trigger"));
    expect(screen.getAllByTestId("model-selector-option")).toHaveLength(1);
    expect(screen.queryByRole("option", { name: /composer-2\.5/i })).toBeNull();
  });

  it("shows an explicit invalid-selection state instead of substituting another model", async () => {
    // The configured value is outside the project's list. Rendering the first
    // permitted model as if it were selected would tell the operator a model
    // is in use that the API is about to refuse.
    const user = userEvent.setup();
    renderSelector(
      <ModelSelector
        value="composer-2.5"
        backend="cursor"
        onChange={vi.fn()}
        projectOptions={projectOptions}
      />,
    );

    const trigger = screen.getByTestId("model-selector-trigger");
    expect(trigger).toHaveAttribute("data-invalid-selection", "true");
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("model-selector-label")).not.toHaveTextContent(
      "composer-1",
    );
    expect(trigger.getAttribute("title")).toContain("composer-2.5");

    await user.click(trigger);
    expect(screen.getAllByTestId("model-selector-option")).toHaveLength(1);
  });

  it("requires an explicit choice when the project permits nothing", () => {
    renderSelector(
      <ModelSelector
        value="composer-2.5"
        backend="cursor"
        onChange={vi.fn()}
        projectOptions={{ ...projectOptions, models: [], defaultModelId: null }}
      />,
    );

    const trigger = screen.getByTestId("model-selector-trigger");
    expect(trigger).toHaveAttribute("data-invalid-selection", "true");
    expect(trigger).toBeDisabled();
  });

  it("falls back to the catalog when the project's options are unknown", () => {
    renderSelector(
      <ModelSelector value="sonnet" backend="claude" onChange={vi.fn()} />,
    );

    expect(screen.getByTestId("model-selector-trigger")).not.toHaveAttribute(
      "data-invalid-selection",
    );
  });
});
