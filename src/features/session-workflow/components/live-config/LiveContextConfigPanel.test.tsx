// @vitest-environment jsdom
/**
 * The §8.2 live edit flow, end to end over the real panel: pause to edit →
 * editable → dirty → blocked or submitted → landed or refused → resume.
 *
 * These are the transitions no single module owns — each step is a different
 * collaborator (the classifier, the draft diff, the two validations, the
 * mutation's flags), and the flow is only correct if they hand off in order.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildInitialTaskState } from "@/lib/workflow-graph/execution-state";
import type {
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import {
  createWorkflowExecution,
  makeProfileSnapshot,
} from "@/lib/workflow-graph/test-fixtures";
import LiveContextConfigPanel from "./LiveContextConfigPanel";

const CONTEXT_ID = "context-impl";

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

function context(
  overrides: Partial<GraphWorkflowResolvedContext> = {},
): GraphWorkflowResolvedContext {
  return {
    id: CONTEXT_ID,
    title: "Implement",
    acceptanceCriteria: "It works",
    placement: { lane: "delivery", mode: "full" },
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: {
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
      },
    },
    contextValidator: { enabled: false, assignments: [] },
    scriptValidator: { commands: [] },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20 },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    ...overrides,
  };
}

/** Ran already (iterations, a worktree) → the lifecycle reports `started`. */
function startedState(): GraphWorkflowExecutionContextState {
  return {
    skipReason: null,
    landingIntent: null,
    contextId: CONTEXT_ID,
    status: "running",
    totalTaskCount: 2,
    completedTaskCount: 1,
    iterationCount: 3,
    consecutiveFailureCount: 0,
    consecutiveCandidateMismatchCount: 0,
    worktreePath: "/tmp/wt",
    branchName: "csm/impl",
    isolation: "worktree",
    batchId: "batch-1",
    laneId: "delivery",
    joinId: "join-1",
    mergeStatus: "pending",
    cleanupStatus: "pending",
    lastMergeError: null,
    pendingApproval: null,
    pendingUserInputs: {},
  };
}

function execution(
  overrides: Partial<GraphWorkflowExecution> = {},
  resolved: GraphWorkflowResolvedContext = context(),
  tasks: GraphWorkflowTaskDefinition[] = [],
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "paused",
    workingDefinition: {
      schemaVersion: 1,
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
      executionContexts: [resolved],
      tasks,
      edges: [],
    },
    activeContextIds: [],
    contextStates: { [CONTEXT_ID]: startedState() },
    taskStates: Object.fromEntries(
      tasks.map((task) => [task.id, buildInitialTaskState(task)]),
    ),
    ...overrides,
  });
}

/** Open straight onto Placement, whose lane field is the smallest real edit. */
function renderPlacement(
  props: Partial<React.ComponentProps<typeof LiveContextConfigPanel>> = {},
) {
  const onSaveContextConfig = vi.fn();
  const view = render(
    <LiveContextConfigPanel
      execution={execution()}
      contextId={CONTEXT_ID}
      onSaveContextConfig={onSaveContextConfig}
      focusScreen={["placement"]}
      {...props}
    />,
  );
  return { ...view, onSaveContextConfig };
}

function typeLane(lane: string): void {
  fireEvent.change(screen.getByLabelText("Lane name"), {
    target: { value: lane },
  });
}

/** Edit and submit, so the panel owns the save whose result it is then shown. */
function submitLaneEdit(lane: string): void {
  typeLane(lane);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
}

describe("LiveContextConfigPanel — pause to edit", () => {
  const running = execution({
    status: "running",
    activeContextIds: [CONTEXT_ID],
  });

  it("offers the pause and reports it in flight rather than inviting a second", () => {
    const onPauseExecution = vi.fn();
    const { rerender } = render(
      <LiveContextConfigPanel
        execution={running}
        contextId={CONTEXT_ID}
        onPauseExecution={onPauseExecution}
      />,
    );

    expect(screen.getByTestId("config-affordance-banner")).toHaveTextContent(
      "This context is in progress. Pause the workflow to edit it.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause to edit" }));
    expect(onPauseExecution).toHaveBeenCalledTimes(1);

    rerender(
      <LiveContextConfigPanel
        execution={running}
        contextId={CONTEXT_ID}
        onPauseExecution={onPauseExecution}
        isPausing
      />,
    );
    const pausing = screen.getByRole("button", { name: "Pausing…" });
    expect(pausing).toBeDisabled();
    fireEvent.click(pausing);
    expect(onPauseExecution).toHaveBeenCalledTimes(1);
  });

  it("becomes editable once the execution reports quiescent", () => {
    // AC pause-to-edit: the pause is asynchronous, so what makes the editor
    // live is the execution coming back quiescent — not the click.
    const { rerender } = render(
      <LiveContextConfigPanel
        execution={running}
        contextId={CONTEXT_ID}
        focusScreen={["placement"]}
      />,
    );
    expect(screen.getByLabelText("Lane name")).toBeDisabled();
    expect(screen.queryByTestId("config-save-bar")).toBeNull();

    rerender(
      <LiveContextConfigPanel
        execution={execution({ status: "paused" })}
        contextId={CONTEXT_ID}
        focusScreen={["placement"]}
      />,
    );
    expect(screen.getByLabelText("Lane name")).toBeEnabled();
    expect(screen.queryByTestId("config-affordance-banner")).toBeNull();
    expect(screen.getByTestId("config-save-bar")).toBeInTheDocument();
  });
});

