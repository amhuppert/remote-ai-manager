import { afterEach, describe, expect, it, vi } from "vitest";
import { assignmentFingerprint } from "./lane-identity";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowSSEEvent,
  GraphWorkflowValidationSpecialistEntry,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowEventDelivery,
  type GraphWorkflowPushInfo,
} from "@/lib/workflow-graph/execution-events";
import {
  _resetRegistryForTesting,
  registerExecutionLogger,
  type ExecutionLogger,
} from "@/lib/workflow-graph/execution-logger";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
  stubValidationRoundService,
} from "@/lib/workflow-graph/test-fixtures";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import {
  appendFailureHistory,
  createGraphWorkflowIterationOrchestrator,
  IterationHaltedError,
  type GraphWorkflowRunAgentIterationInput,
} from "./iteration-orchestrator";
import {
  applyLiveExecutionEdits,
  type LiveEditDeps,
  type ResolvedContextConfig,
} from "./runtime-edits";
import { composeImplementerLaneWriteEnvelope } from "./implementer-lane-write-envelope";
import type { FsWritePolicy } from "@/lib/agent-backends/task";
import type { GraphWorkflowContextValidationInput } from "./execution-validation";
import type { CohortParkedLane } from "./validation-cohort";
import type { ResumeUserInputContext } from "./user-input-gate";
import { IterationFailureWithProgressError } from "./iteration-failure-with-progress";
import { StaleLoopFenceError, runWithLoopFence } from "./loop-fence";
import { AgentTurnFailedError } from "./errors";
import type {
  ResolveImplementerCallInput,
  RecordLaneTurnOutcomeInput,
  GraphLaneContinuityDeps,
} from "./lane-continuity";
import { createGraphLaneContinuity } from "./lane-continuity";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { validateJsonSchemaSubset } from "@/lib/workflows/primitives/output-schema-subset";
import type { GraphWorkflowValidationIssue } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowContextOutputCaptureOutcome } from "@/lib/workflow-graph/context-output-capture";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createUserInputGateService } from "./user-input-gate";
import { createGraphWorkflowSignalHaltHandler } from "./graph-workflow-signal-halt";
import { createGraphWorkflowManager } from "./workflow-manager";
import { formatQuestionAnswersBlock } from "@/lib/conversations/question-answers-block";
import type {
  AskQuestionAnswer,
  AskQuestionItem,
} from "@/lib/conversations/schemas";

type MutateActiveReturn =
  | GraphWorkflowExecution
  | {
      execution: GraphWorkflowExecution;
      events: GraphWorkflowExecutionEvent[];
      pushes?: GraphWorkflowPushInfo[];
    };

interface InMemoryExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveReturn | Promise<MutateActiveReturn>,
  ): Promise<GraphWorkflowExecution>;
  findLatestContextValidationEvent(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<GraphWorkflowExecutionEvent | null>;
}

/**
 * Global config floor for the live-edit core, which this file drives only to
 * make a placement change the production way — through the one live-edit core
 * — before asserting which placement the NEXT iteration dispatches under.
 */
const LIVE_EDIT_RESOLVED_DEFAULTS: ResolvedContextConfig = {
  implementer: {
    id: "implementer",
    profile: { tier: "builtin", id: "general-implementer" },
    profileSnapshot: makeProfileSnapshot(),
    agent: {
      backend: "claude",
      modelSelection: { modelId: "opus", parameters: { effort: "medium" } },
    },
  },
  contextValidator: { enabled: false, assignments: [] },
  scriptValidator: { commands: [] },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  collaboration: {
    enabled: { value: true, source: "global" },
    secondAgent: {
      value: {
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
      },
      source: "global",
    },
    negotiationRounds: { value: 3, source: "global" },
    autonomousResolutionThreshold: { value: "minor", source: "global" },
  },
  agentValidation: {
    implementer: { value: { mode: "all", except: [] }, source: "global" },
    contextValidator: {
      value: { mode: "only", commands: [] },
      source: "global",
    },
  },
};

function makeLiveEditDeps(): LiveEditDeps {
  let counter = 0;
  return {
    createTaskId: () => `task-minted-${(counter += 1)}`,
    resolvedGlobalDefaults: () => LIVE_EDIT_RESOLVED_DEFAULTS,
    validationCommandPreflight: () => ({
      commandCosts: { typecheck: 2, test: 5 },
      concurrencyLimit: 8,
    }),
    snapshotFor: (assignment) => makeProfileSnapshot({ ...assignment.profile }),
    now: () => "2026-03-27T16:20:00.000Z",
  };
}

function isResultWithEvents(value: MutateActiveReturn): value is {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  pushes?: GraphWorkflowPushInfo[];
} {
  return (
    "events" in value &&
    "execution" in value &&
    Array.isArray((value as { events: unknown }).events)
  );
}

function createRepository(
  initialExecution: GraphWorkflowExecution,
): InMemoryExecutionRepository & {
  read(): GraphWorkflowExecution;
  appendedEvents: GraphWorkflowExecutionEvent[];
  commits: Array<{
    execution: GraphWorkflowExecution;
    events: GraphWorkflowExecutionEvent[];
  }>;
  /**
   * Post-commit delivery hook, mirroring the repository-level mutation seam
   * that broadcasts a reducer's derived events after the write commits. Tests
   * that assert broadcasts assign the event publisher's `deliver` here (the
   * publisher is created after this repository, hence the settable hook).
   */
  deliver: (delivery: GraphWorkflowEventDelivery) => void;
} {
  let activeExecution = initialExecution;
  let lock: Promise<void> = Promise.resolve();
  const appendedEvents: GraphWorkflowExecutionEvent[] = [];
  const commits: Array<{
    execution: GraphWorkflowExecution;
    events: GraphWorkflowExecutionEvent[];
  }> = [];

  const repository: InMemoryExecutionRepository & {
    read(): GraphWorkflowExecution;
    appendedEvents: GraphWorkflowExecutionEvent[];
    commits: Array<{
      execution: GraphWorkflowExecution;
      events: GraphWorkflowExecutionEvent[];
    }>;
    deliver: (delivery: GraphWorkflowEventDelivery) => void;
  } = {
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
        const result = await fn(structuredClone(activeExecution));
        if (isResultWithEvents(result)) {
          activeExecution = result.execution;
          appendedEvents.push(...result.events);
          commits.push({
            execution: structuredClone(result.execution),
            events: structuredClone(result.events),
          });
          // Mirror the production seam: commit the rows, then perform delivery
          // post-commit through the injected publisher so a sibling publisher's
          // broadcast/push fires here (the reducer returned inert data).
          repository.deliver({
            events: result.events,
            pushes: result.pushes ?? [],
          });
        } else {
          activeExecution = result;
          commits.push({
            execution: structuredClone(result),
            events: [],
          });
        }
        return activeExecution;
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
    appendedEvents,
    commits,
    deliver: () => {},
  };
  return repository;
}

/**
 * Real graph lane continuity over an in-memory lane store, persisting through
 * the same in-memory repository the orchestrator under test mutates.
 */
function makeLaneContinuityService(
  repository: InMemoryExecutionRepository,
  deps: Partial<GraphLaneContinuityDeps> = {},
): ReturnType<typeof createGraphLaneContinuity> {
  return createGraphLaneContinuity({
    laneService: createLaneService({
      store: createInMemoryLaneStore(),
      now: () => "2026-03-27T16:00:00.000Z",
    }),
    executionRepository: repository,
    createConversation: vi.fn(),
    getConversation: vi.fn(),
    now: () => "2026-03-27T16:00:00.000Z",
    ...deps,
  });
}

function createExecutionWithPlanTasks(
  statuses: Record<
    string,
    GraphWorkflowExecution["taskStates"][string]["status"]
  >,
): GraphWorkflowExecution {
  const definition = createResolvedWorkflowDefinition({
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
    activeContextIds: ["context-plan"],
    workingDefinition: definition,
    contextStates: {
      "context-plan": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "context-plan",
        status: "running",
        totalTaskCount: 2,
        completedTaskCount: statuses["task-plan-1"] === "completed" ? 1 : 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
      "context-implement": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "context-implement",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
      "context-verify": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "context-verify",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
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
        kind: "shared",
        createdAt: "2026-03-27T15:00:00.000Z",
        updatedAt: "2026-03-27T15:00:00.000Z",
        lastUpdatedByConversationId: "conversation-seed",
      },
    ],
  });
}

