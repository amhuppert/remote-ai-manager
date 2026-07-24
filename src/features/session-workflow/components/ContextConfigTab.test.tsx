// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import {
  buildInitialContextState,
  buildInitialTaskState,
} from "@/lib/workflow-graph/execution-state";
import ContextConfigTab from "./ContextConfigTab";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowResolvedContext,
  GraphWorkflowStatus,
  GraphWorkflowTaskDefinition,
} from "@/lib/workflow-graph/definition-schemas";

function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

function fullContext(): GraphWorkflowResolvedContext {
  return {
    id: "context-impl",
    title: "Implement",
    description: "Do the work",
    acceptanceCriteria: "It works",
    implementer: { backend: "claude", model: "opus", reasoningEffort: "high" },
    contextValidator: {
      type: "claude",
      enabled: true,
      continuity: { enabled: true, contextLimitTokens: 50000 },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    },
    scriptValidator: { enabled: true },
    humanApprovalGate: { enabled: true },
    askUserQuestions: { enabled: true },
    mutability: { allowAgentTaskAdd: true },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    collaboration: {
      enabled: { value: true, source: "per-node" },
      secondAgent: {
        value: { backend: "codex", model: "gpt-5.4", reasoningEffort: "high" },
        source: "per-node",
      },
      negotiationRounds: { value: 5, source: "per-node" },
      autonomousResolutionThreshold: { value: "major", source: "per-node" },
    },
  };
}

// A "started" runtime state: it ran (iterationCount > 0, worktree assigned), so
// the lifecycle classifier reports `started`.
function startedContextState(): GraphWorkflowExecutionContextState {
  return {
    contextId: "context-impl",
    status: "running",
    totalTaskCount: 4,
    completedTaskCount: 1,
    iterationCount: 3,
    consecutiveFailureCount: 0,
    worktreePath: "/tmp/wt-impl",
    branchName: "csm/impl-branch",
    isolation: "worktree",
    batchId: "batch-7",
    laneId: "lane-3",
    joinId: "join-2",
    mergeStatus: "merged-success",
    cleanupStatus: "removed",
    lastMergeError: "conflict in file.ts",
    pendingApproval: null,
    pendingUserInput: null,
  };
}

// An execution whose single context is `started` (ran already). Default status
// `paused` → quiescent → editable.
function startedExecution(
  context: GraphWorkflowResolvedContext,
  contextState: GraphWorkflowExecutionContextState,
  opts: { status?: GraphWorkflowStatus; activeContextIds?: string[] } = {},
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: opts.status ?? "paused",
    workingDefinition: {
      schemaVersion: 1,
      executionContexts: [context],
      tasks: [],
      edges: [],
    },
    activeContextIds: opts.activeContextIds ?? [],
    contextStates: { [context.id]: contextState },
    taskStates: {},
  });
}

// An execution whose single context sits in its pristine initial state → the
// lifecycle classifier reports `unstarted`.
function unstartedExecution(
  context: GraphWorkflowResolvedContext,
  opts: {
    status?: GraphWorkflowStatus;
    tasks?: GraphWorkflowTaskDefinition[];
  } = {},
): GraphWorkflowExecution {
  const tasks = opts.tasks ?? [];
  return createWorkflowExecution({
    status: opts.status ?? "running",
    workingDefinition: {
      schemaVersion: 1,
      executionContexts: [context],
      tasks,
      edges: [],
    },
    activeContextIds: [],
    contextStates: { [context.id]: buildInitialContextState(context, tasks) },
    taskStates: Object.fromEntries(
      tasks.map((task) => [task.id, buildInitialTaskState(task)]),
    ),
  });
}

