import { describe, expect, it, vi } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  ResolvedWorkflowSemanticDefinition,
  SessionState,
  WorkflowDefinitionRecord,
} from "@/types";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import {
  _resetRegistryForTesting,
  getExecutionLogger,
  unregisterExecutionLogger,
} from "@/lib/workflow-graph/execution-logger";
import type {
  DisposeInput,
  DisposeResult,
  ParallelWorktrees,
  ProvisionInput,
  ProvisionResult,
} from "@/lib/workflow-graph/parallel-worktrees";
import { createGraphWorkflowManager } from "./workflow-manager";

interface InMemoryExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  create(
    projectPath: string,
    sessionName: string,
    seed: {
      definition: WorkflowDefinitionRecord["definition"];
      definitionId: string;
      definitionRevision: number;
      executionId: string;
      startedAt: string;
    },
  ): Promise<GraphWorkflowExecution>;
  update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
}

function createRepository(
  initialExecution: GraphWorkflowExecution | null = null,
): InMemoryExecutionRepository & { read(): GraphWorkflowExecution | null } {
  let activeExecution = initialExecution;
  let lock: Promise<void> = Promise.resolve();

  return {
    async getActive() {
      return activeExecution;
    },
    async create(_projectPath, _sessionName, seed) {
      activeExecution = createWorkflowExecution({
        id: seed.executionId,
        seedDefinitionId: seed.definitionId,
        seedDefinitionRevision: seed.definitionRevision,
        workingDefinition:
          seed.definition as unknown as ResolvedWorkflowSemanticDefinition,
        startedAt: seed.startedAt,
      });
      return activeExecution;
    },
    async update(_projectPath, _sessionName, execution) {
      activeExecution = execution;
    },
    async mutateActive(_projectPath, _sessionName, fn) {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        if (!activeExecution) {
          throw new Error(
            "Session does not have an active graph workflow execution",
          );
        }
        const next = await fn(structuredClone(activeExecution));
        activeExecution = next;
        return next;
      } finally {
        release();
      }
    },
    read() {
      return activeExecution;
    },
  };
}

