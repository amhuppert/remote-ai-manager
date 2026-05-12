// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GraphWorkflowExecution, GraphWorkflowHaltReason } from "@/types";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import ExecutionStatusBar from "./ExecutionStatusBar";

function makeExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "halted",
    ...overrides,
  });
}

const baseProps = {
  onPause: vi.fn(),
  onResume: vi.fn(),
  onAbort: vi.fn(),
  onClear: vi.fn(),
  isMutating: false,
};

describe("ExecutionStatusBar halt banner", () => {
  it("renders merge_precondition_failed headline, truncated dirty paths, and action text", () => {
    const haltReason: GraphWorkflowHaltReason = {
      type: "merge_precondition_failed",
      contextId: "context-implement",
      targetBranch: "csm/session-1",
      dirtyPaths: [
        { path: "src/a.ts", statusCode: " M", tracked: true },
        { path: "src/b.ts", statusCode: " M", tracked: true },
      ],
      totalDirtyCount: 4,
      message: "Target branch 'csm/session-1' has 4 uncommitted change(s)",
    };

    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ haltReason })}
      />,
    );

    expect(
      screen.getByText(/Cannot merge into csm\/session-1/),
    ).toBeInTheDocument();
    expect(screen.getByText(/4 uncommitted change\(s\)/)).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Commit, stash, or discard those changes in the session worktree/,
      ),
    ).toBeInTheDocument();
  });

  it("renders a +N more failures chip when secondaryHaltReasons is non-empty", () => {
    const haltReason: GraphWorkflowHaltReason = {
      type: "merge_precondition_failed",
      contextId: "context-a",
      targetBranch: "csm/session-1",
      dirtyPaths: [],
      totalDirtyCount: 0,
      message: "blocked",
    };
    const secondary: GraphWorkflowHaltReason[] = [
      {
        type: "agent_turn_failed",
        contextId: "context-b",
        engine: "claude",
        cause: "sdk_error",
        message: "boom",
      },
      {
        type: "agent_turn_failed",
        contextId: "context-c",
        engine: "codex",
        cause: "unknown",
        message: "kaboom",
      },
    ];

    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({
          haltReason,
          secondaryHaltReasons: secondary,
        })}
      />,
    );

    expect(screen.getByText("+2 more failures")).toBeInTheDocument();
  });

  it("does not render a halt banner when haltReason is null", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({
          status: "running",
          haltReason: null,
        })}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
