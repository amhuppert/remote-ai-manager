import { describe, expect, it, vi } from "vitest";
import type {
  GraphWorkflowExecution,
  ResolvedWorkflowSemanticDefinition,
  WorkflowDefinitionRecord,
} from "@/types";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
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
}

function createRepository(
  initialExecution: GraphWorkflowExecution | null = null,
): InMemoryExecutionRepository & { read(): GraphWorkflowExecution | null } {
  let activeExecution = initialExecution;

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
        activeContextId: "context-plan",
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
          },
          "context-implement": {
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
          },
          "context-verify": {
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
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
        activeContextId: "context-plan",
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 2,
            consecutiveFailureCount: 0,
          },
          "context-implement": {
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
          },
          "context-verify": {
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
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
        activeContextId: "context-plan",
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
        activeContextId: "context-plan",
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
          },
          "context-implement": {
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
          },
          "context-verify": {
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
          },
        },
        laneStates: {
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
    expect(execution.laneStates["implementer"]).toMatchObject({
      rotateBeforeNextTurn: true,
      lastUsedAt: "2026-03-27T15:07:00.000Z",
    });
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
        activeContextId: "context-plan",
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
          },
          "context-implement": {
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
          },
          "context-verify": {
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
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
        activeContextId: "context-plan",
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
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
        activeContextId: "context-plan",
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "ready",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 1,
            consecutiveFailureCount: 0,
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

    expect(execution.activeContextId).toBe("context-implement");
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
        activeContextId: "context-plan",
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
    expect(execution.activeContextId).toBe("context-plan");
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

  it("resumes an aborted execution, clearing abort reason and preserving interrupted tasks", async () => {
    const repository = createRepository(
      createWorkflowExecution({
        status: "aborted",
        activeContextId: "context-plan",
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

    const execution = await manager.resume("/repo", "session-1");

    expect(execution.status).toBe("running");
    expect(execution.completedAt).toBeNull();
    expect(execution.haltReason).toBeNull();
    expect(execution.taskStates["task-plan-1"]?.status).toBe("interrupted");
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "interrupted_task",
      hasLiveIteration: false,
    });
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
      activeContextId: null,
      laneStates: {
        implementer: {
          engine: "claude",
          lane: "implementer",
          contextId: "context-plan",
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
      contextStates: {
        "context-plan": {
          contextId: "context-plan",
          status: "completed",
          totalTaskCount: 1,
          completedTaskCount: 1,
          iterationCount: 1,
          consecutiveFailureCount: 0,
        },
        "context-implement": {
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
        },
        "context-verify": {
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
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
});
