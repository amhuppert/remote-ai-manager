import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AskQuestionAnswer,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
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
  conversationId?: string;
}): GraphWorkflowAgentSessionState {
  return {
    lane: input.lane,
    contextId: input.contextId,
    backend: "claude",
    refKind: "conversation",
    ...(input.conversationId !== undefined
      ? { workflowConversationId: input.conversationId }
      : {}),
    sessionRef: {
      backend: "claude",
      ref: input.conversationId ?? "conv-fallback",
    },
    metrics: { rotateBeforeNextTurn: false },
    limitEvaluation: "disabled",
    lastUsedAt: NOW,
  };
}

function codexLaneState(input: {
  lane: "implementer" | "context_validator";
  contextId: string;
  conversationId?: string;
}): GraphWorkflowAgentSessionState {
  return {
    lane: input.lane,
    contextId: input.contextId,
    backend: "codex",
    refKind: "backend",
    ...(input.conversationId !== undefined
      ? { workflowConversationId: input.conversationId }
      : {}),
    metrics: { lastTurnUsage: null, rotateBeforeNextTurn: false },
    limitEvaluation: "disabled",
    lastUsedAt: NOW,
  };
}

/**
 * Builds an execution whose gated context has a resolved `askUserQuestions`
 * toggle, plus `laneStates` populated with the given lane sessions keyed by
 * their lane kind.
 */
function buildExecution(input: {
  askEnabled: boolean;
  lanes?: Record<string, Record<string, GraphWorkflowAgentSessionState>>;
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
  if (input.lanes) {
    execution.laneStates = input.lanes;
  }
  return execution;
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
      sendConversationEvent() {
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
    });
  });

  it("allows a Claude context_validator lane when the toggle is enabled", async () => {
    const service = buildService(
      buildExecution({
        askEnabled: true,
        lanes: {
          [IMPL_CONTEXT_ID]: {
            context_validator: claudeLaneState({
              lane: "context_validator",
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

    expect(permission.allowed).toBe(true);
    expect(permission.lane).toBe("context_validator");
  });

  it("allows a Codex implementer lane (workflowConversationId set) when enabled", async () => {
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
    });
  });

  it("denies a Codex validator lane (workflowConversationId unset)", async () => {
    const service = buildService(
      buildExecution({
        askEnabled: true,
        lanes: {
          [IMPL_CONTEXT_ID]: {
            context_validator: codexLaneState({
              lane: "context_validator",
              contextId: IMPL_CONTEXT_ID,
              // no conversationId -> workflowConversationId unset
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
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,
      markGraphWorkflowContextEventsPreReset:
        fixture.store.markGraphWorkflowContextEventsPreReset,
      eventPublisher: publisher,
    });
    return createUserInputGateService({
      getActive: repo.getActive,
      mutateActive: repo.mutateActive,
      publishUserInputPending: publisher.publishUserInputPending,
      publishUserInputResolved: publisher.publishUserInputResolved,
      sendConversationEvent: (_projectPath, _sessionName, conversationId) => {
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
      async () => ({ execution, events: [] }),
    );
  }

  async function reloadGatedContext() {
    const execution = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    const contextState = execution?.contextStates[IMPL_CONTEXT_ID];
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

  it("parks the context: snapshots questions, flips status, publishes pending", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));

    const outcome = await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
      lane: "implementer",
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      questions: makeQuestions(),
    });

    expect(outcome).toBe("parked");

    const reloaded = await reloadGatedContext();
    expect(reloaded.status).toBe("awaiting_user_input");
    expect(reloaded.pendingUserInput).toEqual({
      conversationId: CONVERSATION_ID,
      lane: "implementer",
      questionBatchId: QUESTION_BATCH_ID,
      questions: makeQuestions(),
      requestedAt: NOW,
      answers: null,
    });

    expect(
      broadcasted.some(
        (event) => event.type === "graph-workflow-user-input-pending",
      ),
    ).toBe(true);
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
      lane: "implementer",
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      questions: makeQuestions(),
    });

    expect(outcome).toBe("answers_ready");
    const reloaded = await reloadGatedContext();
    // Fast answer never flips the context into the awaiting state.
    expect(reloaded.status).toBe("running");
    expect(reloaded.pendingUserInput?.answers?.byQuestionId).toEqual(
      makeAnswers(),
    );
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
    expect(reloaded.pendingUserInput).not.toBeNull();
    expect(reloaded.pendingUserInput?.questionBatchId).toBe(QUESTION_BATCH_ID);
    expect(reloaded.pendingUserInput?.answers?.byQuestionId).toEqual(
      makeAnswers(),
    );
    expect(reloaded.pendingUserInput?.answers?.answeredAt).toBe(NOW);
    // Recording answers before park must NOT flip the status prematurely.
    expect(reloaded.status).toBe("running");
  });

  it("records answers into an existing parked record", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));
    await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
      lane: "implementer",
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
    expect(reloaded.pendingUserInput?.answers?.byQuestionId).toEqual(
      makeAnswers(),
    );

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
      lane: "implementer",
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
      lane: "implementer",
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

  it("consumeAnswers returns the answers, clears the record, and flips status back to running", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));
    await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
      lane: "implementer",
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

    const consumed = await service.consumeAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
    });

    expect(consumed).toEqual({
      answers: makeAnswers(),
      questionBatchId: QUESTION_BATCH_ID,
      conversationId: CONVERSATION_ID,
      lane: "implementer",
    });

    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingUserInput).toBeNull();
    expect(reloaded.status).toBe("running");
  });

  it("consumeAnswers returns null when the context has no recorded answers", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));

    const consumed = await service.consumeAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
    });

    expect(consumed).toBeNull();
  });

  it("withdrawAll clears records, dispatches CLEAR_PENDING_QUESTION, and publishes resolved(withdrawn)", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));
    await service.enterAwaitingUserInput({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: IMPL_CONTEXT_ID,
      lane: "implementer",
      conversationId: CONVERSATION_ID,
      questionBatchId: QUESTION_BATCH_ID,
      questions: makeQuestions(),
    });

    await service.withdrawAll({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      executionId: "execution-1",
    });

    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingUserInput).toBeNull();
    expect(reloaded.status).toBe("running");

    expect(cleared).toEqual([{ conversationId: CONVERSATION_ID }]);
    expect(
      broadcasted.some(
        (event) =>
          event.type === "graph-workflow-user-input-resolved" &&
          event.resolution === "withdrawn",
      ),
    ).toBe(true);
  });

  it("withdrawAll is idempotent when nothing is parked", async () => {
    const service = buildService();
    await seedExecution(buildExecution(laneFixture()));

    await expect(
      service.withdrawAll({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        executionId: "execution-1",
      }),
    ).resolves.toBeUndefined();

    expect(cleared).toEqual([]);
    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingUserInput).toBeNull();
  });
});
