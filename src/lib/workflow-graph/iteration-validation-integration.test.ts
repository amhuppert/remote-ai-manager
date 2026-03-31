import { describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecution } from "@/types";
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
): InMemoryExecutionRepository & { read(): GraphWorkflowExecution } {
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
  };
}

describe("graph workflow iteration validation integration", () => {
  it("surfaces task-validator feedback without marking the task complete", async () => {
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (context) =>
          context.id === "context-plan"
            ? {
                ...context,
                taskValidation: {
                  enabled: true,
                  autoCreateFixTasks: false,
                  agent: {
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

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createToolServer: vi.fn((input) => {
        toolInput = input;
        return { server: { id: "tool-server" } };
      }),
      runAgentIteration: vi.fn(async () => {
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
          failureMessage: expect.stringContaining(
            "Missing validation artifact",
          ),
        });
        return { contextTokens: null, contextWindowMax: null };
      }),
      validationService: {
        async validateTaskCompletion() {
          return {
            pass: false,
            summary: "Validation failed",
            issues: [
              {
                title: "Missing validation artifact",
                description:
                  "Add the evidence file before completing the task.",
              },
            ],
            reopenTaskIds: [],
            feedback:
              "Task validation blocked completion.\n- Missing validation artifact: Add the evidence file before completing the task.",
          };
        },
        async validateContextCompletion() {
          return {
            pass: true,
            summary: "unused",
            feedback: "unused",
            issues: [],
            reopenTaskIds: [],
            agentResult: null,
            scriptResult: null,
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
    expect(result.shouldValidateContext).toBe(false);
    expect(result.execution.taskStates["task-plan-1"]).toMatchObject({
      status: "pending",
      failureMessage: expect.stringContaining("Missing validation artifact"),
    });
  });
});
