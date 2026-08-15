import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GraphWorkflowApprovalDecision,
  GraphWorkflowApprovalScope,
  GraphWorkflowExecution,
  GraphWorkflowPendingApproval,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createApprovalGateService } from "./approval-gate";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createWorkflowExecution } from "./test-fixtures";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";
const GATED_CONTEXT_ID = "context-implement";
const CONVERSATION_ID = "conv-gate-1";
const NOW = "2026-06-10T10:00:00.000Z";

function buildExecution(input: {
  executionStatus?: GraphWorkflowStatus;
  contextStatus?: "running" | "awaiting_approval";
  pendingApproval?: GraphWorkflowPendingApproval | null;
}): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    status: input.executionStatus ?? "running",
    // A halted fixture carries a resumable reason, the only halt shape the
    // engine produces (its halt event's reason is non-nullable) and the one the
    // lease predicate keeps Current.
    ...(input.executionStatus === "halted"
      ? {
          haltReason: {
            type: "circuit_breaker" as const,
            contextId: GATED_CONTEXT_ID,
            condition: "retry_exhaustion" as const,
            summary: null,
          },
        }
      : {}),
  });
  const contextState = execution.contextStates[GATED_CONTEXT_ID];
  if (!contextState) throw new Error("fixture missing gated context");
  contextState.status = input.contextStatus ?? "awaiting_approval";
  contextState.pendingApproval =
    input.pendingApproval !== undefined
      ? input.pendingApproval
      : {
          conversationId: CONVERSATION_ID,
          requestedAt: "2026-06-10T09:00:00.000Z",
          decision: null,
          approvalScope: { kind: "whole_tree" },
        };
  return execution;
}

const FROZEN_SCOPED_SCOPE: GraphWorkflowApprovalScope = {
  kind: "scoped",
  ownedPaths: ["src/api"],
  treeHash: "owned-digest-1",
  headSha: "base-sha-1",
};

describe("createApprovalGateService.enterAwaitingApproval", () => {
  function buildService() {
    return createApprovalGateService({
      async mutateActive() {
        throw new Error("not used by enterAwaitingApproval");
      },
      now: () => NOW,
    });
  }

  it("sets the context to awaiting_approval with a fresh pending record", () => {
    const service = buildService();
    const execution = buildExecution({
      contextStatus: "running",
      pendingApproval: null,
    });

    const entered = service.enterAwaitingApproval(execution, {
      contextId: GATED_CONTEXT_ID,
      conversationId: CONVERSATION_ID,
      approvalScope: { kind: "whole_tree" },
    });

    const contextState = execution.contextStates[GATED_CONTEXT_ID];
    expect(contextState?.status).toBe("awaiting_approval");
    expect(contextState?.pendingApproval).toEqual({
      conversationId: CONVERSATION_ID,
      requestedAt: NOW,
      decision: null,
      // A full-access member declares no ownership, so it parks on the
      // whole-tree view it has always been reviewed under.
      approvalScope: { kind: "whole_tree" },
    });
    // Pure helper: the `gate.pending` observability is returned as DATA for the
    // caller to log post-commit (no logging I/O inside the write-queue reducer).
    expect(entered).toEqual({
      conversationId: CONVERSATION_ID,
      requestedAt: NOW,
    });
  });

  it("leaves other contexts and accounting fields untouched", () => {
    const service = buildService();
    const execution = buildExecution({
      contextStatus: "running",
      pendingApproval: null,
    });
    const before = structuredClone(execution);

    service.enterAwaitingApproval(execution, {
      contextId: GATED_CONTEXT_ID,
      conversationId: CONVERSATION_ID,
      approvalScope: { kind: "whole_tree" },
    });

    const gated = execution.contextStates[GATED_CONTEXT_ID];
    const gatedBefore = before.contextStates[GATED_CONTEXT_ID];
    expect(gated?.iterationCount).toBe(gatedBefore?.iterationCount);
    expect(gated?.consecutiveFailureCount).toBe(
      gatedBefore?.consecutiveFailureCount,
    );
    expect(execution.contextStates["context-plan"]).toEqual(
      before.contextStates["context-plan"],
    );
    expect(execution.contextStates["context-verify"]).toEqual(
      before.contextStates["context-verify"],
    );
    expect(execution.status).toBe(before.status);
  });

  it("persists the frozen scoped snapshot an owning member parks on", () => {
    const service = buildService();
    const execution = buildExecution({
      contextStatus: "running",
      pendingApproval: null,
    });

    service.enterAwaitingApproval(execution, {
      contextId: GATED_CONTEXT_ID,
      conversationId: CONVERSATION_ID,
      approvalScope: FROZEN_SCOPED_SCOPE,
    });

    expect(execution.contextStates[GATED_CONTEXT_ID]?.pendingApproval).toEqual({
      conversationId: CONVERSATION_ID,
      requestedAt: NOW,
      decision: null,
      approvalScope: FROZEN_SCOPED_SCOPE,
    });
  });

  it("throws for an unknown context id", () => {
    const service = buildService();
    const execution = buildExecution({});

    expect(() =>
      service.enterAwaitingApproval(execution, {
        contextId: "context-missing",
        conversationId: CONVERSATION_ID,
        approvalScope: { kind: "whole_tree" },
      }),
    ).toThrow(/context-missing/);
  });
});