function seedFailedContextValidationEvent(
  repository: { appendedEvents: GraphWorkflowExecutionEvent[] },
  executionId: string,
  overrides: Partial<{
    summary: string;
    reopenTaskIds: string[];
    issues: Array<{
      taskId: string;
      title: string;
      description: string;
    }>;
    roundSeq: number | null;
    specialists: GraphWorkflowValidationSpecialistEntry[];
  }> = {},
): void {
  repository.appendedEvents.push({
    occurredAt: "2026-03-27T15:55:00.000Z",
    event: {
      type: "graph-workflow-validation-result",
      projectName: "repo",
      sessionName: "session-1",
      executionId,
      contextId: "context-plan",
      validatorType: "context",
      roundSeq: overrides.roundSeq ?? null,
      specialists: overrides.specialists ?? [],
      kind: "context_validation",
      rejectedOutput: null,
      gateRepairAttempts: null,
      gateRepairBudget: null,
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
    preReset: false,
  });
}

describe("graph workflow iteration orchestrator", () => {
  it("rejects an iteration from a stale loop generation before any agent work starts", async () => {
    // A zombie loop that wakes from a long await seeds its next iteration
    // through here; the ambient fence no longer matches the persisted
    // generation (the execution was resumed), so the iteration must die
    // before creating a conversation or prompting an agent.
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conversation-1" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const runAgentIteration = vi.fn();

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      now() {
        return "2026-03-27T16:00:00.000Z";
      },
    });

    const staleFence = {
      projectPath: "/repo",
      sessionName: "session-1",
      executionId: repository.read().id,
      loopEpoch: repository.read().loopEpoch + 1,
    };
    await expect(
      runWithLoopFence(staleFence, () =>
        orchestrator.runIteration({
          projectPath: "/repo",
          projectName: "repo",
          sessionName: "session-1",
          contextId: "context-plan",
        }),
      ),
    ).rejects.toThrow(StaleLoopFenceError);

    expect(createConversation).not.toHaveBeenCalled();
    expect(runAgentIteration).not.toHaveBeenCalled();
  });

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

      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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

    // The lane conversation is handed the context implementer's seeded
    // snapshot, not left to resolve a profile of its own (R4).
    expect(createConversation).toHaveBeenCalledWith("/repo", "session-1", {
      role: "iteration",
      profileSnapshot:
        repository.read().workingDefinition.executionContexts[0]!.implementer
          .profileSnapshot,
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

  it("filters scoped charter invariants from the dispatched implementer prompt", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const charter: WorkflowCharter = {
      mission: "Apply invariants only to their declared graph contexts.",
      invariants: [
        { id: "global", statement: "Global-implementer-sentinel" },
        {
          id: "verify-only",
          statement: "Out-of-scope-implementer-sentinel",
          appliesTo: { contextIds: ["context-verify"] },
        },
      ],
      sourcesOfTruth: [],
    };
    execution.charter = charter;
    for (const context of execution.workingDefinition.executionContexts) {
      context.charter = charter;
    }

    const repository = createRepository(execution);
    const prompts: string[] = [];
    const runAgentIteration = vi.fn(
      async (input: GraphWorkflowRunAgentIterationInput) => {
        prompts.push(input.prompt);
        const next = structuredClone(repository.read());
        for (const taskId of ["task-plan-1", "task-plan-2"]) {
          next.taskStates[taskId] = {
            ...next.taskStates[taskId]!,
            status: "completed",
            summary: "Done",
            completedAt: "2026-03-27T16:02:00.000Z",
          };
        }
        next.contextStates["context-plan"] = {
          ...next.contextStates["context-plan"]!,
          completedTaskCount: 2,
        };
        await repository.mutateActive("/repo", "session-1", () => next);
        return {
          conversationId: "conversation-1",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
    );
    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: async () => ({ id: "conversation-1" }),
      createToolServer: () => ({ server: { id: "tool-server" } }),
      runAgentIteration,
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Global-implementer-sentinel");
    expect(prompts[0]).not.toContain("Out-of-scope-implementer-sentinel");
  });

  it("materializes workflow documents into a worktree-isolation lane before the agent runs", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conversation-1" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const materializeCalls: Array<{
      executionId: string;
      worktreePath: string;
    }> = [];
    const runAgentIteration = vi.fn(async () => {
      // The materializer must have run before the agent turn.
      expect(materializeCalls).toHaveLength(1);
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "done",
        completedAt: "2026-03-27T16:02:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 1,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      materializeWorkflowDocuments: async ({ execution, worktreePath }) => {
        materializeCalls.push({ executionId: execution.id, worktreePath });
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
      executionTarget: {
        worktreePath: "/repo/.worktrees/session-1.context-plan",
        branchName: "csm/session-1-context-plan",
        isolation: "worktree",
        laneId: "lane-1",
      },
    });

    expect(materializeCalls).toEqual([
      {
        executionId: "execution-1",
        worktreePath: "/repo/.worktrees/session-1.context-plan",
      },
    ]);
  });

  it("does not materialize documents for a session-isolation lane", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "conversation-1" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const materializeWorkflowDocuments = vi.fn(async () => {});
    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "done",
        completedAt: "2026-03-27T16:02:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 1,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      materializeWorkflowDocuments,
      now() {
        return "2026-03-27T16:00:00.000Z";
      },
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
      executionTarget: {
        worktreePath: "/repo/.worktrees/session-1",
        branchName: "csm/session-1",
        isolation: "session",
        laneId: null,
      },
    });

    expect(materializeWorkflowDocuments).not.toHaveBeenCalled();
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

      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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

      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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

    expect(runAgentIteration).toHaveBeenCalledWith(
      expect.objectContaining({ askUserQuestionsEnabled: false }),
    );
    expect(result.shouldContinueInContext).toBe(false);
    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "completed",
    );
  });

  it("withholds the terminal transition when recovery already returned the context to ready", async () => {
    // A retryable iteration error sends the context back to `ready` for a fresh
    // iteration while leaving `execution.status` on "running" — so the
    // mid-flight halt guard cannot fire. This iteration no longer owns the
    // context, and writing `completed` over the recovery is the illegal
    // `ready` -> `completed` transition that halts the whole execution.
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "completed",
        "task-plan-2": "pending",
      }),
    );
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
        status: "ready",
      };

      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-3" })),
      createToolServer: vi.fn(() => ({ server: { id: "tool-server" } })),
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

    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "ready",
    );
    expect(result.shouldContinueInContext).toBe(false);
    expect(repository.read().status).toBe("running");
  });

  it("threads the resolved askUserQuestions toggle into runAgentIteration (Req 8.1)", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "completed",
      "task-plan-2": "pending",
    });
    execution.workingDefinition.executionContexts =
      execution.workingDefinition.executionContexts.map((ctx) =>
        ctx.id === "context-plan"
          ? { ...ctx, askUserQuestions: { enabled: true } }
          : ctx,
      );
    const repository = createRepository(execution);
    const createConversation = vi.fn(async () => ({ id: "conversation-aq" }));
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
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      now() {
        return "2026-03-27T16:20:00.000Z";
      },
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(runAgentIteration).toHaveBeenCalledWith(
      expect.objectContaining({ askUserQuestionsEnabled: true }),
    );
  });

  it("dispatches the placement a live edit accepted on the context's next turn (lwp R10.2)", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "completed",
      "task-plan-2": "pending",
    });
    execution.workingDefinition.executionContexts =
      execution.workingDefinition.executionContexts.map((ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              placement: {
                lane: "delivery",
                mode: "owned",
                ownedPaths: ["docs"],
              },
            }
          : ctx,
      );
    const repository = createRepository(execution);
    const createConversation = vi.fn(async () => ({
      id: "conversation-placement",
    }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));

    // The first iteration leaves the task open, so the context legitimately
    // takes a SECOND iteration — the turn the accepted edit has to reach.
    let completeTheTask = false;
    const dispatchedPlacements: unknown[] = [];
    // Not a re-read of the dispatch field: each turn's placement goes through
    // the same composer the implementer runner binds in production, so what is
    // asserted is the write envelope the turn would run under.
    const dispatchedEnvelopes: (FsWritePolicy | null)[] = [];
    const runAgentIteration = vi.fn(
      async (input: GraphWorkflowRunAgentIterationInput) => {
        dispatchedPlacements.push(input.placement);
        dispatchedEnvelopes.push(
          input.placement === undefined || input.placement.mode === "full"
            ? null
            : composeImplementerLaneWriteEnvelope(
                {
                  executionId: input.executionId,
                  contextId: input.contextId,
                  worktreePath: "/repo/worktree",
                  // The same derivation the implementer runner performs before
                  // dispatch, so what is asserted is the policy the turn would
                  // actually run under.
                  ownedPaths:
                    input.placement.mode === "owned"
                      ? input.placement.ownedPaths
                      : [],
                },
                {
                  scratchRootDir: "/scratch",
                  ensureDir: () => {},
                  exists: () => true,
                  // Idempotent, so a path already canonical resolves to itself.
                  realpath: (target: string) =>
                    target.startsWith("/private/")
                      ? target
                      : `/private${target}`,
                },
              ).policy,
        );
        if (completeTheTask) {
          const current = structuredClone(repository.read());
          const taskState = current.taskStates["task-plan-2"];
          const contextState = current.contextStates["context-plan"];
          if (!taskState || !contextState) {
            throw new Error("fixture is missing context-plan runtime state");
          }
          current.taskStates["task-plan-2"] = {
            ...taskState,
            status: "completed",
            summary: "Finished planning",
            completedAt: "2026-03-27T16:22:00.000Z",
          };
          current.contextStates["context-plan"] = {
            ...contextState,
            completedTaskCount: 2,
          };
          await repository.mutateActive("/repo", "session-1", () => current);
        }
        return {
          conversationId: "conv-mock",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      now() {
        return "2026-03-27T16:20:00.000Z";
      },
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(dispatchedPlacements[0]).toEqual({
      lane: "delivery",
      mode: "owned",
      ownedPaths: ["docs"],
    });

    // The accepted change goes through the live-edit core on the paused
    // execution — pause-to-edit, because the first iteration started it.
    const edited = applyLiveExecutionEdits(
      { ...repository.read(), status: "paused" },
      {
        operations: [
          {
            type: "update-context",
            contextId: "context-plan",
            placement: {
              lane: "delivery",
              mode: "owned",
              ownedPaths: ["docs", "scripts/docs.ts"],
            },
          },
        ],
      },
      makeLiveEditDeps(),
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    await repository.mutateActive("/repo", "session-1", () => ({
      ...edited.execution,
      status: "running",
    }));

    completeTheTask = true;
    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(dispatchedPlacements.at(-1)).toEqual({
      lane: "delivery",
      mode: "owned",
      ownedPaths: ["docs", "scripts/docs.ts"],
    });

    // The point of the criterion: the envelope the NEXT turn runs under grew
    // the newly-owned path, while the first turn's did not. Asserted on the
    // repository entries rather than the whole allowlist, because the scratch
    // and payload entries around them are the composer's own contract and have
    // their own coverage.
    expect(dispatchedEnvelopes[0]?.allowWrite).toContain(
      "/private/repo/worktree/docs",
    );
    expect(dispatchedEnvelopes[0]?.allowWrite).not.toContain(
      "/private/repo/worktree/scripts/docs.ts",
    );
    expect(dispatchedEnvelopes.at(-1)?.allowWrite).toEqual(
      expect.arrayContaining([
        "/private/repo/worktree/docs",
        "/private/repo/worktree/scripts/docs.ts",
      ]),
    );
    expect(dispatchedEnvelopes.at(-1)?.denyWrite).toEqual([
      "/private/repo/worktree/.git",
    ]);
  });

  it("dispatches a placement edit that lands while the iteration is starting (lwp R10.2)", async () => {
    // `context-implement` is unstarted at entry, so update-context is editable
    // WHILE RUNNING — no pause required. That opens a real interleaving: the
    // orchestrator reads the definition, then awaits conversation resolution,
    // and only then commits the seed that marks the context started. An edit
    // that commits inside that window is accepted against a lifecycle that
    // still reads `unstarted`, so it has to reach the very turn being
    // dispatched — there is no later turn it could belong to.
    const execution = createExecutionWithPlanTasks({});
    execution.workingDefinition.executionContexts =
      execution.workingDefinition.executionContexts.map((ctx) =>
        ctx.id === "context-implement"
          ? {
              ...ctx,
              placement: {
                lane: "implement",
                mode: "owned",
                ownedPaths: ["docs"],
              },
            }
          : ctx,
      );
    const repository = createRepository(execution);

    let editOutcome: "not-attempted" | "accepted" | "rejected" =
      "not-attempted";
    const createConversation = vi.fn(async () => {
      const edited = applyLiveExecutionEdits(
        repository.read(),
        {
          operations: [
            {
              type: "update-context",
              contextId: "context-implement",
              placement: {
                lane: "implement",
                mode: "owned",
                ownedPaths: ["docs", "scripts/docs.ts"],
              },
            },
          ],
        },
        makeLiveEditDeps(),
      );
      editOutcome = edited.ok ? "accepted" : "rejected";
      if (edited.ok) {
        await repository.mutateActive(
          "/repo",
          "session-1",
          () => edited.execution,
        );
      }
      return { id: "conversation-race" };
    });
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));

    const dispatchedPlacements: unknown[] = [];
    const runAgentIteration = vi.fn(
      async (input: GraphWorkflowRunAgentIterationInput) => {
        dispatchedPlacements.push(input.placement);
        const current = structuredClone(repository.read());
        const taskState = current.taskStates["task-implement-1"];
        const contextState = current.contextStates["context-implement"];
        if (!taskState || !contextState) {
          throw new Error("fixture is missing context-implement runtime state");
        }
        current.taskStates["task-implement-1"] = {
          ...taskState,
          status: "completed",
          summary: "Implemented",
          completedAt: "2026-03-27T16:22:00.000Z",
        };
        current.contextStates["context-implement"] = {
          ...contextState,
          completedTaskCount: 1,
        };
        await repository.mutateActive("/repo", "session-1", () => current);
        return {
          conversationId: "conv-mock",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      now() {
        return "2026-03-27T16:20:00.000Z";
      },
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-implement",
    });

    // The interleaved edit really was accepted (a rejection would make the
    // dispatch assertion below pass for the wrong reason).
    expect(editOutcome).toBe("accepted");
    expect(dispatchedPlacements).toEqual([
      {
        lane: "implement",
        mode: "owned",
        ownedPaths: ["docs", "scripts/docs.ts"],
      },
    ]);
    // The seed preserved the edit in the working definition, so the dispatched
    // value is the persisted one and not a lucky read of a discarded snapshot.
    expect(
      repository
        .read()
        .workingDefinition.executionContexts.find(
          (ctx) => ctx.id === "context-implement",
        )?.placement,
    ).toEqual({
      lane: "implement",
      mode: "owned",
      ownedPaths: ["docs", "scripts/docs.ts"],
    });
  });

  it("preserves sibling active contexts when one parallel context starts and completes", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "completed",
      "task-plan-2": "pending",
    });
    execution.activeContextIds = ["context-plan", "context-implement"];
    execution.contextStates["context-implement"] = {
      ...execution.contextStates["context-implement"]!,
      status: "running",
    };
    const repository = createRepository(execution);
    const createConversation = vi.fn(async () => ({ id: "conversation-3" }));
    const createToolServer = vi.fn(() => ({ server: { id: "tool-server" } }));
    const runAgentIteration = vi.fn(async () => {
      expect(repository.read().activeContextIds).toEqual([
        "context-plan",
        "context-implement",
      ]);

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

      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
    expect(result.execution.activeContextIds).toEqual(["context-implement"]);
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
    const ownershipPrefix = [
      "# Spec ownership (authoritative)",
      "",
      "Frozen ownership bytes for this execution.",
      "",
    ].join("\n");
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
        await repository.mutateActive("/repo", "session-1", () => current);
      }
      // First two calls: agent returns without completing any task
      return {
        conversationId: "conv-mock",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      executionContract: {
        validateDefinition: () => ({ ok: true }),
        loadLiveEdit: () => ({
          validateOperation: () => ({ ok: true }),
          accountabilityCoverageGroups: [],
        }),
        validateTaskCompletion: () => ({ ok: true }),
        deriveContextAcceptanceCriteria: () => ({
          ok: true,
          acceptanceCriteriaByContextId: {},
        }),
        loadPromptProjection: async () => ({
          heading: "Spec ownership",
          body: "Frozen ownership bytes for this execution.",
        }),
      },
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
    expect(followUp1Prompt).toContain("cctl workflow task complete");
    expect(
      calls.map(([call]) => call.prompt.startsWith(ownershipPrefix)),
    ).toEqual([true, true, true]);
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
      compacted: false,
    }));

    const resolveImplementerCall = vi.fn(
      async (input: ResolveImplementerCallInput) => ({
        execution: input.execution,
        conversationId: "conv-rotate",
        sessionAction: "create" as const,
        promptMode: "iteration_seed" as const,
      }),
    );

    // After each turn, signal that rotation is needed. The continuity service
    // persists the rotation flag itself, so the fake writes through the
    // repository the orchestrator re-reads between turns.
    const recordLaneTurnOutcome = vi.fn(async () =>
      repository.mutateActive("/repo", "session-1", (latest) => ({
        ...latest,
        laneStates: {
          "context-plan": {
            implementer: {
              backend: "claude" as const,
              refKind: "conversation" as const,
              lane: "implementer" as const,
              contextId: "context-plan",
              workflowConversationId: "conv-rotate",
              sessionRef: { backend: "claude" as const, ref: "conv-rotate" },
              metrics: {
                contextTokens: 180_000,
                contextWindowMax: 200_000,
                rotateBeforeNextTurn: true,
              },
              limitEvaluation: "supported" as const,
              lastUsedAt: "2026-03-27T16:00:00.000Z",
            },
          },
        },
      })),
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: {
        resolveImplementerCall,
        recordLaneTurnOutcome,
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

  it("fingerprints the implementer assignment so an edited implementer rotates its lane", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
    });
    const repository = createRepository(execution);
    const resolveImplementerCall = vi.fn(
      async (input: ResolveImplementerCallInput) => ({
        execution: input.execution,
        conversationId: "conv-1",
        sessionAction: "reuse" as const,
        promptMode: "follow_up" as const,
      }),
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conv-unused" })),
      createToolServer: vi.fn(() => ({ server: { id: "tool-server" } })),
      runAgentIteration: vi.fn(async () => ({
        conversationId: "conv-1",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
        compacted: false,
      })),
      continuityService: {
        resolveImplementerCall,
        recordLaneTurnOutcome: vi.fn(
          async (input: RecordLaneTurnOutcomeInput) => input.execution,
        ),
      },
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    )!;
    expect(
      resolveImplementerCall.mock.calls[0]?.[0].assignmentFingerprint,
    ).toBe(
      assignmentFingerprint({
        profileSnapshot: context.implementer.profileSnapshot,
        agent: context.implementer.agent,
        continuity: context.iterationPolicy.continuity,
      }),
    );
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
      compacted: false,
    }));

    const resolveImplementerCall = vi.fn(
      async (input: ResolveImplementerCallInput) => ({
        execution: input.execution,
        conversationId: "conv-resumed",
        sessionAction: "reuse" as const,
        promptMode: "follow_up" as const,
      }),
    );

    const recordLaneTurnOutcome = vi.fn(
      async (input: RecordLaneTurnOutcomeInput) => input.execution,
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: {
        resolveImplementerCall,
        recordLaneTurnOutcome,
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
    expect(initialPrompt).toContain("cctl workflow task complete");
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
      compacted: false,
    }));

    const resolveImplementerCall = vi.fn(
      async (input: ResolveImplementerCallInput) => ({
        execution: input.execution,
        conversationId: "conv-resumed",
        sessionAction: "reuse" as const,
        promptMode: "follow_up" as const,
      }),
    );

    const recordLaneTurnOutcome = vi.fn(
      async (input: RecordLaneTurnOutcomeInput) => input.execution,
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: {
        resolveImplementerCall,
        recordLaneTurnOutcome,
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conv-mock",
        contextTokens: 50000,
        contextWindowMax: 200000,
        compacted: false,
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
    const recordLaneTurnOutcome = vi.fn(
      async (input: RecordLaneTurnOutcomeInput) => input.execution,
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: {
        resolveImplementerCall,
        recordLaneTurnOutcome,
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
    // The turn outcome is recorded once per agent run, as a neutral outcome.
    expect(recordLaneTurnOutcome).toHaveBeenCalledOnce();
    expect(recordLaneTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "implementer",
        outcome: expect.objectContaining({
          backend: "claude",
          contextTokens: 50000,
          contextWindowMax: 200000,
        }),
      }),
    );
  });

  it("pins the asking conversation and embeds the answers block on an implementer resume", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const createConversation = vi.fn(async () => ({ id: "fallback-conv" }));
    const createToolServer = vi.fn(() => ({ server: {} }));
    const capturedPrompts: string[] = [];
    const runAgentIteration = vi.fn(async (input: { prompt: string }) => {
      capturedPrompts.push(input.prompt);
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
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conv-ask",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    // The asking conversation is reused (pinned), so the follow-up prompt
    // carries the block.
    const resolveImplementerCall = vi.fn(
      async (input: ResolveImplementerCallInput) => ({
        execution: input.execution,
        conversationId: "conv-ask",
        sessionAction: "reuse" as const,
        promptMode: "follow_up" as const,
      }),
    );
    const recordLaneTurnOutcome = vi.fn(
      async (input: RecordLaneTurnOutcomeInput) => input.execution,
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: {
        resolveImplementerCall,
        recordLaneTurnOutcome,
      },
      now() {
        return "2026-03-27T16:00:00.000Z";
      },
    });

    const answers: Record<string, AskQuestionAnswer> = {
      q1: {
        selected: ["A"],
        note: "prefer A",
        skipped: false,
        question: "Which approach?",
      },
    };

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
      resumeUserInputs: [
        {
          laneKey: "implementer",
          lane: "implementer",
          conversationId: "conv-ask",
          questionBatchId: "batch-conv-ask",
          answers,
        },
      ],
    });

    // The pin threads the asking conversation into the resolver.
    expect(resolveImplementerCall).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedConversationId: "conv-ask" }),
    );
    // The follow-up prompt embeds the answers block verbatim.
    expect(capturedPrompts[0]).toContain(
      formatQuestionAnswersBlock("batch-conv-ask", answers),
    );
    expect(capturedPrompts[0]).toContain("## Your Question Was Answered");
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
      await repository.mutateActive("/repo", "session-1", () => next);
      return {
        conversationId: "conv-mock",
        contextTokens: 25_000,
        contextWindowMax: 200_000,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
    const validatorLaneState: GraphWorkflowAgentSessionState = {
      backend: "claude",
      refKind: "conversation",
      lane: "context_validator",
      contextId: "context-plan",
      workflowConversationId: "validator-conv",
      sessionRef: { backend: "claude", ref: "validator-conv" },
      metrics: {
        contextTokens: 10_000,
        contextWindowMax: 200_000,
        rotateBeforeNextTurn: false,
      },
      limitEvaluation: "disabled",
      lastUsedAt: "2026-03-27T16:01:00.000Z",
    };

    const validateContextCompletion = vi.fn(async () => {
      // Simulate validator-runner persisting updated lane states
      const current = structuredClone(repository.read());
      current.laneStates = {
        [validatorLaneState.contextId]: {
          context_validator: validatorLaneState,
        },
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        kind: "pass" as const,
        summary: "Context passed",
        feedback: "Context validation passed.",
        issues: [] as never[],
        reopenTaskIds: [],
        sessionRef: {
          backend: "claude" as const,
          ref: "validator-conv",
          lane: "context_validator" as const,
          refKind: "conversation" as const,
          workflowConversationId: "validator-conv",
        },
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
    expect(
      final.laneStates["context-plan"]?.["context_validator"],
    ).toBeDefined();
    expect(
      (
        final.laneStates["context-plan"]?.[
          "context_validator"
        ] as typeof validatorLaneState
      ).sessionRef,
    ).toEqual({ backend: "claude", ref: "validator-conv" });
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
      activeContextIds: ["context-plan"],
      laneStates: {
        "context-plan": {
          implementer: {
            backend: "claude",
            refKind: "conversation",
            lane: "implementer",
            contextId: "context-plan",
            workflowConversationId: "conv-existing",
            sessionRef: { backend: "claude", ref: "conv-existing" },
            metrics: {
              contextTokens: 50_000,
              contextWindowMax: 200_000,
              rotateBeforeNextTurn: false,
            },
            limitEvaluation: "disabled",
            lastUsedAt: NOW,
          },
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
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conv-mock",
        contextTokens: 60_000,
        contextWindowMax: 200_000,
        compacted: false,
      };
    });

    const continuityService = makeLaneContinuityService(repository, {
      createConversation,
      getConversation,
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conv-mock",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
        compacted: false,
      };
    });

    const continuityService = makeLaneContinuityService(repository, {
      createConversation,
      getConversation,
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
    const definition = createResolvedWorkflowDefinition();
    const ctxPlan = definition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    ctxPlan.iterationPolicy = {
      ...ctxPlan.iterationPolicy,
      continuity: { enabled: false },
    };

    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      workingDefinition: definition,
      laneStates: {
        "context-plan": {
          implementer: {
            backend: "claude",
            refKind: "conversation",
            lane: "implementer",
            contextId: "context-plan",
            workflowConversationId: "conv-old",
            sessionRef: { backend: "claude", ref: "conv-old" },
            metrics: { rotateBeforeNextTurn: false },
            limitEvaluation: "disabled",
            lastUsedAt: NOW,
          },
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
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conv-mock",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
        compacted: false,
      };
    });

    const continuityService = makeLaneContinuityService(repository, {
      createConversation,
      getConversation,
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
            compacted: false,
          }
        : {
            conversationId: "conv-mock",
            contextTokens: 50_000,
            contextWindowMax: 200_000,
            compacted: false,
          };
    });

    const continuityService = makeLaneContinuityService(repository, {
      createConversation,
      getConversation,
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
    const laneState =
      repository.read().laneStates["context-plan"]?.["implementer"];
    expect(laneState?.metrics.rotateBeforeNextTurn).toBe(false);
  });

  it("injects the retiring conversation's handoff note into the rotation seed prompt", async () => {
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

    const prompts: string[] = [];
    let callCount = 0;
    const runAgentIteration = vi.fn(async (input: { prompt: string }) => {
      prompts.push(input.prompt);
      callCount++;
      return {
        conversationId: "conv-mock",
        contextTokens: callCount === 1 ? 120_000 : 50_000,
        contextWindowMax: 200_000,
        compacted: false,
      };
    });

    const continuityService = makeLaneContinuityService(repository, {
      createConversation,
      getConversation,
      loadRotationHandoff: vi
        .fn()
        .mockResolvedValue(
          "Finished task-plan-1. Lesson: the fixture DB needs WAL mode.",
        ),
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(),
      createToolServer: vi.fn(() => ({ server: {} })),
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
    await orchestrator.runIteration(input);
    await orchestrator.runIteration(input);

    // First seed has no predecessor; the rotation seed carries the handoff.
    expect(prompts[0]).not.toContain(
      "## Handoff from the previous conversation",
    );
    expect(prompts[1]).toContain("## Handoff from the previous conversation");
    expect(prompts[1]).toContain(
      "Finished task-plan-1. Lesson: the fixture DB needs WAL mode.",
    );
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
      compacted: false,
    }));

    const continuityService = makeLaneContinuityService(repository, {
      createConversation,
      getConversation,
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
    await repository.mutateActive("/repo", "session-1", () => deserialized);

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
      ref: "validator-conv",
      lane: "context_validator" as const,
      refKind: "conversation" as const,
      workflowConversationId: "validator-conv",
    };

    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "All checks passed",
      feedback: "Context validation passed.",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef,
      reviewArtifact: {
        backend: "claude" as const,
        kind: "conversation" as const,
        ref: "validator-conv",
        usage: null,
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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

    const validationHistoryEntry = repository.appendedEvents.find(
      (entry) => entry.event.type === "graph-workflow-validation-result",
    );
    expect(validationHistoryEntry).toBeDefined();
    // Validation history preserves the backend-neutral session envelope.
    expect(validationHistoryEntry?.event).toMatchObject({
      type: "graph-workflow-validation-result",
      validatorType: "context",
      kind: "context_validation",
      rejectedOutput: null,
      gateRepairAttempts: null,
      gateRepairBudget: null,
      pass: true,
      sessionRef: {
        backend: "claude",
        ref: "validator-conv",
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
          assignmentId: "general",
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    seedFailedContextValidationEvent(repository, repository.read().id);
    const prompts: string[] = [];

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-retry" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: vi.fn(async (agentInput) => {
        prompts.push(agentInput.prompt);
        return {
          conversationId: "conversation-retry",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
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

  // R12.2: the latest-verdict feedback reads the AGGREGATE. A cohort round adds
  // specialist entries and drops the single-reviewer refs, and the remediation
  // an implementer receives must be identical to what one reviewer produced.
  it("builds the same remediation feedback from a multi-assignment round's aggregate", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const specialist = (
      assignmentId: string,
      id: string,
      pass: boolean,
    ): GraphWorkflowValidationSpecialistEntry => ({
      assignmentId,
      profile: { tier: "builtin", id, revision: 1 },
      resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
      advisories: [],
      pass,
      summary: `${assignmentId} reported`,
      issues: [],
      sessionRef: null,
      reviewArtifact: null,
      usage: null,
    });
    seedFailedContextValidationEvent(repository, repository.read().id, {
      roundSeq: 3,
      specialists: [
        specialist("general", "general-reviewer", true),
        specialist("security", "security-reviewer", false),
      ],
    });
    const prompts: string[] = [];

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-retry" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: vi.fn(async (agentInput) => {
        prompts.push(agentInput.prompt);
        return {
          conversationId: "conversation-retry",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      }),
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(prompts[0]).toContain("Latest Context Validation Failure");
    expect(prompts[0]).toContain(
      "Validation failed because rollback notes are missing.",
    );
    expect(prompts[0]).toContain("`task-plan-2` - Write plan");
    expect(prompts[0]).toContain("Missing rollback notes");
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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

  it("omits every collaboration reference when the resolved context has no enabled collaboration config", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const repository = createRepository(execution);
    const prompts: string[] = [];

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-no-collab" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: vi.fn(async (agentInput) => {
        prompts.push(agentInput.prompt);
        return {
          conversationId: "conversation-no-collab",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      }),
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(prompts).not.toHaveLength(0);
    expect(prompts[0]?.toLowerCase()).not.toContain("collaboration");
  });

  it("omits acceptance criteria when contextValidator.enabled is false (same path as null)", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const planContext = execution.workingDefinition.executionContexts.find(
      (ctx) => ctx.id === "context-plan",
    )!;
    planContext.acceptanceCriteria =
      "Never-include-me-sentinel: plan review complete.";
    planContext.contextValidator = {
      enabled: false,
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
              modelId: "opus",
              parameters: { effort: "medium" },
            },
          },
          continuity: { enabled: true },
        },
      ],
    };

    const repository = createRepository(execution);
    const prompts: string[] = [];

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-disabled" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: vi.fn(async (agentInput) => {
        prompts.push(agentInput.prompt);
        return {
          conversationId: "conversation-disabled",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      }),
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).not.toContain("Never-include-me-sentinel");
    expect(prompts[0]).not.toContain("Acceptance Criteria");
  });

  it("includes acceptance criteria in iteration prompt when contextValidator.enabled is true", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const planContext = execution.workingDefinition.executionContexts.find(
      (ctx) => ctx.id === "context-plan",
    )!;
    planContext.acceptanceCriteria =
      "Include-me-sentinel: plan review complete.";
    planContext.contextValidator = {
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
              modelId: "opus",
              parameters: { effort: "medium" },
            },
          },
          continuity: { enabled: true },
        },
      ],
    };

    const repository = createRepository(execution);
    const prompts: string[] = [];

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-enabled" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: vi.fn(async (agentInput) => {
        prompts.push(agentInput.prompt);
        return {
          conversationId: "conversation-enabled",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      }),
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain("Acceptance Criteria");
    expect(prompts[0]).toContain("Include-me-sentinel");
  });
});

