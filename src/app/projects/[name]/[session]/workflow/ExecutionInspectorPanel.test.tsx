// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import ExecutionInspectorPanel from "./ExecutionInspectorPanel";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationResultEvent,
} from "@/types";

const baseHandlers = {
  onDeselectContext: vi.fn(),
  onAddTask: vi.fn(),
  onUpdateTask: vi.fn(),
  onRemoveTask: vi.fn(),
  onReorderTask: vi.fn(),
  onViewTask: vi.fn(),
  viewingTaskId: null,
  isMutating: false,
};

function makeValidationEvent(
  overrides: Partial<GraphWorkflowValidationResultEvent> = {},
): GraphWorkflowValidationResultEvent {
  return {
    type: "graph-workflow-validation-result",
    projectName: "project",
    sessionName: "session-1",
    executionId: "execution-1",
    contextId: "context-plan",
    validatorType: "task",
    pass: true,
    summary: "All good",
    issues: [],
    ...overrides,
  };
}

function makeExecutionWithHistory(
  events: GraphWorkflowValidationResultEvent[],
): GraphWorkflowExecution {
  const history = events.map((event, i) => ({
    occurredAt: `2026-03-27T10:0${i}:00.000Z`,
    event,
  }));
  return createWorkflowExecution({ history });
}

describe("ExecutionInspectorPanel — ValidationCard lane and engine badges", () => {
  it("renders Task badge for task_validator lane", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: {
          engine: "claude",
          lane: "task_validator",
          conversationId: "conv-1",
        },
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Task")).toBeInTheDocument();
  });

  it("renders engine badge showing claude", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: {
          engine: "claude",
          lane: "task_validator",
          conversationId: "conv-1",
        },
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("claude")).toBeInTheDocument();
  });

  it("renders engine badge showing codex", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: {
          engine: "codex",
          threadId: "thread-xyz",
          response: "Looks good",
          usage: null,
        },
        sessionRef: {
          engine: "codex",
          lane: "task_validator",
          threadId: "thread-xyz",
        },
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("codex")).toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — View Transcript button", () => {
  it("shows View Transcript button for claude validation when handler is provided", () => {
    const onViewConversation = vi.fn();
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: {
          engine: "claude",
          lane: "task_validator",
          conversationId: "conv-abc",
        },
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId={null}
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );

    expect(
      screen.getByRole("button", { name: /View Transcript/i }),
    ).toBeInTheDocument();
  });

  it("calls onViewConversation with correct args when View Transcript is clicked", () => {
    const onViewConversation = vi.fn();
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        contextId: "context-plan",
        sessionRef: {
          engine: "claude",
          lane: "task_validator",
          conversationId: "conv-abc",
        },
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId={null}
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /View Transcript/i }));

    expect(onViewConversation).toHaveBeenCalledWith(
      "conv-abc",
      "task_validator",
      "context-plan",
    );
  });

  it("does not show View Transcript button when onViewConversation is not provided", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: {
          engine: "claude",
          lane: "task_validator",
          conversationId: "conv-abc",
        },
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /View Transcript/i }),
    ).not.toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — Codex review artifact", () => {
  it("displays codex thread ID in artifact section", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: {
          engine: "codex",
          threadId: "thread-codex-99",
          response: "Code looks correct",
          usage: null,
        },
        sessionRef: {
          engine: "codex",
          lane: "task_validator",
          threadId: "thread-codex-99",
        },
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("thread-codex-99")).toBeInTheDocument();
  });

  it("displays codex response text in artifact section", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: {
          engine: "codex",
          threadId: "thread-1",
          response: "Everything checks out.",
          usage: null,
        },
        sessionRef: {
          engine: "codex",
          lane: "task_validator",
          threadId: "thread-1",
        },
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Everything checks out.")).toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — continued session badge", () => {
  it("shows continued badge when the same session is reused in a newer validation", () => {
    // Two events in the same lane with the same conversationId — the newer one (index 0
    // in the reversed display) gets the badge when the older one set the session.
    const olderEvent = makeValidationEvent({
      sessionRef: {
        engine: "claude",
        lane: "task_validator",
        conversationId: "conv-shared",
      },
    });
    const newerEvent = makeValidationEvent({
      sessionRef: {
        engine: "claude",
        lane: "task_validator",
        conversationId: "conv-shared",
      },
    });
    const history = [
      { occurredAt: "2026-03-27T10:00:00.000Z", event: olderEvent },
      { occurredAt: "2026-03-27T10:01:00.000Z", event: newerEvent },
    ];
    const execution = createWorkflowExecution({ history });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // "↺ continued" badge should appear for the reused session
    expect(screen.getByText("↺ continued")).toBeInTheDocument();
  });

  it("does not show continued badge when sessions differ between validations", () => {
    const firstEvent = makeValidationEvent({
      sessionRef: {
        engine: "claude",
        lane: "task_validator",
        conversationId: "conv-1",
      },
    });
    const secondEvent = makeValidationEvent({
      sessionRef: {
        engine: "claude",
        lane: "task_validator",
        conversationId: "conv-2",
      },
    });
    const history = [
      { occurredAt: "2026-03-27T10:00:00.000Z", event: firstEvent },
      { occurredAt: "2026-03-27T10:01:00.000Z", event: secondEvent },
    ];
    const execution = createWorkflowExecution({ history });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.queryByText("↺ continued")).not.toBeInTheDocument();
  });

  it("both validation history entries remain independently viewable when they share the same session", () => {
    const onViewConversation = vi.fn();
    const sharedConvId = "conv-shared";

    const olderEvent = makeValidationEvent({
      contextId: "context-plan",
      sessionRef: {
        engine: "claude",
        lane: "task_validator",
        conversationId: sharedConvId,
      },
    });
    const newerEvent = makeValidationEvent({
      contextId: "context-plan",
      sessionRef: {
        engine: "claude",
        lane: "task_validator",
        conversationId: sharedConvId,
      },
    });
    const history = [
      { occurredAt: "2026-03-27T10:00:00.000Z", event: olderEvent },
      { occurredAt: "2026-03-27T10:01:00.000Z", event: newerEvent },
    ];
    const execution = createWorkflowExecution({ history });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId={null}
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );

    // Both history entries must render a View Transcript button
    const buttons = screen.getAllByRole("button", { name: /View Transcript/i });
    expect(buttons).toHaveLength(2);

    // Each button calls onViewConversation with the shared conversationId
    fireEvent.click(buttons[0]!);
    expect(onViewConversation).toHaveBeenCalledWith(
      sharedConvId,
      "task_validator",
      "context-plan",
    );
    fireEvent.click(buttons[1]!);
    expect(onViewConversation).toHaveBeenCalledTimes(2);
  });
});

