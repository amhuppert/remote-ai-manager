import { describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecution, GraphWorkflowLaneState } from "@/types";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import { graphWorkflowExecutionSchema } from "@/lib/schemas";
import { createGraphWorkflowIterationOrchestrator } from "./iteration-orchestrator";
import type { GraphWorkflowStreamFrame } from "@/lib/workflow-graph/stream-registry";
import type {
  ResolveImplementerCallInput,
  RecordClaudeLaneTurnInput,
} from "./workflow-continuity-service";
import { createWorkflowContinuityService } from "./workflow-continuity-service";

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
      current.taskStates["task-plan-2"] = {
        ...current.taskStates["task-plan-2"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:32:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };

      await repository.update("/repo", "session-1", current);
      return { contextTokens: 50_000, contextWindowMax: 200_000 };
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

  it("continues follow-ups even when context is full (no automatic 85% stopping)", async () => {
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

    // 1 initial + 2 follow-ups — no automatic stopping based on context percentage
    expect(runAgentIteration).toHaveBeenCalledTimes(3);
  });

  it("stops follow-ups when continuity service schedules rotation (rotateBeforeNextTurn)", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conv-rotate" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const runAgentIteration = vi.fn(async () => ({
      contextTokens: 180_000,
      contextWindowMax: 200_000,
    }));

    const resolveImplementerCall = vi.fn(
      async (input: ResolveImplementerCallInput) => ({
        execution: input.execution,
        conversationId: "conv-rotate",
        sessionAction: "create" as const,
        promptMode: "iteration_seed" as const,
      }),
    );

    // After each turn, signal that rotation is needed
    const recordClaudeTurnOutcome = vi.fn(
      (input: RecordClaudeLaneTurnInput) => ({
        ...input.execution,
        laneStates: {
          implementer: {
            engine: "claude" as const,
            lane: "implementer" as const,
            contextId: "context-plan",
            sessionRef: {
              engine: "claude" as const,
              lane: "implementer" as const,
              conversationId: "conv-rotate",
            },
            lastContextTokens: 180_000,
            lastContextWindowMax: 200_000,
            rotateBeforeNextTurn: true,
            limitEvaluation: "supported" as const,
            lastUsedAt: "2026-03-27T16:00:00.000Z",
          },
        },
      }),
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: { resolveImplementerCall, recordClaudeTurnOutcome },
      now() {
        return "2026-03-27T16:00:00.000Z";
      },
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Only the initial call — follow-up stopped because rotateBeforeNextTurn was set
    expect(runAgentIteration).toHaveBeenCalledTimes(1);
  });

  it("sends follow-up prompt as initial call when session is resumed (promptMode follow_up)", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conv-unused" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const runAgentIteration = vi.fn(async () => ({
      contextTokens: 50_000,
      contextWindowMax: 200_000,
    }));

    const resolveImplementerCall = vi.fn(
      async (input: ResolveImplementerCallInput) => ({
        execution: input.execution,
        conversationId: "conv-resumed",
        sessionAction: "reuse" as const,
        promptMode: "follow_up" as const,
      }),
    );

    const recordClaudeTurnOutcome = vi.fn(
      (input: RecordClaudeLaneTurnInput) => input.execution,
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: { resolveImplementerCall, recordClaudeTurnOutcome },
      now() {
        return "2026-03-27T16:00:00.000Z";
      },
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    const calls = runAgentIteration.mock.calls as unknown as Array<
      [{ conversationId: string; prompt: string }]
    >;
    const initialPrompt = calls[0]![0].prompt;

    // When resuming a session, the initial prompt should be a follow-up (not the full seed)
    expect(initialPrompt).not.toContain("# Execution Context");
    expect(initialPrompt).toContain("task-plan-1");
    expect(initialPrompt).toContain("task-plan-2");
    expect(initialPrompt).toContain("complete_task");
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

  it("uses continuity service conversation ID when provided", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "fallback-conv" }));
    const createToolServer = vi.fn(() => ({ server: {} }));
    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:00:00.000Z",
      };
      current.taskStates["task-plan-2"] = {
        ...current.taskStates["task-plan-2"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:01:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };
      await repository.update("/repo", "session-1", current);
      return { contextTokens: 50000, contextWindowMax: 200000 };
    });

    const resolveImplementerCall = vi.fn(
      async (input: ResolveImplementerCallInput) => ({
        execution: input.execution,
        conversationId: "continuity-conv-id",
        sessionAction: "create" as const,
        promptMode: "iteration_seed" as const,
      }),
    );
    const recordClaudeTurnOutcome = vi.fn(
      (input: RecordClaudeLaneTurnInput) => input.execution,
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: { resolveImplementerCall, recordClaudeTurnOutcome },
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

    // createConversation should NOT be called — continuity service provides the ID
    expect(createConversation).not.toHaveBeenCalled();
    expect(resolveImplementerCall).toHaveBeenCalledOnce();
    expect(result.conversationId).toBe("continuity-conv-id");
    // recordClaudeTurnOutcome should be called after each agent run
    expect(recordClaudeTurnOutcome).toHaveBeenCalledOnce();
    expect(recordClaudeTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "implementer",
        contextTokens: 50000,
        contextWindowMax: 200000,
      }),
    );
  });
});

