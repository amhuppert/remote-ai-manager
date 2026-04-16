import { describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecution, GraphWorkflowHaltReason } from "@/types";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import {
  createGraphWorkflowIterationOrchestrator,
  type GraphWorkflowIterationToolServerInput,
} from "@/lib/workflows/graph-workflow/iteration-orchestrator";

interface InMemoryExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void>;
}

function createRepository(
  initialExecution: GraphWorkflowExecution,
): InMemoryExecutionRepository & {
  read(): GraphWorkflowExecution;
  write(execution: GraphWorkflowExecution): void;
} {
  let activeExecution = initialExecution;

  return {
    async getActive() {
      return activeExecution;
    },
    async update(_projectPath, _sessionName, execution) {
      activeExecution = execution;
    },
    read() {
      return activeExecution;
    },
    write(execution) {
      activeExecution = execution;
    },
  };
}

function createValidatorEnabledExecution(
  circuitBreaker: { consecutiveFailureThreshold?: number } = {},
) {
  const definition = createWorkflowDefinition({
    executionContexts: createWorkflowDefinition().executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? {
              ...context,
              circuitBreaker,
              taskValidation: {
                type: "claude",
                enabled: true,
                continuity: { enabled: true },
                agent: {
                  backend: "claude",
                  model: "sonnet",
                  reasoningEffort: "medium",
                },
                instructions: "Review task output before completion.",
              },
            }
          : context,
    ),
  });
  return createWorkflowExecution({
    status: "running",
    activeContextId: "context-plan",
    workingDefinition: definition,
    contextStates: {
      ...createWorkflowExecution().contextStates,
      "context-plan": {
        ...createWorkflowExecution().contextStates["context-plan"]!,
        status: "running",
        iterationCount: 0,
      },
    },
  });
}

