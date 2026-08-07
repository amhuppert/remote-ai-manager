import { describe, expect, it } from "vitest";
import {
  createWorkflowExecution,
  makeSeededValidatorAssignment,
} from "../test-fixtures";
import { executionFor, workerJudgeDefinition } from "../loop-test-fixtures";
import type { GraphWorkflowExecution, PlanRepairRound } from "../schemas";
import type { SeededValidatorAssignment } from "../config-schemas";
import type { MutateActiveResult } from "../execution-repository";
import type { LiveEditApplyOutcome } from "../live-edit-apply";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { PublishPlanRepairInput } from "../execution-events";
import {
  createPlanRepairSupervisor,
  type PlanRepairAgentResult,
  type PlanRepairSupervisorDeps,
} from "./supervisor";

function haltedExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "halted",
    haltReason: {
      type: "circuit_breaker",
      contextId: "context-implement",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    },
    ...overrides,
  });
}

/**
 * A halted loop execution: the worker+judge body the D4 loop suites share,
 * seeded through the real resolver so the group carries the seed-resolved
 * `planRepair` policy the trigger reads (decision D10).
 */
function loopHaltedExecution(
  planRepairRounds: PlanRepairRound[] = [],
): GraphWorkflowExecution {
  return {
    ...executionFor(workerJudgeDefinition()),
    status: "halted",
    planRepairRounds,
    haltReason: {
      type: "loop_limit_reached",
      scope: "loop",
      loopGroupId: "refine",
      pass: 3,
      maxPasses: 3,
      verdict: "unsatisfied",
      passCount: 3,
      totalPassCount: 3,
      contextId: "refine__p3__judge",
      message: 'loop "refine" reached its 3-pass budget',
      summary: null,
    },
  };
}

interface HarnessOptions {
  initial: GraphWorkflowExecution | null;
  agentResults?: PlanRepairAgentResult[];
  applyOutcomes?: LiveEditApplyOutcome[];
  resumeError?: Error;
  /**
   * An edit that lands while the repair agent's turn is open — the window a
   * live operator actually has, since the turn is minutes long.
   */
  duringAgentTurn?: (current: GraphWorkflowExecution) => GraphWorkflowExecution;
}

function makeHarness(options: HarnessOptions) {
  let execution = options.initial;
  const agentResults = [...(options.agentResults ?? [])];
  const applyOutcomes = [...(options.applyOutcomes ?? [])];
  const applyRequests: {
    baseLiveRevision: number;
    source: string;
    operationCount: number;
  }[] = [];
  const appliedOperations: WorkflowLiveEditOperation[][] = [];
  const published: PublishPlanRepairInput[] = [];
  const agentCalls: { prompt: string; roundsAtCall: number }[] = [];
  let resumeCalls = 0;
  let pendingAgent: ((result: PlanRepairAgentResult) => void) | null = null;

  const deps: PlanRepairSupervisorDeps = {
    getActiveExecution: () => Promise.resolve(execution),
    mutateActive: (_p, _s, fn) => {
      if (!execution) {
        return Promise.reject(
          new Error("Session does not have an active graph workflow execution"),
        );
      }
      const result = fn(execution) as
        | MutateActiveResult
        | GraphWorkflowExecution;
      execution = "execution" in result ? result.execution : result;
      return Promise.resolve(execution);
    },
    applyLiveEdits: (input) => {
      applyRequests.push({
        baseLiveRevision: input.request.baseLiveRevision,
        source: input.request.source,
        operationCount: input.request.operations.length,
      });
      appliedOperations.push([...input.request.operations]);
      const next = applyOutcomes.shift();
      if (!next) throw new Error("no scripted apply outcome left");
      if (next.ok && !next.dryRun && execution) {
        execution = {
          ...execution,
          liveRevision: next.liveRevision,
        };
      }
      return Promise.resolve(next);
    },
    runRepairAgent: (invocation) => {
      agentCalls.push({
        prompt: invocation.prompt,
        roundsAtCall: execution?.planRepairRounds.length ?? -1,
      });
      if (options.duringAgentTurn && execution) {
        execution = options.duringAgentTurn(execution);
      }
      const scripted = agentResults.shift();
      if (scripted) return Promise.resolve(scripted);
      return new Promise((resolve) => {
        pendingAgent = resolve;
      });
    },
    resumeExecution: () => {
      resumeCalls += 1;
      if (options.resumeError) return Promise.reject(options.resumeError);
      if (execution) execution = { ...execution, status: "running" };
      return Promise.resolve();
    },
    getValidationHistory: () =>
      Promise.resolve([
        {
          pass: false,
          summary: "AC requires calling /v2/users which was removed",
          issues: [],
        },
      ]),
    getSessionWorktreePath: () => Promise.resolve("/wt/session"),
    publishPlanRepairRound: (input) => {
      published.push(input);
      return { events: [], pushes: [] };
    },
    now: () => "2026-07-29T01:00:00.000Z",
  };

  return {
    deps,
    current: () => execution,
    applyRequests,
    appliedOperations,
    published,
    agentCalls,
    resumeCalls: () => resumeCalls,
    settlePendingAgent: (result: PlanRepairAgentResult) => {
      if (!pendingAgent) throw new Error("no pending agent call");
      pendingAgent(result);
      pendingAgent = null;
    },
  };
}

