import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
import { captureContextReviewOrigin } from "./review-origin";
import type {
  ExecutionMutationDecision,
  ExecutionMutationOutcome,
} from "@/lib/workflow-graph/execution-mutation";
import { createContextTestCapabilities } from "@/lib/workflow-graph/testing/context-capabilities";
import { createNonParticipatingGraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import { describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
  stubValidationRoundService,
} from "./test-fixtures";
import {
  createContextIterationFixture,
  type BoundIterationCompletion,
} from "./testing/iteration-fixture";

interface InMemoryExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  mutateActive<Value = void, Refusal = never>(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => ExecutionMutationDecision<Value, Refusal>,
  ): Promise<ExecutionMutationOutcome<Value, Refusal>>;
  findLatestContextValidationEvent(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<GraphWorkflowExecutionEvent | null>;
}

function createRepository(
  initialExecution: GraphWorkflowExecution,
): InMemoryExecutionRepository & {
  read(): GraphWorkflowExecution;
  write(execution: GraphWorkflowExecution): void;
  appendedEvents: GraphWorkflowExecutionEvent[];
} {
  let activeExecution = initialExecution;
  let lock: Promise<void> = Promise.resolve();
  const appendedEvents: GraphWorkflowExecutionEvent[] = [];

  return {
    async getActive() {
      return activeExecution;
    },
    async mutateActive(_projectPath, _sessionName, fn) {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        return applyFixtureMutation(activeExecution, fn, (next, delivery) => {
          activeExecution = next;
          appendedEvents.push(...delivery.events);
        });
      } finally {
        release();
      }
    },
    async findLatestContextValidationEvent(
      _projectPath,
      _sessionName,
      _executionId,
      contextId,
    ) {
      for (let i = appendedEvents.length - 1; i >= 0; i -= 1) {
        const entry = appendedEvents[i]!;
        const event = entry.event;
        if (
          event.type === "graph-workflow-validation-result" &&
          "contextId" in event &&
          event.contextId === contextId
        ) {
          return entry;
        }
      }
      return null;
    },
    read() {
      return activeExecution;
    },
    write(execution) {
      activeExecution = execution;
    },
    appendedEvents,
  };
}