describe("ExecutionInspectorPanel — shared implementer session task history", () => {
  it("tasks sharing the same implementer lastConversationId both show independent View buttons", () => {
    const onViewTask = vi.fn();

    // Extend the default definition with a second task in context-plan
    const baseDef = createWorkflowDefinition();
    const definition = {
      ...baseDef,
      tasks: [
        ...baseDef.tasks,
        {
          id: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          title: "Write tests",
          instructions: "Add test coverage.",
          source: "user" as const,
        },
      ],
    };

    const sharedConvId = "conv-impl-shared";
    const execution = createWorkflowExecution({
      workingDefinition: definition,
      activeContextId: "context-plan",
      taskStates: {
        "task-plan-1": {
          taskId: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          status: "completed",
          summary: "Inspected",
          startedAt: "2026-03-27T10:00:00.000Z",
          completedAt: "2026-03-27T10:05:00.000Z",
          lastConversationId: sharedConvId,
          failureMessage: null,
          failureHistory: [],
        },
        "task-plan-2": {
          taskId: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          status: "completed",
          summary: "Tests written",
          startedAt: "2026-03-27T10:05:00.000Z",
          completedAt: "2026-03-27T10:10:00.000Z",
          lastConversationId: sharedConvId,
          failureMessage: null,
          failureHistory: [],
        },
        "task-implement-1": {
          taskId: "task-implement-1",
          contextId: "context-implement",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
        "task-verify-1": {
          taskId: "task-verify-1",
          contextId: "context-verify",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
      },
    });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId="context-plan"
        {...baseHandlers}
        onViewTask={onViewTask}
        viewingTaskId={null}
      />,
    );

    // Both completed tasks with a shared implementer session should show "View"
    const viewButtons = screen.getAllByRole("button", { name: "View" });
    expect(viewButtons).toHaveLength(2);

    // Each button independently invokes onViewTask with its own task ID
    fireEvent.click(viewButtons[0]!);
    expect(onViewTask).toHaveBeenCalledWith("task-plan-1");

    fireEvent.click(viewButtons[1]!);
    expect(onViewTask).toHaveBeenCalledWith("task-plan-2");

    // No deduplication — both calls occurred
    expect(onViewTask).toHaveBeenCalledTimes(2);
  });
});
