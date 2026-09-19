import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AskQuestionAnswer,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowValidationRound,
} from "@/lib/workflow-graph/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { laneStateKey } from "./lane-identity";
import { createWorkflowExecution } from "./test-fixtures";
import {
  createUserInputGateService,
  type UserInputGateServiceDeps,
} from "./user-input-gate";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";
const IMPL_CONTEXT_ID = "context-implement";
const CONVERSATION_ID = "conv-user-input-1";
const QUESTION_BATCH_ID = "batch-1";
const NOW = "2026-07-03T10:00:00.000Z";

const SECURITY_KEY = laneStateKey("context_validator", "security-reviewer");
const PERF_KEY = laneStateKey("context_validator", "perf-reviewer");
const SECURITY_CONVERSATION = "conv-security";
const PERF_CONVERSATION = "conv-perf";
const ROUND_SEQ = 3;
/** A second context, reviewing its own candidate on its own round. */
const SIBLING_CONTEXT_ID = "context-plan";
const SIBLING_CONVERSATION = "conv-sibling-security";

function makeQuestions(): AskQuestionItem[] {
  return [
    {
      id: "q1",
      question: "Which database should the feature use?",
      options: [
        { label: "Postgres", recommended: false },
        { label: "SQLite", recommended: false },
      ],
      multiSelect: false,
      required: true,
      allowNote: true,
    },
  ];
}

function makeAnswers(): Record<string, AskQuestionAnswer> {
  return {
    q1: {
      selected: ["Postgres"],
      note: null,
      skipped: false,
      question: "Which database should the feature use?",
    },
  };
}

function claudeLaneState(input: {
  lane: "implementer" | "context_validator";
  contextId: string;
  conversationId: string;
}): GraphWorkflowAgentSessionState {
  return {
    lane: input.lane,
    contextId: input.contextId,
    backend: "claude",
    workflowConversationId: input.conversationId,
    metrics: {},
    lastUsedAt: NOW,
  };
}

function codexLaneState(input: {
  lane: "implementer" | "context_validator";
  contextId: string;
  conversationId: string;
}): GraphWorkflowAgentSessionState {
  return {
    lane: input.lane,
    contextId: input.contextId,
    backend: "codex",
    workflowConversationId: input.conversationId,
    metrics: { lastTurnUsage: null },
    lastUsedAt: NOW,
  };
}

/**
 * Builds an execution whose gated context has a resolved `askUserQuestions`
 * toggle, plus `laneStates` populated with the given lane sessions keyed by
 * their lane key (`implementer` / `context_validator:<assignmentId>`).
 */
function buildExecution(input: {
  askEnabled: boolean;
  lanes?: Record<string, Record<string, GraphWorkflowAgentSessionState>>;
  round?: GraphWorkflowValidationRound;
}): GraphWorkflowExecution {
  const execution = createWorkflowExecution();
  const context = execution.workingDefinition.executionContexts.find(
    (ctx) => ctx.id === IMPL_CONTEXT_ID,
  );
  if (!context) throw new Error("fixture missing gated context");
  context.askUserQuestions = { enabled: input.askEnabled };
  execution.status = "running";
  const contextState = execution.contextStates[IMPL_CONTEXT_ID];
  if (!contextState) throw new Error("fixture missing gated context state");
  contextState.status = "running";
  if (input.round) contextState.validationRound = input.round;
  if (input.lanes) {
    execution.laneStates = input.lanes;
  }
  return execution;
}

/** An open round on the gated context, as the cohort would have frozen it. */
function openRound(
  overrides: Partial<GraphWorkflowValidationRound> = {},
): GraphWorkflowValidationRound {
  return {
    seq: ROUND_SEQ,
    candidate: {
      identityScope: "wholeTree",
      headSha: "head-1",
      candidateTreeHash: "tree-a",
      taskStateHash: "tasks-a",
    },
    roster: [],
    specialists: {},
    phase: "specialists",
    outcome: null,
    startedAt: NOW,
    ...overrides,
  };
}

