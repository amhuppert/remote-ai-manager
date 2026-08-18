// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import ExecutionStatusBar from "./ExecutionStatusBar";

function makeExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "halted",
    ...overrides,
  });
}

const baseProps = {
  onPause: vi.fn(),
  onResume: vi.fn(),
  onAbort: vi.fn(),
  isMutating: false,
  pendingAction: null,
};

describe("ExecutionStatusBar per-action pending feedback", () => {
  it("shows Pausing… on the pause button and disables the others while pause is in flight", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ status: "running", haltReason: null })}
        isMutating
        pendingAction="pause"
      />,
    );

    const pauseBtn = screen.getByRole("button", { name: /pausing…/i });
    expect(pauseBtn).toBeDisabled();
    expect(screen.getByRole("button", { name: "Abort" })).toBeDisabled();
  });

  it("shows Resuming… while resume is in flight", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ status: "paused", haltReason: null })}
        isMutating
        pendingAction="resume"
      />,
    );

    expect(screen.getByRole("button", { name: /resuming…/i })).toBeDisabled();
  });

  it("shows Aborting… while abort is in flight", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ status: "running", haltReason: null })}
        isMutating
        pendingAction="abort"
      />,
    );

    expect(screen.getByRole("button", { name: /aborting…/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
  });

  it("offers no control on a settled run, which released its lease on its own", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ status: "completed", haltReason: null })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort" })).toBeNull();
  });

  it("keeps static labels when no control action is pending", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ status: "running", haltReason: null })}
        isMutating
      />,
    );

    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Abort" })).toBeDisabled();
  });
});

describe("ExecutionStatusBar awaiting-approval chip", () => {
  it("renders an awaiting-approval chip with count when a context is parked", () => {
    const base = makeExecution({ status: "running", haltReason: null });
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "awaiting_approval",
        },
      },
    };

    render(<ExecutionStatusBar {...baseProps} execution={execution} />);

    const chip = screen.getByText("1 awaiting approval");
    expect(chip).toBeInTheDocument();
  });

  it("counts multiple parked contexts in the chip", () => {
    const base = makeExecution({ status: "running", haltReason: null });
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "awaiting_approval",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "awaiting_approval",
        },
      },
    };

    render(<ExecutionStatusBar {...baseProps} execution={execution} />);

    expect(screen.getByText("2 awaiting approval")).toBeInTheDocument();
  });

  it("does not render the chip when no context is awaiting approval", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ status: "running", haltReason: null })}
      />,
    );

    expect(screen.queryByText(/awaiting approval/)).not.toBeInTheDocument();
  });
});

describe("ExecutionStatusBar lane activity", () => {
  it("shows both concurrently active members of an authored lane", () => {
    const base = makeExecution({ status: "running", haltReason: null });
    const execution = makeExecution({
      status: "running",
      haltReason: null,
      activeContextIds: ["context-plan", "context-implement"],
      workingDefinition: {
        ...base.workingDefinition,
        executionContexts: base.workingDefinition.executionContexts.map(
          (context) =>
            context.id === "context-plan" || context.id === "context-implement"
              ? {
                  ...context,
                  placement: {
                    lane: "delivery",
                    mode: "owned" as const,
                    ownedPaths: [`src/${context.id}`],
                  },
                }
              : context,
        ),
      },
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "running",
          laneId: "delivery",
          batchId: "batch-1",
        },
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "running",
          laneId: "delivery",
          batchId: "batch-1",
        },
      },
      executionLanes: {
        delivery: {
          laneId: "delivery",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/delivery",
          branchName: "csm/delivery",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-08-09T12:00:00.000Z",
          updatedAt: "2026-08-09T12:00:00.000Z",
        },
      },
    });

    render(<ExecutionStatusBar {...baseProps} execution={execution} />);

    const lane = screen.getByTestId("execution-lane-activity");
    expect(lane).toHaveTextContent("delivery");
    expect(lane).toHaveTextContent("context-plan: running");
    expect(lane).toHaveTextContent("context-implement: running");
  });
});

const longJoinFailure: GraphWorkflowHaltReason = {
  type: "join_failure",
  joinId: "join-final",
  joinKind: "final_publish",
  contextId: null,
  sourceLaneIds: ["lane-a", "lane-b", "lane-c"],
  targetLaneId: "__session__",
  message:
    "Pre-merge validation failed\n$ bun scripts/generate-build-info.ts\n$ bun run build:cli\nDetected additional lockfiles",
  conflictFiles: [
    "src/lib/specs/compiler.ts",
    "src/lib/specs/policy.ts",
    "src/lib/specs/queries.ts",
  ],
};

