import { describe, expect, it } from "vitest";
import type { GraphWorkflowExecution } from "./schemas";
import {
  createWorkflowExecution,
  makeSeededValidatorAssignment,
} from "./test-fixtures";
import { createAuthoredContextOutcomeService } from "./authored-context-outcome";

const NOW = "2026-08-15T12:00:00.000Z";
const CONTEXT_ID = "context-plan";
const SESSION_LANE_ID = "__session__";

function lookup(
  execution: GraphWorkflowExecution | null,
  location: "active" | "archived" = "active",
) {
  return createAuthoredContextOutcomeService({
    async findExecutionById(executionId) {
      if (execution === null || execution.id !== executionId) return null;
      return { execution, location };
    },
  });
}

function outcome(
  execution: GraphWorkflowExecution | null,
  authoredContextId = CONTEXT_ID,
  location: "active" | "archived" = "active",
) {
  return lookup(execution, location).getAuthoredContextOutcome(
    execution?.id ?? "missing-execution",
    authoredContextId,
  );
}

function finalCandidate(
  execution: GraphWorkflowExecution | null,
  requiredAuthoredContextIds: readonly string[] = [CONTEXT_ID],
  location: "active" | "archived" = "archived",
) {
  return lookup(execution, location).getIntegrationReadyFinalCandidate(
    execution?.id ?? "missing-execution",
    requiredAuthoredContextIds,
  );
}

function oneContextExecution(
  placement: "readOnly" | "owned" | "full",
): GraphWorkflowExecution {
  const execution = createWorkflowExecution({ status: "running" });
  const context = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === CONTEXT_ID,
  )!;
  context.placement =
    placement === "owned"
      ? { lane: "delivery", mode: "owned", ownedPaths: ["src"] }
      : {
          lane: placement === "readOnly" ? "session" : "delivery",
          mode: placement,
        };
  execution.workingDefinition.executionContexts = [context];
  execution.workingDefinition.tasks = execution.workingDefinition.tasks.filter(
    (task) => task.contextId === CONTEXT_ID,
  );
  execution.workingDefinition.edges = [];
  execution.contextStates = {
    [CONTEXT_ID]: execution.contextStates[CONTEXT_ID]!,
  };
  execution.taskStates = Object.fromEntries(
    Object.entries(execution.taskStates).filter(
      ([, state]) => state.contextId === CONTEXT_ID,
    ),
  );
  return execution;
}

function completeContext(execution: GraphWorkflowExecution): void {
  const state = execution.contextStates[CONTEXT_ID]!;
  state.status = "completed";
  state.completedTaskCount = state.totalTaskCount;
  for (const task of Object.values(execution.taskStates)) {
    task.status = "completed";
    task.completedAt = NOW;
  }
}

