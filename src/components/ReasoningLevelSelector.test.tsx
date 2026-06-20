// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ReasoningLevelSelector from "./ReasoningLevelSelector";

describe("ReasoningLevelSelector", () => {
  const defaultProps = { onChange: vi.fn() };

  describe("rainbow styling", () => {
    it("applies rainbow-border class when value is 'max'", () => {
      render(
        <ReasoningLevelSelector
          {...defaultProps}
          value="max"
          availableLevels={["low", "medium", "high", "max"]}
        />,
      );
      const trigger = document.querySelector(
        '[data-testid="effort-selector-trigger"]',
      );
      expect(trigger?.hasAttribute("data-rainbow")).toBe(true);
    });

    it("applies rainbow-border class when value is 'xhigh'", () => {
      render(
        <ReasoningLevelSelector
          {...defaultProps}
          value="xhigh"
          availableLevels={["low", "medium", "high", "xhigh"]}
        />,
      );
      const trigger = document.querySelector(
        '[data-testid="effort-selector-trigger"]',
      );
      expect(trigger?.hasAttribute("data-rainbow")).toBe(true);
    });

    it("does not apply rainbow-border class for non-max levels", () => {
      render(
        <ReasoningLevelSelector
          {...defaultProps}
          value="high"
          availableLevels={["low", "medium", "high", "max"]}
        />,
      );
      const trigger = document.querySelector(
        '[data-testid="effort-selector-trigger"]',
      );
      expect(trigger?.hasAttribute("data-rainbow")).toBe(false);
    });
  });

  it("renders a disabled unavailable state when no effort levels exist", () => {
    expect(() =>
      render(
        <ReasoningLevelSelector
          {...defaultProps}
          value="high"
          availableLevels={[]}
          disabled
        />,
      ),
    ).not.toThrow();

    expect(
      screen.getByRole("button", { name: /reasoning level unavailable/i }),
    ).toBeDisabled();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });
});