describe("createUserInputGateService.resolveLaneAskPermission", () => {
  function buildService(execution: GraphWorkflowExecution | null) {
    const deps: UserInputGateServiceDeps = {
      async getActive() {
        return execution;
      },
      async mutateActive() {
        throw new Error("not used by resolveLaneAskPermission");
      },
      publishUserInputPending() {
        throw new Error("not used by resolveLaneAskPermission");
      },
      publishUserInputResolved() {
        throw new Error("not used by resolveLaneAskPermission");
      },
      deliver() {
        throw new Error("not used by resolveLaneAskPermission");
      },
      async clearConversationQuestion() {
        return true;
      },
      now: () => NOW,
    };
    return createUserInputGateService(deps);
  }

  it("allows a Claude implementer lane when the toggle is enabled", async () => {
    const service = buildService(
      buildExecution({
        askEnabled: true,
        lanes: {
          [IMPL_CONTEXT_ID]: {
            implementer: claudeLaneState({
              lane: "implementer",
              contextId: IMPL_CONTEXT_ID,
              conversationId: CONVERSATION_ID,
            }),
          },
        },
      }),
    );

    const permission = await service.resolveLaneAskPermission(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );

    expect(permission).toEqual({
      allowed: true,
      executionId: "execution-1",
      contextId: IMPL_CONTEXT_ID,
      lane: "implementer",
      laneKey: "implementer",
    });
  });

  it("allows a Claude context_validator lane, naming the assignment's lane key", async () => {
    const service = buildService(
      buildExecution({
        askEnabled: true,
        lanes: {
          [IMPL_CONTEXT_ID]: {
            [SECURITY_KEY]: claudeLaneState({
              lane: "context_validator",
              contextId: IMPL_CONTEXT_ID,
              conversationId: SECURITY_CONVERSATION,
            }),
          },
        },
      }),
    );

    const permission = await service.resolveLaneAskPermission(
      PROJECT_PATH,
      SESSION_NAME,
      SECURITY_CONVERSATION,
    );

    expect(permission.allowed).toBe(true);
    expect(permission.lane).toBe("context_validator");
    expect(permission.laneKey).toBe(SECURITY_KEY);
  });

  it("allows a Codex implementer lane when enabled", async () => {
    const service = buildService(
      buildExecution({
        askEnabled: true,
        lanes: {
          [IMPL_CONTEXT_ID]: {
            implementer: codexLaneState({
              lane: "implementer",
              contextId: IMPL_CONTEXT_ID,
              conversationId: CONVERSATION_ID,
            }),
          },
        },
      }),
    );

    const permission = await service.resolveLaneAskPermission(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );

    expect(permission).toEqual({
      allowed: true,
      executionId: "execution-1",
      contextId: IMPL_CONTEXT_ID,
      lane: "implementer",
      laneKey: "implementer",
    });
  });

  it("denies when the toggle is disabled even for a resolvable lane", async () => {
    const service = buildService(
      buildExecution({
        askEnabled: false,
        lanes: {
          [IMPL_CONTEXT_ID]: {
            implementer: claudeLaneState({
              lane: "implementer",
              contextId: IMPL_CONTEXT_ID,
              conversationId: CONVERSATION_ID,
            }),
          },
        },
      }),
    );

    const permission = await service.resolveLaneAskPermission(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );

    expect(permission).toEqual({ allowed: false });
  });

  it("denies a conversation that resolves to no lane (planner / non-lane)", async () => {
    const service = buildService(
      buildExecution({
        askEnabled: true,
        lanes: {
          [IMPL_CONTEXT_ID]: {
            implementer: claudeLaneState({
              lane: "implementer",
              contextId: IMPL_CONTEXT_ID,
              conversationId: "conv-other",
            }),
          },
        },
      }),
    );

    const permission = await service.resolveLaneAskPermission(
      PROJECT_PATH,
      SESSION_NAME,
      "conv-planner-or-unknown",
    );

    expect(permission).toEqual({ allowed: false });
  });

  it("denies when there is no active execution", async () => {
    const service = buildService(null);

    const permission = await service.resolveLaneAskPermission(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );

    expect(permission).toEqual({ allowed: false });
  });
});

