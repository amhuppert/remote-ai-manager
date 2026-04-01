import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import { createGraphWorkflowValidationService } from "./execution-validation";

describe("graph workflow execution validation service", () => {
  it("blocks task completion while preserving validator issues and reopen directives", async () => {
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (context) =>
          context.id === "context-plan"
            ? {
                ...context,
                taskValidation: {
                  type: "claude",
                  enabled: true,
                  autoCreateFixTasks: true,
                  agent: {
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
          reopenedCount: 0,
          lastReopenedAt: null,
          failureMessage: null,
        },
      },
    });
    const runTaskValidator = vi.fn(async () => ({
      pass: true,
      summary: "Needs more evidence",
      reopenTaskIds: ["task-plan-2"],
      issues: [
        {
          title: "Missing artifact",
          description: "Attach the architecture notes before closing the task.",
        },
      ],
    }));
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
    expect(result.pass).toBe(false);
    expect(result.summary).toBe("Needs more evidence");
    expect(result.reopenTaskIds).toEqual(["task-plan-2"]);
    expect(result.issues).toEqual([
      {
        title: "Missing artifact",
        description: "Attach the architecture notes before closing the task.",
      },
    ]);
    expect(result.feedback).toContain("Task validation blocked completion");
    expect(result.feedback).toContain("Missing artifact");
  });

  it("requires both agent and script validators to pass for context completion", async () => {
    const definition = createWorkflowDefinition({
      executionContexts: createWorkflowDefinition().executionContexts.map(
        (context) =>
          context.id === "context-plan"
            ? {
                ...context,
                contextValidation: {
                  agentValidator: {
                    type: "claude",
                    enabled: true,
                    autoCreateFixTasks: true,
                    agent: {
                      model: "opus",
                      reasoningEffort: "high",
                    },
                    instructions: "Validate the plan.",
                  },
                  scriptValidator: {
                    enabled: true,
                  },
                  onFail: {
                    mode: "retry",
                    retryScope: "same_context",
                    maxAttempts: 2,
                  },
                },
              }
            : context,
      ),
    });
    const execution = createWorkflowExecution({
      workingDefinition: definition,
      contextStates: {
        ...createWorkflowExecution().contextStates,
        "context-plan": {
          ...createWorkflowExecution().contextStates["context-plan"]!,
          status: "validating",
          completedTaskCount: 1,
        },
      },
      taskStates: {
        ...createWorkflowExecution().taskStates,
        "task-plan-1": {
          ...createWorkflowExecution().taskStates["task-plan-1"]!,
          status: "completed",
          completedAt: "2026-03-27T16:10:00.000Z",
        },
      },
    });
    const runContextAgentValidator = vi.fn(async () => ({
      pass: true,
      summary: "Agent validator passed",
      reopenTaskIds: [],
      issues: [],
    }));
    const runContextScriptValidator = vi.fn(async () => ({
      executed: true,
      pass: false,
      stdout: "",
      stderr: "Type errors remain",
      output: "Type errors remain",
      timedOut: false,
      message: "Pre-merge validation failed",
    }));
    const service = createGraphWorkflowValidationService({
      runContextAgentValidator,
      runContextScriptValidator,
    });

    const result = await service.validateContextCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      worktreePath: "/repo/.worktrees/session-1",
      branchName: "csm/session-1",
      execution,
      contextId: "context-plan",
    });

    expect(runContextAgentValidator).toHaveBeenCalled();
    expect(runContextScriptValidator).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      worktreePath: "/repo/.worktrees/session-1",
      branchName: "csm/session-1",
      timeoutMs: undefined,
    });
    expect(result.pass).toBe(false);
    expect(result.summary).toBe("Pre-merge validation failed");
    expect(result.feedback).toContain("Type errors remain");
    expect(result.agentResult).toMatchObject({
      pass: true,
      summary: "Agent validator passed",
    });
    expect(result.scriptResult).toMatchObject({
      pass: false,
      executed: true,
    });
  });
});