// -- fix-0582fa53: stale execution clobbers validator lane state ---------------

describe("task validation continuity state preservation (fix-0582fa53)", () => {
  it("preserves lane states written by validator-runner after task validation passes", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const repository = createRepository(execution);

    let capturedCompleteTask:
      | ((taskId: string, summary: string) => Promise<GraphWorkflowExecution>)
      | undefined;

    const createToolServer = vi.fn(
      (input: {
        completeTask: (
          taskId: string,
          summary: string,
        ) => Promise<GraphWorkflowExecution>;
      }) => {
        capturedCompleteTask = input.completeTask;
        return { server: {} };
      },
    );
    const createConversation = vi.fn(async () => ({ id: "conv-1" }));

    // Simulate validator-runner persisting updated lane states mid-validation
    const validatorLaneState: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "task_validator",
      contextId: "context-plan",
      sessionRef: {
        engine: "claude",
        lane: "task_validator",
        conversationId: "validator-conv",
      },
      lastContextTokens: 10_000,
      lastContextWindowMax: 200_000,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: "2026-03-27T16:01:00.000Z",
    };

    const validateTaskCompletion = vi.fn(async () => {
      // Simulate validator-runner persisting updated lane states
      const current = structuredClone(repository.read());
      current.laneStates = { task_validator: validatorLaneState };
      await repository.update("/repo", "session-1", current);
      return {
        pass: true,
        summary: "Task passed",
        feedback: "Task validation passed.",
        issues: [] as never[],
        reopenTaskIds: [] as string[],
        sessionRef: validatorLaneState.sessionRef,
        reviewArtifact: null,
      };
    });

    const runAgentIteration = vi.fn(async () => {
      // Only complete task on the first call — follow-up calls do nothing
      if (runAgentIteration.mock.calls.length === 1) {
        await capturedCompleteTask!("task-plan-1", "Done");
      }
      return { contextTokens: null, contextWindowMax: null };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: {
        validateTaskCompletion,
        validateContextCompletion: vi.fn(),
      },
      now() {
        return "2026-03-27T16:00:00.000Z";
      },
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Lane states written by the validator-runner must survive subsequent orchestrator writes
    const final = repository.read();
    expect(final.laneStates["task_validator"]).toBeDefined();
    expect(
      (final.laneStates["task_validator"] as typeof validatorLaneState)
        .sessionRef,
    ).toEqual({
      engine: "claude",
      lane: "task_validator",
      conversationId: "validator-conv",
    });
  });
});

// -- E2E: session continuity across consecutive runIteration calls ------------

