import { describe, expect, it } from "vitest";
import {
  buildInitialContextState,
  buildInitialTaskState,
} from "@/lib/workflow-graph/execution-state";
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
import { classifyConfigAffordance } from "./execution-affordance";

/**
 * The §8.1 affordance matrix, one case per row, plus the E2 table's per-state
 * config column — including the row the classifier alone cannot answer: an
 * ABANDONED resumable halt, which E2 files under History with the
 * `halt-not-resumable` reason.
 */

const CONTEXT_ID = "context-impl";
const SCHEMA = { type: "object", properties: { note: { type: "string" } } };

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
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    ...overrides,
  };
}

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
    laneId: "lane-1",
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

/** The same execution with its context pristine, so it reads as `unstarted`. */
function unstarted(
  overrides: Partial<GraphWorkflowExecution> = {},
  resolved: GraphWorkflowResolvedContext = context(),
): GraphWorkflowExecution {
  return execution(
    {
      contextStates: {
        [CONTEXT_ID]: buildInitialContextState(resolved, []),
      },
      ...overrides,
    },
    resolved,
  );
}

describe("classifyConfigAffordance — §8.1 matrix", () => {
  it("editable: an unstarted context on a running execution", () => {
    expect(
      classifyConfigAffordance(unstarted({ status: "running" }), CONTEXT_ID),
    ).toEqual({
      affordance: "editable",
      readOnlyReason: null,
      schemaFrozen: false,
    });
  });

  it("editable: a started context while the execution is paused", () => {
    expect(
      classifyConfigAffordance(execution({ status: "paused" }), CONTEXT_ID),
    ).toEqual({
      affordance: "editable",
      readOnlyReason: null,
      schemaFrozen: false,
    });
  });

  it("editable: a started context on a resumably halted execution holding its lease", () => {
    const halted = execution({
      status: "halted",
      haltReason: {
        type: "circuit_breaker",
        contextId: CONTEXT_ID,
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
    });
    expect(classifyConfigAffordance(halted, CONTEXT_ID).affordance).toBe(
      "editable",
    );
  });

  it("pause-to-edit: a started context while the execution is running", () => {
    expect(
      classifyConfigAffordance(execution({ status: "running" }), CONTEXT_ID),
    ).toEqual({
      affordance: "pause-to-edit",
      readOnlyReason: null,
      schemaFrozen: false,
    });
  });

  it("frozen: a completed context", () => {
    const completed = execution({
      contextStates: {
        [CONTEXT_ID]: { ...startedState(), status: "completed" },
      },
    });
    expect(classifyConfigAffordance(completed, CONTEXT_ID)).toEqual({
      affordance: "frozen",
      readOnlyReason: null,
      schemaFrozen: false,
    });
  });

  it("read-only: a completed execution", () => {
    expect(
      classifyConfigAffordance(execution({ status: "completed" }), CONTEXT_ID),
    ).toEqual({
      affordance: "read-only",
      readOnlyReason: "completed",
      schemaFrozen: false,
    });
  });

  it("read-only: an aborted execution", () => {
    expect(
      classifyConfigAffordance(execution({ status: "aborted" }), CONTEXT_ID)
        .readOnlyReason,
    ).toBe("aborted");
  });

  it("read-only: a non-resumably halted execution", () => {
    const halted = execution({
      status: "halted",
      haltReason: { type: "recovery_error", message: "dead" },
    });
    expect(classifyConfigAffordance(halted, CONTEXT_ID)).toEqual({
      affordance: "read-only",
      readOnlyReason: "halt-not-resumable",
      schemaFrozen: false,
    });
  });

  it("read-only: an execution parked awaiting definition approval", () => {
    const parked = execution({
      status: "pending",
      definitionApproval: {
        requestedAt: "2026-08-20T10:00:00.000Z",
        approvedAt: null,
      },
    });
    expect(classifyConfigAffordance(parked, CONTEXT_ID).readOnlyReason).toBe(
      "awaiting-definition-approval",
    );
  });

  it("read-only: an abandoned resumable halt, which E2 files under History", () => {
    const abandoned = execution({
      status: "halted",
      haltReason: {
        type: "circuit_breaker",
        contextId: CONTEXT_ID,
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
      abandonment: {
        abandonedAt: "2026-08-20T11:00:00.000Z",
        actor: { kind: "human" },
        reason: "moved on",
      },
    });
    expect(classifyConfigAffordance(abandoned, CONTEXT_ID)).toEqual({
      affordance: "read-only",
      readOnlyReason: "halt-not-resumable",
      schemaFrozen: false,
    });
  });

  it("the execution-level verdict outranks a completed context", () => {
    const aborted = execution({
      status: "aborted",
      contextStates: {
        [CONTEXT_ID]: { ...startedState(), status: "completed" },
      },
    });
    expect(classifyConfigAffordance(aborted, CONTEXT_ID)).toEqual({
      affordance: "read-only",
      readOnlyReason: "aborted",
      schemaFrozen: false,
    });
  });

  it("an unknown context id is read-only rather than silently editable", () => {
    expect(classifyConfigAffordance(execution(), "nope").affordance).toBe(
      "read-only",
    );
  });
});

describe("classifyConfigAffordance — the frozen output schema", () => {
  it("freezes the schema once output was captured, even while editable", () => {
    const captured = execution(
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
      context({ outputSchema: SCHEMA }),
    );
    expect(classifyConfigAffordance(captured, CONTEXT_ID)).toEqual({
      affordance: "editable",
      readOnlyReason: null,
      schemaFrozen: true,
    });
  });

  it("leaves the schema editable while the contract is still owed", () => {
    const pending = execution(
      { status: "paused" },
      context({ outputSchema: SCHEMA }),
    );
    expect(classifyConfigAffordance(pending, CONTEXT_ID).schemaFrozen).toBe(
      false,
    );
  });
});
