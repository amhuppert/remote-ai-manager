import { describe, expect, it } from "vitest";
import {
  graphWorkflowExecutionSchema,
  graphWorkflowHaltReasonSchema,
} from "@/lib/workflow-graph/schemas";
import { resolvedWorkflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowHaltReason,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import {
  buildInitialContextState,
  buildInitialContextStates,
  buildInitialTaskState,
  buildInitialTaskStates,
} from "./execution-state";
import {
  classifyContextLifecycle,
  classifyExecutionEditability,
  isResumableHalt,
} from "./lifecycle-classifier";

const workingDefinition = resolvedWorkflowSemanticDefinitionSchema.parse({
  schemaVersion: 1,
  executionContexts: [
    {
      id: "ctx-1",
      title: "Ctx 1",
      acceptanceCriteria: "AC1",
      implementer: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      },
      contextValidator: null,
      scriptValidator: { enabled: false },
      humanApprovalGate: { enabled: false },
      askUserQuestions: { enabled: false },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
    },
  ],
  tasks: [
    {
      id: "t1",
      contextId: "ctx-1",
      order: 1,
      title: "T1",
      instructions: "do it",
      source: "user",
    },
  ],
  edges: [],
});

const CTX = workingDefinition.executionContexts[0];
const T1 = workingDefinition.tasks[0];
if (!CTX || !T1) throw new Error("fixture invariant: ctx-1 / t1 must exist");

const INITIAL_CONTEXT_STATE = buildInitialContextState(
  CTX,
  workingDefinition.tasks,
);
const INITIAL_TASK_STATE = buildInitialTaskState(T1);

interface ExecutionOverrides {
  status?: GraphWorkflowStatus;
  activeContextIds?: string[];
  contextState?: GraphWorkflowExecutionContextState;
  taskState?: GraphWorkflowTaskState;
  haltReason?: GraphWorkflowHaltReason | null;
}

function makeExecution(
  overrides: ExecutionOverrides = {},
): GraphWorkflowExecution {
  return graphWorkflowExecutionSchema.parse({
    id: "exec-1",
    seedDefinitionId: "seed-1",
    seedDefinitionRevision: 1,
    liveRevision: 1,
    loopEpoch: 0,
    workingDefinition,
    charter: makeTestCharter(),
    status: overrides.status ?? "running",
    activeContextIds: overrides.activeContextIds ?? [],
    contextStates: {
      "ctx-1":
        overrides.contextState ??
        buildInitialContextStates(workingDefinition)["ctx-1"],
    },
    taskStates: {
      t1:
        overrides.taskState ?? buildInitialTaskStates(workingDefinition)["t1"],
    },
    startedAt: "2026-01-01T00:00:00Z",
    haltReason: overrides.haltReason ?? null,
  });
}

function contextState(
  patch: Partial<GraphWorkflowExecutionContextState>,
): GraphWorkflowExecutionContextState {
  return { ...INITIAL_CONTEXT_STATE, ...patch };
}

function taskState(
  patch: Partial<GraphWorkflowTaskState>,
): GraphWorkflowTaskState {
  return { ...INITIAL_TASK_STATE, ...patch };
}

describe("classifyContextLifecycle", () => {
  const cases: Array<{
    name: string;
    execution: GraphWorkflowExecution;
    expected: "frozen" | "unstarted" | "started";
  }> = [
    {
      name: "a pristine pending context is unstarted",
      execution: makeExecution(),
      expected: "unstarted",
    },
    {
      name: "a completed context is frozen",
      execution: makeExecution({
        contextState: contextState({
          status: "completed",
          completedTaskCount: 1,
          iterationCount: 2,
        }),
        taskState: taskState({ status: "completed" }),
      }),
      expected: "frozen",
    },
    {
      name: "a completed context is frozen even when it is in the active set",
      execution: makeExecution({
        activeContextIds: ["ctx-1"],
        contextState: contextState({ status: "completed" }),
      }),
      expected: "frozen",
    },
    {
      name: "a pristine-state context that is in the active set is started, not unstarted",
      execution: makeExecution({ activeContextIds: ["ctx-1"] }),
      expected: "started",
    },
    {
      name: "a paused-was-running context (ready, iterationCount > 0) is started",
      execution: makeExecution({
        status: "paused",
        contextState: contextState({ status: "ready", iterationCount: 2 }),
      }),
      expected: "started",
    },
    {
      name: "a context with an interrupted task is started",
      execution: makeExecution({
        status: "paused",
        taskState: taskState({ status: "interrupted" }),
      }),
      expected: "started",
    },
    {
      name: "a lane-assigned pending context is started",
      execution: makeExecution({
        contextState: contextState({ laneId: "lane-1" }),
      }),
      expected: "started",
    },
    {
      name: "a batchId-assigned context is started",
      execution: makeExecution({
        contextState: contextState({ batchId: "batch-1" }),
      }),
      expected: "started",
    },
    {
      name: "an awaiting_approval context is started",
      execution: makeExecution({
        contextState: contextState({ status: "awaiting_approval" }),
      }),
      expected: "started",
    },
    {
      name: "a worktree-isolated context that ran is started (isolation flipped)",
      execution: makeExecution({
        contextState: contextState({
          status: "ready",
          isolation: "worktree",
          worktreePath: "/wt/ctx-1",
          iterationCount: 1,
        }),
      }),
      expected: "started",
    },
  ];

  for (const { name, execution, expected } of cases) {
    it(name, () => {
      expect(classifyContextLifecycle(execution, "ctx-1")).toBe(expected);
    });
  }
});

