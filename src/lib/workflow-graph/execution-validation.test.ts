import { describe, expect, it, vi } from "vitest";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import { createGraphWorkflowValidationService } from "./execution-validation";
import type { ValidatorRunResult } from "./validator-runner";

function buildExecutionWithContextValidator() {
  const baseDefinition = createResolvedWorkflowDefinition();
  const definition = createResolvedWorkflowDefinition({
    executionContexts: baseDefinition.executionContexts.map((context) =>
      context.id === "context-plan"
        ? {
            ...context,
            acceptanceCriteria:
              "Every task summary is complete and the plan document is updated.",
            contextValidator: {
              type: "claude",
              enabled: true,
              continuity: { enabled: true },
              agent: {
                backend: "claude",
                model: "sonnet",
                reasoningEffort: "medium",
              },
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
        instructions: "Document the implementation plan.",
        source: "user",
      },
      ...baseDefinition.tasks.filter(
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
        completedTaskCount: 2,
      },
    },
    taskStates: {
      ...createWorkflowExecution().taskStates,
      "task-plan-1": {
        ...createWorkflowExecution().taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Inspected the codebase and documented the current behavior.",
        startedAt: "2026-03-27T16:00:00.000Z",
        completedAt: "2026-03-27T16:05:00.000Z",
      },
      "task-plan-2": {
        taskId: "task-plan-2",
        contextId: "context-plan",
        order: 2,
        status: "completed",
        summary: "Drafted the implementation plan and linked the updated doc.",
        startedAt: "2026-03-27T16:05:00.000Z",
        completedAt: "2026-03-27T16:10:00.000Z",
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
  it("returns kind=fail with reopened tasks when runner blocks context completion", async () => {
    const { execution } = buildExecutionWithContextValidator();
    const runContextValidator = vi.fn(
      async (): Promise<ValidatorRunResult> => ({
        result: {
          kind: "fail",
          summary: "The plan document is still missing key migration notes.",
          issues: [
            {
              taskId: "task-plan-2",
              title: "Plan incomplete",
              description:
                "The migration rollback steps are not documented in the plan.",
            },
          ],
          reopenTaskIds: ["task-plan-2"],
        },
        metadata: emptyMetadata(),
      }),
    );
    const service = createGraphWorkflowValidationService({
      runContextValidator,
    });

    const result = await service.validateContextCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
    });

    expect(runContextValidator).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          id: "context-plan",
          acceptanceCriteria:
            "Every task summary is complete and the plan document is updated.",
        }),
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.summary).toBe(
        "The plan document is still missing key migration notes.",
      );
      expect(result.reopenTaskIds).toEqual(["task-plan-2"]);
      expect(result.feedback).toContain(
        "Context validation blocked completion",
      );
      expect(result.feedback).toContain("task-plan-2");
    }
  });

  it("returns kind=pass when runner approves the completed context", async () => {
    const { execution } = buildExecutionWithContextValidator();
    const runContextValidator = vi.fn(
      async (): Promise<ValidatorRunResult> => ({
        result: {
          kind: "pass",
          summary: "All acceptance criteria were satisfied.",
          issues: [],
          reopenTaskIds: [],
        },
        metadata: emptyMetadata(),
      }),
    );
    const service = createGraphWorkflowValidationService({
      runContextValidator,
    });

    const result = await service.validateContextCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
    });

    expect(result.kind).toBe("pass");
    if (result.kind === "pass") {
      expect(result.summary).toBe("All acceptance criteria were satisfied.");
      expect(result.reopenTaskIds).toEqual([]);
      expect(result.feedback).toContain("Context validation passed");
    }
  });

  it("returns kind=infra_error when runner fails before producing a valid result", async () => {
    const { execution } = buildExecutionWithContextValidator();
    const runContextValidator = vi.fn(
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
      runContextValidator,
    });

    const result = await service.validateContextCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
    });

    expect(result.kind).toBe("infra_error");
    if (result.kind === "infra_error") {
      expect(result.reason).toBe("exception");
      expect(result.message).toBe("Codex rate limit exceeded");
      expect(result.engine).toBe("codex");
    }
  });

  it("returns kind=pass with disabled feedback when context validation is not enabled", async () => {
    const execution = createWorkflowExecution();
    const runContextValidator = vi.fn();
    const service = createGraphWorkflowValidationService({
      runContextValidator,
    });

    const result = await service.validateContextCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
    });

    expect(runContextValidator).not.toHaveBeenCalled();
    expect(result.kind).toBe("pass");
    if (result.kind === "pass") {
      expect(result.reopenTaskIds).toEqual([]);
      expect(result.feedback).toBe("Context validation is not enabled.");
    }
  });
});