describe("ContextConfigTab — display", () => {
  it("renders every resolved config field for an editable context", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState())}
        contextId="context-impl"
      />,
    );

    const impl = screen.getByTestId("config-block-implementer");
    expect(within(impl).getByText("Opus 5")).toBeInTheDocument();
    expect(within(impl).getByText("High")).toBeInTheDocument();
    expect(
      within(impl).getByRole("button", { name: "Claude" }),
    ).toHaveAttribute("data-active", "true");

    const val = screen.getByTestId("config-block-context-validator");
    expect(
      within(val).getByLabelText("Context validator enabled"),
    ).toBeChecked();
    expect(within(val).getByText("Sonnet")).toBeInTheDocument();
    expect(within(val).getByLabelText("Continuity enabled")).toBeChecked();
    expect(within(val).getByLabelText("Context limit tokens")).toHaveValue(
      50000,
    );

    expect(screen.getByLabelText("Script validator enabled")).toBeChecked();
    expect(screen.getByLabelText("Human approval gate enabled")).toBeChecked();
    expect(screen.getByLabelText("Ask user questions enabled")).toBeChecked();
    expect(screen.getByLabelText("Allow agent task add")).toBeChecked();

    expect(screen.getByTestId("config-iteration-count")).toHaveTextContent(
      "3 / 20",
    );
    expect(screen.getByLabelText("Max iterations")).toHaveValue(20);
    expect(screen.getByLabelText("Failure threshold")).toHaveValue(3);

    const collab = screen.getByTestId("config-block-collaboration");
    expect(
      within(collab).getByLabelText("Collaboration enabled"),
    ).toBeChecked();
    expect(within(collab).getByText("GPT-5.4")).toBeInTheDocument();
    expect(within(collab).getByLabelText("Negotiation rounds")).toHaveValue(5);
    expect(
      within(collab).getByRole("radio", { name: "major" }),
    ).toHaveAttribute("aria-checked", "true");

    // Prose fields
    expect(screen.getByLabelText("Context title")).toHaveValue("Implement");
    expect(screen.getByLabelText("Context acceptance criteria")).toHaveValue(
      "It works",
    );

    const runtime = screen.getByTestId("context-runtime");
    expect(within(runtime).getByTestId("runtime-isolation")).toHaveTextContent(
      "worktree",
    );
    expect(
      within(runtime).getByTestId("runtime-worktree-path"),
    ).toHaveTextContent("/tmp/wt-impl");
    expect(within(runtime).getByTestId("runtime-lane")).toHaveTextContent(
      "lane-3",
    );
    expect(
      within(runtime).getByTestId("runtime-last-merge-error"),
    ).toHaveTextContent("conflict in file.ts");
  });

  it("renders an off toggle for a null validator and omits absent collaboration", () => {
    const context = fullContext();
    context.contextValidator = null;
    delete (context as { collaboration?: unknown }).collaboration;

    render(
      <ContextConfigTab
        execution={startedExecution(context, startedContextState())}
        contextId="context-impl"
      />,
    );

    const val = screen.getByTestId("config-block-context-validator");
    expect(within(val).getByText(/off/i)).toBeInTheDocument();
    expect(
      within(val).getByLabelText("Context validator enabled"),
    ).not.toBeChecked();
    expect(
      screen.queryByTestId("config-block-collaboration"),
    ).not.toBeInTheDocument();
  });

  it("renders placeholders for unassigned runtime facts and hides an absent merge error", () => {
    const state = startedContextState();
    state.worktreePath = null;
    state.laneId = null;
    state.isolation = "session";
    state.lastMergeError = null;

    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), state)}
        contextId="context-impl"
      />,
    );

    const runtime = screen.getByTestId("context-runtime");
    expect(within(runtime).getByTestId("runtime-isolation")).toHaveTextContent(
      "session",
    );
    expect(
      within(runtime).getByTestId("runtime-worktree-path"),
    ).toHaveTextContent("—");
    expect(
      within(runtime).queryByTestId("runtime-last-merge-error"),
    ).not.toBeInTheDocument();
  });
});

describe("ContextConfigTab — context validator enabled field", () => {
  it("faithfully renders a configured-but-disabled validator: switch off, config still shown", () => {
    const context = fullContext();
    context.contextValidator = {
      type: "claude",
      enabled: false,
      continuity: { enabled: true },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    };

    render(
      <ContextConfigTab
        execution={startedExecution(context, startedContextState())}
        contextId="context-impl"
      />,
    );

    const val = screen.getByTestId("config-block-context-validator");
    // The switch reflects value.enabled, not mere presence.
    expect(
      within(val).getByLabelText("Context validator enabled"),
    ).not.toBeChecked();
    // AC2 requires type/model/etc. to display even for a disabled validator.
    expect(within(val).getByText("Sonnet")).toBeInTheDocument();
    expect(screen.queryByText(/off — no validator/i)).not.toBeInTheDocument();
  });

  it("enabling a disabled validator only flips enabled and preserves its config", () => {
    const onSaveContextConfig = vi.fn();
    const context = fullContext();
    context.contextValidator = {
      type: "codex",
      enabled: false,
      continuity: { enabled: true },
      codex: { model: "gpt-5.4", reasoningEffort: "high" },
    };

    render(
      <ContextConfigTab
        execution={startedExecution(context, startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    fireEvent.click(screen.getByLabelText("Context validator enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        contextValidator: {
          type: "codex",
          enabled: true,
          continuity: { enabled: true },
          codex: { model: "gpt-5.4", reasoningEffort: "high" },
        },
      },
    ]);
  });

  it("disabling an enabled validator preserves its config as enabled:false (never null)", () => {
    const onSaveContextConfig = vi.fn();

    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    fireEvent.click(screen.getByLabelText("Context validator enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        contextValidator: {
          type: "claude",
          enabled: false,
          continuity: { enabled: true, contextLimitTokens: 50000 },
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        },
      },
    ]);
  });

  it("seeds a default validator when enabling an absent (null) validator", () => {
    const onSaveContextConfig = vi.fn();
    const context = fullContext();
    context.contextValidator = null;

    render(
      <ContextConfigTab
        execution={startedExecution(context, startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    fireEvent.click(screen.getByLabelText("Context validator enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        contextValidator: {
          type: "claude",
          enabled: true,
          continuity: { enabled: true },
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        },
      },
    ]);
  });
});

