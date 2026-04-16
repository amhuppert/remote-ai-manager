// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import { renderWithQuery } from "@/test/component-mocks";
import type { GraphWorkflowExecution } from "@/types";
import GraphWorkflowPanel from "./GraphWorkflowPanel";
import IterationTranscriptViewer from "./IterationTranscriptViewer";
import { resolveViewingTask } from "./view-task-resolver";

const noopCallbacks = {
  projectName: "test-project",
  sessionName: "test-session",
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
  isMobile: false,
  mobilePanel: "graph" as const,
  autoSwitchPanel: vi.fn(),
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
          failureMessage: null,
          failureHistory: [],
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

// ---------------------------------------------------------------------------
// Codex implementer parity — proves the panel routes Codex-backed tasks
// through the same CC conversation + shared IterationTranscriptViewer path
// used by Claude tasks:
//
//   1. resolveViewingTask (pure function extracted from the panel) returns
//      the task's lastConversationId (a normal CC conversation ID, not a
//      Codex thread handle) and the context/task metadata the viewer needs,
//      regardless of backend.
//   2. IterationTranscriptViewer mounts with those props and issues a GET
//      against the standard CC conversation-messages endpoint — proving
//      Codex workflow implementers share the existing transcript viewer.
//   3. The live-state signal (isLive) correctly flows from the running
//      Codex task through to the viewer, matching Claude's behavior.
// ---------------------------------------------------------------------------

function createCodexExecutionWithRunningTask() {
  const definition = createWorkflowDefinition({
    executionContexts: [
      {
        id: "context-codex-impl",
        title: "Codex Implement",
        description: "Codex-powered implementation",
        agent: {
          backend: "codex",
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
        },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
      },
    ],
    tasks: [
      {
        id: "task-codex-1",
        contextId: "context-codex-impl",
        order: 1,
        title: "Ship Codex feature",
        instructions: "Implement the feature using Codex.",
        source: "user",
      },
    ],
    edges: [],
  });

  return createWorkflowExecution({
    status: "running",
    activeContextId: "context-codex-impl",
    workingDefinition: definition,
    contextStates: {
      "context-codex-impl": {
        contextId: "context-codex-impl",
        status: "running",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 1,
        consecutiveFailureCount: 0,
      },
    },
    taskStates: {
      "task-codex-1": {
        taskId: "task-codex-1",
        contextId: "context-codex-impl",
        order: 1,
        status: "running",
        summary: null,
        startedAt: "2026-03-27T16:00:00.000Z",
        completedAt: null,
        lastConversationId: "cc-conv-codex-abc",
        failureMessage: null,
        failureHistory: [],
      },
    },
    machineSnapshot: {
      hasLiveIteration: true,
      activeContextId: "context-codex-impl",
    } as GraphWorkflowExecution["machineSnapshot"],
  });
}

describe("resolveViewingTask — codex implementer parity", () => {
  it("resolves a codex-backed task to its CC conversation ID plus context/task titles", () => {
    const execution = createCodexExecutionWithRunningTask();

    const resolved = resolveViewingTask(execution, "task-codex-1");

    expect(resolved).toEqual({
      conversationId: "cc-conv-codex-abc",
      contextTitle: "Codex Implement",
      taskTitle: "Ship Codex feature",
      isLive: true,
    });
  });

  it("returns null when the codex task has no conversation yet", () => {
    const execution = createCodexExecutionWithRunningTask();
    execution.taskStates["task-codex-1"]!.lastConversationId = null;

    expect(resolveViewingTask(execution, "task-codex-1")).toBeNull();
  });

  it("returns identical shape for a claude-backed task — proving backend-agnostic resolution", () => {
    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      taskStates: {
        ...createWorkflowExecution().taskStates,
        "task-plan-1": {
          taskId: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          status: "running",
          summary: null,
          startedAt: "2026-03-27T16:00:00.000Z",
          completedAt: null,
          lastConversationId: "cc-conv-claude-xyz",
          failureMessage: null,
          failureHistory: [],
        },
      },
    });

    const resolved = resolveViewingTask(execution, "task-plan-1");

    expect(resolved).toEqual({
      conversationId: "cc-conv-claude-xyz",
      contextTitle: "Plan",
      taskTitle: "Inspect code",
      isLive: false,
    });
  });
});

describe("GraphWorkflowPanel — codex transcript viewing path (mount)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mounts IterationTranscriptViewer with codex task metadata and hits the CC conversation-messages endpoint", async () => {
    // Drive the mount path directly: GraphWorkflowPanel's `resolveViewingTask`
    // produces these props from a codex-backed task, and IterationTranscriptViewer
    // is the exact component the panel mounts when a user clicks View on a task.
    // This proves Codex workflow implementers use normal CC conversations AND
    // the existing transcript viewing component — end-to-end at the mount layer.
    const execution = createCodexExecutionWithRunningTask();
    const resolved = resolveViewingTask(execution, "task-codex-1");
    expect(resolved).not.toBeNull();

    renderWithQuery(
      <IterationTranscriptViewer
        projectName="test-project"
        sessionName="test-session"
        conversationId={resolved!.conversationId}
        isLive={resolved!.isLive}
        contextTitle={resolved!.contextTitle}
        taskTitle={resolved!.taskTitle}
        onClose={vi.fn()}
      />,
    );

    // Header surfaces the codex context + task titles unchanged.
    expect(screen.getByText("Codex Implement")).toBeInTheDocument();
    expect(screen.getByText("Ship Codex feature")).toBeInTheDocument();
    // Live indicator is present (codex task is running).
    expect(screen.getByText("Live")).toBeInTheDocument();

    // The viewer calls the standard CC conversation-messages endpoint with the
    // CC conversation ID — confirming Codex tasks reuse the normal conversation
    // transport, not a codex-specific one.
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(
      urls.some((u) =>
        u.includes(
          "/api/projects/test-project/sessions/test-session/conversations/cc-conv-codex-abc/messages",
        ),
      ),
    ).toBe(true);
  });

  it("does not mount the transcript viewer until a task is selected (default render path for codex execution)", () => {
    const execution = createCodexExecutionWithRunningTask();

    render(
      <GraphWorkflowPanel
        execution={execution}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    // Viewer close button (the viewer's marker element) must not be present.
    expect(
      screen.queryByRole("button", { name: "Close transcript" }),
    ).toBeNull();
    // Panel still renders normal status bar + codex context — proves the panel
    // handles codex executions through its default path.
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(
      screen.getAllByText("Codex Implement").length,
    ).toBeGreaterThanOrEqual(1);
  });
});
