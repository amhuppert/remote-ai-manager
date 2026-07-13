// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import ExecutionInspectorPanel from "./ExecutionInspectorPanel";
import { askQuestionItemSchema } from "@/lib/conversations/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
  GraphWorkflowValidationResultEvent,
} from "@/lib/workflows/schemas";
// Radix-backed tabs activate on pointer-down (automatic activation), not on a
// bare synthetic click event.
function selectDetailTab(name: RegExp | string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
}

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
): {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
} {
  const history = events.map((event, i) => ({
    occurredAt: `2026-03-27T10:0${i}:00.000Z`,
    event,
    preReset: false,
  }));
  return { execution: createWorkflowExecution(), events: history };
}

describe("ExecutionInspectorPanel — ValidationCard markdown formatting", () => {
  it("renders summary with markdown inline code for any validator", async () => {
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // The canonical Markdown adapter defers its renderer — wait for it to mount.
    // Cold-load of the dynamic chunk can exceed the 1000ms default timeout
    // under parallel test-suite load.
    const codeEl = await screen.findByText("bunx vitest run", undefined, {
      timeout: 15000,
    });
    expect(codeEl.closest("code")).toBeTruthy();
  });

  it("renders issue descriptions as markdown for any validator", async () => {
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    const codeEl = await screen.findByText("handleSubmit");
    expect(codeEl.closest("code")).toBeTruthy();
  });

  it("routes summary and issue descriptions through the compact canonical adapter", async () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        pass: false,
        summary: "Uses ~~legacy~~ **canonical** rendering",
        issues: [
          {
            taskId: "task-1",
            title: "Missing coverage",
            description: "No test for the ~~old~~ path",
          },
        ],
        sessionRef: {
          engine: "claude",
          lane: "context_validator",
          conversationId: "conv-canonical",
        },
      }),
    ]);

    const { container } = render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // GFM strikethrough proves it flows through the canonical renderer.
    const del = await screen.findByText("legacy", undefined, {
      timeout: 15000,
    });
    expect(del.tagName).toBe("DEL");
    expect(del.closest('[data-markdown-intent="compact"]')).not.toBeNull();
    // Migrated inspector fields no longer lean on the generated-descendant hook.
    expect(container.querySelector(".wb-markdown-inline")).toBeNull();
  });
});

