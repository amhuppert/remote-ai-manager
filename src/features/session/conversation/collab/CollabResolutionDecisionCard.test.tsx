// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import CollabResolutionDecisionCard from "@/features/session/conversation/collab/CollabResolutionDecisionCard";

const BASE_PROPS = {
  agent: "claude" as const,
  agreementReached: false,
  acceptedPoints: [],
  resolvedDisagreements: [],
  remainingDisagreements: [],
  userQuestions: [],
  rationale: "rationale",
};

describe("CollabResolutionDecisionCard", () => {
  it("hides the trajectory sparkline when fewer than two data points are available", () => {
    const { container } = render(
      <CollabResolutionDecisionCard
        {...BASE_PROPS}
        round={1}
        nextAction="continue_negotiation"
        trajectory={[3]}
      />,
    );

    expect(
      container.querySelector(".collab-resolution-decision-card-trajectory"),
    ).toBeNull();
    expect(
      container.querySelector(".collab-resolution-decision-card-sparkline"),
    ).toBeNull();
  });

  it("renders the trajectory sparkline once at least two data points exist (R2+)", () => {
    const { container } = render(
      <CollabResolutionDecisionCard
        {...BASE_PROPS}
        round={2}
        nextAction="ask_user"
        trajectory={[3, 1]}
      />,
    );

    const sparkline = container.querySelector(
      ".collab-resolution-decision-card-sparkline",
    );
    expect(sparkline).not.toBeNull();
    expect(sparkline?.querySelector("path")).not.toBeNull();
    expect(sparkline?.querySelector("circle")).not.toBeNull();
  });

  it("drives the verdict accent via data-next-action", () => {
    const { container, rerender } = render(
      <CollabResolutionDecisionCard
        {...BASE_PROPS}
        round={3}
        nextAction="final"
        trajectory={[3, 1, 0]}
      />,
    );

    const verdict = container.querySelector(".collab-artifact-card-verdict");
    expect(verdict?.getAttribute("data-next-action")).toBe("final");
    expect(verdict?.textContent ?? "").toContain("Converged");

    rerender(
      <CollabResolutionDecisionCard
        {...BASE_PROPS}
        round={3}
        nextAction="fail"
        trajectory={[4, 4, 3]}
      />,
    );

    const failed = container.querySelector(".collab-artifact-card-verdict");
    expect(failed?.getAttribute("data-next-action")).toBe("fail");
    expect(failed?.textContent ?? "").toContain("Failed");
  });
});