// -- Codex implementer continuity ---------------------------------------------

describe("codex implementer continuity", () => {
  function createCodexExecutionWithPlanTasks(): GraphWorkflowExecution {
    const definition = createResolvedWorkflowDefinition({
      executionContexts: [
        {
          placement: { lane: "context-plan", mode: "full" as const },
          id: "context-plan",
          title: "Plan",
          acceptanceCriteria: "TBD",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            profileSnapshot: makeProfileSnapshot(),
            agent: {
              backend: "codex",
              modelSelection: {
                modelId: "gpt-5.4-mini",
                parameters: { reasoning: "medium", fast: "false" },
              },
            },
          },
          contextValidator: { enabled: false, assignments: [] },
          scriptValidator: { commands: [] },
          humanApprovalGate: { enabled: false },
          askUserQuestions: { enabled: false },
          mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 5,
            continuity: { enabled: true },
          },
          planRepair: { enabled: true, maxAttemptsPerContext: 2 },
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
      activeContextIds: ["context-plan"],
      workingDefinition: definition,
      contextStates: {
        "context-plan": {
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-plan",
          status: "running",
          totalTaskCount: 2,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          consecutiveCandidateMismatchCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          laneId: null,
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
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
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
        sessionRef: { backend: "codex" as const, ref: "thread-real-123" },
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
    const recordLaneTurnOutcome = vi.fn(
      async (input: RecordLaneTurnOutcomeInput) => input.execution,
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: {
        resolveImplementerCall,
        recordLaneTurnOutcome,
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
      expect.objectContaining({ backend: "codex" }),
    );
    // The neutral outcome carries the lane backend and the advanced thread ref
    expect(recordLaneTurnOutcome).toHaveBeenCalledOnce();
    expect(recordLaneTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          backend: "codex",
          ref: "thread-real-123",
        }),
      }),
    );
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
      compacted: false,
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
    const recordLaneTurnOutcome = vi.fn(async () =>
      repository.mutateActive("/repo", "session-1", (latest) => ({
        ...latest,
        laneStates: {
          "context-plan": {
            implementer: {
              backend: "codex" as const,
              refKind: "backend" as const,
              lane: "implementer" as const,
              contextId: "context-plan",
              sessionRef: { backend: "codex" as const, ref: "thread-1" },
              // Defense-in-depth: Codex schema defines this as literal false, but
              // the rotation guard should still stop follow-ups if the value is true
              metrics: {
                lastTurnUsage: null,
                rotateBeforeNextTurn: true,
              },
              limitEvaluation: "disabled" as const,
              lastUsedAt: "2026-03-27T16:00:00.000Z",
            },
          },
        },
      })),
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      continuityService: {
        resolveImplementerCall,
        recordLaneTurnOutcome,
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
    const adapterStart = vi.fn(async () => ({
      backend: "codex" as const,
      ref: `thread-${++convCounter}`,
    }));
    const adapterResume = vi.fn(
      async (ref: { backend: "codex"; ref: string }) => ({
        ref,
        recovered: false,
      }),
    );
    const createToolServer = vi.fn(() => ({ server: {} }));
    const runAgentIteration = vi.fn(async () => ({
      conversationId: "conv-mock",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
      sessionRef: { backend: "codex" as const, ref: "thread-real-1" },
    }));

    const continuityService = makeLaneContinuityService(repository, {
      createConversation,
      getConversation,
      continuityAdapter: () => ({
        backend: "codex",
        start: adapterStart,
        resumeOrRecover: adapterResume,
        validate: vi.fn(async () => ({ status: "valid" as const })),
        fork: vi.fn(),
      }),
      now: () => NOW,
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
    await repository.mutateActive("/repo", "session-1", () => deserialized);

    // Second iteration after restart: should reuse
    const result2 = await orchestrator.runIteration(input);

    expect(result1.conversationId).toBe(result2.conversationId);
    // Only one CC conversation created — the second call reused
    expect(createConversation).toHaveBeenCalledOnce();
    expect(adapterStart).not.toHaveBeenCalled();
    expect(adapterResume).not.toHaveBeenCalled();
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
      kind: "infra_exhausted" as const,
      assignmentId: "general",
      attempts: 3,
      reason: "exception" as const,
      message: "Codex rate limit exceeded",
      engine: "codex" as const,
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
        await repository.mutateActive("/repo", "session-1", () => current);
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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

  it("increments consecutiveFailureCount when an iteration is terminated by a pending-halt terminal error while still running", async () => {
    const repository = seedRepoWithConsecutiveFailures(0);

    const createToolServer = vi.fn(() => ({
      server: {},
      close: vi.fn(async () => undefined),
    }));
    const createConversation = vi.fn(async () => ({ id: "conv-drain" }));

    // Faithful drain-window halt: a sibling already recorded the halt, so
    // signalHalt is a no-op here and the execution stays "running" until the
    // outer loop drains.
    const signalHalt = vi.fn(async () => repository.read());

    const runAgentIteration = vi.fn(async () => {
      // Simulate a sibling recording a halt during this context's turn: set
      // pendingHaltReason without flipping status or completing any task.
      await repository.mutateActive("/repo", "session-1", (current) => {
        current.pendingHaltReason = {
          type: "collaboration_failure",
          status: "objective_disagreement",
          brief: "sibling blocked",
          executionContextId: "ctx-other",
          conversationId: "conv-other",
          summary: "sibling blocked",
        };
        return current;
      });
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // The swallowed IterationHaltedError must count toward the circuit breaker
    // so a terminal-error loop is bounded by the consecutive-failure threshold,
    // not only by maxIterations.
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);
    // Tasks remain and the execution is still running, so the iteration would
    // otherwise loop — the breaker is the backstop.
    expect(result.shouldContinueInContext).toBe(true);
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
          assignmentId: "general",
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
        await repository.mutateActive("/repo", "session-1", () => current);
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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

  it("routes circuit-breaker decisions through the runCircuitBreakerGate primitive (Task 6.2 — primitive layer integration)", async () => {
    const { runCircuitBreakerGate: defaultGate } =
      await import("@/lib/workflows/primitives/circuit-breaker-gate");
    // Seed with count = 2; default threshold is 3 — third failing completion
    // should ask the primitive whether to trip and receive a `fail` result.
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
    const createConversation = vi.fn(async () => ({ id: "conv-gate" }));

    const validateContextCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Still failing",
      feedback:
        "Context validation blocked completion.\nReopened tasks:\n- task-plan-2\n- Missing: add coverage",
      issues: [
        {
          assignmentId: "general",
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
        await repository.mutateActive("/repo", "session-1", () => current);
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
        compacted: false,
      };
    });

    const runCircuitBreakerGate = vi.fn(defaultGate);

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      runCircuitBreakerGate,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Gate primitive consulted with the post-failure count and the context's threshold
    expect(runCircuitBreakerGate).toHaveBeenCalledWith({
      failureCount: 3,
      threshold: 3,
    });
    const gateResult = runCircuitBreakerGate.mock.results.at(-1)!.value;
    expect(gateResult.status).toBe("fail");
    expect(gateResult.kind).toBe("circuit_breaker");

    // Halt actually fires using the gate's verdict
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
    expect(result.execution.status).toBe("halted");
    expect(result.execution.haltReason?.type).toBe("circuit_breaker");
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
      await repository.mutateActive("/repo", "session-1", () => current);
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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

  it("halts the iteration and skips follow-up turns when a tool handler writes pendingHaltReason mid-turn (collaboration_failure)", async () => {
    // Same-Turn Tool Dispatch Contract (R5.3): a non-converged
    // `request_collaboration` writes `pendingHaltReason` from inside the tool
    // handler. The orchestrator's follow-up loop must read the field before
    // sending the next agent turn and halt instead of dispatching.
    const repository = seedRepoWithConsecutiveFailures(0);
    const createToolServer = vi.fn(() => ({
      server: {},
      close: vi.fn(async () => undefined),
    }));
    const createConversation = vi.fn(async () => ({ id: "conv-pending-halt" }));

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
        await repository.mutateActive("/repo", "session-1", () => current);
        return current;
      },
    );

    const runAgentIteration = vi.fn(async () => {
      // Simulate the `request_collaboration` handler writing pendingHaltReason
      // before returning its tool_result on this turn.
      await repository.mutateActive("/repo", "session-1", (current) => {
        current.pendingHaltReason = {
          type: "collaboration_failure",
          status: "rounds_exhausted",
          brief: "Should we use approach A or B?",
          executionContextId: "context-plan",
          conversationId: "conv-pending-halt",
          summary: "Negotiation rounds exhausted without convergence",
        };
        return current;
      });
      return {
        conversationId: "conv-mock",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // The initial agent turn ran; the follow-up loop detected
    // pendingHaltReason and halted before dispatching turn 2.
    expect(runAgentIteration).toHaveBeenCalledTimes(1);
    expect(signalHalt).toHaveBeenCalledTimes(1);
    expect(signalHalt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.objectContaining({ type: "collaboration_failure" }),
      }),
    );
    expect(result.execution.status).toBe("halted");
    expect(result.execution.haltReason?.type).toBe("collaboration_failure");
    expect(result.shouldContinueInContext).toBe(false);
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
        await repository.mutateActive("/repo", "session-1", () => current);
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
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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
    expect(result.execution.activeContextIds).toEqual(["context-plan"]);
  });
});

// -- Resume after validator_infra_error: all tasks already completed ----------

describe("runIteration when all tasks are already completed on entry", () => {
  const NOW = "2026-04-17T18:00:00.000Z";

  function seedRepoWithAllTasksCompleted(): ReturnType<
    typeof createRepository
  > {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "completed",
      "task-plan-2": "completed",
    });
    const completedAt = "2026-04-17T17:00:00.000Z";
    const prevConversationId = "conv-prev-iteration";
    for (const taskId of ["task-plan-1", "task-plan-2"] as const) {
      const taskState = execution.taskStates[taskId]!;
      taskState.summary = "Done in prior iteration";
      taskState.completedAt = completedAt;
      taskState.startedAt = "2026-04-17T16:55:00.000Z";
      taskState.lastConversationId = prevConversationId;
    }
    const contextState = execution.contextStates["context-plan"]!;
    contextState.completedTaskCount = 2;
    contextState.iterationCount = 1;
    return createRepository(execution);
  }

  it("re-runs context validation without creating a new implementer conversation or tool server when validator passes", async () => {
    const repository = seedRepoWithAllTasksCompleted();

    const createConversation = vi.fn();
    const createToolServer = vi.fn();
    const runAgentIteration = vi.fn();

    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "Context passed on re-validation",
      feedback: "Context validation passed.",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: { validateContextCompletion },
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
    expect(createConversation).not.toHaveBeenCalled();
    expect(createToolServer).not.toHaveBeenCalled();
    expect(runAgentIteration).not.toHaveBeenCalled();

    expect(result.shouldContinueInContext).toBe(false);
    expect(result.execution.status).toBe("running");
    expect(result.execution.activeContextIds).toEqual([]);
    expect(result.execution.contextStates["context-plan"]).toMatchObject({
      status: "completed",
      completedTaskCount: 2,
      consecutiveFailureCount: 0,
      consecutiveCandidateMismatchCount: 0,
    });

    const validationEvent = repository.appendedEvents.find(
      (entry) => entry.event.type === "graph-workflow-validation-result",
    );
    expect(validationEvent?.event).toMatchObject({
      validatorType: "context",
      kind: "context_validation",
      rejectedOutput: null,
      gateRepairAttempts: null,
      gateRepairBudget: null,
      pass: true,
      summary: "Context passed on re-validation",
    });
  });

  it("forwards a validator resume into context validation (pin + answer block)", async () => {
    const repository = seedRepoWithAllTasksCompleted();

    let receivedResume: readonly ResumeUserInputContext[] | undefined;
    const validateContextCompletion = vi.fn(
      async (input: GraphWorkflowContextValidationInput) => {
        receivedResume = input.resumeUserInputs;
        return {
          kind: "pass" as const,
          summary: "Context passed after answer",
          feedback: "Context validation passed.",
          issues: [] as never[],
          reopenTaskIds: [],
          sessionRef: null,
          reviewArtifact: null,
        };
      },
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(),
      createToolServer: vi.fn(),
      runAgentIteration: vi.fn(),
      validationService: { validateContextCompletion },
      now: () => NOW,
    });

    const answers: Record<string, AskQuestionAnswer> = {
      q1: {
        selected: ["Reopen"],
        note: null,
        skipped: false,
        question: "Reopen the task?",
      },
    };

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
      resumeUserInputs: [
        {
          laneKey: "context_validator:general",
          lane: "context_validator",
          conversationId: "validator-conv-ask",
          questionBatchId: "batch-validator",
          answers,
        },
      ],
    });

    // The validator resume is forwarded so the runner pins the asking
    // validator conversation and embeds the answers block in its prompt.
    expect(receivedResume).toEqual([
      {
        laneKey: "context_validator:general",
        lane: "context_validator",
        conversationId: "validator-conv-ask",
        questionBatchId: "batch-validator",
        answers,
      },
    ]);
  });

  it("does not forward an implementer resume into context validation", async () => {
    const repository = seedRepoWithAllTasksCompleted();

    let receivedResume: unknown = "unset";
    const validateContextCompletion = vi.fn(
      async (input: GraphWorkflowContextValidationInput) => {
        receivedResume = input.resumeUserInputs;
        return {
          kind: "pass" as const,
          summary: "Context passed",
          feedback: "Context validation passed.",
          issues: [] as never[],
          reopenTaskIds: [],
          sessionRef: null,
          reviewArtifact: null,
        };
      },
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(),
      createToolServer: vi.fn(),
      runAgentIteration: vi.fn(),
      validationService: { validateContextCompletion },
      now: () => NOW,
    });

    // An implementer resume that happens to reach the inline completion check
    // must not leak its answers into the validator prompt.
    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
      resumeUserInputs: [
        {
          laneKey: "implementer",
          lane: "implementer",
          conversationId: "impl-conv-ask",
          questionBatchId: "batch-impl",
          answers: {},
        },
      ],
    });

    // An implementer entry is filtered out, so the validator sees an empty set
    // rather than another lane's answers.
    expect(receivedResume).toEqual([]);
  });

  it("signals halt with validator_infra_error without running implementer when validator returns infra_error on re-validation", async () => {
    const repository = seedRepoWithAllTasksCompleted();

    const createConversation = vi.fn();
    const createToolServer = vi.fn();
    const runAgentIteration = vi.fn();

    const validateContextCompletion = vi.fn(async () => ({
      kind: "infra_exhausted" as const,
      assignmentId: "general",
      attempts: 3,
      reason: "unparseable" as const,
      message: "Validator agent did not return a JSON block",
      engine: "codex" as const,
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
        await repository.mutateActive("/repo", "session-1", () => current);
        return current;
      },
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
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

    expect(runAgentIteration).not.toHaveBeenCalled();
    expect(createConversation).not.toHaveBeenCalled();
    expect(createToolServer).not.toHaveBeenCalled();
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);

    expect(signalHalt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.objectContaining({
          type: "validator_infra_error",
          contextId: "context-plan",
          engine: "codex",
          infraReason: "unparseable",
        }),
      }),
    );

    expect(result.execution.status).toBe("halted");
    expect(result.execution.haltReason?.type).toBe("validator_infra_error");
    expect(result.shouldContinueInContext).toBe(false);
  });

  it("reopens tasks and returns shouldContinueInContext=true when validator fails on re-validation", async () => {
    const repository = seedRepoWithAllTasksCompleted();

    const createConversation = vi.fn();
    const createToolServer = vi.fn();
    const runAgentIteration = vi.fn();

    const validateContextCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Rollback notes missing",
      feedback:
        "Context validation blocked completion.\nReopened tasks:\n- task-plan-2",
      issues: [
        {
          assignmentId: "general",
          taskId: "task-plan-2",
          title: "Missing rollback notes",
          description: "Add rollback guidance.",
        },
      ],
      reopenTaskIds: ["task-plan-2"],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: { validateContextCompletion },
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(runAgentIteration).not.toHaveBeenCalled();
    expect(result.execution.taskStates["task-plan-2"]).toMatchObject({
      status: "pending",
      summary: null,
    });
    expect(result.execution.taskStates["task-plan-1"]?.status).toBe(
      "completed",
    );
    expect(result.shouldContinueInContext).toBe(true);
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);
  });
});

