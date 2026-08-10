// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import CollabCollapsibleCard, {
  CollabCardOrchestrationProvider,
} from "./CollabCollapsibleCard";

const baseProps = {
  kind: "draft",
  ariaLabel: "Initial draft",
  header: <span>Initial draft</span>,
};

describe("CollabCollapsibleCard", () => {
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