function buildDraftService() {
  return createApprovalGateService({
    async mutateActive() {
      throw new Error("not used by draft-level methods");
    },
    now: () => NOW,
  });
}

function buildExecutionWithDecision(
  decision: GraphWorkflowApprovalDecision,
): GraphWorkflowExecution {
  return buildExecution({
    pendingApproval: {
      conversationId: CONVERSATION_ID,
      requestedAt: "2026-06-10T09:00:00.000Z",
      decision,
      approvalScope: { kind: "whole_tree" },
    },
  });
}

describe("createApprovalGateService.applyApprovedDecision", () => {
  it("clears the pending record and leaves everything else untouched", () => {
    const service = buildDraftService();
    const execution = buildExecutionWithDecision({
      type: "approved",
      decidedAt: NOW,
    });
    const before = structuredClone(execution);

    const applied = service.applyApprovedDecision(execution, GATED_CONTEXT_ID);

    // Pure helper: returns the `gate.applied` observability as DATA for the
    // caller to log post-commit (no logging I/O inside the write-queue reducer).
    expect(applied).toEqual({ decisionType: "approved" });

    const contextState = execution.contextStates[GATED_CONTEXT_ID];
    expect(contextState?.pendingApproval).toBeNull();
    expect(contextState?.status).toBe("awaiting_approval");
    expect(execution.workingDefinition.tasks).toEqual(
      before.workingDefinition.tasks,
    );
    expect(execution.taskStates).toEqual(before.taskStates);
    expect(contextState?.totalTaskCount).toBe(
      before.contextStates[GATED_CONTEXT_ID]?.totalTaskCount,
    );
    expect(contextState?.consecutiveFailureCount).toBe(
      before.contextStates[GATED_CONTEXT_ID]?.consecutiveFailureCount,
    );
    expect(execution.contextStates["context-plan"]).toEqual(
      before.contextStates["context-plan"],
    );
    expect(execution.contextStates["context-verify"]).toEqual(
      before.contextStates["context-verify"],
    );
  });

  it("throws when the context is not awaiting approval", () => {
    const service = buildDraftService();
    const execution = buildExecution({
      contextStatus: "running",
      pendingApproval: null,
    });

    expect(() =>
      service.applyApprovedDecision(execution, GATED_CONTEXT_ID),
    ).toThrow(/not awaiting approval/);
  });

  it("throws when no decision has been recorded", () => {
    const service = buildDraftService();
    const execution = buildExecution({});

    expect(() =>
      service.applyApprovedDecision(execution, GATED_CONTEXT_ID),
    ).toThrow(/no recorded decision/);
  });

  it("throws when the recorded decision is rejected", () => {
    const service = buildDraftService();
    const execution = buildExecutionWithDecision({
      type: "rejected",
      message: "Not good enough",
      decidedAt: NOW,
    });

    expect(() =>
      service.applyApprovedDecision(execution, GATED_CONTEXT_ID),
    ).toThrow(/rejected/);
  });

  it("throws for an unknown context id", () => {
    const service = buildDraftService();
    const execution = buildExecution({});

    expect(() =>
      service.applyApprovedDecision(execution, "context-missing"),
    ).toThrow(/context-missing/);
  });
});

