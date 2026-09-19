import { describe, expect, it } from "vitest";
import {
  createWorkflowExecution,
  makeSeededValidatorAssignment,
} from "./test-fixtures";
import { laneStateKey } from "./lane-identity";
import {
  ResetAssignmentError,
  resetExecutionContextAssignment,
} from "./reset-assignment";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowValidationSpecialist,
} from "./schemas";

const CONTEXT_ID = "context-implement";
const ALPHA = laneStateKey("context_validator", "alpha");
const BETA = laneStateKey("context_validator", "beta");

function makeLane(
  conversationId: string,
  assignmentId: string,
): GraphWorkflowAgentSessionState {
  return {
    lane: "context_validator",
    contextId: CONTEXT_ID,
    assignmentId,
    assignmentFingerprint: `fingerprint-${assignmentId}`,
    backend: "claude",
    workflowConversationId: conversationId,
    metrics: {},
    lastUsedAt: "2026-04-01T10:00:00.000Z",
  };
}

function makeSpecialist(
  overrides: Partial<GraphWorkflowValidationSpecialist> = {},
): GraphWorkflowValidationSpecialist {
  return {
    state: "pending",
    attempts: 0,
    summary: null,
    issues: [],
    advisories: [],
    questionToken: null,
    sessionRef: null,
    reviewArtifact: null,
    lastInfraFailure: null,
    ...overrides,
  };
}

/**
 * A halted execution mid-round: two validator assignments hold independent
 * lanes, alpha already returned a failing verdict, beta is still pending.
 */
function makeExecution(
  overrides: {
    status?: GraphWorkflowExecution["status"];
    roundPhase?: "specialists" | "concluded";
  } = {},
): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    status: overrides.status ?? "halted",
  });
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === CONTEXT_ID,
  )!;
  context.contextValidator = {
    enabled: true,
    assignments: [
      makeSeededValidatorAssignment({ id: "alpha" }),
      makeSeededValidatorAssignment({ id: "beta" }),
    ],
  };

  execution.laneStates = {
    [CONTEXT_ID]: {
      implementer: {
        ...makeLane("conv-implementer", "alpha"),
        lane: "implementer",
        assignmentId: undefined,
      },
      [ALPHA]: makeLane("conv-alpha", "alpha"),
      [BETA]: makeLane("conv-beta", "beta"),
    },
  };

  const contextState = execution.contextStates[CONTEXT_ID]!;
  contextState.validationRound = {
    seq: 3,
    candidate: {
      identityScope: "wholeTree",
      headSha: "head-1",
      candidateTreeHash: "tree-1",
      taskStateHash: "tasks-1",
    },
    roster: [
      {
        assignmentId: "alpha",
        profileRef: { tier: "builtin", id: "general-reviewer" },
        revision: 1,
        resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
      },
      {
        assignmentId: "beta",
        profileRef: { tier: "builtin", id: "general-reviewer" },
        revision: 1,
        resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
      },
    ],
    specialists: {
      alpha: makeSpecialist({
        state: "verdict_fail",
        attempts: 1,
        summary: "Missing coverage",
        sessionRef: {
          lane: "context_validator",
          backend: "claude",
          ref: "conv-alpha",
        },
      }),
      beta: makeSpecialist({ state: "verdict_pass", attempts: 1 }),
    },
    phase: overrides.roundPhase ?? "specialists",
    outcome: overrides.roundPhase === "concluded" ? "failed" : null,
    startedAt: "2026-04-01T10:00:00.000Z",
  };
  return execution;
}

