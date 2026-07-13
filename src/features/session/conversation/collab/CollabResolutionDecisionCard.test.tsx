// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CollabResolutionDecisionCard from "@/features/session/conversation/collab/CollabResolutionDecisionCard";

const BASE_PROPS = {
  agent: "claude" as const,
  agreement_reached: false,
  accepted_points: [],
  resolved_disagreements: [],
  remaining_disagreements: [],
  user_questions: [],
  rationale: "rationale",
};

describe("CollabResolutionDecisionCard", () => {
  it("hides the trajectory sparkline when fewer than two data points are available", () => {
    const { container } = render(
      <CollabResolutionDecisionCard
        {...BASE_PROPS}
        defaultOpen
        round={1}
        next_action="continue_negotiation"
        trajectory={[3]}
      />,
    );

    expect(
      container.querySelector('[aria-label^="Disagreement trajectory"]'),
    ).toBeNull();
    expect(container.querySelector('svg[role="img"]')).toBeNull();
  });

  it("renders the trajectory sparkline once at least two data points exist (R2+)", () => {
    const { container } = render(
      <CollabResolutionDecisionCard
        {...BASE_PROPS}
        defaultOpen
        round={2}
        next_action="ask_user"
        trajectory={[3, 1]}
      />,
    );

    const sparkline = container.querySelector('svg[role="img"]');
    expect(sparkline).not.toBeNull();
    expect(sparkline?.querySelector("path")).not.toBeNull();
    expect(sparkline?.querySelector("circle")).not.toBeNull();
  });

  it("drives the verdict accent via data-next-action", () => {
    const { container, rerender } = render(
      <CollabResolutionDecisionCard
        {...BASE_PROPS}
        round={3}
        next_action="final"
        trajectory={[3, 1, 0]}
      />,
    );

    const verdict = container.querySelector("[data-next-action]");
    expect(verdict?.getAttribute("data-next-action")).toBe("final");
    expect(verdict?.textContent ?? "").toContain("Converged");

    rerender(
      <CollabResolutionDecisionCard
        {...BASE_PROPS}
        round={3}
        next_action="fail"
        trajectory={[4, 4, 3]}
      />,
    );

    const failed = container.querySelector("[data-next-action]");
    expect(failed?.getAttribute("data-next-action")).toBe("fail");
    expect(failed?.textContent ?? "").toContain("Failed");
  });

  it("renders the rationale narrative through the compact canonical adapter", async () => {
    const { container } = render(
      <CollabResolutionDecisionCard
        {...BASE_PROPS}
        defaultOpen
        round={1}
        next_action="continue_negotiation"
        trajectory={[3]}
        rationale="Resolved via ~~old~~ **new** consensus."
      />,
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-markdown-intent="compact"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByText("new").tagName).toBe("STRONG");
    expect(container.querySelector(".collab-markdown-text")).toBeNull();
  });
});
