// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ModelSelector, { getModelsForBackend } from "./ModelSelector";

afterEach(cleanup);

describe("getModelsForBackend", () => {
  it("includes the Fable model for the claude backend", () => {
    const ids = getModelsForBackend("claude").map((m) => m.id);
    expect(ids).toContain("fable");
    expect(ids).toEqual(expect.arrayContaining(["opus", "sonnet", "haiku"]));
  });

  it("does not offer Fable for the codex backend", () => {
    const ids = getModelsForBackend("codex").map((m) => m.id);
    expect(ids).not.toContain("fable");
  });
});

describe("ModelSelector", () => {
  it("shows the selected model label + descriptive title in the trigger", () => {
    render(<ModelSelector value="sonnet" onChange={vi.fn()} />);
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
    render(<ModelSelector value="sonnet" onChange={onChange} />);

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
    render(
      <ModelSelector value="gpt-5.4" backend="codex" onChange={vi.fn()} />,
    );

    await user.click(screen.getByTestId("model-selector-trigger"));
    const labels = screen
      .getAllByTestId("model-selector-option")
      .map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.startsWith("GPT-5.5"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Fable"))).toBe(false);
  });

  it("disables the trigger when disabled", () => {
    render(<ModelSelector value="sonnet" disabled onChange={vi.fn()} />);
    expect(screen.getByTestId("model-selector-trigger")).toBeDisabled();
  });
});
