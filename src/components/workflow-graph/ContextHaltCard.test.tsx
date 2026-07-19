// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
import ContextHaltCard from "./ContextHaltCard";

const joinFailureWithManyConflicts: GraphWorkflowHaltReason = {
  type: "join_failure",
  joinId: "join-final",
  joinKind: "final_publish",
  contextId: null,
  sourceLaneIds: ["lane-a", "lane-b"],
  targetLaneId: "__session__",
  message: "Pre-merge validation failed",
  conflictFiles: Array.from(
    { length: 60 },
    (_, i) => `src/lib/specs/file-${i}.ts`,
  ),
};

describe("ContextHaltCard detail bounding", () => {
  it("renders the detail inside a height-bounded scroll container so long conflict lists cannot grow the card", () => {
    render(<ContextHaltCard primary={joinFailureWithManyConflicts} />);

    const detailRegion = screen.getByTestId("halt-detail");
    // The height bound IS the behavior under test: an unbounded conflict list
    // previously grew the card (and its host) past the viewport.
    expect(detailRegion.className).toContain("max-h-");
    expect(detailRegion.className).toContain("overflow-y-auto");
    expect(detailRegion).toContainElement(
      screen.getByText("src/lib/specs/file-59.ts"),
    );
  });

  it("still shows headline and action outside the scroll region", () => {
    render(<ContextHaltCard primary={joinFailureWithManyConflicts} />);

    expect(
      screen.getByText(/Final publish failed — 2 source lane\(s\)/),
    ).toBeInTheDocument();
    const action = screen.getByText(/Resolve conflicts in the target worktree/);
    expect(screen.getByTestId("halt-detail")).not.toContainElement(action);
  });
});
