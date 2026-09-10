import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import {
  countExecutionGates,
  deriveExecutionStatusSummary,
} from "@/lib/workflow-graph/execution-status-summary";

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

  /**
   * The merge window the bar was blind to. Every context has finished, so the
   * old sentence read "No context is running" — true, and a poor description of
   * a run that is actively merging lane worktrees and may be running validation
   * commands inside them.
   */
  it("names the lane merge in flight instead of reporting nothing running", () => {
    const base = parallelLaneExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      activeContextIds: [],
      contextStates: {
        ...base.contextStates,
        "context-plan": contextState(base, "context-plan", {
          status: "completed",
          laneId: "delivery",
        }),
        "context-implement": contextState(base, "context-implement", {
          status: "completed",
          laneId: "delivery",
        }),
      },
      joins: {
        "join-publish": {
          joinId: "join-publish",
          kind: "final_publish",
          contextId: null,
          targetLaneId: "__session__",
          sourceLaneIds: ["delivery", "docs"],
          mergedSourceLaneIds: ["docs"],
          validationDebtSourceLaneIds: [],
          status: "running",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
          completedAt: null,
        },
      },
    };

    expect(summaryText(execution)).toBe("Merging delivery → session");
  });

  it("emphasizes the lane names in the merge sentence", () => {
    const base = parallelLaneExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      activeContextIds: [],
      joins: {
        "join-publish": {
          joinId: "join-publish",
          kind: "final_publish",
          contextId: null,
          targetLaneId: "__session__",
          sourceLaneIds: ["delivery"],
          mergedSourceLaneIds: [],
          validationDebtSourceLaneIds: [],
          status: "running",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
          completedAt: null,
        },
      },
    };

    expect(
      deriveExecutionStatusSummary(execution)
        .filter((part) => part.emphasis)
        .map((part) => part.text),
    ).toEqual(["delivery", "session"]);
  });

  /**
   * A running context outranks the merge: the merge is background work, and the
   * bar's first duty is naming what an agent is doing right now.
   */
  it("keeps reporting the running context when a merge runs beside it", () => {
    const base = parallelLaneExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      activeContextIds: ["context-plan"],
      contextStates: {
        ...base.contextStates,
        "context-implement": contextState(base, "context-implement", {
          status: "completed",
          laneId: "delivery",
        }),
      },
      joins: {
        "join-merge": {
          joinId: "join-merge",
          kind: "context_merge",
          contextId: null,
          targetLaneId: "__session__",
          sourceLaneIds: ["delivery"],
          mergedSourceLaneIds: [],
          validationDebtSourceLaneIds: [],
          status: "running",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
          completedAt: null,
        },
      },
    };

    expect(summaryText(execution)).toBe(
      "Lane delivery · context-plan running · task Inspect code",
    );
  });

  /**
   * Every source lane already merged: the join is finalizing rather than
   * carrying any particular lane, so naming one would be wrong.
   */
  it("drops the source list once the join has merged every lane", () => {
    const base = parallelLaneExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      activeContextIds: [],
      joins: {
        "join-publish": {
          joinId: "join-publish",
          kind: "final_publish",
          contextId: null,
          targetLaneId: "__session__",
          sourceLaneIds: ["delivery"],
          mergedSourceLaneIds: ["delivery"],
          validationDebtSourceLaneIds: [],
          status: "running",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
          completedAt: null,
        },
      },
    };

    expect(summaryText(execution)).toBe("Publishing → session");
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
