// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
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
    // The refusal has to belong to a save THIS context submitted — the
    // runtime-edit mutation is shared across the whole execution, so an
    // unsubmitted context must not adopt its error.
    const onSaveContextConfig = vi.fn();
    const client = createTestQueryClient();
    const paused = createWorkflowExecution({ status: "paused" });
    const panel = (props: { configEditError?: string }) => (
      <QueryClientProvider client={client}>
        <GraphWorkflowPanel
          execution={paused}
          events={[]}
          archivedExecutions={[]}
          {...noopCallbacks}
          onSaveContextConfig={onSaveContextConfig}
          {...props}
        />
      </QueryClientProvider>
    );
    const view = render(panel({}));

    const contextTitle = screen.getByText("Implement");
    const contextNode = contextTitle.closest(".react-flow__node");
    expect(contextNode).not.toBeNull();
    fireEvent.click(contextNode!);
    await userEvent.click(screen.getByRole("tab", { name: "Config" }));

    await userEvent.click(
      screen.getByRole("button", { name: /Execution policy/ }),
    );
    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveContextConfig).toHaveBeenCalledTimes(1);

    view.rerender(
      panel({ configEditError: 'Unknown validation command "premerge".' }),
    );

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

    expect(screen.getByTestId("execution-status-summary")).toHaveTextContent(
      "Definition awaiting approval · the snapshot is frozen for the decision",
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onApproveDefinition).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
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

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
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
    const base = createWorkflowExecution({
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
    const planState = base.contextStates["context-plan"];
    if (planState === undefined) {
      throw new Error("fixture no longer states context-plan");
    }
    // Active membership alone is not liveness — a gate keeps a context in
    // activeContextIds — so a genuinely running context has to say so.
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": { ...planState, status: "running" },
      },
    };

    renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    expect(screen.getAllByText("running").length).toBeGreaterThanOrEqual(1);
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

    // Abort is destructive, so it confirms before it fires (README §9).
    const abortBtn = screen.getByRole("button", { name: "Abort" });
    fireEvent.click(abortBtn);
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Abort execution",
      }),
    );
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

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
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

    expect(screen.getByTestId("execution-status-summary")).toHaveTextContent(
      "Definition awaiting approval",
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
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

    // README §11 puts the approval trail on Overview → Approvals.
    fireEvent.click(screen.getByTestId("overview-row-approvals"));
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
            modelSelection: {
              modelId: "gpt-5.4-mini",
              parameters: { reasoning: "medium", fast: "false" },
            },
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
        consecutiveCandidateMismatchCount: 0,
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

  // The Log header titles the CONVERSATION, not the task that opened it. A lane
  // runs several tasks in one conversation, so completing a task retires the
  // task and not the conversation: calling it ended here would tell the reader
  // a transcript that is still being written to has stopped.
  it("still calls the conversation live when its task completed but the lane holds it", () => {
    const execution = createCodexExecutionWithRunningTask();
    execution.taskStates["task-codex-1"]!.status = "completed";
    execution.taskStates["task-codex-1"]!.completedAt =
      "2026-03-27T16:20:00.000Z";
    execution.laneStates = {
      "context-codex-impl": {
        implementer: {
          lane: "implementer",
          contextId: "context-codex-impl",
          backend: "codex",
          refKind: "conversation",
          workflowConversationId: "cc-conv-codex-abc",
          metrics: { rotateBeforeNextTurn: false },
          limitEvaluation: "supported",
          lastUsedAt: "2026-03-27T16:20:00.000Z",
        },
      },
    };

    expect(resolveViewingTask(execution, "task-codex-1")?.isLive).toBe(true);
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

    // Live for the same reason the codex task above is: a running task names
    // the conversation the context is working in. The two backends answer
    // identically for identical situations, which is the parity claimed here.
    expect(resolved).toEqual({
      conversationId: "cc-conv-claude-xyz",
      contextTitle: "Plan",
      taskTitle: "Inspect code",
      isLive: true,
    });
  });

  // The pill tracks whether another turn is possible, not what the lane record
  // still says. A halt that nothing can resume holds no execution lease.
  it("calls the conversation ended once the run holds no execution lease", () => {
    const execution = createCodexExecutionWithRunningTask();
    const halted: GraphWorkflowExecution = {
      ...execution,
      status: "halted",
      haltReason: { type: "recovery_error", message: "worktree vanished" },
    };

    expect(resolveViewingTask(halted, "task-codex-1")?.isLive).toBe(false);
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
        role="Implementer"
        contextTitle={resolved!.contextTitle}
        taskTitle={resolved!.taskTitle}
        onClose={vi.fn()}
      />,
    );

    // Header surfaces the codex context + task titles unchanged.
    const breadcrumb = screen.getByTestId("transcript-breadcrumb");
    expect(breadcrumb).toHaveTextContent("Codex Implement");
    expect(breadcrumb).toHaveTextContent("Ship Codex feature");
    // Live indicator is present (codex task is running).
    expect(screen.getByTestId("transcript-status")).toHaveTextContent("live");

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
        role="Implementer"
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
      screen.queryByRole("button", {
        name: "Close transcript and return to graph",
      }),
    ).toBeNull();
    // Panel still renders normal status bar + codex context — proves the panel
    // handles codex executions through its default path.
    expect(screen.getAllByText("running").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText("Codex Implement").length,
    ).toBeGreaterThanOrEqual(1);
  });

  // README §11 semantic navigation: task or validator → Log transcript, and
  // close transcript → Graph. On the desktop the transcript REPLACES the canvas,
  // so closing has to put the graph back rather than merely emptying the panel.
  it("returns to the graph when the Log surface is closed", async () => {
    const execution = createCodexExecutionWithRunningTask();

    const { container } = renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    expect(container.querySelector(".react-flow")).not.toBeNull();

    fireEvent.click(screen.getAllByText("Codex Implement")[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Watch" }));

    expect(screen.getByTestId("wf-transcript-viewer")).toBeInTheDocument();
    expect(container.querySelector(".react-flow")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Close transcript and return to graph",
      }),
    );

    expect(screen.queryByTestId("wf-transcript-viewer")).toBeNull();
    expect(container.querySelector(".react-flow")).not.toBeNull();
  });

  // The Log header answers live/ended for the conversation as it stands NOW,
  // not as it stood when the reader opened it. A run settles while the panel is
  // open often enough — the last verdict lands, the context completes — and a
  // pill answered once would keep pulsing at a transcript nobody is writing to.
  it("stops calling an open conversation transcript live once the run settles", async () => {
    const execution = createCodexExecutionWithRunningTask();
    execution.laneStates = {
      "context-codex-impl": {
        implementer: {
          lane: "implementer",
          contextId: "context-codex-impl",
          backend: "codex",
          refKind: "conversation",
          workflowConversationId: "cc-conv-codex-abc",
          metrics: { rotateBeforeNextTurn: false },
          limitEvaluation: "supported",
          lastUsedAt: "2026-03-27T16:20:00.000Z",
        },
      },
    };
    const queryClient = createTestQueryClient();
    const panel = (current: GraphWorkflowExecution) => (
      <QueryClientProvider client={queryClient}>
        <GraphWorkflowPanel
          execution={current}
          events={[]}
          archivedExecutions={[]}
          {...noopCallbacks}
        />
      </QueryClientProvider>
    );
    const view = render(panel(execution));

    fireEvent.click(screen.getAllByText("Codex Implement")[0]!);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /History/ }));
    fireEvent.click(screen.getByTestId("conversation-transcript-button"));
    expect(screen.getByTestId("transcript-status")).toHaveTextContent("live");

    view.rerender(panel({ ...execution, status: "completed" }));

    expect(screen.getByTestId("transcript-status")).toHaveTextContent("ended");
  });

  it("deep-links Edit schema to the halted context's Config tab (R3.2)", async () => {
    // jsdom has no layout, so the panel's scroll restoration is a no-op here;
    // the destination is observable from the screen it lands on instead.
    Element.prototype.scrollIntoView = () => {};

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

    // …and at the Brief → Output schema screen, not merely on the tab: the
    // typed destination carries a screen, and the contract that refused the run
    // is what the reader is sent to.
    await waitFor(() => {
      expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
        "Output schema",
      );
    });
    expect(screen.getByLabelText("Output schema JSON")).toBeInTheDocument();
  });
});