describe("ExecutionInspectorPanel — ValidationCard lane and engine badges", () => {
  it("renders Context badge for context_validator lane", () => {
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Context")).toBeInTheDocument();
  });

  it("renders engine badge showing claude", () => {
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("claude")).toBeInTheDocument();
  });

  it("renders engine badge showing codex", () => {
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
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
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
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
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
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
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
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
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("thread-codex-99")).toBeInTheDocument();
  });

  it("displays codex response text in artifact section", async () => {
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // The plain-text response first paints in the adapter's streaming
    // fallback, which is then swapped for the loaded canonical root. Poll until
    // the text lands inside that root so we never assert on the detached
    // fallback node (cold chunk load can exceed the 1000ms default).
    await waitFor(
      () =>
        expect(
          screen
            .getByText("Everything checks out.")
            .closest('[data-markdown-intent="compact"]'),
        ).not.toBeNull(),
      { timeout: 15000 },
    );
  });

  it("parses JSON codex response and renders summary as markdown instead of raw JSON", async () => {
    const jsonResponse = JSON.stringify({
      pass: true,
      summary: "Validated with `bunx vitest run` command. All 23 tests passed.",
      issues: [],
    });
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // Summary text should be rendered (markdown strips backticks into <code>);
    // the canonical adapter loads its renderer behind one dynamic import.
    const codeEl = await screen.findByText("bunx vitest run", undefined, {
      timeout: 15000,
    });
    expect(codeEl.closest("code")).toBeTruthy();
    expect(screen.getByText(/All 23 tests passed/)).toBeInTheDocument();
    // Raw JSON must NOT appear
    expect(screen.queryByText(jsonResponse)).not.toBeInTheDocument();
  });

  it("renders issues from parsed codex response JSON", async () => {
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
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // Issue titles rendered
    expect(screen.getByText("Missing test coverage")).toBeInTheDocument();
    expect(screen.getByText("Type error")).toBeInTheDocument();
    // Issue descriptions rendered with markdown (backtick code) once the
    // canonical adapter's renderer resolves behind its dynamic import.
    const codeEl = await screen.findByText("handleSubmit", undefined, {
      timeout: 15000,
    });
    expect(codeEl.closest("code")).toBeTruthy();
    expect(screen.getByText("processData").closest("code")).toBeTruthy();
  });

  it("renders non-JSON codex response as markdown", async () => {
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // Inline code from backticks should be rendered as <code> once the
    // canonical adapter's renderer resolves behind its dynamic import.
    const codeEl = await screen.findByText("vitest", undefined, {
      timeout: 15000,
    });
    expect(codeEl.closest("code")).toBeTruthy();
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
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        event: olderEvent,
        preReset: false,
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        event: newerEvent,
        preReset: false,
      },
    ];
    const execution = createWorkflowExecution();
    const events = history;

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
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
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        event: firstEvent,
        preReset: false,
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        event: secondEvent,
        preReset: false,
      },
    ];
    const execution = createWorkflowExecution();
    const events = history;

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
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
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        event: olderEvent,
        preReset: false,
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        event: newerEvent,
        preReset: false,
      },
    ];
    const execution = createWorkflowExecution();
    const events = history;

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
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
    const { execution, events } = makeExecutionWithHistory([
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
        events={events}
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
    const baseDef = createResolvedWorkflowDefinition();
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
      activeContextIds: ["context-plan"],
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
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
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
      activeContextIds: ["context-plan"],
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
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
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
      activeContextIds: ["context-plan"],
      taskStates: {
        ...baseExecution.taskStates,
        "task-plan-1": {
          ...baseExecution.taskStates["task-plan-1"]!,
          status: "running",
        },
      },
    });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
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
      activeContextIds: ["context-plan"],
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
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
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
    const baseDefinition = createResolvedWorkflowDefinition();
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
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
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

