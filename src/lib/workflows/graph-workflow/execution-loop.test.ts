import { describe, expect, it, vi } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  WorkflowSemanticDefinition,
} from "@/types";
import {
  createGraphWorkflowExecutionLoop,
  isExecutionLoopActive,
  _resetActiveLoopsForTesting,
  type GraphWorkflowExecutionLoopDeps,
} from "./execution-loop";
import type { GraphWorkflowIterationResult } from "./iteration-orchestrator";

function createSingleContextDefinition(
  maxIterations: number,
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    executionContexts: [
      {
        id: "ctx-1",
        title: "Do work",
        description: "Single context",
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations, continuity: { enabled: true } },
      },
    ],
    tasks: [
      {
        id: "task-1",
        contextId: "ctx-1",
        order: 1,
        title: "Implement feature",
        instructions: "Do the thing.",
        source: "user" as const,
      },
    ],
    edges: [],
  };
}

function createRunningExecution(
  definition: WorkflowSemanticDefinition,
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return {
    id: "exec-1",
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    workingDefinition: definition,
    status: "running",
    activeContextId: null,
    contextStates: {
      "ctx-1": {
        contextId: "ctx-1",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
      },
    },
    taskStates: {
      "task-1": {
        taskId: "task-1",
        contextId: "ctx-1",
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
    sharedDocuments: [],
    laneStates: {},
    machineSnapshot: null,
    history: [],
    startedAt: "2026-03-27T12:00:00.000Z",
    completedAt: null,
    haltReason: null,
    ...overrides,
  };
}

describe("execution loop", () => {
  it("halts when a context exceeds its maxIterations limit", async () => {
    const definition = createSingleContextDefinition(2);
    let currentExecution = createRunningExecution(definition);
    let iterationCallCount = 0;

    const sendSpy = vi.fn(
      async (
        _projectPath: string,
        _sessionName: string,
        event:
          | { type: "complete" }
          | { type: "halt"; reason: GraphWorkflowHaltReason },
      ): Promise<GraphWorkflowExecution> => {
        if (event.type === "halt") {
          currentExecution = {
            ...structuredClone(currentExecution),
            status: "halted",
            haltReason: event.reason,
            completedAt: "2026-03-27T12:10:00.000Z",
          };
        }
        return currentExecution;
      },
    );

    const deps: GraphWorkflowExecutionLoopDeps = {
      workflowManager: {
        async scheduleNextContext() {
          const next = structuredClone(currentExecution);
          next.activeContextId = "ctx-1";
          next.contextStates["ctx-1"]!.status = "running";
          currentExecution = next;
          return next;
        },
        send: sendSpy,
      },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          iterationCallCount += 1;
          if (iterationCallCount > 3) {
            throw new Error("Safety bail-out: too many iterations");
          }
          const next = structuredClone(currentExecution);
          next.contextStates["ctx-1"]!.iterationCount = iterationCallCount;
          // Agent finished without completing tasks — task stays interrupted
          next.taskStates["task-1"]!.status = "interrupted";
          currentExecution = next;
          return {
            conversationId: `conv-${iterationCallCount}`,
            execution: next,
            shouldContinueInContext: true,
          };
        },
      },
      emitStreamFrame: vi.fn(),
    };

    const loop = createGraphWorkflowExecutionLoop(deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: currentExecution,
    });

    expect(iterationCallCount).toBe(2);
    expect(result.status).toBe("halted");
    expect(result.haltReason).toEqual({
      type: "max_iterations",
      contextId: "ctx-1",
      iterationCount: 2,
    });
    expect(sendSpy).toHaveBeenCalledWith("/repo", "session-1", {
      type: "halt",
      reason: {
        type: "max_iterations",
        contextId: "ctx-1",
        iterationCount: 2,
      },
    });
  });

  it("completes normally when tasks finish before maxIterations", async () => {
    const definition = createSingleContextDefinition(5);
    let currentExecution = createRunningExecution(definition);

    const deps: GraphWorkflowExecutionLoopDeps = {
      workflowManager: {
        async scheduleNextContext() {
          const next = structuredClone(currentExecution);
          if (next.contextStates["ctx-1"]!.status !== "completed") {
            next.activeContextId = "ctx-1";
            next.contextStates["ctx-1"]!.status = "running";
          } else {
            next.activeContextId = null;
          }
          currentExecution = next;
          return next;
        },
        async send(_projectPath, _sessionName, event) {
          if (event.type === "complete") {
            currentExecution = {
              ...structuredClone(currentExecution),
              status: "completed",
              completedAt: "2026-03-27T12:05:00.000Z",
            };
          }
          return currentExecution;
        },
      },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          const next = structuredClone(currentExecution);
          next.contextStates["ctx-1"]!.iterationCount = 1;
          next.contextStates["ctx-1"]!.status = "completed";
          next.taskStates["task-1"]!.status = "completed";
          next.activeContextId = null;
          currentExecution = next;
          return {
            conversationId: "conv-1",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
      emitStreamFrame: vi.fn(),
    };

    const loop = createGraphWorkflowExecutionLoop(deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: currentExecution,
    });

    expect(result.status).toBe("completed");
    expect(result.haltReason).toBeNull();
  });

  it("registers as active while running and deregisters on completion", async () => {
    const definition = createSingleContextDefinition(5);
    let currentExecution = createRunningExecution(definition, {
      activeContextId: "ctx-1",
    });
    let wasActiveDuringIteration = false;

    const deps: GraphWorkflowExecutionLoopDeps = {
      workflowManager: {
        async scheduleNextContext() {
          currentExecution = {
            ...structuredClone(currentExecution),
            activeContextId: null,
          };
          return currentExecution;
        },
        async send(_p, _s, event) {
          if (event.type === "complete") {
            currentExecution = {
              ...structuredClone(currentExecution),
              status: "completed",
              completedAt: "2026-03-27T12:05:00.000Z",
            };
          }
          return currentExecution;
        },
      },
      iterationOrchestrator: {
        async runIteration() {
          wasActiveDuringIteration = isExecutionLoopActive(
            "/repo",
            "session-1",
          );

          const ctx = currentExecution.contextStates["ctx-1"]!;
          currentExecution = {
            ...structuredClone(currentExecution),
            activeContextId: null,
            contextStates: {
              ...currentExecution.contextStates,
              "ctx-1": {
                ...ctx,
                status: "completed",
                completedTaskCount: 1,
              },
            },
          };
          return {
            conversationId: "conv-1",
            execution: currentExecution,
            shouldContinueInContext: false,
          } satisfies GraphWorkflowIterationResult;
        },
      },
      emitStreamFrame: vi.fn(),
    };

    _resetActiveLoopsForTesting();
    expect(isExecutionLoopActive("/repo", "session-1")).toBe(false);

    const loop = createGraphWorkflowExecutionLoop(deps);
    await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: currentExecution,
    });

    expect(wasActiveDuringIteration).toBe(true);
    expect(isExecutionLoopActive("/repo", "session-1")).toBe(false);
  });

  it("retries once when the iteration fails with a stream-closed error", async () => {
    const definition = createSingleContextDefinition(5);
    let currentExecution = createRunningExecution(definition, {
      activeContextId: "ctx-1",
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
        },
      },
      laneStates: {
        implementer: {
          engine: "claude",
          lane: "implementer",
          contextId: "ctx-1",
          sessionRef: {
            engine: "claude",
            lane: "implementer",
            conversationId: "conv-1",
          },
          lastContextTokens: null,
          lastContextWindowMax: null,
          rotateBeforeNextTurn: false,
          limitEvaluation: "disabled",
          lastUsedAt: "2026-03-27T12:00:00.000Z",
        },
      },
    });
    let iterationCallCount = 0;

    const recoverRetryableIterationError = vi.fn(
      async (_projectPath, _sessionName, input) => {
        expect(input).toEqual({
          contextId: "ctx-1",
          errorMessage: "SDK error: MCP error -32000: Stream closed",
        });
        const next = structuredClone(currentExecution);
        next.contextStates["ctx-1"]!.status = "ready";
        const lane = next.laneStates["implementer"];
        if (lane?.engine === "claude") {
          lane.rotateBeforeNextTurn = true;
        }
        currentExecution = next;
        return next;
      },
    );

    const sendSpy = vi.fn(async (_projectPath, _sessionName, event) => {
      if (event.type === "complete") {
        currentExecution = {
          ...structuredClone(currentExecution),
          status: "completed",
          completedAt: "2026-03-27T12:05:00.000Z",
        };
      }
      return currentExecution;
    });

    const deps: GraphWorkflowExecutionLoopDeps = {
      workflowManager: {
        async scheduleNextContext() {
          return currentExecution;
        },
        send: sendSpy,
        recoverRetryableIterationError,
      },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          iterationCallCount += 1;
          if (iterationCallCount === 1) {
            throw new Error("SDK error: MCP error -32000: Stream closed");
          }

          const next = structuredClone(currentExecution);
          next.contextStates["ctx-1"]!.iterationCount = 2;
          next.contextStates["ctx-1"]!.status = "completed";
          next.taskStates["task-1"]!.status = "completed";
          next.taskStates["task-1"]!.completedAt = "2026-03-27T12:03:00.000Z";
          next.contextStates["ctx-1"]!.completedTaskCount = 1;
          next.activeContextId = null;
          currentExecution = next;

          return {
            conversationId: "conv-2",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
      emitStreamFrame: vi.fn(),
    };

    const loop = createGraphWorkflowExecutionLoop(deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: currentExecution,
    });

    expect(iterationCallCount).toBe(2);
    expect(recoverRetryableIterationError).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith("/repo", "session-1", {
      type: "complete",
    });
    expect(result.status).toBe("completed");
  });

  it("retries once when the iteration fails before prompt delivery", async () => {
    const definition = createSingleContextDefinition(5);
    let currentExecution = createRunningExecution(definition, {
      activeContextId: "ctx-1",
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
        },
      },
      laneStates: {
        implementer: {
          engine: "claude",
          lane: "implementer",
          contextId: "ctx-1",
          sessionRef: {
            engine: "claude",
            lane: "implementer",
            conversationId: "conv-1",
          },
          lastContextTokens: null,
          lastContextWindowMax: null,
          rotateBeforeNextTurn: false,
          limitEvaluation: "disabled",
          lastUsedAt: "2026-03-27T12:00:00.000Z",
        },
      },
    });
    let iterationCallCount = 0;

    const recoverRetryableIterationError = vi.fn(
      async (_projectPath, _sessionName, input) => {
        expect(input).toEqual({
          contextId: "ctx-1",
          errorMessage: "SDK error: QuerySession died before prompt delivery",
        });
        const next = structuredClone(currentExecution);
        next.contextStates["ctx-1"]!.status = "ready";
        const lane = next.laneStates["implementer"];
        if (lane?.engine === "claude") {
          lane.rotateBeforeNextTurn = true;
        }
        currentExecution = next;
        return next;
      },
    );

    const sendSpy = vi.fn(async (_projectPath, _sessionName, event) => {
      if (event.type === "complete") {
        currentExecution = {
          ...structuredClone(currentExecution),
          status: "completed",
          completedAt: "2026-03-27T12:05:00.000Z",
        };
      }
      return currentExecution;
    });

    const deps: GraphWorkflowExecutionLoopDeps = {
      workflowManager: {
        async scheduleNextContext() {
          return currentExecution;
        },
        send: sendSpy,
        recoverRetryableIterationError,
      },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          iterationCallCount += 1;
          if (iterationCallCount === 1) {
            throw new Error(
              "SDK error: QuerySession died before prompt delivery",
            );
          }

          const next = structuredClone(currentExecution);
          next.contextStates["ctx-1"]!.iterationCount = 2;
          next.contextStates["ctx-1"]!.status = "completed";
          next.taskStates["task-1"]!.status = "completed";
          next.taskStates["task-1"]!.completedAt = "2026-03-27T12:03:00.000Z";
          next.contextStates["ctx-1"]!.completedTaskCount = 1;
          next.activeContextId = null;
          currentExecution = next;

          return {
            conversationId: "conv-2",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
      emitStreamFrame: vi.fn(),
    };

    const loop = createGraphWorkflowExecutionLoop(deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: currentExecution,
    });

    expect(iterationCallCount).toBe(2);
    expect(recoverRetryableIterationError).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith("/repo", "session-1", {
      type: "complete",
    });
    expect(result.status).toBe("completed");
  });

  it("halts after a second consecutive stream-closed error", async () => {
    const definition = createSingleContextDefinition(5);
    let currentExecution = createRunningExecution(definition, {
      activeContextId: "ctx-1",
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
        },
      },
    });

    const sendSpy = vi.fn(
      async (
        _projectPath: string,
        _sessionName: string,
        event:
          | { type: "complete" }
          | { type: "halt"; reason: GraphWorkflowHaltReason },
      ) => {
        if (event.type === "halt") {
          currentExecution = {
            ...structuredClone(currentExecution),
            status: "halted",
            haltReason: event.reason,
            completedAt: "2026-03-27T12:06:00.000Z",
          };
        }
        return currentExecution;
      },
    );

    const recoverRetryableIterationError = vi.fn(async () => {
      const next = structuredClone(currentExecution);
      next.contextStates["ctx-1"]!.status = "ready";
      currentExecution = next;
      return next;
    });

    const deps: GraphWorkflowExecutionLoopDeps = {
      workflowManager: {
        async scheduleNextContext() {
          return currentExecution;
        },
        send: sendSpy,
        recoverRetryableIterationError,
      },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("SDK error: MCP error -32000: Stream closed");
        },
      },
      emitStreamFrame: vi.fn(),
    };

    const loop = createGraphWorkflowExecutionLoop(deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: currentExecution,
    });

    expect(recoverRetryableIterationError).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith("/repo", "session-1", {
      type: "halt",
      reason: {
        type: "recovery_error",
        message: "SDK error: MCP error -32000: Stream closed",
      },
    });
    expect(result.status).toBe("halted");
  });

  it("halts with circuit_breaker when consecutiveFailureCount reaches threshold", async () => {
    const definition = createSingleContextDefinition(10);
    let currentExecution = createRunningExecution(definition, {
      activeContextId: "ctx-1",
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 2,
        },
      },
    });

    const sendSpy = vi.fn(
      async (
        _projectPath: string,
        _sessionName: string,
        event:
          | { type: "complete" }
          | { type: "halt"; reason: GraphWorkflowHaltReason },
      ) => {
        if (event.type === "halt") {
          currentExecution = {
            ...structuredClone(currentExecution),
            status: "halted",
            haltReason: event.reason,
            completedAt: "2026-03-27T12:10:00.000Z",
          };
        }
        return currentExecution;
      },
    );

    const deps: GraphWorkflowExecutionLoopDeps = {
      workflowManager: {
        async scheduleNextContext() {
          return currentExecution;
        },
        send: sendSpy,
      },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          // Simulate an iteration where validation failed — consecutiveFailureCount
          // was already incremented by the iteration orchestrator to 3 (threshold)
          const next = structuredClone(currentExecution);
          next.contextStates["ctx-1"]!.iterationCount += 1;
          next.contextStates["ctx-1"]!.consecutiveFailureCount = 3;
          currentExecution = next;
          return {
            conversationId: "conv-1",
            execution: next,
            shouldContinueInContext: true,
          };
        },
      },
      emitStreamFrame: vi.fn(),
    };

    const loop = createGraphWorkflowExecutionLoop(deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: currentExecution,
    });

    expect(result.status).toBe("halted");
    expect(sendSpy).toHaveBeenCalledWith("/repo", "session-1", {
      type: "halt",
      reason: {
        type: "circuit_breaker",
        contextId: "ctx-1",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
    });
  });

  it("continues iterating when consecutiveFailureCount is below threshold", async () => {
    const definition = createSingleContextDefinition(10);
    let currentExecution = createRunningExecution(definition, {
      activeContextId: "ctx-1",
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
        },
      },
    });
    let iterationCallCount = 0;

    const sendSpy = vi.fn(async (_projectPath, _sessionName, event) => {
      if (event.type === "complete") {
        currentExecution = {
          ...structuredClone(currentExecution),
          status: "completed",
          completedAt: "2026-03-27T12:05:00.000Z",
        };
      }
      return currentExecution;
    });

    const deps: GraphWorkflowExecutionLoopDeps = {
      workflowManager: {
        async scheduleNextContext() {
          return currentExecution;
        },
        send: sendSpy,
      },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          iterationCallCount += 1;
          const next = structuredClone(currentExecution);
          next.contextStates["ctx-1"]!.iterationCount = iterationCallCount;

          if (iterationCallCount === 1) {
            // First iteration: validation fails, count goes to 1 (below threshold of 3)
            next.contextStates["ctx-1"]!.consecutiveFailureCount = 1;
            currentExecution = next;
            return {
              conversationId: "conv-1",
              execution: next,
              shouldContinueInContext: true,
            };
          }

          // Second iteration: task completes, count resets
          next.contextStates["ctx-1"]!.consecutiveFailureCount = 0;
          next.contextStates["ctx-1"]!.completedTaskCount = 1;
          next.taskStates["task-1"]!.status = "completed";
          next.activeContextId = null;
          currentExecution = next;
          return {
            conversationId: "conv-2",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
      emitStreamFrame: vi.fn(),
    };

    const loop = createGraphWorkflowExecutionLoop(deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: currentExecution,
    });

    expect(iterationCallCount).toBe(2);
    expect(result.status).toBe("completed");
  });
});
