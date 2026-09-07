import { createNonParticipatingGraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
/**
 * Plan-defect routing, end to end through production parts only.
 *
 * The chain under test is the one `runExecutionLoopWithPlanRepair` composes:
 * the orchestrator concludes a round on a blocking seat's typed defect, the
 * production halt path records it, the loop's settle (`drainAndHalt`) turns it
 * into a halted execution, and the supervisor gets its shot at that settlement.
 * Nothing here hand-builds the halt — a routing test whose subject is whether
 * the engine's OWN halt reaches repair cannot supply that halt itself.
 *
 * Fakes sit only at the true boundaries: the specialist dispatch and the repair
 * agent's turn. The trigger, the halt record, the drain, the supervisor, the
 * live-edit core, and the resume are all production code.
 */

import { describe, expect, it } from "vitest";
import {
  createCohortExecution,
  createHarness,
  metadata,
  planDefectResult,
  PLAN_DEFECT,
  type Harness,
} from "@/lib/workflow-graph/testing/cohort-engine-harness";
import { makeLiveEditDeps } from "../loop-test-fixtures";
import { applyLiveEditsToActiveExecution } from "../live-edit-apply";
import { prepareLiveEditAssignmentSnapshots } from "../live-edit-preparation";
import { makeProfileSnapshot } from "../test-fixtures";
import { createGraphWorkflowExecutionEventPublisher } from "../execution-events";
import type { GraphWorkflowExecution } from "../schemas";
import {
  createPlanRepairSupervisor,
  type PlanRepairAgentResult,
  type PlanRepairSupervisorDeps,
} from "./supervisor";

const RUN_INPUT = {
  projectPath: "/repo",
  sessionName: "session-1",
  projectName: "repo",
};

const NOW = "2026-08-16T12:00:00.000Z";

/** The repair the agent proposes: rewrite the criterion the defect names. */
const REPAIR_OPS = [
  {
    type: "update-context",
    contextId: "context-plan",
    acceptanceCriteria: "Document the reader; the publisher is not in scope.",
  },
];

/** The tripped context with plan repair switched off by its own policy. */
function withRepairDisabled(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return {
    ...execution,
    workingDefinition: {
      ...execution.workingDefinition,
      executionContexts: execution.workingDefinition.executionContexts.map(
        (context) =>
          context.id === "context-plan"
            ? {
                ...context,
                planRepair: { enabled: false, maxAttemptsPerContext: 2 },
              }
            : context,
      ),
    },
  };
}

/**
 * An execution the ENGINE halted on a plan defect: one blocking seat reports
 * the typed refusal, the production halt path records it pending, and the
 * loop's settle drains it.
 */
async function haltedOnPlanDefect(
  options: { repairEnabled?: boolean } = {},
): Promise<Harness> {
  const execution = createCohortExecution({ assignmentIds: ["general"] });
  const harness = createHarness({
    execution:
      options.repairEnabled === false
        ? withRepairDisabled(execution)
        : execution,
    productionSignalHalt: true,
    runContextValidator: async (input) => ({
      result: planDefectResult(input.validator.id),
      metadata: metadata(),
      roundToken: input.roundToken ?? null,
    }),
  });
  await harness.run();
  await harness.drainAndHalt();
  return harness;
}

interface SupervisorHarness {
  supervisor: ReturnType<typeof createPlanRepairSupervisor>;
  prompts: string[];
  current(): GraphWorkflowExecution;
}

/**
 * The supervisor as `execution-route-handlers.ts` composes it, over the
 * harness's repository: the shared live-edit apply core carries the repair, and
 * the resume is the manager's own.
 */
function supervisorOver(
  harness: Harness,
  agentResult: PlanRepairAgentResult,
): SupervisorHarness {
  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    now: () => NOW,
  });
  const prompts: string[] = [];

  const deps: PlanRepairSupervisorDeps = {
    getActiveExecution: () => harness.repository.getActive(),
    mutateActive: harness.repository.mutateActive,
    applyLiveEdits: (input) =>
      applyLiveEditsToActiveExecution(input, {
        executionContract: createNonParticipatingGraphExecutionContract(),
        getActiveExecution: () => harness.repository.getActive(),
        mutateActive: harness.repository.mutateActive,
        buildLiveEditDeps: () => Promise.resolve(makeLiveEditDeps()),
        prepareAssignmentSnapshots: (_projectPath, operations) =>
          prepareLiveEditAssignmentSnapshots({
            operations,
            composeSnapshot: async (assignment) =>
              makeProfileSnapshot({ ...assignment.profile }),
          }),
        publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
        publishCharterUpdated: eventPublisher.publishCharterUpdated,
        getSession: () => Promise.resolve(null),
        writeCharterDocument: () => Promise.resolve(),
      }),
    runRepairAgent: (invocation) => {
      prompts.push(invocation.prompt);
      return Promise.resolve(agentResult);
    },
    resumeExecution: () => harness.resumeHalt(),
    getValidationHistory: () => Promise.resolve([]),
    getSessionWorktreePath: () => Promise.resolve("/wt/session"),
    publishPlanRepairRound: eventPublisher.publishPlanRepairRound,
    now: () => NOW,
  };

  return {
    supervisor: createPlanRepairSupervisor(deps),
    prompts,
    current: () => harness.repository.read(),
  };
}