describe("ContextConfigTab — disable matrix per lifecycle × execution status", () => {
  it("started context on a paused execution is editable", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Max iterations")).not.toBeDisabled();
    expect(screen.getByTestId("config-save-bar")).toBeInTheDocument();
    expect(
      screen.queryByTestId("config-affordance-pause-to-edit"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("config-affordance-frozen"),
    ).not.toBeInTheDocument();
  });

  it("started context on a running execution shows pause-to-edit and disables controls", () => {
    const onPauseExecution = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "running",
          activeContextIds: ["context-impl"],
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
        onPauseExecution={onPauseExecution}
      />,
    );

    expect(screen.getByLabelText("Max iterations")).toBeDisabled();
    expect(screen.queryByTestId("config-save-bar")).not.toBeInTheDocument();

    const pauseButton = screen.getByRole("button", { name: "Pause to edit" });
    fireEvent.click(pauseButton);
    expect(onPauseExecution).toHaveBeenCalledTimes(1);
  });

  it("unstarted context is editable even while the execution is running", () => {
    render(
      <ContextConfigTab
        execution={unstartedExecution(fullContext(), { status: "running" })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Max iterations")).not.toBeDisabled();
    expect(screen.getByTestId("config-save-bar")).toBeInTheDocument();
    expect(
      screen.queryByTestId("config-affordance-pause-to-edit"),
    ).not.toBeInTheDocument();
  });

  it("completed context is frozen: read-only with a lock affordance", () => {
    const state = startedContextState();
    state.status = "completed";
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), state, { status: "paused" })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    expect(screen.getByTestId("config-affordance-frozen")).toBeInTheDocument();
    expect(screen.getByLabelText("Max iterations")).toBeDisabled();
    expect(screen.queryByTestId("config-save-bar")).not.toBeInTheDocument();
  });

  it("completed execution renders a read-only banner", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "completed",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    expect(screen.getByTestId("config-affordance-readonly")).toHaveTextContent(
      /completed/i,
    );
    expect(screen.getByLabelText("Max iterations")).toBeDisabled();
    expect(screen.queryByTestId("config-save-bar")).not.toBeInTheDocument();
  });

  it("non-resumably-halted execution renders a read-only banner", () => {
    const execution = startedExecution(fullContext(), startedContextState(), {
      status: "halted",
    });
    execution.haltReason = { type: "recovery_error", message: "boom" };
    render(
      <ContextConfigTab
        execution={execution}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("config-affordance-readonly"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("config-save-bar")).not.toBeInTheDocument();
  });
});

describe("ContextConfigTab — edit payload shape", () => {
  it("composes a single update-context op carrying only the changed field", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    // Save is disabled until the draft diverges from the resolved config.
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "10" },
    });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);

    expect(onSaveContextConfig).toHaveBeenCalledTimes(1);
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        iterationPolicy: { maxIterations: 10, continuity: { enabled: true } },
      },
    ]);
  });

  it("wraps a collaboration edit back into provenanced per-node values", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    const collab = screen.getByTestId("config-block-collaboration");
    fireEvent.change(within(collab).getByLabelText("Negotiation rounds"), {
      target: { value: "8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        collaboration: {
          enabled: { value: true, source: "per-node" },
          secondAgent: {
            value: {
              backend: "codex",
              model: "gpt-5.4",
              reasoningEffort: "high",
            },
            source: "per-node",
          },
          negotiationRounds: { value: 8, source: "per-node" },
          autonomousResolutionThreshold: { value: "major", source: "per-node" },
        },
      },
    ]);
  });

  it("saves collaboration enablement with per-node provenance", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    fireEvent.click(screen.getByLabelText("Collaboration enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "update-context",
        contextId: "context-impl",
        collaboration: expect.objectContaining({
          enabled: { value: false, source: "per-node" },
        }),
      }),
    ]);
  });

  it("shows a visible saving state while the mutation is pending", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
        isSaving
      />,
    );

    const saveButton = screen.getByRole("button", { name: "Saving…" });
    expect(saveButton).toBeDisabled();
  });
});