describe("createUserInputGateService lifecycle (real persistence)", () => {
  let fixture: PersistenceFixture;
  let broadcasted: GraphWorkflowSSEEvent[];
  let cleared: Array<{ conversationId: string }>;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    broadcasted = [];
    cleared = [];
  });

  afterEach(() => {
    fixture.close();
  });

  function buildService() {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: (event) => {
        broadcasted.push(event);
      },
      now: () => NOW,
    });
    const repo = createGraphWorkflowExecutionRepository({
      getGraphWorkflowPendingArtifacts: async () => null,
      clearGraphWorkflowPendingArtifacts: async () => false,

      // No git worktree in this harness; the real exclusion would shell out.
      ensureCcArtifactsExcluded: async () => {},
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      reserveActiveGraphWorkflowExecution:
        fixture.store.reserveActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,

      eventPublisher: publisher,
    });
    return createUserInputGateService({
      getActive: repo.getActive,
      mutateActive: repo.mutateActive,
      publishUserInputPending: publisher.publishUserInputPending,
      publishUserInputResolved: publisher.publishUserInputResolved,
      deliver: publisher.deliver,
      clearConversationQuestion: async (
        _projectPath,
        _sessionName,
        conversationId,
      ) => {
        cleared.push({ conversationId });
        return true;
      },
      now: () => NOW,
    });
  }

  async function seedExecution(execution: GraphWorkflowExecution) {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedExecution",
      () => ({
        kind: "commit",
        value: undefined,
        ...{ execution, events: [] },
      }),
    );
  }

  async function reloadExecution(): Promise<GraphWorkflowExecution> {
    const execution = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    if (!execution) throw new Error("execution missing after reload");
    return execution;
  }

  async function reloadGatedContext() {
    const contextState = (await reloadExecution()).contextStates[
      IMPL_CONTEXT_ID
    ];
    if (!contextState) throw new Error("gated context missing after reload");
    return contextState;
  }

  function laneFixture() {
    return {
      askEnabled: true,
      lanes: {
        [IMPL_CONTEXT_ID]: {
          implementer: claudeLaneState({
            lane: "implementer",
            contextId: IMPL_CONTEXT_ID,
            conversationId: CONVERSATION_ID,
          }),
        },
      },
    } as const;
  }

  /** Two question-capable validator lanes plus their open round. */
  function cohortFixture() {
    return {
      askEnabled: true,
      round: openRound(),
      lanes: {
        [IMPL_CONTEXT_ID]: {
          [SECURITY_KEY]: claudeLaneState({
            lane: "context_validator",
            contextId: IMPL_CONTEXT_ID,
            conversationId: SECURITY_CONVERSATION,
          }),
          [PERF_KEY]: claudeLaneState({
            lane: "context_validator",
            contextId: IMPL_CONTEXT_ID,
            conversationId: PERF_CONVERSATION,
          }),
        },
      },
    } as const;
  }

  async function parkValidator(
    service: ReturnType<typeof buildService>,
    laneKey: string,
    conversationId: string,
    questionBatchId: string,
  ) {
    return await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
      laneKey,
      conversationId,
      questionBatchId,
      questions: makeQuestions(),
      roundSeq: ROUND_SEQ,
    });
  }

  it("parks the context: snapshots questions under the lane key, publishes pending", async () => {
    const service = buildService();
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      makeConversationState({ id: CONVERSATION_ID }),
    );
    const execution = buildExecution(laneFixture());
    execution.ownerConversationId = CONVERSATION_ID;
    await seedExecution(execution);

    const outcome = await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
      laneKey: "implementer",
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      questions: makeQuestions(),
    });

    expect(outcome).toBe("parked");

    const reloaded = await reloadGatedContext();
    expect(reloaded.status).toBe("awaiting_user_input");
    expect(reloaded.pendingUserInputs).toEqual({
      implementer: {
        conversationId: CONVERSATION_ID,
        lane: "implementer",
        questionBatchId: QUESTION_BATCH_ID,
        questions: makeQuestions(),
        requestedAt: NOW,
        roundSeq: null,
        answers: null,
      },
    });

    expect(
      broadcasted.some(
        (event) => event.type === "graph-workflow-user-input-pending",
      ),
    ).toBe(true);

    const eventRows = fixture.graphWorkflowEvents.findRecordsByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      execution.id,
    );
    expect(eventRows.map((row) => row.event.type)).toEqual(
      expect.arrayContaining([
        "graph-workflow-user-input-pending",
        "graph-workflow-boundary",
      ]),
    );
    const boundary = eventRows.find(
      (row) =>
        row.event.type === "graph-workflow-boundary" &&
        row.event.boundaryKind === "lane_question",
    );
    expect(boundary).toBeDefined();
    expect(
      createGraphWorkflowResultDeliveriesRepo(fixture.db).findByBoundary(
        PROJECT_PATH,
        SESSION_NAME,
        execution.id,
        boundary!.id,
      ),
    ).not.toBeNull();
    expect(
      broadcasted.some(
        (event) => event.type === "graph-workflow-result-recorded",
      ),
    ).toBe(true);
  });

  it("parks two validator lanes at once, each on its own round-scoped record", async () => {
    const service = buildService();
    await seedExecution(buildExecution(cohortFixture()));

    await parkValidator(
      service,
      SECURITY_KEY,
      SECURITY_CONVERSATION,
      "batch-security",
    );
    await parkValidator(service, PERF_KEY, PERF_CONVERSATION, "batch-perf");

    const reloaded = await reloadGatedContext();
    expect(Object.keys(reloaded.pendingUserInputs).sort()).toEqual(
      [PERF_KEY, SECURITY_KEY].sort(),
    );
    expect(reloaded.pendingUserInputs[SECURITY_KEY]).toMatchObject({
      conversationId: SECURITY_CONVERSATION,
      questionBatchId: "batch-security",
      roundSeq: ROUND_SEQ,
      answers: null,
    });
    expect(reloaded.pendingUserInputs[PERF_KEY]).toMatchObject({
      conversationId: PERF_CONVERSATION,
      questionBatchId: "batch-perf",
      roundSeq: ROUND_SEQ,
      answers: null,
    });
    expect(reloaded.status).toBe("awaiting_user_input");
    expect(
      broadcasted.filter(
        (event) => event.type === "graph-workflow-user-input-pending",
      ),
    ).toHaveLength(2);
  });

  it("answering one parked lane settles only that lane", async () => {
    const service = buildService();
    await seedExecution(buildExecution(cohortFixture()));
    await parkValidator(
      service,
      SECURITY_KEY,
      SECURITY_CONVERSATION,
      "batch-security",
    );
    await parkValidator(service, PERF_KEY, PERF_CONVERSATION, "batch-perf");

    const recorded = await service.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: SECURITY_CONVERSATION,
      questionBatchId: "batch-security",
      answers: makeAnswers(),
    });

    expect(recorded).toEqual({ ok: true });
    const reloaded = await reloadGatedContext();
    expect(
      reloaded.pendingUserInputs[SECURITY_KEY]?.answers?.byQuestionId,
    ).toEqual(makeAnswers());
    expect(reloaded.pendingUserInputs[PERF_KEY]?.answers).toBeNull();
    // The sibling is still waiting, so the context stays parked.
    expect(reloaded.status).toBe("awaiting_user_input");
  });

  it("consumeAnswers resumes only the answered lanes and holds the park open for the rest", async () => {
    const service = buildService();
    await seedExecution(buildExecution(cohortFixture()));
    await parkValidator(
      service,
      SECURITY_KEY,
      SECURITY_CONVERSATION,
      "batch-security",
    );
    await parkValidator(service, PERF_KEY, PERF_CONVERSATION, "batch-perf");
    await service.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: SECURITY_CONVERSATION,
      questionBatchId: "batch-security",
      answers: makeAnswers(),
    });

    const consumed = await service.consumeAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
    });

    expect(consumed).toEqual([
      {
        laneKey: SECURITY_KEY,
        lane: "context_validator",
        conversationId: SECURITY_CONVERSATION,
        questionBatchId: "batch-security",
        answers: makeAnswers(),
      },
    ]);
    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingUserInputs[SECURITY_KEY]).toBeUndefined();
    expect(reloaded.pendingUserInputs[PERF_KEY]).toBeDefined();
    // A lane still parked keeps the context in the awaiting state.
    expect(reloaded.status).toBe("awaiting_user_input");
  });

  it("consumeAnswers flips back to running once the last parked lane is consumed", async () => {
    const service = buildService();
    await seedExecution(buildExecution(cohortFixture()));
    await parkValidator(
      service,
      SECURITY_KEY,
      SECURITY_CONVERSATION,
      "batch-security",
    );
    await parkValidator(service, PERF_KEY, PERF_CONVERSATION, "batch-perf");
    for (const [conversationId, questionBatchId] of [
      [SECURITY_CONVERSATION, "batch-security"],
      [PERF_CONVERSATION, "batch-perf"],
    ] as const) {
      await service.recordAnswers({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId,
        questionBatchId,
        answers: makeAnswers(),
      });
    }

    const consumed = await service.consumeAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
    });

    expect(consumed.map((entry) => entry.laneKey).sort()).toEqual(
      [PERF_KEY, SECURITY_KEY].sort(),
    );
    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingUserInputs).toEqual({});
    expect(reloaded.status).toBe("running");
  });

  it("returns answers_ready when answers were recorded before park (fast answer)", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));

    const recorded = await service.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      answers: makeAnswers(),
    });
    expect(recorded.ok).toBe(true);

    const outcome = await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
      laneKey: "implementer",
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      questions: makeQuestions(),
    });

    expect(outcome).toBe("answers_ready");
    const reloaded = await reloadGatedContext();
    // Fast answer never flips the context into the awaiting state.
    expect(reloaded.status).toBe("running");
    expect(
      reloaded.pendingUserInputs["implementer"]?.answers?.byQuestionId,
    ).toEqual(makeAnswers());
  });

  it("recordAnswers creates the record pre-park (upsert-before-park)", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));

    const result = await service.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      answers: makeAnswers(),
    });

    expect(result).toEqual({ ok: true });
    const reloaded = await reloadGatedContext();
    const record = reloaded.pendingUserInputs["implementer"];
    expect(record?.questionBatchId).toBe(QUESTION_BATCH_ID);
    expect(record?.answers?.byQuestionId).toEqual(makeAnswers());
    expect(record?.answers?.answeredAt).toBe(NOW);
    // Recording answers before park must NOT flip the status prematurely.
    expect(reloaded.status).toBe("running");
  });

  it("upserts a validator fast answer before its park, keyed by its own lane", async () => {
    const service = buildService();
    await seedExecution(buildExecution(cohortFixture()));
    await parkValidator(
      service,
      SECURITY_KEY,
      SECURITY_CONVERSATION,
      "batch-security",
    );

    // The perf lane's answer arrives before its park lands: a sibling's parked
    // record must not make the pre-park upsert look superseded.
    const result = await service.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: PERF_CONVERSATION,
      questionBatchId: "batch-perf",
      answers: makeAnswers(),
    });

    expect(result).toEqual({ ok: true });
    const outcome = await parkValidator(
      service,
      PERF_KEY,
      PERF_CONVERSATION,
      "batch-perf",
    );
    expect(outcome).toBe("answers_ready");
  });

  it("records answers into an existing parked record", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));
    await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
      laneKey: "implementer",
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      questions: makeQuestions(),
    });

    const result = await service.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      answers: makeAnswers(),
    });

    expect(result).toEqual({ ok: true });
    const reloaded = await reloadGatedContext();
    expect(reloaded.status).toBe("awaiting_user_input");
    expect(
      reloaded.pendingUserInputs["implementer"]?.answers?.byQuestionId,
    ).toEqual(makeAnswers());

    expect(
      broadcasted.some(
        (event) =>
          event.type === "graph-workflow-user-input-resolved" &&
          event.resolution === "answered",
      ),
    ).toBe(true);
  });

  it("rejects a duplicate answer submission as already_answered", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));
    await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
      laneKey: "implementer",
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      questions: makeQuestions(),
    });
    await service.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      answers: makeAnswers(),
    });

    const second = await service.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      answers: makeAnswers(),
    });

    expect(second).toEqual({ ok: false, reason: "already_answered" });
  });

  it("returns not_found when no matching batch is registered", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));
    await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
      laneKey: "implementer",
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      questions: makeQuestions(),
    });

    const result = await service.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      questionBatchId: "some-other-batch",
      answers: makeAnswers(),
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses a validator answer whose round is over (dead token)", async () => {
    const service = buildService();
    await seedExecution(
      buildExecution({
        ...cohortFixture(),
        round: openRound({ phase: "concluded" }),
      }),
    );

    const result = await service.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: SECURITY_CONVERSATION,
      questionBatchId: "batch-security",
      answers: makeAnswers(),
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses a validator answer for a superseded round's parked record", async () => {
    const service = buildService();
    await seedExecution(buildExecution(cohortFixture()));
    await parkValidator(
      service,
      SECURITY_KEY,
      SECURITY_CONVERSATION,
      "batch-security",
    );
    // A newer round opened under the park: the recorded token is dead.
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.supersedeRound",
      (execution) => {
        if (execution === null) throw new Error("no active execution");
        const contextState = execution.contextStates[IMPL_CONTEXT_ID];
        if (!contextState?.validationRound) throw new Error("no round");
        contextState.validationRound.seq = ROUND_SEQ + 1;
        return {
          kind: "commit",
          value: undefined,
          ...{ execution, events: [] },
        };
      },
    );

    const result = await service.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: SECURITY_CONVERSATION,
      questionBatchId: "batch-security",
      answers: makeAnswers(),
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("consumeAnswers returns an empty list when the context has no recorded answers", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));

    const consumed = await service.consumeAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
    });

    expect(consumed).toEqual([]);
  });

  it("withdrawAll clears every lane's record, dispatches CLEAR_PENDING_QUESTION, and publishes resolved(withdrawn)", async () => {
    const service = buildService();
    await seedExecution(buildExecution(cohortFixture()));
    await parkValidator(
      service,
      SECURITY_KEY,
      SECURITY_CONVERSATION,
      "batch-security",
    );
    await parkValidator(service, PERF_KEY, PERF_CONVERSATION, "batch-perf");

    await service.withdrawAll({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
    });

    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingUserInputs).toEqual({});
    expect(reloaded.status).toBe("running");

    expect(cleared.map((entry) => entry.conversationId).sort()).toEqual(
      [PERF_CONVERSATION, SECURITY_CONVERSATION].sort(),
    );
    expect(
      broadcasted.filter(
        (event) =>
          event.type === "graph-workflow-user-input-resolved" &&
          event.resolution === "withdrawn",
      ),
    ).toHaveLength(2);
  });

  it("withdrawAll is idempotent when nothing is parked", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));

    const unchanged = await service.withdrawAll({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
    });
    expect(unchanged.contextStates["context-plan"]?.pendingUserInputs).toEqual(
      {},
    );

    expect(cleared).toEqual([]);
    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingUserInputs).toEqual({});
  });

  it("withdrawRoundQuestions clears the open round and exactly its validator parks, once", async () => {
    const service = buildService();
    await seedExecution(
      buildExecution({
        ...cohortFixture(),
        lanes: {
          [IMPL_CONTEXT_ID]: {
            ...cohortFixture().lanes[IMPL_CONTEXT_ID],
            implementer: claudeLaneState({
              lane: "implementer",
              contextId: IMPL_CONTEXT_ID,
              conversationId: CONVERSATION_ID,
            }),
          },
        },
      }),
    );
    await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
      laneKey: "implementer",
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      questions: makeQuestions(),
    });
    await parkValidator(
      service,
      SECURITY_KEY,
      SECURITY_CONVERSATION,
      "batch-security",
    );
    await parkValidator(service, PERF_KEY, PERF_CONVERSATION, "batch-perf");

    await service.withdrawRoundQuestions({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
    });
    // A second pass finds nothing left to withdraw.
    await service.withdrawRoundQuestions({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
    });

    const reloaded = await reloadGatedContext();
    // The implementer's park survives a pause; both validator parks are gone.
    expect(Object.keys(reloaded.pendingUserInputs)).toEqual(["implementer"]);
    expect(reloaded.validationRound?.phase).toBe("concluded");
    expect(reloaded.validationRound?.outcome).toBeNull();
    expect(cleared.map((entry) => entry.conversationId).sort()).toEqual(
      [PERF_CONVERSATION, SECURITY_CONVERSATION].sort(),
    );
    expect(
      broadcasted.filter(
        (event) =>
          event.type === "graph-workflow-user-input-resolved" &&
          event.resolution === "withdrawn",
      ),
    ).toHaveLength(2);
    // An implementer park still holds the context in the awaiting state.
    expect(reloaded.status).toBe("awaiting_user_input");
  });

  it("re-asserting a standing question changes nothing and announces nothing", async () => {
    const service = buildService();
    await seedExecution(buildExecution(cohortFixture()));
    expect(
      await parkValidator(
        service,
        SECURITY_KEY,
        SECURITY_CONVERSATION,
        "batch-security",
      ),
    ).toBe("parked");
    const standing = (await reloadGatedContext()).pendingUserInputs[
      SECURITY_KEY
    ];

    // A resumed round carries a still-parked lane through the gate again.
    expect(
      await parkValidator(
        service,
        SECURITY_KEY,
        SECURITY_CONVERSATION,
        "batch-security",
      ),
    ).toBe("parked");

    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingUserInputs[SECURITY_KEY]).toEqual(standing);
    // One pending event for one question: a second would surface a question the
    // operator is already looking at as a new one.
    expect(
      broadcasted.filter(
        (event) => event.type === "graph-workflow-user-input-pending",
      ),
    ).toHaveLength(1);
  });

  it("withdrawRoundQuestions scoped to one context leaves a sibling's round and park standing", async () => {
    const service = buildService();
    const execution = buildExecution(cohortFixture());
    // A second context reviewing its own candidate, with its own parked lane.
    const sibling = execution.contextStates[SIBLING_CONTEXT_ID];
    if (!sibling) throw new Error("fixture missing sibling context state");
    sibling.status = "running";
    sibling.validationRound = openRound();
    execution.laneStates[SIBLING_CONTEXT_ID] = {
      [SECURITY_KEY]: claudeLaneState({
        lane: "context_validator",
        contextId: SIBLING_CONTEXT_ID,
        conversationId: SIBLING_CONVERSATION,
      }),
    };
    await seedExecution(execution);
    await parkValidator(
      service,
      SECURITY_KEY,
      SECURITY_CONVERSATION,
      "batch-security",
    );
    await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: SIBLING_CONTEXT_ID,
      laneKey: SECURITY_KEY,
      conversationId: SIBLING_CONVERSATION,
      questionBatchId: "batch-sibling",
      questions: makeQuestions(),
      roundSeq: ROUND_SEQ,
    });

    await service.withdrawRoundQuestions({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
      contextId: IMPL_CONTEXT_ID,
      releaseTo: "running",
    });

    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingUserInputs).toEqual({});
    expect(reloaded.validationRound?.phase).toBe("concluded");
    // Released to the iteration still driving it, not to the scheduler.
    expect(reloaded.status).toBe("running");

    // The sibling context is mid-review of its own candidate: its round and the
    // question it is waiting on are untouched.
    const siblingState = (await reloadExecution()).contextStates[
      SIBLING_CONTEXT_ID
    ];
    expect(Object.keys(siblingState?.pendingUserInputs ?? {})).toEqual([
      SECURITY_KEY,
    ]);
    expect(siblingState?.validationRound?.phase).toBe("specialists");
    expect(siblingState?.status).toBe("awaiting_user_input");
    expect(cleared.map((entry) => entry.conversationId)).toEqual([
      SECURITY_CONVERSATION,
    ]);
  });

  it("withdrawRoundQuestions returns a context with no surviving park to the schedulable set", async () => {
    const service = buildService();
    await seedExecution(buildExecution(cohortFixture()));
    await parkValidator(
      service,
      SECURITY_KEY,
      SECURITY_CONVERSATION,
      "batch-security",
    );

    await service.withdrawRoundQuestions({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
    });

    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingUserInputs).toEqual({});
    expect(reloaded.status).toBe("ready");
  });
});