const RUN_INPUT = {
  projectPath: "/p",
  sessionName: "s",
  projectName: "proj",
};

const REPAIR_OPS = [
  {
    type: "update-context",
    contextId: "context-implement",
    acceptanceCriteria: "Achievable criteria",
  },
];

function appliedOutcome(liveRevision: number): LiveEditApplyOutcome {
  return {
    ok: true,
    applied: 1,
    liveRevision,
    affectedContextIds: ["context-implement"],
    dryRun: false,
    execution: null,
  };
}

describe("plan-repair supervisor", () => {
  it("runs the full repair loop: append round → agent → apply (plan-repair source) → resume → settle", async () => {
    const harness = makeHarness({
      initial: haltedExecution(),
      agentResults: [
        {
          kind: "verdict",
          verdict: {
            planningDefect: true,
            diagnosis: "AC references a removed endpoint",
            operations: REPAIR_OPS,
          },
          conversationId: "conv-repair-1",
        },
      ],
      applyOutcomes: [appliedOutcome(2)],
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "repaired" });
    // Round appended BEFORE the agent ran (crash-safe accounting).
    expect(harness.agentCalls[0]?.roundsAtCall).toBe(1);
    // Apply rode the shared core with the server-derived source.
    expect(harness.applyRequests).toEqual([
      { baseLiveRevision: 1, source: "plan-repair", operationCount: 1 },
    ]);
    expect(harness.resumeCalls()).toBe(1);
    const round = harness.current()?.planRepairRounds.at(-1);
    expect(round).toMatchObject({
      seq: 1,
      contextId: "context-implement",
      haltType: "circuit_breaker",
      outcome: "repaired",
      planningDefect: true,
      diagnosis: "AC references a removed endpoint",
      operationCount: 1,
      resumed: true,
      conversationId: "conv-repair-1",
    });
    expect(round?.settledAt).not.toBeNull();
    expect(harness.published).toEqual([
      expect.objectContaining({
        outcome: "repaired",
        attempt: 1,
        resumed: true,
        operationCount: 1,
      }),
    ]);
  });

  it("declines a non-planning-defect verdict: summary populated, no apply, no resume", async () => {
    const harness = makeHarness({
      initial: haltedExecution(),
      agentResults: [
        {
          kind: "verdict",
          verdict: {
            planningDefect: false,
            diagnosis: "Implementation keeps failing the same real test",
            operations: [],
          },
          conversationId: "conv-repair-1",
        },
      ],
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "declined" });
    expect(harness.applyRequests).toHaveLength(0);
    expect(harness.resumeCalls()).toBe(0);
    const current = harness.current();
    expect(current?.status).toBe("halted");
    expect(
      current?.haltReason?.type === "circuit_breaker"
        ? current.haltReason.summary
        : null,
    ).toContain("Implementation keeps failing");
    expect(harness.current()?.planRepairRounds.at(-1)).toMatchObject({
      outcome: "declined",
      planningDefect: false,
      resumed: false,
    });
    expect(harness.published).toEqual([
      expect.objectContaining({ outcome: "declined", planningDefect: false }),
    ]);
  });

  it("fails closed when the verdict contains a forbidden operation", async () => {
    const harness = makeHarness({
      initial: haltedExecution(),
      agentResults: [
        {
          kind: "verdict",
          verdict: {
            planningDefect: true,
            diagnosis: "Needs a whole new context",
            operations: [
              {
                type: "add-context",
                id: "sneaky",
                title: "New context",
                acceptanceCriteria: "x",
              },
            ],
          },
          conversationId: "conv-repair-1",
        },
      ],
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "failed" });
    expect(harness.applyRequests).toHaveLength(0);
    expect(harness.resumeCalls()).toBe(0);
    expect(harness.current()?.planRepairRounds.at(-1)).toMatchObject({
      outcome: "failed",
    });
    expect(harness.published).toEqual([
      expect.objectContaining({ outcome: "failed" }),
    ]);
  });

  it("records a failed round when the agent turn errors", async () => {
    const harness = makeHarness({
      initial: haltedExecution(),
      agentResults: [
        {
          kind: "error",
          message: "timed out after 900000ms",
          conversationId: "conv-repair-1",
        },
      ],
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "failed" });
    expect(harness.current()?.planRepairRounds.at(-1)).toMatchObject({
      outcome: "failed",
      resumed: false,
    });
    expect(harness.resumeCalls()).toBe(0);
  });

  it("retries exactly once on a revision conflict with the re-read revision", async () => {
    const conflicted = haltedExecution();
    const harness = makeHarness({
      initial: conflicted,
      agentResults: [
        {
          kind: "verdict",
          verdict: {
            planningDefect: true,
            diagnosis: "AC fix",
            operations: REPAIR_OPS,
          },
          conversationId: "conv-repair-1",
        },
      ],
      applyOutcomes: [
        {
          ok: false,
          kind: "rejected",
          failure: {
            status: 409,
            code: "revision_conflict",
            error: "stale",
            currentLiveRevision: 4,
          },
        },
        appliedOutcome(5),
      ],
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "repaired" });
    expect(harness.applyRequests).toHaveLength(2);
    expect(harness.resumeCalls()).toBe(1);
  });

  it("withdraws as superseded when the apply is rejected because the user already acted", async () => {
    const harness = makeHarness({
      initial: haltedExecution(),
      agentResults: [
        {
          kind: "verdict",
          verdict: {
            planningDefect: true,
            diagnosis: "AC fix",
            operations: REPAIR_OPS,
          },
          conversationId: "conv-repair-1",
        },
      ],
      applyOutcomes: [
        {
          ok: false,
          kind: "rejected",
          failure: {
            status: 409,
            code: "not_editable",
            error: "execution is not editable (running)",
          },
        },
      ],
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "superseded" });
    expect(harness.resumeCalls()).toBe(0);
    expect(harness.current()?.planRepairRounds.at(-1)).toMatchObject({
      outcome: "superseded",
    });
    // Audit-only conclusion — the event records it; the publisher owns push
    // suppression for superseded rounds.
    expect(harness.published).toEqual([
      expect.objectContaining({ outcome: "superseded" }),
    ]);
  });

  it("populates the halt summary and notifies when attempts are exhausted, without running the agent", async () => {
    const harness = makeHarness({
      initial: haltedExecution({
        planRepairRounds: [
          {
            seq: 1,
            contextId: "context-implement",
            haltType: "circuit_breaker",
            loopGroupId: null,
            startedAt: "2026-07-29T00:00:00.000Z",
            settledAt: "2026-07-29T00:05:00.000Z",
            outcome: "repaired",
            planningDefect: true,
            diagnosis: "first",
            operationCount: 1,
            resumed: true,
            conversationId: "c1",
          },
          {
            seq: 2,
            contextId: "context-implement",
            haltType: "circuit_breaker",
            loopGroupId: null,
            startedAt: "2026-07-29T00:10:00.000Z",
            settledAt: null,
            outcome: null,
            planningDefect: null,
            diagnosis: null,
            operationCount: 0,
            resumed: false,
            conversationId: null,
          },
        ],
      }),
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toEqual({
      ran: false,
      reason: "context_attempts_exhausted",
    });
    expect(harness.agentCalls).toHaveLength(0);
    const current = harness.current();
    expect(
      current?.haltReason?.type === "circuit_breaker"
        ? current.haltReason.summary
        : null,
    ).toContain("exhausted");
    expect(harness.published).toEqual([
      expect.objectContaining({ outcome: "exhausted", attempt: 2 }),
    ]);
  });

  it("fires on a loop_limit_reached halt, accounting the round on the loop (R12.1)", async () => {
    const harness = makeHarness({
      initial: loopHaltedExecution(),
      agentResults: [
        {
          kind: "verdict",
          verdict: {
            planningDefect: true,
            diagnosis: "the exit bar demanded a field the judge cannot produce",
            operations: [
              {
                type: "amend-loop-predicate",
                loopGroupId: "refine",
                until: {
                  schema: {
                    type: "object",
                    properties: { notes: { type: "string" } },
                    required: ["notes"],
                  },
                },
                rationale: "recorded notes are the real exit condition",
              },
            ],
          },
          conversationId: "conv-loop-1",
        },
      ],
      applyOutcomes: [appliedOutcome(2)],
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "repaired" });
    // The loop-control op reached the shared live-edit core; the supervisor
    // never applies anything itself.
    expect(harness.applyRequests).toEqual([
      { baseLiveRevision: 1, source: "plan-repair", operationCount: 1 },
    ]);
    expect(harness.resumeCalls()).toBe(1);
    // The round is keyed on the LOOP, so the next pass instance does not get a
    // fresh budget of repairs (decision D10).
    expect(harness.current()?.planRepairRounds.at(-1)).toMatchObject({
      haltType: "loop_limit_reached",
      loopGroupId: "refine",
      contextId: "refine__p3__judge",
      outcome: "repaired",
      resumed: true,
    });
    expect(harness.published).toEqual([
      expect.objectContaining({
        haltType: "loop_limit_reached",
        loopGroupId: "refine",
        outcome: "repaired",
      }),
    ]);
  });

  it("refuses a loop-control op aimed at another loop, and records the refusal on the loop halt", async () => {
    const harness = makeHarness({
      initial: loopHaltedExecution(),
      agentResults: [
        {
          kind: "verdict",
          verdict: {
            planningDefect: true,
            diagnosis: "raise the other loop instead",
            operations: [
              {
                type: "raise-loop-max-passes",
                loopGroupId: "some-other-loop",
                maxPasses: 9,
              },
            ],
          },
          conversationId: "conv-loop-1",
        },
      ],
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "failed" });
    // Nothing reached the live-edit core.
    expect(harness.applyRequests).toHaveLength(0);
    expect(harness.resumeCalls()).toBe(0);
    const halt = harness.current()?.haltReason;
    expect(halt?.type === "loop_limit_reached" ? halt.summary : null).toContain(
      "disallowed operations",
    );
  });

  it("announces exhaustion on a loop halt once the loop's own attempts are spent", async () => {
    const harness = makeHarness({
      initial: loopHaltedExecution([
        {
          seq: 1,
          contextId: "refine__p1__judge",
          haltType: "loop_limit_reached",
          loopGroupId: "refine",
          startedAt: "2026-07-29T00:00:00.000Z",
          settledAt: "2026-07-29T00:05:00.000Z",
          outcome: "repaired",
          planningDefect: true,
          diagnosis: "raised the cap",
          operationCount: 1,
          resumed: true,
          conversationId: "c1",
        },
        {
          seq: 2,
          contextId: "refine__p2__judge",
          haltType: "loop_limit_reached",
          loopGroupId: "refine",
          startedAt: "2026-07-29T00:10:00.000Z",
          settledAt: "2026-07-29T00:15:00.000Z",
          outcome: "declined",
          planningDefect: false,
          diagnosis: "not converging",
          operationCount: 0,
          resumed: false,
          conversationId: "c2",
        },
      ]),
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toEqual({
      ran: false,
      reason: "context_attempts_exhausted",
    });
    expect(harness.agentCalls).toHaveLength(0);
    const halt = harness.current()?.haltReason;
    expect(halt?.type === "loop_limit_reached" ? halt.summary : null).toContain(
      "2 round(s) for this loop",
    );
    expect(harness.published).toEqual([
      expect.objectContaining({
        outcome: "exhausted",
        loopGroupId: "refine",
        attempt: 2,
      }),
    ]);
  });

  it("does nothing for ineligible halts and non-halted executions", async () => {
    const running = makeHarness({
      initial: createWorkflowExecution({ status: "running" }),
    });
    const supervisor = createPlanRepairSupervisor(running.deps);
    expect(await supervisor.maybeRunPlanRepair(RUN_INPUT)).toEqual({
      ran: false,
      reason: "not_halted",
    });
    expect(running.agentCalls).toHaveLength(0);
    expect(running.published).toHaveLength(0);

    const none = makeHarness({ initial: null });
    const supervisor2 = createPlanRepairSupervisor(none.deps);
    expect(await supervisor2.maybeRunPlanRepair(RUN_INPUT)).toEqual({
      ran: false,
      reason: "no_execution",
    });
  });

  it("guards against concurrent runs for the same session", async () => {
    const harness = makeHarness({
      initial: haltedExecution(),
      applyOutcomes: [appliedOutcome(2)],
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const first = supervisor.maybeRunPlanRepair(RUN_INPUT);
    // Give the first run time to reach the (unscripted, pending) agent call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await supervisor.maybeRunPlanRepair(RUN_INPUT);
    expect(second).toEqual({ ran: false, reason: "in_flight" });

    harness.settlePendingAgent({
      kind: "verdict",
      verdict: {
        planningDefect: true,
        diagnosis: "fix",
        operations: REPAIR_OPS,
      },
      conversationId: "conv-repair-1",
    });
    await expect(first).resolves.toMatchObject({
      ran: true,
      outcome: "repaired",
    });
  });

  it("still settles the round as repaired (resumed false) when resume fails", async () => {
    const harness = makeHarness({
      initial: haltedExecution(),
      agentResults: [
        {
          kind: "verdict",
          verdict: {
            planningDefect: true,
            diagnosis: "AC fix",
            operations: REPAIR_OPS,
          },
          conversationId: "conv-repair-1",
        },
      ],
      applyOutcomes: [appliedOutcome(2)],
      resumeError: new Error("execution was aborted"),
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "repaired" });
    expect(harness.current()?.planRepairRounds.at(-1)).toMatchObject({
      outcome: "repaired",
      resumed: false,
    });
  });
});

/**
 * R10.1 — a narrowing names ONE assignment, so what lands must change one seat
 * and nothing else. The op is expanded into a whole-cohort write, and the agent
 * turn is minutes long, so the cohort the agent was shown is not necessarily the
 * cohort the write lands on: the expansion has to be built from the state the
 * apply is guarded against, not from the state the prompt was built from.
 */
describe("plan-repair validator narrowing vs. a concurrent cohort edit", () => {
  function haltedWithCohort(
    assignments: SeededValidatorAssignment[],
  ): GraphWorkflowExecution {
    const execution = haltedExecution();
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    )!;
    context.contextValidator = { enabled: true, assignments };
    return execution;
  }

  function withCohort(
    execution: GraphWorkflowExecution,
    assignments: SeededValidatorAssignment[],
  ): GraphWorkflowExecution {
    return {
      ...execution,
      liveRevision: execution.liveRevision + 1,
      workingDefinition: {
        ...execution.workingDefinition,
        executionContexts: execution.workingDefinition.executionContexts.map(
          (entry) =>
            entry.id === "context-implement"
              ? {
                  ...entry,
                  contextValidator: { enabled: true, assignments },
                }
              : entry,
        ),
      },
    };
  }

  const DEMOTE_ALPHA = [
    {
      type: "update-validator-assignment",
      contextId: "context-implement",
      assignmentId: "alpha",
      authority: "advisory",
    },
  ];

  function appliedCohort(
    operations: WorkflowLiveEditOperation[],
  ): Array<Record<string, unknown>> {
    const operation = operations[0] as {
      contextValidator?: { assignments?: Array<Record<string, unknown>> };
    };
    return operation.contextValidator?.assignments ?? [];
  }

  it("carries a concurrent operator edit through instead of overwriting it", async () => {
    const harness = makeHarness({
      initial: haltedWithCohort([
        makeSeededValidatorAssignment({ id: "alpha", authority: "blocking" }),
        makeSeededValidatorAssignment({
          id: "beta",
          authority: "blocking",
          focus: "Judge the migration order.",
        }),
      ]),
      // While the repair agent is thinking, an operator refocuses beta and adds
      // a third reviewer.
      duringAgentTurn: (current) =>
        withCohort(current, [
          makeSeededValidatorAssignment({ id: "alpha", authority: "blocking" }),
          makeSeededValidatorAssignment({
            id: "beta",
            authority: "blocking",
            focus: "Judge the rollback path instead.",
          }),
          makeSeededValidatorAssignment({ id: "gamma", authority: "advisory" }),
        ]),
      agentResults: [
        {
          kind: "verdict",
          verdict: {
            planningDefect: true,
            diagnosis: "alpha's blocking standard is mis-scoped",
            operations: DEMOTE_ALPHA,
          },
          conversationId: "conv-repair-1",
        },
      ],
      applyOutcomes: [appliedOutcome(3)],
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "repaired" });
    const cohort = appliedCohort(harness.appliedOperations[0] ?? []);
    // The operator's roster, not the one the agent was shown.
    expect(cohort.map((entry) => entry.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(cohort[1]).toMatchObject({
      focus: "Judge the rollback path instead.",
    });
    // …with exactly the named seat narrowed.
    expect(cohort[0]).toMatchObject({ id: "alpha", authority: "advisory" });
  });

  it("fails closed when the concurrent edit removed the seat the repair names", async () => {
    const harness = makeHarness({
      initial: haltedWithCohort([
        makeSeededValidatorAssignment({ id: "alpha", authority: "blocking" }),
        makeSeededValidatorAssignment({ id: "beta", authority: "blocking" }),
      ]),
      // The operator got there first and removed the seat outright.
      duringAgentTurn: (current) =>
        withCohort(current, [
          makeSeededValidatorAssignment({ id: "beta", authority: "blocking" }),
        ]),
      agentResults: [
        {
          kind: "verdict",
          verdict: {
            planningDefect: true,
            diagnosis: "alpha's blocking standard is mis-scoped",
            operations: DEMOTE_ALPHA,
          },
          conversationId: "conv-repair-1",
        },
      ],
    });
    const supervisor = createPlanRepairSupervisor(harness.deps);

    const result = await supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "failed" });
    // Nothing was written: a vanished seat is never resurrected by an expansion.
    expect(harness.applyRequests).toHaveLength(0);
    expect(harness.resumeCalls()).toBe(0);
    expect(harness.current()?.planRepairRounds.at(-1)).toMatchObject({
      outcome: "failed",
    });
    const current = harness.current();
    expect(
      current?.haltReason?.type === "circuit_breaker"
        ? current.haltReason.summary
        : null,
    ).toContain("alpha");
  });
});
