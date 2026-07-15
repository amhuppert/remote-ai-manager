import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskQuestionAnswer } from "@/lib/conversations/schemas";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowPendingUserInput,
} from "@/lib/workflow-graph/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { _resetRegistryForTesting } from "./execution-logger";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import {
  createGraphWorkflowExecutionLoop,
  _resetActiveLoopsForTesting,
  type GraphWorkflowExecutionLoopDeps,
  type GraphWorkflowExecutionLoopWorkflowManager,
} from "./execution-loop";
import type { GraphWorkflowIterationResult } from "./iteration-orchestrator";
import { createWorkflowExecution } from "./test-fixtures";
import {
  createUserInputGateService,
  type UserInputGateService,
} from "./user-input-gate";

/**
 * Task 6.2 — Prove the awaiting-user-input lifecycle and its edge flows against
 * REAL persistence. Every scenario drives the genuine execution loop
 * (`createGraphWorkflowExecutionLoop`) and the genuine user-input gate
 * (`createUserInputGateService`) over a `createPersistenceFixture` SQLite store,
 * with the loop's workflow manager reading and writing through a real
 * `createGraphWorkflowExecutionRepository`. Assertions are made on state
 * reloaded from the store, so the durability of the parked record across a
 * restart-shaped reload, the completion guard, concurrent independent parks,
 * the paused-answer immediate apply, and the abort withdrawal are all proven
 * against real serialization — not an in-memory object.
 */

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";
const NOW = "2026-07-03T21:00:00.000Z";

const QUESTIONS = [
  {
    id: "q1",
    question: "Which approach?",
    options: [
      { label: "A", recommended: false },
      { label: "B", recommended: false },
    ],
    multiSelect: false,
    required: true,
    allowNote: true,
  },
];

function makeAnswers(): Record<string, AskQuestionAnswer> {
  return {
    q1: {
      selected: ["A"],
      note: null,
      skipped: false,
      question: "Which approach?",
    },
  };
}

function parkedRecord(conversationId: string): GraphWorkflowPendingUserInput {
  return {
    conversationId,
    lane: "implementer",
    questionBatchId: `batch-${conversationId}`,
    questions: structuredClone(QUESTIONS),
    requestedAt: "2026-07-03T20:59:00.000Z",
    answers: null,
  };
}

/**
 * A running execution reduced to `contextIds` independent contexts (no edges,
 * one task each) so a resumed context completing does not schedule a downstream
 * context. Each named context is flipped to `awaiting_user_input` with a parked
 * record on the conversation `conv-<contextId>`.
 */
function buildParkedExecution(input: {
  contextIds: string[];
  parked: string[];
  withAnswers?: Record<string, Record<string, AskQuestionAnswer>>;
}): GraphWorkflowExecution {
  const execution = createWorkflowExecution();
  const keep = new Set(input.contextIds);
  const taskIdFor = (contextId: string) => `task-${contextId}`;

  execution.workingDefinition.executionContexts =
    execution.workingDefinition.executionContexts
      .filter((ctx) => keep.has(ctx.id))
      .map((ctx) => ({ ...ctx, askUserQuestions: { enabled: true } }));
  execution.workingDefinition.edges = [];
  execution.workingDefinition.tasks = input.contextIds.map((contextId) => ({
    id: taskIdFor(contextId),
    contextId,
    order: 1,
    title: `Task for ${contextId}`,
    instructions: "Do the thing.",
    source: "user",
  }));

  const baseContext = execution.contextStates["context-plan"]!;
  const baseTask = execution.taskStates["task-plan-1"]!;
  execution.contextStates = {};
  execution.taskStates = {};
  for (const contextId of input.contextIds) {
    const isParked = input.parked.includes(contextId);
    const conversationId = `conv-${contextId}`;
    const record = isParked ? parkedRecord(conversationId) : null;
    if (record && input.withAnswers?.[contextId]) {
      record.answers = {
        byQuestionId: input.withAnswers[contextId]!,
        answeredAt: "2026-07-03T20:59:30.000Z",
      };
    }
    execution.contextStates[contextId] = {
      ...structuredClone(baseContext),
      contextId,
      status: isParked ? "awaiting_user_input" : "pending",
      totalTaskCount: 1,
      completedTaskCount: 0,
      iterationCount: isParked ? 1 : 0,
      consecutiveFailureCount: 0,
      pendingUserInput: record,
    };
    execution.taskStates[taskIdFor(contextId)] = {
      ...structuredClone(baseTask),
      taskId: taskIdFor(contextId),
      contextId,
      status: "pending",
    };
  }

  execution.status = "running";
  execution.activeContextIds = [];
  execution.laneStates = {};
  return execution;
}

