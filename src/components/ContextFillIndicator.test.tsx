// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextFillIndicator } from "./ContextFillIndicator";

describe("ContextFillIndicator", () => {
  it("shows unknown without inventing a percentage when measurements are missing", () => {
    render(<ContextFillIndicator percentage={null} />);

    expect(screen.getByText("Context unknown")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("clamps and rounds the visible and accessible percentage", () => {
    const { rerender } = render(<ContextFillIndicator percentage={0} />);

    for (const [input, expected] of [
      [-10, 0],
      [42.6, 43],
      [150, 100],
    ] as const) {
      rerender(<ContextFillIndicator percentage={input} />);
      expect(screen.getByText(`${expected}%`)).toBeInTheDocument();
      expect(
        screen.getByRole("progressbar", {
          name: `Context window ${expected}% full`,
        }),
      ).toBeInTheDocument();
    }
  });
});