// -- Script validator integration --------------------------------------------

describe("script validator integration", () => {
  const NOW = "2026-04-18T17:00:00.000Z";

  function enableScriptValidator(
    execution: GraphWorkflowExecution,
    contextId: string,
  ): GraphWorkflowExecution {
    const ctx = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === contextId,
    );
    if (!ctx) throw new Error(`context "${contextId}" not in fixture`);
    ctx.scriptValidator = { commands: ["pre-merge"] };
    return execution;
  }

  function seedRepoWithScriptValidator(
    opts: {
      task1?: GraphWorkflowExecution["taskStates"][string]["status"];
      task2?: GraphWorkflowExecution["taskStates"][string]["status"];
      consecutiveFailureCount?: number;
    } = {},
  ) {
    const exec = createExecutionWithPlanTasks({
      "task-plan-1": opts.task1 ?? "pending",
      "task-plan-2": opts.task2 ?? "pending",
    });
    enableScriptValidator(exec, "context-plan");
    if (opts.consecutiveFailureCount !== undefined) {
      const ctxState = exec.contextStates["context-plan"];
      if (ctxState) {
        ctxState.consecutiveFailureCount = opts.consecutiveFailureCount;
      }
    }
    return createRepository(exec);
  }

  function createCapturingToolServer(): {
    createToolServer: ReturnType<typeof vi.fn>;
    capturedCompleteTask():
      | ((taskId: string, summary: string) => Promise<GraphWorkflowExecution>)
      | undefined;
  } {
    let captured:
      | ((taskId: string, summary: string) => Promise<GraphWorkflowExecution>)
      | undefined;
    const createToolServer = vi.fn(
      (input: {
        completeTask: (
          taskId: string,
          summary: string,
        ) => Promise<GraphWorkflowExecution>;
      }) => {
        captured = input.completeTask;
        return { server: {}, close: vi.fn(async () => undefined) };
      },
    );
    return {
      createToolServer,
      capturedCompleteTask: () => captured,
    };
  }

  it("runs the script validator before the agent validator when enabled", async () => {
    const repository = seedRepoWithScriptValidator();
    const { createToolServer, capturedCompleteTask } =
      createCapturingToolServer();
    const createConversation = vi.fn(async () => ({ id: "conv-s1" }));

    const callOrder: string[] = [];
    const runScriptValidator = vi.fn(async () => {
      callOrder.push("script");
      return { kind: "pass" as const };
    });
    const validateContextCompletion = vi.fn(async () => {
      callOrder.push("agent");
      return {
        kind: "pass" as const,
        summary: "All good",
        feedback: "pass",
        issues: [] as never[],
        reopenTaskIds: [],
        sessionRef: null,
        reviewArtifact: null,
      };
    });

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask()!("task-plan-1", "Done");
      await capturedCompleteTask()!("task-plan-2", "Done");
      return {
        conversationId: "conv-s1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: { validateContextCompletion },
      scriptValidatorService: { runScriptValidator },
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(callOrder).toEqual(["script", "agent"]);
    expect(runScriptValidator).toHaveBeenCalledTimes(1);
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
  });

  it("skips the script validator when the context has it disabled", async () => {
    // Default fixture leaves scriptValidator disabled
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const repository = createRepository(execution);
    const { createToolServer, capturedCompleteTask } =
      createCapturingToolServer();
    const createConversation = vi.fn(async () => ({ id: "conv-s2" }));

    const runScriptValidator = vi.fn();
    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "All good",
      feedback: "pass",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask()!("task-plan-1", "Done");
      await capturedCompleteTask()!("task-plan-2", "Done");
      return {
        conversationId: "conv-s2",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: { validateContextCompletion },
      scriptValidatorService: { runScriptValidator },
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(runScriptValidator).not.toHaveBeenCalled();
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
  });

  it("defers configured script validation for an enveloped context", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    );
    if (!context) throw new Error('context "context-plan" not in fixture');
    context.placement = {
      lane: "implementation",
      mode: "owned",
      ownedPaths: ["src"],
    };
    context.scriptValidator = { commands: ["typecheck"] };
    const repository = createRepository(execution);
    const { createToolServer, capturedCompleteTask } =
      createCapturingToolServer();
    const runScriptValidator = vi.fn(async () => ({ kind: "pass" as const }));
    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "All good",
      feedback: "pass",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));
    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask()!("task-plan-1", "Done");
      await capturedCompleteTask()!("task-plan-2", "Done");
      return {
        conversationId: "conv-enveloped",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });
    const orchestrator = createGraphWorkflowIterationOrchestrator({
      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conv-enveloped" })),
      createToolServer,
      runAgentIteration,
      validationService: { validateContextCompletion },
      scriptValidatorService: { runScriptValidator },
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(runScriptValidator).not.toHaveBeenCalled();
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
  });

  it("runs configured script-validator commands even when the legacy enabled flag is false", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    );
    if (!context) throw new Error('context "context-plan" not in fixture');
    context.scriptValidator = { commands: ["typecheck"] };
    const repository = createRepository(execution);
    const { createToolServer, capturedCompleteTask } =
      createCapturingToolServer();
    const runScriptValidator = vi.fn(async () => ({ kind: "pass" as const }));
    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "All good",
      feedback: "pass",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));
    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask()!("task-plan-1", "Done");
      await capturedCompleteTask()!("task-plan-2", "Done");
      return {
        conversationId: "conv-commands",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });
    const orchestrator = createGraphWorkflowIterationOrchestrator({
      // A selected script gate opens a validation round, so the candidate tree
      // has to be resolvable for the gate to be reached at all.
      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conv-commands" })),
      createToolServer,
      runAgentIteration,
      validationService: { validateContextCompletion },
      scriptValidatorService: { runScriptValidator },
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(runScriptValidator).toHaveBeenCalledTimes(1);
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
  });

  it("skips the agent validator when the script validator fails, adds a remediation task, and increments failure count", async () => {
    const repository = seedRepoWithScriptValidator();
    const { createToolServer, capturedCompleteTask } =
      createCapturingToolServer();
    const createConversation = vi.fn(async () => ({ id: "conv-s3" }));

    const runScriptValidator = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Pre-merge validation failed",
      logFilePath:
        "/repo/.worktrees/session-1/.cc/workflow/execution-1/pre-merge-20260418T170000Z.log",
      logRelativePath:
        ".cc/workflow/execution-1/pre-merge-20260418T170000Z.log",
      timedOut: false,
    }));
    const validateContextCompletion = vi.fn();

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask()!("task-plan-1", "Done");
      await capturedCompleteTask()!("task-plan-2", "Done");
      return {
        conversationId: "conv-s3",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    let remediationTaskId = 0;
    const createTaskId = vi.fn(() => {
      remediationTaskId += 1;
      return `task-remediation-${remediationTaskId}`;
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      validationService: { validateContextCompletion },
      scriptValidatorService: { runScriptValidator },
      createTaskId,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(runScriptValidator).toHaveBeenCalledTimes(1);
    expect(validateContextCompletion).not.toHaveBeenCalled();

    // Remediation task exists in the context
    const planTasks = result.execution.workingDefinition.tasks.filter(
      (t) => t.contextId === "context-plan",
    );
    const remediationTask = planTasks.find(
      (t) => t.id === "task-remediation-1",
    );
    expect(remediationTask).toBeDefined();
    expect(remediationTask?.title.toLowerCase()).toContain("pre-merge");
    expect(remediationTask?.instructions).toContain(
      ".cc/workflow/execution-1/pre-merge-20260418T170000Z.log",
    );

    // Task state for remediation is pending
    const remediationTaskState =
      result.execution.taskStates["task-remediation-1"];
    expect(remediationTaskState?.status).toBe("pending");

    // Failure count incremented
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);

    // Execution remains running, iteration should continue in context
    expect(result.execution.status).toBe("running");
    expect(result.shouldContinueInContext).toBe(true);
  });

  it("halts with script_validator_unknown_command for an unregistered configured command", async () => {
    const repository = seedRepoWithScriptValidator();
    const { createToolServer, capturedCompleteTask } =
      createCapturingToolServer();
    const runScriptValidator = vi.fn(async () => ({
      kind: "infra_error" as const,
      reason: "unknown_command" as const,
      commandName: "missing",
      message:
        'Script validator command "missing" is not registered; registered commands: test',
    }));
    const validateContextCompletion = vi.fn();
    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask()!("task-plan-1", "Done");
      await capturedCompleteTask()!("task-plan-2", "Done");
      return {
        conversationId: "conv-unknown-command",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });
    const signalHalt = vi.fn(
      async (input: {
        projectPath: string;
        sessionName: string;
        reason: GraphWorkflowExecution["haltReason"];
      }) => {
        const current = structuredClone(repository.read());
        current.status = "halted";
        current.haltReason = input.reason;
        await repository.mutateActive("/repo", "session-1", () => current);
        return current;
      },
    );
    const orchestrator = createGraphWorkflowIterationOrchestrator({
      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conv-unknown-command" })),
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      scriptValidatorService: { runScriptValidator },
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(signalHalt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: {
          type: "script_validator_unknown_command",
          contextId: "context-plan",
          commandName: "missing",
          message:
            'Script validator command "missing" is not registered; registered commands: test',
        },
      }),
    );
    expect(validateContextCompletion).not.toHaveBeenCalled();
    expect(result.execution.haltReason?.type).toBe(
      "script_validator_unknown_command",
    );
    expect(result.shouldContinueInContext).toBe(false);
  });

  it("treats a script-gate capacity wait as orchestration state", async () => {
    const repository = seedRepoWithScriptValidator({
      consecutiveFailureCount: 2,
    });
    const { createToolServer, capturedCompleteTask } =
      createCapturingToolServer();
    let releaseCapacity: (() => void) | undefined;
    const runScriptValidator = vi.fn(
      () =>
        new Promise<{ kind: "pass" }>((resolve) => {
          releaseCapacity = () => resolve({ kind: "pass" });
        }),
    );
    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "All good",
      feedback: "pass",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));
    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask()!("task-plan-1", "Done");
      await capturedCompleteTask()!("task-plan-2", "Done");
      return {
        conversationId: "conv-capacity-wait",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });
    const signalHalt = vi.fn();
    const orchestrator = createGraphWorkflowIterationOrchestrator({
      // A selected script gate opens a validation round, so the candidate tree
      // has to be resolvable for the gate to be reached at all.
      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conv-capacity-wait" })),
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      scriptValidatorService: { runScriptValidator },
      now: () => NOW,
    });

    let settled = false;
    const resultPromise = orchestrator
      .runIteration({
        projectPath: "/repo",
        projectName: "repo",
        sessionName: "session-1",
        contextId: "context-plan",
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() => expect(runScriptValidator).toHaveBeenCalledTimes(1));

    const waiting = repository.read();
    expect(settled).toBe(false);
    expect(waiting.contextStates["context-plan"]?.consecutiveFailureCount).toBe(
      2,
    );
    expect(
      waiting.workingDefinition.tasks.filter((task) =>
        task.id.startsWith("script-remediation-"),
      ),
    ).toEqual([]);
    expect(signalHalt).not.toHaveBeenCalled();
    expect(validateContextCompletion).not.toHaveBeenCalled();
    const iterationCountWhileWaiting =
      waiting.contextStates["context-plan"]?.iterationCount;

    releaseCapacity?.();
    const result = await resultPromise;
    expect(result.execution.status).toBe("running");
    expect(result.execution.contextStates["context-plan"]?.iterationCount).toBe(
      iterationCountWhileWaiting,
    );
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
  });

  it("halts with recovery_error when the script validator throws an unexpected exception", async () => {
    const repository = seedRepoWithScriptValidator();
    const { createToolServer, capturedCompleteTask } =
      createCapturingToolServer();
    const createConversation = vi.fn(async () => ({ id: "conv-s5" }));

    const runScriptValidator = vi.fn(async () => ({
      kind: "infra_error" as const,
      reason: "exception" as const,
      message: "spawn enoent",
    }));
    const validateContextCompletion = vi.fn();

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask()!("task-plan-1", "Done");
      await capturedCompleteTask()!("task-plan-2", "Done");
      return {
        conversationId: "conv-s5",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const workflowManager = createGraphWorkflowManager({
      executionRepository: {
        ...repository,
        async create() {
          throw new Error("not used by this test");
        },
        async archiveActive() {
          return { archived: false as const, reason: "no_active" as const };
        },
        async markContextEventsPreReset() {
          return 0;
        },
      },
      async loadDefinition() {
        return null;
      },
    });
    const signalHalt = vi.fn(
      createGraphWorkflowSignalHaltHandler(workflowManager),
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      scriptValidatorService: { runScriptValidator },
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(signalHalt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.objectContaining({
          type: "recovery_error",
        }),
      }),
    );
    expect(validateContextCompletion).not.toHaveBeenCalled();
    expect(result.execution.status).toBe("running");
    expect(result.execution.pendingHaltReason?.type).toBe("recovery_error");
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(0);
    expect(result.shouldContinueInContext).toBe(false);
  });

  it("trips the circuit breaker when script validator fails repeatedly beyond the threshold", async () => {
    // Seed with count = 2; threshold is default 3. A third fail should trip.
    const repository = seedRepoWithScriptValidator({
      consecutiveFailureCount: 2,
    });
    const { createToolServer, capturedCompleteTask } =
      createCapturingToolServer();
    const createConversation = vi.fn(async () => ({ id: "conv-s6" }));

    const runScriptValidator = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Pre-merge validation failed again",
      logFilePath:
        "/repo/.worktrees/session-1/.cc/workflow/execution-1/pre-merge-20260418T170100Z.log",
      logRelativePath:
        ".cc/workflow/execution-1/pre-merge-20260418T170100Z.log",
      timedOut: false,
    }));
    const validateContextCompletion = vi.fn();

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask()!("task-plan-1", "Done");
      await capturedCompleteTask()!("task-plan-2", "Done");
      return {
        conversationId: "conv-s6",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

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
        await repository.mutateActive("/repo", "session-1", () => current);
        return current;
      },
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      scriptValidatorService: { runScriptValidator },
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

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
    expect(validateContextCompletion).not.toHaveBeenCalled();
    expect(result.execution.status).toBe("halted");
    expect(result.execution.haltReason?.type).toBe("circuit_breaker");
  });

  it("routes script-validator circuit-breaker decisions through the runCircuitBreakerGate primitive (Task 6.2)", async () => {
    const { runCircuitBreakerGate: defaultGate } =
      await import("@/lib/workflows/primitives/circuit-breaker-gate");
    const repository = seedRepoWithScriptValidator({
      consecutiveFailureCount: 2,
    });
    const { createToolServer, capturedCompleteTask } =
      createCapturingToolServer();
    const createConversation = vi.fn(async () => ({ id: "conv-script-gate" }));

    const runScriptValidator = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Pre-merge validation failed again",
      logFilePath:
        "/repo/.worktrees/session-1/.cc/workflow/execution-1/pre-merge-20260418T170100Z.log",
      logRelativePath:
        ".cc/workflow/execution-1/pre-merge-20260418T170100Z.log",
      timedOut: false,
    }));
    const validateContextCompletion = vi.fn();

    const runAgentIteration = vi.fn(async () => {
      await capturedCompleteTask()!("task-plan-1", "Done");
      await capturedCompleteTask()!("task-plan-2", "Done");
      return {
        conversationId: "conv-script-gate",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

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
        await repository.mutateActive("/repo", "session-1", () => current);
        return current;
      },
    );

    const runCircuitBreakerGate = vi.fn(defaultGate);

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      validationRoundService: stubValidationRoundService(),
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer,
      runAgentIteration,
      signalHalt,
      validationService: { validateContextCompletion },
      scriptValidatorService: { runScriptValidator },
      runCircuitBreakerGate,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(runCircuitBreakerGate).toHaveBeenCalledWith({
      failureCount: 3,
      threshold: 3,
    });
    const gateResult = runCircuitBreakerGate.mock.results.at(-1)!.value;
    expect(gateResult.status).toBe("fail");
    expect(gateResult.kind).toBe("circuit_breaker");

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
    expect(result.execution.status).toBe("halted");
    expect(result.execution.haltReason?.type).toBe("circuit_breaker");
  });
});

