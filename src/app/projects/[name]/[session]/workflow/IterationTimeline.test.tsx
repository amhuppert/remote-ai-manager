// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import IterationTimeline from "./IterationTimeline";
import type { IterationMeta } from "./types";

function makeIteration(overrides: Partial<IterationMeta> = {}): IterationMeta {
  return {
    iterationNumber: 1,
    conversationId: "conv-001",
    status: "completed",
    startedAt: "2026-02-25T10:00:00Z",
    completedAt: "2026-02-25T10:05:00Z",
    durationMs: 300_000,
    costUsd: 0.42,
    turns: 8,
    gitMetrics: {
      filesChanged: 3,
      linesAdded: 45,
      linesRemoved: 12,
      changedFiles: ["src/auth.ts", "src/auth.test.ts", "src/types.ts"],
    },
    statusReport: {
      status: "in_progress",
      exit_signal: false,
      work_summary: "Implemented JWT authentication",
      work_type: "implementation",
    },
    tasksCompleted: [],
    tasksSkipped: [],
    tasksAdded: [],
    progressClassification: "progress",
    peakContextTokens: 0,
    ...overrides,
  };
}

describe("IterationTimeline", () => {
  it("renders all iteration cards", () => {
    const iterations = [
      makeIteration(),
      makeIteration({ iterationNumber: 2, conversationId: "conv-002" }),
    ];
    const { container } = render(<IterationTimeline iterations={iterations} />);
    const cards = container.querySelectorAll(".iteration-card");
    expect(cards.length).toBe(2);
  });

  it("returns null for empty iterations", () => {
    const { container } = render(<IterationTimeline iterations={[]} />);
    expect(container.querySelector(".iteration-timeline")).toBeNull();
  });

  // --- Expandable detail (Task 12.1) ---

  it("shows expand toggle on each iteration card", () => {
    const { container } = render(
      <IterationTimeline iterations={[makeIteration()]} />,
    );
    const toggle = container.querySelector(".iteration-card-expand");
    expect(toggle).not.toBeNull();
  });

  it("does not show detail panel when collapsed", () => {
    const { container } = render(
      <IterationTimeline iterations={[makeIteration()]} />,
    );
    expect(container.querySelector(".iteration-card-detail")).toBeNull();
  });

  it("shows detail panel with changed files when expanded", () => {
    const { container } = render(
      <IterationTimeline iterations={[makeIteration()]} />,
    );
    const toggle = container.querySelector(".iteration-card-expand")!;
    fireEvent.click(toggle);
    const detail = container.querySelector(".iteration-card-detail");
    expect(detail).not.toBeNull();
    // Should show changed files
    const fileItems = container.querySelectorAll(".iteration-diff-file");
    expect(fileItems.length).toBe(3);
    expect(fileItems[0]!.textContent).toContain("src/auth.ts");
    expect(fileItems[1]!.textContent).toContain("src/auth.test.ts");
    expect(fileItems[2]!.textContent).toContain("src/types.ts");
  });

  it("collapses detail panel on second click", () => {
    const { container } = render(
      <IterationTimeline iterations={[makeIteration()]} />,
    );
    const toggle = container.querySelector(".iteration-card-expand")!;
    fireEvent.click(toggle);
    expect(container.querySelector(".iteration-card-detail")).not.toBeNull();
    fireEvent.click(toggle);
    expect(container.querySelector(".iteration-card-detail")).toBeNull();
  });

  it("shows transcript link in expanded detail", () => {
    const { container } = render(
      <IterationTimeline iterations={[makeIteration()]} />,
    );
    const toggle = container.querySelector(".iteration-card-expand")!;
    fireEvent.click(toggle);
    const transcriptLink = container.querySelector(
      ".iteration-transcript-link",
    );
    expect(transcriptLink).not.toBeNull();
    expect(transcriptLink!.textContent).toContain("View transcript");
  });

  it("shows diff summary in expanded detail", () => {
    const { container } = render(
      <IterationTimeline iterations={[makeIteration()]} />,
    );
    const toggle = container.querySelector(".iteration-card-expand")!;
    fireEvent.click(toggle);
    const diffSummary = container.querySelector(".iteration-diff-summary");
    expect(diffSummary).not.toBeNull();
    expect(diffSummary!.textContent).toContain("3 files");
    expect(diffSummary!.textContent).toContain("+45");
    expect(diffSummary!.textContent).toContain("-12");
  });

  it("shows no files message when no git changes", () => {
    const iter = makeIteration({
      gitMetrics: {
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        changedFiles: [],
      },
    });
    const { container } = render(<IterationTimeline iterations={[iter]} />);
    const toggle = container.querySelector(".iteration-card-expand")!;
    fireEvent.click(toggle);
    const noFiles = container.querySelector(".iteration-diff-empty");
    expect(noFiles).not.toBeNull();
  });

  it("expands only the clicked card, not all", () => {
    const iterations = [
      makeIteration(),
      makeIteration({ iterationNumber: 2, conversationId: "conv-002" }),
    ];
    const { container } = render(<IterationTimeline iterations={iterations} />);
    const toggles = container.querySelectorAll(".iteration-card-expand");
    expect(toggles.length).toBe(2);
    fireEvent.click(toggles[0]!);
    const details = container.querySelectorAll(".iteration-card-detail");
    expect(details.length).toBe(1);
  });
});