describe("graph workflow iteration validation integration", () => {
  it("surfaces task-validator feedback without marking the task complete", async () => {
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (context) =>
          context.id === "context-plan"
            ? {
                ...context,
                circuitBreaker: { consecutiveFailureThreshold: 10 },
                taskValidation: {
                  type: "claude",
                  enabled: true,
                  continuity: { enabled: true },
                  agent: {
                    backend: "claude",
                    model: "sonnet",
                    reasoningEffort: "medium",
                  },
                  instructions: "Review task output before completion.",
                },
              }
            : context,
      ),
    });
    const repository = createRepository(
      createWorkflowExecution({
        status: "running",
        activeContextId: "context-plan",
        workingDefinition: definition,
        contextStates: {
          ...createWorkflowExecution().contextStates,
          "context-plan": {
            ...createWorkflowExecution().contextStates["context-plan"]!,
            status: "running",
            iterationCount: 0,
          },
        },
      }),
    );

    let toolInput: GraphWorkflowIterationToolServerInput | null = null;
    const createConversation = async () => ({ id: "conversation-1" });
    const createToolServer = (input: GraphWorkflowIterationToolServerInput) => {
      toolInput = input;
      return { server: { id: "tool-server" } };
    };
    const runAgentIteration = async () => {
      if (!toolInput) {
        throw new Error("Tool server input was not captured");
      }

      let thrown: Error | null = null;
      try {
        await toolInput.completeTask("task-plan-1", "Finished planning.");
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown?.message).toContain("Task validation blocked completion");
      expect(repository.read().taskStates["task-plan-1"]).toMatchObject({
        status: "pending",
        failureMessage: expect.stringContaining("Missing validation artifact"),
      });
      return { contextTokens: null, contextWindowMax: null };
    };

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: {
        async validateTaskCompletion() {
          return {
            kind: "fail" as const,
            summary: "Validation failed",
            issues: [
              {
                title: "Missing validation artifact",
                description:
                  "Add the evidence file before completing the task.",
              },
            ],
            feedback:
              "Task validation blocked completion.\n- Missing validation artifact: Add the evidence file before completing the task.",
          };
        },
      },
      now() {
        return "2026-03-27T16:30:00.000Z";
      },
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(result.shouldContinueInContext).toBe(true);
    expect(result.execution.taskStates["task-plan-1"]).toMatchObject({
      status: "pending",
      failureMessage: expect.stringContaining("Missing validation artifact"),
    });
  });

  it("halts execution with validator_infra_error and does NOT increment consecutiveFailureCount when validator returns infra_error", async () => {
    const repository = createRepository(createValidatorEnabledExecution());

    const signalHalt = vi.fn(
      async ({ reason }: { reason: GraphWorkflowHaltReason }) => {
        const current = repository.read();
        const halted: GraphWorkflowExecution = {
          ...current,
          status: "halted",
          haltReason: reason,
          completedAt: "2026-03-27T16:30:00.000Z",
        };
        repository.write(halted);
        return halted;
      },
    );

    let toolInput: GraphWorkflowIterationToolServerInput | null = null;
    const runAgentIteration = async () => {
      if (!toolInput) throw new Error("Tool server input was not captured");
      let thrown: Error | null = null;
      try {
        await toolInput.completeTask("task-plan-1", "Finished planning.");
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown).not.toBeNull();
      return { contextTokens: null, contextWindowMax: null };
    };

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation: async () => ({ id: "conversation-1" }),
      createToolServer: (input) => {
        toolInput = input;
        return { server: { id: "tool-server" } };
      },
      runAgentIteration,
      signalHalt,
      validationService: {
        async validateTaskCompletion() {
          return {
            kind: "infra_error" as const,
            reason: "exception" as const,
            message: "Codex API rate limit exceeded",
            engine: "codex" as const,
            sessionRef: null,
            reviewArtifact: null,
          };
        },
      },
      now: () => "2026-03-27T16:30:00.000Z",
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(signalHalt).toHaveBeenCalledTimes(1);
    expect(signalHalt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.objectContaining({
          type: "validator_infra_error",
          engine: "codex",
          infraReason: "exception",
          message: "Codex API rate limit exceeded",
          contextId: "context-plan",
          taskId: "task-plan-1",
        }),
      }),
    );
    expect(result.shouldContinueInContext).toBe(false);
    expect(result.execution.status).toBe("halted");
    expect(result.execution.haltReason?.type).toBe("validator_infra_error");
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(0);
  });

  it("halts execution with circuit_breaker when consecutive failures cross the threshold mid-iteration", async () => {
    const repository = createRepository(
      createValidatorEnabledExecution({ consecutiveFailureThreshold: 3 }),
    );

    const signalHalt = vi.fn(
      async ({ reason }: { reason: GraphWorkflowHaltReason }) => {
        const current = repository.read();
        const halted: GraphWorkflowExecution = {
          ...current,
          status: "halted",
          haltReason: reason,
          completedAt: "2026-03-27T16:30:00.000Z",
        };
        repository.write(halted);
        return halted;
      },
    );

    let toolInput: GraphWorkflowIterationToolServerInput | null = null;
    const runAgentIteration = async () => {
      if (!toolInput) throw new Error("Tool server input was not captured");
      try {
        await toolInput.completeTask("task-plan-1", "Finished planning.");
      } catch {
        // swallow validation/halt errors; orchestrator drives next turns
      }
      return { contextTokens: null, contextWindowMax: null };
    };

    const validateTaskCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Validation failed",
      issues: [
        {
          title: "Missing artifact",
          description: "Add the evidence file.",
        },
      ],
      feedback:
        "Task validation blocked completion.\n- Missing artifact: Add the evidence file.",
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation: async () => ({ id: "conversation-1" }),
      createToolServer: (input) => {
        toolInput = input;
        return { server: { id: "tool-server" } };
      },
      runAgentIteration,
      signalHalt,
      validationService: {
        validateTaskCompletion,
      },
      now: () => "2026-03-27T16:30:00.000Z",
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Validator ran exactly 3 times before breaker tripped (follow-ups beyond that are skipped)
    expect(validateTaskCompletion).toHaveBeenCalledTimes(3);
    expect(signalHalt).toHaveBeenCalledTimes(1);
    expect(signalHalt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.objectContaining({
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "retry_exhaustion",
          failureCount: 3,
        }),
      }),
    );
    expect(result.shouldContinueInContext).toBe(false);
    expect(result.execution.status).toBe("halted");
    expect(result.execution.haltReason?.type).toBe("circuit_breaker");
  });

  it("keeps execution running and increments counter to 1 when validator fails once (below threshold)", async () => {
    const repository = createRepository(
      createValidatorEnabledExecution({ consecutiveFailureThreshold: 10 }),
    );

    const signalHalt = vi.fn();

    let toolInput: GraphWorkflowIterationToolServerInput | null = null;
    let completeTaskCalled = false;
    const runAgentIteration = async () => {
      if (!toolInput) throw new Error("Tool server input was not captured");
      if (!completeTaskCalled) {
        completeTaskCalled = true;
        try {
          await toolInput.completeTask("task-plan-1", "Finished planning.");
        } catch {
          // intentionally swallow fail error
        }
      }
      return { contextTokens: null, contextWindowMax: null };
    };

    const validateTaskCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Validation failed",
      issues: [
        {
          title: "Missing artifact",
          description: "Add the evidence file.",
        },
      ],
      feedback:
        "Task validation blocked completion.\n- Missing artifact: Add the evidence file.",
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation: async () => ({ id: "conversation-1" }),
      createToolServer: (input) => {
        toolInput = input;
        return { server: { id: "tool-server" } };
      },
      runAgentIteration,
      signalHalt,
      validationService: {
        validateTaskCompletion,
      },
      now: () => "2026-03-27T16:30:00.000Z",
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(validateTaskCompletion).toHaveBeenCalledTimes(1);
    expect(signalHalt).not.toHaveBeenCalled();
    expect(result.execution.status).toBe("running");
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);
  });
});
