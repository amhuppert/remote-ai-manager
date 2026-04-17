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
    validatorType: "context",
    pass: true,
    summary: "All good",
    issues: [],
    reopenTaskIds: [],
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

describe("ExecutionInspectorPanel — ValidationCard markdown formatting", () => {
  it("renders summary with markdown inline code for any validator", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        summary: "All 23 tests passed via `bunx vitest run`",
        sessionRef: {
          engine: "claude",
          lane: "context_validator",
          conversationId: "conv-md",
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

    expect(screen.getByText("bunx vitest run").closest("code")).toBeTruthy();
  });

  it("renders issue descriptions as markdown for any validator", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        pass: false,
        summary: "Failed",
        issues: [
          {
            taskId: "task-1",
            title: "Missing coverage",
            description: "No tests for `handleSubmit` function",
          },
        ],
        sessionRef: {
          engine: "claude",
          lane: "context_validator",
          conversationId: "conv-md-2",
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

    expect(screen.getByText("handleSubmit").closest("code")).toBeTruthy();
  });
});

describe("ExecutionInspectorPanel — ValidationCard lane and engine badges", () => {
  it("renders Context badge for context_validator lane", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: {
          engine: "claude",
          lane: "context_validator",
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

    expect(screen.getByText("Context")).toBeInTheDocument();
  });

  it("renders engine badge showing claude", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: {
          engine: "claude",
          lane: "context_validator",
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
          lane: "context_validator",
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
          lane: "context_validator",
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
          lane: "context_validator",
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
      "context_validator",
      "context-plan",
    );
  });

  it("does not show View Transcript button when onViewConversation is not provided", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: {
          engine: "claude",
          lane: "context_validator",
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
          lane: "context_validator",
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
          lane: "context_validator",
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

  it("parses JSON codex response and renders summary as markdown instead of raw JSON", () => {
    const jsonResponse = JSON.stringify({
      pass: true,
      summary: "Validated with `bunx vitest run` command. All 23 tests passed.",
      issues: [],
    });
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: {
          engine: "codex",
          threadId: "thread-json-1",
          response: jsonResponse,
          usage: null,
        },
        sessionRef: {
          engine: "codex",
          lane: "context_validator",
          threadId: "thread-json-1",
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

    // Raw JSON must NOT appear
    expect(screen.queryByText(jsonResponse)).not.toBeInTheDocument();
    // Summary text should be rendered (markdown strips backticks into <code>)
    expect(screen.getByText(/All 23 tests passed/)).toBeInTheDocument();
    // Inline code from backticks should be rendered as <code>
    expect(screen.getByText("bunx vitest run").closest("code")).toBeTruthy();
  });

  it("renders issues from parsed codex response JSON", () => {
    const jsonResponse = JSON.stringify({
      pass: false,
      summary: "Found issues in implementation",
      issues: [
        {
          title: "Missing test coverage",
          description: "The `handleSubmit` function has no unit tests",
        },
        {
          title: "Type error",
          description: "Parameter type mismatch in `processData`",
        },
      ],
    });
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: {
          engine: "codex",
          threadId: "thread-json-2",
          response: jsonResponse,
          usage: null,
        },
        sessionRef: {
          engine: "codex",
          lane: "context_validator",
          threadId: "thread-json-2",
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

    // Issue titles rendered
    expect(screen.getByText("Missing test coverage")).toBeInTheDocument();
    expect(screen.getByText("Type error")).toBeInTheDocument();
    // Issue descriptions rendered with markdown (backtick code)
    expect(screen.getByText("handleSubmit").closest("code")).toBeTruthy();
    expect(screen.getByText("processData").closest("code")).toBeTruthy();
  });

  it("renders non-JSON codex response as markdown", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: {
          engine: "codex",
          threadId: "thread-plain",
          response: "All tests pass with `vitest` runner.",
          usage: null,
        },
        sessionRef: {
          engine: "codex",
          lane: "context_validator",
          threadId: "thread-plain",
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

    // Inline code from backticks should be rendered as <code>
    expect(screen.getByText("vitest").closest("code")).toBeTruthy();
  });
});

describe("ExecutionInspectorPanel — continued session badge", () => {
  it("shows continued badge when the same session is reused in a newer validation", () => {
    // Two events in the same lane with the same conversationId — the newer one (index 0
    // in the reversed display) gets the badge when the older one set the session.
    const olderEvent = makeValidationEvent({
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
        conversationId: "conv-shared",
      },
    });
    const newerEvent = makeValidationEvent({
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
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
        lane: "context_validator",
        conversationId: "conv-1",
      },
    });
    const secondEvent = makeValidationEvent({
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
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
        lane: "context_validator",
        conversationId: sharedConvId,
      },
    });
    const newerEvent = makeValidationEvent({
      contextId: "context-plan",
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
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
      "context_validator",
      "context-plan",
    );
    fireEvent.click(buttons[1]!);
    expect(onViewConversation).toHaveBeenCalledTimes(2);
  });
});

describe("ExecutionInspectorPanel — reopened tasks", () => {
  it("renders reopened task ids for failed context validation", () => {
    const execution = makeExecutionWithHistory([
      makeValidationEvent({
        pass: false,
        reopenTaskIds: ["task-plan-1", "task-implement-1"],
        sessionRef: {
          engine: "claude",
          lane: "context_validator",
          conversationId: "conv-reopen",
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

    expect(screen.getByText("Reopened Tasks (2)")).toBeInTheDocument();
    expect(screen.getByText("task-plan-1")).toBeInTheDocument();
    expect(screen.getByText("task-implement-1")).toBeInTheDocument();
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

describe("ExecutionInspectorPanel — live implementer viewing", () => {
  it("shows Watch for an incomplete task when the active iteration is live", () => {
    const onViewTask = vi.fn();
    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      taskStates: {
        "task-plan-1": {
          taskId: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: "2026-03-27T10:00:00.000Z",
          completedAt: null,
          lastConversationId: "conv-live",
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
      machineSnapshot: {
        schemaVersion: 1,
        lifecycleStatus: "running",
        activeContextId: "context-plan",
        recoveryMode: "none",
        hasLiveIteration: true,
      },
    });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId="context-plan"
        {...baseHandlers}
        onViewTask={onViewTask}
      />,
    );

    expect(screen.getByRole("button", { name: "Watch" })).toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — task editability", () => {
  it("does not show edit controls for a running task", () => {
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      taskStates: {
        ...baseExecution.taskStates,
        "task-plan-1": {
          ...baseExecution.taskStates["task-plan-1"]!,
          status: "running",
        },
      },
    });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    fireEvent.click(screen.getByText("Inspect code"));

    expect(screen.queryByText("Edit Title")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });

  it("does not show edit controls while a live iteration is active for the task context", () => {
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      taskStates: {
        ...baseExecution.taskStates,
        "task-plan-1": {
          ...baseExecution.taskStates["task-plan-1"]!,
          status: "pending",
          lastConversationId: "conversation-live",
        },
      },
      machineSnapshot: {
        schemaVersion: 1,
        lifecycleStatus: "running",
        activeContextId: "context-plan",
        recoveryMode: "none",
        hasLiveIteration: true,
      },
    });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    fireEvent.click(screen.getByText("Inspect code"));

    expect(screen.queryByText("Edit Title")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });

  it("reorders only editable tasks within a context", () => {
    const onReorderTask = vi.fn();
    const baseDefinition = createWorkflowDefinition();
    const definition = {
      ...baseDefinition,
      tasks: [
        {
          id: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          title: "Inspect code",
          instructions: "Read the relevant files.",
          source: "user" as const,
        },
        {
          id: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          title: "Write plan",
          instructions: "Document the plan.",
          source: "user" as const,
        },
        {
          id: "task-plan-3",
          contextId: "context-plan",
          order: 3,
          title: "Capture risks",
          instructions: "Summarize the remaining risks.",
          source: "user" as const,
        },
        ...baseDefinition.tasks.filter(
          (task) => task.contextId !== "context-plan",
        ),
      ],
    };
    const baseExecution = createWorkflowExecution({
      workingDefinition: definition,
    });
    const execution = createWorkflowExecution({
      status: "paused",
      workingDefinition: definition,
      taskStates: {
        ...baseExecution.taskStates,
        "task-plan-1": {
          ...baseExecution.taskStates["task-plan-1"]!,
          status: "completed",
          completedAt: "2026-03-27T10:05:00.000Z",
        },
        "task-plan-2": {
          ...baseExecution.taskStates["task-plan-2"]!,
          status: "pending",
        },
        "task-plan-3": {
          taskId: "task-plan-3",
          contextId: "context-plan",
          order: 3,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
      },
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          totalTaskCount: 3,
          completedTaskCount: 1,
        },
      },
    });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        selectedContextId="context-plan"
        {...baseHandlers}
        onReorderTask={onReorderTask}
      />,
    );

    fireEvent.click(screen.getByText("Capture risks"));
    fireEvent.click(screen.getByRole("button", { name: "▴ Up" }));

    expect(onReorderTask).toHaveBeenCalledWith("context-plan", [
      "task-plan-3",
      "task-plan-2",
    ]);
  });
});