describe("graph workflow manager", () => {
  it("starts a run from a saved workflow definition and persists lifecycle metadata", async () => {
    const definition = createWorkflowDefinitionRecord({
      revision: 3,
    });
    const repository = createRepository();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return definition;
      },
      now() {
        return "2026-03-27T15:00:00.000Z";
      },
      createExecutionId() {
        return "execution-started";
      },
    });

    const execution = await manager.start({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: definition.id,
    });

    expect(execution.id).toBe("execution-started");
    expect(execution.status).toBe("running");
    expect(execution.seedDefinitionId).toBe(definition.id);
    expect(execution.seedDefinitionRevision).toBe(3);
    expect(execution.workingDefinition).toEqual(definition.definition);
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: null,
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("pauses immediately by interrupting running tasks in the active context", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-implement": {
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-verify": {
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
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
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
          "task-implement-1": {
            taskId: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
          "task-verify-1": {
            taskId: "task-verify-1",
            contextId: "context-verify",
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
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:05:00.000Z";
      },
    });

    const execution = await manager.send("/repo", "session-1", {
      type: "pause",
    });

    expect(execution.status).toBe("paused");
    expect(execution.taskStates["task-plan-1"]?.status).toBe("interrupted");
    expect(execution.contextStates["context-plan"]?.status).toBe("ready");
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "paused",
      activeContextId: "context-plan",
      recoveryMode: "interrupted_task",
      hasLiveIteration: false,
    });
  });

  it("transitions a running context to ready when halted", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 2,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-implement": {
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-verify": {
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
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
            summary: "done",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:01:00.000Z",
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
          "task-implement-1": {
            taskId: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
          "task-verify-1": {
            taskId: "task-verify-1",
            contextId: "context-verify",
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
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:05:00.000Z";
      },
    });

    const execution = await manager.send("/repo", "session-1", {
      type: "halt",
      reason: {
        type: "max_iterations",
        contextId: "context-plan",
        iterationCount: 2,
      },
    });

    expect(execution.status).toBe("halted");
    expect(execution.contextStates["context-plan"]?.status).toBe("ready");
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "halted",
      activeContextId: "context-plan",
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("resumes a paused execution preserving the active context", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "paused",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
          "task-implement-1": {
            taskId: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
          "task-verify-1": {
            taskId: "task-verify-1",
            contextId: "context-verify",
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
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "paused",
          activeContextId: "context-plan",
          recoveryMode: "interrupted_task",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:06:00.000Z";
      },
    });

    const execution = await manager.resume("/repo", "session-1");

    expect(execution.status).toBe("running");
    expect(execution.taskStates["task-plan-1"]?.status).toBe("interrupted");
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "interrupted_task",
      hasLiveIteration: false,
    });
  });

  it("schedules implementer rotation when recovering a retryable iteration error", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-implement": {
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-verify": {
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        laneStates: {
          "context-plan": {
            implementer: {
              engine: "claude",
              lane: "implementer",
              contextId: "context-plan",
              sessionRef: {
                engine: "claude",
                lane: "implementer",
                conversationId: "conv-1",
              },
              lastContextTokens: 10_000,
              lastContextWindowMax: 200_000,
              rotateBeforeNextTurn: false,
              limitEvaluation: "disabled",
              lastUsedAt: "2026-03-27T15:00:00.000Z",
            },
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:07:00.000Z";
      },
    });

    const execution = await manager.recoverRetryableIterationError(
      "/repo",
      "session-1",
      {
        contextId: "context-plan",
        errorMessage: "SDK error: MCP error -32000: Stream closed",
      },
    );

    expect(execution.status).toBe("running");
    expect(execution.contextStates["context-plan"]?.status).toBe("ready");
    expect(execution.laneStates["context-plan"]?.["implementer"]).toMatchObject(
      {
        rotateBeforeNextTurn: true,
        lastUsedAt: "2026-03-27T15:07:00.000Z",
      },
    );
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("normalizes an in-flight iteration after restart so resume starts a fresh iteration", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-implement": {
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-verify": {
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
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
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
          "task-implement-1": {
            taskId: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            status: "pending",
            summary: null,
            startedAt: null,
            completedAt: null,
            lastConversationId: null,
            failureMessage: null,
            failureHistory: [],
          },
          "task-verify-1": {
            taskId: "task-verify-1",
            contextId: "context-verify",
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
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:10:00.000Z";
      },
    });

    const recovered = await manager.normalizeAfterRestart("/repo", "session-1");

    expect(recovered).not.toBeNull();
    expect(recovered?.status).toBe("paused");
    expect(recovered?.taskStates["task-plan-1"]?.status).toBe("interrupted");
    expect(recovered?.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "paused",
      activeContextId: "context-plan",
      recoveryMode: "restart_normalized",
      hasLiveIteration: false,
    });
  });

  it("skips normalization when the execution loop is actively running", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
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
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: true,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      isExecutionLoopActive() {
        return true;
      },
    });

    const result = await manager.normalizeAfterRestart("/repo", "session-1");

    // Should return the execution unchanged — not paused
    expect(result).not.toBeNull();
    expect(result?.status).toBe("running");
    expect(result?.taskStates["task-plan-1"]?.status).toBe("running");
    expect(result?.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "none",
      hasLiveIteration: true,
    });
  });

  it("normalizes a running execution to paused when hasLiveIteration is false and no loop is active", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "ready",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
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
            summary: "Done",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:05:00.000Z",
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      isExecutionLoopActive() {
        return false;
      },
    });

    const recovered = await manager.normalizeAfterRestart("/repo", "session-1");

    expect(recovered).not.toBeNull();
    expect(recovered?.status).toBe("paused");
    expect(recovered?.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "paused",
      activeContextId: "context-plan",
      recoveryMode: "restart_normalized",
      hasLiveIteration: false,
    });
  });

  it("transitions a running execution with pendingHaltReason directly to halted (drain resumed after crash)", async () => {
    const haltReason: GraphWorkflowHaltReason = {
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      summary: "consecutive failures exhausted",
    };

    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        pendingHaltReason: haltReason,
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
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
            status: "running",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "running",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      isExecutionLoopActive() {
        return false;
      },
      now() {
        return "2026-04-02T08:08:08.000Z";
      },
    });

    const recovered = await manager.normalizeAfterRestart("/repo", "session-1");

    expect(recovered?.status).toBe("halted");
    expect(recovered?.haltReason).toEqual(haltReason);
    expect(recovered?.pendingHaltReason).toBeNull();
    expect(recovered?.completedAt).toBe("2026-04-02T08:08:08.000Z");
    expect(recovered?.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "halted",
      activeContextId: "context-plan",
      recoveryMode: "restart_drain_resumed",
      hasLiveIteration: false,
    });
    expect(repository.read()?.status).toBe("halted");
    expect(repository.read()?.haltReason).toEqual(haltReason);
    expect(repository.read()?.pendingHaltReason).toBeNull();
  });

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

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const execution = await manager.scheduleNextContext("/repo", "session-1");

    expect(execution.activeContextIds).toEqual(["context-implement"]);
    expect(execution.contextStates["context-implement"]?.status).toBe(
      "running",
    );
    expect(execution.contextStates["context-verify"]?.status).toBe("ready");
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-implement",
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("resumes a halted execution, resetting halted context state and failure counters", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "halted",
        activeContextIds: ["context-plan"],
        completedAt: "2026-03-27T15:30:00.000Z",
        haltReason: {
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "retry_exhaustion",
          summary: "tests failed",
          failureCount: 2,
        },
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "halted",
            iterationCount: 2,
            consecutiveFailureCount: 2,
          },
        },
        taskStates: {
          ...baseExecution.taskStates,
          "task-plan-1": {
            ...baseExecution.taskStates["task-plan-1"]!,
            status: "completed",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:10:00.000Z",
            lastConversationId: "conversation-1",
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "halted",
          activeContextId: "context-plan",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const execution = await manager.resume("/repo", "session-1");

    expect(execution.status).toBe("running");
    expect(execution.completedAt).toBeNull();
    expect(execution.haltReason).toBeNull();
    expect(execution.activeContextIds).toEqual(["context-plan"]);
    expect(execution.contextStates["context-plan"]).toMatchObject({
      status: "ready",
      consecutiveFailureCount: 0,
    });
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("rejects resuming an aborted execution", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "aborted",
        activeContextIds: ["context-plan"],
        completedAt: "2026-03-27T15:30:00.000Z",
        haltReason: { type: "aborted" },
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "ready",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
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
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "aborted",
          activeContextId: "context-plan",
          recoveryMode: "interrupted_task",
          hasLiveIteration: false,
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    await expect(manager.resume("/repo", "session-1")).rejects.toThrow(
      "Only paused or halted graph workflow executions can be resumed",
    );
  });

  it("rejects resuming a completed execution", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "completed",
        completedAt: "2026-03-27T15:30:00.000Z",
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    await expect(manager.resume("/repo", "session-1")).rejects.toThrow(
      "can be resumed",
    );
  });

  it("rejects starting a second active execution in the same session", async () => {
    const repository = createRepository(createWorkflowExecution());
    const loadDefinition = vi.fn(async () => createWorkflowDefinitionRecord());

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      loadDefinition,
    });

    await expect(
      manager.start({
        projectPath: "/repo",
        sessionName: "session-1",
        definitionId: "workflow-1",
      }),
    ).rejects.toThrow("already has an active graph workflow execution");
    expect(loadDefinition).not.toHaveBeenCalled();
  });

  it("clears lane states when scheduling a new execution context", async () => {
    const baseExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: [],
      laneStates: {
        "context-implement": {
          implementer: {
            engine: "claude",
            lane: "implementer",
            contextId: "context-implement",
            sessionRef: {
              engine: "claude",
              lane: "implementer",
              conversationId: "conv-old",
            },
            lastContextTokens: 50_000,
            lastContextWindowMax: 200_000,
            rotateBeforeNextTurn: false,
            limitEvaluation: "disabled",
            lastUsedAt: "2026-03-27T15:00:00.000Z",
          },
        },
      },
      contextStates: {
        "context-plan": {
          contextId: "context-plan",
          status: "completed",
          totalTaskCount: 1,
          completedTaskCount: 1,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
        "context-implement": {
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
        "context-verify": {
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
    });

    const repository = createRepository(baseExecution);
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    const execution = await manager.scheduleNextContext("/repo", "session-1");

    expect(execution.laneStates).toEqual({});
  });

  describe("resetContext", () => {
    function createPausedExecutionWithRunState(): GraphWorkflowExecution {
      return createWorkflowExecution({
        status: "paused",
        activeContextIds: ["context-implement"],
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "completed",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 2,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-implement": {
            contextId: "context-implement",
            status: "ready",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 3,
            consecutiveFailureCount: 2,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
          "context-verify": {
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
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
            summary: "Planned",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:01:00.000Z",
            lastConversationId: "conv-plan",
            failureMessage: null,
            failureHistory: [],
          },
          "task-implement-1": {
            taskId: "task-implement-1",
            contextId: "context-implement",
            order: 1,
            status: "completed",
            summary: "Implemented",
            startedAt: "2026-03-27T15:05:00.000Z",
            completedAt: "2026-03-27T15:10:00.000Z",
            lastConversationId: "conv-impl",
            failureMessage: "prior failure",
            failureHistory: [
              { message: "flaky", timestamp: "2026-03-27T15:07:00.000Z" },
            ],
          },
          "task-verify-1": {
            taskId: "task-verify-1",
            contextId: "context-verify",
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
        laneStates: {
          "context-implement": {
            implementer: {
              engine: "claude",
              lane: "implementer",
              contextId: "context-implement",
              sessionRef: {
                engine: "claude",
                lane: "implementer",
                conversationId: "conv-impl",
              },
              lastContextTokens: 10,
              lastContextWindowMax: 100,
              rotateBeforeNextTurn: false,
              limitEvaluation: "disabled",
              lastUsedAt: "2026-03-27T15:10:00.000Z",
            },
          },
          "context-plan": {
            context_validator: {
              engine: "claude",
              lane: "context_validator",
              contextId: "context-plan",
              sessionRef: {
                engine: "claude",
                lane: "context_validator",
                conversationId: "conv-val",
              },
              lastContextTokens: null,
              lastContextWindowMax: null,
              rotateBeforeNextTurn: false,
              limitEvaluation: "disabled",
              lastUsedAt: "2026-03-27T15:11:00.000Z",
            },
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "paused",
          activeContextId: "context-implement",
          recoveryMode: "none",
          hasLiveIteration: false,
        },
      });
    }

    it("resets the selected context to execution-start defaults and persists via the repository", async () => {
      const repository = createRepository(createPausedExecutionWithRunState());

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const execution = await manager.resetContext(
        "/repo",
        "session-1",
        "context-implement",
      );

      expect(execution.status).toBe("paused");
      expect(execution.activeContextIds).toEqual([]);
      expect(execution.completedAt).toBeNull();
      expect(execution.haltReason).toBeNull();
      expect(execution.machineSnapshot).toBeNull();
      expect(execution.contextStates["context-implement"]).toEqual({
        contextId: "context-implement",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      });
      expect(execution.taskStates["task-implement-1"]).toEqual({
        taskId: "task-implement-1",
        contextId: "context-implement",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      });
      expect(execution.laneStates["context-implement"]).toBeUndefined();
      expect(
        execution.laneStates["context-plan"]?.["context_validator"],
      ).toBeDefined();

      // Repository was updated
      expect(repository.read()).toEqual(execution);
    });

    it("registers an execution logger when resetting from halted so the reset lifecycle event is captured", async () => {
      _resetRegistryForTesting();
      const haltedExecution = createWorkflowExecution({
        ...createPausedExecutionWithRunState(),
        status: "halted",
        completedAt: "2026-03-27T15:30:00.000Z",
        haltReason: {
          type: "max_iterations",
          contextId: "context-implement",
          iterationCount: 3,
        },
      });
      const repository = createRepository(haltedExecution);
      // Simulate the state after `send(halt)`: the execution logger is unregistered.
      unregisterExecutionLogger(haltedExecution.id);
      expect(getExecutionLogger(haltedExecution.id)).toBeNull();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const execution = await manager.resetContext(
        "/repo",
        "session-1",
        "context-implement",
      );

      expect(execution.status).toBe("paused");
      expect(getExecutionLogger(haltedExecution.id)).not.toBeNull();
      _resetRegistryForTesting();
    });

    it("accepts reset when the execution is halted and moves it back to paused", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          ...createPausedExecutionWithRunState(),
          status: "halted",
          completedAt: "2026-03-27T15:30:00.000Z",
          haltReason: {
            type: "max_iterations",
            contextId: "context-implement",
            iterationCount: 3,
          },
        }),
      );

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const execution = await manager.resetContext(
        "/repo",
        "session-1",
        "context-implement",
      );

      expect(execution.status).toBe("paused");
      expect(execution.completedAt).toBeNull();
      expect(execution.haltReason).toBeNull();
    });

    it("rejects reset when the execution is running", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          ...createPausedExecutionWithRunState(),
          status: "running",
        }),
      );

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.resetContext("/repo", "session-1", "context-implement"),
      ).rejects.toThrow(/paused|halted/i);
    });

    it("rejects reset when the target context is already completed", async () => {
      const repository = createRepository(createPausedExecutionWithRunState());

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.resetContext("/repo", "session-1", "context-plan"),
      ).rejects.toThrow(/completed/i);
    });

    it("rejects reset when there is no active execution", async () => {
      const repository = createRepository(null);

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.resetContext("/repo", "session-1", "context-implement"),
      ).rejects.toThrow(
        "Session does not have an active graph workflow execution",
      );
    });
  });

  describe("mutateActive", () => {
    it("applies fn to the latest persisted execution and returns the persisted shape", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: [],
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const result = await manager.mutateActive(
        "/repo",
        "session-1",
        (execution) => {
          const next = structuredClone(execution);
          next.activeContextIds = ["context-plan"];
          return next;
        },
      );

      expect(result.activeContextIds).toEqual(["context-plan"]);
      expect(repository.read()?.activeContextIds).toEqual(["context-plan"]);
    });

    it("serializes concurrent invocations so the second mutator observes the first's effect", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: [],
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const [first, second] = await Promise.all([
        manager.mutateActive("/repo", "session-1", (execution) => {
          const next = structuredClone(execution);
          next.activeContextIds = [...next.activeContextIds, "context-plan"];
          return next;
        }),
        manager.mutateActive("/repo", "session-1", (execution) => {
          const next = structuredClone(execution);
          next.activeContextIds = [
            ...next.activeContextIds,
            "context-implement",
          ];
          return next;
        }),
      ]);

      expect(first.activeContextIds).toEqual(["context-plan"]);
      expect(second.activeContextIds).toEqual([
        "context-plan",
        "context-implement",
      ]);
      expect(repository.read()?.activeContextIds).toEqual([
        "context-plan",
        "context-implement",
      ]);
    });

    it("releases the lock and does not persist when fn throws", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: [],
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.mutateActive("/repo", "session-1", () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(repository.read()?.activeContextIds).toEqual([]);

      const result = await manager.mutateActive(
        "/repo",
        "session-1",
        (execution) => {
          const next = structuredClone(execution);
          next.activeContextIds = ["context-plan"];
          return next;
        },
      );
      expect(result.activeContextIds).toEqual(["context-plan"]);
      expect(repository.read()?.activeContextIds).toEqual(["context-plan"]);
    });

    it("throws when there is no active graph workflow execution", async () => {
      const repository = createRepository(null);
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.mutateActive("/repo", "session-1", (execution) => execution),
      ).rejects.toThrow(
        "Session does not have an active graph workflow execution",
      );
    });
  });

  describe("scheduleEligibleContexts", () => {
    function createSession(
      overrides: Partial<SessionState> = {},
    ): SessionState {
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
        objective: null,
        creationMode: "fast",
        tddEnabled: true,
        targetBranch: "main",
        parentSessionName: null,
        graphWorkflowExecution: null,
        graphWorkflowExecutionHistory: [],
        referenceDocuments: [],
        ...overrides,
      };
    }

    type ProvisionCall = ProvisionInput;

    function createParallelWorktreesStub(options?: {
      failOnContextId?: string;
      failureMessage?: string;
    }): ParallelWorktrees & {
      provisionCalls: ProvisionCall[];
      disposeCalls: DisposeInput[];
    } {
      const provisionCalls: ProvisionCall[] = [];
      const disposeCalls: DisposeInput[] = [];

      async function provision(
        input: ProvisionInput,
      ): Promise<ProvisionResult> {
        provisionCalls.push(input);
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
        disposeCalls.push(input);
        return { status: "removed" };
      }

      return {
        provision,
        provisionBatch,
        dispose,
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
              contextId: "context-plan",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
              mergeStatus: "not-applicable",
              cleanupStatus: "not-applicable",
              lastMergeError: null,
            },
            "context-implement": {
              contextId: "context-implement",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
              mergeStatus: "not-applicable",
              cleanupStatus: "not-applicable",
              lastMergeError: null,
            },
            "context-verify": {
              contextId: "context-verify",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
              mergeStatus: "not-applicable",
              cleanupStatus: "not-applicable",
              lastMergeError: null,
            },
          },
        }),
      );
      const parallelWorktrees = createParallelWorktreesStub();

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession();
        },
      });

      const result = await manager.scheduleEligibleContexts({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.scheduled).toEqual({ kind: "none" });
      expect(result.execution.activeContextIds).toEqual([]);
      expect(parallelWorktrees.provisionCalls).toEqual([]);
    });

    it("schedules a single eligible context inside the session worktree without a sub-worktree", async () => {
      const baseExecution = createWorkflowExecution();
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

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession();
        },
      });

      const result = await manager.scheduleEligibleContexts({
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
      expect(parallelWorktrees.provisionCalls).toEqual([]);
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

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        createExecutionId() {
          return "batch-1";
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      const result = await manager.scheduleEligibleContexts({
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
        "/repo/.worktrees/feature-abc.context-implement",
      );
      expect(implState?.branchName).toBe("csm/feature-abc-context-implement");
      expect(implState?.batchId).toBe(result.scheduled.batchId);

      const verifyState = result.execution.contextStates["context-verify"];
      expect(verifyState?.status).toBe("running");
      expect(verifyState?.isolation).toBe("worktree");
      expect(verifyState?.worktreePath).toBe(
        "/repo/.worktrees/feature-abc.context-verify",
      );
      expect(verifyState?.branchName).toBe("csm/feature-abc-context-verify");
      expect(verifyState?.batchId).toBe(result.scheduled.batchId);

      expect(
        parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
      ).toEqual(["context-implement", "context-verify"]);
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
        failOnContextId: "context-verify",
        failureMessage: "disk full",
      });

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      await expect(
        manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName: "session-1",
        }),
      ).rejects.toThrow(/disk full/);

      expect(parallelWorktrees.disposeCalls.map((c) => c.branchName)).toEqual([
        "csm/feature-abc-context-implement",
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

    it("rejects scheduling before any worktree is created when a contextId is unsafe", async () => {
      const unsafeDefinition = createResolvedWorkflowDefinition({
        executionContexts: [
          {
            id: "context-plan",
            title: "Plan",
            acceptanceCriteria: "Plan complete",
            implementer: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "medium",
            },
            contextValidator: null,
            scriptValidator: { enabled: false },
            mutability: { allowAgentTaskAdd: false },
            circuitBreaker: {},
            iterationPolicy: {
              maxIterations: 4,
              continuity: { enabled: true },
            },
          },
          {
            id: "..escape",
            title: "Bad",
            acceptanceCriteria: "n/a",
            implementer: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "medium",
            },
            contextValidator: null,
            scriptValidator: { enabled: false },
            mutability: { allowAgentTaskAdd: false },
            circuitBreaker: {},
            iterationPolicy: {
              maxIterations: 4,
              continuity: { enabled: true },
            },
          },
          {
            id: "context-other",
            title: "Other",
            acceptanceCriteria: "n/a",
            implementer: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "medium",
            },
            contextValidator: null,
            scriptValidator: { enabled: false },
            mutability: { allowAgentTaskAdd: false },
            circuitBreaker: {},
            iterationPolicy: {
              maxIterations: 4,
              continuity: { enabled: true },
            },
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
              contextId: "context-plan",
              status: "completed",
              totalTaskCount: 1,
              completedTaskCount: 1,
              iterationCount: 1,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
              mergeStatus: "not-applicable",
              cleanupStatus: "not-applicable",
              lastMergeError: null,
            },
            "..escape": {
              contextId: "..escape",
              status: "pending",
              totalTaskCount: 1,
              completedTaskCount: 0,
              iterationCount: 0,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
              mergeStatus: "not-applicable",
              cleanupStatus: "not-applicable",
              lastMergeError: null,
            },
            "context-other": {
              contextId: "context-other",
              status: "pending",
              totalTaskCount: 1,
              completedTaskCount: 0,
              iterationCount: 0,
              consecutiveFailureCount: 0,
              worktreePath: null,
              branchName: null,
              isolation: "session",
              batchId: null,
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

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession({
            worktreePath: "/repo/.worktrees/feature-abc",
            branchName: "csm/feature-abc",
          });
        },
      });

      await expect(
        manager.scheduleEligibleContexts({
          projectPath: "/repo",
          sessionName: "session-1",
        }),
      ).rejects.toThrow(/contextId/i);

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

      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        parallelWorktrees,
        async getSession() {
          return createSession();
        },
      });

      const result = await manager.scheduleEligibleContexts({
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
  });

  describe("recordPendingHaltReason", () => {
    it("sets pendingHaltReason on the active execution and reports accepted=true", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: ["context-implement"],
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const result = await manager.recordPendingHaltReason({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: { type: "recovery_error", message: "boom" },
      });

      expect(result.accepted).toBe(true);
      expect(result.execution.pendingHaltReason).toEqual({
        type: "recovery_error",
        message: "boom",
      });
      expect(repository.read()?.pendingHaltReason).toEqual({
        type: "recovery_error",
        message: "boom",
      });
      expect(repository.read()?.status).toBe("running");
    });

    it("preserves the first reason when called twice (first-failure-wins) and reports accepted=false", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: ["context-implement"],
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const first = await manager.recordPendingHaltReason({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: { type: "recovery_error", message: "first" },
      });
      const second = await manager.recordPendingHaltReason({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: {
          type: "max_iterations",
          contextId: "context-implement",
          iterationCount: 5,
        },
      });

      expect(first.accepted).toBe(true);
      expect(second.accepted).toBe(false);
      expect(second.execution.pendingHaltReason).toEqual({
        type: "recovery_error",
        message: "first",
      });
      expect(repository.read()?.pendingHaltReason).toEqual({
        type: "recovery_error",
        message: "first",
      });
    });

    it("throws when there is no active graph workflow execution", async () => {
      const repository = createRepository(null);
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.recordPendingHaltReason({
          projectPath: "/repo",
          sessionName: "session-1",
          reason: { type: "aborted" },
        }),
      ).rejects.toThrow(
        "Session does not have an active graph workflow execution",
      );
    });

    it("applies applyAdditionalMutation in the same transaction as the pendingHaltReason write (atomicity)", async () => {
      const seeded = createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-implement"],
      });
      seeded.contextStates["context-implement"]!.mergeStatus = "in-progress";
      const repository = createRepository(seeded);

      const recordedSnapshots: Array<{
        mergeStatus: string;
        pendingHaltReason: unknown;
      }> = [];
      const wrappedRepository = {
        ...repository,
        async mutateActive(
          projectPath: string,
          sessionName: string,
          fn: Parameters<typeof repository.mutateActive>[2],
        ) {
          const result = await repository.mutateActive(
            projectPath,
            sessionName,
            fn,
          );
          recordedSnapshots.push({
            mergeStatus:
              result.contextStates["context-implement"]?.mergeStatus ??
              "missing",
            pendingHaltReason: result.pendingHaltReason,
          });
          return result;
        },
      };

      const manager = createGraphWorkflowManager({
        executionRepository: wrappedRepository,
        async loadDefinition() {
          return null;
        },
      });

      const result = await manager.recordPendingHaltReason({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: {
          type: "merge_failure",
          contextId: "context-implement",
          message: "merge failed",
          conflictFiles: [],
        },
        applyAdditionalMutation(execution) {
          const cs = execution.contextStates["context-implement"];
          if (cs) {
            cs.mergeStatus = "merged-failed";
            cs.lastMergeError = "merge failed";
          }
        },
      });

      expect(result.accepted).toBe(true);
      expect(recordedSnapshots).toHaveLength(1);
      expect(recordedSnapshots[0]).toEqual({
        mergeStatus: "merged-failed",
        pendingHaltReason: {
          type: "merge_failure",
          contextId: "context-implement",
          message: "merge failed",
          conflictFiles: [],
        },
      });
      expect(
        repository.read()?.contextStates["context-implement"]?.mergeStatus,
      ).toBe("merged-failed");
      expect(repository.read()?.pendingHaltReason).toEqual({
        type: "merge_failure",
        contextId: "context-implement",
        message: "merge failed",
        conflictFiles: [],
      });
    });

    it("applies applyAdditionalMutation even when first-failure-wins rejects the new reason (secondary failure path)", async () => {
      const seeded = createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan", "context-implement"],
        pendingHaltReason: {
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "retry_exhaustion",
          summary: null,
        },
      });
      seeded.contextStates["context-plan"]!.mergeStatus = "in-progress";
      seeded.contextStates["context-implement"]!.mergeStatus = "in-progress";
      const repository = createRepository(seeded);
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      const result = await manager.recordPendingHaltReason({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: {
          type: "merge_failure",
          contextId: "context-implement",
          message: "second failure",
          conflictFiles: [],
        },
        applyAdditionalMutation(execution) {
          const cs = execution.contextStates["context-implement"];
          if (cs) {
            cs.mergeStatus = "merged-failed";
            cs.lastMergeError = "second failure";
          }
        },
      });

      expect(result.accepted).toBe(false);
      expect(result.execution.pendingHaltReason).toEqual({
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "retry_exhaustion",
        summary: null,
      });
      expect(
        result.execution.contextStates["context-implement"]?.mergeStatus,
      ).toBe("merged-failed");
      expect(
        result.execution.contextStates["context-implement"]?.lastMergeError,
      ).toBe("second failure");
    });
  });

  describe("drainAndHalt", () => {
    it("transitions the execution to halted using the recorded pendingHaltReason and clears the pending field", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: ["context-implement"],
          pendingHaltReason: { type: "recovery_error", message: "drain" },
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
        now: () => "2026-04-02T11:11:11.000Z",
      });

      const result = await manager.drainAndHalt({
        projectPath: "/repo",
        sessionName: "session-1",
      });

      expect(result.status).toBe("halted");
      expect(result.haltReason).toEqual({
        type: "recovery_error",
        message: "drain",
      });
      expect(result.pendingHaltReason).toBeNull();
      expect(result.completedAt).toBe("2026-04-02T11:11:11.000Z");
      expect(repository.read()?.status).toBe("halted");
    });

    it("throws when there is no pendingHaltReason recorded", async () => {
      const repository = createRepository(
        createWorkflowExecution({
          status: "running",
          activeContextIds: ["context-implement"],
          pendingHaltReason: null,
        }),
      );
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.drainAndHalt({
          projectPath: "/repo",
          sessionName: "session-1",
        }),
      ).rejects.toThrow(/pendingHaltReason/);
      expect(repository.read()?.status).toBe("running");
    });

    it("throws when there is no active graph workflow execution", async () => {
      const repository = createRepository(null);
      const manager = createGraphWorkflowManager({
        executionRepository: repository,
        async loadDefinition() {
          return null;
        },
      });

      await expect(
        manager.drainAndHalt({
          projectPath: "/repo",
          sessionName: "session-1",
        }),
      ).rejects.toThrow(
        "Session does not have an active graph workflow execution",
      );
    });
  });
});
