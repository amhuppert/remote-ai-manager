import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowHaltReason,
  GraphWorkflowPendingUserInput,
} from "@/lib/workflow-graph/schemas";
import { deriveExecutionGates } from "@/lib/workflow-graph/execution-gates";

function pendingInput(
  questions: string[],
  overrides: Partial<GraphWorkflowPendingUserInput> = {},
): GraphWorkflowPendingUserInput {
  return {
    lane: "implementer",
    roundSeq: 1,
    conversationId: "conv-1",
    questionBatchId: "batch-1",
    questions: questions.map((question, index) => ({
      id: `q${index + 1}`,
      question,
      header: "Q",
      multiSelect: false,
      required: true,
      allowNote: true,
      options: [{ label: "yes", recommended: true, description: "" }],
    })),
    requestedAt: "2026-03-27T10:00:00.000Z",
    answers: null,
    ...overrides,
  };
}

function waiting(options: {
  approvalIteration?: number;
  questions?: string[];
  status?: GraphWorkflowExecution["status"];
}): GraphWorkflowExecution {
  const base = createWorkflowExecution({ status: options.status ?? "running" });
  const planState = base.contextStates["context-plan"]!;
  const implementState = base.contextStates["context-implement"]!;
  return {
    ...base,
    contextStates: {
      ...base.contextStates,
      ...(options.approvalIteration === undefined
        ? {}
        : {
            "context-plan": {
              ...planState,
              status: "awaiting_approval" as const,
              iterationCount: options.approvalIteration,
              pendingApproval: {
                conversationId: "conv-approval",
                requestedAt: "2026-03-27T10:00:00.000Z",
                decision: null,
                approvalScope: { kind: "whole_tree" as const },
              },
            },
          }),
      ...(options.questions === undefined
        ? {}
        : {
            "context-implement": {
              ...implementState,
              status: "awaiting_user_input" as const,
              pendingUserInputs: {
                implementer: pendingInput(options.questions),
              },
            },
          }),
    },
  };
}

const JOIN_ID = "join_delivery_1";

/**
 * A run halted on a conflicted join, as the engine persists one: per-source
 * merge progress lives on `execution.joins[joinId]`, and the frozen
 * `sourceLaneContextIds` map — not context state — is what names the members.
 */
function haltedOnJoin(
  joinOverrides: Partial<GraphWorkflowExecutionJoinState> = {},
  haltOverrides: Partial<
    Extract<GraphWorkflowHaltReason, { type: "join_failure" }>
  > = {},
): GraphWorkflowExecution {
  const base = createWorkflowExecution({ status: "halted" });
  const lane = (
    laneId: string,
    includedContextIds: string[],
  ): GraphWorkflowExecution["executionLanes"][string] => ({
    laneId,
    kind: "worktree",
    status: "active",
    worktreePath: `/tmp/${laneId}`,
    branchName: `wf/${laneId}`,
    includedContextIds,
    lastCommittingContextId: includedContextIds[0] ?? null,
    commitSnapshots: [],
    createdAt: "2026-08-21T09:00:00.000Z",
    updatedAt: "2026-08-21T10:00:00.000Z",
  });
  return {
    ...base,
    haltReason: {
      type: "join_failure",
      joinId: JOIN_ID,
      joinKind: "context_merge",
      contextId: "context-implement",
      sourceLaneIds: ["lane-plan", "lane-implement"],
      targetLaneId: "delivery",
      message: "merge conflict",
      conflictFiles: ["src/checkout/audit.ts"],
      ...haltOverrides,
    },
    joins: {
      [JOIN_ID]: {
        joinId: JOIN_ID,
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
        createdAt: "2026-08-21T10:00:00.000Z",
        updatedAt: "2026-08-21T10:05:00.000Z",
        completedAt: null,
        ...joinOverrides,
      },
    },
    executionLanes: {
      "lane-plan": lane("lane-plan", ["context-plan"]),
      "lane-implement": lane("lane-implement", ["context-implement"]),
    },
  };
}

