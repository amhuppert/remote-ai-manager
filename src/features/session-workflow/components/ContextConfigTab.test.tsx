// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OUTPUT_SCHEMA_TEMPLATE } from "@/components/workflow-config/OutputSchemaField";
import {
  createWorkflowExecution,
  makeProfileSnapshot,
} from "@/lib/workflow-graph/test-fixtures";
import {
  buildInitialContextState,
  buildInitialTaskState,
} from "@/lib/workflow-graph/execution-state";
import ContextConfigTab from "./ContextConfigTab";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import { contextOutputSchemaSchema } from "@/lib/workflow-graph/definition-schemas";
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
    placement: { lane: "context-impl", mode: "full" as const },
    id: "context-impl",
    title: "Implement",
    description: "Do the work",
    acceptanceCriteria: "It works",
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
    },
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
            model: "sonnet",
            reasoningEffort: "medium",
          },
          continuity: { enabled: true, contextLimitTokens: 50000 },
        },
      ],
    },
    scriptValidator: { commands: ["pre-merge"] },
    humanApprovalGate: { enabled: true },
    askUserQuestions: { enabled: true },
    mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
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
    skipReason: null,
    landingIntent: null,
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
    pendingUserInputs: {},
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
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
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
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
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
    expect(
      within(val).getByLabelText("Continuity enabled for general"),
    ).toBeChecked();
    expect(
      within(val).getByLabelText("Context limit tokens for general"),
    ).toHaveValue(50000);

    expect(
      screen.queryByLabelText("Script validator enabled"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Human approval gate enabled")).toBeChecked();
    expect(screen.getByLabelText("Ask user questions enabled")).toBeChecked();
    expect(screen.getByLabelText("Allow agent task add")).toBeChecked();

    expect(screen.getByTestId("config-iteration-count")).toHaveTextContent(
      "3 / 20",
    );
    expect(screen.getByLabelText("Max iterations")).toHaveValue(20);
    expect(screen.getByLabelText("Failure threshold")).toHaveValue(3);

    const repair = screen.getByTestId("config-block-plan-repair");
    expect(within(repair).getByLabelText("Plan repair enabled")).toBeChecked();
    expect(within(repair).getByLabelText("Max repair attempts")).toHaveValue(2);
    // No explicit agent resolved → the supervisor's fallback, shown as such.
    expect(
      within(repair).getByLabelText("Custom repair agent"),
    ).not.toBeChecked();

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
    context.contextValidator = { enabled: false, assignments: [] };
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
      enabled: false,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          profileSnapshot: makeProfileSnapshot(),
          strategy: "conversation",
          authority: "blocking",
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          continuity: { enabled: true },
        },
      ],
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
      enabled: false,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          profileSnapshot: makeProfileSnapshot(),
          strategy: "task",
          authority: "blocking",
          agent: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "high",
          },
          continuity: { enabled: true },
        },
      ],
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
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
              strategy: "task",
              // Preserved, not re-derived: an enabled-flip that dropped it
              // would demote the seat to the schema default (advisory).
              authority: "blocking",
              agent: {
                backend: "codex",
                model: "gpt-5.4",
                reasoningEffort: "high",
              },
              continuity: { enabled: true },
            },
          ],
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
          enabled: false,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
              strategy: "conversation",
              authority: "blocking",
              agent: {
                backend: "claude",
                model: "sonnet",
                reasoningEffort: "medium",
              },
              continuity: { enabled: true, contextLimitTokens: 50000 },
            },
          ],
        },
      },
    ]);
  });

  it("seeds a default validator when enabling an absent (null) validator", () => {
    const onSaveContextConfig = vi.fn();
    const context = fullContext();
    context.contextValidator = { enabled: false, assignments: [] };

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
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
              strategy: "conversation",
              // Cloned from SEEDED_WORKFLOW_DEFAULTS, whose one seeded seat is
              // the shipped blocking reviewer — so re-enabling an empty cohort
              // seeds that blocking seat rather than the schema's flat
              // "advisory" default.
              authority: "blocking",
              agent: {
                backend: "claude",
                model: "sonnet",
                reasoningEffort: "medium",
              },
              continuity: { enabled: true },
            },
          ],
        },
      },
    ]);
  });
});

