import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import { createGraphWorkflowValidationService } from "./execution-validation";
import type { ValidatorRunResult } from "./validator-runner";

function buildExecutionWithTaskValidator() {
  const definition = createWorkflowDefinition({
    executionContexts: createWorkflowDefinition().executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? {
              ...context,
              taskValidation: {
                type: "claude",
                enabled: true,
                continuity: { enabled: true },
                agent: {
                  backend: "claude",
                  model: "sonnet",
                  reasoningEffort: "medium",
                },
                instructions: "Review task completion before it can close.",
              },
            }
          : context,
    ),
    tasks: [
      {
        id: "task-plan-1",
        contextId: "context-plan",
        order: 1,
        title: "Inspect code",
        instructions: "Read the relevant files.",
        source: "user",
      },
      {
        id: "task-plan-2",
        contextId: "context-plan",
        order: 2,
        title: "Write plan",
        instructions: "Document the plan.",
        source: "user",
      },
      ...createWorkflowDefinition().tasks.filter(
        (task) => task.contextId !== "context-plan",
      ),
    ],
  });
  const execution = createWorkflowExecution({
    workingDefinition: definition,
    contextStates: {
      ...createWorkflowExecution().contextStates,
      "context-plan": {
        ...createWorkflowExecution().contextStates["context-plan"]!,
        totalTaskCount: 2,
        completedTaskCount: 1,
      },
    },
    taskStates: {
      ...createWorkflowExecution().taskStates,
      "task-plan-1": {
        ...createWorkflowExecution().taskStates["task-plan-1"]!,
        status: "running",
      },
      "task-plan-2": {
        taskId: "task-plan-2",
        contextId: "context-plan",
        order: 2,
        status: "completed",
        summary: "Initial draft written",
        startedAt: "2026-03-27T16:00:00.000Z",
        completedAt: "2026-03-27T16:05:00.000Z",
        lastConversationId: "conversation-seed",
        failureMessage: null,
        failureHistory: [],
      },
    },
  });
  return { definition, execution };
}

function emptyMetadata(): ValidatorRunResult["metadata"] {
  return {
    sessionRef: null,
    reviewArtifact: null,
    limitEvaluation: "disabled",
    rotateBeforeNextTurn: false,
  };
}

describe("graph workflow execution validation service", () => {
  it("returns kind=fail when runner produces a fail outcome and builds feedback from issues", async () => {
    const { execution } = buildExecutionWithTaskValidator();
    const runTaskValidator = vi.fn(
      async (): Promise<ValidatorRunResult> => ({
        result: {
          kind: "fail",
          summary: "Needs more evidence",
          issues: [
            {
              title: "Missing artifact",
              description:
                "Attach the architecture notes before closing the task.",
            },
          ],
        },
        metadata: emptyMetadata(),
      }),
    );
    const service = createGraphWorkflowValidationService({
      runTaskValidator,
    });

    const result = await service.validateTaskCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
      taskId: "task-plan-1",
      conversationId: "conversation-1",
      summary: "Finished the planning pass.",
    });

    expect(runTaskValidator).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          id: "context-plan",
        }),
        task: expect.objectContaining({
          id: "task-plan-1",
        }),
        validator: expect.objectContaining({
          instructions: "Review task completion before it can close.",
        }),
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.summary).toBe("Needs more evidence");
      expect(result.issues).toEqual([
        {
          title: "Missing artifact",
          description: "Attach the architecture notes before closing the task.",
        },
      ]);
      expect(result.feedback).toContain("Task validation blocked completion");
      expect(result.feedback).toContain("Missing artifact");
    }
  });

  it("returns kind=pass when runner produces a pass outcome", async () => {
    const { execution } = buildExecutionWithTaskValidator();
    const runTaskValidator = vi.fn(
      async (): Promise<ValidatorRunResult> => ({
        result: {
          kind: "pass",
          summary: "Looks good",
          issues: [],
        },
        metadata: emptyMetadata(),
      }),
    );
    const service = createGraphWorkflowValidationService({
      runTaskValidator,
    });

    const result = await service.validateTaskCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
      taskId: "task-plan-1",
      conversationId: "conversation-1",
      summary: "Done.",
    });

    expect(result.kind).toBe("pass");
    if (result.kind === "pass") {
      expect(result.summary).toBe("Looks good");
      expect(result.feedback).toContain("Task validation passed");
    }
  });

  it("returns kind=infra_error with reason, message, engine when runner produces infra_error outcome", async () => {
    const { execution } = buildExecutionWithTaskValidator();
    const runTaskValidator = vi.fn(
      async (): Promise<ValidatorRunResult> => ({
        result: {
          kind: "infra_error",
          reason: "exception",
          message: "Codex rate limit exceeded",
          engine: "codex",
        },
        metadata: emptyMetadata(),
      }),
    );
    const service = createGraphWorkflowValidationService({
      runTaskValidator,
    });

    const result = await service.validateTaskCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
      taskId: "task-plan-1",
      conversationId: "conversation-1",
      summary: "Done.",
    });

    expect(result.kind).toBe("infra_error");
    if (result.kind === "infra_error") {
      expect(result.reason).toBe("exception");
      expect(result.message).toBe("Codex rate limit exceeded");
      expect(result.engine).toBe("codex");
      expect(result.sessionRef).toBeNull();
      expect(result.reviewArtifact).toBeNull();
    }
  });

  it("returns kind=pass with disabled-feedback when validator is not enabled", async () => {
    const execution = createWorkflowExecution();
    const runTaskValidator = vi.fn();
    const service = createGraphWorkflowValidationService({
      runTaskValidator,
    });

    const result = await service.validateTaskCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
      taskId: "task-plan-1",
      conversationId: "conversation-1",
      summary: "Done.",
    });

    expect(runTaskValidator).not.toHaveBeenCalled();
    expect(result.kind).toBe("pass");
    if (result.kind === "pass") {
      expect(result.feedback).toBe("Task validation is not enabled.");
    }
  });
});
