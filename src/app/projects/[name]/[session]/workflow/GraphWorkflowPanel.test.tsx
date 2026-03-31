// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import GraphWorkflowPanel from "./GraphWorkflowPanel";

const noopCallbacks = {
  onPause: vi.fn(),
  onResume: vi.fn(),
  onAbort: vi.fn(),
  onClear: vi.fn(),
  onAddTask: vi.fn(),
  onUpdateTask: vi.fn(),
  onRemoveTask: vi.fn(),
  onMoveTask: vi.fn(),
  onReorderTask: vi.fn(),
  isMutating: false,
  layout: null,
};

describe("GraphWorkflowPanel", () => {
  it("renders empty state when no execution exists", () => {
    render(
      <GraphWorkflowPanel
        execution={null}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    expect(
      screen.getByText(
        "No graph workflow execution has started for this session.",
      ),
    ).toBeInTheDocument();
  });

  it("renders status bar with execution status badge and active context info", () => {
    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      workingDefinition: {
        ...createWorkflowExecution().workingDefinition,
        tasks: [
          {
            id: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            title: "Inspect code",
            instructions: "Read the relevant files.",
            source: "user",
          },
        ],
      },
      taskStates: {
        "task-plan-1": {
          taskId: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          status: "running",
          summary: null,
          startedAt: "2026-03-28T10:01:00.000Z",
          completedAt: null,
          lastConversationId: null,
          reopenedCount: 0,
          lastReopenedAt: null,
          failureMessage: null,
        },
      },
    });

    render(
      <GraphWorkflowPanel
        execution={execution}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getAllByText("Plan").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Inspect code").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("shows Pause button when running and Abort button when not completed", () => {
    const onPause = vi.fn();
    const onAbort = vi.fn();

    render(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({ status: "running" })}
        archivedExecutions={[]}
        {...noopCallbacks}
        onPause={onPause}
        onAbort={onAbort}
      />,
    );

    const pauseBtn = screen.getByRole("button", { name: "Pause" });
    fireEvent.click(pauseBtn);
    expect(onPause).toHaveBeenCalledTimes(1);

    const abortBtn = screen.getByRole("button", { name: "Abort" });
    fireEvent.click(abortBtn);
    expect(onAbort).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("shows Resume button when paused", () => {
    const onResume = vi.fn();

    render(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({ status: "paused" })}
        archivedExecutions={[]}
        {...noopCallbacks}
        onResume={onResume}
      />,
    );

    const resumeBtn = screen.getByRole("button", { name: "Resume" });
    fireEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("shows only Clear button when execution is completed", () => {
    render(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({ status: "completed" })}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort" })).toBeNull();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("shows Resume and Clear buttons when execution is halted", () => {
    const onResume = vi.fn();
    const onClear = vi.fn();

    render(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({
          status: "halted",
          completedAt: "2026-03-28T10:00:00.000Z",
          haltReason: {
            type: "circuit_breaker",
            contextId: "context-plan",
            condition: "retry_exhaustion",
            summary: "tests failed",
            failureCount: 2,
          },
        })}
        archivedExecutions={[]}
        {...noopCallbacks}
        onResume={onResume}
        onClear={onClear}
      />,
    );

    const resumeBtn = screen.getByRole("button", { name: "Resume" });
    fireEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledTimes(1);

    const clearBtn = screen.getByRole("button", { name: "Clear" });
    fireEvent.click(clearBtn);
    expect(onClear).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("shows Resume and Clear buttons when execution is aborted", () => {
    render(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({
          status: "aborted",
          completedAt: "2026-03-28T10:00:00.000Z",
          haltReason: { type: "aborted" },
        })}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });
});