describe("session continuity across runIteration calls (end-to-end)", () => {
  const NOW = "2026-03-27T16:00:00.000Z";

  it("reuses the same implementer conversation when a prior lane state exists for the same context", async () => {
    // Pre-populate the execution with an existing implementer lane state so the
    // continuity service finds a session to reuse on the very first call.
    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      laneStates: {
        implementer: {
          engine: "claude",
          lane: "implementer",
          contextId: "context-plan",
          sessionRef: {
            engine: "claude",
            lane: "implementer",
            conversationId: "conv-existing",
          },
          lastContextTokens: 50_000,
          lastContextWindowMax: 200_000,
          rotateBeforeNextTurn: false,
          limitEvaluation: "disabled",
          lastUsedAt: NOW,
        },
      },
    });
    const repository = createRepository(execution);

    const createConversation = vi.fn();
    const getConversation = vi.fn(async () => ({ id: "conv-existing" }));
    const createToolServer = vi.fn(() => ({ server: {} }));

    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: NOW,
      };
      await repository.update("/repo", "session-1", current);
      return { contextTokens: 60_000, contextWindowMax: 200_000 };
    });

    const continuityService = createWorkflowContinuityService({
      createConversation,
      getConversation,
      startCodexThread: vi.fn(),
      resumeCodexThread: vi.fn(),
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation: vi.fn(),
      createToolServer,
      runAgentIteration,
      continuityService,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Existing session reused — createConversation must not have been called
    expect(createConversation).not.toHaveBeenCalled();
    // getConversation validates the existing session is still alive
    expect(getConversation).toHaveBeenCalledWith(
      "/repo",
      "session-1",
      "conv-existing",
    );
    expect(result.conversationId).toBe("conv-existing");
  });

  it("creates a fresh conversation when the execution context changes between runIteration calls", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );

    let convCounter = 0;
    const createConversation = vi.fn(async () => {
      convCounter++;
      return { id: `conv-${convCounter}` };
    });
    const getConversation = vi.fn(
      async (_p: string, _s: string, id: string) => ({ id }),
    );
    const createToolServer = vi.fn(() => ({ server: {} }));

    const runAgentIteration = vi.fn(async (input: { contextId: string }) => {
      const current = structuredClone(repository.read());
      // Complete one task per call based on context
      if (input.contextId === "context-plan") {
        current.taskStates["task-plan-1"] = {
          ...current.taskStates["task-plan-1"]!,
          status: "completed",
          summary: "Done",
          completedAt: NOW,
        };
        current.contextStates["context-plan"] = {
          ...current.contextStates["context-plan"]!,
          completedTaskCount: 1,
        };
      } else {
        current.taskStates["task-implement-1"] = {
          ...current.taskStates["task-implement-1"]!,
          status: "completed",
          summary: "Done",
          completedAt: NOW,
        };
        current.contextStates["context-implement"] = {
          ...current.contextStates["context-implement"]!,
          completedTaskCount: 1,
        };
      }
      await repository.update("/repo", "session-1", current);
      return { contextTokens: 50_000, contextWindowMax: 200_000 };
    });

    const continuityService = createWorkflowContinuityService({
      createConversation,
      getConversation,
      startCodexThread: vi.fn(),
      resumeCodexThread: vi.fn(),
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation: vi.fn(),
      createToolServer,
      runAgentIteration,
      continuityService,
      now: () => NOW,
    });

    const result1 = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    const result2 = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-implement",
    });

    // Each context gets its own fresh conversation
    expect(result1.conversationId).toBe("conv-1");
    expect(result2.conversationId).toBe("conv-2");
    expect(createConversation).toHaveBeenCalledTimes(2);
  });

  it("creates a fresh conversation even when a prior lane state exists and continuity is disabled", async () => {
    // Pre-populate with an existing lane state AND disable continuity to verify
    // that continuity=false forces a fresh session regardless of saved lane state.
    const definition = createWorkflowDefinition();
    const ctxPlan = definition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    ctxPlan.iterationPolicy.continuity = { enabled: false };

    const execution = createWorkflowExecution({
      status: "running",
      activeContextId: "context-plan",
      workingDefinition: definition,
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
          lastContextTokens: null,
          lastContextWindowMax: null,
          rotateBeforeNextTurn: false,
          limitEvaluation: "disabled",
          lastUsedAt: NOW,
        },
      },
    });
    const repository = createRepository(execution);

    const createConversation = vi.fn(async () => ({ id: "conv-new" }));
    const getConversation = vi.fn();
    const createToolServer = vi.fn(() => ({ server: {} }));

    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: NOW,
      };
      await repository.update("/repo", "session-1", current);
      return { contextTokens: 50_000, contextWindowMax: 200_000 };
    });

    const continuityService = createWorkflowContinuityService({
      createConversation,
      getConversation,
      startCodexThread: vi.fn(),
      resumeCodexThread: vi.fn(),
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation: vi.fn(),
      createToolServer,
      runAgentIteration,
      continuityService,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // A fresh session is always created when continuity is disabled, ignoring any saved lane state
    expect(createConversation).toHaveBeenCalledOnce();
    expect(getConversation).not.toHaveBeenCalled();
    expect(result.conversationId).toBe("conv-new");
  });

  it("reuses the same implementer conversation across 3 consecutive iterations in the same context", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const repository = createRepository(execution);

    let convCounter = 0;
    const createConversation = vi.fn(async () => {
      convCounter++;
      return { id: `conv-${convCounter}` };
    });
    const getConversation = vi.fn(
      async (_p: string, _s: string, id: string) => ({ id }),
    );
    const createToolServer = vi.fn(() => ({ server: {} }));
    const runAgentIteration = vi.fn(async () => ({
      contextTokens: 50_000,
      contextWindowMax: 200_000,
    }));

    const continuityService = createWorkflowContinuityService({
      createConversation,
      getConversation,
      startCodexThread: vi.fn(),
      resumeCodexThread: vi.fn(),
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation: vi.fn(),
      createToolServer,
      runAgentIteration,
      continuityService,
      now: () => NOW,
    });

    const input = {
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    };
    const result1 = await orchestrator.runIteration(input);
    const result2 = await orchestrator.runIteration(input);
    const result3 = await orchestrator.runIteration(input);

    // Only one conversation created — on the very first call
    expect(createConversation).toHaveBeenCalledOnce();
    // All three iterations reuse the same session
    expect(result1.conversationId).toBe("conv-1");
    expect(result2.conversationId).toBe("conv-1");
    expect(result3.conversationId).toBe("conv-1");
  });

  it("starts a fresh session when the context limit was exceeded on the previous iteration", async () => {
    const baseExecution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const execution: GraphWorkflowExecution = {
      ...baseExecution,
      workingDefinition: {
        ...baseExecution.workingDefinition,
        executionContexts:
          baseExecution.workingDefinition.executionContexts.map((ctx) =>
            ctx.id === "context-plan"
              ? {
                  ...ctx,
                  iterationPolicy: {
                    ...ctx.iterationPolicy,
                    continuity: { enabled: true, contextLimitTokens: 100_000 },
                  },
                }
              : ctx,
          ),
      },
    };
    const repository = createRepository(execution);

    let convCounter = 0;
    const createConversation = vi.fn(async () => {
      convCounter++;
      return { id: `conv-${convCounter}` };
    });
    const getConversation = vi.fn(
      async (_p: string, _s: string, id: string) => ({ id }),
    );
    const createToolServer = vi.fn(() => ({ server: {} }));

    // Call 1 exceeds the configured limit; call 2 stays within it
    let callCount = 0;
    const runAgentIteration = vi.fn(async () => {
      callCount++;
      return callCount === 1
        ? { contextTokens: 120_000, contextWindowMax: 200_000 }
        : { contextTokens: 50_000, contextWindowMax: 200_000 };
    });

    const continuityService = createWorkflowContinuityService({
      createConversation,
      getConversation,
      startCodexThread: vi.fn(),
      resumeCodexThread: vi.fn(),
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation: vi.fn(),
      createToolServer,
      runAgentIteration,
      continuityService,
      now: () => NOW,
    });

    const input = {
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    };
    const result1 = await orchestrator.runIteration(input);
    const result2 = await orchestrator.runIteration(input);

    // Two conversations: first call creates conv-1, second call rotates to conv-2
    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(result1.conversationId).toBe("conv-1");
    expect(result2.conversationId).toBe("conv-2");
    // After the second call the fresh session has not exceeded the limit
    const laneState = repository.read().laneStates["implementer"];
    expect(laneState?.rotateBeforeNextTurn).toBe(false);
  });

  it("reuses the same implementer session after execution state is deserialized through the schema (restart recovery)", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const repository = createRepository(execution);

    let convCounter = 0;
    const createConversation = vi.fn(async () => {
      convCounter++;
      return { id: `conv-${convCounter}` };
    });
    const getConversation = vi.fn(
      async (_p: string, _s: string, id: string) => ({ id }),
    );
    const createToolServer = vi.fn(() => ({ server: {} }));
    const runAgentIteration = vi.fn(async () => ({
      contextTokens: 50_000,
      contextWindowMax: 200_000,
    }));

    const continuityService = createWorkflowContinuityService({
      createConversation,
      getConversation,
      startCodexThread: vi.fn(),
      resumeCodexThread: vi.fn(),
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation: vi.fn(),
      createToolServer,
      runAgentIteration,
      continuityService,
      now: () => NOW,
    });

    const input = {
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    };

    // First call: creates conv-1, persists lane state to repository
    const result1 = await orchestrator.runIteration(input);
    expect(result1.conversationId).toBe("conv-1");

    // Simulate a restart by round-tripping the execution through the schema parser
    const deserialized = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(repository.read())),
    );
    await repository.update("/repo", "session-1", deserialized);

    // Second call after restart: should find and reuse conv-1 from the deserialized lane state
    const result2 = await orchestrator.runIteration(input);
    expect(result2.conversationId).toBe("conv-1");
    // Only one conversation ever created — the second call resumed rather than creating fresh
    expect(createConversation).toHaveBeenCalledOnce();
  });
});