describe("iteration failure with partial turn progress", () => {
  it("rethrows as IterationFailureWithProgressError when a follow-up turn fails after a successful first turn", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );

    let agentCallCount = 0;
    const runAgentIteration = vi.fn(async () => {
      agentCallCount += 1;
      if (agentCallCount === 1) {
        return {
          conversationId: "conversation-progress",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      }
      throw new Error("SDK error: QuerySession is dead");
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-progress" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      now: () => "2026-03-27T16:00:00.000Z",
    });

    let caught: unknown;
    try {
      await orchestrator.runIteration({
        projectPath: "/repo",
        projectName: "repo",
        sessionName: "session-1",
        contextId: "context-plan",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IterationFailureWithProgressError);
    if (caught instanceof IterationFailureWithProgressError) {
      expect(caught.completedTurnCount).toBe(1);
      expect(caught.message).toContain("QuerySession is dead");
    }
    expect(agentCallCount).toBe(2);
  });

  it("rethrows the original error unwrapped when the first turn fails before any progress", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );

    const runAgentIteration = vi.fn(async () => {
      throw new Error("SDK error: QuerySession is dead");
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-fail" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      now: () => "2026-03-27T16:00:00.000Z",
    });

    let caught: unknown;
    try {
      await orchestrator.runIteration({
        projectPath: "/repo",
        projectName: "repo",
        sessionName: "session-1",
        contextId: "context-plan",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeInstanceOf(IterationFailureWithProgressError);
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toContain("QuerySession is dead");
    }
  });
});

// -- background-task wait lifecycle logging + accounting (task 4.2) ------------

describe("background-task wait lifecycle (task 4.2)", () => {
  type IterationLoggerCall = {
    event: string;
    data: Record<string, unknown> | undefined;
  };

  function createCapturingExecutionLogger(executionId: string): {
    logger: ExecutionLogger;
    iterationCalls: IterationLoggerCall[];
  } {
    const iterationCalls: IterationLoggerCall[] = [];
    const logger: ExecutionLogger = {
      executionId,
      logDir: "/tmp/test-bg-wait",
      writeManifest() {},
      lifecycle() {},
      iteration(_contextId, event, data) {
        iterationCalls.push({ event, data });
      },
      task() {},
      validation() {},
      writePrompt() {},
      writeValidatorResponse() {},
      writeValidatorTranscript() {},
      decision() {},
    };
    return { logger, iterationCalls };
  }

  afterEach(() => {
    _resetRegistryForTesting();
  });

  function backgroundWaitSummary(
    overrides: Partial<BackgroundWaitSummary> = {},
  ): BackgroundWaitSummary {
    return {
      waitedTaskIds: ["bg-task-1"],
      settledTaskIds: ["bg-task-1"],
      timedOut: false,
      durationMs: 1234,
      ...overrides,
    };
  }

  it("emits background_wait_started and background_wait_resolved entries when a non-timed-out wait occurred", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const { logger, iterationCalls } =
      createCapturingExecutionLogger("execution-1");
    registerExecutionLogger(logger);

    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:02:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 1,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
        backgroundWait: backgroundWaitSummary({
          waitedTaskIds: ["bg-task-1", "bg-task-2"],
          settledTaskIds: ["bg-task-1", "bg-task-2"],
          timedOut: false,
          durationMs: 4242,
        }),
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createToolServer: vi.fn(() => ({ server: { id: "tool-server" } })),
      runAgentIteration,
      now() {
        return "2026-03-27T16:00:00.000Z";
      },
    });

    const beforeRun = Date.now();
    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });
    const afterRun = Date.now();

    const started = iterationCalls.find(
      (call) => call.event === "iteration.background_wait_started",
    );
    expect(started).toBeDefined();
    expect(started?.data).toMatchObject({
      waitedTaskIds: ["bg-task-1", "bg-task-2"],
      durationMs: 4242,
    });
    // Both wait-lifecycle lines are written retrospectively after the turn;
    // startedAt back-dates the started line to the wait's true begin time.
    const startedAt = (started?.data as { startedAt?: string }).startedAt;
    expect(startedAt).toBeDefined();
    expect(Date.parse(startedAt!)).toBeGreaterThanOrEqual(beforeRun - 4242);
    expect(Date.parse(startedAt!)).toBeLessThanOrEqual(afterRun - 4242);

    const resolved = iterationCalls.find(
      (call) => call.event === "iteration.background_wait_resolved",
    );
    expect(resolved).toBeDefined();
    expect(resolved?.data).toMatchObject({
      settledTaskIds: ["bg-task-1", "bg-task-2"],
      durationMs: 4242,
    });

    expect(
      iterationCalls.some(
        (call) => call.event === "iteration.background_wait_timed_out",
      ),
    ).toBe(false);
  });

  it("emits background_wait_started and background_wait_timed_out with still-in-flight ids when the wait timed out", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const { logger, iterationCalls } =
      createCapturingExecutionLogger("execution-1");
    registerExecutionLogger(logger);

    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:02:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 1,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
        backgroundWait: backgroundWaitSummary({
          waitedTaskIds: ["bg-task-1", "bg-task-2"],
          settledTaskIds: ["bg-task-1"],
          timedOut: true,
          durationMs: 60000,
        }),
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createToolServer: vi.fn(() => ({ server: { id: "tool-server" } })),
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

    const started = iterationCalls.find(
      (call) => call.event === "iteration.background_wait_started",
    );
    expect(started).toBeDefined();
    expect(started?.data).toMatchObject({
      waitedTaskIds: ["bg-task-1", "bg-task-2"],
      durationMs: 60000,
    });
    expect((started?.data as { startedAt?: string }).startedAt).toBeDefined();

    const timedOut = iterationCalls.find(
      (call) => call.event === "iteration.background_wait_timed_out",
    );
    expect(timedOut).toBeDefined();
    // Still-in-flight ids are waitedTaskIds minus settledTaskIds.
    expect(timedOut?.data).toMatchObject({
      stillInFlightTaskIds: ["bg-task-2"],
      durationMs: 60000,
    });

    expect(
      iterationCalls.some(
        (call) => call.event === "iteration.background_wait_resolved",
      ),
    ).toBe(false);
  });

  it("does not emit any background_wait entries when no wait occurred", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const { logger, iterationCalls } =
      createCapturingExecutionLogger("execution-1");
    registerExecutionLogger(logger);

    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:02:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 1,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createToolServer: vi.fn(() => ({ server: { id: "tool-server" } })),
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

    expect(
      iterationCalls.some((call) =>
        call.event.startsWith("iteration.background_wait"),
      ),
    ).toBe(false);
  });

  it("consumes exactly one iteration and sends no extra follow-up turn because a wait occurred (5.1)", async () => {
    // All tasks complete on the first turn, so the follow-up loop has nothing
    // to drive. A wait happening inside that single turn must not cause an
    // additional turn nor an extra iteration to be counted.
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );

    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:02:00.000Z",
      };
      current.taskStates["task-plan-2"] = {
        ...current.taskStates["task-plan-2"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:02:30.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
        backgroundWait: backgroundWaitSummary(),
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createToolServer: vi.fn(() => ({ server: { id: "tool-server" } })),
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

    // The wait lives inside the single agent turn — no extra turn dispatched.
    expect(runAgentIteration).toHaveBeenCalledOnce();
    // iterationCount incremented exactly once (seeded), not bumped by the wait.
    expect(result.execution.contextStates["context-plan"]?.iterationCount).toBe(
      1,
    );
  });

  it("does not increase the consecutive-failure count or trip the circuit breaker as a result of the wait (5.2/5.3)", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );

    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:02:00.000Z",
      };
      current.taskStates["task-plan-2"] = {
        ...current.taskStates["task-plan-2"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:02:30.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
        backgroundWait: backgroundWaitSummary({ timedOut: true }),
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createToolServer: vi.fn(() => ({ server: { id: "tool-server" } })),
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

    // The wait (even a timed-out one) is not a failure: counter stays at 0 and
    // the context is not halted.
    expect(
      result.execution.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(0);
    expect(result.execution.status).toBe("running");
    expect(result.execution.haltReason ?? null).toBeNull();
  });
});

// -- Human approval gate at finalization ---------------------------------------

describe("human approval gate at finalization", () => {
  const NOW = "2026-03-27T16:20:00.000Z";

  function enableGateOnPlanContext(execution: GraphWorkflowExecution): void {
    const planContext = execution.workingDefinition.executionContexts.find(
      (ctx) => ctx.id === "context-plan",
    )!;
    planContext.humanApprovalGate = { enabled: true };
  }

  function completeAllPlanTasks(repository: {
    read(): GraphWorkflowExecution;
    mutateActive(
      projectPath: string,
      sessionName: string,
      fn: (
        execution: GraphWorkflowExecution,
      ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
    ): Promise<GraphWorkflowExecution>;
  }) {
    return vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:02:00.000Z",
      };
      current.taskStates["task-plan-2"] = {
        ...current.taskStates["task-plan-2"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:02:30.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-gate",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });
  }

  function passingValidationService() {
    return {
      validateContextCompletion: vi.fn(async () => ({
        kind: "pass" as const,
        summary: "All checks passed",
        feedback: "Context validation passed.",
        issues: [] as never[],
        reopenTaskIds: [],
        sessionRef: null,
        reviewArtifact: null,
      })),
    };
  }

  function approvalPendingEvents(
    calls: Array<[GraphWorkflowSSEEvent]>,
  ): GraphWorkflowSSEEvent[] {
    return calls
      .map(([event]) => event)
      .filter((event) => event.type === "graph-workflow-approval-pending");
  }

  it("parks a gate-enabled context after all validators pass and publishes approval-pending after commit", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    enableGateOnPlanContext(execution);
    const repository = createRepository(execution);

    let statusAtBroadcast: string | null = null;
    let pendingRecordAtBroadcast:
      | GraphWorkflowExecution["contextStates"][string]["pendingApproval"]
      | null = null;
    const broadcast = vi.fn((event: GraphWorkflowSSEEvent) => {
      if (event.type === "graph-workflow-approval-pending") {
        const committedState = repository.read().contextStates["context-plan"];
        statusAtBroadcast = committedState?.status ?? null;
        pendingRecordAtBroadcast = committedState?.pendingApproval ?? null;
      }
    });
    const dispatchPush = vi.fn();
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-gate" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeAllPlanTasks(repository),
      validationService: passingValidationService(),
      eventPublisher,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(result.shouldContinueInContext).toBe(false);

    const persisted = repository.read();
    const contextState = persisted.contextStates["context-plan"];
    expect(contextState?.status).toBe("awaiting_approval");
    expect(contextState?.pendingApproval).toEqual({
      conversationId: "conversation-gate",
      requestedAt: NOW,
      decision: null,
      // Full-access member: no ownership to scope to, so it parks on the
      // whole-tree approval view (R15.2).
      approvalScope: { kind: "whole_tree" },
    });
    expect(persisted.activeContextIds).not.toContain("context-plan");

    const pendingEvents = approvalPendingEvents(broadcast.mock.calls);
    expect(pendingEvents).toEqual([
      {
        type: "graph-workflow-approval-pending",
        projectName: "repo",
        sessionName: "session-1",
        executionId: persisted.id,
        contextId: "context-plan",
        contextTitle: "Plan",
        conversationId: "conversation-gate",
        requestedAt: NOW,
      },
    ]);
    // Published strictly after the parking mutation committed.
    expect(statusAtBroadcast).toBe("awaiting_approval");
    expect(pendingRecordAtBroadcast).toEqual({
      conversationId: "conversation-gate",
      requestedAt: NOW,
      decision: null,
      approvalScope: { kind: "whole_tree" },
    });
    expect(dispatchPush).toHaveBeenCalledExactlyOnceWith({
      kind: "approval-pending",
      projectName: "repo",
      sessionName: "session-1",
      contextTitle: "Plan",
    });

    // History entry persists in the repository, not only on the returned clone.
    const persistedHistoryEvent = repository.appendedEvents.find(
      (entry) => entry.event.type === "graph-workflow-approval-pending",
    );
    expect(persistedHistoryEvent?.event).toMatchObject({
      type: "graph-workflow-approval-pending",
      contextId: "context-plan",
      conversationId: "conversation-gate",
      requestedAt: NOW,
    });
    expect(
      repository.appendedEvents.some(
        (entry) => entry.event.type === "graph-workflow-approval-pending",
      ),
    ).toBe(true);

    const approvalCommits = repository.commits.filter(
      (commit) =>
        commit.execution.contextStates["context-plan"]?.status ===
          "awaiting_approval" &&
        commit.execution.contextStates["context-plan"]?.pendingApproval !==
          null,
    );
    expect(approvalCommits).toHaveLength(1);
    expect(approvalCommits[0]?.events.map((entry) => entry.event.type)).toEqual(
      expect.arrayContaining([
        "graph-workflow-approval-pending",
        "graph-workflow-boundary",
      ]),
    );
  });

  it("parks an enveloped member on the owned-subset candidate it froze", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    enableGateOnPlanContext(execution);
    const planContext = execution.workingDefinition.executionContexts.find(
      (ctx) => ctx.id === "context-plan",
    );
    if (!planContext) throw new Error("fixture missing context-plan");
    planContext.placement = {
      lane: "impl",
      mode: "owned",
      ownedPaths: ["src/api", "docs/api.md"],
    };
    const repository = createRepository(execution);

    // The SAME resolver a validation round freezes through, so the approval
    // surface and the validators cannot disagree about what this context owns.
    const resolvedScopes: unknown[] = [];
    const validationRoundService = {
      resolveCandidateTree: vi.fn(
        async (input: { candidateScope: unknown }) => {
          resolvedScopes.push(input.candidateScope);
          return {
            kind: "resolved" as const,
            identityScope: "owned" as const,
            headSha: "base-sha",
            candidateTreeHash: "owned-digest",
          };
        },
      ),
    };

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-gate" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeAllPlanTasks(repository),
      validationService: passingValidationService(),
      validationRoundService,
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    const contextState = repository.read().contextStates["context-plan"];
    expect(contextState?.status).toBe("awaiting_approval");
    expect(contextState?.pendingApproval?.approvalScope).toEqual({
      kind: "scoped",
      ownedPaths: ["src/api", "docs/api.md"],
      treeHash: "owned-digest",
      headSha: "base-sha",
    });
    expect(resolvedScopes).toContainEqual({
      mode: "owned",
      ownedPaths: ["src/api", "docs/api.md"],
    });
  });

  it("parks an enveloped member with no frozen snapshot when the candidate cannot be read", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    enableGateOnPlanContext(execution);
    const planContext = execution.workingDefinition.executionContexts.find(
      (ctx) => ctx.id === "context-plan",
    );
    if (!planContext) throw new Error("fixture missing context-plan");
    planContext.placement = {
      lane: "impl",
      mode: "owned",
      ownedPaths: ["src/api"],
    };
    const repository = createRepository(execution);

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-gate" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeAllPlanTasks(repository),
      validationService: passingValidationService(),
      validationRoundService: {
        resolveCandidateTree: vi.fn(async () => ({
          kind: "unavailable" as const,
          reason: "git could not resolve HEAD",
        })),
      },
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // The gate still stands — an unreadable candidate must not strand the
    // human decision. The approval surface reports the missing artifact
    // rather than falling back to the shared lane's whole-tree delta.
    const contextState = repository.read().contextStates["context-plan"];
    expect(contextState?.status).toBe("awaiting_approval");
    // Fails CLOSED: an enveloped member whose candidate could not be read
    // parks on an explicitly unreadable scope, never the whole-tree view.
    expect(contextState?.pendingApproval?.approvalScope).toEqual({
      kind: "unreadable",
      reason: "git could not resolve HEAD",
    });
  });

  it("completes a gate-disabled context unchanged with no approval event", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );

    const broadcast = vi.fn<(event: GraphWorkflowSSEEvent) => void>();
    const dispatchPush = vi.fn();
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-gate" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeAllPlanTasks(repository),
      validationService: passingValidationService(),
      eventPublisher,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(result.shouldContinueInContext).toBe(false);

    const persisted = repository.read();
    const contextState = persisted.contextStates["context-plan"];
    expect(contextState?.status).toBe("completed");
    expect(contextState?.pendingApproval).toBeNull();
    expect(persisted.activeContextIds).not.toContain("context-plan");

    expect(approvalPendingEvents(broadcast.mock.calls)).toEqual([]);
    expect(dispatchPush).not.toHaveBeenCalled();
    expect(
      repository.appendedEvents.some(
        (entry) => entry.event.type === "graph-workflow-approval-pending",
      ),
    ).toBe(false);
  });

  it("routes a validator failure through the standard reopen flow without triggering the gate", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    enableGateOnPlanContext(execution);
    const repository = createRepository(execution);

    const broadcast = vi.fn<(event: GraphWorkflowSSEEvent) => void>();
    const dispatchPush = vi.fn();
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;

    const validateContextCompletion = vi.fn(async () => ({
      kind: "fail" as const,
      summary: "Validation failed",
      feedback:
        "Context validation blocked completion.\nReopened tasks:\n- task-plan-2",
      issues: [
        {
          assignmentId: "general",
          taskId: "task-plan-2",
          title: "Missing tests",
          description: "Add edge case tests.",
        },
      ],
      reopenTaskIds: ["task-plan-2"],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-gate" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeAllPlanTasks(repository),
      validationService: { validateContextCompletion },
      eventPublisher,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(result.shouldContinueInContext).toBe(true);

    const persisted = repository.read();
    const contextState = persisted.contextStates["context-plan"];
    expect(contextState?.status).toBe("running");
    expect(contextState?.pendingApproval).toBeNull();
    expect(contextState?.consecutiveFailureCount).toBe(1);

    expect(approvalPendingEvents(broadcast.mock.calls)).toEqual([]);
    expect(dispatchPush).not.toHaveBeenCalled();
    expect(
      repository.appendedEvents.some(
        (entry) => entry.event.type === "graph-workflow-approval-pending",
      ),
    ).toBe(false);
  });
});

