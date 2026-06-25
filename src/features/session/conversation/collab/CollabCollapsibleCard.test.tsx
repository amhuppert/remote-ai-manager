// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CollabCollapsibleCard, {
  CollabCardOrchestrationProvider,
} from "./CollabCollapsibleCard";

const baseProps = {
  kind: "draft",
  ariaLabel: "Initial draft",
  header: <span>Initial draft</span>,
};

describe("CollabCollapsibleCard — Radix Collapsible disclosure", () => {
  it("keeps the body out of the DOM while collapsed (default)", () => {
    render(
      <CollabCollapsibleCard {...baseProps}>
        <span data-testid="collab-body">body</span>
      </CollabCollapsibleCard>,
    );
    // A Radix-backed disclosure unmounts the closed region (not merely hidden).
    expect(screen.queryByTestId("collab-body")).toBeNull();
  });

  it("mounts the body when defaultOpen", () => {
    render(
      <CollabCollapsibleCard {...baseProps} defaultOpen>
        <span data-testid="collab-body">body</span>
      </CollabCollapsibleCard>,
    );
    expect(screen.getByTestId("collab-body")).toBeInTheDocument();
  });

  it("wires aria-expanded + aria-controls from the trigger to the region", () => {
    render(
      <CollabCollapsibleCard {...baseProps} defaultOpen>
        <span data-testid="collab-body">body</span>
      </CollabCollapsibleCard>,
    );
    const trigger = screen.getByRole("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const controls = trigger.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)).not.toBeNull();
  });

  it("toggles the region open and closed on click", () => {
    render(
      <CollabCollapsibleCard {...baseProps}>
        <span data-testid="collab-body">body</span>
      </CollabCollapsibleCard>,
    );
    const trigger = screen.getByRole("button");
    expect(screen.queryByTestId("collab-body")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByTestId("collab-body")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId("collab-body")).toBeNull();
  });

  it("forces open via the orchestration context", () => {
    render(
      <CollabCardOrchestrationProvider forceState="open" tick={1}>
        <CollabCollapsibleCard {...baseProps}>
          <span data-testid="collab-body">body</span>
        </CollabCollapsibleCard>
      </CollabCardOrchestrationProvider>,
    );
    expect(screen.getByTestId("collab-body")).toBeInTheDocument();
  });
});