describe("ExecutionStatusBar halt display", () => {
  it("stays a terse headline-only chip for the delivery-approval halt — remediation lives on the card and dialog", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({
          haltReason: {
            type: "delivery_gate_failed",
            unmet: [],
            instruction:
              "Approve delivery in Spec Studio: open the spec's Controls view → Merge gate → Approve delivery for merge, then resume the merge.",
            refusalCode: "approval_required",
            spec: {
              specSlug: "audit-log",
              specName: "Audit Log",
              projectName: "command-center",
            },
          },
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Delivery gate — waiting on your approval",
    );
    expect(
      screen.queryByRole("link", { name: /Open the merge gate/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details" })).toBeInTheDocument();
  });

  it("keeps the bar to a one-line summary: headline visible, detail withheld", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ haltReason: longJoinFailure })}
      />,
    );

    const summary = screen.getByRole("alert");
    expect(summary).toHaveTextContent(
      "Publish to session failed — 3 source lane(s) → __session__",
    );
    // The long message body and per-file conflict list must stay out of the
    // bar — they previously grew it past the viewport.
    expect(
      screen.queryByText(/Pre-merge validation failed/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("src/lib/specs/compiler.ts"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details" })).toBeInTheDocument();
  });

  it("opens a details dialog with the full message, conflict files, guidance, and recovery form", async () => {
    const user = userEvent.setup();
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ haltReason: longJoinFailure })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Details" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Pre-merge validation failed/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("src/lib/specs/compiler.ts"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Resolve conflicts in the target worktree/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /retry merge/i }),
    ).toBeInTheDocument();
  });

  it("retries the join merge with per-file guidance entered in the dialog", async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    render(
      <ExecutionStatusBar
        {...baseProps}
        onResume={onResume}
        execution={makeExecution({ haltReason: longJoinFailure })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("Guidance for src/lib/specs/compiler.ts"),
      "keep the lane-a side",
    );
    await user.click(
      within(dialog).getByRole("button", { name: /retry merge/i }),
    );

    expect(onResume).toHaveBeenCalledWith([
      {
        file: "src/lib/specs/compiler.ts",
        decision: "rejected",
        feedback: "keep the lane-a side",
      },
    ]);
  });

  it("counts secondary failures in the summary and lists them in the dialog", async () => {
    const user = userEvent.setup();
    const haltReason: GraphWorkflowHaltReason = {
      type: "merge_precondition_failed",
      contextId: "context-a",
      targetBranch: "csm/session-1",
      dirtyPaths: [],
      totalDirtyCount: 0,
      message: "blocked",
    };
    const secondary: GraphWorkflowHaltReason[] = [
      {
        type: "agent_turn_failed",
        contextId: "context-b",
        engine: "claude",
        cause: "sdk_error",
        message: "boom",
      },
      {
        type: "agent_turn_failed",
        contextId: "context-c",
        engine: "codex",
        cause: "unknown",
        message: "kaboom",
      },
    ];

    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({
          haltReason,
          secondaryHaltReasons: secondary,
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("+2 more");

    await user.click(screen.getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Agent turn failed in context-b \(claude\)/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Agent turn failed in context-c \(codex\)/),
    ).toBeInTheDocument();
  });

  it("resumes from the dialog footer for a non-join halt", async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    const haltReason: GraphWorkflowHaltReason = {
      type: "agent_turn_failed",
      contextId: "context-b",
      engine: "claude",
      cause: "sdk_error",
      message: "SDK stream ended unexpectedly",
    };

    render(
      <ExecutionStatusBar
        {...baseProps}
        onResume={onResume}
        execution={makeExecution({ haltReason })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Resume" }));

    expect(onResume).toHaveBeenCalledWith();
  });

  it("does not render a halt summary when haltReason is null", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({
          status: "running",
          haltReason: null,
        })}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Details" }),
    ).not.toBeInTheDocument();
  });
});

describe("ExecutionStatusBar output-schema halt (R3.2)", () => {
  const haltReason: GraphWorkflowHaltReason = {
    type: "circuit_breaker",
    contextId: "context-plan",
    condition: "output_schema_validation",
    failureCount: 3,
    summary: "Output schema not satisfied",
  };

  function schemaExecution(): GraphWorkflowExecution {
    const execution = makeExecution({ haltReason });
    return {
      ...execution,
      workingDefinition: {
        ...execution.workingDefinition,
        executionContexts: execution.workingDefinition.executionContexts.map(
          (context) =>
            context.id === "context-plan"
              ? {
                  ...context,
                  outputSchema: {
                    type: "object",
                    properties: { verdict: { type: "string" } },
                  },
                }
              : context,
        ),
      },
    };
  }

  const rejectionEvents = [
    {
      occurredAt: "2026-03-27T09:41:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: "project",
        sessionName: "session-1",
        executionId: "execution-1",
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "output_schema" as const,
        pass: false,
        summary: "Output rejected",
        reopenTaskIds: [],
        issues: [
          {
            title: "/verdict",
            description: "not one of the allowed values",
            path: "/verdict",
          },
        ],
        rejectedOutput: '{ "verdict": "partial" }',
        gateRepairAttempts: null,
        gateRepairBudget: null,
      },
    },
  ];

  it("keeps the one-line headline in the bar itself", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={schemaExecution()}
        events={rejectionEvents}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      /Output schema not satisfied in context-plan/,
    );
    // The evidence belongs behind Details — the bar's height must never depend
    // on the size of the failure.
    expect(screen.queryByText("Rejected output")).not.toBeInTheDocument();
  });

  it("shows the refused payload, contract and issue paths in the details dialog", async () => {
    const user = userEvent.setup();
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={schemaExecution()}
        events={rejectionEvents}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText("/verdict")).toBeInTheDocument();
    expect(within(dialog).getByText("Rejected output")).toBeInTheDocument();
    expect(within(dialog).getByText("Declared schema")).toBeInTheDocument();
  });

  it("routes the Edit schema action to the halted context's config", async () => {
    const user = userEvent.setup();
    const onEditSchema = vi.fn();
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={schemaExecution()}
        events={rejectionEvents}
        onEditSchema={onEditSchema}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Edit schema" }),
    );

    expect(onEditSchema).toHaveBeenCalledWith("context-plan");
  });
});
