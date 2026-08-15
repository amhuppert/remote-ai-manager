// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
} from "@/lib/workflow-graph/test-fixtures";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import GraphWorkflowPanel from "./GraphWorkflowPanel";
import WorkflowConversationViewer from "./WorkflowConversationViewer";
import { resolveViewingTask } from "./view-task-resolver";

const noopCallbacks = {
  projectName: "test-project",
  sessionName: "test-session",
  onPause: vi.fn(),
  onResume: vi.fn(),
  onAbort: vi.fn(),
  onAbandon: vi.fn(),
  onApproveDefinition: vi.fn(),
  onRejectDefinition: vi.fn(),
  onAddTask: vi.fn(),
  onUpdateTask: vi.fn(),
  onRemoveTask: vi.fn(),
  onMoveTask: vi.fn(),
  onReorderTask: vi.fn(),
  onResetContext: vi.fn(),
  onSaveContextConfig: vi.fn(),
  isSavingConfig: false,
  isPausingExecution: false,
  isResumingExecution: false,
  isApprovingDefinition: false,
  isRejectingDefinition: false,
  definitionApprovalError: null,
  configEditConflict: false,
  configEditError: null,
  configSaveSucceeded: false,
  isMutating: false,
  pendingAction: null,
  layout: null,
  isMobile: false,
  mobilePanel: "graph" as const,
  autoSwitchPanel: vi.fn(),
};