describe("GraphWorkflowPanel — join conflict recovery (E2)", () => {
  function joinFailureExecution(): GraphWorkflowExecution {
    const base = createWorkflowExecution({
      status: "halted",
      haltReason: {
        type: "join_failure",
        joinId: "join_delivery_1",
        joinKind: "context_merge",
        contextId: "context-implement",
        sourceLaneIds: ["lane-plan", "lane-implement"],
        targetLaneId: "delivery",
        message: "merge conflict",
        conflictFiles: ["src/checkout/audit.ts"],
      },
    });
    // Per-source join progress as the engine persists it: on the join record,
    // not on the member contexts. A context_merge join stamps `joinId` on its
    // downstream target alone, so nothing here fakes a per-context merge state.
    return {
      ...base,
      joins: {
        join_delivery_1: {
          joinId: "join_delivery_1",
          kind: "context_merge",
          contextId: "context-implement",
          targetLaneId: "delivery",
          sourceLaneIds: ["lane-plan", "lane-implement"],
          mergedSourceLaneIds: ["lane-plan"],
          validationDebtSourceLaneIds: [],
          sourceLaneContextIds: {
            "lane-plan": ["context-plan"],
            "lane-implement": ["context-implement"],
          },
          status: "conflicts",
          errorMessage: "both wrote the timeout branch",
          conflicts: {
            files: ["src/checkout/audit.ts"],
            message: "merge conflict",
            analysis: null,
          },
          conflictGuidance: null,
          createdAt: "2026-03-27T09:00:00.000Z",
          updatedAt: "2026-03-27T09:30:00.000Z",
          completedAt: null,
        },
      },
      executionLanes: {
        "lane-plan": {
          laneId: "lane-plan",
          kind: "worktree",
          status: "active",
          worktreePath: "/tmp/lane-plan",
          branchName: "wf/lane-plan",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
          commitSnapshots: [],
          createdAt: "2026-03-27T09:00:00.000Z",
          updatedAt: "2026-03-27T09:30:00.000Z",
        },
        "lane-implement": {
          laneId: "lane-implement",
          kind: "worktree",
          status: "active",
          worktreePath: "/tmp/lane-implement",
          branchName: "wf/lane-implement",
          includedContextIds: ["context-implement"],
          lastCommittingContextId: "context-implement",
          commitSnapshots: [],
          createdAt: "2026-03-27T09:00:00.000Z",
          updatedAt: "2026-03-27T09:30:00.000Z",
        },
      },
    };
  }

  it("names the lane, its members and sends Edit ownership to the blocked member's placement", async () => {
    // jsdom has no layout, so the panel's scroll restoration is a no-op here;
    // the destination is observable from the screen it lands on instead.
    Element.prototype.scrollIntoView = () => {};

    renderWithQuery(
      <GraphWorkflowPanel
        execution={joinFailureExecution()}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Join conflict — delivery"),
    ).toBeInTheDocument();
    expect(within(dialog).getByTestId("join-members")).toHaveTextContent(
      "blocked · Implement → delivery — both wrote the timeout branch",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Edit ownership" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Config" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
        "Placement",
      );
    });
  });

  it("sends Open lane worktree to the blocked member's runtime", async () => {
    Element.prototype.scrollIntoView = () => {};

    renderWithQuery(
      <GraphWorkflowPanel
        execution={joinFailureExecution()}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open lane worktree" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Config" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    // The lane's branch, worktree and merge state live on Placement in the
    // config panel, so that is where "Open lane worktree" lands.
    await waitFor(() => {
      expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
        "Placement",
      );
    });
  });
});

