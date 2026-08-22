import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import {
  countExecutionGates,
  deriveExecutionStatusSummary,
} from "./execution-status-summary";

function contextState(
  base: GraphWorkflowExecution,
  contextId: string,
  overrides: Partial<GraphWorkflowExecutionContextState>,
): GraphWorkflowExecutionContextState {
  const existing = base.contextStates[contextId];
  if (!existing) throw new Error(`missing fixture context state ${contextId}`);
  return { ...existing, ...overrides };
}

/** Two contexts placed on one lane and both running, as in the design fixture. */
function parallelLaneExecution(): GraphWorkflowExecution {
  const base = createWorkflowExecution({ status: "running" });
  return {
    ...base,
    status: "running",
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
      "context-plan": contextState(base, "context-plan", {
        status: "running",
        laneId: "delivery",
      }),
      "context-implement": contextState(base, "context-implement", {
        status: "running",
        laneId: "delivery",
      }),
    },
  };
}

function summaryText(execution: GraphWorkflowExecution): string {
  return deriveExecutionStatusSummary(execution)
    .map((part) => part.text)
    .join("");
}

describe("deriveExecutionStatusSummary", () => {
  it("names the active lane, both parallel contexts, and the current task", () => {
    expect(summaryText(parallelLaneExecution())).toBe(
      "Lane delivery · context-plan and context-implement running in parallel · task Inspect code",
    );
  });

  it("emphasizes the lane, context and task names and nothing else", () => {
    const emphasized = deriveExecutionStatusSummary(parallelLaneExecution())
      .filter((part) => part.emphasis)
      .map((part) => part.text);

    expect(emphasized).toEqual([
      "delivery",
      "context-plan",
      "context-implement",
      "Inspect code",
    ]);
  });

  it("drops the parallel phrasing for a single running context", () => {
    const base = parallelLaneExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      activeContextIds: ["context-plan"],
      contextStates: {
        ...base.contextStates,
        "context-implement": contextState(base, "context-implement", {
          status: "pending",
          laneId: null,
        }),
      },
    };

    expect(summaryText(execution)).toBe(
      "Lane delivery · context-plan running · task Inspect code",
    );
  });

  it("skips the task segment once every task of the active context is done", () => {
    const base = parallelLaneExecution();
    const taskState = base.taskStates["task-plan-1"];
    if (!taskState) throw new Error("missing fixture task state");
    const execution: GraphWorkflowExecution = {
      ...base,
      activeContextIds: ["context-plan"],
      taskStates: {
        ...base.taskStates,
        "task-plan-1": { ...taskState, status: "completed" },
      },
    };

    expect(summaryText(execution)).toBe("Lane delivery · context-plan running");
  });

  it("never calls a context running while it is parked on a gate", () => {
    // A gate does not remove its context from activeContextIds, so active
    // membership alone would claim "running" beside a chip saying the same
    // context is waiting on the operator.
    const base = parallelLaneExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-implement": contextState(base, "context-implement", {
          status: "awaiting_approval",
          laneId: "delivery",
          pendingApproval: {
            conversationId: "conv-approval",
            requestedAt: "2026-08-20T10:00:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" },
          },
        }),
      },
    };

    expect(summaryText(execution)).toBe(
      "Lane delivery · context-plan running · context-implement awaiting you · task Inspect code",
    );
  });

  it("reports a parked context as awaiting rather than running when nothing runs", () => {
    const base = parallelLaneExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": contextState(base, "context-plan", {
          status: "awaiting_user_input",
          laneId: "delivery",
        }),
        "context-implement": contextState(base, "context-implement", {
          status: "awaiting_approval",
          laneId: "delivery",
          pendingApproval: {
            conversationId: "conv-approval",
            requestedAt: "2026-08-20T10:00:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" },
          },
        }),
      },
    };

    // No running context means no current task to name either.
    expect(summaryText(execution)).toBe(
      "Lane delivery · context-plan and context-implement awaiting you",
    );
  });

  it("ignores an active context that is neither running nor parked on a gate", () => {
    const base = parallelLaneExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-implement": contextState(base, "context-implement", {
          status: "ready",
          laneId: "delivery",
        }),
      },
    };

    expect(summaryText(execution)).toBe(
      "Lane delivery · context-plan running · task Inspect code",
    );
  });

  it("says the run has no active context rather than naming a lane", () => {
    const execution = createWorkflowExecution({
      status: "pending",
      activeContextIds: [],
    });

    expect(summaryText(execution)).toBe("No context is running");
  });
});