describe("LiveContextConfigPanel — the save flow", () => {
  it("marks the panel dirty and submits the edit as one update-context op", () => {
    const { onSaveContextConfig } = renderPlacement();

    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "No unsaved changes",
    );

    typeLane("review");
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "Unsaved changes",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveContextConfig).toHaveBeenCalledTimes(1);
    expect(onSaveContextConfig.mock.calls[0]?.[0]).toEqual([
      {
        type: "update-context",
        contextId: CONTEXT_ID,
        // Whole-value: the grade discriminates on `mode`, so a partial
        // placement merge has no meaning.
        placement: { lane: "review", mode: "full" },
      },
    ]);
  });

  it("names the paused execution while the submission is in flight", () => {
    const { rerender, onSaveContextConfig } = renderPlacement();
    submitLaneEdit("review");

    rerender(
      <LiveContextConfigPanel
        execution={execution()}
        contextId={CONTEXT_ID}
        onSaveContextConfig={onSaveContextConfig}
        focusScreen={["placement"]}
        isSaving
      />,
    );

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "Applying to the paused execution",
    );
  });

  it("offers Resume workflow once the save landed", () => {
    const onResumeExecution = vi.fn();
    const { rerender, onSaveContextConfig } = renderPlacement({
      onResumeExecution,
    });
    submitLaneEdit("review");

    // The saved state is only reachable once the edit is actually BACK in the
    // execution — until then the draft is still dirty, and a dirty draft
    // outranks a landed save.
    rerender(
      <LiveContextConfigPanel
        execution={execution(
          { status: "paused" },
          context({ placement: { lane: "review", mode: "full" } }),
        )}
        contextId={CONTEXT_ID}
        onSaveContextConfig={onSaveContextConfig}
        onResumeExecution={onResumeExecution}
        focusScreen={["placement"]}
        saveSucceeded
      />,
    );

    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "Saved — the execution is still paused",
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume workflow" }));
    expect(onResumeExecution).toHaveBeenCalledTimes(1);
  });

  it("renders the revision-conflict copy and keeps the edit", () => {
    const { rerender, onSaveContextConfig } = renderPlacement();
    submitLaneEdit("review");
    onSaveContextConfig.mockClear();

    rerender(
      <LiveContextConfigPanel
        execution={execution()}
        contextId={CONTEXT_ID}
        onSaveContextConfig={onSaveContextConfig}
        focusScreen={["placement"]}
        editConflict
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The execution changed since you started editing. Review your changes and retry.",
    );
    // The whole point of keeping the edit is that the retry can carry it.
    expect(screen.getByLabelText("Lane name")).toHaveValue("review");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveContextConfig).toHaveBeenCalledTimes(1);
  });

  it("renders the server's own refusal at the edit site", () => {
    const { rerender, onSaveContextConfig } = renderPlacement();
    submitLaneEdit("review");

    rerender(
      <LiveContextConfigPanel
        execution={execution()}
        contextId={CONTEXT_ID}
        onSaveContextConfig={onSaveContextConfig}
        focusScreen={["placement"]}
        editError="Live edit refused: lane delivery is mid-merge. Wait for the join to settle and retry."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Live edit refused: lane delivery is mid-merge. Wait for the join to settle and retry.",
    );
  });
});

