// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import CumulativeDiff from "./CumulativeDiff";
import type { IterationMeta } from "./types";

function makeIteration(
  n: number,
  gitOverrides?: Partial<IterationMeta["gitMetrics"]>,
): IterationMeta {
  return {
    iterationNumber: n,
    conversationId: `conv-${n}`,
    status: "completed",
    startedAt: "2026-02-25T10:00:00Z",
    completedAt: "2026-02-25T10:05:00Z",
    durationMs: 300_000,
    costUsd: 0.42,
    turns: 8,
    gitMetrics: {
      filesChanged: 2,
      linesAdded: 30,
      linesRemoved: 10,
      changedFiles: ["src/a.ts", "src/b.ts"],
      ...gitOverrides,
    },
    statusReport: null,
    tasksCompleted: [],
    tasksSkipped: [],
    tasksAdded: [],
    progressClassification: "progress",
    peakContextTokens: 0,
  };
}

describe("CumulativeDiff", () => {
  it("shows aggregated line counts across iterations", () => {
    const iterations = [
      makeIteration(1, { linesAdded: 30, linesRemoved: 10 }),
      makeIteration(2, { linesAdded: 50, linesRemoved: 5 }),
    ];
    const { container } = render(<CumulativeDiff iterations={iterations} />);
    const summary = container.querySelector(".cumulative-diff-summary");
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain("+80");
    expect(summary!.textContent).toContain("-15");
  });

  it("shows deduplicated file list when expanded", () => {
    const iterations = [
      makeIteration(1, { changedFiles: ["src/a.ts", "src/b.ts"] }),
      makeIteration(2, { changedFiles: ["src/b.ts", "src/c.ts"] }),
    ];
    const { container } = render(<CumulativeDiff iterations={iterations} />);
    const toggle = container.querySelector(".cumulative-diff-toggle")!;
    fireEvent.click(toggle);
    const files = container.querySelectorAll(".cumulative-diff-file");
    // Should be 3 unique files: a.ts, b.ts, c.ts
    expect(files.length).toBe(3);
  });

  it("starts collapsed and expands on click", () => {
    const iterations = [makeIteration(1)];
    const { container } = render(<CumulativeDiff iterations={iterations} />);
    // File list should not be visible initially
    expect(container.querySelector(".cumulative-diff-files")).toBeNull();
    // Click to expand
    const toggle = container.querySelector(".cumulative-diff-toggle")!;
    fireEvent.click(toggle);
    expect(container.querySelector(".cumulative-diff-files")).not.toBeNull();
  });

  it("collapses on second click", () => {
    const iterations = [makeIteration(1)];
    const { container } = render(<CumulativeDiff iterations={iterations} />);
    const toggle = container.querySelector(".cumulative-diff-toggle")!;
    fireEvent.click(toggle);
    expect(container.querySelector(".cumulative-diff-files")).not.toBeNull();
    fireEvent.click(toggle);
    expect(container.querySelector(".cumulative-diff-files")).toBeNull();
  });

  it("renders nothing for empty iterations", () => {
    const { container } = render(<CumulativeDiff iterations={[]} />);
    expect(container.querySelector(".cumulative-diff")).toBeNull();
  });

  it("shows total unique file count", () => {
    const iterations = [
      makeIteration(1, { changedFiles: ["src/a.ts", "src/b.ts"] }),
      makeIteration(2, { changedFiles: ["src/b.ts", "src/c.ts", "src/d.ts"] }),
    ];
    const { container } = render(<CumulativeDiff iterations={iterations} />);
    const summary = container.querySelector(".cumulative-diff-summary");
    expect(summary!.textContent).toContain("4 files");
  });
});