describe("deriveExecutionGates", () => {
  it("names a context approval's iteration in the row's own words", () => {
    const gates = deriveExecutionGates(waiting({ approvalIteration: 2 }));

    expect(gates).toEqual([
      {
        kind: "approval",
        contextId: "context-plan",
        contextTitle: "Plan",
        detail: "context approval · iteration 2 candidate",
      },
    ]);
  });

  it("quotes a single parked question and names the lane that asked it", () => {
    const gates = deriveExecutionGates(
      waiting({ questions: ["Should the toggle default to on?"] }),
    );

    expect(gates).toEqual([
      {
        kind: "question",
        contextId: "context-implement",
        contextTitle: "Implement",
        laneKey: "implementer",
        detail: 'parked question · "Should the toggle default to on?"',
      },
    ]);
  });

  it("counts a batch rather than quoting one of several questions", () => {
    const gates = deriveExecutionGates(
      waiting({ questions: ["Which branch?", "Which model?"] }),
    );

    expect(gates[0]?.detail).toBe("parked question · 2 questions awaiting you");
  });

  it("lists an approval and a question as separate rows, each naming its context", () => {
    const gates = deriveExecutionGates(
      waiting({ approvalIteration: 1, questions: ["Which branch?"] }),
    );

    expect(gates.map((gate) => [gate.kind, gate.contextId])).toEqual([
      ["approval", "context-plan"],
      ["question", "context-implement"],
    ]);
  });

  it("is empty on a run that can no longer act on an answer", () => {
    expect(
      deriveExecutionGates(
        waiting({ approvalIteration: 2, status: "completed" }),
      ),
    ).toEqual([]);
  });
});

// README §11 routes join conflicts to the Overview gates list as well as to the
// lane rail. A conflicted join is a wait on the human exactly like an approval:
// nothing on the run advances until someone resolves the merge.
describe("deriveExecutionGates on a conflicted join", () => {
  it("lists the join, naming the blocked member and the lane it was merging into", () => {
    const gates = deriveExecutionGates(haltedOnJoin());

    expect(gates).toEqual([
      {
        kind: "join",
        joinId: JOIN_ID,
        contextId: "context-implement",
        contextTitle: "Implement",
        detail:
          "join conflict · merging into delivery · Implement blocked: both wrote the timeout branch",
      },
    ]);
  });

  // A blocked lane can carry several contexts. The row is a control: whatever
  // context it names is the one clicking it must open, or the operator is sent
  // to a context the list never mentioned.
  it("names the same context it opens when the blocked lane carries several", () => {
    const base = haltedOnJoin({
      sourceLaneContextIds: {
        "lane-plan": ["context-plan"],
        "lane-implement": ["context-implement", "context-verify"],
      },
    });
    const gates = deriveExecutionGates({
      ...base,
      executionLanes: {
        ...base.executionLanes,
        "lane-implement": {
          ...base.executionLanes["lane-implement"]!,
          includedContextIds: ["context-implement", "context-verify"],
          lastCommittingContextId: "context-verify",
        },
      },
    });

    expect(gates[0]?.contextId).toBe("context-verify");
    expect(gates[0]?.contextTitle).toBe("Verify");
    expect(gates[0]?.detail).toContain("Verify blocked");
  });

  // Neither the join's frozen roster nor live lane membership knows what the
  // blocked lane carried — the row names the lane rather than inventing a
  // context to send the operator to.
  it("names the lane when neither roster can resolve a blocked context", () => {
    const base = haltedOnJoin({ sourceLaneContextIds: {} });
    const gates = deriveExecutionGates({
      ...base,
      executionLanes: {
        ...base.executionLanes,
        "lane-implement": {
          ...base.executionLanes["lane-implement"]!,
          includedContextIds: [],
        },
      },
    });

    expect(gates[0]?.contextId).toBeNull();
    expect(gates[0]?.detail).toContain("lane-implement blocked");
  });

  it("raises no join row once the join is abandoned and can no longer be resolved", () => {
    const execution = haltedOnJoin();
    expect(
      deriveExecutionGates({
        ...execution,
        abandonment: {
          abandonedAt: "2026-08-21T11:00:00.000Z",
          actor: { kind: "human" },
          reason: "superseded",
        },
      }),
    ).toEqual([]);
  });
});
