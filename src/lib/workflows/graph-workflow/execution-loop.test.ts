import { describe, expect, it, vi } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  SessionState,
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
        agent: { model: "sonnet", reasoningEffort: "medium" },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations },
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
        lastValidationAt: null,
        lastValidationPass: null,
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
        reopenedCount: 0,
        lastReopenedAt: null,
        failureMessage: null,
      },
    },
    retryState: {},
    sharedDocuments: [],
    machineSnapshot: null,
    history: [],
    startedAt: "2026-03-27T12:00:00.000Z",
    completedAt: null,
    haltReason: null,
    ...overrides,
  };
}

describe("execution loop", () => {
  it(
    "halts when a context exceeds its maxIterations limit",
    { timeout: 5000 },
    async () => {
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
          recordContextValidationResult: vi.fn(),
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
              shouldValidateContext: false,
            };
          },
        },
        validationService: {
          async validateContextCompletion() {
            return {
              pass: true,
              summary: "passed",
              feedback: "passed",
              issues: [],
              reopenTaskIds: [],
              agentResult: null,
              scriptResult: null,
            };
          },
        },
        async getSession() {
          return { worktreePath: "/repo", branchName: "main" } as SessionState;
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
    },
  );

  it(
    "completes normally when tasks finish before maxIterations",
    { timeout: 5000 },
    async () => {
      const definition = createSingleContextDefinition(5);
      let currentExecution = createRunningExecution(definition);

      const deps: GraphWorkflowExecutionLoopDeps = {
        workflowManager: {
          async scheduleNextContext() {
            const next = structuredClone(currentExecution);
            // Only schedule if context is not already completed
            if (next.contextStates["ctx-1"]!.status !== "completed") {
              next.activeContextId = "ctx-1";
              next.contextStates["ctx-1"]!.status = "running";
            } else {
              next.activeContextId = null;
            }
            currentExecution = next;
            return next;
          },
          async recordContextValidationResult(
            _projectPath,
            _sessionName,
            result,
          ) {
            const next = structuredClone(currentExecution);
            next.contextStates["ctx-1"]!.status = "completed";
            next.contextStates["ctx-1"]!.lastValidationPass = result.pass;
            next.activeContextId = null;
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
            next.taskStates["task-1"]!.status = "completed";
            currentExecution = next;
            return {
              conversationId: "conv-1",
              execution: next,
              shouldContinueInContext: false,
              shouldValidateContext: true,
            };
          },
        },
        validationService: {
          async validateContextCompletion() {
            return {
              pass: true,
              summary: "passed",
              feedback: "passed",
              issues: [],
              reopenTaskIds: [],
              agentResult: null,
              scriptResult: null,
            };
          },
        },
        async getSession() {
          return { worktreePath: "/repo", branchName: "main" } as SessionState;
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
    },
  );

  it(
    "registers as active while running and deregisters on completion",
    { timeout: 5000 },
    async () => {
      const definition = createSingleContextDefinition(5);
      let currentExecution = createRunningExecution(definition, {
        activeContextId: "ctx-1",
      });
      let wasActiveDuringIteration = false;

      const deps: GraphWorkflowExecutionLoopDeps = {
        workflowManager: {
          async scheduleNextContext() {
            // No more contexts to schedule — all done
            currentExecution = {
              ...structuredClone(currentExecution),
              activeContextId: null,
            };
            return currentExecution;
          },
          async recordContextValidationResult() {
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
            // Check the registry while the loop is running
            wasActiveDuringIteration = isExecutionLoopActive(
              "/repo",
              "session-1",
            );

            // Complete all tasks so context is done
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
              shouldValidateContext: false,
            } satisfies GraphWorkflowIterationResult;
          },
        },
        validationService: {
          async validateContextCompletion() {
            return {
              pass: true,
              summary: "passed",
              feedback: "passed",
              issues: [],
              reopenTaskIds: [],
              agentResult: null,
              scriptResult: null,
            };
          },
        },
        async getSession() {
          return {
            worktreePath: "/repo",
            branchName: "main",
          } as SessionState;
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
    },
  );

  it(
    "passes validation issues, reopenTaskIds, and autoCreateFixTasks to recordContextValidationResult",
    { timeout: 5000 },
    async () => {
      const definition: WorkflowSemanticDefinition = {
        schemaVersion: 1,
        executionContexts: [
          {
            id: "ctx-1",
            title: "Do work",
            description: "Single context",
            agent: { model: "sonnet", reasoningEffort: "medium" },
            mutability: { allowAgentTaskAdd: false },
            circuitBreaker: {},
            iterationPolicy: { maxIterations: 3 },
            contextValidation: {
              agentValidator: {
                type: "claude",
                enabled: true,
                autoCreateFixTasks: true,
                agent: { model: "opus", reasoningEffort: "medium" },
                instructions: "Validate the work.",
              },
              onFail: {
                mode: "retry" as const,
                retryScope: "same_context" as const,
                maxAttempts: 2,
              },
            },
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

      let currentExecution = createRunningExecution(definition);
      const recordedResults: Array<{
        contextId: string;
        pass: boolean;
        issues?: unknown[];
        reopenTaskIds?: string[];
        autoCreateFixTasks?: boolean;
      }> = [];

      const deps: GraphWorkflowExecutionLoopDeps = {
        workflowManager: {
          async scheduleNextContext() {
            const next = structuredClone(currentExecution);
            next.activeContextId = "ctx-1";
            next.contextStates["ctx-1"]!.status = "running";
            currentExecution = next;
            return next;
          },
          async recordContextValidationResult(
            _projectPath,
            _sessionName,
            result,
          ) {
            recordedResults.push(structuredClone(result));
            const next = structuredClone(currentExecution);
            // Simulate halt after recording (not the point of this test)
            next.status = "halted";
            next.haltReason = {
              type: "circuit_breaker",
              contextId: "ctx-1",
              condition: "retry_exhaustion",
              summary: result.summary ?? null,
              failureCount: 2,
            };
            currentExecution = next;
            return next;
          },
          async send(_projectPath, _sessionName, _event) {
            return currentExecution;
          },
        },
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            const next = structuredClone(currentExecution);
            next.contextStates["ctx-1"]!.iterationCount = 1;
            next.taskStates["task-1"]!.status = "completed";
            currentExecution = next;
            return {
              conversationId: "conv-1",
              execution: next,
              shouldContinueInContext: false,
              shouldValidateContext: true,
            };
          },
        },
        validationService: {
          async validateContextCompletion() {
            return {
              pass: false,
              summary: "Found issues",
              feedback: "Task needs rework.",
              issues: [
                {
                  title: "Missing tests",
                  description: "Add unit tests.",
                },
              ],
              reopenTaskIds: ["task-1"],
              agentResult: null,
              scriptResult: null,
            };
          },
        },
        async getSession() {
          return { worktreePath: "/repo", branchName: "main" } as SessionState;
        },
        emitStreamFrame: vi.fn(),
      };

      const loop = createGraphWorkflowExecutionLoop(deps);
      await loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: currentExecution,
      });

      expect(recordedResults).toHaveLength(1);
      expect(recordedResults[0]).toMatchObject({
        contextId: "ctx-1",
        pass: false,
        summary: "Found issues",
        issues: [{ title: "Missing tests", description: "Add unit tests." }],
        reopenTaskIds: ["task-1"],
        autoCreateFixTasks: true,
      });
    },
  );
});