describe("LiveContextConfigPanel — results belong to the save that caused them", () => {
  // The runtime-edit mutation is owned once for the WHOLE execution, so its
  // pending / error / conflict / success flags are still set when a different
  // context is selected. A context that submitted nothing must ignore them, or
  // it reports a save it never made — and offers a Resume for someone else's.
  it("ignores an in-flight save it did not submit", () => {
    renderPlacement({ isSaving: true });

    expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull();
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "No unsaved changes",
    );
  });

  it("ignores another context's failure and conflict", () => {
    const { unmount } = renderPlacement({
      editError: "Someone else's refusal",
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "No unsaved changes",
    );
    unmount();

    renderPlacement({ editConflict: true });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores another context's success rather than offering its Resume", () => {
    renderPlacement({ saveSucceeded: true });

    expect(
      screen.queryByRole("button", { name: "Resume workflow" }),
    ).toBeNull();
  });

  it("refuses a save while a sibling context's save is still in flight, and says why", () => {
    // The shared mutation can only carry one submission, and its guard is
    // invisible from here: without a stated block the author sees an enabled
    // Save changes, clicks it, and nothing at all happens.
    const { rerender, onSaveContextConfig } = renderPlacement();
    typeLane("review");

    rerender(
      <LiveContextConfigPanel
        execution={execution()}
        contextId={CONTEXT_ID}
        onSaveContextConfig={onSaveContextConfig}
        focusScreen={["placement"]}
        isSaving
      />,
    );

    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "Blocked: Another edit on this execution is still saving.",
    );
    fireEvent.click(save);
    expect(onSaveContextConfig).not.toHaveBeenCalled();
  });

  it("keeps the draft and the outcome with the execution that produced them", () => {
    // Context ids repeat across runs of the same plan, and the inspector keeps
    // its selection when the execution rail moves. Carrying the draft — or the
    // landed save — across that switch would rebase one run's unsaved edits
    // onto another run's snapshot and offer a Resume nobody asked for.
    const onResumeExecution = vi.fn();
    const { rerender, onSaveContextConfig } = renderPlacement({
      onResumeExecution,
    });
    submitLaneEdit("review");

    rerender(
      <LiveContextConfigPanel
        execution={execution({ id: "execution-2" })}
        contextId={CONTEXT_ID}
        onSaveContextConfig={onSaveContextConfig}
        onResumeExecution={onResumeExecution}
        focusScreen={["placement"]}
        saveSucceeded
      />,
    );

    expect(screen.getByLabelText("Lane name")).toHaveValue("delivery");
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "No unsaved changes",
    );
    expect(
      screen.queryByRole("button", { name: "Resume workflow" }),
    ).toBeNull();
  });

  it("reports the result once this context has actually submitted", () => {
    const { rerender, onSaveContextConfig } = renderPlacement();
    typeLane("review");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveContextConfig).toHaveBeenCalledTimes(1);

    rerender(
      <LiveContextConfigPanel
        execution={execution()}
        contextId={CONTEXT_ID}
        onSaveContextConfig={onSaveContextConfig}
        focusScreen={["placement"]}
        editError="Live edit refused: lane delivery is mid-merge."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Live edit refused: lane delivery is mid-merge.",
    );
  });
});

describe("LiveContextConfigPanel — blocked saves", () => {
  it("names the placement refusal and refuses to submit", () => {
    // AC save-blocked: a lane name that would become a branch segment.
    const { onSaveContextConfig } = renderPlacement();
    typeLane("bad lane");

    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "Blocked: Lane names become branch and worktree path segments:",
    );

    fireEvent.click(save);
    expect(onSaveContextConfig).not.toHaveBeenCalled();
  });

  it("names the schema refusal rather than just refusing", () => {
    const { onSaveContextConfig } = renderPlacement({
      focusScreen: ["schema"],
    });

    fireEvent.change(screen.getByLabelText("Output schema JSON"), {
      target: { value: "{ half-typed" },
    });

    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "Blocked: The output schema cannot be parsed.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveContextConfig).not.toHaveBeenCalled();
  });
});

describe("LiveContextConfigPanel — the frozen contract", () => {
  it("locks the schema of an editable context whose output was captured", () => {
    // AC schema-frozen: paused → the context is otherwise fully editable, and
    // the banked payload still settles the declaration.
    renderPlacement({
      execution: execution(
        {
          status: "paused",
          contextOutputs: {
            [CONTEXT_ID]: {
              value: { note: "done" },
              capturedAt: "2026-08-20T12:00:00.000Z",
              iteration: 2,
              parse: { source: "native" },
            },
          },
        },
        context({
          outputSchema: {
            type: "object",
            properties: { note: { type: "string" } },
          },
        }),
      ),
      focusScreen: ["schema"],
    });

    expect(screen.getByLabelText("Output schema JSON")).toBeDisabled();
    expect(
      screen.getByText(
        "The output was already captured against this schema — editing it now would not re-validate anything.",
      ),
    ).toBeInTheDocument();
    // The rest of the context is untouched by the capture.
    expect(screen.getByTestId("context-config-tab")).toHaveAttribute(
      "data-affordance",
      "editable",
    );
  });
});