describe("resetExecutionContextAssignment", () => {
  it("refuses while the execution is running", () => {
    expect(() =>
      resetExecutionContextAssignment(makeExecution({ status: "running" }), {
        contextId: CONTEXT_ID,
        assignmentId: "alpha",
      }),
    ).toThrow(ResetAssignmentError);
  });

  it("refuses an assignment the context's cohort does not configure", () => {
    expect(() =>
      resetExecutionContextAssignment(makeExecution(), {
        contextId: CONTEXT_ID,
        assignmentId: "gamma",
      }),
    ).toThrow(/gamma/);
  });

  it("refuses an unknown context", () => {
    expect(() =>
      resetExecutionContextAssignment(makeExecution(), {
        contextId: "context-missing",
        assignmentId: "alpha",
      }),
    ).toThrow(ResetAssignmentError);
  });

  it("preserves the assignment's conversation and every sibling lane", () => {
    const execution = makeExecution();
    const result = resetExecutionContextAssignment(execution, {
      contextId: CONTEXT_ID,
      assignmentId: "alpha",
    });

    expect(result.execution.laneStates).toEqual(execution.laneStates);
  });

  it("does not make an unusable conversation replaceable through reset", () => {
    const execution = makeExecution();
    const lane = execution.laneStates[CONTEXT_ID]?.[ALPHA];
    if (!lane) throw new Error("Missing assignment lane");
    lane.staleSession = true;
    const result = resetExecutionContextAssignment(execution, {
      contextId: CONTEXT_ID,
      assignmentId: "alpha",
    });

    expect(result.execution.laneStates[CONTEXT_ID]?.[ALPHA]).toEqual(lane);
  });

  it("returns the roster entry of an open round to pending rather than removing it", () => {
    const result = resetExecutionContextAssignment(makeExecution(), {
      contextId: CONTEXT_ID,
      assignmentId: "alpha",
    });

    const round = result.execution.contextStates[CONTEXT_ID]?.validationRound;
    // Removing the seat could let the round conclude vacuously on beta alone.
    expect(round?.roster.map((seat) => seat.assignmentId)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(round?.specialists["alpha"]).toEqual({
      state: "pending",
      attempts: 0,
      summary: null,
      issues: [],
      advisories: [],
      questionToken: null,
      sessionRef: null,
      reviewArtifact: null,
      lastInfraFailure: null,
    });
    expect(round?.specialists["beta"]?.state).toBe("verdict_pass");
    expect(round?.specialists["beta"]?.attempts).toBe(1);
    expect(round?.phase).toBe("specialists");
    expect(round?.seq).toBe(3);
  });

  it("leaves a concluded round and its conversation alone", () => {
    const execution = makeExecution({ roundPhase: "concluded" });
    const result = resetExecutionContextAssignment(execution, {
      contextId: CONTEXT_ID,
      assignmentId: "alpha",
    });

    const round = result.execution.contextStates[CONTEXT_ID]?.validationRound;
    expect(round?.specialists["alpha"]?.state).toBe("verdict_fail");
    expect(result.execution.laneStates[CONTEXT_ID]?.[ALPHA]).toEqual(
      execution.laneStates[CONTEXT_ID]?.[ALPHA],
    );
  });

  it("clears the reset assignment's parked question and leaves a sibling's parked", () => {
    const execution = makeExecution();
    const contextState = execution.contextStates[CONTEXT_ID]!;
    contextState.status = "awaiting_user_input";
    contextState.pendingUserInputs = {
      [ALPHA]: {
        conversationId: "conv-alpha",
        lane: "context_validator",
        questionBatchId: "batch-alpha",
        questions: [],
        requestedAt: "2026-04-01T10:00:00.000Z",
        roundSeq: 3,
        answers: null,
      },
      [BETA]: {
        conversationId: "conv-beta",
        lane: "context_validator",
        questionBatchId: "batch-beta",
        questions: [],
        requestedAt: "2026-04-01T10:00:00.000Z",
        roundSeq: 3,
        answers: null,
      },
    };

    const result = resetExecutionContextAssignment(execution, {
      contextId: CONTEXT_ID,
      assignmentId: "alpha",
    });

    expect(result.withdrawnQuestion).toEqual({
      conversationId: "conv-alpha",
      questionBatchId: "batch-alpha",
    });
    const next = result.execution.contextStates[CONTEXT_ID]!;
    expect(next.pendingUserInputs[ALPHA]).toBeUndefined();
    expect(next.pendingUserInputs[BETA]?.questionBatchId).toBe("batch-beta");
    // A sibling is still waiting on the human, so the park stays open.
    expect(next.status).toBe("awaiting_user_input");
  });

  it("releases the context's park when the reset assignment was the last lane waiting", () => {
    const execution = makeExecution();
    const contextState = execution.contextStates[CONTEXT_ID]!;
    contextState.status = "awaiting_user_input";
    contextState.pendingUserInputs = {
      [ALPHA]: {
        conversationId: "conv-alpha",
        lane: "context_validator",
        questionBatchId: "batch-alpha",
        questions: [],
        requestedAt: "2026-04-01T10:00:00.000Z",
        roundSeq: 3,
        answers: null,
      },
    };

    const result = resetExecutionContextAssignment(execution, {
      contextId: CONTEXT_ID,
      assignmentId: "alpha",
    });

    expect(
      result.execution.contextStates[CONTEXT_ID]?.pendingUserInputs,
    ).toEqual({});
    expect(result.execution.contextStates[CONTEXT_ID]?.status).toBe("ready");
  });

  it("does not mutate the execution it was handed", () => {
    const execution = makeExecution();
    resetExecutionContextAssignment(execution, {
      contextId: CONTEXT_ID,
      assignmentId: "alpha",
    });

    expect(execution.laneStates[CONTEXT_ID]?.[ALPHA]).toBeDefined();
    expect(
      execution.contextStates[CONTEXT_ID]?.validationRound?.specialists["alpha"]
        ?.state,
    ).toBe("verdict_fail");
  });
});
