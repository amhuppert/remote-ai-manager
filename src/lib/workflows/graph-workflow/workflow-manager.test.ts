import { describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecution, WorkflowDefinitionRecord } from "@/types";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
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
        workingDefinition: seed.definition,
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
            lastValidationAt: null,
            lastValidationPass: null,
          },
          "context-implement": {
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            lastValidationAt: null,
            lastValidationPass: null,
          },
          "context-verify": {
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            lastValidationAt: null,
            lastValidationPass: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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
            lastValidationAt: null,
            lastValidationPass: null,
          },
          "context-implement": {
            contextId: "context-implement",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            lastValidationAt: null,
            lastValidationPass: null,
          },
          "context-verify": {
            contextId: "context-verify",
            status: "pending",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 0,
            consecutiveFailureCount: 0,
            lastValidationAt: null,
            lastValidationPass: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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
            lastValidationAt: null,
            lastValidationPass: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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
            lastValidationAt: null,
            lastValidationPass: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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
    const branchedDefinition = createWorkflowDefinition({
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
            lastValidationPass: true,
            lastValidationAt: "2026-03-27T15:00:00.000Z",
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

  it("records retry bookkeeping for a failed validation and keeps the same context ready to rerun", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextId: "context-plan",
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "running",
            iterationCount: 1,
          },
        },
        retryState: {
          "context-plan": {
            contextId: "context-plan",
            attempt: 0,
            maxAttempts: 2,
          },
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:15:00.000Z";
      },
    });

    const execution = await manager.recordContextValidationResult(
      "/repo",
      "session-1",
      {
        contextId: "context-plan",
        pass: false,
        summary: "validator blocked completion",
      },
    );

    expect(execution.status).toBe("running");
    expect(execution.activeContextId).toBe("context-plan");
    expect(execution.contextStates["context-plan"]).toMatchObject({
      status: "ready",
      consecutiveFailureCount: 1,
      lastValidationAt: "2026-03-27T15:15:00.000Z",
      lastValidationPass: false,
    });
    expect(execution.retryState["context-plan"]?.attempt).toBe(1);
    expect(execution.haltReason).toBeNull();
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("halts at the validation boundary when the circuit breaker threshold is reached", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextId: "context-implement",
        contextStates: {
          ...baseExecution.contextStates,
          "context-implement": {
            ...baseExecution.contextStates["context-implement"]!,
            status: "running",
            consecutiveFailureCount: 1,
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
      now() {
        return "2026-03-27T15:20:00.000Z";
      },
    });

    const execution = await manager.recordContextValidationResult(
      "/repo",
      "session-1",
      {
        contextId: "context-implement",
        pass: false,
        summary: "tests failed twice",
      },
    );

    expect(execution.status).toBe("halted");
    expect(execution.completedAt).toBe("2026-03-27T15:20:00.000Z");
    expect(execution.contextStates["context-implement"]).toMatchObject({
      status: "halted",
      consecutiveFailureCount: 2,
      lastValidationAt: "2026-03-27T15:20:00.000Z",
      lastValidationPass: false,
    });
    expect(execution.haltReason).toEqual({
      type: "circuit_breaker",
      contextId: "context-implement",
      condition: "retry_exhaustion",
      failureCount: 2,
      summary: "tests failed twice",
    });
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "halted",
      activeContextId: "context-implement",
      recoveryMode: "none",
      hasLiveIteration: false,
    });
  });

  it("resets failure counters after a context passes validation", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextId: "context-plan",
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "running",
            consecutiveFailureCount: 2,
            iterationCount: 2,
            lastValidationPass: false,
          },
        },
        retryState: {
          "context-plan": {
            contextId: "context-plan",
            attempt: 1,
            maxAttempts: 2,
          },
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:25:00.000Z";
      },
    });

    const execution = await manager.recordContextValidationResult(
      "/repo",
      "session-1",
      {
        contextId: "context-plan",
        pass: true,
        summary: "validation passed",
      },
    );

    expect(execution.status).toBe("running");
    expect(execution.activeContextId).toBeNull();
    expect(execution.contextStates["context-plan"]).toMatchObject({
      status: "completed",
      completedTaskCount: 1,
      consecutiveFailureCount: 0,
      lastValidationAt: "2026-03-27T15:25:00.000Z",
      lastValidationPass: true,
    });
    expect(execution.retryState["context-plan"]?.attempt).toBe(0);
    expect(execution.haltReason).toBeNull();
  });

  it("halts when retry attempts are exhausted after repeated validation failures", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextId: "context-plan",
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "running",
            iterationCount: 2,
            consecutiveFailureCount: 1,
          },
        },
        retryState: {
          "context-plan": {
            contextId: "context-plan",
            attempt: 1,
            maxAttempts: 2,
          },
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:30:00.000Z";
      },
    });

    const execution = await manager.recordContextValidationResult(
      "/repo",
      "session-1",
      {
        contextId: "context-plan",
        pass: false,
        summary: "still failing after retries",
      },
    );

    expect(execution.status).toBe("halted");
    expect(execution.completedAt).toBe("2026-03-27T15:30:00.000Z");
    expect(execution.activeContextId).toBe("context-plan");
    expect(execution.contextStates["context-plan"]).toMatchObject({
      status: "halted",
      consecutiveFailureCount: 2,
      lastValidationAt: "2026-03-27T15:30:00.000Z",
      lastValidationPass: false,
    });
    expect(execution.retryState["context-plan"]?.attempt).toBe(2);
    expect(execution.haltReason).toEqual({
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      failureCount: 2,
      summary: "still failing after retries",
    });
    expect(execution.machineSnapshot).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "halted",
      activeContextId: "context-plan",
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
            lastValidationAt: "2026-03-27T15:30:00.000Z",
            lastValidationPass: false,
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
        retryState: {
          "context-plan": {
            contextId: "context-plan",
            attempt: 2,
            maxAttempts: 2,
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
    expect(execution.retryState["context-plan"]?.attempt).toBe(0);
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
            lastValidationAt: null,
            lastValidationPass: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
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

  it("reopens completed tasks listed in reopenTaskIds on validation failure", async () => {
    const baseExecution = createWorkflowExecution();
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextId: "context-plan",
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "running",
            iterationCount: 1,
            completedTaskCount: 1,
          },
        },
        taskStates: {
          ...baseExecution.taskStates,
          "task-plan-1": {
            ...baseExecution.taskStates["task-plan-1"]!,
            status: "completed",
            summary: "Did the thing",
            completedAt: "2026-03-27T15:00:00.000Z",
            lastConversationId: "conversation-1",
          },
        },
        retryState: {
          "context-plan": {
            contextId: "context-plan",
            attempt: 0,
            maxAttempts: 2,
          },
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:15:00.000Z";
      },
    });

    const execution = await manager.recordContextValidationResult(
      "/repo",
      "session-1",
      {
        contextId: "context-plan",
        pass: false,
        summary: "Task needs rework",
        reopenTaskIds: ["task-plan-1"],
        issues: [
          {
            title: "Missing edge case",
            description: "The implementation misses an edge case",
          },
        ],
      },
    );

    expect(execution.status).toBe("running");
    expect(execution.contextStates["context-plan"]).toMatchObject({
      status: "ready",
      completedTaskCount: 0,
    });
    expect(execution.taskStates["task-plan-1"]).toMatchObject({
      status: "pending",
      reopenedCount: 1,
      lastReopenedAt: "2026-03-27T15:15:00.000Z",
      summary: null,
      completedAt: null,
    });
  });

  it("creates fix tasks from validator issues on validation failure", async () => {
    const definition = createWorkflowDefinition({
      executionContexts: [
        {
          id: "context-plan",
          title: "Plan",
          description: "Plan the implementation",
          agent: { model: "opus", reasoningEffort: "high" },
          mutability: { allowAgentTaskAdd: true },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 4, continuity: { enabled: true } },
          contextValidation: {
            agentValidator: {
              type: "claude",
              enabled: true,
              continuity: { enabled: true },
              agent: { model: "opus", reasoningEffort: "medium" },
              instructions: "Validate the work.",
            },
            onFail: {
              mode: "retry",
              retryScope: "same_context" as const,
              maxAttempts: 2,
            },
          },
        },
      ],
      tasks: [
        {
          id: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          title: "Inspect code",
          instructions: "Read the relevant files.",
          source: "user" as const,
        },
      ],
      edges: [],
    });
    const baseExecution = createWorkflowExecution({
      workingDefinition: definition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextId: "context-plan",
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            lastValidationAt: null,
            lastValidationPass: null,
          },
        },
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "completed",
            summary: "Did the thing",
            startedAt: "2026-03-27T15:00:00.000Z",
            completedAt: "2026-03-27T15:05:00.000Z",
            lastConversationId: "conversation-1",
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
          },
        },
        retryState: {
          "context-plan": {
            contextId: "context-plan",
            attempt: 0,
            maxAttempts: 2,
          },
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:15:00.000Z";
      },
    });

    const execution = await manager.recordContextValidationResult(
      "/repo",
      "session-1",
      {
        contextId: "context-plan",
        pass: false,
        summary: "Two issues found",
        issues: [
          {
            title: "Missing error handling",
            description: "Add try/catch around the API call",
          },
          {
            title: "No tests",
            description: "Add unit tests for the new function",
          },
        ],
        reopenTaskIds: [],
      },
    );

    expect(execution.status).toBe("running");
    // Two new fix tasks should have been added
    const contextTasks = execution.workingDefinition.tasks.filter(
      (t) => t.contextId === "context-plan",
    );
    expect(contextTasks).toHaveLength(3); // 1 original + 2 fix tasks
    const fixTasks = contextTasks.filter((t) => t.source === "validator");
    expect(fixTasks).toHaveLength(2);
    expect(fixTasks[0]!.title).toBe("Fix: Missing error handling");
    expect(fixTasks[0]!.instructions).toBe("Add try/catch around the API call");
    expect(fixTasks[1]!.title).toBe("Fix: No tests");

    // Fix tasks should have task states
    for (const fixTask of fixTasks) {
      const state = execution.taskStates[fixTask.id];
      expect(state).toBeDefined();
      expect(state!.status).toBe("pending");
      expect(state!.contextId).toBe("context-plan");
    }

    // Context counts should be updated
    expect(execution.contextStates["context-plan"]).toMatchObject({
      status: "ready",
      totalTaskCount: 3,
      completedTaskCount: 1,
    });
  });

  it("creates fallback fix task when validation fails with empty issues and reopenTaskIds", async () => {
    const definition = createWorkflowDefinition({
      executionContexts: [
        {
          id: "context-plan",
          title: "Plan",
          description: "Plan the implementation",
          agent: { model: "opus", reasoningEffort: "high" },
          mutability: { allowAgentTaskAdd: true },
          circuitBreaker: {},
          iterationPolicy: { maxIterations: 4, continuity: { enabled: true } },
          contextValidation: {
            onFail: {
              mode: "retry",
              retryScope: "same_context" as const,
              maxAttempts: 3,
            },
          },
        },
      ],
      tasks: [
        {
          id: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          title: "Implement feature",
          instructions: "Do the thing.",
          source: "user" as const,
        },
      ],
      edges: [],
    });
    const baseExecution = createWorkflowExecution({
      workingDefinition: definition,
    });
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextId: "context-plan",
        contextStates: {
          "context-plan": {
            contextId: "context-plan",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 1,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            lastValidationAt: null,
            lastValidationPass: null,
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
            reopenedCount: 0,
            lastReopenedAt: null,
            failureMessage: null,
          },
        },
        retryState: {
          "context-plan": {
            contextId: "context-plan",
            attempt: 0,
            maxAttempts: 3,
          },
        },
      }),
    );

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:15:00.000Z";
      },
    });

    const execution = await manager.recordContextValidationResult(
      "/repo",
      "session-1",
      {
        contextId: "context-plan",
        pass: false,
        summary: "Pre-merge validation failed",
        issues: [],
        reopenTaskIds: [],
        scriptOutput: "Error: tests failed\nexit code 1",
        scriptOutputDocumentPath:
          ".cc/graph-workflow-docs/validation-output-context-plan.txt",
      },
    );

    // Retry should be authorized (not halted)
    expect(execution.status).toBe("running");
    expect(execution.contextStates["context-plan"]?.status).toBe("ready");

    // A fallback fix task must exist so the retry has something to iterate on
    const contextTasks = execution.workingDefinition.tasks.filter(
      (t) => t.contextId === "context-plan",
    );
    const fixTasks = contextTasks.filter((t) => t.source === "validator");
    expect(fixTasks).toHaveLength(1);
    expect(fixTasks[0]!.title).toBe("Fix: Fix validation failures");
    expect(fixTasks[0]!.instructions).toContain(
      ".cc/graph-workflow-docs/validation-output-context-plan.txt",
    );

    // Fix task should have a pending task state
    const fixTaskState = execution.taskStates[fixTasks[0]!.id];
    expect(fixTaskState).toBeDefined();
    expect(fixTaskState!.status).toBe("pending");

    // Shared document should be registered
    expect(execution.sharedDocuments).toHaveLength(1);
    expect(execution.sharedDocuments[0]).toMatchObject({
      id: "validation-output-context-plan",
      relativePath:
        ".cc/graph-workflow-docs/validation-output-context-plan.txt",
    });

    // Context counts should reflect the new task
    expect(execution.contextStates["context-plan"]).toMatchObject({
      totalTaskCount: 2,
      completedTaskCount: 1,
    });
  });

  it("passes issues and reopenTaskIds through to the validation result event", async () => {
    const baseExecution = createWorkflowExecution();
    const publishedEvents: Array<{
      issues: unknown[];
      reopenTaskIds: string[];
    }> = [];
    const repository = createRepository(
      createWorkflowExecution({
        ...baseExecution,
        status: "running",
        activeContextId: "context-plan",
        contextStates: {
          ...baseExecution.contextStates,
          "context-plan": {
            ...baseExecution.contextStates["context-plan"]!,
            status: "running",
            iterationCount: 1,
            completedTaskCount: 1,
          },
        },
        taskStates: {
          ...baseExecution.taskStates,
          "task-plan-1": {
            ...baseExecution.taskStates["task-plan-1"]!,
            status: "completed",
            summary: "Done",
            completedAt: "2026-03-27T15:00:00.000Z",
          },
        },
        retryState: {
          "context-plan": {
            contextId: "context-plan",
            attempt: 0,
            maxAttempts: 2,
          },
        },
      }),
    );

    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast(event) {
        if (event.type === "graph-workflow-validation-result") {
          publishedEvents.push({
            issues: event.issues,
            reopenTaskIds: event.reopenTaskIds,
          });
        }
      },
    });

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now() {
        return "2026-03-27T15:15:00.000Z";
      },
      eventPublisher,
    });

    await manager.recordContextValidationResult("/repo", "session-1", {
      contextId: "context-plan",
      pass: false,
      summary: "Issues found",
      issues: [{ title: "Bug", description: "Fix the bug" }],
      reopenTaskIds: ["task-plan-1"],
    });

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]!.issues).toEqual([
      { title: "Bug", description: "Fix the bug" },
    ]);
    expect(publishedEvents[0]!.reopenTaskIds).toEqual(["task-plan-1"]);
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
          lastValidationAt: "2026-03-27T15:00:00.000Z",
          lastValidationPass: true,
        },
        "context-implement": {
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          lastValidationAt: null,
          lastValidationPass: null,
        },
        "context-verify": {
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          lastValidationAt: null,
          lastValidationPass: null,
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
