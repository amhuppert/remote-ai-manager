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
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
} from "@/lib/workflow-graph/test-fixtures";
import { renderWithQuery } from "@/test/component-mocks";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import GraphWorkflowPanel from "./GraphWorkflowPanel";
import WorkflowConversationViewer from "./WorkflowConversationViewer";
import { resolveViewingTask } from "./view-task-resolver";

const noopCallbacks = {
  projectName: "test-project",
  sessionName: "test-session",
  onPause: vi.fn(),
  onResume: vi.fn(),
  onAbort: vi.fn(),
  onClear: vi.fn(),
  onApproveDefinition: vi.fn(),
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
  definitionApprovalError: null,
  configEditConflict: false,
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

  it("offers the definition-approval recovery action for a parked execution", async () => {
    const onApproveDefinition = vi.fn();
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
      />,
    );

    expect(screen.getByText("Definition awaiting approval")).toBeVisible();
    const approve = screen.getByRole("button", {
      name: "Approve definition & start",
    });
    await userEvent.click(approve);

    expect(onApproveDefinition).toHaveBeenCalledTimes(1);
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

  // The assignment-cutover migration empties the active execution table, so
  // this empty state is exactly where every affected session lands. Its
  // archived runs — and the reason they were ended — must be reachable here.
  it("surfaces archived runs and their cutover abort reason in the empty state", () => {
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

    expect(screen.getByText(/exec-cutover/)).toBeInTheDocument();
    expect(
      screen.getByText(/ended by a Command Center schema cutover/i),
    ).toBeInTheDocument();
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

  it("shows only Clear button when execution is completed", () => {
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
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("shows Resume and Clear buttons when execution is halted", () => {
    const onResume = vi.fn();
    const onClear = vi.fn();

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

  it("shows only Clear button when execution is aborted", () => {
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

    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort" })).toBeNull();
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
        scriptValidator: { enabled: false },
        humanApprovalGate: { enabled: false },
        askUserQuestions: { enabled: false },
        mutability: { allowAgentTaskAdd: false },
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