describe("ExecutionInspectorPanel — awaiting-approval status badge", () => {
  it("shows an Awaiting Approval badge for a parked context in the detail view", () => {
    const baseExecution = createWorkflowExecution({ status: "running" });
    const execution = createWorkflowExecution({
      status: "running",
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "awaiting_approval",
        },
      },
    });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    const badge = screen.getByText("Awaiting Approval");
    expect(badge).toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — Reset Context", () => {
  it("shows a Reset button when execution is paused and context is not completed", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /reset context/i }),
    ).toBeInTheDocument();
  });

  it("shows a Reset button when execution is halted and context is not completed", () => {
    const execution = createWorkflowExecution({ status: "halted" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /reset context/i }),
    ).toBeInTheDocument();
  });

  it("hides the Reset button when execution is running", () => {
    const execution = createWorkflowExecution({ status: "running" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /reset context/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the Reset button when the selected context is completed", () => {
    const baseExecution = createWorkflowExecution({ status: "paused" });
    const execution = createWorkflowExecution({
      status: "paused",
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
        },
      },
    });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /reset context/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the Reset button when no onResetContext handler is provided", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /reset context/i }),
    ).not.toBeInTheDocument();
  });

  it("opens a confirmation dialog on Reset and calls onResetContext after confirming", () => {
    const onResetContext = vi.fn();
    const execution = createWorkflowExecution({ status: "paused" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={onResetContext}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reset context/i }));

    expect(screen.getByText("Reset context?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^reset$/i }));

    expect(onResetContext).toHaveBeenCalledWith("context-plan");
  });

  it("does not call onResetContext when the confirmation dialog is cancelled", () => {
    const onResetContext = vi.fn();
    const execution = createWorkflowExecution({ status: "paused" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={onResetContext}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reset context/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onResetContext).not.toHaveBeenCalled();
    expect(screen.queryByText("Reset context?")).not.toBeInTheDocument();
  });

  it("hides history entries flagged as preReset in the detail history tab", () => {
    const visibleEvent = makeValidationEvent({
      contextId: "context-plan",
      summary: "Kept after reset",
    });
    const hiddenEvent = makeValidationEvent({
      contextId: "context-plan",
      summary: "Discarded by reset",
    });
    const execution = createWorkflowExecution({ status: "paused" });
    const events = [
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        event: hiddenEvent,
        preReset: true,
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        event: visibleEvent,
        preReset: false,
      },
    ];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab(/history/i);

    expect(screen.getByText("Kept after reset")).toBeInTheDocument();
    expect(screen.queryByText("Discarded by reset")).not.toBeInTheDocument();
  });

  it("hides history entries flagged as preReset in the overview validations section", () => {
    const visibleEvent = makeValidationEvent({
      contextId: "context-plan",
      summary: "Kept after reset",
    });
    const hiddenEvent = makeValidationEvent({
      contextId: "context-plan",
      summary: "Discarded by reset",
    });
    const execution = createWorkflowExecution({ status: "paused" });
    const events = [
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        event: hiddenEvent,
        preReset: true,
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        event: visibleEvent,
        preReset: false,
      },
    ];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Kept after reset")).toBeInTheDocument();
    expect(screen.queryByText("Discarded by reset")).not.toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — Launch Inputs audit surface", () => {
  it("renders the bound input snapshot for human inspection (R6.3)", () => {
    const execution = createWorkflowExecution({
      boundInputs: { feature: "search box", priority: "high" },
    });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Launch Inputs")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();
    expect(screen.getByText("search box")).toBeInTheDocument();
    expect(screen.getByText("priority")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("omits the Launch Inputs section for a zero-input execution", () => {
    const execution = createWorkflowExecution({ boundInputs: {} });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.queryByText("Launch Inputs")).not.toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — parked user-input question", () => {
  const QUESTION_TEXT = "Which database should we use?";
  const parkedPanel = () => ({
    questions: [
      askQuestionItemSchema.parse({
        id: "q1",
        question: QUESTION_TEXT,
        options: [{ label: "Postgres" }, { label: "SQLite" }],
      }),
    ],
    questionId: "qb-1",
    currentIndex: 0,
    onNavigate: vi.fn(),
    onSubmit: vi.fn(),
  });

  it("mounts the question panel for the selected parked context when userInputPanel is provided", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
        userInputPanel={parkedPanel()}
      />,
    );

    expect(screen.getByText(QUESTION_TEXT)).toBeInTheDocument();
    expect(screen.getByText("Postgres")).toBeInTheDocument();
  });

  it("renders no question panel when userInputPanel is null", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
        userInputPanel={null}
      />,
    );

    expect(screen.queryByText(QUESTION_TEXT)).not.toBeInTheDocument();
  });

  it("renders no question panel in the overview (no context selected) even if props carry a panel", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
        userInputPanel={parkedPanel()}
      />,
    );

    expect(screen.queryByText(QUESTION_TEXT)).not.toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — Config tab + overview header", () => {
  it("shows a Config tab that renders the selected context's resolved config", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    // The config content is not mounted until the tab is selected.
    expect(screen.queryByTestId("context-config-tab")).not.toBeInTheDocument();

    selectDetailTab("Config");

    const tab = screen.getByTestId("context-config-tab");
    // context-plan's resolved implementer is claude opus.
    const impl = within(tab).getByTestId("config-block-implementer");
    expect(within(impl).getByText("Opus")).toBeInTheDocument();
    // Runtime facts render for the selected context.
    expect(within(tab).getByTestId("runtime-isolation")).toHaveTextContent(
      "session",
    );
  });

  it("keeps the Tasks tab as the default detail view", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    // Tasks content is present by default; config is not.
    expect(screen.getByText("Inspect code")).toBeInTheDocument();
    expect(screen.queryByTestId("context-config-tab")).not.toBeInTheDocument();
  });

  it("shows liveRevision and seed definition id@revision in the overview header", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({
          liveRevision: 4,
          seedDefinitionId: "workflow-1",
          seedDefinitionRevision: 12,
        })}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByTestId("overview-live-revision")).toHaveTextContent(
      "liveRev 4",
    );
    expect(screen.getByTestId("overview-seed")).toHaveTextContent(
      "workflow-1@12",
    );
  });
});