describe("createApprovalGateService.applyRejectedDecision", () => {
  const REJECTION_MESSAGE = "Use the v2 API shape and add error handling";

  it("clears the record, appends a remediation task, sets running, and updates task counts", () => {
    const service = buildDraftService();
    const execution = buildExecutionWithDecision({
      type: "rejected",
      message: REJECTION_MESSAGE,
      decidedAt: NOW,
    });
    const contextStateBefore = execution.contextStates[GATED_CONTEXT_ID];
    if (!contextStateBefore) throw new Error("fixture missing gated context");
    contextStateBefore.consecutiveFailureCount = 2;

    const applied = service.applyRejectedDecision(execution, GATED_CONTEXT_ID);

    // Pure helper: returns the `gate.applied` observability as DATA for the
    // caller to log post-commit (no logging I/O inside the write-queue reducer).
    expect(applied).toEqual({
      decisionType: "rejected",
      remediationTaskId: `task-${GATED_CONTEXT_ID}-rejection-1`,
      rejectionMessageLength: REJECTION_MESSAGE.length,
    });

    const contextState = execution.contextStates[GATED_CONTEXT_ID];
    expect(contextState?.pendingApproval).toBeNull();
    expect(contextState?.status).toBe("running");

    const remediationTask = execution.workingDefinition.tasks.find(
      (task) => task.id === `task-${GATED_CONTEXT_ID}-rejection-1`,
    );
    expect(remediationTask).toBeDefined();
    expect(remediationTask?.contextId).toBe(GATED_CONTEXT_ID);
    expect(remediationTask?.order).toBe(2);
    expect(remediationTask?.instructions).toContain(REJECTION_MESSAGE);
    expect(remediationTask?.source).toBe("user");

    const remediationState =
      execution.taskStates[`task-${GATED_CONTEXT_ID}-rejection-1`];
    expect(remediationState).toMatchObject({
      taskId: `task-${GATED_CONTEXT_ID}-rejection-1`,
      contextId: GATED_CONTEXT_ID,
      order: 2,
      status: "pending",
      failureMessage: null,
      failureHistory: [],
    });

    expect(contextState?.totalTaskCount).toBe(2);
    expect(contextState?.completedTaskCount).toBe(0);
    expect(contextState?.iterationCount).toBe(0);
  });

  it("drops a captured structured output so remediation work must satisfy the contract again (D2 R2)", () => {
    const service = buildDraftService();
    const execution = buildExecutionWithDecision({
      type: "rejected",
      message: REJECTION_MESSAGE,
      decidedAt: NOW,
    });
    execution.contextOutputs = {
      [GATED_CONTEXT_ID]: {
        value: { summary: "the work the human just rejected" },
        capturedAt: NOW,
        iteration: 1,
        parse: { source: "raw_json" },
      },
      "context-other": {
        value: { summary: "an unrelated context's output" },
        capturedAt: NOW,
        iteration: 1,
        parse: { source: "raw_json" },
      },
    };

    service.applyRejectedDecision(execution, GATED_CONTEXT_ID);

    // The banked payload described work a human refused. Capture is skipped
    // whenever an output already exists, so leaving it would let the context
    // re-complete after remediation carrying the PRE-rejection output.
    expect(execution.contextOutputs[GATED_CONTEXT_ID]).toBeUndefined();
    // Scoped to the rejected context only.
    expect(execution.contextOutputs["context-other"]).toBeDefined();
  });

  it("never touches the consecutive-failure count, across repeated rejections", () => {
    const service = buildDraftService();
    const execution = buildExecutionWithDecision({
      type: "rejected",
      message: "First pass is wrong",
      decidedAt: NOW,
    });
    const contextState = execution.contextStates[GATED_CONTEXT_ID];
    if (!contextState) throw new Error("fixture missing gated context");
    contextState.consecutiveFailureCount = 3;

    service.applyRejectedDecision(execution, GATED_CONTEXT_ID);
    expect(contextState.consecutiveFailureCount).toBe(3);

    contextState.status = "awaiting_approval";
    contextState.pendingApproval = {
      conversationId: CONVERSATION_ID,
      requestedAt: NOW,
      approvalScope: { kind: "whole_tree" },
      decision: { type: "rejected", message: "Still wrong", decidedAt: NOW },
    };
    service.applyRejectedDecision(execution, GATED_CONTEXT_ID);
    expect(contextState.consecutiveFailureCount).toBe(3);
  });

  it("produces unique remediation task ids across repeated rejections", () => {
    const service = buildDraftService();
    const execution = buildExecutionWithDecision({
      type: "rejected",
      message: "First rejection feedback",
      decidedAt: NOW,
    });

    service.applyRejectedDecision(execution, GATED_CONTEXT_ID);

    const contextState = execution.contextStates[GATED_CONTEXT_ID];
    if (!contextState) throw new Error("fixture missing gated context");
    contextState.status = "awaiting_approval";
    contextState.pendingApproval = {
      conversationId: CONVERSATION_ID,
      requestedAt: NOW,
      approvalScope: { kind: "whole_tree" },
      decision: {
        type: "rejected",
        message: "Second rejection feedback",
        decidedAt: NOW,
      },
    };
    service.applyRejectedDecision(execution, GATED_CONTEXT_ID);

    const remediationIds = execution.workingDefinition.tasks
      .filter((task) => task.id.includes("rejection"))
      .map((task) => task.id);
    expect(remediationIds).toEqual([
      `task-${GATED_CONTEXT_ID}-rejection-1`,
      `task-${GATED_CONTEXT_ID}-rejection-2`,
    ]);
    expect(new Set(remediationIds).size).toBe(2);

    const secondTask = execution.workingDefinition.tasks.find(
      (task) => task.id === `task-${GATED_CONTEXT_ID}-rejection-2`,
    );
    expect(secondTask?.order).toBe(3);
    expect(secondTask?.instructions).toContain("Second rejection feedback");
    expect(contextState.totalTaskCount).toBe(3);
  });

  it("throws when the recorded decision is approved", () => {
    const service = buildDraftService();
    const execution = buildExecutionWithDecision({
      type: "approved",
      decidedAt: NOW,
    });

    expect(() =>
      service.applyRejectedDecision(execution, GATED_CONTEXT_ID),
    ).toThrow(/approved/);
  });

  it("throws when no decision has been recorded", () => {
    const service = buildDraftService();
    const execution = buildExecution({});

    expect(() =>
      service.applyRejectedDecision(execution, GATED_CONTEXT_ID),
    ).toThrow(/no recorded decision/);
  });
});