describe("countExecutionGates", () => {
  it("counts a context parked on an approval gate", () => {
    const base = createWorkflowExecution({ status: "running" });
    const execution: GraphWorkflowExecution = {
      ...base,
      status: "running",
      contextStates: {
        ...base.contextStates,
        "context-plan": contextState(base, "context-plan", {
          status: "awaiting_approval",
          pendingApproval: {
            conversationId: "conv-approval",
            requestedAt: "2026-08-20T10:00:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" },
          },
        }),
      },
    };

    expect(countExecutionGates(execution)).toBe(1);
  });

  it("counts each parked question lane alongside approvals", () => {
    const base = createWorkflowExecution({ status: "running" });
    const execution: GraphWorkflowExecution = {
      ...base,
      status: "running",
      contextStates: {
        ...base.contextStates,
        "context-plan": contextState(base, "context-plan", {
          status: "awaiting_approval",
          pendingApproval: {
            conversationId: "conv-approval",
            requestedAt: "2026-08-20T10:00:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" },
          },
        }),
        "context-implement": contextState(base, "context-implement", {
          status: "awaiting_user_input",
          pendingUserInputs: {
            implementer: {
              conversationId: "conv-1",
              lane: "implementer",
              questionBatchId: "batch-1",
              questions: [
                {
                  question: "Should the toggle default to on?",
                  header: "Toggle",
                  options: [
                    { label: "Yes", recommended: true },
                    { label: "No", recommended: false },
                  ],
                  multiSelect: false,
                  required: true,
                  allowNote: true,
                },
              ],
              requestedAt: "2026-08-20T10:01:00.000Z",
              roundSeq: null,
              answers: null,
            },
          },
        }),
      },
    };

    expect(countExecutionGates(execution)).toBe(2);
  });

  it("counts no gate on a run that can never act on one", () => {
    const base = createWorkflowExecution({ status: "running" });
    const parked: GraphWorkflowExecution = {
      ...base,
      status: "completed",
      contextStates: {
        ...base.contextStates,
        "context-plan": contextState(base, "context-plan", {
          status: "awaiting_approval",
          pendingApproval: {
            conversationId: "conv-approval",
            requestedAt: "2026-08-20T10:00:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" },
          },
        }),
      },
    };

    expect(countExecutionGates(parked)).toBe(0);
  });

  it("counts no gate for an approval that was already decided", () => {
    const base = createWorkflowExecution({ status: "running" });
    const execution: GraphWorkflowExecution = {
      ...base,
      status: "running",
      contextStates: {
        ...base.contextStates,
        "context-plan": contextState(base, "context-plan", {
          status: "awaiting_approval",
          pendingApproval: {
            conversationId: "conv-approval",
            requestedAt: "2026-08-20T10:00:00.000Z",
            decision: {
              type: "approved",
              decidedAt: "2026-08-20T10:05:00.000Z",
            },
            approvalScope: { kind: "whole_tree" },
          },
        }),
      },
    };

    expect(countExecutionGates(execution)).toBe(0);
  });
});

describe("deriveExecutionStatusSummary — awaiting definition approval", () => {
  it("says the run is parked and that its snapshot is frozen for the decision", () => {
    const parked = createWorkflowExecution({
      status: "pending",
      definitionApproval: {
        requestedAt: "2026-08-20T09:00:00.000Z",
        approvedAt: null,
      },
    });

    expect(
      deriveExecutionStatusSummary(parked)
        .map((part) => part.text)
        .join(""),
    ).toBe(
      "Definition awaiting approval · the snapshot is frozen for the decision",
    );
  });

  it("returns to the running sentence once the definition is approved", () => {
    const approved = createWorkflowExecution({
      status: "running",
      definitionApproval: {
        requestedAt: "2026-08-20T09:00:00.000Z",
        approvedAt: "2026-08-20T09:05:00.000Z",
      },
    });

    expect(
      deriveExecutionStatusSummary(approved)
        .map((part) => part.text)
        .join(""),
    ).not.toContain("frozen for the decision");
  });
});
