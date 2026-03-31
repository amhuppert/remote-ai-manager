import { describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecution } from "@/types";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowIterationOrchestrator } from "./iteration-orchestrator";
import type { GraphWorkflowStreamFrame } from "@/lib/workflow-graph/stream-registry";

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

function createExecutionWithPlanTasks(
  statuses: Record<
    string,
    GraphWorkflowExecution["taskStates"][string]["status"]
  >,
): GraphWorkflowExecution {
  const definition = createWorkflowDefinition({
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
      {
        id: "task-implement-1",
        contextId: "context-implement",
        order: 1,
        title: "Write code",
        instructions: "Implement the feature.",
        source: "user",
      },
      {
        id: "task-verify-1",
        contextId: "context-verify",
        order: 1,
        title: "Run checks",
        instructions: "Verify behavior.",
        source: "user",
      },
    ],
  });

  return createWorkflowExecution({
    status: "running",
    activeContextId: "context-plan",
    workingDefinition: definition,
    contextStates: {
      "context-plan": {
        contextId: "context-plan",
        status: "running",
        totalTaskCount: 2,
        completedTaskCount: statuses["task-plan-1"] === "completed" ? 1 : 0,
        iterationCount: 0,
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
        status: statuses["task-plan-1"] ?? "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        reopenedCount: 0,
        lastReopenedAt: null,
        failureMessage: null,
      },
      "task-plan-2": {
        taskId: "task-plan-2",
        contextId: "context-plan",
        order: 2,
        status: statuses["task-plan-2"] ?? "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
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
    sharedDocuments: [
      {
        id: "doc-1",
        relativePath: "memory-bank/shared/plan.md",
        description: "Current implementation plan",
        readWhen: "Read before starting implementation tasks.",
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
        lastUpdatedByConversationId: "conversation-seed",
      },
    ],
  });
}

describe("graph workflow iteration orchestrator", () => {
  it("runs an iteration that completes one task and signals more remain", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conversation-1" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const runAgentIteration = vi.fn(async () => {
      // Agent completes task-plan-1 via complete_task callback
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Inspected the codebase",
        completedAt: "2026-03-27T16:02:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 1,
      };

      await repository.update("/repo", "session-1", current);
      return { contextTokens: null, contextWindowMax: null };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      now() {
        return "2026-03-27T16:00:00.000Z";
      },
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(createConversation).toHaveBeenCalledWith("/repo", "session-1", {
      role: "iteration",
    });
    expect(createToolServer).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        contextId: "context-plan",
        sharedDocuments: [
          expect.objectContaining({
            relativePath: "memory-bank/shared/plan.md",
          }),
        ],
      }),
    );
    // No activeTask in runAgentIteration call
    expect(runAgentIteration).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        contextId: "context-plan",
      }),
    );
    expect(result.conversationId).toBe("conversation-1");
    expect(result.shouldContinueInContext).toBe(true);
    expect(result.shouldValidateContext).toBe(false);
    expect(result.execution.contextStates["context-plan"]).toMatchObject({
      status: "running",
      completedTaskCount: 1,
      iterationCount: 1,
    });
    expect(result.execution.taskStates["task-plan-1"]).toMatchObject({
      status: "completed",
    });
  });

  it("handles interrupted tasks by presenting them first", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "interrupted",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conversation-2" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Retried interrupted task",
        completedAt: "2026-03-27T16:12:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 1,
      };

      await repository.update("/repo", "session-1", current);
      return { contextTokens: null, contextWindowMax: null };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      now() {
        return "2026-03-27T16:10:00.000Z";
      },
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // The prompt should include the interrupted task — the agent works through it first
    expect(runAgentIteration).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("task-plan-1"),
      }),
    );
    expect(result.shouldContinueInContext).toBe(true);
  });

  it("signals context validation once all tasks are completed in an iteration", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "completed",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conversation-3" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-2"] = {
        ...current.taskStates["task-plan-2"]!,
        status: "completed",
        summary: "Finished planning",
        completedAt: "2026-03-27T16:22:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };

      await repository.update("/repo", "session-1", current);
      return { contextTokens: null, contextWindowMax: null };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      now() {
        return "2026-03-27T16:20:00.000Z";
      },
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(result.shouldContinueInContext).toBe(false);
    expect(result.shouldValidateContext).toBe(true);
    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "validating",
    );
  });

  it("emits live stream frames for iteration boundaries and agent content", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conversation-4" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const emittedFrames: GraphWorkflowStreamFrame[] = [];
    const runAgentIteration = vi.fn(async (input) => {
      input.emitStreamFrame?.({
        type: "content",
        conversationId: input.conversationId,
        contextId: input.contextId,
        content: {
          type: "text",
          text: "Inspecting the codebase.",
        },
      });

      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Inspected the codebase",
        completedAt: "2026-03-27T16:32:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 1,
      };

      await repository.update("/repo", "session-1", current);
      // Return exhausted context to prevent follow-ups (this test is about frame emission)
      return { contextTokens: 190_000, contextWindowMax: 200_000 };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      emitStreamFrame(_projectPath, _sessionName, frame) {
        emittedFrames.push(frame);
      },
      now() {
        return "2026-03-27T16:30:00.000Z";
      },
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(emittedFrames).toEqual([
      {
        type: "iteration-boundary",
        conversationId: "conversation-4",
        contextId: "context-plan",
        status: "started",
      },
      {
        type: "content",
        conversationId: "conversation-4",
        contextId: "context-plan",
        content: {
          type: "text",
          text: "Inspecting the codebase.",
        },
      },
      {
        type: "iteration-boundary",
        conversationId: "conversation-4",
        contextId: "context-plan",
        status: "completed",
      },
    ]);
  });

  it("sends follow-up messages when agent stops with incomplete tasks and context has room", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conversation-5" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    let callCount = 0;
    const runAgentIteration = vi.fn(async () => {
      callCount++;
      if (callCount === 3) {
        // Third call (second follow-up): agent finally completes the first task
        const current = structuredClone(repository.read());
        current.taskStates["task-plan-1"] = {
          ...current.taskStates["task-plan-1"]!,
          status: "completed",
          summary: "Finished after follow-ups",
          completedAt: "2026-03-27T16:42:00.000Z",
        };
        current.contextStates["context-plan"] = {
          ...current.contextStates["context-plan"]!,
          completedTaskCount: 1,
        };
        await repository.update("/repo", "session-1", current);
      }
      // First two calls: agent returns without completing any task
      return { contextTokens: 50_000, contextWindowMax: 200_000 };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      now() {
        return "2026-03-27T16:40:00.000Z";
      },
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Should have called runAgentIteration 3 times: initial + 2 follow-ups
    expect(runAgentIteration).toHaveBeenCalledTimes(3);
    // All calls use the same conversation
    const calls = runAgentIteration.mock.calls as unknown as Array<
      [{ conversationId: string; prompt: string }]
    >;
    expect(calls[1]![0]).toMatchObject({
      conversationId: "conversation-5",
    });
    expect(calls[2]![0]).toMatchObject({
      conversationId: "conversation-5",
    });
    // Follow-up prompts are different from the initial prompt
    const initialPrompt = calls[0]![0].prompt;
    const followUp1Prompt = calls[1]![0].prompt;
    expect(followUp1Prompt).not.toBe(initialPrompt);
    expect(followUp1Prompt).toContain("complete_task");
    // Task completed after follow-ups
    expect(result.execution.taskStates["task-plan-1"]).toMatchObject({
      status: "completed",
    });
    expect(result.shouldContinueInContext).toBe(true);
  });

  it("skips follow-up when context is exhausted", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conversation-6" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const runAgentIteration = vi.fn(async () => {
      // Agent returns without completing, and context is nearly full
      return { contextTokens: 180_000, contextWindowMax: 200_000 };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      now() {
        return "2026-03-27T16:50:00.000Z";
      },
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Only the initial call — no follow-ups because context is exhausted
    expect(runAgentIteration).toHaveBeenCalledTimes(1);
  });

  it("stops follow-ups after max attempts even if tasks are still incomplete", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conversation-7" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const runAgentIteration = vi.fn(async () => {
      // Agent never completes any task
      return { contextTokens: 50_000, contextWindowMax: 200_000 };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      now() {
        return "2026-03-27T16:55:00.000Z";
      },
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // 1 initial + 2 follow-ups = 3 total
    expect(runAgentIteration).toHaveBeenCalledTimes(3);
  });
});
