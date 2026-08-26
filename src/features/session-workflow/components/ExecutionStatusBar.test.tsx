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

const resumableHalt: GraphWorkflowHaltReason = {
  type: "agent_turn_failed",
  contextId: "context-plan",
  engine: "claude",
  cause: "sdk_error",
  message: "SDK stream ended unexpectedly",
};

const baseProps = {
  onPause: vi.fn(),
  onResume: vi.fn(),
  onAbort: vi.fn(),
  isMutating: false,
  pendingAction: null,
};

describe("ExecutionStatusBar state chip", () => {
  it("names the execution's state and pulses only while it is running", () => {
    const { rerender } = render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ status: "running", haltReason: null })}
      />,
    );

    expect(screen.getByTestId("execution-state-chip")).toHaveTextContent(
      "running",
    );
    expect(screen.getByTestId("execution-state-dot")).toBeInTheDocument();

    for (const status of ["pending", "paused", "completed"] as const) {
      rerender(
        <ExecutionStatusBar
          {...baseProps}
          execution={makeExecution({ status, haltReason: null })}
        />,
      );
      expect(screen.getByTestId("execution-state-chip")).toHaveTextContent(
        status,
      );
      expect(screen.queryByTestId("execution-state-dot")).toBeNull();
    }
  });
});

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

  it("shows Abandoning… while the halted run's lease is being released", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({
          status: "halted",
          haltReason: resumableHalt,
        })}
        onAbandon={vi.fn()}
        isMutating
        pendingAction="abandon"
      />,
    );

    expect(screen.getByRole("button", { name: /abandoning…/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
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

describe("ExecutionStatusBar gates chip", () => {
  function parked(count: number): GraphWorkflowExecution {
    const base = makeExecution({ status: "running", haltReason: null });
    const ids = ["context-plan", "context-implement"].slice(0, count);
    return {
      ...base,
      contextStates: {
        ...base.contextStates,
        ...Object.fromEntries(
          ids.map((contextId) => [
            contextId,
            {
              ...base.contextStates[contextId]!,
              status: "awaiting_approval" as const,
              pendingApproval: {
                conversationId: `conv-${contextId}`,
                requestedAt: "2026-08-20T10:00:00.000Z",
                decision: null,
                approvalScope: { kind: "whole_tree" as const },
              },
            },
          ]),
        ),
      },
    };
  }

  it("announces one waiting gate in the singular", () => {
    render(<ExecutionStatusBar {...baseProps} execution={parked(1)} />);

    expect(screen.getByText("1 gate awaiting you")).toBeInTheDocument();
  });

  it("counts every waiting gate", () => {
    render(<ExecutionStatusBar {...baseProps} execution={parked(2)} />);

    expect(screen.getByText("2 gates awaiting you")).toBeInTheDocument();
  });

  it("states the count without offering a control on a host with no rail", () => {
    render(<ExecutionStatusBar {...baseProps} execution={parked(1)} />);

    expect(
      screen.queryByRole("button", { name: /gate awaiting you/ }),
    ).toBeNull();
  });

  it("opens the gates list from the chip", async () => {
    const user = userEvent.setup();
    const onOpenGates = vi.fn();
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={parked(1)}
        onOpenGates={onOpenGates}
      />,
    );

    await user.click(screen.getByRole("button", { name: /gate awaiting you/ }));

    expect(onOpenGates).toHaveBeenCalledTimes(1);
  });

  it("does not render the chip when nothing is waiting on the human", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ status: "running", haltReason: null })}
      />,
    );

    expect(screen.queryByText(/awaiting you/)).not.toBeInTheDocument();
  });
});