describe("GraphWorkflowPanel — gates chip (README §10)", () => {
  function executionWithTwoGates(): GraphWorkflowExecution {
    const base = createWorkflowExecution({ status: "running" });
    const planState = base.contextStates["context-plan"]!;
    const implementState = base.contextStates["context-implement"]!;
    return {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...planState,
          status: "awaiting_approval",
          pendingApproval: {
            conversationId: "conv-approval",
            requestedAt: "2026-03-27T10:00:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" as const },
          },
        },
        "context-implement": {
          ...implementState,
          status: "awaiting_user_input",
          pendingUserInputs: {
            implementer: {
              lane: "implementer",
              roundSeq: 1,
              conversationId: "conv-1",
              questionBatchId: "batch-1",
              questions: [
                {
                  id: "q1",
                  question: "Should the toggle default to on?",
                  header: "Toggle",
                  multiSelect: false,
                  required: true,
                  allowNote: true,
                  options: [
                    { label: "yes", recommended: true, description: "" },
                  ],
                },
              ],
              requestedAt: "2026-03-27T10:00:00.000Z",
              answers: null,
            },
          },
        },
      },
    };
  }

  it("opens the gates list from the status bar's chip", async () => {
    renderWithQuery(
      <GraphWorkflowPanel
        execution={executionWithTwoGates()}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "2 gates awaiting you" }),
    );

    const list = await screen.findByTestId("execution-gates-list");
    const rows = within(list).getAllByTestId("execution-gate-row");
    expect(rows[0]).toHaveTextContent("Plan");
    expect(rows[0]).toHaveTextContent("context approval");
    expect(rows[1]).toHaveTextContent("Implement");
    expect(rows[1]).toHaveTextContent(
      'parked question · "Should the toggle default to on?"',
    );
  });

  it("opens the context a gate row names", async () => {
    renderWithQuery(
      <GraphWorkflowPanel
        execution={executionWithTwoGates()}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "2 gates awaiting you" }),
    );
    const list = await screen.findByTestId("execution-gates-list");
    fireEvent.click(within(list).getAllByTestId("execution-gate-row")[1]!);

    // The inspector leaves the Overview for the context that holds the gate.
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  // README §10: there is no single global gate. Two parked approvals are two
  // waits on two contexts, so opening one row must show THAT context's decision
  // and nothing else — a stack of every approval card above the canvas is the
  // surface the redesign removes.
  it("opens one context's approval surface, not every open approval", async () => {
    const base = executionWithTwoGates();
    const reviewState = base.contextStates["context-verify"]!;
    const twoApprovals: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-verify": {
          ...reviewState,
          status: "awaiting_approval",
          pendingApproval: {
            conversationId: "conv-approval-2",
            requestedAt: "2026-03-27T10:05:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" as const },
          },
        },
      },
    };

    renderWithQuery(
      <GraphWorkflowPanel
        execution={twoApprovals}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
        renderContextApproval={(contextId) => (
          <div data-testid={`approval-card-${contextId}`}>
            Context approval — {contextId}
          </div>
        )}
      />,
    );

    // Nothing is selected yet, so no decision surface is on screen at all.
    expect(screen.queryByTestId(/^approval-card-/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "3 gates awaiting you" }),
    );
    const list = await screen.findByTestId("execution-gates-list");
    const approvalRows = within(list)
      .getAllByTestId("execution-gate-row")
      .filter((row) => row.dataset.gateKind === "approval");
    expect(approvalRows).toHaveLength(2);
    fireEvent.click(approvalRows[0]!);

    await waitFor(() => {
      expect(
        screen.getByTestId("approval-card-context-plan"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("approval-card-context-verify"),
    ).not.toBeInTheDocument();
  });

  // The gate row is only useful if it lands on the thing that clears the gate.
  // A parked question's row has to reach the answering surface itself, not just
  // the context that happens to hold it.
  it("lands a parked question's row on the surface that answers it", async () => {
    renderWithQuery(
      <GraphWorkflowPanel
        execution={executionWithTwoGates()}
        events={[]}
        archivedExecutions={[]}
        {...noopCallbacks}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "2 gates awaiting you" }),
    );
    const list = await screen.findByTestId("execution-gates-list");
    fireEvent.click(within(list).getAllByTestId("execution-gate-row")[1]!);

    const panel = await screen.findByTestId("parked-question-panel");
    expect(panel).toHaveAttribute("data-lane-key", "implementer");
    expect(
      within(panel).getByText("Should the toggle default to on?"),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("radio", { name: /yes/ })).toBeEnabled();
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

    // The overview's Advisories drill lists the advisory without any round
    // having been opened (README §11, screen E3).
    fireEvent.click(screen.getByTestId("overview-row-advisories"));
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

describe("GraphWorkflowPanel inspector rail collapse", () => {
  it("collapses the 420px inspector rail from the status bar and restores it", async () => {
    renderWithQuery(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({ id: "exec-collapse" })}
        events={[]}
        {...noopCallbacks}
      />,
    );

    expect(screen.getByRole("complementary")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Collapse inspector" }),
    );
    expect(screen.queryByRole("complementary")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Expand inspector" }),
    );
    expect(screen.getByRole("complementary")).toBeInTheDocument();
  });

  it("holds the inspector at the design's one approved width exception", () => {
    renderWithQuery(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({ id: "exec-width" })}
        events={[]}
        {...noopCallbacks}
      />,
    );

    // jsdom computes no layout, so the authored width is the only evidence
    // available — and 420px is a spec constant, not a free layout choice.
    expect(screen.getByRole("complementary").className).toContain("w-[420px]");
  });

  it("keeps the inspector mounted on mobile, where the tab bar owns panel choice", () => {
    renderWithQuery(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({ id: "exec-mobile" })}
        events={[]}
        {...noopCallbacks}
        isMobile
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Collapse inspector" }),
    ).toBeNull();
    expect(screen.getByRole("complementary")).toBeInTheDocument();
  });
});