// -- Awaiting-user-input park after an implementer turn ------------------------

describe("awaiting-user-input park after an implementer turn", () => {
  const NOW = "2026-07-03T16:00:00.000Z";

  function question(id: string): AskQuestionItem {
    return {
      id,
      question: `Which path for ${id}?`,
      options: [
        { label: "A", recommended: false },
        { label: "B", recommended: false },
      ],
      multiSelect: false,
      required: true,
      allowNote: true,
    };
  }

  /** Real gate over the in-memory repository — exercises the true park write. */
  function createGate(
    repository: ReturnType<typeof createRepository>,
    eventPublisher: ReturnType<
      typeof createGraphWorkflowExecutionEventPublisher
    >,
  ) {
    return createUserInputGateService({
      getActive: repository.getActive,
      mutateActive: repository.mutateActive,
      publishUserInputPending: eventPublisher.publishUserInputPending,
      publishUserInputResolved: eventPublisher.publishUserInputResolved,
      deliver: eventPublisher.deliver,
      sendConversationEvent: () => false,
      now: () => NOW,
    });
  }

  /** Agent turn that completes every plan task (so validation would run absent a park). */
  function completeAllPlanTasks(
    repository: ReturnType<typeof createRepository>,
  ) {
    return vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: NOW,
      };
      current.taskStates["task-plan-2"] = {
        ...current.taskStates["task-plan-2"]!,
        status: "completed",
        summary: "Done",
        completedAt: NOW,
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-ask",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });
  }

  it("parks the context when the lane conversation ends with a pending question", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    // Pre-set a non-zero failure count so we can prove parking leaves it alone.
    execution.contextStates["context-plan"]!.consecutiveFailureCount = 2;
    execution.contextStates["context-plan"]!.iterationCount = 4;
    const repository = createRepository(execution);
    const iterationCountBeforeTurn =
      repository.read().contextStates["context-plan"]!.iterationCount;

    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;
    const gate = createGate(repository, eventPublisher);

    const questions = [question("q1"), question("q2")];
    const readLaneConversation = vi.fn(async () => ({
      pendingQuestionId: "batch-1",
      pendingQuestions: questions,
    }));
    const enterSpy = vi.spyOn(gate, "enterAwaitingUserInput");

    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "unreached",
      feedback: "unreached",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-ask" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeAllPlanTasks(repository),
      validationService: { validateContextCompletion },
      userInputGateService: gate,
      readLaneConversation,
      eventPublisher,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Parked outcome: the context does not continue and validation never ran.
    expect(result.shouldContinueInContext).toBe(false);
    expect(result.conversationId).toBe("conversation-ask");
    expect(validateContextCompletion).not.toHaveBeenCalled();

    // The returned execution reflects the committed park.
    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "awaiting_user_input",
    );

    // The gate was driven with the implementer lane key, batch, and snapshot
    // questions.
    expect(enterSpy).toHaveBeenCalledTimes(1);
    expect(enterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "context-plan",
        laneKey: "implementer",
        conversationId: "conversation-ask",
        questionBatchId: "batch-1",
        questions,
      }),
    );

    // Persisted state: awaiting_user_input with the snapshot record.
    const persisted = repository.read();
    const contextState = persisted.contextStates["context-plan"];
    expect(contextState?.status).toBe("awaiting_user_input");
    expect(contextState?.pendingUserInputs["implementer"]).toMatchObject({
      conversationId: "conversation-ask",
      lane: "implementer",
      questionBatchId: "batch-1",
      questions,
      answers: null,
    });

    // Req 3.3: no iteration consumed and no failure recorded while parked.
    expect(contextState?.iterationCount).toBe(iterationCountBeforeTurn);
    expect(contextState?.consecutiveFailureCount).toBe(2);

    // The parked context is not scheduled to continue.
    expect(persisted.activeContextIds).not.toContain("context-plan");

    const parkCommit = repository.commits.find(
      (commit) =>
        commit.execution.contextStates["context-plan"]?.pendingUserInputs[
          "implementer"
        ]?.questionBatchId === "batch-1",
    );
    expect(parkCommit?.events.map((entry) => entry.event.type)).toEqual(
      expect.arrayContaining([
        "graph-workflow-user-input-pending",
        "graph-workflow-boundary",
      ]),
    );
  });

  it("parks after the asking turn without dispatching a follow-up (ask-ended turn never reaches the follow-up loop)", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    execution.contextStates["context-plan"]!.consecutiveFailureCount = 1;
    execution.contextStates["context-plan"]!.iterationCount = 3;
    const repository = createRepository(execution);
    const iterationCountBeforeTurn =
      repository.read().contextStates["context-plan"]!.iterationCount;

    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;
    const gate = createGate(repository, eventPublisher);
    const enterSpy = vi.spyOn(gate, "enterAwaitingUserInput");

    const questions = [question("q1")];
    const readLaneConversation = vi.fn(async () => ({
      pendingQuestionId: "batch-1",
      pendingQuestions: questions,
    }));

    // The asking turn ends cleanly with its tasks still incomplete — the shape
    // that would otherwise enter the follow-up loop. A follow-up SUBMIT_PROMPT
    // onto a waitingForInput conversation wipes the pending question (the
    // machine treats any claimed turn as superseding it), so the park check
    // must run before every follow-up dispatch, not only after the loop.
    const runAgentIteration = vi.fn(async () => ({
      conversationId: "conversation-ask",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
    }));

    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "unreached",
      feedback: "unreached",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-ask" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      validationService: { validateContextCompletion },
      userInputGateService: gate,
      readLaneConversation,
      eventPublisher,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // The discriminating assertion: exactly one agent turn ran. The ask-ended
    // turn parks before any follow-up prompt is dispatched onto the asking
    // conversation.
    expect(runAgentIteration).toHaveBeenCalledTimes(1);
    expect(enterSpy).toHaveBeenCalledTimes(1);

    expect(result.shouldContinueInContext).toBe(false);
    expect(validateContextCompletion).not.toHaveBeenCalled();

    const persisted = repository.read();
    const contextState = persisted.contextStates["context-plan"];
    expect(contextState?.status).toBe("awaiting_user_input");
    expect(contextState?.pendingUserInputs["implementer"]).toMatchObject({
      conversationId: "conversation-ask",
      lane: "implementer",
      questionBatchId: "batch-1",
      questions,
      answers: null,
    });

    // Req 3.3 holds at this check site too: no iteration consumed, no failure
    // recorded.
    expect(contextState?.iterationCount).toBe(iterationCountBeforeTurn);
    expect(contextState?.consecutiveFailureCount).toBe(1);
    expect(persisted.activeContextIds).not.toContain("context-plan");
  });

  it("parks an asking turn before honoring a sibling's pending halt", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    execution.contextStates["context-plan"]!.iterationCount = 3;
    const repository = createRepository(execution);
    const iterationCountBeforeTurn =
      repository.read().contextStates["context-plan"]!.iterationCount;

    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;
    const gate = createGate(repository, eventPublisher);
    const enterSpy = vi.spyOn(gate, "enterAwaitingUserInput");

    const questions = [question("q1")];
    const pendingHaltReason: GraphWorkflowHaltReason = {
      type: "agent_turn_failed",
      contextId: "sibling-context",
      engine: "codex",
      cause: "sdk_error",
      message: "Sibling turn failed",
    };
    const readLaneConversation = vi.fn(async () => ({
      pendingQuestionId: "batch-1",
      pendingQuestions: questions,
    }));
    const runAgentIteration = vi.fn(async () => {
      await repository.mutateActive("/repo", "session-1", (current) => {
        current.pendingHaltReason = pendingHaltReason;
        return current;
      });
      return {
        conversationId: "conversation-ask",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });
    const signalHalt = vi.fn(
      async (input: {
        projectPath: string;
        sessionName: string;
        reason: GraphWorkflowHaltReason;
      }) => {
        const current = structuredClone(repository.read());
        current.status = "halted";
        current.haltReason = input.reason;
        current.pendingHaltReason = null;
        await repository.mutateActive("/repo", "session-1", () => current);
        return current;
      },
    );

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-ask" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      signalHalt,
      userInputGateService: gate,
      readLaneConversation,
      eventPublisher,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(runAgentIteration).toHaveBeenCalledTimes(1);
    expect(enterSpy).toHaveBeenCalledTimes(1);
    expect(signalHalt).not.toHaveBeenCalled();
    expect(result.execution.status).toBe("running");
    expect(result.execution.pendingHaltReason).toEqual(pendingHaltReason);
    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "awaiting_user_input",
    );
    expect(
      result.execution.contextStates["context-plan"]?.pendingUserInputs[
        "implementer"
      ],
    ).toMatchObject({
      conversationId: "conversation-ask",
      questionBatchId: "batch-1",
      questions,
      answers: null,
    });
    expect(result.execution.contextStates["context-plan"]?.iterationCount).toBe(
      iterationCountBeforeTurn,
    );
  });

  it("parks the context when an ask-ended turn surfaces a sessionDiedMidTurn error (park wins over the transient error)", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    // Pre-set a non-zero failure count to prove parking leaves it alone.
    execution.contextStates["context-plan"]!.consecutiveFailureCount = 2;
    execution.contextStates["context-plan"]!.iterationCount = 4;
    const repository = createRepository(execution);
    const iterationCountBeforeTurn =
      repository.read().contextStates["context-plan"]!.iterationCount;

    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;
    const gate = createGate(repository, eventPublisher);

    const questions = [question("q1"), question("q2")];
    const readLaneConversation = vi.fn(async () => ({
      pendingQuestionId: "batch-1",
      pendingQuestions: questions,
    }));
    const enterSpy = vi.spyOn(gate, "enterAwaitingUserInput");

    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "unreached",
      feedback: "unreached",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));

    // The lane agent asked and ended its turn, but the implementer runner's
    // waitForBackgroundTasks settlement barrier surfaced the ask-interrupt as a
    // sessionDiedMidTurn SDK error thrown out of the agent iteration. A pending
    // question must still win over the transient error and park the context.
    const runAgentIteration = vi.fn(async () => {
      throw new AgentTurnFailedError(
        "SDK error: QuerySession ended before the turn completed",
        {
          contextId: "context-plan",
          engine: "claude",
          cause: "sdk_error",
          originalMessage: "QuerySession ended before the turn completed",
        },
      );
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-ask" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      validationService: { validateContextCompletion },
      userInputGateService: gate,
      readLaneConversation,
      eventPublisher,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Parked outcome: no continue, validation never ran, status is awaiting.
    expect(result.shouldContinueInContext).toBe(false);
    expect(validateContextCompletion).not.toHaveBeenCalled();
    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "awaiting_user_input",
    );

    expect(enterSpy).toHaveBeenCalledTimes(1);
    expect(enterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "context-plan",
        laneKey: "implementer",
        conversationId: "conversation-ask",
        questionBatchId: "batch-1",
        questions,
      }),
    );

    const persisted = repository.read();
    const contextState = persisted.contextStates["context-plan"];
    expect(contextState?.status).toBe("awaiting_user_input");
    // Req 3.3: parking consumes no iteration and records no failure, even though
    // the turn technically threw.
    expect(contextState?.iterationCount).toBe(iterationCountBeforeTurn);
    expect(contextState?.consecutiveFailureCount).toBe(2);
    expect(persisted.activeContextIds).not.toContain("context-plan");
  });

  it("re-throws an agent turn error when no question is pending (park never masks a real failure)", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const repository = createRepository(execution);
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;
    const gate = createGate(repository, eventPublisher);
    const enterSpy = vi.spyOn(gate, "enterAwaitingUserInput");

    // No pending question on the lane conversation → a genuine failure.
    const readLaneConversation = vi.fn(async () => ({
      pendingQuestionId: null,
      pendingQuestions: [],
    }));

    const runAgentIteration = vi.fn(async () => {
      throw new AgentTurnFailedError("SDK error: genuine-boom", {
        contextId: "context-plan",
        engine: "claude",
        cause: "sdk_error",
        originalMessage: "genuine-boom",
      });
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-ask" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      validationService: { validateContextCompletion: vi.fn() },
      userInputGateService: gate,
      readLaneConversation,
      eventPublisher,
      now: () => NOW,
    });

    await expect(
      orchestrator.runIteration({
        projectPath: "/repo",
        projectName: "repo",
        sessionName: "session-1",
        contextId: "context-plan",
      }),
    ).rejects.toThrow(/genuine-boom|QuerySession/);
    expect(enterSpy).not.toHaveBeenCalled();
    expect(repository.read().contextStates["context-plan"]?.status).not.toBe(
      "awaiting_user_input",
    );
  });

  it("does not park when answers are already recorded at the check (fast answer)", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    // Fast answer: a same-batch record with answers already exists pre-park.
    execution.contextStates["context-plan"]!.pendingUserInputs = {
      implementer: {
        conversationId: "conversation-ask",
        lane: "implementer",
        questionBatchId: "batch-1",
        questions: [question("q1")],
        requestedAt: NOW,
        roundSeq: null,
        answers: {
          byQuestionId: {
            q1: { selected: ["A"], note: null, skipped: false, question: "?" },
          },
          answeredAt: NOW,
        },
      },
    };
    const repository = createRepository(execution);

    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;
    const gate = createGate(repository, eventPublisher);
    const enterSpy = vi.spyOn(gate, "enterAwaitingUserInput");

    const readLaneConversation = vi.fn(async () => ({
      pendingQuestionId: "batch-1",
      pendingQuestions: [question("q1")],
    }));

    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "All checks passed",
      feedback: "Context validation passed.",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-ask" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeAllPlanTasks(repository),
      validationService: { validateContextCompletion },
      userInputGateService: gate,
      readLaneConversation,
      eventPublisher,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // The gate was consulted but returned answers_ready → no park.
    expect(enterSpy).toHaveBeenCalledTimes(1);
    const persisted = repository.read();
    expect(persisted.contextStates["context-plan"]?.status).not.toBe(
      "awaiting_user_input",
    );

    // Fell through to the normal finalize path: all tasks complete → validation ran.
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "completed",
    );
    expect(result.shouldContinueInContext).toBe(false);
  });

  it("behaves identically to today when the lane has no pending question", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const repository = createRepository(execution);

    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;
    const gate = createGate(repository, eventPublisher);
    const enterSpy = vi.spyOn(gate, "enterAwaitingUserInput");

    const readLaneConversation = vi.fn(async () => ({
      pendingQuestionId: null,
      pendingQuestions: [],
    }));

    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "All checks passed",
      feedback: "Context validation passed.",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-ask" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeAllPlanTasks(repository),
      validationService: { validateContextCompletion },
      userInputGateService: gate,
      readLaneConversation,
      eventPublisher,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // No pending question → no park, no gate call, normal completion.
    expect(enterSpy).not.toHaveBeenCalled();
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "completed",
    );
    expect(result.shouldContinueInContext).toBe(false);
    expect(
      repository.read().contextStates["context-plan"]?.pendingUserInputs,
    ).toEqual({});
  });
});

// -- Awaiting-user-input park after a context-validator turn ------------------