describe("ContextConfigTab — pause-to-edit → save → resume flow", () => {
  it("becomes editable after the execution is paused", () => {
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "running",
          activeContextIds: ["context-impl"],
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
        onPauseExecution={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("config-affordance-pause-to-edit"),
    ).toBeInTheDocument();

    // Pausing demotes the running context to `ready`; still `started` but now
    // quiescent → editable.
    const pausedState = startedContextState();
    pausedState.status = "ready";
    rerender(
      <ContextConfigTab
        execution={startedExecution(fullContext(), pausedState, {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
        onPauseExecution={vi.fn()}
      />,
    );

    expect(
      screen.queryByTestId("config-affordance-pause-to-edit"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("config-save-bar")).toBeInTheDocument();
  });

  it("offers Resume after a successful save on a paused started context", () => {
    const onResumeExecution = vi.fn();
    const pausedState = startedContextState();
    pausedState.status = "ready";
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), pausedState, {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
        onResumeExecution={onResumeExecution}
        saveSucceeded
      />,
    );

    const resumeButton = screen.getByRole("button", {
      name: "Resume workflow",
    });
    fireEvent.click(resumeButton);
    expect(onResumeExecution).toHaveBeenCalledTimes(1);
  });

  it("does not offer Resume while the draft still has unsaved changes", () => {
    const pausedState = startedContextState();
    pausedState.status = "ready";
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), pausedState, {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
        onResumeExecution={vi.fn()}
        saveSucceeded
      />,
    );

    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "9" },
    });
    expect(
      screen.queryByRole("button", { name: "Resume workflow" }),
    ).not.toBeInTheDocument();
  });
});

describe("ContextConfigTab — revision-conflict recovery", () => {
  it("surfaces a retry notice and preserves unsaved edits across a same-context refetch", () => {
    const context = fullContext();
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(context, startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "12" },
    });

    // The refetch after a 409 delivers a fresh execution object (same context)
    // plus the conflict flag. The user's edit must survive.
    const refreshed = startedExecution(context, startedContextState(), {
      status: "paused",
    });
    refreshed.liveRevision = 7;
    rerender(
      <ContextConfigTab
        execution={refreshed}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
        editConflict
      />,
    );

    expect(screen.getByTestId("config-affordance-conflict")).toHaveTextContent(
      /execution changed/i,
    );
    expect(screen.getByLabelText("Max iterations")).toHaveValue(12);
    expect(
      screen.getByRole("button", { name: "Save changes" }),
    ).not.toBeDisabled();
  });

  it("rebases on a conflict refetch: keeps the user's edit, drops a concurrently-changed field from the retry payload", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    // The user edits max iterations and leaves the title untouched.
    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "12" },
    });

    // A concurrent editor renamed the context; the 409 refetch delivers it.
    const concurrent = fullContext();
    concurrent.title = "Renamed by another editor";
    const refreshed = startedExecution(concurrent, startedContextState(), {
      status: "paused",
    });
    refreshed.liveRevision = 9;
    rerender(
      <ContextConfigTab
        execution={refreshed}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
        editConflict
      />,
    );

    // The untouched title adopts the fresh concurrent value...
    expect(screen.getByLabelText("Context title")).toHaveValue(
      "Renamed by another editor",
    );
    // ...while the user's own edit survives.
    expect(screen.getByLabelText("Max iterations")).toHaveValue(12);

    // Retrying sends ONLY the user's field — never the concurrent rename.
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        iterationPolicy: { maxIterations: 12, continuity: { enabled: true } },
      },
    ]);
  });

  it("re-seeds the draft when the selected context changes", () => {
    const first = fullContext();
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(first, startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "99" },
    });

    const second = fullContext();
    second.id = "context-other";
    second.iterationPolicy = {
      maxIterations: 15,
      continuity: { enabled: true },
    };
    rerender(
      <ContextConfigTab
        execution={startedExecution(second, startedContextState(), {
          status: "paused",
        })}
        contextId="context-other"
        onSaveContextConfig={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Max iterations")).toHaveValue(15);
  });
});