/**
 * A run whose lanes have actually moved: one merged, one holding the live
 * context, one never entered, and the reserved session lane a final-publish
 * join targets. The default fixture's lanes are all pending, so the band
 * runtime states have nothing to distinguish without this.
 */
function executionWithRuntimeLanes(): GraphWorkflowExecution {
  const definition = createResolvedWorkflowDefinition();
  const verifyContext = definition.executionContexts.find(
    (context) => context.id === "context-verify",
  );
  if (verifyContext === undefined) {
    throw new Error("fixture no longer defines context-verify");
  }

  const lane = (
    laneId: string,
    kind: "session" | "worktree",
    status: "pending" | "active" | "merged",
    includedContextIds: string[],
  ) => ({
    laneId,
    kind,
    status,
    worktreePath: kind === "session" ? null : `/tmp/lanes/${laneId}`,
    branchName: `cc/lane-${laneId}`,
    includedContextIds,
    lastCommittingContextId: null,
    commitSnapshots: [],
    createdAt: "2026-08-20T09:00:00.000Z",
    updatedAt: "2026-08-20T09:30:00.000Z",
  });

  const base = createWorkflowExecution({
    id: "exec-lane-runtime",
    status: "running",
    workingDefinition: {
      ...definition,
      executionContexts: [
        ...definition.executionContexts,
        {
          ...verifyContext,
          id: "context-publish",
          title: "Publish",
          placement: { lane: "session", mode: "readOnly" },
        },
      ],
    },
    activeContextIds: ["context-implement"],
    executionLanes: {
      plan: lane("plan", "worktree", "merged", ["context-plan"]),
      implement: lane("implement", "worktree", "active", ["context-implement"]),
      __session__: lane("__session__", "session", "active", [
        "context-publish",
      ]),
    },
    joins: {
      "join-publish": {
        joinId: "join-publish",
        kind: "final_publish",
        contextId: null,
        targetLaneId: "__session__",
        sourceLaneIds: ["implement"],
        mergedSourceLaneIds: [],
        validationDebtSourceLaneIds: [],
        status: "pending",
        errorMessage: null,
        conflicts: null,
        conflictGuidance: null,
        createdAt: "2026-08-20T09:00:00.000Z",
        updatedAt: "2026-08-20T09:00:00.000Z",
        completedAt: null,
      },
    },
  });

  const verifyState = base.contextStates["context-verify"];
  if (verifyState === undefined) {
    throw new Error("fixture no longer states context-verify");
  }

  return {
    ...base,
    contextStates: {
      ...base.contextStates,
      "context-publish": {
        ...verifyState,
        contextId: "context-publish",
        laneId: "__session__",
      },
    },
  };
}