describe("awaiting-user-input park after a context-validator turn", () => {
  const NOW = "2026-07-03T16:00:00.000Z";

  function question(id: string): AskQuestionItem {
    return {
      id,
      question: `Which path for ${id}?`,
      options: [
        { label: "A", recommended: false },
        { label: "B", recommended: false },
      ],
      multiSelect: false,
      required: true,
      allowNote: true,
    };
  }

  function createGate(
    repository: ReturnType<typeof createRepository>,
    eventPublisher: ReturnType<
      typeof createGraphWorkflowExecutionEventPublisher
    >,
  ) {
    return createUserInputGateService({
      getActive: repository.getActive,
      mutateActive: repository.mutateActive,
      publishUserInputPending: eventPublisher.publishUserInputPending,
      publishUserInputResolved: eventPublisher.publishUserInputResolved,
      deliver: eventPublisher.deliver,
      sendConversationEvent: () => false,
      now: () => NOW,
    });
  }

  /** Agent turn that completes every plan task, so validation runs after it. */
  function completeAllPlanTasks(
    repository: ReturnType<typeof createRepository>,
  ) {
    return vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: NOW,
      };
      current.taskStates["task-plan-2"] = {
        ...current.taskStates["task-plan-2"]!,
        status: "completed",
        summary: "Done",
        completedAt: NOW,
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-impl",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });
  }

  it("parks the context with lane=context_validator when the validator asks, leaving the failure count and tasks untouched", async () => {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    // Pre-set a non-zero failure count so we can prove parking leaves it alone.
    execution.contextStates["context-plan"]!.consecutiveFailureCount = 2;
    const repository = createRepository(execution);

    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;
    const gate = createGate(repository, eventPublisher);
    const enterSpy = vi.spyOn(gate, "enterAwaitingUserInput");

    // Implementer lane has no pending question → implementer park does not fire.
    const readLaneConversation = vi.fn(async () => ({
      pendingQuestionId: null,
      pendingQuestions: [] as AskQuestionItem[],
    }));

    const questions = [question("qv1")];
    // The validator's turn ended with a pending question and no verdict.
    const validateContextCompletion = vi.fn(async () => ({
      kind: "asked_user" as const,
      parked: [
        {
          assignmentId: "general",
          conversationId: "conversation-validator",
          questionBatchId: "batch-validator-1",
          questions,
        },
      ] as [CohortParkedLane, ...CohortParkedLane[]],
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-impl" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeAllPlanTasks(repository),
      validationService: { validateContextCompletion },
      userInputGateService: gate,
      readLaneConversation,
      eventPublisher,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // Validation ran (the validator asked), but the outcome parks — no continue.
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
    expect(result.shouldContinueInContext).toBe(false);
    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "awaiting_user_input",
    );

    // The gate was driven with the asking VALIDATOR's lane key, batch, and
    // snapshot questions.
    expect(enterSpy).toHaveBeenCalledTimes(1);
    expect(enterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "context-plan",
        laneKey: "context_validator:general",
        conversationId: "conversation-validator",
        questionBatchId: "batch-validator-1",
        questions,
      }),
    );

    // Persisted state: awaiting_user_input with the validator snapshot record.
    const persisted = repository.read();
    const contextState = persisted.contextStates["context-plan"];
    expect(contextState?.status).toBe("awaiting_user_input");
    expect(
      contextState?.pendingUserInputs["context_validator:general"],
    ).toMatchObject({
      conversationId: "conversation-validator",
      lane: "context_validator",
      questionBatchId: "batch-validator-1",
      questions,
      answers: null,
    });

    // Req 3.2/3.3: the failure count is untouched and no task was reopened.
    expect(contextState?.consecutiveFailureCount).toBe(2);
    expect(persisted.taskStates["task-plan-1"]?.status).toBe("completed");
    expect(persisted.taskStates["task-plan-2"]?.status).toBe("completed");
    expect(persisted.taskStates["task-plan-2"]?.failureMessage).toBeNull();
    expect(persisted.taskStates["task-plan-2"]?.failureHistory).toHaveLength(0);

    // Req 3.2: no validation-failure event was recorded for the asking turn.
    const validationResultEvents = repository.appendedEvents.filter(
      (entry) => entry.event.type === "graph-workflow-validation-result",
    );
    expect(validationResultEvents).toHaveLength(0);

    // The parked context is not scheduled to continue.
    expect(persisted.activeContextIds).not.toContain("context-plan");
  });

  it("parks from the validation-only re-entry path when the validator asks", async () => {
    // All tasks already complete at entry → runIteration takes the
    // validation-only path, which must also short-circuit to a park.
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "completed",
      "task-plan-2": "completed",
    });
    execution.contextStates["context-plan"]!.consecutiveFailureCount = 1;
    execution.contextStates["context-plan"]!.completedTaskCount = 2;
    const repository = createRepository(execution);

    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      now: () => NOW,
    });
    repository.deliver = eventPublisher.deliver;
    const gate = createGate(repository, eventPublisher);
    const enterSpy = vi.spyOn(gate, "enterAwaitingUserInput");

    const readLaneConversation = vi.fn(async () => ({
      pendingQuestionId: null,
      pendingQuestions: [] as AskQuestionItem[],
    }));

    const questions = [question("qv1")];
    const validateContextCompletion = vi.fn(async () => ({
      kind: "asked_user" as const,
      parked: [
        {
          assignmentId: "general",
          conversationId: "conversation-validator",
          questionBatchId: "batch-validator-2",
          questions,
        },
      ] as [CohortParkedLane, ...CohortParkedLane[]],
    }));

    const runAgentIteration = vi.fn(async () => {
      throw new Error("validation-only path must not run the implementer");
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-impl" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      validationService: { validateContextCompletion },
      userInputGateService: gate,
      readLaneConversation,
      eventPublisher,
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(runAgentIteration).not.toHaveBeenCalled();
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
    expect(enterSpy).toHaveBeenCalledWith(
      expect.objectContaining({ laneKey: "context_validator:general" }),
    );
    expect(result.shouldContinueInContext).toBe(false);
    expect(result.execution.contextStates["context-plan"]?.status).toBe(
      "awaiting_user_input",
    );
    const contextState = repository.read().contextStates["context-plan"];
    expect(contextState?.consecutiveFailureCount).toBe(1);
    expect(
      repository.appendedEvents.filter(
        (entry) => entry.event.type === "graph-workflow-validation-result",
      ),
    ).toHaveLength(0);
  });
});

describe("appendFailureHistory (cap)", () => {
  const failure = (n: number) => ({
    message: `failure ${n}`,
    timestamp: `2026-06-19T00:00:${String(n).padStart(2, "0")}Z`,
  });

  it("appends to an empty/undefined history", () => {
    expect(appendFailureHistory(undefined, failure(1))).toEqual([failure(1)]);
    expect(appendFailureHistory([], failure(1))).toEqual([failure(1)]);
  });

  it("keeps only the most recent 10 entries, dropping the oldest", () => {
    let history = appendFailureHistory(undefined, failure(0));
    for (let n = 1; n < 15; n += 1) {
      history = appendFailureHistory(history, failure(n));
    }

    expect(history).toHaveLength(10);
    // Oldest (failure 0..4) dropped; the most recent 10 (failure 5..14) retained, in order.
    expect(history.map((f) => f.message)).toEqual([
      "failure 5",
      "failure 6",
      "failure 7",
      "failure 8",
      "failure 9",
      "failure 10",
      "failure 11",
      "failure 12",
      "failure 13",
      "failure 14",
    ]);
  });
});

// -- per-conversation occupancy-vs-outcome telemetry ---------------------------