function landAndIntegrate(
  execution: GraphWorkflowExecution,
  evidence: "commit" | "adopted-head" | "no-changes",
): void {
  const state = execution.contextStates[CONTEXT_ID]!;
  state.laneId = "delivery";
  state.landingIntent = {
    mode: "lane_commit",
    attempt: 1,
    token: `cc-landing:${execution.id}:${CONTEXT_ID}:1`,
    laneId: "delivery",
    worktreePath: "/repo/.worktrees/delivery",
    baselineSha: "base",
    headSha: evidence === "no-changes" ? "base" : "head",
    joinId: null,
    state: "landed",
    evidence,
    recordedAt: NOW,
    settledAt: NOW,
  };
  execution.executionLanes = {
    delivery: {
      laneId: "delivery",
      kind: "worktree",
      status: "merged",
      worktreePath: "/repo/.worktrees/delivery",
      branchName: "csm/delivery",
      includedContextIds: [CONTEXT_ID],
      lastCommittingContextId: CONTEXT_ID,
      commitSnapshots: [],
      ignoredBaseline: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    [SESSION_LANE_ID]: {
      laneId: SESSION_LANE_ID,
      kind: "session",
      status: "merged",
      worktreePath: "/repo",
      branchName: "csm/session",
      includedContextIds: [],
      lastCommittingContextId: null,
      commitSnapshots: [],
      ignoredBaseline: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
  execution.joins = {
    publish: {
      joinId: "publish",
      kind: "final_publish",
      contextId: null,
      targetLaneId: SESSION_LANE_ID,
      sourceLaneIds: ["delivery"],
      mergedSourceLaneIds: ["delivery"],
      validationDebtSourceLaneIds: [],
      sourceLaneContextIds: { delivery: [CONTEXT_ID] },
      validationEvidence: [],
      status: "succeeded",
      errorMessage: null,
      conflicts: null,
      conflictGuidance: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    },
  };
}

describe("getAuthoredContextOutcome", () => {
  it("returns pending for unfinished and approval-parked contexts", async () => {
    const execution = oneContextExecution("owned");

    await expect(outcome(execution)).resolves.toMatchObject({
      status: "pending",
      reason: "context_unsettled",
    });

    execution.contextStates[CONTEXT_ID]!.status = "awaiting_approval";
    await expect(outcome(execution)).resolves.toMatchObject({
      status: "pending",
      reason: "approval_pending",
    });
  });

  it("returns skipped for a settled conditional omission", async () => {
    const execution = oneContextExecution("owned");
    execution.contextStates[CONTEXT_ID]!.status = "skipped";
    execution.contextStates[CONTEXT_ID]!.skipReason = {
      edgeEvaluations: [{ edgeId: "guarded", verdict: "inactive" }],
      at: NOW,
    };

    await expect(outcome(execution)).resolves.toMatchObject({
      status: "skipped",
      reason: "route_skipped",
    });
  });

  it("returns failed for halted and aborted executions", async () => {
    const halted = oneContextExecution("owned");
    halted.status = "halted";
    halted.contextStates[CONTEXT_ID]!.status = "halted";
    await expect(outcome(halted)).resolves.toMatchObject({
      status: "failed",
      reason: "execution_halted",
    });

    const aborted = oneContextExecution("owned");
    aborted.status = "aborted";
    await expect(outcome(aborted)).resolves.toMatchObject({
      status: "failed",
      reason: "execution_aborted",
    });
  });

  it("satisfies read-only and validator-disabled contexts without landing evidence", async () => {
    const execution = oneContextExecution("readOnly");
    const context = execution.workingDefinition.executionContexts[0]!;
    context.outputSchema = {
      type: "object",
      properties: { report: { type: "string" } },
      required: ["report"],
    };
    execution.contextOutputs[CONTEXT_ID] = {
      value: { report: "done" },
      capturedAt: NOW,
      iteration: 1,
      parse: { source: "native" },
    };
    completeContext(execution);

    await expect(outcome(execution)).resolves.toMatchObject({
      status: "satisfied",
      reason: "read_only_completed",
    });
  });

  it.each(["no-changes", "adopted-head", "commit"] as const)(
    "satisfies an integrated write-capable context with %s landing evidence",
    async (evidence) => {
      const execution = oneContextExecution(
        evidence === "adopted-head" ? "full" : "owned",
      );
      completeContext(execution);
      landAndIntegrate(execution, evidence);

      await expect(outcome(execution)).resolves.toMatchObject({
        status: "satisfied",
        reason: "write_result_integrated",
      });
    },
  );

  it("satisfies completed script, validator, and consumed approval gates", async () => {
    const execution = oneContextExecution("owned");
    const context = execution.workingDefinition.executionContexts[0]!;
    context.scriptValidator = { commands: ["test"] };
    context.contextValidator = {
      enabled: true,
      assignments: [makeSeededValidatorAssignment()],
    };
    context.humanApprovalGate = { enabled: true };
    execution.contextStates[CONTEXT_ID]!.validationRound = {
      seq: 1,
      candidate: {
        headSha: "head",
        candidateTreeHash: "tree",
        taskStateHash: "tasks",
        identityScope: "wholeTree",
      },
      roster: [],
      specialists: {},
      phase: "concluded",
      outcome: "passed",
      startedAt: NOW,
    };
    completeContext(execution);
    landAndIntegrate(execution, "commit");

    await expect(outcome(execution)).resolves.toMatchObject({
      status: "satisfied",
      reason: "write_result_integrated",
    });
  });

  it("keeps a landed write result pending until integration, then fails a terminal missing integration", async () => {
    const execution = oneContextExecution("owned");
    completeContext(execution);
    landAndIntegrate(execution, "commit");
    delete execution.joins.publish;

    await expect(outcome(execution)).resolves.toMatchObject({
      status: "pending",
      reason: "integration_pending",
    });

    execution.status = "completed";
    await expect(outcome(execution)).resolves.toMatchObject({
      status: "failed",
      reason: "write_result_not_integrated",
    });
  });

  it("fails completed contexts whose configured output or validation gate is unsatisfied", async () => {
    const outputMissing = oneContextExecution("readOnly");
    outputMissing.workingDefinition.executionContexts[0]!.outputSchema = {
      type: "object",
      properties: { report: { type: "string" } },
      required: ["report"],
    };
    completeContext(outputMissing);
    await expect(outcome(outputMissing)).resolves.toMatchObject({
      status: "failed",
      reason: "output_gate_failed",
    });

    const validationFailed = oneContextExecution("readOnly");
    validationFailed.workingDefinition.executionContexts[0]!.scriptValidator = {
      commands: ["test"],
    };
    completeContext(validationFailed);
    await expect(outcome(validationFailed)).resolves.toMatchObject({
      status: "failed",
      reason: "validation_gate_failed",
    });
  });

  it("returns typed failures for failed script, validator, and approval gates", async () => {
    const scriptFailed = oneContextExecution("readOnly");
    scriptFailed.contextStates[CONTEXT_ID]!.validationRound = {
      seq: 1,
      candidate: {
        headSha: "head",
        candidateTreeHash: "tree",
        taskStateHash: "tasks",
        identityScope: "wholeTree",
      },
      roster: [],
      specialists: {},
      phase: "concluded",
      outcome: "script_failed",
      startedAt: NOW,
    };
    await expect(outcome(scriptFailed)).resolves.toMatchObject({
      status: "failed",
      reason: "script_gate_failed",
    });

    const validatorFailed = oneContextExecution("readOnly");
    validatorFailed.contextStates[CONTEXT_ID]!.validationRound = {
      seq: 1,
      candidate: {
        headSha: "head",
        candidateTreeHash: "tree",
        taskStateHash: "tasks",
        identityScope: "wholeTree",
      },
      roster: [],
      specialists: {},
      phase: "concluded",
      outcome: "failed",
      startedAt: NOW,
    };
    await expect(outcome(validatorFailed)).resolves.toMatchObject({
      status: "failed",
      reason: "validator_gate_failed",
    });

    const approvalRejected = oneContextExecution("readOnly");
    approvalRejected.contextStates[CONTEXT_ID]!.status = "awaiting_approval";
    approvalRejected.contextStates[CONTEXT_ID]!.pendingApproval = {
      conversationId: "conversation-1",
      requestedAt: NOW,
      approvalScope: { kind: "whole_tree" },
      decision: {
        type: "rejected",
        message: "Needs remediation",
        decidedAt: NOW,
      },
    };
    await expect(outcome(approvalRejected)).resolves.toMatchObject({
      status: "failed",
      reason: "approval_gate_failed",
    });
  });

  it.each([
    { outcome: "candidate_mismatch", contextStatus: "ready" },
    { outcome: "roster_drift", contextStatus: "running" },
  ] as const)(
    "keeps a $contextStatus context pending after a $outcome validation incident",
    async ({ outcome: validationOutcome, contextStatus }) => {
      const execution = oneContextExecution("readOnly");
      execution.contextStates[CONTEXT_ID]!.status = contextStatus;
      execution.contextStates[CONTEXT_ID]!.validationRound = {
        seq: 1,
        candidate: {
          headSha: "head",
          candidateTreeHash: "tree",
          taskStateHash: "tasks",
          identityScope: "wholeTree",
        },
        roster: [],
        specialists: {},
        phase: "concluded",
        outcome: validationOutcome,
        startedAt: NOW,
      };

      await expect(outcome(execution)).resolves.toMatchObject({
        status: "pending",
        reason: "context_unsettled",
      });
    },
  );

  it("fails a write-capable claimant when its final integration join fails", async () => {
    const execution = oneContextExecution("owned");
    completeContext(execution);
    landAndIntegrate(execution, "commit");
    execution.joins.publish!.status = "failed";
    execution.joins.publish!.errorMessage = "Final merge validation failed";

    await expect(outcome(execution)).resolves.toMatchObject({
      status: "failed",
      reason: "integration_failed",
    });
  });

  it("keeps generated work rolled up to its stable spawner and resolves a post-loop integration context", async () => {
    const spawner = oneContextExecution("readOnly");
    completeContext(spawner);
    const generated = {
      ...spawner.workingDefinition.executionContexts[0]!,
      id: "generated-child",
    };
    spawner.workingDefinition.executionContexts.push(generated);
    spawner.contextStates[generated.id] = {
      ...spawner.contextStates[CONTEXT_ID]!,
      contextId: generated.id,
      status: "running",
    };
    spawner.expansionReceipts.accepted.push({
      requestId: "request-rollup",
      payloadHash: "b".repeat(64),
      invokerContextId: CONTEXT_ID,
      initiatorConversationId: "conversation-1",
      rationale: "Perform dynamic work",
      addedContextIds: [generated.id],
      addedTaskIds: [],
      rejoinContextIds: [],
      liveRevision: 2,
      acceptedAt: NOW,
    });
    await expect(outcome(spawner)).resolves.toMatchObject({
      status: "satisfied",
      reason: "read_only_completed",
    });

    const postLoop = oneContextExecution("readOnly");
    const template = {
      ...postLoop.workingDefinition.executionContexts[0]!,
      id: "loop-worker",
    };
    postLoop.workingDefinition.loopGroups = [
      {
        id: "refine",
        entryContextId: template.id,
        exitContextId: template.id,
        until: { schema: { type: "object" } },
        maxPasses: 2,
        template: { contexts: [template], tasks: [], edges: [] },
        templateVersion: 1,
        planRepair: { enabled: false, maxAttemptsPerContext: 1 },
      },
    ];
    postLoop.loopStates.refine = {
      loopGroupId: "refine",
      activation: "concluded",
      loopControlRevision: 0,
      passCount: 1,
      slotLedger: [],
      boundaryInputs: [],
      decisions: {},
      passTemplateVersions: { "1": 1 },
      concludingExitContextId: "refine__p1__loop-worker",
      activatedAt: NOW,
      settledAt: NOW,
    };
    completeContext(postLoop);
    await expect(outcome(postLoop)).resolves.toMatchObject({
      status: "satisfied",
      reason: "read_only_completed",
    });
  });

  it("returns typed failures for unknown executions, unknown ids, generated children, and loop ids", async () => {
    await expect(outcome(null)).resolves.toMatchObject({
      status: "failed",
      reason: "execution_not_found",
    });

    const execution = oneContextExecution("owned");
    await expect(outcome(execution, "unknown")).resolves.toMatchObject({
      status: "failed",
      reason: "authored_context_not_found",
    });

    const generated = {
      ...execution.workingDefinition.executionContexts[0]!,
      id: "generated-child",
    };
    execution.workingDefinition.executionContexts.push(generated);
    execution.contextStates[generated.id] = {
      ...execution.contextStates[CONTEXT_ID]!,
      contextId: generated.id,
    };
    execution.expansionReceipts.accepted.push({
      requestId: "request-1",
      payloadHash: "a".repeat(64),
      invokerContextId: CONTEXT_ID,
      initiatorConversationId: "conversation-1",
      rationale: "Generate a child",
      addedContextIds: [generated.id],
      addedTaskIds: [],
      rejoinContextIds: [],
      liveRevision: 2,
      acceptedAt: NOW,
    });
    await expect(outcome(execution, generated.id)).resolves.toMatchObject({
      status: "failed",
      reason: "generated_context_not_authored",
    });

    const template = execution.workingDefinition.executionContexts[0]!;
    execution.workingDefinition.loopGroups = [
      {
        id: "refine",
        entryContextId: template.id,
        exitContextId: template.id,
        until: { schema: { type: "object" } },
        maxPasses: 2,
        template: { contexts: [template], tasks: [], edges: [] },
        templateVersion: 1,
        planRepair: { enabled: false, maxAttemptsPerContext: 1 },
      },
    ];
    await expect(outcome(execution, template.id)).resolves.toMatchObject({
      status: "failed",
      reason: "loop_body_template_not_authored_source",
    });
    await expect(
      outcome(execution, "refine__p1__context-plan"),
    ).resolves.toMatchObject({
      status: "failed",
      reason: "loop_instance_not_authored_source",
    });
  });

  it("reads completed archived executions with an explicit archived location", async () => {
    const execution = oneContextExecution("readOnly");
    completeContext(execution);
    execution.status = "completed";
    execution.completedAt = NOW;

    await expect(outcome(execution, CONTEXT_ID, "archived")).resolves.toEqual({
      status: "satisfied",
      reason: "read_only_completed",
      executionLocation: "archived",
    });
  });
});

describe("getIntegrationReadyFinalCandidate", () => {
  it("satisfies a completed graph whose required write lane reached final publish", async () => {
    const execution = oneContextExecution("owned");
    completeContext(execution);
    landAndIntegrate(execution, "commit");
    execution.status = "completed";
    execution.completedAt = NOW;

    await expect(finalCandidate(execution)).resolves.toEqual({
      status: "satisfied",
      reason: "integration_ready",
      executionLocation: "archived",
    });
  });

  it("requires graph completion after claimant satisfaction", async () => {
    const execution = oneContextExecution("readOnly");
    completeContext(execution);

    await expect(finalCandidate(execution)).resolves.toMatchObject({
      status: "pending",
      reason: "execution_unsettled",
    });
  });

  it("fails a graph whose final publish join failed", async () => {
    const execution = oneContextExecution("owned");
    completeContext(execution);
    landAndIntegrate(execution, "commit");
    execution.joins.publish!.status = "failed";

    await expect(finalCandidate(execution)).resolves.toMatchObject({
      status: "failed",
      reason: "final_publish_failed",
    });
  });

  it("fails when a required authored claimant is not integrated", async () => {
    const execution = oneContextExecution("readOnly");
    completeContext(execution);
    execution.status = "completed";
    execution.completedAt = NOW;

    await expect(
      finalCandidate(execution, ["unclaimed-context"]),
    ).resolves.toMatchObject({
      status: "failed",
      reason: "required_claimant_not_integrated",
    });
  });
});
