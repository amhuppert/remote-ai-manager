import { describe, expect, it } from "vitest";
import {
  graphWorkflowAbandonmentSchema,
  graphWorkflowExecutionSchema,
  graphWorkflowHaltReasonSchema,
} from "@/lib/workflow-graph/schemas";
import { resolvedWorkflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowAbandonment,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionOrigin,
  GraphWorkflowHaltReason,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import { graphWorkflowStatusSchema } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowLifecycleDecision } from "@/lib/workflow-graph/schemas";
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
  evaluateLeaseAdmission,
  graphWorkflowLifecycleDecision,
  evaluateGraphWorkflowSessionDelivery,
  holdsActionableGate,
  holdsExecutionLease,
  isResumableHalt,
  isTerminalStatus,
} from "./lifecycle-classifier";
import { makeProfileSnapshot } from "./test-fixtures";

const ABANDONMENT = graphWorkflowAbandonmentSchema.parse({
  abandonedAt: "2026-08-13T00:00:00.000Z",
  actor: { kind: "human" },
  reason: "superseded by a fresh plan",
});

const workingDefinition = resolvedWorkflowSemanticDefinitionSchema.parse({
  schemaVersion: 1,
  executionContexts: [
    {
      id: "ctx-1",
      title: "Ctx 1",
      acceptanceCriteria: "AC1",
      placement: { lane: "ctx-1", mode: "full" },
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        profileSnapshot: makeProfileSnapshot(),
        agent: {
          backend: "claude",
          model: "opus",
          reasoningEffort: "medium",
        },
      },
      contextValidator: { enabled: false, assignments: [] },
      scriptValidator: { commands: [] },
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
  id?: string;
  status?: GraphWorkflowStatus;
  activeContextIds?: string[];
  contextState?: GraphWorkflowExecutionContextState;
  taskState?: GraphWorkflowTaskState;
  haltReason?: GraphWorkflowHaltReason | null;
  abandonment?: GraphWorkflowAbandonment | null;
  origin?: GraphWorkflowExecutionOrigin;
  ownerConversationId?: string | null;
  definitionApproval?: { requestedAt: string; approvedAt: string | null };
}

function makeExecution(
  overrides: ExecutionOverrides = {},
): GraphWorkflowExecution {
  return graphWorkflowExecutionSchema.parse({
    id: overrides.id ?? "exec-1",
    origin: overrides.origin ?? {
      kind: "template",
      definitionId: "seed-1",
      definitionRevision: 1,
      tier: "project",
    },
    ownerConversationId: overrides.ownerConversationId ?? null,
    definitionApproval: overrides.definitionApproval ?? null,
    abandonment: overrides.abandonment ?? null,
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

/**
 * The delivery gate is a LEASE consumer, not a status reader (D7 decision D14).
 * Blocking on status alone blocked every `halted` run, so a non-resumable or
 * abandoned halt — a run that will never continue — permanently refused the
 * merge at both call sites with no act available to clear it.
 */
describe("evaluateGraphWorkflowSessionDelivery", () => {
  const RESUMABLE_HALT = {
    type: "execution_loop_failed",
    contextId: null,
    cause: "unknown",
    message: "halted",
  } as const;
  const NON_RESUMABLE_HALT = {
    type: "recovery_error",
    message: "unrecoverable",
  } as const;

  /**
   * The refusal names the SAME remedy the launch refusal would (D7 decision D6):
   * both are "this run holds the session's lease, here is what clears it", and
   * two independently-worded answers to one question is how a surface ends up
   * telling an operator to complete a run that has halted.
   */
  const leaseHolders = [
    {
      label: "pending",
      status: "pending" as const,
      haltReason: null,
      definitionApproval: null,
      remedy: "inspect_or_pause" as const,
      sentence: "Complete or abort it before merging this session.",
    },
    {
      label: "pending awaiting definition approval",
      status: "pending" as const,
      haltReason: null,
      definitionApproval: {
        definitionId: "definition-1",
        definitionRevision: 1,
        requestedAt: "2026-01-01T00:00:00Z",
        approvedAt: null,
        approvedBy: null,
      },
      remedy: "approve_or_abort" as const,
      sentence: "Approve or abort it before merging this session.",
    },
    {
      label: "running",
      status: "running" as const,
      haltReason: null,
      definitionApproval: null,
      remedy: "inspect_or_pause" as const,
      sentence: "Complete or abort it before merging this session.",
    },
    {
      label: "paused",
      status: "paused" as const,
      haltReason: null,
      definitionApproval: null,
      remedy: "inspect_or_pause" as const,
      sentence: "Complete or abort it before merging this session.",
    },
    {
      // The correction R13.1 forces: a halted run can never be "completed", and
      // abandoning it is exactly what admits the merge — so naming
      // complete-or-abort here pointed at acts its state does not admit.
      label: "resumably halted",
      status: "halted" as const,
      haltReason: RESUMABLE_HALT,
      definitionApproval: null,
      remedy: "resume_or_abandon" as const,
      sentence: "Resume or abandon it before merging this session.",
    },
  ];

  for (const holder of leaseHolders) {
    it(`blocks delivery while a ${holder.label} execution holds the lease, naming the ${holder.remedy} remedy`, () => {
      expect(
        evaluateGraphWorkflowSessionDelivery({
          id: "execution-1",
          status: holder.status,
          haltReason: holder.haltReason,
          abandonment: null,
          definitionApproval: holder.definitionApproval,
        }),
      ).toEqual({
        allowed: false,
        executionId: "execution-1",
        status: holder.status,
        remedy: holder.remedy,
        message: `Graph workflow execution execution-1 is ${holder.status}. ${holder.sentence}`,
      });
    });
  }

  const leaseFree = [
    {
      label: "completed",
      status: "completed" as const,
      haltReason: null,
      abandonment: null,
    },
    {
      label: "aborted",
      status: "aborted" as const,
      haltReason: null,
      abandonment: null,
    },
    {
      label: "non-resumably halted",
      status: "halted" as const,
      haltReason: NON_RESUMABLE_HALT,
      abandonment: null,
    },
    {
      label: "abandoned resumable halt",
      status: "halted" as const,
      haltReason: RESUMABLE_HALT,
      abandonment: {
        abandonedAt: "2026-01-02T00:00:00Z",
        actor: { kind: "human" as const },
        reason: "superseded",
      },
    },
    {
      // Schema-valid and therefore reachable: `haltReason` is nullable. Not a
      // resumable reason, so it never blocks a merge — the R13 defect this rule
      // exists to prevent is a halt holding delivery hostage forever.
      label: "halted with no recorded reason",
      status: "halted" as const,
      haltReason: null,
      abandonment: null,
    },
  ];

  for (const free of leaseFree) {
    it(`allows delivery once a ${free.label} execution has released the lease`, () => {
      expect(
        evaluateGraphWorkflowSessionDelivery({
          id: "execution-1",
          status: free.status,
          haltReason: free.haltReason,
          abandonment: free.abandonment,
          definitionApproval: null,
        }),
      ).toEqual({ allowed: true });
    });
  }

  it("allows session delivery when no graph execution exists", () => {
    expect(evaluateGraphWorkflowSessionDelivery(null)).toEqual({
      allowed: true,
    });
  });
});

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
      name: "a pending context with cleared reservation state is unstarted",
      execution: makeExecution({
        contextState: contextState({
          reservedByBatchId: null,
          reservedOwnership: null,
        }),
      }),
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
      name: "a context with a scheduling reservation is started",
      execution: makeExecution({
        contextState: contextState({ reservedByBatchId: "batch-1" }),
      }),
      expected: "started",
    },
    {
      name: "a context with reserved ownership is started",
      execution: makeExecution({
        contextState: contextState({
          reservedOwnership: { mode: "full", canonicalPrefixes: [] },
        }),
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
      // D7 decision D17: an execution-addressed approval is only sound if its
      // subject is immutable, so a parked snapshot is frozen rather than
      // "quiescent, therefore fully editable" — otherwise an id-only approval
      // could admit bytes nobody reviewed.
      name: "pending awaiting definition approval is not editable",
      execution: makeExecution({
        status: "pending",
        definitionApproval: {
          requestedAt: "2026-08-13T09:00:00.000Z",
          approvedAt: null,
        },
      }),
      expected: {
        kind: "not-editable",
        reason: "awaiting-definition-approval",
      },
    },
    {
      name: "pending with an already-approved definition is editable and quiescent",
      execution: makeExecution({
        status: "pending",
        definitionApproval: {
          requestedAt: "2026-08-13T09:00:00.000Z",
          approvedAt: "2026-08-13T09:05:00.000Z",
        },
      }),
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
          summary: null,
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
        haltReason: { type: "aborted", cause: null, summary: null },
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

describe("halt resumability and the lease it decides", () => {
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
      summary: null,
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
      message: "stored script-validator configuration was incomplete",
    },
    script_validator_unknown_command: {
      type: "script_validator_unknown_command",
      contextId: "ctx-1",
      commandName: "missing",
      message: "unknown validation command",
    },
    validation_candidate_unavailable: {
      type: "validation_candidate_unavailable",
      contextId: "ctx-1",
      attempts: 2,
      message: "could not read the candidate tree",
    },
    // A blocking seat refused the CONTRACT. Resumable by construction: the
    // remedy is a plan repair (or an operator's own edit) of the contract the
    // defect names, followed by resume — the reviewed work is untouched and
    // every seat's verdict is still on the open round.
    plan_defect: {
      type: "plan_defect",
      contextId: "ctx-1",
      roundSeq: 4,
      planDefects: [
        {
          assignmentId: "general",
          title: "The criterion names work this context does not own",
          description:
            "Criterion 2 requires the downstream publisher to change, and nothing here may touch it.",
          whyNotLocallyRemediable:
            "Every task in this context is scoped to the reader; the publisher belongs to a later context.",
          conflictingContract: "Acceptance criterion 2",
        },
      ],
      summary: null,
    },
    validator_infra_error: {
      type: "validator_infra_error",
      contextId: "ctx-1",
      engine: "claude",
      infraReason: "exception",
      message: "infra failure",
      summary: null,
      // The cohort's additive fields: one specialist exhausted its attempts in
      // a specific round. Classification must be unchanged by them — the halt is
      // resumable precisely so resuming can reset those counters and rerun it.
      assignmentId: "security-reviewer",
      attempts: 3,
      roundSeq: 2,
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
    aborted: { type: "aborted", cause: null, summary: null },
    recovery_error: { type: "recovery_error", message: "cannot recover" },
    routing_cardinality: {
      type: "routing_cardinality",
      contextId: "ctx-classify",
      policy: "exactlyOne",
      outcome: "over-selection",
      conditionalEdgeIds: ["e1", "e2"],
      activatedEdgeIds: ["e1", "e2"],
      message: "two branches activated under exactlyOne",
    },
    routing_invariant: {
      type: "routing_invariant",
      contextId: "ctx-fix",
      reason: "guard-unevaluable",
      edgeIds: ["e1"],
      sourceContextIds: ["ctx-classify"],
      message: "the completed source's output cannot be read",
    },
    loop_exit_skipped: {
      type: "loop_exit_skipped",
      loopGroupId: "refine",
      pass: 2,
      contextId: "refine__p2__judge",
      message: "the active loop's exit instance resolved skipped",
    },
    loop_invariant: {
      type: "loop_invariant",
      loopGroupId: "refine",
      pass: 2,
      contextId: "refine__p2__judge",
      reason: "exit-output-unevaluable",
      message: "the exit landed but banked no readable output",
    },
    loop_limit_reached: {
      type: "loop_limit_reached",
      scope: "loop",
      loopGroupId: "refine",
      pass: 3,
      maxPasses: 3,
      verdict: "unsatisfied",
      passCount: 3,
      totalPassCount: 3,
      contextId: "refine__p3__judge",
      message: "the final allowed pass did not satisfy the until predicate",
      summary: null,
    },
    ownership_violation: {
      type: "ownership_violation",
      laneId: "lane-api",
      contextId: "ctx-1",
      unattributedPaths: ["scripts/deploy.sh"],
      message: 'Lane "lane-api" has 1 change no member owns',
    },
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

    it(`a halt on ${type} ${expected ? "keeps" : "releases"} the lease`, () => {
      expect(
        holdsExecutionLease(
          "halted",
          graphWorkflowHaltReasonSchema.parse(reason),
          null,
        ),
      ).toBe(expected);
    });

    it(`an abandoned halt on ${type} releases the lease`, () => {
      expect(
        holdsExecutionLease(
          "halted",
          graphWorkflowHaltReasonSchema.parse(reason),
          ABANDONMENT,
        ),
      ).toBe(false);
    });
  }
});

/**
 * THE canonical lease predicate (D7 decision D14). Every admission, resume,
 * Current/History projection, ambient signal, validation owner, delivery gate,
 * and the `lease_held` persistence projection consume this one decision, so the
 * status/halt/abandonment matrix is pinned here rather than restated per site.
 */
describe("holdsExecutionLease", () => {
  const RESUMABLE = graphWorkflowHaltReasonSchema.parse({
    type: "agent_turn_failed",
    contextId: "ctx-1",
    engine: "claude",
    cause: "sdk_error",
    message: "turn failed",
  });
  const NON_RESUMABLE = graphWorkflowHaltReasonSchema.parse({
    type: "recovery_error",
    message: "unrecoverable",
  });

  for (const status of ["pending", "running", "paused"] as const) {
    it(`${status} holds the lease`, () => {
      expect(holdsExecutionLease(status, null, null)).toBe(true);
    });
  }

  for (const status of ["completed", "aborted"] as const) {
    it(`${status} never holds the lease, even carrying a resumable halt reason`, () => {
      expect(holdsExecutionLease(status, RESUMABLE, null)).toBe(false);
    });
  }

  it("keeps the lease for a resumably halted run that was never abandoned", () => {
    expect(holdsExecutionLease("halted", RESUMABLE, null)).toBe(true);
  });

  it("releases the lease once an abandonment record exists", () => {
    expect(holdsExecutionLease("halted", RESUMABLE, ABANDONMENT)).toBe(false);
  });

  it("releases the lease for a non-resumable halt with no abandonment act", () => {
    expect(holdsExecutionLease("halted", NON_RESUMABLE, null)).toBe(false);
  });

  it("releases the lease for a halted run whose reason was not recorded", () => {
    // The pinned spec's rule is `halted holds IFF isResumableHalt(haltReason)`
    // (revision 5, D14 — and R3: "halted with a resumable reason"). A null
    // reason is not a resumable reason, so such a run is lease-free and belongs
    // in History.
    //
    // This deliberately overrides the fail-closed instinct — that an unproven
    // halt should keep the lease because a wrongly-held one is recoverable by
    // abandoning it. The spec outranks that reasoning, and it is also the
    // consistent answer: `classifyExecutionEditability` and
    // `workflowExecutionAmendmentRefusalInstruction` both already require a
    // NON-NULL resumable reason, so treating null as lease-holding left a run
    // that is Current and blocking yet not editable, resumable, or amendable —
    // reachable only by abandoning a run the UI offers no abandon control for.
    expect(holdsExecutionLease("halted", null, null)).toBe(false);
  });

  it("classifies every status in the vocabulary", () => {
    for (const status of graphWorkflowStatusSchema.options) {
      expect(typeof holdsExecutionLease(status, null, null)).toBe("boolean");
    }
  });

  describe("holdsActionableGate", () => {
    it("excludes pending, which holds the lease but has not started", () => {
      // A pending run is waiting on its OWN definition approval, so no context
      // of it is running and a park on one is not yet a fact. This is the one
      // place the gate question and the lease question part company.
      expect(holdsExecutionLease("pending", null, null)).toBe(true);
      expect(holdsActionableGate("pending", null, null)).toBe(false);
    });

    for (const status of ["running", "paused"] as const) {
      it(`${status} can act on a parked gate`, () => {
        expect(holdsActionableGate(status, null, null)).toBe(true);
      });
    }

    it("keeps a resumably halted gate actionable — the decision defers", () => {
      expect(holdsActionableGate("halted", RESUMABLE, null)).toBe(true);
    });

    it.each([
      ["a non-resumable halt", NON_RESUMABLE, null],
      ["an abandoned halt", RESUMABLE, ABANDONMENT],
      ["a halt with no recorded reason", null, null],
    ] as const)("drops the gate for %s", (_label, reason, abandonment) => {
      expect(holdsActionableGate("halted", reason, abandonment)).toBe(false);
    });

    for (const status of ["completed", "aborted"] as const) {
      it(`${status} can never act on a gate`, () => {
        expect(holdsActionableGate(status, RESUMABLE, null)).toBe(false);
      });
    }

    it("classifies every status in the vocabulary", () => {
      for (const status of graphWorkflowStatusSchema.options) {
        expect(typeof holdsActionableGate(status, null, null)).toBe("boolean");
      }
    });
  });
});

/**
 * THE one admission decision (D7 decision D3). Both start-guard call sites —
 * the manager's advisory check and the repository's authoritative CAS — consult
 * this, so a launch can only ever admit (lease free), normalize a lease-free
 * physical incumbent into History, or refuse naming the lease holder. There is
 * no branch in which an incumbent is ended as a side effect (R3.4).
 */
describe("evaluateLeaseAdmission", () => {
  const RESUMABLE = graphWorkflowHaltReasonSchema.parse({
    type: "agent_turn_failed",
    contextId: "ctx-1",
    engine: "claude",
    cause: "sdk_error",
    message: "turn failed",
  });
  const NON_RESUMABLE = graphWorkflowHaltReasonSchema.parse({
    type: "recovery_error",
    message: "unrecoverable",
  });

  it("admits when the session holds no execution at all", () => {
    expect(evaluateLeaseAdmission(null)).toEqual({ kind: "admit" });
  });

  const LEASE_HOLDERS: Array<{
    label: string;
    overrides: ExecutionOverrides;
    remedy: string;
  }> = [
    {
      label: "a pending run parked awaiting definition approval",
      overrides: {
        status: "pending",
        definitionApproval: {
          requestedAt: "2026-08-13T00:00:00.000Z",
          approvedAt: null,
        },
      },
      remedy: "approve_or_abort",
    },
    {
      label: "a pending run with no approval park",
      overrides: { status: "pending" },
      remedy: "inspect_or_pause",
    },
    {
      label: "a running run",
      overrides: { status: "running" },
      remedy: "inspect_or_pause",
    },
    {
      label: "a paused run",
      overrides: { status: "paused" },
      remedy: "inspect_or_pause",
    },
    {
      label: "a resumably halted run",
      overrides: { status: "halted", haltReason: RESUMABLE },
      remedy: "resume_or_abandon",
    },
  ];

  for (const holder of LEASE_HOLDERS) {
    it(`refuses over ${holder.label}, naming it and its remedy`, () => {
      const incumbent = makeExecution({
        id: "incumbent-1",
        ownerConversationId: "conv-origin",
        ...holder.overrides,
      });

      expect(evaluateLeaseAdmission(incumbent)).toEqual({
        kind: "refuse",
        incumbent: {
          executionId: "incumbent-1",
          status: holder.overrides.status,
          origin: incumbent.origin,
          originConversationId: "conv-origin",
        },
        remedy: holder.remedy,
      });
    });
  }

  it("carries a one-off incumbent's origin and its absent origin conversation", () => {
    const incumbent = makeExecution({
      id: "incumbent-one-off",
      status: "running",
      origin: { kind: "one_off", planName: "Ship the search box" },
      ownerConversationId: null,
    });

    expect(evaluateLeaseAdmission(incumbent)).toMatchObject({
      kind: "refuse",
      incumbent: {
        origin: { kind: "one_off", planName: "Ship the search box" },
        originConversationId: null,
      },
    });
  });

  const LEASE_FREE: Array<{ label: string; overrides: ExecutionOverrides }> = [
    { label: "a completed run", overrides: { status: "completed" } },
    { label: "an aborted run", overrides: { status: "aborted" } },
    {
      label: "a non-resumably halted run",
      overrides: { status: "halted", haltReason: NON_RESUMABLE },
    },
    {
      label: "an abandoned resumable halt",
      overrides: {
        status: "halted",
        haltReason: RESUMABLE,
        abandonment: ABANDONMENT,
      },
    },
    {
      // `isResumableHalt` is a claim about a REASON; with none recorded there is
      // nothing to resume from, so the run is lease-free and normalizes into
      // History rather than refusing the launch.
      label: "a halted run whose reason was never recorded",
      overrides: { status: "halted", haltReason: null },
    },
  ];

  for (const freeCase of LEASE_FREE) {
    it(`admits over ${freeCase.label}, normalizing it into History`, () => {
      const incumbent = makeExecution({
        id: "legacy-terminal",
        ownerConversationId: "conv-origin",
        ...freeCase.overrides,
      });

      expect(evaluateLeaseAdmission(incumbent)).toEqual({
        kind: "admit-with-normalization",
        incumbent: {
          executionId: "legacy-terminal",
          status: freeCase.overrides.status,
          origin: incumbent.origin,
          originConversationId: "conv-origin",
        },
      });
    });
  }

  it("agrees with the lease predicate for every status the vocabulary has", () => {
    for (const status of graphWorkflowStatusSchema.options) {
      const incumbent = makeExecution({ status });
      const decision = evaluateLeaseAdmission(incumbent);
      expect(decision.kind === "refuse").toBe(
        holdsExecutionLease(status, incumbent.haltReason, null),
      );
    }
  });
});

describe("graph-workflow lifecycle contract", () => {
  // The full decision table (design §10), as D7 leaves it: terminality is the
  // one status-only fact and stays here. Slot ownership, replacement, and
  // archive eligibility were status-only APPROXIMATIONS of tenure and are gone,
  // because `holdsExecutionLease` decides tenure from the whole record.
  const TABLE: Record<GraphWorkflowStatus, GraphWorkflowLifecycleDecision> = {
    pending: {
      status: "pending",
      terminal: false,
    },
    running: {
      status: "running",
      terminal: false,
    },
    paused: {
      status: "paused",
      terminal: false,
    },
    halted: {
      status: "halted",
      terminal: true,
    },
    completed: {
      status: "completed",
      terminal: true,
    },
    aborted: {
      status: "aborted",
      terminal: true,
    },
  };

  it("covers every status in graphWorkflowStatusSchema", () => {
    expect(Object.keys(TABLE).sort()).toEqual(
      [...graphWorkflowStatusSchema.options].sort(),
    );
  });

  for (const status of graphWorkflowStatusSchema.options) {
    const expected = TABLE[status];

    it(`${status} → ${JSON.stringify(expected)}`, () => {
      expect(graphWorkflowLifecycleDecision(status)).toEqual(expected);
    });

    it(`${status} predicates agree with the decision row`, () => {
      expect(isTerminalStatus(status)).toBe(expected.terminal);
    });
  }

  it("keeps no status-only tenure column at all", () => {
    // The columns D7 retires: slot ownership, replacement, and — once CLEAR and
    // `workflow live release` were deleted — archive eligibility. A row that
    // still carries any of them is a status set masquerading as the lease,
    // which is the defect the predicate replaces.
    for (const status of graphWorkflowStatusSchema.options) {
      expect(
        Object.keys(graphWorkflowLifecycleDecision(status)).sort(),
      ).toEqual(["status", "terminal"]);
    }
  });
});