describe("LiveContextConfigPanel — what only the host can wire", () => {
  const withSeat = () =>
    context({
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin", id: "general-reviewer" },
            profileSnapshot: makeProfileSnapshot(),
            strategy: "conversation",
            authority: "blocking",
            agent: {
              backend: "claude",
              modelSelection: {
                modelId: "sonnet",
                parameters: { effort: "medium" },
              },
            },
          },
        ],
      },
    });

  it.each(["implementer", "context_validator"] as const)(
    "freezes only the started %s when both assignments have the same id",
    (startedLane) => {
      const resolved = withSeat();
      resolved.implementer.id = "general";
      const laneKey =
        startedLane === "implementer"
          ? "implementer"
          : "context_validator:general";
      const current = execution(
        {
          laneStates: {
            [CONTEXT_ID]: {
              [laneKey]: {
                lane: startedLane,
                contextId: CONTEXT_ID,
                backend: "claude",
                refKind: "conversation",
                workflowConversationId: "conv_started",
                metrics: {},
                lastUsedAt: "2026-09-18T10:00:00.000Z",
              },
            },
          },
        },
        resolved,
      );
      const { unmount } = render(
        <LiveContextConfigPanel
          execution={current}
          contextId={CONTEXT_ID}
          focusScreen={["implementer"]}
        />,
      );
      expect(screen.getByLabelText("Implementer instructions")).toHaveProperty(
        "disabled",
        startedLane === "implementer",
      );
      unmount();
      render(
        <LiveContextConfigPanel
          execution={current}
          contextId={CONTEXT_ID}
          focusScreen={["seat:general"]}
        />,
      );
      expect(screen.getByRole("radio", { name: "advisory" })).toHaveProperty(
        "disabled",
        startedLane === "context_validator",
      );
    },
  );

  it("offers the per-seat reset on a paused run and withholds it while running", () => {
    // The reducer refuses a per-assignment reset unless the run is paused or
    // halted, so offering it while running would promise a refused action.
    const onResetAssignment = vi.fn();
    const { unmount } = render(
      <LiveContextConfigPanel
        execution={execution({ status: "paused" }, withSeat())}
        contextId={CONTEXT_ID}
        onResetAssignment={onResetAssignment}
        focusScreen={["seat:general"]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset seat" }));
    expect(onResetAssignment).toHaveBeenCalledWith(CONTEXT_ID, "general");
    unmount();

    render(
      <LiveContextConfigPanel
        execution={execution(
          { status: "running", activeContextIds: [CONTEXT_ID] },
          withSeat(),
        )}
        contextId={CONTEXT_ID}
        onResetAssignment={onResetAssignment}
        focusScreen={["seat:general"]}
      />,
    );
    expect(screen.queryByTestId("config-row-seat-reset")).toBeNull();
  });

  it("shows the provisioned runtime beside the authored lane", () => {
    // Derived from the execution payload, not the definition: the authored lane
    // is what a save would change, the runtime rows are what actually got
    // provisioned, and the two can legitimately disagree mid-run.
    render(
      <LiveContextConfigPanel
        execution={execution({ status: "paused" })}
        contextId={CONTEXT_ID}
        focusScreen={["placement"]}
      />,
    );

    expect(screen.getByLabelText("Lane name")).toHaveValue("delivery");
    expect(screen.getByTestId("config-row-runtime-branch")).toHaveTextContent(
      "csm/impl",
    );
    expect(screen.getByTestId("config-row-runtime-worktree")).toHaveTextContent(
      "/tmp/wt",
    );
    // The whole lane's picture: an owning member's activity only means
    // something beside the siblings sharing its worktree.
    expect(screen.getByTestId("config-row-runtime-activity")).toHaveTextContent(
      CONTEXT_ID,
    );
    // Absent until there is an error to report.
    expect(screen.queryByTestId("config-row-runtime-mergeError")).toBeNull();
  });
});