describe("GraphWorkflowPanel lane canvas assembly", () => {
  it("groups the canvas into lane bands derived from the mounted execution", async () => {
    const { container } = renderWithQuery(
      <GraphWorkflowPanel
        execution={createWorkflowExecution({ id: "exec-lanes" })}
        events={[]}
        {...noopCallbacks}
      />,
    );

    await waitFor(() =>
      expect(
        container.querySelectorAll('[data-testid="lane-band"]').length,
      ).toBeGreaterThan(0),
    );
    const laneNames = [
      ...container.querySelectorAll('[data-testid="lane-band"]'),
    ].map((band) => band.getAttribute("data-lane-name"));
    expect(laneNames).toEqual(
      expect.arrayContaining(["plan", "implement", "verify"]),
    );
  });

  it("colours each band from the run's own lane records and names the publication target", async () => {
    const { container } = renderWithQuery(
      <GraphWorkflowPanel
        execution={executionWithRuntimeLanes()}
        events={[]}
        {...noopCallbacks}
      />,
    );

    await waitFor(() =>
      expect(
        container.querySelectorAll('[data-testid="lane-band"]').length,
      ).toBe(4),
    );

    const band = (laneName: string): HTMLElement => {
      const found = container.querySelector<HTMLElement>(
        `[data-testid="lane-band"][data-lane-name="${laneName}"]`,
      );
      if (found === null) throw new Error(`no band for lane ${laneName}`);
      return found;
    };

    // A merged lane, the lane holding the live context, an untouched lane, and
    // the reserved session lane — each state read off the execution, not a prop.
    expect(band("plan").dataset["laneState"]).toBe("merged");
    expect(band("implement").dataset["laneState"]).toBe("active");
    expect(band("verify").dataset["laneState"]).toBe("pending");
    expect(band("session").dataset["laneState"]).toBe("session");
    expect(band("session").dataset["reserved"]).toBe("true");

    // The final-publish join is stated on both ends: the source lane says where
    // it publishes, the session lane says it is what receives the publication.
    expect(
      within(band("implement")).getByTestId("lane-band-runtime"),
    ).toHaveTextContent("publishes → session");
    expect(
      within(band("session")).getByTestId("lane-band-runtime"),
    ).toHaveTextContent("publication target");
    expect(
      within(band("session")).getByTestId("lane-band-status"),
    ).toHaveTextContent("reserved · read-only");
  });

  it("renders the E1 publication pill naming source, target and completion condition", async () => {
    const { container } = renderWithQuery(
      <GraphWorkflowPanel
        execution={executionWithRuntimeLanes()}
        events={[]}
        {...noopCallbacks}
      />,
    );

    const pill = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        '[data-testid="lane-band-publication"]',
      );
      if (found === null) throw new Error("no publication pill on the canvas");
      return found;
    });

    // The pill states the relation between lanes, which no single band header
    // can: who publishes, into what, and what the publish waits on.
    expect(pill).toHaveTextContent(
      "publication: implement → session, after every member completes",
    );
    // A drawn icon, never a Unicode glyph standing in for one.
    expect(pill.querySelector("svg")).not.toBeNull();
  });

  it("still renders the publication pill when the session lane holds no context", async () => {
    // The ordinary shape of a real final_publish run: the session lane exists to
    // receive the publish and carries no member of its own, so it contributes no
    // node and therefore no band box. The pill describes the run, not the band,
    // so it must survive its target lane having nothing to wrap.
    const base = executionWithRuntimeLanes();
    const sessionLane = base.executionLanes["__session__"];
    if (sessionLane === undefined) {
      throw new Error("fixture no longer defines the session lane");
    }
    const { "context-publish": _publishState, ...contextStates } =
      base.contextStates;
    const execution: GraphWorkflowExecution = {
      ...base,
      workingDefinition: {
        ...base.workingDefinition,
        executionContexts: base.workingDefinition.executionContexts.filter(
          (context) => context.id !== "context-publish",
        ),
      },
      executionLanes: {
        ...base.executionLanes,
        __session__: { ...sessionLane, includedContextIds: [] },
      },
      contextStates,
    };

    const { container } = renderWithQuery(
      <GraphWorkflowPanel
        execution={execution}
        events={[]}
        {...noopCallbacks}
      />,
    );

    const pill = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        '[data-testid="lane-band-publication"]',
      );
      if (found === null) throw new Error("no publication pill on the canvas");
      return found;
    });

    expect(pill).toHaveTextContent(
      "publication: implement → session, after every member completes",
    );
  });
});