describe("ExecutionStatusBar contextual summary", () => {
  it("names the active lane, both parallel contexts and the current task", () => {
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

    expect(screen.getByTestId("execution-status-summary")).toHaveTextContent(
      "Lane delivery · context-plan and context-implement running in parallel · task Inspect code",
    );
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
      within(dialog).getByRole("button", { name: /retry join/i }),
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
      within(dialog).getByRole("button", { name: /retry join/i }),
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

describe("ExecutionStatusBar repair activity", () => {
  const breakerHalt: GraphWorkflowHaltReason = {
    type: "circuit_breaker",
    contextId: "context-plan",
    condition: "retry_exhaustion",
    failureCount: 3,
    summary: null,
  };

  const openRound = {
    seq: 1,
    contextId: "context-plan",
    haltType: "circuit_breaker" as const,
    loopGroupId: null,
    // Relative to the real clock: an open round is only believed while its
    // agent's turn budget could still be running, so a fixed past timestamp
    // would read as an orphaned round rather than a live one.
    startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    settledAt: null,
    outcome: null,
    planningDefect: null,
    diagnosis: null,
    operationCount: 0,
    resumed: false,
    conversationId: null,
  };

  it("says a repair agent is working while its round is open", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({
          haltReason: breakerHalt,
          planRepairRounds: [openRound],
        })}
      />,
    );

    const chip = screen.getByTestId("execution-repair-chip");
    expect(chip).toHaveTextContent("repair agent working");
    // The halt headline still stands — the run IS halted; what the chip adds
    // is that something is acting on it.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Circuit breaker tripped in context-plan",
    );
  });

  it("says no agent is working once the round has settled", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({
          haltReason: breakerHalt,
          planRepairRounds: [
            {
              ...openRound,
              settledAt: "2026-08-25T12:08:00.000Z",
              outcome: "declined",
            },
          ],
        })}
      />,
    );

    expect(screen.getByTestId("execution-repair-chip")).toHaveTextContent(
      "no agent working",
    );
  });

  it("says no agent is working on a halt repair never ran for", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ haltReason: resumableHalt })}
      />,
    );

    expect(screen.getByTestId("execution-repair-chip")).toHaveTextContent(
      "no agent working",
    );
  });

  it("makes no liveness claim on a run that is not halted", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ status: "running", haltReason: null })}
      />,
    );

    expect(screen.queryByTestId("execution-repair-chip")).toBeNull();
  });

  it("carries the same claim in the mobile header", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        isMobile
        execution={makeExecution({
          haltReason: breakerHalt,
          planRepairRounds: [openRound],
        })}
      />,
    );

    expect(screen.getByTestId("execution-repair-chip")).toHaveTextContent(
      "repair agent working",
    );
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

  // The halt card shows a disabled "Resume — blocked until the contract is
  // accepted". That claim is only true if the page's OWN resume controls honour
  // it: an enabled Resume in the bar (or a second one in the details dialog)
  // spends another turn against the contract that just refused.
  describe("while the refusing contract is still in force", () => {
    const unrepairedEvents = rejectionEvents.map((entry) => ({
      ...entry,
      event: {
        ...entry.event,
        rejectedAgainstSchema: {
          type: "object",
          properties: { verdict: { type: "string" } },
        },
      },
    }));

    it("offers Resume only in its blocked, unclickable form", async () => {
      const onResume = vi.fn();
      const user = userEvent.setup();
      render(
        <ExecutionStatusBar
          {...baseProps}
          onResume={onResume}
          execution={schemaExecution()}
          events={unrepairedEvents}
        />,
      );

      const resume = screen.getByRole("button", {
        name: "Resume — blocked until the contract is accepted",
      });
      expect(resume).toBeDisabled();
      await user.click(resume);
      expect(onResume).not.toHaveBeenCalled();
    });

    it("withholds the details dialog's resume as well", async () => {
      const onResume = vi.fn();
      const user = userEvent.setup();
      render(
        <ExecutionStatusBar
          {...baseProps}
          onResume={onResume}
          execution={schemaExecution()}
          events={unrepairedEvents}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Details" }));
      const dialog = await screen.findByRole("dialog");
      // The read view keeps its resume in the same blocked form the bar shows —
      // absent, it would read as "this run is over"; enabled, it would let the
      // dialog take the act the bar beside it refuses.
      expect(
        within(dialog).queryByRole("button", { name: /^Resume$/ }),
      ).not.toBeInTheDocument();
      const blocked = within(dialog).getByRole("button", {
        name: "Resume — blocked until the contract is accepted",
      });
      expect(blocked).toBeDisabled();
      await user.click(blocked);
      expect(onResume).not.toHaveBeenCalled();
    });

    it("releases Resume once the contract has been edited", () => {
      const repaired = schemaExecution();
      render(
        <ExecutionStatusBar
          {...baseProps}
          execution={{
            ...repaired,
            workingDefinition: {
              ...repaired.workingDefinition,
              executionContexts:
                repaired.workingDefinition.executionContexts.map((context) =>
                  context.id === "context-plan"
                    ? {
                        ...context,
                        outputSchema: {
                          type: "object",
                          properties: { verdict: { type: "number" } },
                        },
                      }
                    : context,
                ),
            },
          }}
          events={unrepairedEvents}
        />,
      );

      expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
    });

    // A rejection recorded before the contract snapshot existed proves nothing
    // about the live contract, and a run nobody can resume is worse than one
    // resumed a turn early.
    it("does not block when no contract snapshot was recorded", () => {
      render(
        <ExecutionStatusBar
          {...baseProps}
          execution={schemaExecution()}
          events={rejectionEvents}
        />,
      );

      expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
    });
  });
});

