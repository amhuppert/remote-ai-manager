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
});
