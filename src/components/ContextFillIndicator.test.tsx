// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextFillIndicator } from "./ContextFillIndicator";

describe("ContextFillIndicator", () => {
  it("renders the percentage text", () => {
    render(<ContextFillIndicator percentage={42} />);
    expect(screen.getByText("42%")).toBeDefined();
  });

  it("renders the CONTEXT label", () => {
    render(<ContextFillIndicator percentage={42} />);
    expect(screen.getByText("Context")).toBeDefined();
  });

  it("clamps percentage to 0-100 range for display", () => {
    const { rerender } = render(<ContextFillIndicator percentage={-10} />);
    expect(screen.getByText("0%")).toBeDefined();

    rerender(<ContextFillIndicator percentage={150} />);
    expect(screen.getByText("100%")).toBeDefined();
  });

  // The fill bar is the only element carrying an inline width style; color level
  // by threshold is appearance, verified visually in Storybook (AllThresholds).
  it("sets fill bar width to the clamped percentage", () => {
    const { container } = render(<ContextFillIndicator percentage={73} />);
    const fill = container.querySelector("[style]") as HTMLElement;
    expect(fill?.style.width).toBe("73%");
  });

  it("renders 0% width for 0 percentage", () => {
    const { container } = render(<ContextFillIndicator percentage={0} />);
    const fill = container.querySelector("[style]") as HTMLElement;
    expect(fill?.style.width).toBe("0%");
    expect(screen.getByText("0%")).toBeDefined();
  });

  it("renders 100% width for 100 percentage", () => {
    const { container } = render(<ContextFillIndicator percentage={100} />);
    const fill = container.querySelector("[style]") as HTMLElement;
    expect(fill?.style.width).toBe("100%");
    expect(screen.getByText("100%")).toBeDefined();
  });
});
