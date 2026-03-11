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

  it("applies normal color class when percentage < 60", () => {
    const { container } = render(<ContextFillIndicator percentage={42} />);
    const indicator = container.querySelector(".context-fill");
    expect(indicator?.classList.contains("context-fill--normal")).toBe(true);
  });

  it("applies warning color class when percentage is 60-79", () => {
    const { container } = render(<ContextFillIndicator percentage={65} />);
    const indicator = container.querySelector(".context-fill");
    expect(indicator?.classList.contains("context-fill--warning")).toBe(true);
  });

  it("applies danger color class when percentage >= 80", () => {
    const { container } = render(<ContextFillIndicator percentage={85} />);
    const indicator = container.querySelector(".context-fill");
    expect(indicator?.classList.contains("context-fill--danger")).toBe(true);
  });

  it("sets fill bar width to the clamped percentage", () => {
    const { container } = render(<ContextFillIndicator percentage={73} />);
    const fill = container.querySelector(
      ".context-fill__bar-fill",
    ) as HTMLElement;
    expect(fill?.style.width).toBe("73%");
  });

  it("renders 0% width for 0 percentage", () => {
    const { container } = render(<ContextFillIndicator percentage={0} />);
    const fill = container.querySelector(
      ".context-fill__bar-fill",
    ) as HTMLElement;
    expect(fill?.style.width).toBe("0%");
    expect(screen.getByText("0%")).toBeDefined();
  });

  it("renders 100% width for 100 percentage", () => {
    const { container } = render(<ContextFillIndicator percentage={100} />);
    const fill = container.querySelector(
      ".context-fill__bar-fill",
    ) as HTMLElement;
    expect(fill?.style.width).toBe("100%");
    expect(screen.getByText("100%")).toBeDefined();
  });
});
