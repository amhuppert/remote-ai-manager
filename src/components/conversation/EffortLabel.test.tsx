// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EffortLabel } from "./EffortLabel";

describe("EffortLabel", () => {
  it("renders the effort text", () => {
    render(<EffortLabel effort="high" />);
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it.each(["max", "xhigh"])(
    "applies the rainbow treatment to the %s tier",
    (effort) => {
      render(<EffortLabel effort={effort} />);
      expect(screen.getByText(effort)).toHaveClass("cc-rainbow-text");
    },
  );

  it.each(["minimal", "low", "medium", "high"])(
    "renders the %s tier as plain secondary text (no rainbow)",
    (effort) => {
      render(<EffortLabel effort={effort} />);
      const el = screen.getByText(effort);
      expect(el).not.toHaveClass("cc-rainbow-text");
      expect(el).toHaveClass("text-text-secondary");
    },
  );

  it("appends layoutClassName after the tone class", () => {
    render(<EffortLabel effort="max" layoutClassName="ml-sm" />);
    expect(screen.getByText("max")).toHaveClass("cc-rainbow-text", "ml-sm");
  });
});
