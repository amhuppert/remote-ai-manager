import { describe, expect, it } from "vitest";
import { changed } from "./execution-mutation";

import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";

import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
} from "@/lib/workflow-graph/test-fixtures";
import {
  _resetRegistryForTesting,
  registerExecutionLogger,
  unregisterExecutionLogger,
  type ExecutionLogger,
} from "@/lib/workflow-graph/execution-logger";
import type {
  DisposeInput,
  DisposeResult,
  ParallelWorktrees,
  ProvisionInput,
  ProvisionLaneInput,
  ProvisionResult,
} from "@/lib/workflow-graph/parallel-worktrees";

import {
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
} from "@/lib/workflow-graph/lane-identity";

import { type ScheduleEligibleContextsResult } from "@/lib/workflow-graph/context-scheduler";

import { runWithLoopFence, StaleLoopFenceError } from "./loop-fence";

import {
  createContextScheduler,
  scheduleNextContext,
} from "./context-scheduler";
import {
  createRepository,
  sharedLaneDefinition,
  withContextsOnLane,
  inflatePrePlacement,
  renameContext,
  renameContextState,
} from "./testing/manager-scheduler-fixture";
it("schedules the first runnable context and keeps other eligible contexts ready", async () => {
  const branchedDefinition = createResolvedWorkflowDefinition({
    edges: [
      {
        id: "edge-plan-implement",
        sourceContextId: "context-plan",
        targetContextId: "context-implement",
      },
      {
        id: "edge-plan-verify",
        sourceContextId: "context-plan",
        targetContextId: "context-verify",
      },
    ],
  });

  const baseExecution = createWorkflowExecution({
    workingDefinition: branchedDefinition,
  });
  const repository = createRepository(
    createWorkflowExecution({
      ...baseExecution,
      status: "running",
      workingDefinition: branchedDefinition,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          iterationCount: 1,
        },
      },
    }),
  );

  const scheduler = { executionRepository: repository };

  const execution = await scheduleNextContext(scheduler, "/repo", "session-1");

  expect(execution.activeContextIds).toEqual(["context-implement"]);
  expect(execution.contextStates["context-implement"]?.status).toBe("running");
  expect(execution.contextStates["context-verify"]?.status).toBe("ready");
  expect(execution.machineSnapshot).toEqual({
    schemaVersion: 1,
    lifecycleStatus: "running",
    activeContextId: "context-implement",
    recoveryMode: "none",
    hasLiveIteration: false,
  });
});
it("preserves an existing conversation when rescheduling its execution context", async () => {
  const baseExecution = createWorkflowExecution({
    status: "running",
    activeContextIds: [],
    laneStates: {
      "context-implement": {
        implementer: {
          backend: "claude",
          lane: "implementer",
          contextId: "context-implement",
          workflowConversationId: "conv-old",
          metrics: {
            contextTokens: 50_000,
            contextWindowMax: 200_000,
          },
          lastUsedAt: "2026-03-27T15:00:00.000Z",
        },
      },
    },
    contextStates: {
      "context-plan": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "context-plan",
        status: "completed",
        totalTaskCount: 1,
        completedTaskCount: 1,
        iterationCount: 1,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
      "context-implement": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "context-implement",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
      "context-verify": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "context-verify",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
    },
  });

  const repository = createRepository(baseExecution);
  const scheduler = { executionRepository: repository };

  const execution = await scheduleNextContext(scheduler, "/repo", "session-1");

  expect(execution.laneStates).toEqual(baseExecution.laneStates);
});
it("refuses to dispatch a worktree context without an assigned lane", async () => {
  const base = createWorkflowExecution();
  const repository = createRepository(
    createWorkflowExecution({
      ...base,
      status: "running",
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "ready",
          isolation: "worktree",
          laneId: null,
        },
      },
    }),
  );

  await expect(
    scheduleNextContext(
      { executionRepository: repository },
      "/repo",
      "session-1",
    ),
  ).rejects.toThrow('Worktree context "context-plan" has no assigned lane');
});