function createContextValidatorExecution(
  circuitBreaker: { consecutiveFailureThreshold?: number } = {},
) {
  const baseDefinition = createResolvedWorkflowDefinition();
  const definition = createResolvedWorkflowDefinition({
    executionContexts: baseDefinition.executionContexts.map((context) =>
      context.id === "context-plan"
        ? {
            ...context,
            circuitBreaker,
            acceptanceCriteria:
              "The plan must include implementation steps, rollback notes, and test coverage.",
            contextValidator: {
              enabled: true,
              assignments: [
                {
                  id: "general",
                  profile: { tier: "builtin", id: "general-reviewer" },
                  profileSnapshot: makeProfileSnapshot(),
                  strategy: "conversation",
                  authority: "blocking",
                  agent: {
                    backend: "claude",
                    modelSelection: {
                      modelId: "sonnet",
                      parameters: { effort: "medium" },
                    },
                  },
                  continuity: { enabled: true },
                },
              ],
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
    status: "running",
    activeContextIds: ["context-plan"],
    workingDefinition: definition,
    contextStates: {
      ...createWorkflowExecution().contextStates,
      "context-plan": {
        ...createWorkflowExecution().contextStates["context-plan"]!,
        status: "running",
        totalTaskCount: 2,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
      },
    },
    taskStates: {
      ...createWorkflowExecution().taskStates,
      "task-plan-1": {
        ...createWorkflowExecution().taskStates["task-plan-1"]!,
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
  captureContextReviewOrigin(
    execution,
    "context-plan",
    "stub-head",
    "2026-08-04T10:00:00.000Z",
  );
  return execution;
}

function createSignalHalt(
  repository: ReturnType<typeof createRepository>,
  completedAt = "2026-03-27T16:30:00.000Z",
) {
  return vi.fn(async ({ reason }: { reason: GraphWorkflowHaltReason }) => {
    const current = repository.read();
    const halted: GraphWorkflowExecution = {
      ...current,
      status: "halted",
      haltReason: reason,
      completedAt,
    };
    repository.write(halted);
    return halted;
  });
}

describe("graph workflow iteration context validation integration", () => {
  it("reopens named tasks after end-of-context validation fails and preserves failure history", async () => {
    const repository = createRepository(createContextValidatorExecution());

    let toolInput: BoundIterationCompletion | null = null;
    const validateContextCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "The plan document is missing rollback notes.",
      feedback:
        "Context validation blocked completion.\nThe plan document is missing rollback notes.\nReopened tasks:\n- task-plan-2\n- Missing rollback notes: Add rollback guidance to the plan.",
      issues: [
        {
          assignmentId: "general",
          title: "Missing rollback notes",
          description: "Add rollback guidance to the plan.",
          taskId: "task-plan-2",
        },
      ],
      reopenTaskIds: ["task-plan-2"],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const orchestrator = createContextIterationFixture({
      ...createContextTestCapabilities(),
      materializeWorkflowDocuments: async ({ execution }) => execution,

      executionContract: createNonParticipatingGraphExecutionContract(),

      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: async () => ({ id: "conversation-1" }),
      bindTaskCompletion: (input) => {
        toolInput = input;
        return;
      },
      runAgentIteration: async () => {
        if (!toolInput) {
          throw new Error("Tool server input was not captured");
        }

        await toolInput.completeTask(
          "task-plan-1",
          "Inspected the codebase and gathered requirements.",
        );
        await toolInput.completeTask(
          "task-plan-2",
          "Drafted the implementation plan.",
        );
        return {
          conversationId: "conversation-1",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
      validationService: { validateContextCompletion },
      now: () => "2026-03-27T16:30:00.000Z",
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
    expect(result.decision.kind).toBe("continue");
    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "running",
    );
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);
    expect(result.execution.taskStates["task-plan-1"]).toMatchObject({
      status: "completed",
      failureHistory: [],
    });
    expect(result.execution.taskStates["task-plan-2"]).toMatchObject({
      status: "pending",
      completedAt: null,
      failureMessage: expect.stringContaining("Missing rollback notes"),
    });
    expect(
      result.execution.taskStates["task-plan-2"]?.failureHistory,
    ).toHaveLength(1);

    const validationEvent = repository.appendedEvents.find(
      (entry) => entry.event.type === "graph-workflow-validation-result",
    );
    expect(validationEvent?.event).toMatchObject({
      type: "graph-workflow-validation-result",
      validatorType: "context",
      pass: false,
      reopenTaskIds: ["task-plan-2"],
    });
  });

  it("does not run context validation until every task in the context is completed", async () => {
    const repository = createRepository(createContextValidatorExecution());

    let toolInput: BoundIterationCompletion | null = null;
    const validateContextCompletion = vi.fn();

    const orchestrator = createContextIterationFixture({
      ...createContextTestCapabilities(),
      materializeWorkflowDocuments: async ({ execution }) => execution,

      executionContract: createNonParticipatingGraphExecutionContract(),

      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: async () => ({ id: "conversation-1" }),
      bindTaskCompletion: (input) => {
        toolInput = input;
        return;
      },
      runAgentIteration: async () => {
        if (!toolInput) {
          throw new Error("Tool server input was not captured");
        }

        await toolInput.completeTask(
          "task-plan-1",
          "Inspected the codebase and gathered requirements.",
        );
        return {
          conversationId: "conversation-1",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
      validationService: { validateContextCompletion },
      now: () => "2026-03-27T16:30:00.000Z",
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(validateContextCompletion).not.toHaveBeenCalled();
    expect(result.decision.kind).toBe("continue");
    expect(result.execution.taskStates["task-plan-1"]?.status).toBe(
      "completed",
    );
    expect(result.execution.taskStates["task-plan-2"]?.status).toBe("pending");
  });

  it("halts execution on context validator infra_error without incrementing consecutiveFailureCount", async () => {
    const repository = createRepository(createContextValidatorExecution());
    const signalHalt = createSignalHalt(repository);

    let toolInput: BoundIterationCompletion | null = null;
    const validateContextCompletion = vi.fn(async () => ({
      kind: "infra_exhausted" as const,
      assignmentId: "general",
      attempts: 3,
      reason: "exception" as const,
      message: "Codex API rate limit exceeded",
      engine: "codex" as const,
    }));

    const orchestrator = createContextIterationFixture({
      ...createContextTestCapabilities(),
      materializeWorkflowDocuments: async ({ execution }) => execution,

      executionContract: createNonParticipatingGraphExecutionContract(),

      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: async () => ({ id: "conversation-1" }),
      bindTaskCompletion: (input) => {
        toolInput = input;
        return;
      },
      runAgentIteration: async () => {
        if (!toolInput) {
          throw new Error("Tool server input was not captured");
        }

        await toolInput.completeTask("task-plan-1", "Inspected the codebase.");
        await toolInput.completeTask("task-plan-2", "Drafted the plan.");
        return {
          conversationId: "conversation-1",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
      signalHalt,
      validationService: { validateContextCompletion },
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
          contextId: "context-plan",
          engine: "codex",
          infraReason: "exception",
          message: "Codex API rate limit exceeded",
        }),
      }),
    );
    expect(result.decision.kind).toBe("execution_stopped");
    expect(result.execution.status).toBe("halted");
    expect(result.execution.haltReason?.type).toBe("validator_infra_error");
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(0);
  });

  it("trips the circuit breaker after repeated context validation failures across iterations", async () => {
    const repository = createRepository(
      createContextValidatorExecution({ consecutiveFailureThreshold: 2 }),
    );
    const signalHalt = createSignalHalt(repository);

    let toolInput: BoundIterationCompletion | null = null;
    const validateContextCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Rollback notes are still missing.",
      feedback:
        "Context validation blocked completion.\nRollback notes are still missing.\nReopened tasks:\n- task-plan-2\n- Missing rollback notes: Add rollback guidance to the plan.",
      issues: [
        {
          assignmentId: "general",
          title: "Missing rollback notes",
          description: "Add rollback guidance to the plan.",
          taskId: "task-plan-2",
        },
      ],
      reopenTaskIds: ["task-plan-2"],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const orchestrator = createContextIterationFixture({
      ...createContextTestCapabilities(),
      materializeWorkflowDocuments: async ({ execution }) => execution,

      executionContract: createNonParticipatingGraphExecutionContract(),

      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: async () => ({ id: "conversation-1" }),
      bindTaskCompletion: (input) => {
        toolInput = input;
        return;
      },
      runAgentIteration: async () => {
        if (!toolInput) {
          throw new Error("Tool server input was not captured");
        }

        await toolInput.completeTask(
          "task-plan-1",
          "Inspected the codebase and gathered requirements.",
        );
        await toolInput.completeTask(
          "task-plan-2",
          "Drafted the implementation plan.",
        );
        return {
          conversationId: "conversation-1",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
      signalHalt,
      validationService: { validateContextCompletion },
      now: () => "2026-03-27T16:30:00.000Z",
    });

    const firstResult = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });
    const secondResult = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(firstResult.decision.kind).toBe("continue");
    expect(validateContextCompletion).toHaveBeenCalledTimes(2);
    expect(signalHalt).toHaveBeenCalledTimes(1);
    expect(secondResult.decision.kind).toBe("execution_stopped");
    expect(secondResult.execution.status).toBe("halted");
    expect(secondResult.execution.haltReason).toMatchObject({
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      failureCount: 2,
    });
    expect(
      secondResult.execution.taskStates["task-plan-2"]?.failureHistory,
    ).toHaveLength(2);
  });

  it("resets consecutiveFailureCount on a later passing context validation while preserving failure history", async () => {
    const repository = createRepository(createContextValidatorExecution());

    let toolInput: BoundIterationCompletion | null = null;
    const validateContextCompletion = vi
      .fn()
      .mockImplementationOnce(async () => ({
        kind: "fail" as const,
        summary: "Rollback notes are missing.",
        feedback:
          "Context validation blocked completion.\nRollback notes are missing.\nReopened tasks:\n- task-plan-2\n- Missing rollback notes: Add rollback guidance to the plan.",
        issues: [
          {
            title: "Missing rollback notes",
            description: "Add rollback guidance to the plan.",
            taskId: "task-plan-2",
          },
        ],
        reopenTaskIds: ["task-plan-2"],
        sessionRef: null,
        reviewArtifact: null,
      }))
      .mockImplementationOnce(async () => ({
        kind: "pass" as const,
        summary: "All acceptance criteria are satisfied.",
        feedback:
          "Context validation passed.\nAll acceptance criteria are satisfied.",
        issues: [],
        reopenTaskIds: [],
        sessionRef: null,
        reviewArtifact: null,
      }));

    const orchestrator = createContextIterationFixture({
      ...createContextTestCapabilities(),
      materializeWorkflowDocuments: async ({ execution }) => execution,

      executionContract: createNonParticipatingGraphExecutionContract(),

      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: async () => ({ id: "conversation-1" }),
      bindTaskCompletion: (input) => {
        toolInput = input;
        return;
      },
      runAgentIteration: async () => {
        if (!toolInput) {
          throw new Error("Tool server input was not captured");
        }

        await toolInput.completeTask(
          "task-plan-1",
          "Inspected the codebase and gathered requirements.",
        );
        await toolInput.completeTask(
          "task-plan-2",
          "Updated the plan with the missing details.",
        );
        return {
          conversationId: "conversation-1",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
      validationService: { validateContextCompletion },
      now: () => "2026-03-27T16:30:00.000Z",
    });

    const firstResult = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });
    const secondResult = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(firstResult.decision.kind).toBe("continue");
    expect(secondResult.decision.kind).toBe("ready_to_land");
    expect(secondResult.execution.contextStates["context-plan"]?.status).toBe(
      "completed",
    );
    expect(
      secondResult.execution.contextStates["context-plan"]
        ?.consecutiveFailureCount,
    ).toBe(0);
    expect(secondResult.execution.taskStates["task-plan-2"]?.status).toBe(
      "completed",
    );
    expect(
      secondResult.execution.taskStates["task-plan-2"]?.failureHistory,
    ).toHaveLength(1);
  });
});