describe("GraphWorkflowPanel", () => {
  it("exposes the active execution identity for contextual diagnostics", () => {
    const execution = createWorkflowExecution({ id: "workflow-observed" });
    const view = renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    expect(
      view.container
        .querySelector("[data-workflow-execution-id]")
        ?.getAttribute("data-workflow-execution-id"),
    ).toBe("workflow-observed");
  });

  it("shows a context configuration save refusal in the selected Config tab", async () => {
    const view = renderWithQuery(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({ status: "paused" })}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
        configEditError='Unknown validation command "premerge".'
      />,
    );

    const contextTitle = screen.getByText("Implement");
    const contextNode = contextTitle.closest(".react-flow__node");
    expect(contextNode).not.toBeNull();
    fireEvent.click(contextNode!);
    await userEvent.click(screen.getByRole("tab", { name: "Config" }));

    expect(view.getByRole("alert")).toHaveTextContent(
      'Unknown validation command "premerge".',
    );
  });

  it("offers the definition-approval recovery action for a parked execution", async () => {
    const onApproveDefinition = vi.fn();
    const onRejectDefinition = vi.fn();
    const execution = createWorkflowExecution({
      status: "pending",
      definitionApproval: {
        requestedAt: "2026-07-31T05:29:58.000Z",
        approvedAt: null,
      },
    });
    renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
        onApproveDefinition={onApproveDefinition}
        onRejectDefinition={onRejectDefinition}
      />,
    );

    expect(screen.getByText("Definition awaiting approval")).toBeVisible();
    const approve = screen.getByRole("button", {
      name: "Approve definition & start",
    });
    await userEvent.click(approve);

    expect(onApproveDefinition).toHaveBeenCalledTimes(1);

    await userEvent.click(
      screen.getByRole("button", { name: "Reject definition" }),
    );
    const dialog = screen.getByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Reject definition" }),
    );
    expect(onRejectDefinition).toHaveBeenCalledTimes(1);
  });

  it("disables definition approval while another workflow mutation is in flight", () => {
    const execution = createWorkflowExecution({
      status: "pending",
      definitionApproval: {
        requestedAt: "2026-07-31T05:29:58.000Z",
        approvedAt: null,
      },
    });
    renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
        isMutating
        isApprovingDefinition={false}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Approve definition & start",
      }),
    ).toBeDisabled();
  });

  it("renders empty state when no execution exists", () => {
    renderWithQuery(
      <GraphWorkflowPanel
        execution={null}
        events={[]}
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

  it("does not render the former passive archive summary in the detail panel", () => {
    renderWithQuery(
      <GraphWorkflowPanel
        execution={null}
        events={[]}
        archivedExecutions={[
          {
            executionId: "exec-cutover",
            definitionId: "wf-1",
            definitionRevision: 2,
            status: "aborted",
            startedAt: "2026-03-01T00:00:00.000Z",
            completedAt: "2026-03-02T00:00:00.000Z",
            haltReason: {
              type: "aborted",
              cause: "migration_cutover",
              summary: "Aborted by the agent assignments cutover.",
            },
            archived: true,
          },
        ]}
        {...noopCallbacks}
      />,
    );

    expect(screen.queryByText(/exec-cutover/)).toBeNull();
  });

  it("renders status bar with execution status badge and active context info", () => {
    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
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

    renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={[]}
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

    renderWithQuery(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
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

    renderWithQuery(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({ status: "paused" })}
        events={[]}
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

  it("offers no control at all when execution is completed", () => {
    renderWithQuery(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({ status: "completed" })}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort" })).toBeNull();
    // A completed run releases the lease on its own, so there is nothing left
    // for an operator to clear.
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("shows Resume when execution is halted", () => {
    const onResume = vi.fn();
    const onAbandon = vi.fn();

    renderWithQuery(
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
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
        onResume={onResume}
        onAbandon={onAbandon}
      />,
    );

    const resumeBtn = screen.getByRole("button", { name: "Resume" });
    fireEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abandon" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Abandon execution",
      }),
    );
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("offers no control when execution is aborted", () => {
    renderWithQuery(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({
          status: "aborted",
          completedAt: "2026-03-28T10:00:00.000Z",
          haltReason: { type: "aborted", cause: null, summary: null },
        })}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort" })).toBeNull();
  });

  it("unmounts every execution mutation when the selected run is read-only", () => {
    const execution = createWorkflowExecution({
      status: "halted",
      definitionApproval: {
        requestedAt: "2026-08-14T15:00:00.000Z",
        approvedAt: null,
      },
      haltReason: {
        type: "join_failure",
        joinId: "join-final",
        joinKind: "final_publish",
        contextId: null,
        sourceLaneIds: ["lane-a", "lane-b"],
        targetLaneId: "__session__",
        message: "Historical merge conflict",
        conflictFiles: ["src/release.ts"],
      },
    });

    renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={[]}
        actionCapability="read-only"
        {...noopCallbacks}
      />,
    );

    expect(screen.getByText("halted")).toBeVisible();
    expect(screen.queryByRole("button", { name: /pause/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /abort/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /abandon/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /edit schema/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reset/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("src/release.ts")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry merge" })).toBeNull();
  });

  it("unmounts a definition-reject confirmation when Current becomes History", () => {
    const execution = createWorkflowExecution({
      id: "execution-awaiting-definition",
      status: "pending",
      definitionApproval: {
        requestedAt: "2026-08-14T15:00:00.000Z",
        approvedAt: null,
      },
    });
    const queryClient = createTestQueryClient();
    const view = renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={[]}
        actionCapability="current"
        {...noopCallbacks}
      />,
      queryClient,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reject definition" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <GraphWorkflowPanel
          execution={execution}
          events={[]}
          actionCapability="read-only"
          {...noopCallbacks}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not carry an abandon confirmation onto a replacement Current execution", () => {
    const halted = (id: string) =>
      createWorkflowExecution({
        id,
        status: "halted",
        haltReason: {
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "retry_exhaustion",
          summary: "Tests failed",
          failureCount: 2,
        },
      });
    const queryClient = createTestQueryClient();
    const view = renderWithQuery(
      <GraphWorkflowPanel
        execution={halted("execution-first")}
        events={[]}
        actionCapability="current"
        {...noopCallbacks}
      />,
      queryClient,
    );

    fireEvent.click(screen.getByRole("button", { name: "Abandon" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <GraphWorkflowPanel
          execution={halted("execution-replacement")}
          events={[]}
          actionCapability="current"
          {...noopCallbacks}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps historical definition approval visible but removes its decision control", () => {
    renderWithQuery(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({
          status: "pending",
          definitionApproval: {
            requestedAt: "2026-08-14T15:00:00.000Z",
            approvedAt: null,
          },
        })}
        events={[]}
        actionCapability="read-only"
        {...noopCallbacks}
      />,
    );

    expect(screen.getByText("Definition awaiting approval")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Approve definition & start" }),
    ).toBeNull();
  });

  it("retains completed definition and context approval history without decision controls", () => {
    const execution = createWorkflowExecution({
      status: "completed",
      completedAt: "2026-08-14T16:00:00.000Z",
      definitionApproval: {
        requestedAt: "2026-08-14T14:00:00.000Z",
        approvedAt: "2026-08-14T14:05:00.000Z",
      },
    });
    const events: GraphWorkflowExecutionEvent[] = [
      {
        occurredAt: "2026-08-14T15:00:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-approval-pending",
          projectName: "test-project",
          sessionName: "test-session",
          executionId: execution.id,
          contextId: "context-plan",
          contextTitle: "Plan",
          conversationId: "conv-plan",
          requestedAt: "2026-08-14T15:00:00.000Z",
        },
      },
      {
        occurredAt: "2026-08-14T15:10:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-approval-resolved",
          projectName: "test-project",
          sessionName: "test-session",
          executionId: execution.id,
          contextId: "context-plan",
          conversationId: "conv-plan",
          decision: "rejected",
          message: "Add migration evidence.",
          decidedAt: "2026-08-14T15:10:00.000Z",
        },
      },
    ];

    renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={events}
        actionCapability="read-only"
        {...noopCallbacks}
      />,
    );

    const history = screen.getByRole("region", { name: "Approval history" });
    expect(history).toHaveTextContent("Definition approved");
    expect(history).toHaveTextContent("Plan requested approval");
    expect(history).toHaveTextContent("Plan rejected");
    expect(history).toHaveTextContent("Add migration evidence.");
    expect(within(history).queryByRole("button")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Codex implementer parity — proves the panel routes Codex-backed tasks
// through the same CC conversation + shared WorkflowConversationViewer path
// used by Claude tasks:
//
//   1. resolveViewingTask (pure function extracted from the panel) returns
//      the task's lastConversationId (a normal CC conversation ID, not a
//      Codex thread handle) and the context/task metadata the viewer needs,
//      regardless of backend.
//   2. WorkflowConversationViewer mounts with those props and issues a GET
//      against the standard CC conversation-messages endpoint — proving
//      Codex workflow implementers share the existing transcript viewer.
//   3. The live-state signal (isLive) correctly flows from the running
//      Codex task through to the viewer, matching Claude's behavior.
// ---------------------------------------------------------------------------

function createCodexExecutionWithRunningTask() {
  const definition = createResolvedWorkflowDefinition({
    executionContexts: [
      {
        placement: { lane: "context-codex-impl", mode: "full" as const },
        id: "context-codex-impl",
        title: "Codex Implement",
        description: "Codex-powered implementation",
        acceptanceCriteria: "Feature shipped via Codex",
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          profileSnapshot: makeProfileSnapshot(),
          agent: {
            backend: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
          },
        },
        contextValidator: { enabled: false, assignments: [] },
        scriptValidator: { commands: [] },
        humanApprovalGate: { enabled: false },
        askUserQuestions: { enabled: false },
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        planRepair: { enabled: true, maxAttemptsPerContext: 2 },
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
    activeContextIds: ["context-codex-impl"],
    workingDefinition: definition,
    contextStates: {
      "context-codex-impl": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "context-codex-impl",
        status: "running",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 1,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
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
      activeContextIds: ["context-plan"],
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mounts WorkflowConversationViewer with codex task metadata and hits the CC conversation-messages endpoint", async () => {
    // Drive the mount path directly: GraphWorkflowPanel's `resolveViewingTask`
    // produces these props from a codex-backed task, and WorkflowConversationViewer
    // is the exact component the panel mounts when a user clicks View on a task.
    // This proves Codex workflow implementers use normal CC conversations AND
    // the existing transcript viewing component — end-to-end at the mount layer.
    const execution = createCodexExecutionWithRunningTask();
    const resolved = resolveViewingTask(execution, "task-codex-1");
    expect(resolved).not.toBeNull();

    renderWithQuery(
      <WorkflowConversationViewer
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

  it("does not refetch a live transcript on a timer", async () => {
    vi.useFakeTimers();
    const execution = createCodexExecutionWithRunningTask();
    const resolved = resolveViewingTask(execution, "task-codex-1");
    expect(resolved).not.toBeNull();

    renderWithQuery(
      <WorkflowConversationViewer
        projectName="test-project"
        sessionName="test-session"
        conversationId={resolved!.conversationId}
        isLive={true}
        contextTitle={resolved!.contextTitle}
        taskTitle={resolved!.taskTitle}
        onClose={vi.fn()}
      />,
    );

    const messageRequestCount = () =>
      fetchSpy.mock.calls.filter(([url]) =>
        String(url).includes(
          "/api/projects/test-project/sessions/test-session/conversations/cc-conv-codex-abc/messages",
        ),
      ).length;

    await act(async () => {
      await vi.waitFor(() => {
        expect(messageRequestCount()).toBe(1);
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(messageRequestCount()).toBe(1);
  });

  it("does not mount the transcript viewer until a task is selected (default render path for codex execution)", () => {
    const execution = createCodexExecutionWithRunningTask();

    renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={[]}
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

  it("deep-links Edit schema to the halted context's Config tab (R3.2)", async () => {
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? {
              ...context,
              outputSchema: { type: "object", properties: {} },
            }
          : context,
    );
    const execution = createWorkflowExecution({
      workingDefinition: definition,
      status: "halted",
      haltReason: {
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "output_schema_validation",
        failureCount: 3,
        summary: "Output schema not satisfied",
      },
    });

    renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Edit schema" }),
    );

    // The inspector opens on the halted context with Config selected, so the
    // refusing contract is one click from the halt that named it.
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Config" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });
});

describe("GraphWorkflowPanel — advisory index origin link (R9.4)", () => {
  // jsdom has no layout, so it does not implement the scroll the deep link
  // performs on its way to the round.
  Element.prototype.scrollIntoView = () => {};

  const SECURITY_HASH = `sha256:${"c".repeat(64)}`;

  const advisory = {
    kind: "plan" as const,
    title: "The plan skips the backfill",
    description: "Nothing writes the historic rows.",
    identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
    deliveredAt: "2026-03-27T10:05:00.000Z",
    disposition: null,
  };

  /**
   * The advisory was raised on round 1; the context has since run rounds 2 and
   * 3 and its state holds round 3. A link that carried only the context would
   * land on round 3, which never raised this advisory.
   */
  function executionWithAdvisory(): GraphWorkflowExecution {
    const base = createWorkflowExecution({
      status: "running",
      workingDefinition: createResolvedWorkflowDefinition(),
      advisoryIndex: [
        {
          identity: advisory.identity,
          kind: "plan",
          title: advisory.title,
          contextId: "context-implement",
        },
      ],
    });
    const state = base.contextStates["context-implement"];
    if (!state) throw new Error("fixture is missing context-implement state");
    return {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-implement": {
          ...state,
          validationRound: {
            seq: 3,
            candidate: {
              identityScope: "wholeTree",
              headSha: "head-3",
              candidateTreeHash: "tree-hash-3",
              taskStateHash: "tasks-3",
            },
            roster: [
              {
                assignmentId: "security",
                profileRef: { tier: "project", id: "security-reviewer" },
                revision: 4,
                resolvedInstructionHash: SECURITY_HASH,
                strategy: "conversation",
              },
            ],
            specialists: {
              security: {
                state: "verdict_pass",
                attempts: 1,
                summary: "Still nothing blocking.",
                issues: [],
                advisories: [],
                questionToken: null,
                sessionRef: null,
                reviewArtifact: null,
                lastInfraFailure: null,
              },
            },
            phase: "concluded",
            outcome: "passed",
            startedAt: "2026-03-27T12:00:00.000Z",
          },
        },
      },
    };
  }

  function roundEvents(): GraphWorkflowExecutionEvent[] {
    return [1, 2, 3].map((seq) => ({
      occurredAt: `2026-03-27T1${seq}:00:00.000Z`,
      preReset: false,
      event: {
        type: "graph-workflow-validation-result",
        projectName: "test-project",
        sessionName: "test-session",
        executionId: "execution-1",
        contextId: "context-implement",
        validatorType: "context",
        kind: "context_validation",
        pass: true,
        summary: `Round ${seq} concluded`,
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: seq,
        specialists: [
          {
            assignmentId: "security",
            profile: { tier: "project", id: "security-reviewer", revision: 4 },
            resolvedInstructionHash: SECURITY_HASH,
            pass: true,
            summary: "Nothing blocking.",
            issues: [],
            advisories: seq === 1 ? [advisory] : [],
            sessionRef: null,
            reviewArtifact: null,
            usage: null,
          },
        ],
      },
    }));
  }

  it("lands on the originating round, not the round the context has since reached", async () => {
    const { container } = renderWithQuery(
      <GraphWorkflowPanel
        execution={executionWithAdvisory()}
        events={roundEvents()}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    // The overview lists the advisory without any round having been opened.
    const origin = screen.getByTestId("advisory-index-origin");
    expect(origin).toHaveTextContent("Implement · Round 1 · security");

    fireEvent.click(origin);

    // The link lands on the context that raised it, at the tab where that
    // round's advisory text and disposition live.
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /history/i })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    // The inspector header names the context it switched to.
    expect(
      screen.getByRole("button", { name: /back/i }).parentElement,
    ).toHaveTextContent("Implement");

    // ...and on the ROUND that raised it, not the round the context reached.
    const focused = container.querySelectorAll('[data-focused-round="true"]');
    expect(focused).toHaveLength(1);
    expect(focused[0]).toHaveAttribute("data-round-seq", "1");
    expect(focused[0]).toHaveTextContent("Round 1 concluded");
  });
});