/**
 * R12.1/R12.2 on the live-execution consumer, and R12.4's rotation disclosure.
 *
 * The axis reaches this tab through the same shared cohort editor the builder
 * and the Settings defaults form render; what is unique here is that a seat
 * already HOLDS a lane, so the rotation an edit forces has to be visible before
 * the edit is applied.
 */
describe("ContextConfigTab — validator authority and lane rotation", () => {
  function renderEditable(onSaveContextConfig = vi.fn()) {
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );
    return { onSaveContextConfig };
  }

  function validatorBlock(): HTMLElement {
    return screen.getByTestId("config-block-context-validator");
  }

  it("exposes the authority axis and its instructions face through the shared editor", () => {
    renderEditable();
    const block = validatorBlock();
    expect(
      within(block).getByTestId("cohort-authority-badge").textContent,
    ).toBe("Blocking");
    expect(
      within(block).getByLabelText("Mandate for general"),
    ).toBeInTheDocument();
    expect(
      within(block).getByLabelText("Validator authority"),
    ).toBeInTheDocument();
  });

  it("carries an authority edit into the update-context op", () => {
    const { onSaveContextConfig } = renderEditable();
    fireEvent.click(
      within(
        within(validatorBlock()).getByLabelText("Validator authority"),
      ).getByRole("radio", { name: "advisory" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const op = onSaveContextConfig.mock.calls[0]?.[0]?.[0];
    expect(op.contextValidator.assignments[0].authority).toBe("advisory");
  });

  it("warns that changing a seat's authority rotates its lane BEFORE the edit is applied", () => {
    const { onSaveContextConfig } = renderEditable();
    expect(
      screen.queryByTestId("lane-rotation-notice"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(
        within(validatorBlock()).getByLabelText("Validator authority"),
      ).getByRole("radio", { name: "advisory" }),
    );

    const notice = screen.getByTestId("lane-rotation-notice");
    expect(notice.textContent).toContain("general");
    expect(notice.textContent).toContain("assignment_changed");
    // The disclosure precedes the write, so the operator can still back out.
    expect(onSaveContextConfig).not.toHaveBeenCalled();
  });

  it("warns that editing a seat's instructions rotates its lane", () => {
    renderEditable();
    fireEvent.change(
      within(validatorBlock()).getByLabelText("Mandate for general"),
      { target: { value: "auth boundaries only" } },
    );
    expect(screen.getByTestId("lane-rotation-notice").textContent).toContain(
      "general",
    );
  });

  // Removing a mandate is an authority-bearing edit like writing one: the seat
  // stops being bound to that text, its fingerprint moves, and its lane is
  // retired. It reaches the op as a MISSING key, not an empty string.
  it("warns about the rotation when a seat's instructions are cleared, and saves the removal", () => {
    const context = fullContext();
    const seat = context.contextValidator.assignments[0];
    if (!seat) throw new Error("fixture carries no validator assignment");
    seat.focus = "auth boundaries";
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(context, startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    fireEvent.change(
      within(validatorBlock()).getByLabelText("Mandate for general"),
      { target: { value: "" } },
    );

    expect(screen.getByTestId("lane-rotation-notice").textContent).toContain(
      "general",
    );
    expect(
      within(validatorBlock()).getByLabelText("Mandate for general"),
    ).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const op = onSaveContextConfig.mock.calls[0]?.[0]?.[0];
    expect(op.contextValidator.assignments[0]).not.toHaveProperty("focus");
  });

  it("stays silent for an edit that does not retire the lane", () => {
    renderEditable();
    fireEvent.change(screen.getByLabelText("Context title"), {
      target: { value: "Implement, revised" },
    });
    expect(
      screen.queryByTestId("lane-rotation-notice"),
    ).not.toBeInTheDocument();
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

describe("ContextConfigTab — validation command selectors", () => {
  // A resolved context whose snapshot carries selector names and mixed
  // per-role provenance.
  function contextWithValidationSelectors(): GraphWorkflowResolvedContext {
    const context = fullContext();
    context.scriptValidator = {
      commands: ["typecheck", "test"],
    };
    context.scriptValidatorSource = "workflow";
    context.agentValidation = {
      implementer: {
        value: { mode: "all", except: ["format"] },
        source: "workflow",
      },
      contextValidator: {
        value: { mode: "only", commands: [] },
        source: "global",
      },
    };
    return context;
  }

  function roleSection(
    block: HTMLElement,
    role: "implementer" | "contextValidator",
  ): HTMLElement {
    const section = block.querySelector(`[data-role="${role}"]`);
    if (!(section instanceof HTMLElement)) {
      throw new Error(`No ${role} role section rendered`);
    }
    return section;
  }

  it("renders effective selections with per-role provenance labels", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(
          contextWithValidationSelectors(),
          startedContextState(),
          { status: "paused" },
        )}
        contextId="context-impl"
      />,
    );

    const script = screen.getByTestId("config-block-script-validator");
    expect(within(script).getByText("typecheck")).toBeInTheDocument();
    expect(within(script).getByText("test")).toBeInTheDocument();
    expect(
      within(script).getByTestId("script-validator-source"),
    ).toHaveTextContent("Workflow");

    const block = screen.getByTestId("config-block-agent-validation");
    expect(
      within(block).getByTestId("agent-validation-source-implementer"),
    ).toHaveTextContent("Workflow");
    expect(
      within(block).getByTestId("agent-validation-source-context-validator"),
    ).toHaveTextContent("Global");

    const implementer = roleSection(block, "implementer");
    expect(
      within(implementer).getByRole("radio", { name: "All except" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(within(implementer).getByText("format")).toBeInTheDocument();

    const validator = roleSection(block, "contextValidator");
    expect(
      within(validator).getByRole("radio", { name: "Only" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("labels a per-context script command selection as Context", () => {
    const context = contextWithValidationSelectors();
    context.scriptValidatorSource = "per-node";
    render(
      <ContextConfigTab
        execution={startedExecution(context, startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
      />,
    );

    expect(screen.getByTestId("script-validator-source")).toHaveTextContent(
      "Context",
    );
  });

  it("falls back to seeded defaults labeled Global when the snapshot is absent", () => {
    // fullContext() predates the field — exactly the legacy-execution case.
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
      />,
    );

    const block = screen.getByTestId("config-block-agent-validation");
    expect(screen.getByTestId("script-validator-source")).toHaveTextContent(
      "Global",
    );
    expect(
      within(block).getByTestId("agent-validation-source-implementer"),
    ).toHaveTextContent("Global");
    expect(
      within(block).getByTestId("agent-validation-source-context-validator"),
    ).toHaveTextContent("Global");
    expect(
      within(roleSection(block, "implementer")).getByRole("radio", {
        name: "All except",
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(roleSection(block, "contextValidator")).getByRole("radio", {
        name: "Only",
      }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("editing one role stamps only that role per-node; the untouched role echoes its stored provenance", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(
          contextWithValidationSelectors(),
          startedContextState(),
          { status: "paused" },
        )}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    const block = screen.getByTestId("config-block-agent-validation");
    fireEvent.click(
      within(roleSection(block, "implementer")).getByRole("radio", {
        name: "Only",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        agentValidation: {
          implementer: {
            value: { mode: "only", commands: [] },
            source: "per-node",
          },
          // Untouched: keeps the stored resolved leaf verbatim, so a one-role
          // edit never converts inherited provenance to Context.
          contextValidator: {
            value: { mode: "only", commands: [] },
            source: "global",
          },
        },
      },
    ]);
  });

  it("adding a script-validator command sends the whole config in the op", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(
          contextWithValidationSelectors(),
          startedContextState(),
          { status: "paused" },
        )}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    const script = screen.getByTestId("config-block-script-validator");
    fireEvent.change(
      within(script).getByLabelText("Add script validator command"),
      { target: { value: "lint" } },
    );
    fireEvent.click(within(script).getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        scriptValidator: {
          commands: ["typecheck", "test", "lint"],
        },
      },
    ]);
  });

  it("removing every script-validator command round-trips commands: [] (explicitly off)", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(
          contextWithValidationSelectors(),
          startedContextState(),
          { status: "paused" },
        )}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    const script = screen.getByTestId("config-block-script-validator");
    fireEvent.click(
      within(script).getByRole("button", { name: "Remove typecheck" }),
    );
    fireEvent.click(
      within(script).getByRole("button", { name: "Remove test" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        scriptValidator: { commands: [] },
      },
    ]);
  });

  it("renders a registry multi-select when command options are provided and toggles compose the op", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(
          contextWithValidationSelectors(),
          startedContextState(),
          { status: "paused" },
        )}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
        commandOptions={[
          { name: "typecheck", cost: 2 },
          { name: "test", cost: 4, description: "Scoped vitest" },
          { name: "lint", cost: 1 },
        ]}
      />,
    );

    const script = screen.getByTestId("config-block-script-validator");
    // Registered commands render as labelled checkboxes with cost annotation;
    // the free-form add input is gone.
    expect(
      within(script).queryByLabelText("Add script validator command"),
    ).not.toBeInTheDocument();
    expect(
      within(script).getByText("cost 4 — Scoped vitest"),
    ).toBeInTheDocument();
    expect(
      within(script).getByRole("checkbox", { name: "typecheck" }),
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(script).getByRole("checkbox", { name: "lint" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        scriptValidator: {
          commands: ["typecheck", "test", "lint"],
        },
      },
    ]);
  });

  it("marks a selected-but-unregistered command and keeps it removable", () => {
    const execution = startedExecution(
      contextWithValidationSelectors(),
      startedContextState(),
      { status: "paused" },
    );
    render(
      <ContextConfigTab
        execution={execution}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
        commandOptions={[{ name: "typecheck", cost: 2 }]}
      />,
    );

    // "test" is selected in the snapshot but absent from the registry.
    const script = screen.getByTestId("config-block-script-validator");
    expect(
      within(script).getByTestId("command-chip-unregistered"),
    ).toBeInTheDocument();
    expect(
      within(script).getByRole("button", { name: "Remove test" }),
    ).toBeInTheDocument();
  });

  it("disables the selector editors while the context is not editable", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(
          contextWithValidationSelectors(),
          startedContextState(),
          { status: "running", activeContextIds: ["context-impl"] },
        )}
        contextId="context-impl"
      />,
    );

    const block = screen.getByTestId("config-block-agent-validation");
    expect(
      within(roleSection(block, "implementer")).getByRole("radio", {
        name: "Only",
      }),
    ).toBeDisabled();
    const script = screen.getByTestId("config-block-script-validator");
    expect(
      within(script).getByLabelText("Add script validator command"),
    ).toBeDisabled();
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

  /**
   * The mutability block carries two independent flags but this editor only
   * surfaces one. A form that rebuilt the block from the flag it renders would
   * silently erase the lane's runtime expansion authority on the next save
   * (D4 R7.1) — the round trip is the pin.
   */
  it("preserves allowAgentContextAdd when the agent-task-add toggle is saved", () => {
    const onSaveContextConfig = vi.fn();
    const context = fullContext();
    context.mutability = {
      allowAgentTaskAdd: true,
      allowAgentContextAdd: true,
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

    fireEvent.click(screen.getByLabelText("Allow agent task add"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: true },
      },
    ]);
  });

  it("composes an update-context op carrying only the changed planRepair policy", () => {
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

    fireEvent.change(screen.getByLabelText("Max repair attempts"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        planRepair: { enabled: true, maxAttemptsPerContext: 4 },
      },
    ]);
  });

  it("enabling a custom repair agent seeds the supervisor's fallback agent", () => {
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

    fireEvent.click(screen.getByLabelText("Custom repair agent"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        planRepair: {
          enabled: true,
          maxAttemptsPerContext: 2,
          agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
        },
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

// The output-schema contract is per-context identity, held in the flat draft as
// RAW TEXT: dirtiness is a string compare, and the text is parsed to
// object-or-null only when an op is composed (R7.1/R7.5).
const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
};
const SCHEMA_TEXT = JSON.stringify(SCHEMA, null, 2);

function schemaContext(): GraphWorkflowResolvedContext {
  return { ...fullContext(), outputSchema: SCHEMA };
}

function schemaEditor(): HTMLElement {
  return screen.getByLabelText("Output schema JSON");
}

describe("ContextConfigTab — output schema flatten/diff round trip", () => {
  it("flattens the resolved outputSchema into the editor as formatted text", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    expect(schemaEditor()).toHaveValue(SCHEMA_TEXT);
    expect(screen.getByTestId("output-schema-field")).toHaveAttribute(
      "data-stage",
      "ok",
    );
    expect(screen.getByTestId("output-schema-shape")).toHaveTextContent(
      "object · 1 field",
    );
    // Untouched → not dirty.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("renders the empty state for a context that declares no schema", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    expect(screen.getByTestId("output-schema-field")).toHaveAttribute(
      "data-stage",
      "empty",
    );
    expect(screen.getByTestId("output-schema-empty")).toBeInTheDocument();
  });

  it("diffs an edited schema into the update-context op as a parsed object", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    const next = {
      type: "object",
      properties: { verdict: { type: "string" }, score: { type: "number" } },
      required: ["verdict", "score"],
    };
    fireEvent.change(schemaEditor(), {
      target: { value: JSON.stringify(next, null, 2) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      { type: "update-context", contextId: "context-impl", outputSchema: next },
    ]);
  });

  it("clears the schema into an explicit null on the op", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      { type: "update-context", contextId: "context-impl", outputSchema: null },
    ]);
  });

  it("adds a schema to a context that had none, parsed from the seeded template", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "+ Add schema" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        // Parsed through the canonical schema rather than asserted — the op
        // field is exactly this type.
        outputSchema: contextOutputSchemaSchema.parse(
          JSON.parse(OUTPUT_SCHEMA_TEMPLATE),
        ),
      },
    ]);
  });

  it("treats whitespace-only reformatting as dirty text but never as a schema change", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    // Same document, different formatting: string-compare dirtiness enables the
    // save bar, and the parsed op carries the (equivalent) document.
    fireEvent.change(schemaEditor(), {
      target: { value: JSON.stringify(SCHEMA) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        outputSchema: SCHEMA,
      },
    ]);
  });
});

describe("ContextConfigTab — output schema lifecycle affordances", () => {
  it("editable: the editor accepts input and carries no read-only explanation", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    expect(schemaEditor()).not.toBeDisabled();
    expect(
      screen.queryByTestId("output-schema-readonly-hint"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("config-output-schema-dirty"),
    ).not.toBeInTheDocument();
  });

  it("dirty: a valid edit shows the unsaved hint and enables save", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    fireEvent.change(schemaEditor(), {
      target: { value: JSON.stringify({ type: "object" }, null, 2) },
    });

    expect(screen.getByTestId("config-output-schema-dirty")).toHaveTextContent(
      /unsaved/i,
    );
    expect(
      screen.getByRole("button", { name: "Save changes" }),
    ).not.toBeDisabled();
  });

  it("dirty-but-invalid: save is disabled, no hint, and fixing the text re-enables it", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    fireEvent.change(schemaEditor(), { target: { value: '{ "type": ' } });
    expect(screen.getByTestId("output-schema-field")).toHaveAttribute(
      "data-stage",
      "invalid-json",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(
      screen.queryByTestId("config-output-schema-dirty"),
    ).not.toBeInTheDocument();

    // An unsupported keyword is equally a real server refusal — also blocking.
    fireEvent.change(schemaEditor(), {
      target: { value: JSON.stringify({ $ref: "#/x" }, null, 2) },
    });
    expect(screen.getByTestId("output-schema-field")).toHaveAttribute(
      "data-stage",
      "unsupported",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    fireEvent.change(schemaEditor(), {
      target: { value: JSON.stringify({ type: "object" }, null, 2) },
    });
    expect(
      screen.getByRole("button", { name: "Save changes" }),
    ).not.toBeDisabled();
  });

  it("dirty-but-invalid blocks a save that other valid edits would otherwise allow", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "10" },
    });
    fireEvent.change(schemaEditor(), { target: { value: "{{{" } });

    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();
    fireEvent.click(saveButton);
    expect(onSaveContextConfig).not.toHaveBeenCalled();
  });

  it("pause-to-edit: the editor is disabled with a pause-specific explanation", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "running",
          activeContextIds: ["context-impl"],
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
        onPauseExecution={vi.fn()}
      />,
    );

    expect(schemaEditor()).toBeDisabled();
    expect(screen.getByTestId("output-schema-readonly-hint")).toHaveTextContent(
      /pause the execution/i,
    );
    expect(
      screen.queryByRole("button", { name: "Clear" }),
    ).not.toBeInTheDocument();
  });

  it("frozen: the editor is disabled, explained, and the banner lock is an SVG not an emoji", () => {
    const state = startedContextState();
    state.status = "completed";
    render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), state, {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    expect(schemaEditor()).toBeDisabled();
    expect(screen.getByTestId("output-schema-readonly-hint")).toHaveTextContent(
      /already captured/i,
    );

    const banner = screen.getByTestId("config-affordance-frozen");
    expect(banner.querySelector("svg")).not.toBeNull();
    expect(banner.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("execution read-only: the editor is disabled with an immutability explanation", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "completed",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    expect(schemaEditor()).toBeDisabled();
    expect(screen.getByTestId("output-schema-readonly-hint")).toHaveTextContent(
      /immutable/i,
    );
  });

  it("revision conflict: the schema stays editable and the unsaved edit survives the refetch", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    const edited = {
      type: "object",
      properties: { score: { type: "number" } },
    };
    fireEvent.change(schemaEditor(), {
      target: { value: JSON.stringify(edited, null, 2) },
    });

    // The 409 refetch delivers a concurrently-renamed context.
    const concurrent = schemaContext();
    concurrent.title = "Renamed by another editor";
    const refreshed = startedExecution(concurrent, startedContextState(), {
      status: "paused",
    });
    refreshed.liveRevision = 11;
    rerender(
      <ContextConfigTab
        execution={refreshed}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
        editConflict
      />,
    );

    expect(
      screen.getByTestId("config-affordance-conflict"),
    ).toBeInTheDocument();
    expect(schemaEditor()).not.toBeDisabled();
    expect(schemaEditor()).toHaveValue(JSON.stringify(edited, null, 2));

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        outputSchema: edited,
      },
    ]);
  });

  // A lifecycle change can arrive over SSE while the tab stays mounted. Every
  // read-only mode must take the editor AND its undo affordance with it —
  // otherwise Undo is a live write into a draft the save bar no longer offers.
  it.each([
    {
      label: "pause-to-edit",
      execution: () =>
        startedExecution(schemaContext(), startedContextState(), {
          status: "running",
          activeContextIds: ["context-impl"],
        }),
    },
    {
      label: "frozen",
      execution: () => {
        const state = startedContextState();
        state.status = "completed";
        return startedExecution(schemaContext(), state, { status: "paused" });
      },
    },
    {
      label: "execution read-only",
      execution: () =>
        startedExecution(schemaContext(), startedContextState(), {
          status: "completed",
        }),
    },
  ])(
    "withdraws the cleared-schema undo when the context becomes $label mid-edit",
    ({ execution }) => {
      const onSaveContextConfig = vi.fn();
      const { rerender } = render(
        <ContextConfigTab
          execution={startedExecution(schemaContext(), startedContextState(), {
            status: "paused",
          })}
          contextId="context-impl"
          onSaveContextConfig={onSaveContextConfig}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(screen.getByTestId("output-schema-cleared")).toBeInTheDocument();

      rerender(
        <ContextConfigTab
          execution={execution()}
          contextId="context-impl"
          onSaveContextConfig={onSaveContextConfig}
          onPauseExecution={vi.fn()}
        />,
      );

      expect(
        screen.queryByTestId("output-schema-cleared"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Undo" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("output-schema-readonly-hint"),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("config-save-bar")).not.toBeInTheDocument();
    },
  );

  it("rebase: an untouched schema adopts the concurrently-changed value", () => {
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "12" },
    });

    const concurrent = schemaContext();
    concurrent.outputSchema = { type: "object", properties: {} };
    const refreshed = startedExecution(concurrent, startedContextState(), {
      status: "paused",
    });
    refreshed.liveRevision = 13;
    rerender(
      <ContextConfigTab
        execution={refreshed}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
        editConflict
      />,
    );

    expect(schemaEditor()).toHaveValue(
      JSON.stringify(concurrent.outputSchema, null, 2),
    );
    expect(screen.getByLabelText("Max iterations")).toHaveValue(12);
  });
});