describe("ExecutionInspectorPanel — Config tab editing wiring", () => {
  it("forwards a composed update-context op batch through onSaveContextConfig", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "paused" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    selectDetailTab("Config");
    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-plan",
        iterationPolicy: { maxIterations: 7, continuity: { enabled: true } },
      },
    ]);
  });

  it("shows a pause-to-edit affordance for a started context on a running execution", () => {
    const onPauseExecution = vi.fn();
    const base = createWorkflowExecution({ status: "running" });
    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "ready",
          iterationCount: 1,
        },
      },
    });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
        onSaveContextConfig={vi.fn()}
        onPauseExecution={onPauseExecution}
      />,
    );

    selectDetailTab("Config");
    fireEvent.click(screen.getByRole("button", { name: "Pause to edit" }));
    expect(onPauseExecution).toHaveBeenCalledTimes(1);
  });

  it("surfaces the revision-conflict retry notice in the Config tab", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "paused" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
        onSaveContextConfig={vi.fn()}
        configEditConflict
      />,
    );

    selectDetailTab("Config");
    expect(screen.getByTestId("config-affordance-conflict")).toHaveTextContent(
      /execution changed/i,
    );
  });
});

describe("ExecutionInspectorPanel — brief markdown + focus modal", () => {
  function makeBriefExecution(): GraphWorkflowExecution {
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? {
              ...context,
              description: "Plan the **entire** implementation",
              acceptanceCriteria: "1. Criteria uses `deepEqualJson` everywhere",
              humanApprovalGate: { enabled: true },
            }
          : context,
    );
    return createWorkflowExecution({ workingDefinition: definition });
  }

  function renderDetail() {
    return render(
      <ExecutionInspectorPanel
        execution={makeBriefExecution()}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );
  }

  it("renders description and acceptance criteria as formatted markdown", async () => {
    renderDetail();

    const bold = await screen.findByText("entire", undefined, {
      timeout: 15000,
    });
    expect(bold.closest("strong")).toBeTruthy();
    const code = await screen.findByText("deepEqualJson");
    expect(code.closest("code")).toBeTruthy();
  });

  it("opens the acceptance criteria in a focus modal on click", async () => {
    renderDetail();

    fireEvent.click(
      screen.getByRole("button", { name: /view acceptance criteria/i }),
    );

    const dialog = await screen.findByRole("dialog", {}, { timeout: 15000 });
    expect(within(dialog).getByText("Plan")).toBeInTheDocument();
    const code = await within(dialog).findByText("deepEqualJson");
    expect(code.closest("code")).toBeTruthy();
  });

  it("opens the description in a focus modal on click", async () => {
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: /view description/i }));

    const dialog = await screen.findByRole("dialog", {}, { timeout: 15000 });
    const bold = await within(dialog).findByText("entire");
    expect(bold.closest("strong")).toBeTruthy();
  });

  it("shows resolved implementer and enabled gate chips for the selected context", () => {
    const { container } = renderDetail();

    const strip = container.querySelector('[data-section="resolved-setup"]');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain("claude opus · high");
    expect(strip!.textContent).toContain("Approval");
    // Disabled gates render no chip.
    expect(strip!.textContent).not.toContain("Script");
    expect(strip!.textContent).not.toContain("Questions");
  });
});
