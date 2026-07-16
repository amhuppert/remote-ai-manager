// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReasoningLevelSelector from "./ReasoningLevelSelector";

afterEach(cleanup);

describe("ReasoningLevelSelector", () => {
  it("renders a disabled Unavailable state when no levels exist", () => {
    render(
      <ReasoningLevelSelector
        onChange={vi.fn()}
        value="high"
        availableLevels={[]}
        disabled
      />,
    );
    expect(screen.getByTestId("effort-selector-trigger")).toBeDisabled();
    expect(screen.getByTestId("effort-selector-label").textContent).toBe(
      "Unavailable",
    );
  });

  it("filters options to availableLevels and reports selection via onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ReasoningLevelSelector
        onChange={onChange}
        value="high"
        availableLevels={["low", "high"]}
      />,
    );

    await user.click(screen.getByTestId("effort-selector-trigger"));
    const labels = screen
      .getAllByTestId("effort-selector-option")
      .map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.startsWith("Low"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Medium"))).toBe(false);

    const low = screen
      .getAllByTestId("effort-selector-option")
      .find((o) => o.textContent?.startsWith("Low"));
    await user.click(low!);
    expect(onChange).toHaveBeenCalledWith("low");
  });
});