// The draft holds the author's RAW text while the server stores a parsed
// document that `toDraft` re-serializes canonically. Unless the submitted text
// adopts that canonical form, a save whose only change was formatting (or the
// hand-formatted Add template) rebases against a baseline it can never string-
// match, and the context stays dirty forever: Save enabled, unsaved hint up,
// Resume withheld.
describe("ContextConfigTab — output schema save round trip", () => {
  function roundTrip(
    saved: Record<string, unknown> | undefined,
    contextState = startedContextState(),
  ) {
    const context = schemaContext();
    if (saved === undefined) {
      delete context.outputSchema;
    } else {
      context.outputSchema = saved;
    }
    const refreshed = startedExecution(context, contextState, {
      status: "paused",
    });
    refreshed.liveRevision = 21;
    return refreshed;
  }

  it("settles clean after a formatting-only edit round-trips", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    // Same document, compact formatting — the op carries an equal document.
    fireEvent.change(schemaEditor(), {
      target: { value: JSON.stringify(SCHEMA) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        outputSchema: SCHEMA,
      },
    ]);

    rerender(
      <ContextConfigTab
        execution={roundTrip(SCHEMA)}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
        saveSucceeded
      />,
    );

    expect(schemaEditor()).toHaveValue(SCHEMA_TEXT);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(
      screen.queryByTestId("config-output-schema-dirty"),
    ).not.toBeInTheDocument();
  });

  it("settles clean after the seeded template round-trips, and offers Resume", () => {
    const onSaveContextConfig = vi.fn();
    const context = fullContext();
    const pausedState = startedContextState();
    pausedState.status = "ready";
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(context, pausedState, {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
        onResumeExecution={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "+ Add schema" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const template = contextOutputSchemaSchema.parse(
      JSON.parse(OUTPUT_SCHEMA_TEMPLATE),
    );
    rerender(
      <ContextConfigTab
        execution={roundTrip(template, pausedState)}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
        onResumeExecution={vi.fn()}
        saveSucceeded
      />,
    );

    expect(schemaEditor()).toHaveValue(JSON.stringify(template, null, 2));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // The whole point of settling clean: the pause-to-edit flow can finish.
    expect(
      screen.getByRole("button", { name: "Resume workflow" }),
    ).toBeInTheDocument();
  });

  it("settles clean after a clear round-trips", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    rerender(
      <ContextConfigTab
        execution={roundTrip(undefined)}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
        saveSucceeded
      />,
    );

    expect(screen.getByTestId("output-schema-field")).toHaveAttribute(
      "data-stage",
      "empty",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  // The invariant underneath the conflict case: dispatch is not acknowledgement.
  // Until the stored state is observed to have moved, the submission stays
  // pending and the author's text stays exactly as they typed it.
  it("does not normalize or settle a formatting-only edit before the save lands", () => {
    const compact = JSON.stringify(SCHEMA);
    const execution = startedExecution(schemaContext(), startedContextState(), {
      status: "paused",
    });
    const { rerender } = render(
      <ContextConfigTab
        execution={execution}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
      />,
    );

    fireEvent.change(schemaEditor(), { target: { value: compact } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // Same execution, unchanged revision — the write has not landed yet, even
    // though the stored document already equals the submitted one.
    rerender(
      <ContextConfigTab
        execution={execution}
        contextId="context-impl"
        onSaveContextConfig={vi.fn()}
        isSaving
      />,
    );

    expect(schemaEditor()).toHaveValue(compact);
    expect(
      screen.getByTestId("config-output-schema-dirty"),
    ).toBeInTheDocument();
  });

  // The narrowest rejection case, and the one a canonicalize-on-dispatch
  // baseline silently loses: the submitted DOCUMENT equals the baseline
  // document, so normalizing the draft before the outcome is known makes it
  // string-equal to seedBase — the rebase then reads the field as untouched,
  // adopts the concurrent schema, and drops the submitted intent entirely.
  it("keeps a formatting-only schema edit in the retry payload when the save conflicts", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    // Same document as the baseline, compact text — a formatting-only edit.
    const compact = JSON.stringify(SCHEMA);
    fireEvent.change(schemaEditor(), { target: { value: compact } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        outputSchema: SCHEMA,
      },
    ]);
    onSaveContextConfig.mockClear();

    // The save was REJECTED; the refetch carries a concurrent schema.
    const theirs = {
      type: "object",
      properties: { theirs: { type: "number" } },
    };
    rerender(
      <ContextConfigTab
        execution={roundTrip(theirs)}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
        editConflict
      />,
    );

    // The user's raw text survives the rejection (R7.5 raw-string dirtiness) —
    // it is neither normalized away nor replaced by the concurrent schema.
    expect(schemaEditor()).toHaveValue(compact);
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        outputSchema: SCHEMA,
      },
    ]);
  });

  // The baseline fix must not turn a REJECTED save into an accepted one: a
  // concurrent schema change still has to leave the user's document dirty and
  // in the retry payload.
  it("keeps a rejected schema save dirty and retries with the user's document", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    const mine = { type: "object", properties: { mine: { type: "string" } } };
    fireEvent.change(schemaEditor(), {
      target: { value: JSON.stringify(mine) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    onSaveContextConfig.mockClear();

    // The save was rejected; the refetch carries a DIFFERENT concurrent schema.
    const theirs = {
      type: "object",
      properties: { theirs: { type: "number" } },
    };
    rerender(
      <ContextConfigTab
        execution={roundTrip(theirs)}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
        editConflict
      />,
    );

    // The rejection leaves the author's own text in place, unnormalized.
    expect(schemaEditor()).toHaveValue(JSON.stringify(mine));
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      { type: "update-context", contextId: "context-impl", outputSchema: mine },
    ]);
  });

  // A moved revision proves SOME write landed — not that OURS did. While a
  // formatting-only save is in flight the stored document already equals what
  // we sent, so an unrelated concurrent edit (here: max iterations) supplies
  // the one missing conjunct and would acknowledge a submission whose outcome
  // is still unknown. If that save then conflicts, the raw text has already
  // been canonicalized away: nothing is dirty, Save is dead, and the author's
  // edit is gone with no retry — exactly the loss R7.5 forbids. Only the
  // mutation's own success may settle a submission.
  it("holds a pending formatting-only edit through an unrelated revision bump, then retries it on conflict", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      <ContextConfigTab
        execution={startedExecution(schemaContext(), startedContextState(), {
          status: "paused",
        })}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    const compact = JSON.stringify(SCHEMA);
    fireEvent.change(schemaEditor(), { target: { value: compact } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    onSaveContextConfig.mockClear();

    // Someone else's edit lands over SSE while OUR save is still pending: the
    // revision moves, the stored schema does not, and no outcome is known yet.
    const concurrent = schemaContext();
    concurrent.iterationPolicy = {
      ...concurrent.iterationPolicy,
      maxIterations: 12,
    };
    const bumped = startedExecution(concurrent, startedContextState(), {
      status: "paused",
    });
    bumped.liveRevision = 21;
    rerender(
      <ContextConfigTab
        execution={bumped}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
        isSaving
      />,
    );

    // Still the author's raw text, still dirty — the bump was not our receipt.
    expect(schemaEditor()).toHaveValue(compact);
    expect(
      screen.getByTestId("config-output-schema-dirty"),
    ).toBeInTheDocument();

    // Our save now comes back rejected. The edit must still be retryable.
    rerender(
      <ContextConfigTab
        execution={bumped}
        contextId="context-impl"
        onSaveContextConfig={onSaveContextConfig}
        editConflict
      />,
    );

    expect(schemaEditor()).toHaveValue(compact);
    expect(
      screen.getByTestId("config-affordance-conflict"),
    ).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Save changes" });
    expect(retry).not.toBeDisabled();
    fireEvent.click(retry);
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-impl",
        outputSchema: SCHEMA,
      },
    ]);
  });
});

/**
 * The runtime surface's per-assignment reset (R8.3): one cohort member's lane
 * goes back to a clean slate without the whole-context reset's blast radius.
 */
describe("ContextConfigTab — per-assignment reset", () => {
  it("resets one assignment by context and use-site id", () => {
    const onResetAssignment = vi.fn();
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState())}
        contextId="context-impl"
        onResetAssignment={onResetAssignment}
      />,
    );

    fireEvent.click(
      within(
        screen.getByTestId("config-block-context-validator"),
      ).getByLabelText("Reset general"),
    );
    expect(onResetAssignment).toHaveBeenCalledWith("context-impl", "general");
  });

  it("offers no reset while the execution is still running", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState(), {
          status: "running",
        })}
        contextId="context-impl"
        onResetAssignment={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Reset general")).not.toBeInTheDocument();
  });

  it("offers no reset where the host wires none", () => {
    render(
      <ContextConfigTab
        execution={startedExecution(fullContext(), startedContextState())}
        contextId="context-impl"
      />,
    );
    expect(screen.queryByLabelText("Reset general")).not.toBeInTheDocument();
  });
});