describe("scheduleEligibleContexts", () => {
  function createSession(overrides: Partial<SessionState> = {}): SessionState {
    return {
      sessionName: "session-1",
      worktreePath: "/repo/.worktrees/feature-abc",
      branchName: "csm/feature-abc",
      createdAt: "2026-03-27T15:00:00.000Z",
      lastActivityAt: "2026-03-27T15:00:00.000Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "cc",
      creationMode: "normal",
      tddEnabled: true,
      targetBranch: "main",
      parentSessionName: null,
      graphWorkflowExecution: null,
      referenceDocuments: [],
      ...overrides,
    };
  }

  type ProvisionCall = ProvisionInput;

  function createParallelWorktreesStub(options?: {
    failOnContextId?: string;
    failureMessage?: string;
    // Branch names whose `disposeLane` rejects — used to prove best-effort
    // disposal (every lane is still attempted) and that reservation release
    // still runs after a disposal failure.
    failDisposeBranchNames?: readonly string[];
    // Runs after each provision is recorded — used to simulate a concurrent
    // supersession (e.g. a resume bumping loopEpoch) while the slow worktree
    // work is in flight, out of the write lock.
    onProvision?: (input: ProvisionInput) => void | Promise<void>;
  }): ParallelWorktrees & {
    provisionCalls: ProvisionCall[];
    disposeCalls: DisposeInput[];
  } {
    const provisionCalls: ProvisionCall[] = [];
    const disposeCalls: DisposeInput[] = [];

    async function provision(input: ProvisionInput): Promise<ProvisionResult> {
      provisionCalls.push(input);
      if (options?.onProvision) {
        await options.onProvision(input);
      }
      if (
        options?.failOnContextId &&
        input.contextId === options.failOnContextId
      ) {
        throw new Error(options.failureMessage ?? "provision failed");
      }
      return {
        worktreePath: `${input.projectPath}/.worktrees/${input.sessionDir}.${input.contextId}`,
        branchName: `csm/${input.sessionDir}-${input.contextId}`,
      };
    }

    async function provisionBatch(
      inputs: ProvisionInput[],
    ): Promise<ProvisionResult[]> {
      const results: ProvisionResult[] = [];
      const created: ProvisionInput[] = [];
      try {
        for (const input of inputs) {
          const result = await provision(input);
          results.push(result);
          created.push(input);
        }
        return results;
      } catch (err) {
        for (const input of created) {
          await dispose({
            projectPath: input.projectPath,
            worktreePath: `${input.projectPath}/.worktrees/${input.sessionDir}.${input.contextId}`,
            branchName: `csm/${input.sessionDir}-${input.contextId}`,
          });
        }
        throw err;
      }
    }

    async function dispose(input: DisposeInput): Promise<DisposeResult> {
      // Record the attempt BEFORE any rejection so `disposeCalls` proves the
      // lane was attempted even when disposal fails.
      disposeCalls.push(input);
      if (options?.failDisposeBranchNames?.includes(input.branchName)) {
        throw new Error(`dispose failed for ${input.branchName}`);
      }
      return { status: "removed" };
    }

    async function provisionLane(
      input: ProvisionLaneInput,
    ): Promise<ProvisionResult> {
      return provision({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        sessionDir: input.sessionDir,
        sessionBranch: input.sessionBranch,
        contextId: input.laneId,
      });
    }

    async function provisionLaneBatch(
      inputs: ProvisionLaneInput[],
    ): Promise<ProvisionResult[]> {
      return provisionBatch(
        inputs.map((input) => ({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          sessionDir: input.sessionDir,
          sessionBranch: input.sessionBranch,
          contextId: input.laneId,
        })),
      );
    }

    async function disposeLane(input: DisposeInput): Promise<DisposeResult> {
      return dispose(input);
    }

    async function cleanupLane(): Promise<DisposeResult> {
      return { status: "removed" };
    }

    return {
      provision,
      provisionBatch,
      dispose,
      provisionLane,
      provisionLaneBatch,
      disposeLane,
      cleanupLane,
      provisionCalls,
      disposeCalls,
    };
  }

  it("returns kind 'none' when no contexts are eligible", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: [],
        contextStates: {
          "context-plan": {
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-plan",
            status: "completed",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-implement": {
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-implement",
            status: "completed",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-verify": {
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-verify",
            status: "completed",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled).toEqual({ kind: "none" });
    expect(result.execution.activeContextIds).toEqual([]);
    expect(parallelWorktrees.provisionCalls).toEqual([]);
  });

  it("schedules a context authored onto the session lane inside the session worktree without a sub-worktree", async () => {
    // The session lane IS the session worktree: it is never provisioned and
    // never lands through a join, which is why only a read-only context may
    // be authored onto it. A group lane, by contrast, always costs a worktree.
    const sessionLaneDefinition = createResolvedWorkflowDefinition();
    const baseExecution = createWorkflowExecution({
      workingDefinition: {
        ...sessionLaneDefinition,
        executionContexts: sessionLaneDefinition.executionContexts.map(
          (context) =>
            context.id === "context-plan"
              ? {
                  ...context,
                  placement: { lane: SESSION_LANE_NAME, mode: "readOnly" },
                  outputSchema: {
                    type: "object" as const,
                    properties: { plan: { type: "string" as const } },
                  },
                }
              : context,
        ),
      },
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled).toEqual({
      kind: "solo",
      contextId: "context-plan",
    });
    expect(result.execution.activeContextIds).toEqual(["context-plan"]);
    const planState = result.execution.contextStates["context-plan"];
    expect(planState?.status).toBe("running");
    expect(planState?.isolation).toBe("session");
    expect(planState?.worktreePath).toBeNull();
    expect(planState?.branchName).toBeNull();
    expect(planState?.batchId).toBeNull();
    expect(planState?.laneId).toBeNull();
    expect(planState?.landingIntent).toBeNull();
    expect(result.execution.executionLanes[SESSION_LANE_ID]).toBeUndefined();
    expect(parallelWorktrees.provisionCalls).toEqual([]);
  });

  it("forces worktree isolation for a single eligible context when another worktree-isolated context is still running", async () => {
    const noEdgeDefinition = createResolvedWorkflowDefinition({ edges: [] });
    const baseExecution = createWorkflowExecution({
      workingDefinition: noEdgeDefinition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: noEdgeDefinition,
        activeContextIds: ["context-implement"],
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            completedTaskCount: 1,
            iterationCount: 1,
          },
          "context-implement": {
            ...baseExecution.contextStates["context-implement"]!,
            status: "running",
            isolation: "worktree",
            worktreePath: "/repo/.worktrees/feature-abc.context-implement",
            branchName: "csm/feature-abc-context-implement",
            batchId: "batch-prior",
            iterationCount: 1,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled.kind).toBe("parallel");
    if (result.scheduled.kind !== "parallel") return;
    expect(result.scheduled.contextIds).toEqual(["context-verify"]);

    const verifyState = result.execution.contextStates["context-verify"];
    expect(verifyState?.status).toBe("running");
    expect(verifyState?.isolation).toBe("worktree");
    expect(verifyState?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.verify",
    );
    expect(verifyState?.branchName).toBe("csm/feature-abc-verify");
    expect(verifyState?.batchId).toBe(result.scheduled.batchId);

    expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
      "verify",
    ]);

    const implState = result.execution.contextStates["context-implement"];
    expect(implState?.isolation).toBe("worktree");
    expect(implState?.status).toBe("running");
  });

  it("forces worktree isolation for a single eligible context while a worktree-isolated sibling still has an unpublished merge in progress", async () => {
    const noEdgeDefinition = createResolvedWorkflowDefinition({ edges: [] });
    const baseExecution = createWorkflowExecution({
      workingDefinition: noEdgeDefinition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: noEdgeDefinition,
        activeContextIds: ["context-implement"],
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            completedTaskCount: 1,
            iterationCount: 1,
          },
          "context-implement": {
            ...baseExecution.contextStates["context-implement"]!,
            status: "completed",
            isolation: "worktree",
            worktreePath: "/repo/.worktrees/feature-abc.context-implement",
            branchName: "csm/feature-abc-context-implement",
            batchId: "batch-prior",
            mergeStatus: "in-progress",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled.kind).toBe("parallel");
    if (result.scheduled.kind !== "parallel") return;
    expect(result.scheduled.contextIds).toEqual(["context-verify"]);

    const verifyState = result.execution.contextStates["context-verify"];
    expect(verifyState?.status).toBe("running");
    expect(verifyState?.isolation).toBe("worktree");
    expect(verifyState?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.verify",
    );

    expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
      "verify",
    ]);
  });

  it("forces worktree isolation for a single eligible context while a worktree-isolated sibling has completed iteration but its merge is still queued behind the mutex", async () => {
    const noEdgeDefinition = createResolvedWorkflowDefinition({ edges: [] });
    const baseExecution = createWorkflowExecution({
      workingDefinition: noEdgeDefinition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: noEdgeDefinition,
        activeContextIds: ["context-implement"],
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            completedTaskCount: 1,
            iterationCount: 1,
          },
          "context-implement": {
            ...baseExecution.contextStates["context-implement"]!,
            status: "completed",
            isolation: "worktree",
            worktreePath: "/repo/.worktrees/feature-abc.context-implement",
            branchName: "csm/feature-abc-context-implement",
            batchId: "batch-prior",
            mergeStatus: "not-applicable",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled.kind).toBe("parallel");
    if (result.scheduled.kind !== "parallel") return;
    expect(result.scheduled.contextIds).toEqual(["context-verify"]);

    const verifyState = result.execution.contextStates["context-verify"];
    expect(verifyState?.status).toBe("running");
    expect(verifyState?.isolation).toBe("worktree");
    expect(verifyState?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.verify",
    );

    expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
      "verify",
    ]);
  });

  it("returns 'none' and does not mark any context running when the persisted execution already has pendingHaltReason", async () => {
    const haltReason: GraphWorkflowHaltReason = {
      type: "merge_failure",
      contextId: "context-implement",
      message: "concurrent sibling failed",
      conflictFiles: [],
    };
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        pendingHaltReason: haltReason,
        activeContextIds: ["context-implement"],
        contextStates: {
          ...baseExecution.contextStates,
          "context-implement": {
            ...baseExecution.contextStates["context-implement"]!,
            status: "running",
            isolation: "worktree",
            worktreePath: "/repo/.worktrees/feature-abc.context-implement",
            branchName: "csm/feature-abc-context-implement",
            batchId: "batch-prior",
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled).toEqual({ kind: "none" });
    expect(result.execution.pendingHaltReason).toEqual(haltReason);

    const planState = result.execution.contextStates["context-plan"];
    expect(planState?.status).toBe("pending");
    expect(planState?.isolation).toBe("session");
    expect(planState?.worktreePath).toBeNull();
    expect(planState?.branchName).toBeNull();
    expect(planState?.batchId).toBeNull();

    const verifyState = result.execution.contextStates["context-verify"];
    expect(verifyState?.status).toBe("pending");
    expect(verifyState?.isolation).toBe("session");

    expect(result.execution.activeContextIds).toEqual(["context-implement"]);
    expect(parallelWorktrees.provisionCalls).toEqual([]);
  });

  it("does not double-provision reserved contexts when a concurrent same-epoch scheduler runs during provisioning", async () => {
    // Owner-discriminated reservation (Design 3.1): the reserve mutation stamps
    // each claimed context before provisioning worktrees out of the lock. A
    // second scheduler running in that window must see the stamped contexts as
    // ineligible, so it schedules and provisions nothing — the batch is
    // provisioned exactly once.
    const branchedDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });
    const baseExecution = createWorkflowExecution({
      workingDefinition: branchedDefinition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: branchedDefinition,
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );

    // Boxed so the value assigned inside the `onProvision` callback keeps its
    // declared union type when read after the await (closure-assignment CFA):
    // a bare `let` would be narrowed to its `null` initializer at the read
    // site, collapsing the post-null-guard type to `never`.
    const concurrentResult: { value: ScheduleEligibleContextsResult | null } = {
      value: null,
    };
    let ranConcurrent = false;
    // Indirection so the stub can reach the scheduler without referencing it
    // before its declaration; wired after the scheduler is built.
    let onFirstProvision: (() => Promise<void>) | null = null;
    const parallelWorktrees = createParallelWorktreesStub({
      // Fire ONE concurrent scheduler while the first pass is provisioning out
      // of the lock (both reservations are already committed by then).
      async onProvision() {
        if (ranConcurrent) return;
        ranConcurrent = true;
        if (onFirstProvision) await onFirstProvision();
      },
    });

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    onFirstProvision = async () => {
      concurrentResult.value = await scheduler.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });
    };

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    // The first pass provisioned each eligible context exactly once.
    expect(result.scheduled.kind).toBe("parallel");
    expect(
      parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
    ).toEqual(["implement", "verify"]);

    // The concurrent scheduler saw both contexts as reserved → nothing to
    // schedule, and it provisioned nothing (no double-provision).
    expect(ranConcurrent).toBe(true);
    const captured = concurrentResult.value;
    if (captured === null) {
      throw new Error("concurrent scheduler did not run");
    }
    expect(captured.scheduled).toEqual({ kind: "none" });

    // Reservation stamps are cleared once the finalize commits.
    expect(
      result.execution.contextStates["context-implement"]?.reservedByBatchId ??
        null,
    ).toBeNull();
    expect(
      result.execution.contextStates["context-verify"]?.reservedByBatchId ??
        null,
    ).toBeNull();
  });

  it("releases the reserve's stamps (contexts stay eligible) when getSession fails after the reserve commits", async () => {
    // Reservation-stranding guard (Design 3.1): the reserve mutation stamps
    // `reservedByBatchId` and commits BEFORE resolving the session out of the
    // lock. If that lookup then rejects, every post-reserve failure path must
    // release the stamps — otherwise the contexts are ineligible for a
    // same-epoch retry forever. This drives a `getSession` rejection after the
    // reserve and asserts the stamps are cleared AND a retry schedules them.
    const branchedDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });
    const baseExecution = createWorkflowExecution({
      workingDefinition: branchedDefinition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: branchedDefinition,
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );

    const parallelWorktrees = createParallelWorktreesStub();

    // getSession rejects on the FIRST scheduling pass (after the reserve
    // commits), then succeeds on the retry.
    let sessionCalls = 0;
    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        sessionCalls += 1;
        if (sessionCalls === 1) {
          throw new Error("session lookup failed");
        }
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    // First pass: reserve commits, then getSession rejects → the call rejects.
    await expect(
      scheduler.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      }),
    ).rejects.toThrow("session lookup failed");

    // Nothing was provisioned, and the reserve's stamps were released — the
    // contexts are not stranded ineligible.
    expect(parallelWorktrees.provisionCalls).toEqual([]);
    const afterFailure = repository.read();
    expect(
      afterFailure?.contextStates["context-implement"]?.reservedByBatchId ??
        null,
    ).toBeNull();
    expect(
      afterFailure?.contextStates["context-verify"]?.reservedByBatchId ?? null,
    ).toBeNull();

    // A same-epoch retry now schedules both contexts, proving they stayed
    // eligible after the release.
    const retry = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });
    expect(retry.scheduled.kind).toBe("parallel");
    expect(
      parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
    ).toEqual(["implement", "verify"]);
  });

  it("provisions a worktree per eligible context and assigns a shared batchId when ≥2 are eligible", async () => {
    const branchedDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });
    const baseExecution = createWorkflowExecution({
      workingDefinition: branchedDefinition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: branchedDefinition,
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled.kind).toBe("parallel");
    if (result.scheduled.kind !== "parallel") return;
    expect(result.scheduled.contextIds.sort()).toEqual([
      "context-implement",
      "context-verify",
    ]);
    expect(typeof result.scheduled.batchId).toBe("string");
    expect(result.scheduled.batchId.length).toBeGreaterThan(0);
    expect(result.execution.activeContextIds.sort()).toEqual([
      "context-implement",
      "context-verify",
    ]);

    const implState = result.execution.contextStates["context-implement"];
    expect(implState?.status).toBe("running");
    expect(implState?.isolation).toBe("worktree");
    expect(implState?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.implement",
    );
    expect(implState?.branchName).toBe("csm/feature-abc-implement");
    expect(implState?.batchId).toBe(result.scheduled.batchId);

    const verifyState = result.execution.contextStates["context-verify"];
    expect(verifyState?.status).toBe("running");
    expect(verifyState?.isolation).toBe("worktree");
    expect(verifyState?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.verify",
    );
    expect(verifyState?.branchName).toBe("csm/feature-abc-verify");
    expect(verifyState?.batchId).toBe(result.scheduled.batchId);

    // Every provisioned worktree is a lane — terminal contexts included —
    // so their work publishes through the gated final_publish join instead
    // of the legacy laneId-null fan-in that bypasses the delivery gate.
    expect(implState?.laneId).toBe("implement");
    expect(verifyState?.laneId).toBe("verify");
    expect(result.execution.executionLanes["implement"]?.kind).toBe("worktree");
    expect(result.execution.executionLanes["verify"]?.kind).toBe("worktree");

    expect(
      parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
    ).toEqual(["implement", "verify"]);
    expect(parallelWorktrees.disposeCalls).toEqual([]);
  });

  it("rolls back already-provisioned worktrees when a later worktree fails to provision", async () => {
    const branchedDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });
    const baseExecution = createWorkflowExecution({
      workingDefinition: branchedDefinition,
    });
    const initialExecution = createWorkflowExecution({
      ...baseExecution,
      status: "running",
      workingDefinition: branchedDefinition,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          iterationCount: 1,
        },
      },
    });
    const repository = createRepository(initialExecution);
    const parallelWorktrees = createParallelWorktreesStub({
      failOnContextId: "verify",
      failureMessage: "disk full",
    });

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    await expect(
      scheduler.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      }),
    ).rejects.toThrow(/disk full/);

    expect(parallelWorktrees.disposeCalls.map((c) => c.branchName)).toEqual([
      "csm/feature-abc-implement",
    ]);

    const persisted = repository.read();
    expect(persisted?.activeContextIds).toEqual([]);
    expect(persisted?.contextStates["context-implement"]?.status).not.toBe(
      "running",
    );
    expect(persisted?.contextStates["context-verify"]?.status).not.toBe(
      "running",
    );
  });

  it("owner-checks the reserve release and surfaces the provision error even when compensating disposal rejects", async () => {
    // Compensation reliability (Design 3.1 finalize-or-compensate). When
    // provisioning fails, the catch disposes the already-provisioned lanes
    // AND releases the reserve's stamps. Here the compensating `disposeLane`
    // REJECTS — the release must still run (else the contexts strand
    // ineligible), the ORIGINAL provision error (not the disposal error) must
    // surface, and the release is OWNER-CHECKED so a stamp a concurrent
    // same-epoch batch re-owns is left intact.
    const branchedDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });
    const baseExecution = createWorkflowExecution({
      workingDefinition: branchedDefinition,
    });
    const initialExecution = createWorkflowExecution({
      ...baseExecution,
      status: "running",
      workingDefinition: branchedDefinition,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          iterationCount: 1,
        },
      },
    });
    const repository = createRepository(initialExecution);

    // context-implement provisions first (success); while it is in flight,
    // simulate a concurrent same-epoch batch re-reserving context-verify by
    // stamping it with a DIFFERENT batchId. context-verify's own provision
    // then fails, triggering compensation. The loop generation is NOT bumped,
    // so the release commits (it is not fenced out).
    const parallelWorktrees = createParallelWorktreesStub({
      failOnContextId: "verify",
      failureMessage: "disk full",
      failDisposeBranchNames: ["csm/feature-abc-implement"],
      async onProvision(input) {
        if (input.contextId !== "implement") return;
        const persisted = repository.read();
        if (!persisted) return;
        const ownBatchId =
          persisted.contextStates["context-implement"]?.reservedByBatchId ??
          "batch";
        await repository.update("/repo", "session-1", {
          ...persisted,
          contextStates: {
            ...persisted.contextStates,
            "context-verify": {
              ...persisted.contextStates["context-verify"]!,
              reservedByBatchId: `${ownBatchId}-foreign`,
            },
          },
        });
      },
    });

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    // The ORIGINAL provision error surfaces — not the disposal rejection.
    await expect(
      scheduler.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      }),
    ).rejects.toThrow(/disk full/);

    // The failing disposal was still ATTEMPTED (best-effort).
    expect(parallelWorktrees.disposeCalls.map((c) => c.branchName)).toEqual([
      "csm/feature-abc-implement",
    ]);

    const persisted = repository.read();
    // Owner-checked release ran despite the disposal rejection: this batch's
    // own stamp (context-implement) is cleared so it re-schedules...
    expect(
      persisted?.contextStates["context-implement"]?.reservedByBatchId ?? null,
    ).toBeNull();
    // ...but the foreign batch's stamp on context-verify is left intact.
    expect(
      persisted?.contextStates["context-verify"]?.reservedByBatchId,
    ).toMatch(/-foreign$/);
  });

  it("refuses the fenced finalize and disposes provisioned worktrees when the loop generation is superseded mid-provision", async () => {
    // Two eligible contexts route through the staged protocol: reserve marks
    // them ready, provisioning runs out of the lock, then a fenced finalize
    // commits the batch. This test supersedes the loop generation while the
    // slow provisioning is in flight and asserts the finalize refuses to
    // commit and disposes the orphaned worktrees.
    const branchedDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });
    const baseExecution = createWorkflowExecution({
      workingDefinition: branchedDefinition,
    });
    const initialExecution = createWorkflowExecution({
      ...baseExecution,
      status: "running",
      workingDefinition: branchedDefinition,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          iterationCount: 1,
        },
      },
    });
    const repository = createRepository(initialExecution);
    const executionId = initialExecution.id;

    // The first provision simulates a concurrent resume superseding this
    // generation: it bumps the persisted loopEpoch out from under the
    // in-flight schedule, out of the write lock.
    const parallelWorktrees = createParallelWorktreesStub({
      async onProvision() {
        const persisted = repository.read();
        if (persisted && persisted.loopEpoch === 0) {
          await repository.update("/repo", "session-1", {
            ...persisted,
            loopEpoch: 1,
          });
        }
      },
    });

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    await expect(
      runWithLoopFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId,
          loopEpoch: 0,
        },
        () =>
          scheduler.scheduleEligibleContexts({
            projectPath: "/repo",
            sessionName: "session-1",
          }),
      ),
    ).rejects.toBeInstanceOf(StaleLoopFenceError);

    // Both worktrees were provisioned out of the lock, then the fenced
    // finalize refused to commit and disposed them as compensation.
    expect(
      parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
    ).toEqual(["implement", "verify"]);
    expect(
      parallelWorktrees.disposeCalls.map((c) => c.branchName).sort(),
    ).toEqual(["csm/feature-abc-implement", "csm/feature-abc-verify"]);

    // The superseded generation committed no running/lane state for the batch.
    const persisted = repository.read();
    expect(persisted?.loopEpoch).toBe(1);
    expect(persisted?.contextStates["context-implement"]?.status).not.toBe(
      "running",
    );
    expect(persisted?.contextStates["context-verify"]?.status).not.toBe(
      "running",
    );
  });

  it("attempts every lane's disposal (best-effort) and surfaces the fence error when a compensating disposal rejects", async () => {
    // Best-effort disposal (Design 3.1). Two lanes provision out of the lock,
    // then a concurrent resume supersedes the generation so the fenced
    // finalize refuses and disposes both lanes as compensation. Disposing the
    // FIRST lane rejects — the second lane must still be attempted, and the
    // original StaleLoopFenceError (not the disposal error) must surface.
    const branchedDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });
    const baseExecution = createWorkflowExecution({
      workingDefinition: branchedDefinition,
    });
    const initialExecution = createWorkflowExecution({
      ...baseExecution,
      status: "running",
      workingDefinition: branchedDefinition,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          iterationCount: 1,
        },
      },
    });
    const repository = createRepository(initialExecution);
    const executionId = initialExecution.id;

    const parallelWorktrees = createParallelWorktreesStub({
      // BOTH lanes' disposal rejects; the first rejection must not abort the
      // second attempt.
      failDisposeBranchNames: [
        "csm/feature-abc-implement",
        "csm/feature-abc-verify",
      ],
      async onProvision() {
        const persisted = repository.read();
        if (persisted && persisted.loopEpoch === 0) {
          await repository.update("/repo", "session-1", {
            ...persisted,
            loopEpoch: 1,
          });
        }
      },
    });

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    // The fenced finalize's StaleLoopFenceError surfaces — not the disposal
    // rejection that happened during compensation.
    await expect(
      runWithLoopFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId,
          loopEpoch: 0,
        },
        () =>
          scheduler.scheduleEligibleContexts({
            projectPath: "/repo",
            sessionName: "session-1",
          }),
      ),
    ).rejects.toBeInstanceOf(StaleLoopFenceError);

    // Both lanes were attempted for disposal even though the first rejected —
    // disposal is best-effort across every lane.
    expect(
      parallelWorktrees.disposeCalls.map((c) => c.branchName).sort(),
    ).toEqual(["csm/feature-abc-implement", "csm/feature-abc-verify"]);
  });

  it("rejects scheduling before any worktree is created when a contextId is unsafe", async () => {
    const unsafeDefinition = createResolvedWorkflowDefinition({
      executionContexts: [
        {
          placement: { lane: "context-plan", mode: "full" as const },
          id: "context-plan",
          title: "Plan",
          acceptanceCriteria: "Plan complete",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            profileSnapshot: makeProfileSnapshot(),
            agent: {
              backend: "claude",
              modelSelection: {
                modelId: "opus",
                parameters: { effort: "medium" },
              },
            },
          },
          contextValidator: { enabled: false, assignments: [] },
          scriptValidator: { commands: [] },
          humanApprovalGate: { enabled: false },
          askUserQuestions: { enabled: false },
          mutability: {
            allowAgentTaskAdd: false,
            allowAgentContextAdd: false,
          },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 4,
          },
          planRepair: { enabled: true, maxAttemptsPerContext: 2 },
        },
        {
          placement: { lane: "..escape", mode: "full" as const },
          id: "..escape",
          title: "Bad",
          acceptanceCriteria: "n/a",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            profileSnapshot: makeProfileSnapshot(),
            agent: {
              backend: "claude",
              modelSelection: {
                modelId: "opus",
                parameters: { effort: "medium" },
              },
            },
          },
          contextValidator: { enabled: false, assignments: [] },
          scriptValidator: { commands: [] },
          humanApprovalGate: { enabled: false },
          askUserQuestions: { enabled: false },
          mutability: {
            allowAgentTaskAdd: false,
            allowAgentContextAdd: false,
          },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 4,
          },
          planRepair: { enabled: true, maxAttemptsPerContext: 2 },
        },
        {
          placement: { lane: "context-other", mode: "full" as const },
          id: "context-other",
          title: "Other",
          acceptanceCriteria: "n/a",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            profileSnapshot: makeProfileSnapshot(),
            agent: {
              backend: "claude",
              modelSelection: {
                modelId: "opus",
                parameters: { effort: "medium" },
              },
            },
          },
          contextValidator: { enabled: false, assignments: [] },
          scriptValidator: { commands: [] },
          humanApprovalGate: { enabled: false },
          askUserQuestions: { enabled: false },
          mutability: {
            allowAgentTaskAdd: false,
            allowAgentContextAdd: false,
          },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 4,
          },
          planRepair: { enabled: true, maxAttemptsPerContext: 2 },
        },
      ],
      tasks: [
        {
          id: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          title: "Plan",
          instructions: "Plan",
          source: "user",
        },
        {
          id: "task-bad-1",
          contextId: "..escape",
          order: 1,
          title: "Bad",
          instructions: "Bad",
          source: "user",
        },
        {
          id: "task-other-1",
          contextId: "context-other",
          order: 1,
          title: "Other",
          instructions: "Other",
          source: "user",
        },
      ],
      edges: [
        {
          id: "edge-plan-bad",
          sourceContextId: "context-plan",
          targetContextId: "..escape",
        },
        {
          id: "edge-plan-other",
          sourceContextId: "context-plan",
          targetContextId: "context-other",
        },
      ],
    });
    const repository = createRepository(
      createWorkflowExecution({
        workingDefinition: unsafeDefinition,
        status: "running",
        activeContextIds: [],
        contextStates: {
          "context-plan": {
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-plan",
            status: "completed",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "..escape": {
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "..escape",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-other": {
            skipReason: null,
            landingIntent: null,
            pendingApproval: null,
            pendingUserInputs: {},
            contextId: "context-other",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            consecutiveCandidateMismatchCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            laneId: null,
            joinId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "completed",
            summary: "ok",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:01:00.000Z",
            lastConversationId: "c1",
            failureMessage: null,
            failureHistory: [],
          },
          "task-bad-1": {
            taskId: "task-bad-1",
            contextId: "..escape",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
          "task-other-1": {
            taskId: "task-other-1",
            contextId: "context-other",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    await expect(
      scheduler.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      }),
    ).rejects.toThrow(/laneId/i);

    expect(parallelWorktrees.provisionCalls).toEqual([]);
    expect(parallelWorktrees.disposeCalls).toEqual([]);
  });

  it("does not schedule contexts whose dependencies are unsatisfied while another context is running", async () => {
    const branchedDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-implement-verify",
          sourceContextId: "context-implement",
          targetContextId: "context-verify",
        },
      ],
    });
    const baseExecution = createWorkflowExecution({
      workingDefinition: branchedDefinition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: branchedDefinition,
        activeContextIds: ["context-implement"],
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            completedTaskCount: 1,
            iterationCount: 1,
          },
          "context-implement": {
            ...baseExecution.contextStates["context-implement"]!,
            status: "running",
            iterationCount: 1,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled).toEqual({ kind: "none" });
    expect(parallelWorktrees.provisionCalls).toEqual([]);
    expect(result.execution.contextStates["context-verify"]?.status).toBe(
      "pending",
    );
    expect(result.execution.activeContextIds).toEqual(["context-implement"]);
  });

  it("reuses the upstream's lane (no provisioning) when its output is lane-committed and downstream is placed on that lane", async () => {
    const lane = {
      laneId: "lane-plan",
      kind: "worktree" as const,
      status: "active" as const,
      worktreePath: "/repo/.worktrees/feature-abc.lane-plan",
      branchName: "csm/feature-abc-lane-plan",
      includedContextIds: ["context-plan"],
      lastCommittingContextId: "context-plan",
      commitSnapshots: [],
      createdAt: "2026-03-27T15:00:00.000Z",
      updatedAt: "2026-03-27T15:00:00.000Z",
    };
    const baseExecution = createWorkflowExecution({
      workingDefinition: withContextsOnLane(
        createResolvedWorkflowDefinition(),
        "lane-plan",
        ["context-plan", "context-implement"],
      ),
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        executionLanes: { "lane-plan": lane },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            isolation: "worktree",
            laneId: "lane-plan",
            worktreePath: lane.worktreePath,
            branchName: lane.branchName,
            mergeStatus: "merged-success",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled.kind).toBe("parallel");
    if (result.scheduled.kind !== "parallel") return;
    expect(result.scheduled.contextIds).toEqual(["context-implement"]);

    const implState = result.execution.contextStates["context-implement"];
    expect(implState?.status).toBe("running");
    expect(implState?.laneId).toBe("lane-plan");
    expect(implState?.isolation).toBe("worktree");
    expect(implState?.worktreePath).toBe(lane.worktreePath);
    expect(implState?.branchName).toBe(lane.branchName);

    expect(parallelWorktrees.provisionCalls).toEqual([]);
  });

  it.each([false, true])(
    "forks the authored lane with the captured converged membership (parent advances=%s)",
    async (parentAdvances) => {
      // Authored placement is the only lane authority: the converged lane is
      // the fork BASE that carries both upstreams' work, never the destination.
      const branchedDefinition = createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
          {
            id: "edge-implement-verify",
            sourceContextId: "context-implement",
            targetContextId: "context-verify",
          },
        ],
      });
      const laneA = {
        laneId: "lane-a",
        kind: "worktree" as const,
        status: "merged" as const,
        worktreePath: "/repo/.worktrees/feature-abc.lane-a",
        branchName: "csm/feature-abc-lane-a",
        includedContextIds: ["context-plan", "context-earlier-pass"],
        lastCommittingContextId: "context-plan",
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const laneB = {
        laneId: "lane-b",
        kind: "worktree" as const,
        status: "merged" as const,
        worktreePath: "/repo/.worktrees/feature-abc.lane-b",
        branchName: "csm/feature-abc-lane-b",
        includedContextIds: ["context-implement"],
        lastCommittingContextId: "context-implement",
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const laneTarget = {
        laneId: "lane-target",
        kind: "worktree" as const,
        status: "active" as const,
        worktreePath: "/repo/.worktrees/feature-abc.lane-target",
        branchName: "csm/feature-abc-lane-target",
        includedContextIds: ["context-plan", "context-implement"],
        lastCommittingContextId: null,
        commitSnapshots: [],
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
      };
      const baseExecution = createWorkflowExecution({
        workingDefinition: branchedDefinition,
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          status: "running",
          workingDefinition: branchedDefinition,
          executionLanes: {
            "lane-a": laneA,
            "lane-b": laneB,
            "lane-target": laneTarget,
          },
          joins: {
            "join-1": {
              joinId: "join-1",
              kind: "context_merge",
              contextId: null,
              targetLaneId: "lane-target",
              sourceLaneIds: ["lane-a", "lane-b"],
              mergedSourceLaneIds: ["lane-a", "lane-b"],
              validationDebtSourceLaneIds: [],
              status: "succeeded",
              errorMessage: null,
              conflicts: null,
              conflictGuidance: null,
              createdAt: "2026-03-27T15:00:00.000Z",
              updatedAt: "2026-03-27T15:00:00.000Z",
              completedAt: "2026-03-27T15:00:00.000Z",
            },
          },
          contextStates: {
            ...baseExecution.contextStates,
            "context-earlier-pass": {
              ...baseExecution.contextStates["context-plan"]!,
              contextId: "context-earlier-pass",
              status: "completed",
              laneId: "lane-a",
              isolation: "worktree",
            },
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "worktree",
              laneId: "lane-a",
              worktreePath: laneA.worktreePath,
              branchName: laneA.branchName,
              mergeStatus: "merged-success",
              completedTaskCount: 1,
              iterationCount: 1,
            },
            "context-implement": {
              ...baseExecution.contextStates["context-implement"]!,
              status: "completed",
              isolation: "worktree",
              laneId: "lane-b",
              worktreePath: laneB.worktreePath,
              branchName: laneB.branchName,
              mergeStatus: "merged-success",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub({
        async onProvision() {
          if (!parentAdvances) return;
          await repository.mutateActive("/repo", "session-1", (current) =>
            changed({
              ...current,
              executionLanes: {
                ...current.executionLanes,
                "lane-target": {
                  ...current.executionLanes["lane-target"]!,
                  includedContextIds: [
                    ...current.executionLanes["lane-target"]!
                      .includedContextIds,
                    "context-earlier-pass",
                  ],
                },
              },
            }),
          );
        },
      });

      const scheduler = createContextScheduler({
        executionRepository: repository,
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await scheduler.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds).toEqual(["context-verify"]);

      const verifyState = result.execution.contextStates["context-verify"];
      expect(verifyState?.status).toBe("running");
      expect(verifyState?.laneId).toBe("verify");
      expect(verifyState?.isolation).toBe("worktree");

      // One worktree, branched off the converged lane so both upstreams are in
      // its history — and the fork inherits their context ids for visibility.
      expect(
        parallelWorktrees.provisionCalls.map((call) => ({
          contextId: call.contextId,
          sessionBranch: call.sessionBranch,
        })),
      ).toEqual([
        { contextId: "verify", sessionBranch: laneTarget.branchName },
      ]);
      expect(
        result.execution.executionLanes.verify?.includedContextIds.sort(),
      ).toEqual(["context-implement", "context-plan"]);
      expect(
        result.execution.executionLanes[
          "lane-target"
        ]!.includedContextIds.includes("context-earlier-pass"),
      ).toBe(parentAdvances);
    },
  );

  it("forks a fresh worktree when sessionLaneEnabled is false and the upstream landed in session", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            isolation: "session",
            mergeStatus: "not-applicable",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionLaneEnabled: false,
    });

    expect(result.scheduled.kind).toBe("parallel");
    if (result.scheduled.kind !== "parallel") return;
    expect(result.scheduled.contextIds).toEqual(["context-implement"]);

    const implState = result.execution.contextStates["context-implement"];
    expect(implState?.status).toBe("running");
    expect(implState?.isolation).toBe("worktree");
    // The forked worktree is a lane like every provisioned worktree, so its
    // output publishes through the gated final_publish join.
    expect(implState?.laneId).toBe("implement");
    expect(implState?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.implement",
    );

    expect(result.execution.executionLanes["implement"]?.kind).toBe("worktree");

    expect(parallelWorktrees.provisionCalls.map((c) => c.contextId)).toEqual([
      "implement",
    ]);
  });

  it("schedules both fan-out children in one pass: each forks its own worktree lane from the parent's branch because neither is placed on the parent lane", async () => {
    const fanOutDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });
    const lane = {
      laneId: "lane-plan",
      kind: "worktree" as const,
      status: "active" as const,
      worktreePath: "/repo/.worktrees/feature-abc.lane-plan",
      branchName: "csm/feature-abc-lane-plan",
      includedContextIds: ["context-plan"],
      lastCommittingContextId: "context-plan",
      commitSnapshots: [],
      createdAt: "2026-03-27T15:00:00.000Z",
      updatedAt: "2026-03-27T15:00:00.000Z",
    };
    const baseExecution = createWorkflowExecution({
      workingDefinition: fanOutDefinition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: fanOutDefinition,
        executionLanes: { "lane-plan": lane },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            isolation: "worktree",
            laneId: "lane-plan",
            worktreePath: lane.worktreePath,
            branchName: lane.branchName,
            mergeStatus: "merged-success",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled.kind).toBe("parallel");
    if (result.scheduled.kind !== "parallel") return;
    // Each child is placed on its own lane, so neither takes the parent's:
    // both fork from its committed head into a worktree of their own.
    expect(result.scheduled.contextIds.slice().sort()).toEqual([
      "context-implement",
      "context-verify",
    ]);

    const inheritState = result.execution.contextStates["context-implement"];
    expect(inheritState?.status).toBe("running");
    expect(inheritState?.laneId).toBe("implement");
    expect(inheritState?.isolation).toBe("worktree");
    expect(inheritState?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.implement",
    );
    expect(inheritState?.branchName).toBe("csm/feature-abc-implement");

    const forkState = result.execution.contextStates["context-verify"];
    expect(forkState?.status).toBe("running");
    expect(forkState?.laneId).toBe("verify");
    expect(forkState?.isolation).toBe("worktree");
    expect(forkState?.worktreePath).toBe("/repo/.worktrees/feature-abc.verify");
    expect(forkState?.branchName).toBe("csm/feature-abc-verify");

    const forkedLane = result.execution.executionLanes["verify"];
    expect(forkedLane).toBeDefined();
    expect(forkedLane?.kind).toBe("worktree");
    expect(forkedLane?.status).toBe("active");
    expect(forkedLane?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.verify",
    );
    expect(forkedLane?.branchName).toBe("csm/feature-abc-verify");
    expect(forkedLane?.includedContextIds).toEqual(["context-plan"]);
    expect(forkedLane?.lastCommittingContextId).toBe("context-plan");
    expect(forkedLane?.commitSnapshots).toEqual([]);

    // Parent lane retained as-is; each fork is a separate entry.
    expect(result.execution.executionLanes["lane-plan"]).toEqual(lane);
    expect(
      result.execution.executionLanes["implement"]?.includedContextIds,
    ).toEqual(["context-plan"]);

    // One worktree per child, each based on the parent lane's branch — that's
    // the fork-from-committed-head semantics.
    expect(parallelWorktrees.provisionCalls).toHaveLength(2);
    expect(
      parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
    ).toEqual(["implement", "verify"]);
    for (const call of parallelWorktrees.provisionCalls) {
      expect(call.sessionBranch).toBe(lane.branchName);
    }
    const forkCall = parallelWorktrees.provisionCalls.find(
      (c) => c.contextId === "verify",
    )!;
    expect(forkCall.contextId).toBe("verify");
    expect(forkCall.sessionBranch).toBe(lane.branchName);
    expect(forkCall.sessionDir).toBe("feature-abc");
  });

  // Two siblings PLACED on the same lane contend for its one worktree. The
  // first in definition order takes it; the other waits for a later pass
  // rather than forking, because a fork would mint a second lane under the
  // name their shared placement already owns.
  it("gives the contested lane to the first sibling in definition order at fan-out, holding the other back", async () => {
    const fanOutDefinition = withContextsOnLane(
      createResolvedWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      }),
      "lane-plan",
      ["context-implement", "context-verify"],
    );
    const lane = {
      laneId: "lane-plan",
      kind: "worktree" as const,
      status: "active" as const,
      worktreePath: "/repo/.worktrees/feature-abc.lane-plan",
      branchName: "csm/feature-abc-lane-plan",
      includedContextIds: ["context-plan"],
      lastCommittingContextId: "context-plan",
      commitSnapshots: [],
      createdAt: "2026-03-27T15:00:00.000Z",
      updatedAt: "2026-03-27T15:00:00.000Z",
    };
    const baseExecution = createWorkflowExecution({
      workingDefinition: fanOutDefinition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: fanOutDefinition,
        executionLanes: { "lane-plan": lane },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            isolation: "worktree",
            laneId: "lane-plan",
            worktreePath: lane.worktreePath,
            branchName: lane.branchName,
            mergeStatus: "merged-success",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled.kind).toBe("parallel");
    if (result.scheduled.kind !== "parallel") return;
    // Only the winner is scheduled this pass.
    expect(result.scheduled.contextIds).toEqual(["context-implement"]);

    const winnerState = result.execution.contextStates["context-implement"];
    expect(winnerState?.laneId).toBe("lane-plan");
    expect(winnerState?.status).toBe("running");

    const heldBackState = result.execution.contextStates["context-verify"];
    expect(heldBackState?.status).not.toBe("running");
    expect(heldBackState?.laneId).toBeNull();

    // The shared lane already exists, so nothing is provisioned and no second
    // lane appears under its name.
    expect(parallelWorktrees.provisionCalls).toEqual([]);
    expect(Object.keys(result.execution.executionLanes)).toEqual(["lane-plan"]);
  });

  it("deterministically restarts a fan-out: the same two forked lanes on a fresh scheduling pass", async () => {
    const fanOutDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });
    const lane = {
      laneId: "lane-plan",
      kind: "worktree" as const,
      status: "active" as const,
      worktreePath: "/repo/.worktrees/feature-abc.lane-plan",
      branchName: "csm/feature-abc-lane-plan",
      includedContextIds: ["context-plan"],
      lastCommittingContextId: "context-plan",
      commitSnapshots: [],
      createdAt: "2026-03-27T15:00:00.000Z",
      updatedAt: "2026-03-27T15:00:00.000Z",
    };
    const baseExecution = createWorkflowExecution({
      workingDefinition: fanOutDefinition,
    });
    const seedRun = (extra: { sessionName: string }): GraphWorkflowExecution =>
      createWorkflowExecution({
        ...baseExecution,
        id: `execution-${extra.sessionName}`,
        status: "running",
        workingDefinition: fanOutDefinition,
        executionLanes: { "lane-plan": lane },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            isolation: "worktree",
            laneId: "lane-plan",
            worktreePath: lane.worktreePath,
            branchName: lane.branchName,
            mergeStatus: "merged-success",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      });

    const runFanout = async (sessionName: string) => {
      const repository = createRepository(seedRun({ sessionName }));
      const parallelWorktrees = createParallelWorktreesStub();
      const scheduler = createContextScheduler({
        executionRepository: repository,
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });
      const result = await scheduler.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName,
      });
      return { result, parallelWorktrees };
    };

    const a = await runFanout("session-a");
    const b = await runFanout("session-b");

    for (const { result, parallelWorktrees } of [a, b]) {
      expect(result.scheduled.kind).toBe("parallel");
      if (result.scheduled.kind !== "parallel") return;
      expect(result.scheduled.contextIds.slice().sort()).toEqual([
        "context-implement",
        "context-verify",
      ]);

      const implementState =
        result.execution.contextStates["context-implement"];
      expect(implementState?.laneId).toBe("implement");
      expect(implementState?.isolation).toBe("worktree");

      const verifyState = result.execution.contextStates["context-verify"];
      expect(verifyState?.laneId).toBe("verify");
      expect(verifyState?.isolation).toBe("worktree");

      for (const laneId of ["implement", "verify"]) {
        expect(result.execution.executionLanes[laneId]).toBeDefined();
        expect(
          result.execution.executionLanes[laneId]?.includedContextIds,
        ).toEqual(["context-plan"]);
      }

      expect(parallelWorktrees.provisionCalls).toHaveLength(2);
      expect(
        parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
      ).toEqual(["implement", "verify"]);
      for (const call of parallelWorktrees.provisionCalls) {
        expect(call.sessionBranch).toBe(lane.branchName);
      }
    }
  });

  it("gives each fan-out sibling its own authored lane, both forked from the session-kind parent's branch", async () => {
    const fanOutDefinition = createResolvedWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });
    const sessionLane = {
      laneId: "lane-session",
      kind: "session" as const,
      status: "active" as const,
      worktreePath: null,
      branchName: "csm/feature-abc",
      includedContextIds: ["context-plan"],
      lastCommittingContextId: "context-plan",
      commitSnapshots: [],
      createdAt: "2026-03-27T15:00:00.000Z",
      updatedAt: "2026-03-27T15:00:00.000Z",
    };
    const baseExecution = createWorkflowExecution({
      workingDefinition: fanOutDefinition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: fanOutDefinition,
        executionLanes: { "lane-session": sessionLane },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            isolation: "session",
            laneId: "lane-session",
            worktreePath: null,
            branchName: null,
            mergeStatus: "not-applicable",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled.kind).toBe("parallel");
    if (result.scheduled.kind !== "parallel") return;
    expect([...result.scheduled.contextIds].sort()).toEqual([
      "context-implement",
      "context-verify",
    ]);

    // Authored placement, not a continuation contest: neither sibling
    // inherits the parent lane, and each gets the lane it declared.
    expect(result.execution.contextStates["context-implement"]?.laneId).toBe(
      "implement",
    );
    expect(result.execution.contextStates["context-verify"]?.laneId).toBe(
      "verify",
    );
    expect(
      parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
    ).toEqual(["implement", "verify"]);
    for (const call of parallelWorktrees.provisionCalls) {
      expect(call.sessionBranch).toBe(sessionLane.branchName);
    }
  });

  it("routes a context authored onto the session lane with isolation=session and no worktree provisioning", async () => {
    const sessionLane = {
      laneId: SESSION_LANE_ID,
      kind: "session" as const,
      status: "active" as const,
      worktreePath: null,
      branchName: "csm/feature-abc",
      includedContextIds: ["context-plan"],
      lastCommittingContextId: "context-plan",
      commitSnapshots: [],
      createdAt: "2026-03-27T15:00:00.000Z",
      updatedAt: "2026-03-27T15:00:00.000Z",
    };
    const sessionPlacedDefinition = createResolvedWorkflowDefinition();
    const definition = {
      ...sessionPlacedDefinition,
      executionContexts: sessionPlacedDefinition.executionContexts.map(
        (context) =>
          context.id === "context-implement"
            ? {
                ...context,
                placement: {
                  lane: SESSION_LANE_NAME,
                  mode: "readOnly" as const,
                },
                outputSchema: {
                  type: "object" as const,
                  properties: { review: { type: "string" as const } },
                },
              }
            : context,
      ),
    };
    const baseExecution = createWorkflowExecution({
      workingDefinition: definition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        workingDefinition: definition,
        executionLanes: { [SESSION_LANE_ID]: sessionLane },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "completed",
            isolation: "session",
            laneId: SESSION_LANE_ID,
            worktreePath: null,
            branchName: null,
            mergeStatus: "not-applicable",
            completedTaskCount: 1,
            iterationCount: 1,
          },
        },
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const result = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(result.scheduled).toEqual({
      kind: "solo",
      contextId: "context-implement",
    });

    const implState = result.execution.contextStates["context-implement"];
    expect(implState?.status).toBe("running");
    expect(implState?.laneId).toBeNull();
    expect(implState?.isolation).toBe("session");
    expect(implState?.worktreePath).toBeNull();
    expect(implState?.branchName).toBeNull();
    expect(implState?.landingIntent).toBeNull();

    expect(parallelWorktrees.provisionCalls).toEqual([]);
  });

  /**
   * R11.1's charset clause, at the production path rather than on the migrated
   * data alone. A legacy context id may be any non-empty string, and this one
   * is not spliceable into a git branch name or a worktree path — so the lane
   * the migration minted for it is the only legal name available. Provisioning
   * that keyed off the context id instead would make the sanitization dead
   * code and refuse the migrated definition outright, which is the opposite of
   * "existing templates remain startable".
   */
  it("provisions a migrated pre-placement context whose id is outside the lane-id charset under its sanitized lane name", async () => {
    const legacyId = "build api";
    const definition = inflatePrePlacement(
      renameContext(
        createResolvedWorkflowDefinition(),
        "context-plan",
        legacyId,
      ),
    );
    // The transformer chose this, not the test.
    expect(
      definition.executionContexts.find((ctx) => ctx.id === legacyId)?.placement
        .lane,
    ).toBe("build_api");

    const base = createWorkflowExecution({ workingDefinition: definition });
    const repository = createRepository({
      ...base,
      status: "running",
      contextStates: renameContextState(
        base.contextStates,
        "context-plan",
        legacyId,
      ),
    });
    const parallelWorktrees = createParallelWorktreesStub();
    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const scheduled = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });

    expect(scheduled.scheduled.kind).toBe("parallel");
    if (scheduled.scheduled.kind !== "parallel") return;
    expect(scheduled.scheduled.contextIds).toEqual([legacyId]);

    expect(parallelWorktrees.provisionCalls).toHaveLength(1);
    expect(parallelWorktrees.provisionCalls[0]?.contextId).toBe("build_api");

    const state = scheduled.execution.contextStates[legacyId];
    expect(state?.laneId).toBe("build_api");
    expect(state?.isolation).toBe("worktree");
    expect(state?.worktreePath).toBe("/repo/.worktrees/feature-abc.build_api");
    expect(state?.branchName).toBe("csm/feature-abc-build_api");
    expect(scheduled.execution.executionLanes["build_api"]?.kind).toBe(
      "worktree",
    );
  });

  /**
   * R11.1's execution clause: a pre-placement definition migrates to one
   * single-member lane per context, and that is what the run must cost — one
   * worktree per context, exactly as the definition behaved before placement
   * existed.
   *
   * The downstream is the case that matters. Its upstream landed on a worktree
   * lane, so the classifier offers that lane; admitting the downstream onto it
   * would silently merge two single-member lanes into one and hand the
   * downstream a worktree its placement never claimed. It forks onto its own
   * lane from the upstream's committed head instead, which is how it still
   * sees the upstream's work.
   */
  it("provisions one worktree per context across a migrated pre-placement chain: each downstream forks onto its own single-member lane", async () => {
    const definition = inflatePrePlacement(createResolvedWorkflowDefinition());
    // Migration names each lane after its context, so no two contexts share one.
    expect(
      definition.executionContexts.map((ctx) => ctx.placement.lane),
    ).toEqual(["context-plan", "context-implement", "context-verify"]);

    const base = createWorkflowExecution({ workingDefinition: definition });
    const repository = createRepository({ ...base, status: "running" });
    const parallelWorktrees = createParallelWorktreesStub();
    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    const first = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });
    expect(first.scheduled.kind).toBe("parallel");
    if (first.scheduled.kind !== "parallel") return;
    expect(first.scheduled.contextIds).toEqual(["context-plan"]);
    const planState = first.execution.contextStates["context-plan"];
    expect(planState?.laneId).toBe("context-plan");
    expect(parallelWorktrees.provisionCalls).toHaveLength(1);

    // context-plan commits on its lane and completes.
    const afterPlan = first.execution;
    const planLane = afterPlan.executionLanes["context-plan"]!;
    await repository.update("/repo", "session-1", {
      ...afterPlan,
      contextStates: {
        ...afterPlan.contextStates,
        "context-plan": {
          ...afterPlan.contextStates["context-plan"]!,
          status: "completed",
          mergeStatus: "merged-success",
          completedTaskCount: 1,
          iterationCount: 1,
          landingIntent: {
            ...afterPlan.contextStates["context-plan"]!.landingIntent!,
            state: "landed",
            evidence: "commit",
            headSha: "plan-head",
            settledAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      executionLanes: {
        ...afterPlan.executionLanes,
        "context-plan": {
          ...planLane,
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
        },
      },
      activeContextIds: afterPlan.activeContextIds.filter(
        (id) => id !== "context-plan",
      ),
    });

    const second = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });
    expect(second.scheduled.kind).toBe("parallel");
    if (second.scheduled.kind !== "parallel") return;
    expect(second.scheduled.contextIds).toEqual(["context-implement"]);

    const implState = second.execution.contextStates["context-implement"];
    expect(implState?.laneId).toBe("context-implement");
    expect(implState?.isolation).toBe("worktree");
    expect(implState?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.context-implement",
    );

    // A second worktree, forked from the upstream lane's branch so the
    // upstream's committed work is visible in it.
    expect(parallelWorktrees.provisionCalls).toHaveLength(2);
    expect(parallelWorktrees.provisionCalls[1]?.contextId).toBe(
      "context-implement",
    );
    expect(parallelWorktrees.provisionCalls[1]?.sessionBranch).toBe(
      planLane.branchName,
    );

    const forkedLane = second.execution.executionLanes["context-implement"];
    expect(forkedLane?.kind).toBe("worktree");
    expect(forkedLane?.includedContextIds).toEqual(["context-plan"]);
    expect(forkedLane?.lastCommittingContextId).toBe("context-plan");
  });

  it("reuses a single worktree lane across a linear context chain (sequential lane reuse) so only the root provisions a lane", async () => {
    // Topology: context-plan -> context-implement -> context-verify (default
    // fixture), all three authored onto ONE lane. The root should be minted
    // into a worktree lane up front; each downstream then reuses it without
    // provisioning a new worktree or going through a session merge.
    const baseExecution = createWorkflowExecution({
      workingDefinition: sharedLaneDefinition(),
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
      }),
    );
    const parallelWorktrees = createParallelWorktreesStub();

    const scheduler = createContextScheduler({
      executionRepository: repository,
      parallelWorktrees,
      async getSession() {
        return createSession({
          worktreePath: "/repo/.worktrees/feature-abc",
          branchName: "csm/feature-abc",
        });
      },
    });

    // Pass 1: only context-plan is eligible. It should be provisioned into
    // a fresh worktree lane named by the group's authored placement.
    const first = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });
    expect(first.scheduled.kind).toBe("parallel");
    if (first.scheduled.kind !== "parallel") return;
    expect(first.scheduled.contextIds).toEqual(["context-plan"]);

    const planState = first.execution.contextStates["context-plan"];
    expect(planState?.laneId).toBe("delivery");
    expect(planState?.isolation).toBe("worktree");
    const mintedLane = first.execution.executionLanes["delivery"];
    expect(mintedLane).toBeDefined();
    expect(mintedLane?.kind).toBe("worktree");
    expect(mintedLane?.status).toBe("active");
    expect(mintedLane?.includedContextIds).toEqual([]);
    expect(mintedLane?.lastCommittingContextId).toBeNull();
    expect(mintedLane?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.delivery",
    );
    expect(mintedLane?.branchName).toBe("csm/feature-abc-delivery");
    expect(parallelWorktrees.provisionCalls).toHaveLength(1);

    // Simulate runLaneCommit: context-plan finishes, lane records its
    // committed contribution. No session merge happens — the lane retains
    // the work for the next consumer. The landing intent settles in the SAME
    // mutation as the merge status (decision D8), because the lane's
    // `includedContextIds` records that the commit phase was entered, not
    // that it produced a landing.
    const afterPlan = first.execution;
    await repository.update("/repo", "session-1", {
      ...afterPlan,
      contextStates: {
        ...afterPlan.contextStates,
        "context-plan": {
          ...afterPlan.contextStates["context-plan"]!,
          status: "completed",
          mergeStatus: "merged-success",
          completedTaskCount: 1,
          iterationCount: 1,
          landingIntent: {
            ...afterPlan.contextStates["context-plan"]!.landingIntent!,
            state: "landed",
            evidence: "commit",
            headSha: "plan-head",
            settledAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      executionLanes: {
        ...afterPlan.executionLanes,
        delivery: {
          ...mintedLane!,
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
        },
      },
      activeContextIds: afterPlan.activeContextIds.filter(
        (id) => id !== "context-plan",
      ),
    });

    // Pass 2: context-implement is now eligible. Its upstream landed in the
    // worktree lane "delivery"; classifier returns targetLaneId =
    // "delivery" → scheduler reuses without minting. No new provision.
    const second = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });
    expect(second.scheduled.kind).toBe("parallel");
    if (second.scheduled.kind !== "parallel") return;
    expect(second.scheduled.contextIds).toEqual(["context-implement"]);

    const implState = second.execution.contextStates["context-implement"];
    expect(implState?.laneId).toBe("delivery");
    expect(implState?.isolation).toBe("worktree");
    expect(implState?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.delivery",
    );
    expect(implState?.branchName).toBe("csm/feature-abc-delivery");
    expect(parallelWorktrees.provisionCalls).toHaveLength(1);

    // Simulate runLaneCommit for context-implement: lane absorbs another
    // committed context, still no session merge.
    const afterImpl = second.execution;
    await repository.update("/repo", "session-1", {
      ...afterImpl,
      contextStates: {
        ...afterImpl.contextStates,
        "context-implement": {
          ...afterImpl.contextStates["context-implement"]!,
          status: "completed",
          mergeStatus: "merged-success",
          completedTaskCount: 1,
          iterationCount: 1,
          landingIntent: {
            ...afterImpl.contextStates["context-implement"]!.landingIntent!,
            state: "landed",
            evidence: "commit",
            headSha: "implement-head",
            settledAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      executionLanes: {
        ...afterImpl.executionLanes,
        delivery: {
          ...afterImpl.executionLanes["delivery"]!,
          includedContextIds: ["context-plan", "context-implement"],
          lastCommittingContextId: "context-implement",
        },
      },
      activeContextIds: afterImpl.activeContextIds.filter(
        (id) => id !== "context-implement",
      ),
    });

    // Pass 3: context-verify is the final consumer; same lane reused. The
    // chain ran end-to-end on one worktree lane with one provisionLane call.
    const third = await scheduler.scheduleEligibleContexts({
      projectPath: "/repo",
      sessionName: "session-1",
    });
    expect(third.scheduled.kind).toBe("parallel");
    if (third.scheduled.kind !== "parallel") return;
    expect(third.scheduled.contextIds).toEqual(["context-verify"]);

    const verifyState = third.execution.contextStates["context-verify"];
    expect(verifyState?.laneId).toBe("delivery");
    expect(verifyState?.isolation).toBe("worktree");
    expect(verifyState?.worktreePath).toBe(
      "/repo/.worktrees/feature-abc.delivery",
    );

    // No additional provisioning across the whole linear chain.
    expect(parallelWorktrees.provisionCalls).toHaveLength(1);
    expect(parallelWorktrees.provisionCalls[0]!.contextId).toBe("delivery");
    // No fresh worktree lanes were minted for downstream consumers.
    expect(Object.keys(third.execution.executionLanes).sort()).toEqual([
      "delivery",
    ]);
  });

  describe("structured scheduler/lane observability", () => {
    type LoggerCall = {
      kind: "lifecycle" | "decision";
      event: string;
      data: Record<string, unknown> | undefined;
    };

    function createCapturingLogger(executionId: string): {
      logger: ExecutionLogger;
      calls: LoggerCall[];
    } {
      const calls: LoggerCall[] = [];
      const logger: ExecutionLogger = {
        executionId,
        logDir: "/tmp/test-obs",
        writeManifest() {},
        lifecycle(event, data) {
          calls.push({ kind: "lifecycle", event, data });
        },
        iteration() {},
        task() {},
        validation() {},
        writePrompt() {},
        writeValidatorResponse() {},
        writeValidatorTranscript() {},
        decision(event, data) {
          calls.push({ kind: "decision", event, data });
        },
      };
      return { logger, calls };
    }

    it("emits a scheduler.ready_set lifecycle event with eligible context ids so operators can trace ready-set computation", async () => {
      _resetRegistryForTesting();
      const baseExecution = createWorkflowExecution();
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          id: "exec-obs-ready-set",
          status: "running",
        }),
      );
      const { logger, calls } = createCapturingLogger("exec-obs-ready-set");
      registerExecutionLogger(logger);

      const parallelWorktrees = createParallelWorktreesStub();
      const scheduler = createContextScheduler({
        executionRepository: repository,
        parallelWorktrees,
        async getSession() {
          return createSession();
        },
      });

      await scheduler.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      const readySet = calls.find(
        (c) => c.kind === "lifecycle" && c.event === "scheduler.ready_set",
      );
      expect(readySet).toBeDefined();
      expect(readySet?.data?.eligibleContextIds).toEqual(["context-plan"]);
      unregisterExecutionLogger("exec-obs-ready-set");
    });

    it("emits a lane.created lifecycle event when minting a fresh worktree lane with the laneId, branchName, worktreePath, and originating contextId", async () => {
      _resetRegistryForTesting();
      const baseExecution = createWorkflowExecution({
        workingDefinition: sharedLaneDefinition(),
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          id: "exec-obs-lane-created",
          status: "running",
        }),
      );
      const { logger, calls } = createCapturingLogger("exec-obs-lane-created");
      registerExecutionLogger(logger);

      const parallelWorktrees = createParallelWorktreesStub();
      const scheduler = createContextScheduler({
        executionRepository: repository,
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      await scheduler.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      const laneCreated = calls.find(
        (c) => c.kind === "lifecycle" && c.event === "lane.created",
      );
      expect(laneCreated).toBeDefined();
      expect(laneCreated?.data).toMatchObject({
        laneId: "delivery",
        contextId: "context-plan",
        branchName: "csm/feature-abc-delivery",
        worktreePath: "/repo/.worktrees/feature-abc.delivery",
        kind: "worktree",
      });
      unregisterExecutionLogger("exec-obs-lane-created");
    });

    it("emits a lane.reused lifecycle event when a downstream context inherits an upstream worktree lane so operators can audit lane handoff", async () => {
      _resetRegistryForTesting();
      // Handoff happens between contexts SHARING a lane, so the definition
      // places both on the one the fixture below provisions.
      const baseExecution = createWorkflowExecution({
        workingDefinition: withContextsOnLane(
          createResolvedWorkflowDefinition(),
          "context-plan",
          ["context-plan", "context-implement"],
        ),
      });
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          id: "exec-obs-lane-reused",
          status: "running",
          executionLanes: {
            "context-plan": {
              laneId: "context-plan",
              kind: "worktree",
              status: "active",
              worktreePath: "/repo/.worktrees/feature-abc.context-plan",
              branchName: "csm/feature-abc-context-plan",
              includedContextIds: ["context-plan"],
              lastCommittingContextId: "context-plan",
              commitSnapshots: [],
              createdAt: "2026-03-27T15:00:00.000Z",
              updatedAt: "2026-03-27T15:00:00.000Z",
            },
          },
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "completed",
              isolation: "worktree",
              laneId: "context-plan",
              worktreePath: "/repo/.worktrees/feature-abc.context-plan",
              branchName: "csm/feature-abc-context-plan",
              mergeStatus: "not-applicable",
              completedTaskCount: 1,
              iterationCount: 1,
            },
          },
        }),
      );
      const { logger, calls } = createCapturingLogger("exec-obs-lane-reused");
      registerExecutionLogger(logger);

      const parallelWorktrees = createParallelWorktreesStub();
      const scheduler = createContextScheduler({
        executionRepository: repository,
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      await scheduler.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      const laneReused = calls.find(
        (c) => c.kind === "lifecycle" && c.event === "lane.reused",
      );
      expect(laneReused).toBeDefined();
      expect(laneReused?.data).toMatchObject({
        laneId: "context-plan",
        contextId: "context-implement",
        branchName: "csm/feature-abc-context-plan",
        worktreePath: "/repo/.worktrees/feature-abc.context-plan",
      });
      unregisterExecutionLogger("exec-obs-lane-reused");
    });

    it("preserves existing lane conversations after provisioning a scheduled context", async () => {
      _resetRegistryForTesting();
      const baseExecution = createWorkflowExecution();
      const repository = createRepository(
        createWorkflowExecution({
          ...baseExecution,
          id: "exec-obs-lane-cleanup",
          status: "running",
          laneStates: {
            "context-plan": {
              implementer: {
                backend: "claude",
                lane: "implementer",
                contextId: "context-plan",
                workflowConversationId: "conv-prev",
                metrics: {
                  contextTokens: 10_000,
                  contextWindowMax: 200_000,
                },
                lastUsedAt: "2026-03-27T15:00:00.000Z",
              },
            },
          },
        }),
      );
      const { logger } = createCapturingLogger("exec-obs-lane-cleanup");
      registerExecutionLogger(logger);

      const parallelWorktrees = createParallelWorktreesStub();
      const scheduler = createContextScheduler({
        executionRepository: repository,
        parallelWorktrees,
        async getSession() {
          return createSession();
        },
      });

      await scheduler.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(
        repository.read()?.laneStates["context-plan"]?.implementer
          ?.workflowConversationId,
      ).toBe("conv-prev");
      unregisterExecutionLogger("exec-obs-lane-cleanup");
    });
  });
});