// -- fix-30388517: successful task-validator turns never emit events -----------

describe("task validation event publishing (fix-30388517)", () => {
  it("publishes a passing validation result event with sessionRef after successful task validation", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const repository = createRepository(execution);

    let capturedCompleteTask:
      | ((taskId: string, summary: string) => Promise<GraphWorkflowExecution>)
      | undefined;

    const createToolServer = vi.fn(
      (input: {
        completeTask: (
          taskId: string,
          summary: string,
        ) => Promise<GraphWorkflowExecution>;
      }) => {
        capturedCompleteTask = input.completeTask;
        return { server: {} };
      },
    );
    const createConversation = vi.fn(async () => ({ id: "conv-1" }));

    const sessionRef = {
      engine: "claude" as const,
      lane: "task_validator" as const,
      conversationId: "validator-conv",
    };

    const validateTaskCompletion = vi.fn(async () => ({
      pass: true,
      summary: "All checks passed",
      feedback: "Task validation passed.",
      issues: [] as never[],
      reopenTaskIds: [] as string[],
      sessionRef,
      reviewArtifact: {
        engine: "claude" as const,
        conversationId: "validator-conv",
      },
    }));

    const runAgentIteration = vi.fn(async () => {
      // Only complete task on the first call — follow-up calls do nothing
      if (runAgentIteration.mock.calls.length === 1) {
        await capturedCompleteTask!("task-plan-1", "Done");
      }
      return { contextTokens: null, contextWindowMax: null };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: {
        validateTaskCompletion,
        validateContextCompletion: vi.fn(),
      },
      now() {
        return "2026-03-27T16:00:00.000Z";
      },
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    const final = repository.read();
    const validationHistoryEntry = final.history.find(
      (entry) => entry.event.type === "graph-workflow-validation-result",
    );
    expect(validationHistoryEntry).toBeDefined();
    expect(validationHistoryEntry?.event).toMatchObject({
      type: "graph-workflow-validation-result",
      validatorType: "task",
      pass: true,
      sessionRef,
    });
  });
});