describe("classifyExecutionEditability", () => {
  const cases: Array<{
    name: string;
    execution: GraphWorkflowExecution;
    expected: ReturnType<typeof classifyExecutionEditability>;
  }> = [
    {
      name: "running is editable but not quiescent",
      execution: makeExecution({ status: "running" }),
      expected: { kind: "editable", quiescent: false },
    },
    {
      name: "paused is editable and quiescent",
      execution: makeExecution({ status: "paused" }),
      expected: { kind: "editable", quiescent: true },
    },
    {
      name: "pending is editable and quiescent",
      execution: makeExecution({ status: "pending" }),
      expected: { kind: "editable", quiescent: true },
    },
    {
      name: "completed is not editable (completed)",
      execution: makeExecution({ status: "completed" }),
      expected: { kind: "not-editable", reason: "completed" },
    },
    {
      name: "aborted is not editable (aborted)",
      execution: makeExecution({ status: "aborted" }),
      expected: { kind: "not-editable", reason: "aborted" },
    },
    {
      name: "halted with a resumable reason is editable and quiescent",
      execution: makeExecution({
        status: "halted",
        haltReason: {
          type: "max_iterations",
          contextId: "ctx-1",
          iterationCount: 5,
        },
      }),
      expected: { kind: "editable", quiescent: true },
    },
    {
      name: "halted with a non-resumable reason is not editable",
      execution: makeExecution({
        status: "halted",
        haltReason: { type: "recovery_error", message: "boom" },
      }),
      expected: { kind: "not-editable", reason: "halt-not-resumable" },
    },
    {
      name: "halted with an aborted reason is not editable",
      execution: makeExecution({
        status: "halted",
        haltReason: { type: "aborted" },
      }),
      expected: { kind: "not-editable", reason: "halt-not-resumable" },
    },
    {
      name: "halted with a null reason is not editable (fail-safe)",
      execution: makeExecution({ status: "halted", haltReason: null }),
      expected: { kind: "not-editable", reason: "halt-not-resumable" },
    },
  ];

  for (const { name, execution, expected } of cases) {
    it(name, () => {
      expect(classifyExecutionEditability(execution)).toEqual(expected);
    });
  }
});

describe("isResumableHalt", () => {
  // Typed as an exhaustive Record so a new halt reason type in the schema fails
  // to compile here until this test map classifies it — mirroring the
  // production exhaustiveness guard.
  const HALT_REASONS: Record<
    GraphWorkflowHaltReason["type"],
    GraphWorkflowHaltReason
  > = {
    delivery_gate_failed: {
      type: "delivery_gate_failed",
      unmet: [
        {
          criterionId: "criterion-1",
          criterionHandle: "native-sdd/R18.4",
          outcome: "unmet",
        },
      ],
      instruction: "Re-dispatch the merge.",
    },
    circuit_breaker: {
      type: "circuit_breaker",
      contextId: "ctx-1",
      condition: "retry_exhaustion",
      summary: null,
    },
    max_iterations: {
      type: "max_iterations",
      contextId: "ctx-1",
      iterationCount: 5,
    },
    merge_failure: {
      type: "merge_failure",
      contextId: "ctx-1",
      message: "conflict",
      conflictFiles: [],
    },
    join_failure: {
      type: "join_failure",
      joinId: "join-1",
      joinKind: "context_merge",
      contextId: "ctx-1",
      sourceLaneIds: ["lane-1"],
      targetLaneId: "lane-2",
      message: "join failed",
      conflictFiles: [],
    },
    merge_precondition_failed: {
      type: "merge_precondition_failed",
      contextId: "ctx-1",
      targetBranch: "main",
      dirtyPaths: [],
      totalDirtyCount: 0,
      message: "dirty tree",
    },
    script_validator_missing_command: {
      type: "script_validator_missing_command",
      contextId: "ctx-1",
      message: "no preMergeCommand",
    },
    validator_infra_error: {
      type: "validator_infra_error",
      contextId: "ctx-1",
      engine: "claude",
      infraReason: "exception",
      message: "infra failure",
      summary: null,
    },
    agent_turn_failed: {
      type: "agent_turn_failed",
      contextId: "ctx-1",
      engine: "claude",
      cause: "sdk_error",
      message: "turn failed",
    },
    worktree_creation_dirty: {
      type: "worktree_creation_dirty",
      contextId: "ctx-1",
      worktreePath: "/wt/ctx-1",
      branchName: "csm/ctx-1",
      dirtyPaths: [],
      totalDirtyCount: 0,
    },
    execution_loop_failed: {
      type: "execution_loop_failed",
      contextId: "ctx-1",
      message: "loop crashed",
      cause: "unknown",
    },
    collaboration_failure: {
      type: "collaboration_failure",
      status: "rounds_exhausted",
      brief: "design dispute",
      executionContextId: "ctx-1",
      conversationId: "conv-1",
      summary: "unresolved",
    },
    aborted: { type: "aborted" },
    recovery_error: { type: "recovery_error", message: "cannot recover" },
  };

  const NON_RESUMABLE = new Set<GraphWorkflowHaltReason["type"]>([
    "aborted",
    "recovery_error",
  ]);

  for (const [type, reason] of Object.entries(HALT_REASONS)) {
    const expected = !NON_RESUMABLE.has(
      type as GraphWorkflowHaltReason["type"],
    );
    it(`${type} → ${expected ? "resumable" : "not resumable"}`, () => {
      // Parse to prove each fixture is a genuine halt reason, not a hand-shaped
      // approximation.
      expect(isResumableHalt(graphWorkflowHaltReasonSchema.parse(reason))).toBe(
        expected,
      );
    });
  }
});