describe("LiveContextConfigPanel — the multiline primary action", () => {
  it("submits the prose edit from the editor's own shortcut, carrying the keystroke", () => {
    // The retired editor wired description and acceptance criteria to save
    // through onPrimaryAction. Without it the shortcut is inert, and — worse —
    // a dictation's stop-and-submit value would never reach the diff.
    const { onSaveContextConfig } = renderPlacement({ focusScreen: ["brief"] });

    const description = screen.getByLabelText("Context description");
    fireEvent.change(description, { target: { value: "Rewritten brief" } });
    fireEvent.keyDown(description, { key: "Enter", ctrlKey: true });

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: CONTEXT_ID,
        description: "Rewritten brief",
      },
    ]);
  });

  it("submits an acceptance-criterion edit from its own shortcut", () => {
    const { onSaveContextConfig } = renderPlacement({ focusScreen: ["brief"] });

    const statement = screen.getByLabelText("Statement for ac-1");
    fireEvent.change(statement, { target: { value: "Checkout persists" } });
    fireEvent.keyDown(statement, { key: "Enter", ctrlKey: true });

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: CONTEXT_ID,
        // Whole-list restatement, as the op requires.
        acceptanceCriteria: [{ id: "ac-1", statement: "Checkout persists" }],
      },
    ]);
  });
});

describe("LiveContextConfigPanel — the danger footer (§11 context reset)", () => {
  const resetButton = () =>
    screen.queryByRole("button", { name: /reset context/i });

  it("offers the reset behind a confirmation and passes the context id", () => {
    const onResetContext = vi.fn();
    renderPlacement({ onResetContext });

    const trigger = resetButton();
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger as HTMLElement);

    expect(screen.getByText("Reset context?")).toBeInTheDocument();
    // The destructive act happens on confirm, never on the trigger.
    expect(onResetContext).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^reset$/i }));
    expect(onResetContext).toHaveBeenCalledWith(CONTEXT_ID);
  });

  it("withholds it while the run is going, when the context is done, and with no handler", () => {
    // The reducer rebuilds context state, which only a stopped run survives.
    const { unmount } = renderPlacement({
      execution: execution({
        status: "running",
        activeContextIds: [CONTEXT_ID],
      }),
      onResetContext: vi.fn(),
    });
    expect(resetButton()).toBeNull();
    unmount();

    const done = renderPlacement({
      execution: execution({
        status: "paused",
        contextStates: {
          [CONTEXT_ID]: { ...startedState(), status: "completed" },
        },
      }),
      onResetContext: vi.fn(),
    });
    expect(resetButton()).toBeNull();
    done.unmount();

    renderPlacement();
    expect(resetButton()).toBeNull();
  });

  it("withdraws an open confirmation when authority is lost mid-dialog", () => {
    // An SSE refresh can strip the lease while the dialog is up, and a dialog
    // already open is still a live mutation control.
    const onResetContext = vi.fn();
    const { rerender } = render(
      <LiveContextConfigPanel
        execution={execution({ status: "paused" })}
        contextId={CONTEXT_ID}
        onResetContext={onResetContext}
        focusScreen={["placement"]}
      />,
    );

    fireEvent.click(resetButton() as HTMLElement);
    expect(screen.getByText("Reset context?")).toBeInTheDocument();

    rerender(
      <LiveContextConfigPanel
        execution={execution({ status: "aborted" })}
        contextId={CONTEXT_ID}
        onResetContext={onResetContext}
        focusScreen={["placement"]}
      />,
    );

    expect(screen.queryByText("Reset context?")).not.toBeInTheDocument();
    expect(onResetContext).not.toHaveBeenCalled();
  });
});

describe("LiveContextConfigPanel — read-only tenures", () => {
  it("carries the parked plan's reason verbatim and offers no save bar", () => {
    render(
      <LiveContextConfigPanel
        execution={execution({
          status: "pending",
          definitionApproval: {
            requestedAt: "2026-08-20T10:00:00.000Z",
            approvedAt: null,
          },
        })}
        contextId={CONTEXT_ID}
        focusScreen={["placement"]}
      />,
    );

    expect(screen.getByTestId("config-affordance-banner")).toHaveTextContent(
      "This plan is parked awaiting definition approval; approve or reject it before editing.",
    );
    expect(screen.getByLabelText("Lane name")).toBeDisabled();
    expect(screen.queryByTestId("config-save-bar")).toBeNull();
  });

  it("carries the completed execution's reason verbatim", () => {
    render(
      <LiveContextConfigPanel
        execution={execution({ status: "completed" })}
        contextId={CONTEXT_ID}
      />,
    );

    expect(screen.getByTestId("config-affordance-banner")).toHaveTextContent(
      "This execution has completed and can no longer be edited.",
    );
  });
});