describe("createApprovalGateService.buildRejectionRemediationTask", () => {
  it("embeds the operator message and uses the requested order", () => {
    const service = buildDraftService();

    const task = service.buildRejectionRemediationTask(
      GATED_CONTEXT_ID,
      "Rename the endpoint to /v2",
      ["task-implement-1"],
      4,
    );

    expect(task.id).toBe(`task-${GATED_CONTEXT_ID}-rejection-1`);
    expect(task.contextId).toBe(GATED_CONTEXT_ID);
    expect(task.order).toBe(4);
    expect(task.instructions).toContain("Rename the endpoint to /v2");
    expect(task.source).toBe("user");
  });

  it("skips ordinals already present in existing task ids", () => {
    const service = buildDraftService();

    const task = service.buildRejectionRemediationTask(
      GATED_CONTEXT_ID,
      "Third round of feedback",
      [
        "task-implement-1",
        `task-${GATED_CONTEXT_ID}-rejection-1`,
        `task-${GATED_CONTEXT_ID}-rejection-2`,
      ],
      4,
    );

    expect(task.id).toBe(`task-${GATED_CONTEXT_ID}-rejection-3`);
  });
});

describe("createApprovalGateService.recordDecision", () => {
  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  });

  afterEach(() => {
    fixture.close();
  });

  function buildService() {
    const repo = createGraphWorkflowExecutionRepository({
      // No git worktree in this harness; the real exclusion would shell out.
      ensureCcArtifactsExcluded: async () => {},
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      reserveActiveGraphWorkflowExecution:
        fixture.store.reserveActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,
      markGraphWorkflowContextEventsPreReset:
        fixture.store.markGraphWorkflowContextEventsPreReset,
      eventPublisher: createGraphWorkflowExecutionEventPublisher({
        broadcast: () => {},
        dispatchPush: () => {},
        now: () => NOW,
      }),
    });
    return createApprovalGateService({
      mutateActive: repo.mutateActive,
      now: () => NOW,
    });
  }

  async function seedExecution(execution: GraphWorkflowExecution | null) {
    // The fixture session starts with no active execution; "seeding null" means
    // leaving it that way (the executions table has no row for the session).
    if (execution === null) return;
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedExecution",
      () => ({ execution, events: [] }),
    );
  }

  async function reloadGatedContext() {
    const execution = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    const contextState = execution?.contextStates[GATED_CONTEXT_ID];
    if (!contextState) throw new Error("gated context missing after reload");
    return contextState;
  }

  it("returns no_active_execution when the session has no active execution", async () => {
    const service = buildService();
    await seedExecution(null);

    const result = await service.recordDecision({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: GATED_CONTEXT_ID,
      decision: { type: "approved" },
    });

    expect(result).toEqual({ ok: false, reason: "no_active_execution" });
  });

  it("rethrows store errors instead of masking them as no_active_execution", async () => {
    const service = buildService();
    await seedExecution(buildExecution({}));

    await expect(
      service.recordDecision({
        projectPath: PROJECT_PATH,
        sessionName: "session-unknown",
        contextId: GATED_CONTEXT_ID,
        decision: { type: "approved" },
      }),
    ).rejects.toThrow(/session-unknown/);
  });

  it.each(["aborted", "completed", "pending"] as const)(
    "returns execution_not_running when the execution is %s and leaves state unchanged",
    async (executionStatus) => {
      const service = buildService();
      await seedExecution(buildExecution({ executionStatus }));

      const result = await service.recordDecision({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        contextId: GATED_CONTEXT_ID,
        decision: { type: "approved" },
      });

      expect(result).toEqual({ ok: false, reason: "execution_not_running" });
      const reloaded = await reloadGatedContext();
      expect(reloaded.status).toBe("awaiting_approval");
      expect(reloaded.pendingApproval?.decision).toBeNull();
    },
  );

  it("returns not_awaiting_approval when the context is not parked", async () => {
    const service = buildService();
    await seedExecution(
      buildExecution({ contextStatus: "running", pendingApproval: null }),
    );

    const result = await service.recordDecision({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: GATED_CONTEXT_ID,
      decision: { type: "approved" },
    });

    expect(result).toEqual({ ok: false, reason: "not_awaiting_approval" });
  });

  it("returns not_awaiting_approval for an unknown context id", async () => {
    const service = buildService();
    await seedExecution(buildExecution({}));

    const result = await service.recordDecision({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: "context-missing",
      decision: { type: "approved" },
    });

    expect(result).toEqual({ ok: false, reason: "not_awaiting_approval" });
  });

  it("returns already_decided and preserves the original decision", async () => {
    const service = buildService();
    const priorDecision = {
      type: "rejected" as const,
      message: "Fix the tests",
      decidedAt: "2026-06-10T09:30:00.000Z",
    };
    await seedExecution(
      buildExecution({
        pendingApproval: {
          conversationId: CONVERSATION_ID,
          requestedAt: "2026-06-10T09:00:00.000Z",
          approvalScope: { kind: "whole_tree" },
          decision: priorDecision,
        },
      }),
    );

    const result = await service.recordDecision({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: GATED_CONTEXT_ID,
      decision: { type: "approved" },
    });

    expect(result).toEqual({ ok: false, reason: "already_decided" });
    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingApproval?.decision).toEqual(priorDecision);
  });

  it("records an approved decision while running and persists it through the store", async () => {
    const service = buildService();
    await seedExecution(buildExecution({}));

    const result = await service.recordDecision({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: GATED_CONTEXT_ID,
      decision: { type: "approved" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(
      result.execution.contextStates[GATED_CONTEXT_ID]?.pendingApproval
        ?.decision,
    ).toEqual({ type: "approved", decidedAt: NOW });

    const reloaded = await reloadGatedContext();
    expect(reloaded.status).toBe("awaiting_approval");
    expect(reloaded.pendingApproval).toEqual({
      conversationId: CONVERSATION_ID,
      requestedAt: "2026-06-10T09:00:00.000Z",
      decision: { type: "approved", decidedAt: NOW },
      approvalScope: { kind: "whole_tree" },
    });
  });

  it("keeps an owning member's frozen scoped snapshot across the decision round-trip", async () => {
    const service = buildService();
    const execution = buildExecution({});
    const contextState = execution.contextStates[GATED_CONTEXT_ID];
    if (!contextState?.pendingApproval) {
      throw new Error("fixture missing pending approval");
    }
    contextState.pendingApproval.approvalScope = { ...FROZEN_SCOPED_SCOPE };
    await seedExecution(execution);

    const result = await service.recordDecision({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: GATED_CONTEXT_ID,
      decision: { type: "approved" },
    });

    expect(result.ok).toBe(true);
    // Reloaded from SQLite: the reference the approval surface reads its bytes
    // through has to survive the process that froze it.
    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingApproval?.approvalScope).toEqual(
      FROZEN_SCOPED_SCOPE,
    );
  });

  it("records a rejected decision with its message", async () => {
    const service = buildService();
    await seedExecution(buildExecution({}));

    const result = await service.recordDecision({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: GATED_CONTEXT_ID,
      decision: { type: "rejected", message: "Wrong API shape, use v2" },
    });

    expect(result.ok).toBe(true);
    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingApproval?.decision).toEqual({
      type: "rejected",
      message: "Wrong API shape, use v2",
      decidedAt: NOW,
    });
  });

  it.each(["paused", "halted"] as const)(
    "records a decision while the execution is %s for deferred application",
    async (executionStatus) => {
      const service = buildService();
      await seedExecution(buildExecution({ executionStatus }));

      const result = await service.recordDecision({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        contextId: GATED_CONTEXT_ID,
        decision: { type: "rejected", message: "Needs another pass" },
      });

      expect(result.ok).toBe(true);
      const reloaded = await reloadGatedContext();
      expect(reloaded.status).toBe("awaiting_approval");
      expect(reloaded.pendingApproval?.decision).toEqual({
        type: "rejected",
        message: "Needs another pass",
        decidedAt: NOW,
      });
    },
  );

  it("applies only the first of two concurrent decisions", async () => {
    const service = buildService();
    await seedExecution(buildExecution({}));

    const [approveResult, rejectResult] = await Promise.all([
      service.recordDecision({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        contextId: GATED_CONTEXT_ID,
        decision: { type: "approved" },
      }),
      service.recordDecision({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        contextId: GATED_CONTEXT_ID,
        decision: { type: "rejected", message: "Hold on" },
      }),
    ]);

    const results = [approveResult, rejectResult];
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toEqual([{ ok: false, reason: "already_decided" }]);

    const reloaded = await reloadGatedContext();
    const winner = winners[0];
    if (!winner || !winner.ok) throw new Error("expected a winning decision");
    const winningType =
      winner.execution.contextStates[GATED_CONTEXT_ID]?.pendingApproval
        ?.decision?.type;
    expect(reloaded.pendingApproval?.decision?.type).toBe(winningType);
  });
});