describe("user-input lifecycle against real persistence (task 6.2)", () => {
  let fixture: PersistenceFixture;
  let broadcasted: GraphWorkflowSSEEvent[];
  let clearedConversations: string[];

  beforeEach(() => {
    _resetRegistryForTesting();
    _resetActiveLoopsForTesting();
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    broadcasted = [];
    clearedConversations = [];
  });

  afterEach(() => {
    fixture.close();
    _resetActiveLoopsForTesting();
    _resetRegistryForTesting();
  });

  function buildEventPublisher() {
    return createGraphWorkflowExecutionEventPublisher({
      broadcast: (event) => {
        broadcasted.push(event);
      },
      now: () => NOW,
    });
  }

  function buildRepository(
    eventPublisher: ReturnType<
      typeof createGraphWorkflowExecutionEventPublisher
    >,
  ) {
    return createGraphWorkflowExecutionRepository({
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,
      markGraphWorkflowContextEventsPreReset:
        fixture.store.markGraphWorkflowContextEventsPreReset,
      eventPublisher,
    });
  }

  function buildGate(
    repository: ReturnType<typeof buildRepository>,
    eventPublisher: ReturnType<
      typeof createGraphWorkflowExecutionEventPublisher
    >,
  ): UserInputGateService {
    return createUserInputGateService({
      getActive: repository.getActive,
      mutateActive: repository.mutateActive,
      publishUserInputPending: eventPublisher.publishUserInputPending,
      publishUserInputResolved: eventPublisher.publishUserInputResolved,
      sendConversationEvent: (_p, _s, conversationId, event) => {
        if (event.type === "CLEAR_PENDING_QUESTION") {
          clearedConversations.push(conversationId);
        }
        return true;
      },
      now: () => NOW,
    });
  }

  /** Persist an execution as the session's active execution (seed step). */
  async function seedExecution(execution: GraphWorkflowExecution) {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedExecution",
      async () => ({ execution, events: [] }),
    );
  }

  async function reload(): Promise<GraphWorkflowExecution> {
    const execution = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    if (!execution) throw new Error("execution missing after reload");
    return execution;
  }

  /**
   * A workflow manager whose state seam is the real execution repository, so the
   * loop's reads (`getActive`) and writes (`mutateActive`, `send`) round-trip
   * through SQLite. `scheduleEligibleContexts` is controlled per test.
   */
  function buildLoopDeps(input: {
    repository: ReturnType<typeof buildRepository>;
    eventPublisher: ReturnType<
      typeof createGraphWorkflowExecutionEventPublisher
    >;
    gate: UserInputGateService;
    iterationOrchestrator: GraphWorkflowExecutionLoopDeps["iterationOrchestrator"];
    waitForUserInputProgress: GraphWorkflowExecutionLoopDeps["waitForUserInputProgress"];
  }): GraphWorkflowExecutionLoopDeps {
    const { repository } = input;
    const workflowManager: GraphWorkflowExecutionLoopWorkflowManager = {
      scheduleEligibleContexts: async () => ({
        execution: (await repository.getActive(PROJECT_PATH, SESSION_NAME))!,
        scheduled: { kind: "none" },
      }),
      send: async (projectPath, sessionName) =>
        repository.mutateActive(projectPath, sessionName, (execution) => ({
          ...execution,
          status: "completed",
          completedAt: NOW,
        })),
      recordPendingHaltReason: async ({ projectPath, sessionName, reason }) => {
        const execution = await repository.mutateActive(
          projectPath,
          sessionName,
          (current) => ({ ...current, pendingHaltReason: reason }),
        );
        return { execution, accepted: true };
      },
      drainAndHalt: async ({ projectPath, sessionName }) =>
        repository.mutateActive(projectPath, sessionName, (execution) => ({
          ...execution,
          status: "halted",
          haltReason: execution.pendingHaltReason,
          pendingHaltReason: null,
          completedAt: NOW,
        })),
      mutateActive: repository.mutateActive,
      getActive: repository.getActive,
    };

    const sessionTarget: ExecutionTarget = {
      worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
      branchName: `csm/${SESSION_NAME}`,
      isolation: "session",
      laneId: null,
    };

    return {
      workflowManager,
      iterationOrchestrator: input.iterationOrchestrator,
      parallelWorktrees: {
        provision: vi.fn(),
        provisionBatch: vi.fn(),
        dispose: vi.fn(),
        provisionLane: vi.fn(),
        provisionLaneBatch: vi.fn(),
        disposeLane: vi.fn(),
        cleanupLane: vi.fn(async () => ({ status: "removed" as const })),
      },
      mergeMutex: { withMergeMutex: async (_k, fn) => fn() },
      sessionGitLock: { withSessionGitLock: async (_k, fn) => fn() },
      mergeRunner: { run: vi.fn() },
      soloContextCommitter: { commit: async () => ({ status: "skipped" }) },
      laneCommitter: { commit: async () => ({ status: "skipped" }) },
      joinRunner: { run: vi.fn() },
      executionTargetResolver: { resolve: () => sessionTarget },
      getSession: fixture.store.getSession,
      waitForUserInputProgress: input.waitForUserInputProgress,
      userInputGateService: input.gate,
      eventPublisher: input.eventPublisher,
      getMaxConcurrentQueries: async () => 999,
    };
  }

  /** Records answers through the gate on the first poll (mirrors the answer route). */
  function answerOnFirstPoll(
    gate: UserInputGateService,
    conversationId: string,
  ) {
    let polls = 0;
    const fn = vi.fn(async () => {
      polls += 1;
      if (polls === 1) {
        await gate.recordAnswers({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          conversationId,
          questionBatchId: `batch-${conversationId}`,
          answers: makeAnswers(),
        });
      }
    });
    return fn;
  }

  /** Iteration orchestrator stub that completes the resumed context. */
  function completingOrchestrator(): GraphWorkflowExecutionLoopDeps["iterationOrchestrator"] {
    return {
      async runIteration(runInput): Promise<GraphWorkflowIterationResult> {
        const execution = await fixtureRepoMutateComplete(runInput.contextId);
        return {
          conversationId: `conv-${runInput.contextId}`,
          execution,
          shouldContinueInContext: false,
        };
      },
    };
  }

  async function fixtureRepoMutateComplete(
    contextId: string,
  ): Promise<GraphWorkflowExecution> {
    return fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.completeContext",
      async (current) => {
        const next = structuredClone(current!);
        const cs = next.contextStates[contextId]!;
        cs.iterationCount += 1;
        cs.completedTaskCount = 1;
        cs.status = "completed";
        next.taskStates[`task-${contextId}`]!.status = "completed";
        next.activeContextIds = next.activeContextIds.filter(
          (id) => id !== contextId,
        );
        return { execution: next, events: [] };
      },
    );
  }

  it("restores a parked execution from the store, re-enters the wait, and resumes on answer (Req 7.1, 7.2)", async () => {
    const eventPublisher = buildEventPublisher();
    const repository = buildRepository(eventPublisher);
    const gate = buildGate(repository, eventPublisher);
    const seeded = buildParkedExecution({
      contextIds: ["context-plan"],
      parked: ["context-plan"],
    });
    await seedExecution(seeded);

    // Restart-shaped reload: the parked record + status survive the round-trip.
    const restored = await reload();
    expect(restored.contextStates["context-plan"]?.status).toBe(
      "awaiting_user_input",
    );
    expect(
      restored.contextStates["context-plan"]?.pendingUserInput,
    ).toMatchObject({
      conversationId: "conv-context-plan",
      questionBatchId: "batch-conv-context-plan",
      questions: QUESTIONS,
      answers: null,
    });

    const waitForUserInputProgress = answerOnFirstPoll(
      gate,
      "conv-context-plan",
    );
    const deps = buildLoopDeps({
      repository,
      eventPublisher,
      gate,
      iterationOrchestrator: completingOrchestrator(),
      waitForUserInputProgress,
    });

    const loop = createGraphWorkflowExecutionLoop(deps);
    const result = await loop.run({
      projectPath: PROJECT_PATH,
      projectName: "repo",
      sessionName: SESSION_NAME,
      execution: restored,
    });

    // The loop re-entered the wait (polled), then consumed + resumed + completed.
    expect(waitForUserInputProgress).toHaveBeenCalled();
    expect(result.status).toBe("completed");

    const finalState = await reload();
    expect(finalState.contextStates["context-plan"]?.status).toBe("completed");
    expect(
      finalState.contextStates["context-plan"]?.pendingUserInput,
    ).toBeNull();
  });

  it("applies answers recorded while paused immediately on re-entry without re-waiting (Req 7.1, 7.3)", async () => {
    const eventPublisher = buildEventPublisher();
    const repository = buildRepository(eventPublisher);
    const gate = buildGate(repository, eventPublisher);
    await seedExecution(
      buildParkedExecution({
        contextIds: ["context-plan"],
        parked: ["context-plan"],
        withAnswers: { "context-plan": makeAnswers() },
      }),
    );

    const waitForUserInputProgress = vi.fn(async () => {});
    const deps = buildLoopDeps({
      repository,
      eventPublisher,
      gate,
      iterationOrchestrator: completingOrchestrator(),
      waitForUserInputProgress,
    });

    const loop = createGraphWorkflowExecutionLoop(deps);
    const result = await loop.run({
      projectPath: PROJECT_PATH,
      projectName: "repo",
      sessionName: SESSION_NAME,
      execution: await reload(),
    });

    // Answers already present → the wait short-circuits with no poll.
    expect(waitForUserInputProgress).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    const finalState = await reload();
    expect(
      finalState.contextStates["context-plan"]?.pendingUserInput,
    ).toBeNull();
    expect(finalState.contextStates["context-plan"]?.status).toBe("completed");
  });

  it("refuses to complete the execution while a context is parked (Req 3.5)", async () => {
    const eventPublisher = buildEventPublisher();
    const repository = buildRepository(eventPublisher);
    const gate = buildGate(repository, eventPublisher);
    await seedExecution(
      buildParkedExecution({
        contextIds: ["context-plan"],
        parked: ["context-plan"],
      }),
    );

    let signalPollStarted!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      signalPollStarted = resolve;
    });
    let releasePoll!: () => void;
    const pollRelease = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const waitForUserInputProgress = vi.fn(async () => {
      signalPollStarted();
      await pollRelease;
    });

    const deps = buildLoopDeps({
      repository,
      eventPublisher,
      gate,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("a parked context must not seed an iteration");
        },
      },
      waitForUserInputProgress,
    });

    const loop = createGraphWorkflowExecutionLoop(deps);
    const runPromise = loop.run({
      projectPath: PROJECT_PATH,
      projectName: "repo",
      sessionName: SESSION_NAME,
      execution: await reload(),
    });

    await pollStarted;
    const outcome = await Promise.race([
      runPromise.then(() => "settled" as const),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 40),
      ),
    ]);
    expect(outcome).toBe("pending");
    // The completion guard held: the execution never reached completed.
    expect((await reload()).status).toBe("running");

    // Unwind: abort in the store, release the poll, let the runner observe it.
    await repository.mutateActive(PROJECT_PATH, SESSION_NAME, (execution) => ({
      ...execution,
      status: "aborted",
    }));
    releasePoll();
    const result = await runPromise;
    expect(result.status).toBe("aborted");
  });

  it("parks two contexts concurrently and answers them independently (Req 3.6)", async () => {
    const eventPublisher = buildEventPublisher();
    const repository = buildRepository(eventPublisher);
    const gate = buildGate(repository, eventPublisher);
    await seedExecution(
      buildParkedExecution({
        contextIds: ["context-plan", "context-implement"],
        parked: ["context-plan", "context-implement"],
      }),
    );

    let releaseSecondPoll!: () => void;
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecondPoll = resolve;
    });
    const waitForUserInputProgress = vi.fn(
      async (input: { contextId: string }) => {
        if (input.contextId === "context-plan") {
          await gate.recordAnswers({
            projectPath: PROJECT_PATH,
            sessionName: SESSION_NAME,
            conversationId: "conv-context-plan",
            questionBatchId: "batch-conv-context-plan",
            answers: makeAnswers(),
          });
          return;
        }
        // context-implement is never answered → its runner keeps waiting.
        await secondBlocked;
      },
    );

    const resumed: string[] = [];
    const deps = buildLoopDeps({
      repository,
      eventPublisher,
      gate,
      iterationOrchestrator: {
        async runIteration(runInput): Promise<GraphWorkflowIterationResult> {
          resumed.push(runInput.contextId);
          const execution = await fixtureRepoMutateComplete(runInput.contextId);
          return {
            conversationId: `conv-${runInput.contextId}`,
            execution,
            shouldContinueInContext: false,
          };
        },
      },
      waitForUserInputProgress,
    });

    const loop = createGraphWorkflowExecutionLoop(deps);
    const runPromise = loop.run({
      projectPath: PROJECT_PATH,
      projectName: "repo",
      sessionName: SESSION_NAME,
      execution: await reload(),
    });

    const outcome = await Promise.race([
      runPromise.then(() => "settled" as const),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 50),
      ),
    ]);
    // context-implement stays parked → the loop never settles.
    expect(outcome).toBe("pending");
    expect(resumed).toEqual(["context-plan"]);

    const mid = await reload();
    expect(mid.contextStates["context-plan"]?.status).toBe("completed");
    expect(mid.contextStates["context-plan"]?.pendingUserInput).toBeNull();
    expect(mid.contextStates["context-implement"]?.status).toBe(
      "awaiting_user_input",
    );
    expect(
      mid.contextStates["context-implement"]?.pendingUserInput,
    ).not.toBeNull();

    // Unwind.
    await repository.mutateActive(PROJECT_PATH, SESSION_NAME, (execution) => ({
      ...execution,
      status: "aborted",
    }));
    releaseSecondPoll();
    const result = await runPromise;
    expect(result.status).toBe("aborted");
  });

  it("withdraws the parked question and clears the conversation marker on abort (Req 7.4)", async () => {
    const eventPublisher = buildEventPublisher();
    const repository = buildRepository(eventPublisher);
    const gate = buildGate(repository, eventPublisher);
    await seedExecution(
      buildParkedExecution({
        contextIds: ["context-plan"],
        parked: ["context-plan"],
      }),
    );

    let signalPollStarted!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      signalPollStarted = resolve;
    });
    let releasePoll!: () => void;
    const pollRelease = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const waitForUserInputProgress = vi.fn(async () => {
      signalPollStarted();
      await pollRelease;
    });

    const deps = buildLoopDeps({
      repository,
      eventPublisher,
      gate,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("a parked context must not seed an iteration");
        },
      },
      waitForUserInputProgress,
    });

    const loop = createGraphWorkflowExecutionLoop(deps);
    const runPromise = loop.run({
      projectPath: PROJECT_PATH,
      projectName: "repo",
      sessionName: SESSION_NAME,
      execution: await reload(),
    });

    await pollStarted;
    await repository.mutateActive(PROJECT_PATH, SESSION_NAME, (execution) => ({
      ...execution,
      status: "aborted",
    }));
    releasePoll();
    const result = await runPromise;
    expect(result.status).toBe("aborted");

    // The abort path withdrew the record, cleared the marker, published withdrawn.
    const finalState = await reload();
    expect(
      finalState.contextStates["context-plan"]?.pendingUserInput,
    ).toBeNull();
    expect(clearedConversations).toEqual(["conv-context-plan"]);
    expect(
      broadcasted.some(
        (e) =>
          e.type === "graph-workflow-user-input-resolved" &&
          e.resolution === "withdrawn",
      ),
    ).toBe(true);
  });

  it("skips the park when answers were already recorded (fast answer, Req 5.4)", async () => {
    const eventPublisher = buildEventPublisher();
    const repository = buildRepository(eventPublisher);
    const gate = buildGate(repository, eventPublisher);
    // A running (not-yet-parked) context whose lane holds a real conversation.
    const execution = buildParkedExecution({
      contextIds: ["context-plan"],
      parked: [],
    });
    execution.activeContextIds = ["context-plan"];
    execution.contextStates["context-plan"]!.status = "running";
    execution.laneStates = {
      "context-plan": {
        implementer: {
          lane: "implementer",
          contextId: "context-plan",
          backend: "claude",
          refKind: "conversation",
          workflowConversationId: "conv-fast",
          sessionRef: { backend: "claude", ref: "conv-fast" },
          metrics: { rotateBeforeNextTurn: false },
          limitEvaluation: "disabled",
          lastUsedAt: NOW,
        },
      },
    };
    await seedExecution(execution);

    // Answer arrives before the asking turn ends (upsert-before-park).
    const recorded = await gate.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: "conv-fast",
      questionBatchId: "batch-fast",
      answers: makeAnswers(),
    });
    expect(recorded).toEqual({ ok: true });

    // The post-turn park check hands off to the gate, which returns answers_ready
    // and never flips the context into awaiting_user_input.
    const outcome = await gate.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: "context-plan",
      lane: "implementer",
      conversationId: "conv-fast",
      questionBatchId: "batch-fast",
      questions: structuredClone(QUESTIONS),
    });

    expect(outcome).toBe("answers_ready");
    const finalState = await reload();
    expect(finalState.contextStates["context-plan"]?.status).toBe("running");
    expect(
      finalState.contextStates["context-plan"]?.pendingUserInput?.answers
        ?.byQuestionId,
    ).toEqual(makeAnswers());
  });
});