describe("conversation telemetry emission", () => {
  afterEach(() => {
    _resetRegistryForTesting();
  });

  function createCapturingExecutionLogger(executionId: string): {
    logger: ExecutionLogger;
    iterationCalls: Array<{
      event: string;
      data: Record<string, unknown> | undefined;
    }>;
  } {
    const iterationCalls: Array<{
      event: string;
      data: Record<string, unknown> | undefined;
    }> = [];
    const logger: ExecutionLogger = {
      executionId,
      logDir: "/tmp/test-conversation-telemetry",
      writeManifest() {},
      lifecycle() {},
      iteration(_contextId, event, data) {
        iterationCalls.push({ event, data });
      },
      task() {},
      validation() {},
      writePrompt() {},
      writeValidatorResponse() {},
      writeValidatorTranscript() {},
      decision() {},
    };
    return { logger, iterationCalls };
  }

  function makeCompletingHarness() {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "completed",
      }),
    );
    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:02:00.000Z",
      };
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: 123_456,
        contextWindowMax: 1_000_000,
        compacted: false,
      };
    });
    return { repository, runAgentIteration };
  }

  it("emits a conversation.telemetry event with the transcript summary after the iteration completes", async () => {
    const { repository, runAgentIteration } = makeCompletingHarness();
    const { logger, iterationCalls } =
      createCapturingExecutionLogger("execution-1");
    registerExecutionLogger(logger);

    const readConversationTelemetry = vi.fn(async () => ({
      costUsd: 23.5,
      apiTurns: 137,
      lineageCount: 1,
      reads: { uniqueFiles: 3, totalReads: 6, repeatReads: 3 },
      topReReads: [{ path: "/repo/a.ts", count: 3 }],
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      readConversationTelemetry,
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

    expect(readConversationTelemetry).toHaveBeenCalledWith("conversation-1");
    const telemetry = iterationCalls.find(
      (call) => call.event === "conversation.telemetry",
    );
    expect(telemetry).toBeDefined();
    expect(telemetry?.data).toMatchObject({
      conversationId: "conversation-1",
      costUsd: 23.5,
      apiTurns: 137,
      lineageCount: 1,
      reads: { uniqueFiles: 3, totalReads: 6, repeatReads: 3 },
      topReReads: [{ path: "/repo/a.ts", count: 3 }],
    });
  });

  it("completes the iteration and emits no event when the telemetry reader fails", async () => {
    const { repository, runAgentIteration } = makeCompletingHarness();
    const { logger, iterationCalls } =
      createCapturingExecutionLogger("execution-1");
    registerExecutionLogger(logger);

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      readConversationTelemetry: vi
        .fn()
        .mockRejectedValue(new Error("transcript missing")),
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

    expect(
      iterationCalls.some((call) => call.event === "conversation.telemetry"),
    ).toBe(false);
    const completed = iterationCalls.find(
      (call) => call.event === "iteration.completed",
    );
    expect(completed).toBeDefined();
    expect(completed?.data).toMatchObject({ completedTaskCount: 2 });
  });
});

// -- per-turn billing telemetry on agent_turn_completed ------------------------

describe("per-turn billing on agent_turn_completed", () => {
  function createCapturingExecutionLogger(executionId: string): {
    logger: ExecutionLogger;
    iterationCalls: Array<{
      event: string;
      data: Record<string, unknown> | undefined;
    }>;
  } {
    const iterationCalls: Array<{
      event: string;
      data: Record<string, unknown> | undefined;
    }> = [];
    const logger: ExecutionLogger = {
      executionId,
      logDir: "/tmp/test-turn-billing",
      writeManifest() {},
      lifecycle() {},
      iteration(_contextId, event, data) {
        iterationCalls.push({ event, data });
      },
      task() {},
      validation() {},
      writePrompt() {},
      writeValidatorResponse() {},
      writeValidatorTranscript() {},
      decision() {},
    };
    return { logger, iterationCalls };
  }

  afterEach(() => {
    _resetRegistryForTesting();
  });

  it("emits cumulative cost and per-turn delta derived from conversation telemetry", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const { logger, iterationCalls } =
      createCapturingExecutionLogger("execution-1");
    registerExecutionLogger(logger);

    // Reads in call order: pre-turn baseline (reused conversation already at
    // $1.00), after turn 0 ($1.75), after the follow-up turn ($2.05), then the
    // iteration-completed telemetry read (clamped to the last value).
    const costReadings = [1.0, 1.75, 2.05];
    let readIndex = 0;
    const readConversationTelemetry = vi.fn(async () => ({
      costUsd: costReadings[Math.min(readIndex++, costReadings.length - 1)]!,
      apiTurns: 3,
      lineageCount: 1,
      reads: { uniqueFiles: 0, totalReads: 0, repeatReads: 0 },
      topReReads: [],
    }));

    let call = 0;
    const runAgentIteration = vi.fn(async () => {
      call += 1;
      const current = structuredClone(repository.read());
      current.taskStates["task-plan-1"] = {
        ...current.taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Done",
        completedAt: "2026-03-27T16:02:00.000Z",
      };
      if (call >= 2) {
        current.taskStates["task-plan-2"] = {
          ...current.taskStates["task-plan-2"]!,
          status: "completed",
          summary: "Done",
          completedAt: "2026-03-27T16:04:00.000Z",
        };
      }
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: call >= 2 ? 2 : 1,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      readConversationTelemetry,
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    const turnEvents = iterationCalls.filter(
      (c) => c.event === "iteration.agent_turn_completed",
    );
    expect(turnEvents).toHaveLength(2);
    const first = turnEvents[0]?.data as {
      cumulativeCostUsd: number | null;
      costUsdDelta: number | null;
    };
    expect(first.cumulativeCostUsd).toBeCloseTo(1.75);
    expect(first.costUsdDelta).toBeCloseTo(0.75);
    const second = turnEvents[1]?.data as {
      cumulativeCostUsd: number | null;
      costUsdDelta: number | null;
    };
    expect(second.cumulativeCostUsd).toBeCloseTo(2.05);
    expect(second.costUsdDelta).toBeCloseTo(0.3);
  });

  it("emits null billing fields when telemetry is unavailable", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const { logger, iterationCalls } =
      createCapturingExecutionLogger("execution-1");
    registerExecutionLogger(logger);

    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      for (const taskId of ["task-plan-1", "task-plan-2"]) {
        current.taskStates[taskId] = {
          ...current.taskStates[taskId]!,
          status: "completed",
          summary: "Done",
          completedAt: "2026-03-27T16:02:00.000Z",
        };
      }
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    const turnEvents = iterationCalls.filter(
      (c) => c.event === "iteration.agent_turn_completed",
    );
    expect(turnEvents).toHaveLength(1);
    expect(turnEvents[0]?.data).toMatchObject({
      cumulativeCostUsd: null,
      costUsdDelta: null,
    });
    // No window max reported (codex-style cumulative counter): the record
    // must say so explicitly, so audits stop dividing cumulative counters.
    expect(turnEvents[0]?.data).toMatchObject({ occupancyMeasurable: false });
  });

  it("marks occupancy measurable when the backend reports a context window max", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const { logger, iterationCalls } =
      createCapturingExecutionLogger("execution-1");
    registerExecutionLogger(logger);

    const runAgentIteration = vi.fn(async () => {
      const current = structuredClone(repository.read());
      for (const taskId of ["task-plan-1", "task-plan-2"]) {
        current.taskStates[taskId] = {
          ...current.taskStates[taskId]!,
          status: "completed",
          summary: "Done",
          completedAt: "2026-03-27T16:02:00.000Z",
        };
      }
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-1",
        contextTokens: 120000,
        contextWindowMax: 200000,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-1" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    const turnEvents = iterationCalls.filter(
      (c) => c.event === "iteration.agent_turn_completed",
    );
    expect(turnEvents[0]?.data).toMatchObject({
      contextTokens: 120000,
      contextWindowMax: 200000,
      occupancyMeasurable: true,
    });
  });
});

describe("context output capture (D2)", () => {
  const NOW = "2026-03-27T16:10:00.000Z";

  const PLAN_OUTPUT_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
      summary: { type: "string" },
      risks: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "risks"],
    additionalProperties: false,
  };

  function createExecutionWithOutputSchema(): GraphWorkflowExecution {
    const execution = createExecutionWithPlanTasks({
      "task-plan-1": "pending",
      "task-plan-2": "pending",
    });
    const planContext = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    );
    if (!planContext) throw new Error("fixture missing context-plan");
    planContext.outputSchema = PLAN_OUTPUT_SCHEMA;
    return execution;
  }

  function completeBothPlanTasks(repository: {
    read(): GraphWorkflowExecution;
    mutateActive(
      projectPath: string,
      sessionName: string,
      fn: (
        execution: GraphWorkflowExecution,
      ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
    ): Promise<GraphWorkflowExecution>;
  }) {
    return vi.fn(async () => {
      const current = structuredClone(repository.read());
      for (const taskId of ["task-plan-1", "task-plan-2"]) {
        current.taskStates[taskId] = {
          ...current.taskStates[taskId]!,
          status: "completed",
          summary: "Done",
          completedAt: NOW,
        };
      }
      current.contextStates["context-plan"] = {
        ...current.contextStates["context-plan"]!,
        completedTaskCount: 2,
      };
      await repository.mutateActive("/repo", "session-1", () => current);
      return {
        conversationId: "conversation-capture",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });
  }

  function passingValidation() {
    return {
      validateContextCompletion: vi.fn(async () => ({
        kind: "pass" as const,
        summary: "All checks passed",
        feedback: "Context validation passed.",
        issues: [] as never[],
        reopenTaskIds: [],
        sessionRef: null,
        reviewArtifact: null,
      })),
    };
  }

  it("captures a schema-declaring context's output before the context transitions to completed", async () => {
    const repository = createRepository(createExecutionWithOutputSchema());

    let statusDuringCapture: string | null = null;
    const captureContextOutput = vi.fn(async () => {
      statusDuringCapture =
        repository.read().contextStates["context-plan"]?.status ?? null;
      return {
        kind: "captured" as const,
        value: { summary: "Plan is ready", risks: ["schema drift"] },
        parse: { source: "raw_json" as const },
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-capture" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeBothPlanTasks(repository),
      validationService: passingValidation(),
      outputCaptureService: { captureContextOutput },
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(captureContextOutput).toHaveBeenCalledTimes(1);
    // The exit evaluator treats "all tasks done, no output yet" as not-yet-
    // complete: the format turn runs while the context is still running.
    expect(statusDuringCapture).toBe("running");

    const persisted = repository.read();
    expect(persisted.contextStates["context-plan"]?.status).toBe("completed");
    expect(result.shouldContinueInContext).toBe(false);

    const captured = persisted.contextOutputs["context-plan"];
    expect(captured).toBeDefined();
    expect(captured?.value).toEqual({
      summary: "Plan is ready",
      risks: ["schema drift"],
    });
    expect(captured?.parse).toEqual({ source: "raw_json" });
    expect(captured?.capturedAt).toBe(NOW);
    expect(captured?.iteration).toBeGreaterThanOrEqual(1);
    expect(
      validateJsonSchemaSubset(PLAN_OUTPUT_SCHEMA, captured?.value).valid,
    ).toBe(true);
  });

  it("does not dispatch a format turn for a context without an outputSchema", async () => {
    const repository = createRepository(
      createExecutionWithPlanTasks({
        "task-plan-1": "pending",
        "task-plan-2": "pending",
      }),
    );
    const captureContextOutput = vi.fn();

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-capture" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeBothPlanTasks(repository),
      validationService: passingValidation(),
      outputCaptureService: { captureContextOutput },
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(captureContextOutput).not.toHaveBeenCalled();
    const persisted = repository.read();
    expect(persisted.contextStates["context-plan"]?.status).toBe("completed");
    expect(persisted.contextOutputs).toEqual({});
  });

  /** A payload the gate refuses no matter how many times the turn is retried. */
  function rejectedCapture() {
    return {
      kind: "rejected" as const,
      summary: "Output did not satisfy the declared outputSchema",
      issues: [
        {
          title: "$.risks",
          description: "expected array, received string",
          path: "$.risks",
        },
        {
          title: "$.owner",
          description: "additional property is not allowed",
          path: "$.owner",
        },
      ],
      rejectedText: '{"summary":"Plan is ready","risks":"drift","owner":"me"}',
    };
  }

  /**
   * Production-shaped halt signal (`graph-workflow-signal-halt.ts`): it records
   * a PENDING halt reason and marks the context halted, but deliberately leaves
   * `execution.status` on `"running"` — the loop owner promotes the pending
   * reason later. A fake that flips the execution to `halted` here would hide
   * every code path that only guards on execution status.
   */
  function haltRecordingSignalHalt(repository: {
    read(): GraphWorkflowExecution;
    mutateActive(
      projectPath: string,
      sessionName: string,
      fn: (
        execution: GraphWorkflowExecution,
      ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
    ): Promise<GraphWorkflowExecution>;
  }) {
    return vi.fn(
      async (input: {
        projectPath: string;
        sessionName: string;
        contextId?: string;
        reason: unknown;
      }) => {
        const reason = input.reason as NonNullable<
          GraphWorkflowExecution["haltReason"]
        >;
        const contextId =
          input.contextId ??
          ("contextId" in reason ? (reason.contextId ?? undefined) : undefined);
        return repository.mutateActive("/repo", "session-1", (latest) => {
          const next = structuredClone(latest);
          next.pendingHaltReason = reason;
          if (contextId) {
            const contextState = next.contextStates[contextId];
            if (contextState && contextState.status !== "completed") {
              contextState.status = "halted";
            }
            next.activeContextIds = next.activeContextIds.filter(
              (activeContextId) => activeContextId !== contextId,
            );
          }
          return next;
        });
      },
    );
  }

  it("records an output_schema validation failure and leaves the context uncompleted when the gate refuses the format turn (R3.1)", async () => {
    const repository = createRepository(createExecutionWithOutputSchema());
    const captureContextOutput = vi.fn(async () => rejectedCapture());

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-capture" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeBothPlanTasks(repository),
      validationService: passingValidation(),
      outputCaptureService: { captureContextOutput },
      signalHalt: haltRecordingSignalHalt(repository),
      now: () => NOW,
    });

    const result = await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    const persisted = repository.read();
    // Tasks are all done and the context validator passed, yet the context is
    // NOT complete: a schema-declaring context needs a validated output.
    expect(persisted.contextStates["context-plan"]?.status).not.toBe(
      "completed",
    );
    expect(persisted.contextOutputs).toEqual({});
    expect(result.shouldContinueInContext).toBe(true);
    expect(persisted.status).toBe("running");

    const failure = repository.appendedEvents
      .map((entry) => entry.event)
      .find(
        (event) =>
          event.type === "graph-workflow-validation-result" &&
          event.kind === "output_schema",
      );
    expect(failure).toMatchObject({
      contextId: "context-plan",
      kind: "output_schema",
      pass: false,
      summary: "Output did not satisfy the declared outputSchema",
      // Issue titles are instance paths, and each carries the addressable
      // `path` D4 conditional edges will key off.
      issues: [
        {
          title: "$.risks",
          description: "expected array, received string",
          path: "$.risks",
        },
        {
          title: "$.owner",
          description: "additional property is not allowed",
          path: "$.owner",
        },
      ],
      // The refused candidate is kept for inspection here and ONLY here.
      rejectedOutput:
        '{"summary":"Plan is ready","risks":"drift","owner":"me"}',
    });

    // Same accounting the agent-validator failure path feeds.
    expect(
      persisted.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);
    // The seed increment plus the failed capture: a refused format turn is a
    // real agent turn, so it consumes an iteration slot.
    expect(persisted.contextStates["context-plan"]?.iterationCount).toBe(2);
  });

  it("trips the circuit breaker with the output_schema_validation condition when the capture keeps failing (R3.1)", async () => {
    const execution = createExecutionWithOutputSchema();
    const planContext = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    );
    if (!planContext) throw new Error("fixture missing context-plan");
    planContext.circuitBreaker = {
      ...planContext.circuitBreaker,
      consecutiveFailureThreshold: 1,
    };

    const repository = createRepository(execution);
    const captureContextOutput = vi.fn(async () => rejectedCapture());
    const signalHalt = haltRecordingSignalHalt(repository);

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-capture" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeBothPlanTasks(repository),
      validationService: passingValidation(),
      outputCaptureService: { captureContextOutput },
      signalHalt,
      now: () => NOW,
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
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "output_schema_validation",
          failureCount: 1,
          summary: "Output did not satisfy the declared outputSchema",
        }),
      }),
    );

    const persisted = repository.read();
    // Production signal-halt records a PENDING reason and leaves the execution
    // `running`, so the halted context must not slip through the finalizer's
    // completion branch on the way out of the iteration.
    expect(persisted.pendingHaltReason).toMatchObject({
      type: "circuit_breaker",
      condition: "output_schema_validation",
    });
    expect(persisted.contextStates["context-plan"]?.status).toBe("halted");
    expect(persisted.contextOutputs).toEqual({});
    expect(persisted.activeContextIds).not.toContain("context-plan");
    expect(result.shouldContinueInContext).toBe(false);
  });

  it("accumulates capture failures to the DEFAULT breaker threshold even though the context validator passes on every retry (R3.1)", async () => {
    // No threshold override: the fixture's `circuitBreaker: {}` resolves to
    // DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD (3). A passing context validator
    // runs ahead of every capture retry, and if its pass cleared the counter
    // the run would read 1,1,1 forever and never trip.
    const repository = createRepository(createExecutionWithOutputSchema());
    const captureContextOutput = vi.fn(async () => rejectedCapture());
    const signalHalt = haltRecordingSignalHalt(repository);
    const validationService = passingValidation();

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-capture" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeBothPlanTasks(repository),
      validationService,
      outputCaptureService: { captureContextOutput },
      signalHalt,
      now: () => NOW,
    });

    const input = {
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    };

    await orchestrator.runIteration(input);
    expect(
      repository.read().contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);

    await orchestrator.runIteration(input);
    // The validator passed again between the two captures; the counter must
    // still carry the first failure forward.
    expect(
      repository.read().contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(2);
    expect(signalHalt).not.toHaveBeenCalled();

    await orchestrator.runIteration(input);

    expect(validationService.validateContextCompletion).toHaveBeenCalledTimes(
      3,
    );
    expect(signalHalt).toHaveBeenCalledTimes(1);
    expect(signalHalt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.objectContaining({
          type: "circuit_breaker",
          condition: "output_schema_validation",
          failureCount: 3,
        }),
      }),
    );
    const persisted = repository.read();
    expect(persisted.contextStates["context-plan"]?.status).toBe("halted");
    expect(persisted.contextOutputs).toEqual({});
  });

  it("does not complete a schema-declaring context whose capture halted the iteration (R2.1, R3.1)", async () => {
    const execution = createExecutionWithOutputSchema();
    const planContext = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    );
    if (!planContext) throw new Error("fixture missing context-plan");
    planContext.circuitBreaker = {
      ...planContext.circuitBreaker,
      consecutiveFailureThreshold: 1,
    };

    const repository = createRepository(execution);
    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-capture" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeBothPlanTasks(repository),
      validationService: passingValidation(),
      outputCaptureService: {
        captureContextOutput: vi.fn(async () => rejectedCapture()),
      },
      signalHalt: haltRecordingSignalHalt(repository),
      now: () => NOW,
    });

    // Every task is complete and the validator passed, so the finalizer's
    // no-remaining-tasks branch is exactly the path that would otherwise write
    // `completed` over the halt — with no output ever captured.
    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    const persisted = repository.read();
    expect(persisted.contextStates["context-plan"]?.status).not.toBe(
      "completed",
    );
    expect(persisted.contextOutputs["context-plan"]).toBeUndefined();
  });

  it("retries the capture with the previous rejection, and completes once the gate accepts (R3.1)", async () => {
    const repository = createRepository(createExecutionWithOutputSchema());

    const captureContextOutput = vi
      .fn<
        (input: {
          previousRejection?: {
            summary: string;
            issues: readonly GraphWorkflowValidationIssue[];
          };
        }) => Promise<GraphWorkflowContextOutputCaptureOutcome>
      >()
      .mockImplementationOnce(async () => rejectedCapture())
      .mockImplementationOnce(async () => ({
        kind: "captured" as const,
        value: { summary: "Plan is ready", risks: ["schema drift"] },
        parse: { source: "raw_json" as const },
      }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-capture" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeBothPlanTasks(repository),
      validationService: passingValidation(),
      outputCaptureService: { captureContextOutput },
      signalHalt: haltRecordingSignalHalt(repository),
      now: () => NOW,
    });

    const input = {
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    };
    await orchestrator.runIteration(input);
    const second = await orchestrator.runIteration(input);

    expect(captureContextOutput).toHaveBeenCalledTimes(2);
    // The retry turn is told what the gate refused rather than guessing.
    expect(captureContextOutput.mock.calls[1]?.[0]).toMatchObject({
      previousRejection: {
        summary: "Output did not satisfy the declared outputSchema",
        issues: [{ path: "$.risks" }, { path: "$.owner" }],
      },
    });

    const persisted = repository.read();
    expect(persisted.contextStates["context-plan"]?.status).toBe("completed");
    expect(persisted.contextOutputs["context-plan"]?.value).toEqual({
      summary: "Plan is ready",
      risks: ["schema drift"],
    });
    expect(second.shouldContinueInContext).toBe(false);
  });

  /** Every plan task already finished in a previous iteration, so `runIteration`
   *  takes the validation-only path and never resolves an implementer lane. */
  function executionWithAllPlanTasksComplete(): GraphWorkflowExecution {
    const execution = createExecutionWithOutputSchema();
    for (const taskId of ["task-plan-1", "task-plan-2"]) {
      execution.taskStates[taskId] = {
        ...execution.taskStates[taskId]!,
        status: "completed",
        summary: "Done",
        completedAt: NOW,
        lastConversationId: "conv-stale-task",
      };
    }
    execution.contextStates["context-plan"] = {
      ...execution.contextStates["context-plan"]!,
      completedTaskCount: 2,
      iterationCount: 1,
    };
    return execution;
  }

  function implementerLaneState(
    conversationId: string,
  ): GraphWorkflowAgentSessionState {
    return {
      backend: "claude",
      refKind: "conversation",
      lane: "implementer",
      contextId: "context-plan",
      workflowConversationId: conversationId,
      sessionRef: { backend: "claude", ref: conversationId },
      metrics: { rotateBeforeNextTurn: false },
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };
  }

  it("dispatches the format turn on the durable implementer lane conversation, not a stale task conversation (R2.1)", async () => {
    const execution = executionWithAllPlanTasksComplete();
    execution.laneStates["context-plan"] = {
      implementer: implementerLaneState("conv-implementer-live"),
    };

    const repository = createRepository(execution);
    const captureContextOutput = vi.fn(async () => ({
      kind: "captured" as const,
      value: { summary: "Plan is ready", risks: [] },
      parse: { source: "raw_json" as const },
    }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conv-should-not-create" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: vi.fn(),
      validationService: passingValidation(),
      outputCaptureService: { captureContextOutput },
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    // The validation-only path picks a HISTORICAL task conversation (or the
    // literal "validation-only") for its own bookkeeping. The format turn must
    // not inherit it: the lane conversation is the one that holds the work, and
    // a synthetic id would be rejected as a nonexistent conversation.
    expect(captureContextOutput).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-implementer-live" }),
    );
  });

  it("creates an implementer conversation for the format turn when the context never opened one (R2.1)", async () => {
    // A zero-task schema context: valid, and it reaches capture with no lane
    // state at all, so there is no existing conversation to restate work into.
    const execution = createExecutionWithOutputSchema();
    execution.workingDefinition = {
      ...execution.workingDefinition,
      tasks: execution.workingDefinition.tasks.filter(
        (task) => task.contextId !== "context-plan",
      ),
    };
    execution.taskStates = {};
    execution.contextStates["context-plan"] = {
      ...execution.contextStates["context-plan"]!,
      totalTaskCount: 0,
      completedTaskCount: 0,
    };

    const repository = createRepository(execution);
    const captureContextOutput = vi.fn(async () => ({
      kind: "captured" as const,
      value: { summary: "Nothing to plan", risks: [] },
      parse: { source: "raw_json" as const },
    }));
    const createConversation = vi.fn(async () => ({ id: "conv-created" }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: vi.fn(),
      validationService: passingValidation(),
      outputCaptureService: { captureContextOutput },
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(createConversation).toHaveBeenCalled();
    expect(captureContextOutput).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-created" }),
    );
  });

  it("creates that conversation for the context's OWN backend, not the service default (R2.1)", async () => {
    // The conversation service defaults a new conversation to Claude. A
    // zero-task context configured for Codex would then run its format turn on
    // Claude while being handed Codex model/effort/timeout settings — a turn
    // dispatched to the wrong backend entirely.
    const execution = createExecutionWithOutputSchema();
    execution.workingDefinition = {
      ...execution.workingDefinition,
      tasks: execution.workingDefinition.tasks.filter(
        (task) => task.contextId !== "context-plan",
      ),
    };
    execution.taskStates = {};
    execution.contextStates["context-plan"] = {
      ...execution.contextStates["context-plan"]!,
      totalTaskCount: 0,
      completedTaskCount: 0,
    };
    const planContext = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    );
    if (!planContext) throw new Error("fixture missing context-plan");
    planContext.implementer = {
      ...planContext.implementer,
      agent: {
        ...planContext.implementer.agent,
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
    };

    const repository = createRepository(execution);
    const createConversation = vi.fn(async () => ({ id: "conv-created" }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation,
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: vi.fn(),
      validationService: passingValidation(),
      outputCaptureService: {
        captureContextOutput: vi.fn(async () => ({
          kind: "captured" as const,
          value: { summary: "Nothing to plan", risks: [] },
          parse: { source: "raw_json" as const },
        })),
      },
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    });

    expect(createConversation).toHaveBeenCalledWith(
      "/repo",
      "session-1",
      expect.objectContaining({ role: "iteration", agentBackend: "codex" }),
    );
  });

  it("persists exactly the failure count the breaker halted on, with no finalize double-count (R3.1)", async () => {
    // The capture path increments and then throws IterationHaltedError, which
    // both iteration loops swallow before finalizing. If finalize counts that
    // swallowed halt as a fresh failure too, the halt reason says 3 while state
    // says 4 — the operator and the breaker disagree about the same run.
    const repository = createRepository(createExecutionWithOutputSchema());
    const signalHalt = haltRecordingSignalHalt(repository);

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-capture" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeBothPlanTasks(repository),
      validationService: passingValidation(),
      outputCaptureService: {
        captureContextOutput: vi.fn(async () => rejectedCapture()),
      },
      signalHalt,
      now: () => NOW,
    });

    const input = {
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    };
    await orchestrator.runIteration(input);
    await orchestrator.runIteration(input);
    await orchestrator.runIteration(input);

    const haltCall = signalHalt.mock.calls[0]?.[0] as
      | { reason: { failureCount?: number } }
      | undefined;
    expect(haltCall?.reason.failureCount).toBe(3);
    expect(
      repository.read().contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(3);
  });

  it("clears the failure streak once a capture is accepted (R3.1)", async () => {
    // The streak means "consecutive failures with no success in between". A
    // capture that the gate accepts IS that success, so a context that later
    // re-enters work (a rejected approval adds remediation tasks) must not
    // start out already part-way to a breaker trip.
    const repository = createRepository(createExecutionWithOutputSchema());
    const captureContextOutput = vi
      .fn<() => Promise<GraphWorkflowContextOutputCaptureOutcome>>()
      .mockImplementationOnce(async () => rejectedCapture())
      .mockImplementationOnce(async () => ({
        kind: "captured" as const,
        value: { summary: "Plan is ready", risks: ["schema drift"] },
        parse: { source: "raw_json" as const },
      }));

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-capture" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: completeBothPlanTasks(repository),
      validationService: passingValidation(),
      outputCaptureService: { captureContextOutput },
      signalHalt: haltRecordingSignalHalt(repository),
      now: () => NOW,
    });

    const input = {
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-plan",
    };
    await orchestrator.runIteration(input);
    expect(
      repository.read().contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(1);

    await orchestrator.runIteration(input);

    const persisted = repository.read();
    expect(persisted.contextStates["context-plan"]?.status).toBe("completed");
    expect(
      persisted.contextStates["context-plan"]?.consecutiveFailureCount,
    ).toBe(0);
  });

  it("injects an upstream context's captured output into the downstream seed prompt (R5.1, R5.2)", async () => {
    const execution = createExecutionWithOutputSchema();
    execution.activeContextIds = ["context-implement"];
    execution.contextStates["context-plan"] = {
      ...execution.contextStates["context-plan"]!,
      status: "completed",
    };
    execution.contextOutputs = {
      "context-plan": {
        value: { summary: "Migrate the store first", risks: ["schema drift"] },
        capturedAt: NOW,
        iteration: 1,
        parse: { source: "raw_json" },
      },
    };

    const repository = createRepository(execution);
    let seedPrompt: string | null = null;
    const runAgentIteration = vi.fn(async (agentInput: { prompt: string }) => {
      // Only the FIRST call is the seed; later calls are follow-up prompts.
      seedPrompt ??= agentInput.prompt;
      return {
        conversationId: "conversation-implement",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-implement" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration,
      validationService: passingValidation(),
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      // Direct successor of context-plan in the fixture graph.
      contextId: "context-implement",
    });

    expect(seedPrompt).not.toBeNull();
    const prompt = seedPrompt ?? "";
    expect(prompt).toContain("## Inputs from upstream");
    expect(prompt).toContain("### context-plan — Plan");
    expect(prompt).toContain('"Migrate the store first"');
    // Rendered from the declared schema, so the downstream agent can address it.
    expect(prompt).toContain("`risks`");
  });

  it("renders no upstream section for a context whose predecessor produced nothing (R5.1)", async () => {
    const execution = createExecutionWithOutputSchema();
    execution.activeContextIds = ["context-implement"];

    const repository = createRepository(execution);
    let seedPrompt: string | null = null;

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: repository,
      findLatestContextValidationEvent:
        repository.findLatestContextValidationEvent,
      createConversation: vi.fn(async () => ({ id: "conversation-implement" })),
      createToolServer: vi.fn(() => ({ server: {} })),
      runAgentIteration: vi.fn(async (agentInput: { prompt: string }) => {
        seedPrompt ??= agentInput.prompt;
        return {
          conversationId: "conversation-implement",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      }),
      validationService: passingValidation(),
      now: () => NOW,
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-implement",
    });

    expect(seedPrompt ?? "").not.toContain("## Inputs from upstream");
  });
});