describe("ExecutionStatusBar destructive confirmation", () => {
  it("aborts only after the confirmation is accepted", async () => {
    const user = userEvent.setup();
    const onAbort = vi.fn();
    render(
      <ExecutionStatusBar
        {...baseProps}
        onAbort={onAbort}
        execution={makeExecution({ status: "running", haltReason: null })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Abort" }));
    expect(onAbort).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Abort execution" }),
    );

    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("leaves the execution alone when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const onAbort = vi.fn();
    render(
      <ExecutionStatusBar
        {...baseProps}
        onAbort={onAbort}
        execution={makeExecution({ status: "running", haltReason: null })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Abort" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(onAbort).not.toHaveBeenCalled();
  });

  it("confirms an abandon with the design's lease copy", async () => {
    const user = userEvent.setup();
    const onAbandon = vi.fn();
    render(
      <ExecutionStatusBar
        {...baseProps}
        onAbandon={onAbandon}
        execution={makeExecution({
          status: "halted",
          haltReason: {
            type: "agent_turn_failed",
            contextId: "context-plan",
            engine: "claude",
            cause: "sdk_error",
            message: "SDK stream ended unexpectedly",
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Abandon" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        "End this resumably halted execution's lease and move it to History.",
      ),
    ).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: "Abandon execution" }),
    );
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("pauses without a confirmation, because pausing is reversible", async () => {
    const user = userEvent.setup();
    const onPause = vi.fn();
    render(
      <ExecutionStatusBar
        {...baseProps}
        onPause={onPause}
        execution={makeExecution({ status: "running", haltReason: null })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(onPause).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("ExecutionStatusBar definition approval", () => {
  const parked = () =>
    makeExecution({
      status: "pending",
      haltReason: null,
      definitionApproval: {
        requestedAt: "2026-08-20T09:00:00.000Z",
        approvedAt: null,
      },
    });

  it("states that the snapshot is frozen for the decision", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={parked()}
        onApproveDefinition={vi.fn()}
        onRejectDefinition={vi.fn()}
      />,
    );

    expect(screen.getByTestId("execution-status-summary")).toHaveTextContent(
      "Definition awaiting approval · the snapshot is frozen for the decision",
    );
  });

  it("approves without a confirmation and shows its pending label", async () => {
    const user = userEvent.setup();
    const onApproveDefinition = vi.fn();
    const { rerender } = render(
      <ExecutionStatusBar
        {...baseProps}
        execution={parked()}
        onApproveDefinition={onApproveDefinition}
        onRejectDefinition={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApproveDefinition).toHaveBeenCalledTimes(1);

    rerender(
      <ExecutionStatusBar
        {...baseProps}
        execution={parked()}
        onApproveDefinition={onApproveDefinition}
        onRejectDefinition={vi.fn()}
        isApprovingDefinition
        isMutating
      />,
    );
    const approving = screen.getByRole("button", { name: "Approving…" });
    expect(approving).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("rejects only after the confirmation naming the move to History is accepted", async () => {
    const user = userEvent.setup();
    const onRejectDefinition = vi.fn();
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={parked()}
        onApproveDefinition={vi.fn()}
        onRejectDefinition={onRejectDefinition}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onRejectDefinition).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("move the execution to History");
    await user.click(
      within(dialog).getByRole("button", { name: "Reject definition" }),
    );

    expect(onRejectDefinition).toHaveBeenCalledTimes(1);
  });

  it("reports a refused decision where the decision was made", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={parked()}
        onApproveDefinition={vi.fn()}
        onRejectDefinition={vi.fn()}
        definitionApprovalError="The execution changed since you started reviewing."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The execution changed since you started reviewing.",
    );
  });

  it("offers no decision on a read-only historical selection", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={parked()}
        onApproveDefinition={vi.fn()}
        onRejectDefinition={vi.fn()}
        allowActions={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });
});

// M2: at 768px and below the bar is a header — state, which run it is, and the
// one control that state is about — with everything else the matrix admits
// moved into the Executions sheet the run chip opens.
describe("ExecutionStatusBar mobile header (M2)", () => {
  function renderMobile(
    overrides: Partial<React.ComponentProps<typeof ExecutionStatusBar>> = {},
  ) {
    const onSelect = vi.fn();
    const view = render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ status: "running", haltReason: null })}
        isMobile
        executionChipLabel="exec_abc · Current"
        renderExecutionsSheet={(close) => (
          <button
            type="button"
            onClick={() => {
              close();
              onSelect();
            }}
          >
            Pick another execution
          </button>
        )}
        {...overrides}
      />,
    );
    return { ...view, onSelect };
  }

  it("carries only the state's primary control in the header", async () => {
    const user = userEvent.setup();
    renderMobile();

    // running -> [Pause, Abort]: Pause is the state's control, Abort is not.
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort" })).toBeNull();

    await user.click(screen.getByTestId("execution-chip"));
    expect(screen.getByRole("button", { name: "Abort" })).toBeInTheDocument();
  });

  it("keeps the same confirmation on a control taken from the sheet", async () => {
    const user = userEvent.setup();
    const onAbort = vi.fn();
    renderMobile({ onAbort });

    await user.click(screen.getByTestId("execution-chip"));
    await user.click(screen.getByRole("button", { name: "Abort" }));

    // The destructive act is still gated by the matrix's own prompt, and the
    // sheet has stepped aside for it.
    expect(screen.getByText("Abort workflow execution?")).toBeInTheDocument();
    expect(onAbort).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Abort execution" }));
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("opens the Executions sheet from the run chip and closes it on a selection", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderMobile();

    const chip = screen.getByTestId("execution-chip");
    expect(chip).toHaveTextContent("exec_abc · Current");
    expect(chip).toHaveAttribute("aria-expanded", "false");

    await user.click(chip);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Pick another execution" }),
    );
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives the gates count its own strip under the header", async () => {
    const user = userEvent.setup();
    const onOpenGates = vi.fn();
    const base = makeExecution({ status: "running", haltReason: null });
    const gated: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "awaiting_approval",
          pendingApproval: {
            conversationId: "conv-context-plan",
            requestedAt: "2026-08-20T10:00:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" },
          },
        },
      },
    };

    renderMobile({ execution: gated, onOpenGates });

    const strip = screen.getByRole("button", { name: /gate.* awaiting you/ });
    // Its own row, not a chip wedged into the header line.
    expect(strip).not.toBe(screen.getByTestId("execution-chip"));
    await user.click(strip);
    expect(onOpenGates).toHaveBeenCalledOnce();
  });

  it("offers no run chip when the host wired no sheet", () => {
    render(
      <ExecutionStatusBar
        {...baseProps}
        execution={makeExecution({ status: "running", haltReason: null })}
        isMobile
      />,
    );
    expect(screen.queryByTestId("execution-chip")).toBeNull();
  });
});
