import { describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecution, GraphWorkflowLaneState } from "@/types";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import { graphWorkflowExecutionSchema } from "@/lib/schemas";
import {
  createGraphWorkflowIterationOrchestrator,
  IterationHaltedError,
} from "./iteration-orchestrator";
import type { GraphWorkflowStreamFrame } from "@/lib/workflow-graph/stream-registry";
import type {
  ResolveImplementerCallInput,
  RecordClaudeLaneTurnInput,
  RecordCodexLaneTurnInput,
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
      },
      "context-implement": {
        contextId: "context-implement",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
      },
      "context-verify": {
        contextId: "context-verify",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
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
        failureMessage: null,
        failureHistory: [],
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
        failureMessage: null,
        failureHistory: [],
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
        failureMessage: null,
        failureHistory: [],
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
        failureMessage: null,
        failureHistory: [],
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

function appendFailedContextValidationEvent(
  execution: GraphWorkflowExecution,
  overrides: Partial<{
    summary: string;
    reopenTaskIds: string[];
    issues: Array<{
      taskId: string;
      title: string;
      description: string;
    }>;
  }> = {},
): GraphWorkflowExecution {
  execution.history.push({
    occurredAt: "2026-03-27T15:55:00.000Z",
    event: {
      type: "graph-workflow-validation-result",
      projectName: "repo",
      sessionName: "session-1",
      executionId: execution.id,
      contextId: "context-plan",
      validatorType: "context",
      pass: false,
      summary:
        overrides.summary ??
        "Validation failed because rollback notes are missing.",
      reopenTaskIds: overrides.reopenTaskIds ?? ["task-plan-2"],
      issues: overrides.issues ?? [
        {
          taskId: "task-plan-2",
          title: "Missing rollback notes",
          description: "Add rollback guidance to the plan.",
        },
      ],
      sessionRef: null,
      reviewArtifact: null,
    },
  });
  return execution;
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
      return {
        conversationId: "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
      };
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
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
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

  it("marks context as completed once all tasks are completed in an iteration", async () => {
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
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
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
    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "completed",
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
      return {
        conversationId: "conv-mock",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
      };
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
      return {
        conversationId: "conv-mock",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
      };
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
      return {
        conversationId: "conv-mock",
        contextTokens: 180_000,
        contextWindowMax: 200_000,
      };
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
      conversationId: "conv-mock",
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
      continuityService: {
        resolveImplementerCall,
        recordClaudeTurnOutcome,
        recordCodexTurnOutcome: vi.fn(),
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
      conversationId: "conv-mock",
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
      continuityService: {
        resolveImplementerCall,
        recordClaudeTurnOutcome,
        recordCodexTurnOutcome: vi.fn(),
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

    const calls = runAgentIteration.mock.calls as unknown as Array<
      [{ conversationId: string; prompt: string }]
    >;
    const initialPrompt = calls[0]![0].prompt;

    // When resuming a session, the initial prompt should be a follow-up (not the full seed)
    expect(initialPrompt).not.toContain("# Execution Context");
    expect(initialPrompt).toContain("task-plan-1");
    expect(initialPrompt).toContain("task-plan-2");
    expect(initialPrompt).toContain("Inspect code");
    expect(initialPrompt).toContain("Read the relevant files.");
    expect(initialPrompt).toContain("Write plan");
    expect(initialPrompt).toContain("Document the plan.");
    expect(initialPrompt).toContain("complete_task");
  });

  it("includes validator-created task instructions in resumed follow-up prompts", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "completed",
      "task-plan-2": "pending",
    });
    execution.workingDefinition.tasks.push({
      id: "fix-1234",
      contextId: "context-plan",
      order: 3,
      title: "Fix: Missing regression coverage",
      instructions: "Add tests for the shared dropdown validation path.",
      source: "agent",
    });
    execution.taskStates["fix-1234"] = {
      taskId: "fix-1234",
      contextId: "context-plan",
      order: 3,
      status: "pending",
      summary: null,
      startedAt: null,
      completedAt: null,
      lastConversationId: null,
      failureMessage: "Previous fix did not cover the failing edge case.",
      failureHistory: [],
    };
    execution.contextStates["context-plan"] = {
      ...execution.contextStates["context-plan"]!,
      totalTaskCount: 3,
      completedTaskCount: 1,
    };

    const repository = createRepository(execution);
    const createConversation = vi.fn(async () => ({ id: "conv-unused" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const runAgentIteration = vi.fn(async () => ({
      conversationId: "conv-mock",
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
      continuityService: {
        resolveImplementerCall,
        recordClaudeTurnOutcome,
        recordCodexTurnOutcome: vi.fn(),
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

    const calls = runAgentIteration.mock.calls as unknown as Array<
      [{ prompt: string }]
    >;
    const initialPrompt = calls[0]![0].prompt;

    expect(initialPrompt).toContain("fix-1234");
    expect(initialPrompt).toContain("Fix: Missing regression coverage");
    expect(initialPrompt).toContain(
      "Add tests for the shared dropdown validation path.",
    );
    expect(initialPrompt).toContain(
      "Previous fix did not cover the failing edge case.",
    );
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
      return {
        conversationId: "conv-mock",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
      };
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
      return {
        conversationId: "conv-mock",
        contextTokens: 50000,
        contextWindowMax: 200000,
      };
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
      continuityService: {
        resolveImplementerCall,
        recordClaudeTurnOutcome,
        recordCodexTurnOutcome: vi.fn(),
      },
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

  it("binds the live conversation to incomplete tasks before the agent turn begins", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "completed",
        "task-plan-2": "pending",
      }),
    );
    const seededExecution = repository.read();
    seededExecution.taskStates["task-plan-1"] = {
      ...seededExecution.taskStates["task-plan-1"]!,
      status: "completed",
      summary: "Already done",
      startedAt: "2026-03-27T15:50:00.000Z",
      completedAt: "2026-03-27T15:55:00.000Z",
      lastConversationId: "conversation-old",
    };
    const createConversation = vi.fn(async () => ({ id: "conversation-8" }));
    const createToolServer = vi.fn(() => ({ server: {} }));
    const runAgentIteration = vi.fn(async () => {
      const current = repository.read();
      expect(current.taskStates["task-plan-1"]).toMatchObject({
        status: "completed",
        lastConversationId: "conversation-old",
        startedAt: "2026-03-27T15:50:00.000Z",
      });
      expect(current.taskStates["task-plan-2"]).toMatchObject({
        status: "pending",
        lastConversationId: "conversation-8",
        startedAt: "2026-03-27T16:00:00.000Z",
      });

      const next = structuredClone(current);
      next.taskStates["task-plan-2"] = {
        ...next.taskStates["task-plan-2"]!,
        status: "completed",
        summary: "Finished planning",
        completedAt: "2026-03-27T16:03:00.000Z",
      };
      next.contextStates["context-plan"] = {
        ...next.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };
      await repository.update("/repo", "session-1", next);
      return {
        conversationId: "conv-mock",
        contextTokens: 25_000,
        contextWindowMax: 200_000,
      };
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

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(runAgentIteration).toHaveBeenCalledOnce();
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
      lane: "context_validator",
      contextId: "context-plan",
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
        conversationId: "validator-conv",
      },
      lastContextTokens: 10_000,
      lastContextWindowMax: 200_000,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: "2026-03-27T16:01:00.000Z",
    };

    const validateContextCompletion = vi.fn(async () => {
      // Simulate validator-runner persisting updated lane states
      const current = structuredClone(repository.read());
      current.laneStates = { context_validator: validatorLaneState };
      await repository.update("/repo", "session-1", current);
      return {
        kind: "pass" as const,
        summary: "Context passed",
        feedback: "Context validation passed.",
        issues: [] as never[],
        reopenTaskIds: [],
        sessionRef: { backend: "claude" as const, sessionId: "validator-conv" },
        reviewArtifact: null,
      };
    });

    const runAgentIteration = vi.fn(async () => {
      if (runAgentIteration.mock.calls.length === 1) {
        await capturedCompleteTask!("task-plan-1", "Done");
        await capturedCompleteTask!("task-plan-2", "Done");
      }
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: {
        validateContextCompletion,
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
    expect(final.laneStates["context_validator"]).toBeDefined();
    expect(
      (final.laneStates["context_validator"] as typeof validatorLaneState)
        .sessionRef,
    ).toEqual({
      engine: "claude",
      lane: "context_validator",
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
      return {
        conversationId: "conv-mock",
        contextTokens: 60_000,
        contextWindowMax: 200_000,
      };
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
      return {
        conversationId: "conv-mock",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
      };
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
      return {
        conversationId: "conv-mock",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
      };
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
      conversationId: "conv-mock",
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
        ? {
            conversationId: "conv-mock",
            contextTokens: 120_000,
            contextWindowMax: 200_000,
          }
        : {
            conversationId: "conv-mock",
            contextTokens: 50_000,
            contextWindowMax: 200_000,
          };
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
      conversationId: "conv-mock",
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
      backend: "claude" as const,
      sessionId: "validator-conv",
    };

    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "All checks passed",
      feedback: "Context validation passed.",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef,
      reviewArtifact: {
        engine: "claude" as const,
        conversationId: "validator-conv",
      },
    }));

    const runAgentIteration = vi.fn(async () => {
      if (runAgentIteration.mock.calls.length === 1) {
        await capturedCompleteTask!("task-plan-1", "Done");
        await capturedCompleteTask!("task-plan-2", "Done");
      }
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: {
        validateContextCompletion,
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
    // The persisted event uses GraphWorkflowExecutionSessionRef (converted from AgentSessionRef)
    expect(validationHistoryEntry?.event).toMatchObject({
      type: "graph-workflow-validation-result",
      validatorType: "context",
      pass: true,
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
        conversationId: "validator-conv",
      },
    });
  });
});

// -- Circuit breaker: validation failure handling -----------------------------

describe("task validation failure handling (circuit breaker)", () => {
  it("catches validation failure, increments consecutiveFailureCount, and returns shouldContinueInContext", async () => {
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
    const createConversation = vi.fn(async () => ({ id: "conv-fail" }));

    const validateContextCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Validation failed",
      feedback:
        "Context validation blocked completion.\nReopened tasks:\n- task-plan-2\n- Missing tests: Add edge case tests.",
      issues: [
        {
          taskId: "task-plan-2",
          title: "Missing tests",
          description: "Add edge case tests.",
        },
      ],
      reopenTaskIds: ["task-plan-2"],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask!("task-plan-1", "Implemented the feature");
      await capturedCompleteTask!("task-plan-2", "Added the rollout plan");
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: { validateContextCompletion },
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

    // Iteration should NOT throw — the error is caught internally
    expect(result.shouldContinueInContext).toBe(true);

    // consecutiveFailureCount should be incremented
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);

    // Task should be marked with failure info
    const taskState = result.execution.taskStates["task-plan-2"];
    expect(taskState?.startedAt).toBe("2026-03-27T16:00:00.000Z");
    expect(taskState?.lastConversationId).toBe("conv-fail");
    expect(taskState?.failureMessage).toBe(
      "Validation failed\n- Missing tests: Add edge case tests.",
    );
    expect(taskState?.failureHistory).toHaveLength(1);
  });

  it("includes the latest failed context validation feedback in both initial and follow-up prompts during a retry", async () => {
    const repository = createRepository(
      appendFailedContextValidationEvent(
        createExecutionWithPlanTasks({
          "task-plan-1": "pending",
          "task-plan-2": "pending",
        }),
      ),
    );
    const prompts: string[] = [];

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation: vi.fn(async () => ({ id: "conversation-retry" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: vi.fn(async (agentInput) => {
        prompts.push(agentInput.prompt);
        return {
          conversationId: "conversation-retry",
          contextTokens: null,
          contextWindowMax: null,
        };
      }),
      now: () => "2026-03-27T16:00:00.000Z",
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(result.shouldContinueInContext).toBe(true);
    expect(prompts[0]).toContain("Latest Context Validation Failure");
    expect(prompts[0]).toContain(
      "Validation failed because rollback notes are missing.",
    );
    expect(prompts[0]).toContain("`task-plan-2` - Write plan");
    expect(prompts[0]).toContain("Missing rollback notes");
    expect(prompts[1]).toContain("Latest Context Validation Failure");
    expect(prompts[1]).toContain("`task-plan-2` - Write plan");
  });

  it("resets consecutiveFailureCount when a task completes successfully", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    // Pre-set a failure count to verify it resets
    execution.contextStates["context-plan"]!.consecutiveFailureCount = 2;
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
    const createConversation = vi.fn(async () => ({ id: "conv-pass" }));

    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "Context passed",
      feedback: "Context validation passed.",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const runAgentIteration = vi.fn(async () => {
      if (runAgentIteration.mock.calls.length === 1) {
        await capturedCompleteTask!("task-plan-1", "Done");
        await capturedCompleteTask!("task-plan-2", "Done");
      }
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: { validateContextCompletion },
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

    // consecutiveFailureCount should reset to 0 after successful completion
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(0);
  });
});

// -- Codex implementer continuity ---------------------------------------------

describe("codex implementer continuity", () => {
  function createCodexExecutionWithPlanTasks(): GraphWorkflowExecution {
    const definition = createWorkflowDefinition({
      executionContexts: [
        {
          id: "context-plan",
          title: "Plan",
          agent: {
            backend: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
          },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 5,
            continuity: { enabled: true },
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
      ],
      edges: [],
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
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
        },
      },
      taskStates: {
        "task-plan-1": {
          taskId: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
        "task-plan-2": {
          taskId: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
      },
    });
  }

  it("passes context backend to resolveImplementerCall and records codex turn outcome", async () => {
    const execution = createCodexExecutionWithPlanTasks();
    const repository = createRepository(execution);
    const createConversation = vi.fn(async () => ({ id: "conv-unused" }));
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
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
        sessionRef: { backend: "codex" as const, threadId: "thread-real-123" },
      };
    });

    const resolveImplementerCall = vi.fn(
      async (input: ResolveImplementerCallInput) => ({
        execution: input.execution,
        conversationId: "conv-codex-impl",
        sessionAction: "create" as const,
        promptMode: "iteration_seed" as const,
      }),
    );
    const recordCodexTurnOutcome = vi.fn(
      (input: RecordCodexLaneTurnInput) => input.execution,
    );
    const recordClaudeTurnOutcome = vi.fn(
      (input: RecordClaudeLaneTurnInput) => input.execution,
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: {
        resolveImplementerCall,
        recordClaudeTurnOutcome,
        recordCodexTurnOutcome,
      },
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

    // resolveImplementerCall must receive the context backend
    expect(resolveImplementerCall).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "codex" }),
    );
    // Codex turn outcome should be recorded, not Claude
    expect(recordCodexTurnOutcome).toHaveBeenCalledOnce();
    expect(recordCodexTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        newThreadId: "thread-real-123",
      }),
    );
    expect(recordClaudeTurnOutcome).not.toHaveBeenCalled();
    expect(result.conversationId).toBe("conv-codex-impl");
  });

  it("checks rotateBeforeNextTurn without requiring claude engine", async () => {
    const execution = createCodexExecutionWithPlanTasks();
    const repository = createRepository(execution);
    const createConversation = vi.fn(async () => ({ id: "conv-unused" }));
    const createToolServer = vi.fn(() => ({ server: {} }));
    const runAgentIteration = vi.fn(async () => ({
      conversationId: "conv-mock",
      contextTokens: null,
      contextWindowMax: null,
    }));

    const resolveImplementerCall = vi.fn(
      async (input: ResolveImplementerCallInput) => ({
        execution: input.execution,
        conversationId: "conv-codex-rotate",
        sessionAction: "create" as const,
        promptMode: "iteration_seed" as const,
      }),
    );

    // Codex normally keeps rotateBeforeNextTurn false, but if somehow set, the guard should trigger
    const recordCodexTurnOutcome = vi.fn((input: RecordCodexLaneTurnInput) => ({
      ...input.execution,
      laneStates: {
        implementer: {
          engine: "codex" as const,
          lane: "implementer" as const,
          contextId: "context-plan",
          sessionRef: {
            engine: "codex" as const,
            lane: "implementer" as const,
            threadId: "thread-1",
          },
          lastTurnUsage: null,
          // Defense-in-depth: Codex schema defines this as literal false, but
          // the rotation guard should still stop follow-ups if the value is true
          rotateBeforeNextTurn: true as boolean as false,
          limitEvaluation: "disabled" as const,
          lastUsedAt: "2026-03-27T16:00:00.000Z",
        },
      },
    }));
    const recordClaudeTurnOutcome = vi.fn();

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: {
        resolveImplementerCall,
        recordClaudeTurnOutcome,
        recordCodexTurnOutcome,
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

    // The rotation guard should stop follow-ups even for codex engine
    expect(runAgentIteration).toHaveBeenCalledTimes(1);
  });

  it("reuses codex implementer session across restarts via continuity service E2E", async () => {
    const NOW = "2026-03-27T16:00:00.000Z";
    const execution = createCodexExecutionWithPlanTasks();
    const repository = createRepository(execution);

    let convCounter = 0;
    const createConversation = vi.fn(async () => {
      convCounter++;
      return { id: `conv-cc-${convCounter}` };
    });
    const getConversation = vi.fn(
      async (_p: string, _s: string, id: string) => ({ id }),
    );
    const startCodexThread = vi.fn(async () => ({
      threadId: `thread-${++convCounter}`,
    }));
    const resumeCodexThread = vi.fn(async (threadId: string) => ({ threadId }));
    const createToolServer = vi.fn(() => ({ server: {} }));
    const runAgentIteration = vi.fn(async () => ({
      conversationId: "conv-mock",
      contextTokens: null,
      contextWindowMax: null,
      sessionRef: { backend: "codex" as const, threadId: "thread-real-1" },
    }));

    const continuityService = createWorkflowContinuityService({
      createConversation,
      getConversation,
      startCodexThread,
      resumeCodexThread,
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

    // First iteration: creates a fresh CC conversation and persists the real thread after the turn
    const result1 = await orchestrator.runIteration(input);

    // Simulate restart by round-tripping through schema parser
    const deserialized = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(repository.read())),
    );
    await repository.update("/repo", "session-1", deserialized);

    // Second iteration after restart: should reuse
    const result2 = await orchestrator.runIteration(input);

    expect(result1.conversationId).toBe(result2.conversationId);
    // Only one CC conversation created — the second call reused
    expect(createConversation).toHaveBeenCalledOnce();
    expect(startCodexThread).not.toHaveBeenCalled();
    expect(resumeCodexThread).not.toHaveBeenCalled();
  });
});

// -- Mid-iteration halt: infra_error and circuit breaker ----------------------

describe("mid-iteration halt via signalHalt", () => {
  const NOW = "2026-03-27T16:00:00.000Z";

  function seedRepoWithConsecutiveFailures(
    consecutiveFailureCount: number,
  ): ReturnType<typeof createRepository> {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    execution.contextStates["context-plan"]!.consecutiveFailureCount =
      consecutiveFailureCount;
    return createRepository(execution);
  }

  it("calls signalHalt with validator_infra_error reason and throws IterationHaltedError on infra_error outcome", async () => {
    const repository = seedRepoWithConsecutiveFailures(0);
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
        return {
          server: {},
          close: vi.fn(async () => undefined),
        };
      },
    );
    const createConversation = vi.fn(async () => ({ id: "conv-infra" }));

    const validateContextCompletion = vi.fn(async () => ({
      kind: "infra_error" as const,
      reason: "exception" as const,
      message: "Codex rate limit exceeded",
      engine: "codex" as const,
      sessionRef: null,
      reviewArtifact: null,
    }));

    const signalHalt = vi.fn(
      async (input: {
        projectPath: string;
        sessionName: string;
        reason: unknown;
      }) => {
        const current = structuredClone(repository.read());
        current.status = "halted";
        current.haltReason =
          input.reason as GraphWorkflowExecution["haltReason"];
        await repository.update("/repo", "session-1", current);
        return current;
      },
    );

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask!("task-plan-1", "Done");
      await capturedCompleteTask!("task-plan-2", "Done");
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // signalHalt invoked with the validator_infra_error reason
    expect(signalHalt).toHaveBeenCalledTimes(1);
    expect(signalHalt).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/repo",
        sessionName: "session-1",
        reason: expect.objectContaining({
          type: "validator_infra_error",
          contextId: "context-plan",
          engine: "codex",
          infraReason: "exception",
          message: "Codex rate limit exceeded",
          summary: null,
        }),
      }),
    );

    // consecutiveFailureCount is NOT incremented on infra_error
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(0);

    // Execution ends halted
    expect(result.execution.status).toBe("halted");
    expect(result.execution.haltReason?.type).toBe("validator_infra_error");
    expect(result.shouldContinueInContext).toBe(false);
  });

  it("triggers mid-iteration circuit_breaker halt when failure count crosses threshold inside a single iteration", async () => {
    // Seed with count = 2; threshold is default 3. A third fail should trip.
    const repository = seedRepoWithConsecutiveFailures(2);
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
        return {
          server: {},
          close: vi.fn(async () => undefined),
        };
      },
    );
    const createConversation = vi.fn(async () => ({ id: "conv-breaker" }));

    const validateContextCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Still failing",
      feedback:
        "Context validation blocked completion.\nReopened tasks:\n- task-plan-2\n- Missing: add coverage",
      issues: [
        {
          taskId: "task-plan-2",
          title: "Missing",
          description: "add coverage",
        },
      ],
      reopenTaskIds: ["task-plan-2"],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const signalHalt = vi.fn(
      async (input: {
        projectPath: string;
        sessionName: string;
        reason: unknown;
      }) => {
        const current = structuredClone(repository.read());
        current.status = "halted";
        current.haltReason =
          input.reason as GraphWorkflowExecution["haltReason"];
        await repository.update("/repo", "session-1", current);
        return current;
      },
    );

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask!("task-plan-1", "Done");
      await capturedCompleteTask!("task-plan-2", "Done");
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // signalHalt invoked with circuit_breaker reason referencing the crossed count
    expect(signalHalt).toHaveBeenCalledTimes(1);
    expect(signalHalt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.objectContaining({
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "retry_exhaustion",
          failureCount: 3,
          summary: null,
        }),
      }),
    );

    // consecutiveFailureCount incremented to 3 (the threshold)
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(3);

    // Execution ends halted
    expect(result.execution.status).toBe("halted");
    expect(result.execution.haltReason?.type).toBe("circuit_breaker");
    expect(result.shouldContinueInContext).toBe(false);
  });

  it("does NOT call signalHalt when failure count remains below threshold", async () => {
    // Seed with count = 0; one fail makes it 1, still below default threshold 3.
    const repository = seedRepoWithConsecutiveFailures(0);
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
        return {
          server: {},
          close: vi.fn(async () => undefined),
        };
      },
    );
    const createConversation = vi.fn(async () => ({
      id: "conv-belowthreshold",
    }));

    const validateContextCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Failing",
      feedback:
        "Context validation blocked completion.\nReopened tasks:\n- task-plan-2\n- Missing details: Try harder.",
      issues: [],
      reopenTaskIds: ["task-plan-2"],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const signalHalt = vi.fn();

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask!("task-plan-1", "Done");
      await capturedCompleteTask!("task-plan-2", "Done");
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(signalHalt).not.toHaveBeenCalled();

    // consecutiveFailureCount incremented to 1, below threshold
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);

    // Execution remains running
    expect(result.execution.status).toBe("running");
    expect(result.shouldContinueInContext).toBe(true);
  });

  it("short-circuits completeTask with IterationHaltedError when execution is halted mid-flight", async () => {
    const repository = seedRepoWithConsecutiveFailures(0);

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
        return {
          server: {},
          close: vi.fn(async () => undefined),
        };
      },
    );
    const createConversation = vi.fn(async () => ({ id: "conv-halt" }));

    const validateContextCompletion = vi.fn();
    const signalHalt = vi.fn();

    let capturedError: unknown;
    const runAgentIteration = vi.fn(async () => {
      // Simulate a prior halt persisted between the orchestrator's seed and
      // the agent's first completeTask call (e.g., by another concurrent path).
      const current = structuredClone(repository.read());
      current.status = "halted";
      current.haltReason = {
        type: "recovery_error",
        message: "Pre-existing halt",
      };
      await repository.update("/repo", "session-1", current);
      try {
        await capturedCompleteTask!("task-plan-1", "Done");
      } catch (error) {
        capturedError = error;
        throw error;
      }
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // completeTask threw IterationHaltedError; validator and signalHalt never invoked
    expect(capturedError).toBeInstanceOf(IterationHaltedError);
    expect(validateContextCompletion).not.toHaveBeenCalled();
    expect(signalHalt).not.toHaveBeenCalled();
  });

  it("short-circuits completeTask as idempotent no-op when task is already completed (no validator re-run)", async () => {
    const baseExecution = createExecutionWithPlanTasks({
      "task-plan-1": "completed",
      "task-plan-2": "pending",
    });
    const originalCompletedAt = "2026-03-27T15:55:00.000Z";
    const originalSummary = "Original completion summary";
    const originalConversationId = "conv-original";
    baseExecution.taskStates["task-plan-1"]!.completedAt = originalCompletedAt;
    baseExecution.taskStates["task-plan-1"]!.summary = originalSummary;
    baseExecution.taskStates["task-plan-1"]!.lastConversationId =
      originalConversationId;
    const repository = createRepository(baseExecution);

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
        return {
          server: {},
          close: vi.fn(async () => undefined),
        };
      },
    );
    const createConversation = vi.fn(async () => ({ id: "conv-redo" }));

    const validateContextCompletion = vi.fn();
    const signalHalt = vi.fn();

    let capturedResult: GraphWorkflowExecution | undefined;
    let capturedError: unknown;
    const runAgentIteration = vi.fn(async () => {
      try {
        capturedResult = await capturedCompleteTask!(
          "task-plan-1",
          "Re-doing the already-completed task",
        );
      } catch (error) {
        capturedError = error;
      }
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Guard short-circuits before validation: validator must NOT be invoked
    expect(validateContextCompletion).not.toHaveBeenCalled();
    expect(signalHalt).not.toHaveBeenCalled();

    // completeTask returned normally (idempotent success, not error)
    expect(capturedError).toBeUndefined();
    expect(capturedResult).toBeDefined();

    // Original completion data on the task is preserved — no clobber
    const persisted = repository.read().taskStates["task-plan-1"]!;
    expect(persisted.status).toBe("completed");
    expect(persisted.completedAt).toBe(originalCompletedAt);
    expect(persisted.summary).toBe(originalSummary);
    expect(persisted.lastConversationId).toBe(originalConversationId);

    // Returned execution also reflects preserved state
    const returned = capturedResult!.taskStates["task-plan-1"]!;
    expect(returned.status).toBe("completed");
    expect(returned.completedAt).toBe(originalCompletedAt);
    expect(returned.summary).toBe(originalSummary);
  });

  it("respects custom circuit breaker threshold from context definition", async () => {
    const baseExecution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    // Override the threshold on context-plan to 5
    const contextPlan = baseExecution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    contextPlan.circuitBreaker.consecutiveFailureThreshold = 5;
    // Seed with count = 2; one failing completion makes it 3, below threshold 5.
    baseExecution.contextStates["context-plan"]!.consecutiveFailureCount = 2;
    const repository = createRepository(baseExecution);

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
        return {
          server: {},
          close: vi.fn(async () => undefined),
        };
      },
    );
    const createConversation = vi.fn(async () => ({ id: "conv-thresh" }));

    const validateContextCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Failing",
      feedback:
        "Context validation blocked completion.\nReopened tasks:\n- task-plan-2\n- Missing details: Not yet.",
      issues: [],
      reopenTaskIds: ["task-plan-2"],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const signalHalt = vi.fn();

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask!("task-plan-1", "Done");
      await capturedCompleteTask!("task-plan-2", "Done");
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // 3 < 5 → breaker should NOT trip
    expect(signalHalt).not.toHaveBeenCalled();
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(3);
    expect(result.execution.status).toBe("running");
  });

  it("returns halted execution without re-running finalization when execution is halted at finalize-time", async () => {
    const repository = seedRepoWithConsecutiveFailures(2);
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
        return {
          server: {},
          close: vi.fn(async () => undefined),
        };
      },
    );
    const createConversation = vi.fn(async () => ({ id: "conv-final-halt" }));

    const validateContextCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Failing",
      feedback:
        "Context validation blocked completion.\nReopened tasks:\n- task-plan-2\n- Missing details: Needs more.",
      issues: [],
      reopenTaskIds: ["task-plan-2"],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const signalHalt = vi.fn(
      async (input: {
        projectPath: string;
        sessionName: string;
        reason: unknown;
      }) => {
        const current = structuredClone(repository.read());
        current.status = "halted";
        current.haltReason =
          input.reason as GraphWorkflowExecution["haltReason"];
        await repository.update("/repo", "session-1", current);
        return current;
      },
    );

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask!("task-plan-1", "Done");
      await capturedCompleteTask!("task-plan-2", "Done");
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Finalization short-circuits: shouldContinueInContext is false and status halted
    expect(result.execution.status).toBe("halted");
    expect(result.shouldContinueInContext).toBe(false);
    // The active context should still be "context-plan" since no finalize happened
    expect(result.execution.activeContextId).toBe("context-plan");
  });
});