function repairedVerdict(): PlanRepairAgentResult {
  return {
    kind: "verdict",
    verdict: {
      planningDefect: true,
      diagnosis: "Criterion 2 names a context this one may not touch.",
      operations: REPAIR_OPS,
    },
    conversationId: "conv-repair-1",
  };
}

const DECLINE_DIAGNOSIS =
  "The criterion is satisfiable here; the reviewer misread the ownership.";

/** The repair agent's own authority to reject the seat's classification. */
function declinedVerdict(): PlanRepairAgentResult {
  return {
    kind: "verdict",
    verdict: {
      planningDefect: false,
      diagnosis: DECLINE_DIAGNOSIS,
      operations: [],
    },
    conversationId: "conv-repair-1",
  };
}

describe("a plan-defect halt routes into plan repair", () => {
  it("reaches the supervisor from the settled halt, with no breaker round spent first", async () => {
    const harness = await haltedOnPlanDefect();
    // The halt the engine wrote, not one this test composed.
    expect(harness.repository.read()).toMatchObject({
      status: "halted",
      haltReason: {
        type: "plan_defect",
        contextId: "context-plan",
        planDefects: [{ ...PLAN_DEFECT, assignmentId: "general" }],
      },
    });

    const seam = supervisorOver(harness, repairedVerdict());
    const result = await seam.supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, seq: 1 });
    expect(seam.prompts).toHaveLength(1);
    // The agent is handed the classified defect off the engine's own halt.
    expect(seam.prompts[0]).toContain("## Plan defect");
    expect(seam.prompts[0]).toContain(PLAN_DEFECT.whyNotLocallyRemediable);
    // Attempt 1 on the FIRST halt: the defect went straight to repair rather
    // than waiting for the reopen loop to exhaust a retry budget it can never
    // satisfy — the context never failed a round.
    expect(seam.current().planRepairRounds).toMatchObject([
      {
        seq: 1,
        contextId: "context-plan",
        haltType: "plan_defect",
        loopGroupId: null,
      },
    ]);
    expect(seam.current().contextStates["context-plan"]?.iterationCount).toBe(
      2,
    );
  });

  it("repaired: applies the allowlisted ops through the live-edit core and resumes", async () => {
    const harness = await haltedOnPlanDefect();
    const seam = supervisorOver(harness, repairedVerdict());

    const result = await seam.supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "repaired" });
    const after = seam.current();
    // Applied through the shared core, not written by the supervisor: the
    // criterion the defect named is rewritten and the live revision advanced.
    expect(
      after.workingDefinition.executionContexts.find(
        (context) => context.id === "context-plan",
      )?.acceptanceCriteria,
    ).toBe(REPAIR_OPS[0]!.acceptanceCriteria);
    expect(after.liveRevision).toBe(2);
    // Auto-resumed: the halt is cleared and the run is going again without an
    // operator in the loop.
    expect(after.status).toBe("running");
    expect(after.haltReason).toBeNull();
    expect(after.planRepairRounds.at(-1)).toMatchObject({
      haltType: "plan_defect",
      outcome: "repaired",
      planningDefect: true,
      operationCount: 1,
      resumed: true,
    });
  });

  it("declined: stays halted on the plan defect, carrying the diagnosis, reopening nothing", async () => {
    const harness = await haltedOnPlanDefect();
    const seam = supervisorOver(harness, declinedVerdict());

    const result = await seam.supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toMatchObject({ ran: true, outcome: "declined" });
    const after = seam.current();
    expect(after.status).toBe("halted");
    // The halt keeps its own reason and gains the decline as its summary —
    // repair has spoken, and the halt is what explains it to an operator.
    expect(after.haltReason?.type).toBe("plan_defect");
    expect(
      after.haltReason?.type === "plan_defect"
        ? after.haltReason.summary
        : null,
    ).toContain(DECLINE_DIAGNOSIS);
    // Resuming the reopen loop is exactly what this halt exists to escape: a
    // decline must not hand the implementer back a contract nobody repaired.
    expect(after.taskStates["task-plan-1"]?.status).toBe("completed");
    expect(after.contextStates["context-plan"]?.status).toBe("halted");
    expect(after.planRepairRounds.at(-1)).toMatchObject({
      haltType: "plan_defect",
      outcome: "declined",
      planningDefect: false,
      operationCount: 0,
      resumed: false,
    });
  });

  it("repair disabled: never runs the agent, and the run stays halted with nothing reopened", async () => {
    const harness = await haltedOnPlanDefect({ repairEnabled: false });
    const seam = supervisorOver(harness, repairedVerdict());

    const result = await seam.supervisor.maybeRunPlanRepair(RUN_INPUT);

    expect(result).toEqual({ ran: false, reason: "disabled" });
    expect(seam.prompts).toEqual([]);
    const after = seam.current();
    expect(after.status).toBe("halted");
    expect(after.haltReason?.type).toBe("plan_defect");
    expect(after.planRepairRounds).toEqual([]);
    expect(after.taskStates["task-plan-1"]?.status).toBe("completed");
    expect(after.contextStates["context-plan"]?.status).toBe("halted");
  });
});
