import { createContextIterationFixture } from "@/lib/workflow-graph/testing/iteration-fixture";
import { changed } from "@/lib/workflow-graph/execution-mutation";
import { createContextTestCapabilities } from "@/lib/workflow-graph/testing/context-capabilities";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AskQuestionAnswer,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import { formatQuestionAnswersBlock } from "@/lib/conversations/question-answers-block";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { _resetRegistryForTesting } from "./execution-logger";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";

import { laneStateKey } from "./lane-identity";
import { createWorkflowExecution } from "./test-fixtures";
import {
  createUserInputGateService,
  type ResumeUserInputContext,
} from "./user-input-gate";
import type { GraphWorkflowContextValidationInput } from "./validator-cohort-runner";
import type { CohortParkedLane } from "./validation-cohort";
import type {
  RecordLaneTurnOutcomeInput,
  ResolveImplementerCallInput,
} from "./lane-continuity";

/**
 * Task 6.1 — Prove the full ask → park → answer → resume cycle against real
 * persistence. Every assertion is made on state reloaded from the real store
 * (`fixture.store.getActiveGraphWorkflowExecution`), not on the in-memory draft
 * an orchestrator returns, so a serialization drop or a default-masked field
 * would fail the suite rather than escape to live verification.
 *
 * The distinguishing property of this suite (vs. the DI'd orchestrator unit
 * tests) is the wiring: a real `createGraphWorkflowExecutionRepository` and a
 * real `createUserInputGateService` over a `createPersistenceFixture` SQLite
 * store. The lane-conversation read seam and the continuity service are
 * injected (as the unit tests inject them), because the park/resume cycle's
 * durable object is the execution's `pendingUserInput` record, which round-trips
 * through the real repo here.
 */

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";
const CONTEXT_ID = "context-plan";
const CONV_ASK = "conv-impl-ask";
const CONV_VALIDATOR = "conv-validator-ask";
const IMPL_BATCH_ID = "batch-impl-1";
const VALIDATOR_BATCH_ID = "batch-validator-1";
const NOW = "2026-07-03T20:00:00.000Z";

function makeQuestions(): AskQuestionItem[] {
  return [
    {
      id: "q1",
      question: "Which approach should the plan take?",
      options: [
        { label: "Incremental", recommended: true },
        { label: "Big bang", recommended: false },
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
      selected: ["Incremental"],
      note: "keep it safe",
      skipped: false,
      question: "Which approach should the plan take?",
    },
  };
}

function claudeLaneState(input: {
  lane: "implementer" | "context_validator";
  conversationId: string;
}): GraphWorkflowAgentSessionState {
  return {
    lane: input.lane,
    contextId: CONTEXT_ID,
    backend: "claude",
    refKind: "conversation",
    workflowConversationId: input.conversationId,
    sessionRef: { backend: "claude", ref: input.conversationId },
    metrics: {},
    lastUsedAt: NOW,
  };
}

/**
 * A running execution whose gated context (`context-plan`) has the
 * `askUserQuestions` toggle resolved on, a Claude lane per role holding a real
 * conversation id, and the plan task set to the requested completion state.
 */
function buildCycleExecution(input: {
  lane: "implementer" | "context_validator";
  /** The assignment a validator lane belongs to; keys its lane state. */
  assignmentId?: string;
  conversationId: string;
  planTaskCompleted: boolean;
  consecutiveFailureCount?: number;
}): GraphWorkflowExecution {
  const execution = createWorkflowExecution();
  const context = execution.workingDefinition.executionContexts.find(
    (ctx) => ctx.id === CONTEXT_ID,
  );
  if (!context) throw new Error("fixture missing gated context");
  context.askUserQuestions = { enabled: true };

  execution.status = "running";
  execution.activeContextIds = [CONTEXT_ID];
  execution.laneStates = {
    [CONTEXT_ID]: {
      [laneStateKey(input.lane, input.assignmentId)]: claudeLaneState({
        lane: input.lane,
        conversationId: input.conversationId,
      }),
    },
  };

  const contextState = execution.contextStates[CONTEXT_ID];
  if (!contextState) throw new Error("fixture missing gated context state");
  contextState.status = "running";
  contextState.consecutiveFailureCount = input.consecutiveFailureCount ?? 0;
  contextState.completedTaskCount = input.planTaskCompleted ? 1 : 0;

  const planTask = execution.taskStates["task-plan-1"];
  if (!planTask) throw new Error("fixture missing plan task");
  if (input.planTaskCompleted) {
    planTask.status = "completed";
    planTask.summary = "Planned";
    planTask.completedAt = NOW;
  }

  return execution;
}

describe("user-input full cycle against real persistence (task 6.1)", () => {
  let fixture: PersistenceFixture;
  let broadcasted: GraphWorkflowSSEEvent[];

  beforeEach(() => {
    _resetRegistryForTesting();
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    broadcasted = [];
  });

  afterEach(() => {
    fixture.close();
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

      eventPublisher,
    });
  }

  function buildGate(
    repository: ReturnType<typeof buildRepository>,
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
      clearConversationQuestion: async () => true,
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

  async function reloadContext() {
    const execution = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    const contextState = execution?.contextStates[CONTEXT_ID];
    if (!contextState) throw new Error("gated context missing after reload");
    return { execution: execution!, contextState };
  }

  it("implementer ask parks with no validation run; the answer resumes the same conversation and consume clears the record", async () => {
    const eventPublisher = buildEventPublisher();
    const repository = buildRepository(eventPublisher);
    const gate = buildGate(repository, eventPublisher);
    await seedExecution(
      buildCycleExecution({
        lane: "implementer",
        conversationId: CONV_ASK,
        planTaskCompleted: false,
      }),
    );

    // The lane conversation shows a pending question until the answer clears it
    // (mirrors the answer route's CLEAR_PENDING_QUESTION machine transition).
    let laneHasPendingQuestion = true;
    const readLaneConversation = vi.fn(
      async (_p: string, _s: string, conversationId: string) => {
        if (conversationId === CONV_ASK && laneHasPendingQuestion) {
          return {
            pendingQuestionId: IMPL_BATCH_ID,
            pendingQuestions: makeQuestions(),
          };
        }
        return { pendingQuestionId: null, pendingQuestions: [] };
      },
    );

    // The ask turn asks and completes nothing; the resume turn completes the
    // plan task. Both turns run on the pinned asking conversation.
    const capturedPrompts: string[] = [];
    const runAgentIteration = vi.fn(
      async (agentInput: { prompt: string; conversationId: string }) => {
        capturedPrompts.push(agentInput.prompt);
        if (!laneHasPendingQuestion) {
          const current = await repository.getActive(
            PROJECT_PATH,
            SESSION_NAME,
          );
          if (!current) throw new Error("execution missing during resume turn");
          const next = structuredClone(current);
          next.taskStates["task-plan-1"] = {
            ...next.taskStates["task-plan-1"]!,
            status: "completed",
            summary: "Planned after answer",
            completedAt: NOW,
          };
          next.contextStates[CONTEXT_ID] = {
            ...next.contextStates[CONTEXT_ID]!,
            completedTaskCount: 1,
          };
          await repository
            .mutateActive(PROJECT_PATH, SESSION_NAME, () => changed(next))
            .then((mutation) => mutation.execution);
        }
        return {
          conversationId: agentInput.conversationId,
          contextTokens: null,
          contextWindowMax: null,
        };
      },
    );

    const validateContextCompletion = vi.fn(async () => ({
      kind: "pass" as const,
      summary: "Context passed",
      feedback: "Context validation passed.",
      issues: [] as never[],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    }));

    const resolveImplementerCall = vi.fn(
      async (callInput: ResolveImplementerCallInput) => ({
        execution: callInput.execution,
        conversationId: CONV_ASK,
        sessionAction: "reuse" as const,
        promptMode: "follow_up" as const,
      }),
    );

    const orchestrator = createContextIterationFixture({
      ...createContextTestCapabilities(),
      materializeWorkflowDocuments: async ({ execution }) => execution,

      executionContract: createTestGraphExecutionContract(),

      executionRepository: repository,
      findLatestContextValidationEvent: async () => null,
      createConversation: vi.fn(async () => ({ id: CONV_ASK })),
      runAgentIteration,
      validationService: { validateContextCompletion },
      userInputGateService: gate,
      readLaneConversation,
      continuityService: {
        resolveImplementerCall,
        recordLaneTurnOutcome: vi.fn(
          async (turnInput: RecordLaneTurnOutcomeInput) => turnInput.execution,
        ),
      },
      eventPublisher,
      now: () => NOW,
    });

    // --- Ask turn: the implementer asks, the context parks ---
    const askResult = await orchestrator.runIteration({
      projectPath: PROJECT_PATH,
      projectName: "repo",
      sessionName: SESSION_NAME,
      contextId: CONTEXT_ID,
    });

    expect(askResult.decision.kind).toBe("await_user_input");
    // No validation ran on the asking turn — the park short-circuits it.
    expect(validateContextCompletion).not.toHaveBeenCalled();

    const parked = await reloadContext();
    expect(parked.contextState.status).toBe("awaiting_user_input");
    expect(parked.contextState.pendingUserInputs["implementer"]).toMatchObject({
      conversationId: CONV_ASK,
      lane: "implementer",
      questionBatchId: IMPL_BATCH_ID,
      questions: makeQuestions(),
      answers: null,
    });
    // Req 3.3: parking consumed no iteration and moved no failure count. The
    // agent turn's seed increment is refunded by the park.
    expect(parked.contextState.iterationCount).toBe(0);
    expect(parked.contextState.consecutiveFailureCount).toBe(0);
    expect(parked.execution.activeContextIds).not.toContain(CONTEXT_ID);
    expect(
      broadcasted.some((e) => e.type === "graph-workflow-user-input-pending"),
    ).toBe(true);
    // The ask turn seeded the agent (turn one of the cycle's two seeded turns).
    const agentCallsAfterAsk = runAgentIteration.mock.calls.length;
    expect(agentCallsAfterAsk).toBeGreaterThanOrEqual(1);

    // --- Answer: recorded on the execution record (as the answer route does) ---
    const recorded = await gate.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONV_ASK,
      questionBatchId: IMPL_BATCH_ID,
      answers: makeAnswers(),
    });
    expect(recorded).toEqual({ ok: true });
    laneHasPendingQuestion = false;

    const answered = await reloadContext();
    expect(answered.contextState.status).toBe("awaiting_user_input");
    expect(
      answered.contextState.pendingUserInputs["implementer"]?.answers
        ?.byQuestionId,
    ).toEqual(makeAnswers());

    // --- Consume: the loop reads the answers, clears the record, unparks ---
    const consumed = await gate.consumeAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: CONTEXT_ID,
    });
    expect(consumed).toEqual([
      {
        laneKey: "implementer",
        lane: "implementer",
        answers: makeAnswers(),
        questionBatchId: IMPL_BATCH_ID,
        conversationId: CONV_ASK,
      },
    ]);

    const afterConsume = await reloadContext();
    expect(afterConsume.contextState.pendingUserInputs).toEqual({});
    expect(afterConsume.contextState.status).toBe("running");

    // --- Resume: the same conversation continues with the answers block ---
    const resumeResult = await orchestrator.runIteration({
      projectPath: PROJECT_PATH,
      projectName: "repo",
      sessionName: SESSION_NAME,
      contextId: CONTEXT_ID,
      resumeUserInputs: consumed,
    });

    expect(resumeResult.conversationId).toBe(CONV_ASK);
    // The resumed prompt carries the standard answers block verbatim.
    const resumePrompt = capturedPrompts.at(-1)!;
    expect(resumePrompt).toContain(
      formatQuestionAnswersBlock(IMPL_BATCH_ID, makeAnswers()),
    );
    expect(resumePrompt).toContain("## Your Question Was Answered");

    const resumed = await reloadContext();
    // The record stays cleared; the context finished its work post-answer.
    expect(resumed.contextState.pendingUserInputs).toEqual({});
    expect(resumed.contextState.status).toBe("completed");
    // Req 5.5: the resume ran as an ordinary seeded iteration (counted once).
    expect(resumed.contextState.iterationCount).toBe(1);
    expect(resumed.contextState.consecutiveFailureCount).toBe(0);
    // Validation ran exactly once — on the resumed turn, never on the ask turn.
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);

    // A park + resume cycle costs exactly two seeded turns: the ask turn (whose
    // iteration was refunded by the park) and the resume turn (the sole counted
    // iteration). The resume turn seeded the agent again after the park.
    expect(runAgentIteration.mock.calls.length).toBeGreaterThan(
      agentCallsAfterAsk,
    );
  });

  it("validator ask parks without failure movement and its resume verdict is processed normally", async () => {
    const eventPublisher = buildEventPublisher();
    const repository = buildRepository(eventPublisher);
    const gate = buildGate(repository, eventPublisher);
    // All tasks complete → runIteration takes the validation-only path.
    await seedExecution(
      buildCycleExecution({
        lane: "context_validator",
        assignmentId: "general",
        conversationId: CONV_VALIDATOR,
        planTaskCompleted: true,
        consecutiveFailureCount: 1,
      }),
    );

    const questions = makeQuestions();
    let validatorAsks = true;
    let receivedResume: readonly ResumeUserInputContext[] | undefined;
    const validateContextCompletion = vi.fn(
      async (validateInput: GraphWorkflowContextValidationInput) => {
        receivedResume = validateInput.resumeUserInputs;
        if (validatorAsks) {
          return {
            kind: "asked_user" as const,
            parked: [
              {
                assignmentId: "general",
                conversationId: CONV_VALIDATOR,
                questionBatchId: VALIDATOR_BATCH_ID,
                questions,
              },
            ] as [CohortParkedLane, ...CohortParkedLane[]],
          };
        }
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

    const runAgentIteration = vi.fn(async () => {
      throw new Error("validation-only path must not run the implementer");
    });

    const orchestrator = createContextIterationFixture({
      ...createContextTestCapabilities(),
      materializeWorkflowDocuments: async ({ execution }) => execution,

      executionContract: createTestGraphExecutionContract(),

      executionRepository: repository,
      findLatestContextValidationEvent: async () => null,
      createConversation: vi.fn(),
      runAgentIteration,
      validationService: { validateContextCompletion },
      userInputGateService: gate,
      readLaneConversation: vi.fn(async () => ({
        pendingQuestionId: null,
        pendingQuestions: [] as AskQuestionItem[],
      })),
      eventPublisher,
      now: () => NOW,
    });

    // --- Ask turn: the validator asks; the context parks as context_validator ---
    const askResult = await orchestrator.runIteration({
      projectPath: PROJECT_PATH,
      projectName: "repo",
      sessionName: SESSION_NAME,
      contextId: CONTEXT_ID,
    });

    expect(runAgentIteration).not.toHaveBeenCalled();
    expect(validateContextCompletion).toHaveBeenCalledTimes(1);
    expect(askResult.decision.kind).toBe("await_user_input");

    const parked = await reloadContext();
    expect(parked.contextState.status).toBe("awaiting_user_input");
    expect(
      parked.contextState.pendingUserInputs["context_validator:general"],
    ).toMatchObject({
      conversationId: CONV_VALIDATOR,
      lane: "context_validator",
      questionBatchId: VALIDATOR_BATCH_ID,
      questions,
      answers: null,
    });
    // Req 3.2: a validator question is never a validation failure.
    expect(parked.contextState.consecutiveFailureCount).toBe(1);
    expect(parked.execution.taskStates["task-plan-1"]?.status).toBe(
      "completed",
    );
    expect(
      parked.execution.taskStates["task-plan-1"]?.failureHistory,
    ).toHaveLength(0);
    expect(
      broadcasted.some(
        (e) =>
          e.type === "graph-workflow-validation-result" &&
          "contextId" in e &&
          e.contextId === CONTEXT_ID,
      ),
    ).toBe(false);

    // --- Answer + consume ---
    const recorded = await gate.recordAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONV_VALIDATOR,
      questionBatchId: VALIDATOR_BATCH_ID,
      answers: makeAnswers(),
    });
    expect(recorded).toEqual({ ok: true });

    const consumed = await gate.consumeAnswers({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: CONTEXT_ID,
    });
    expect(consumed).toMatchObject([
      {
        laneKey: "context_validator:general",
        lane: "context_validator",
        questionBatchId: VALIDATOR_BATCH_ID,
        conversationId: CONV_VALIDATOR,
      },
    ]);

    const afterConsume = await reloadContext();
    expect(afterConsume.contextState.pendingUserInputs).toEqual({});
    expect(afterConsume.contextState.status).toBe("running");

    // --- Resume: the validator re-runs and its verdict is processed normally ---
    validatorAsks = false;
    const resumeResult = await orchestrator.runIteration({
      projectPath: PROJECT_PATH,
      projectName: "repo",
      sessionName: SESSION_NAME,
      contextId: CONTEXT_ID,
      resumeUserInputs: consumed,
    });

    // Req 5.1/5.5: the validator resume forwards the answers into re-validation.
    expect(receivedResume).toEqual(consumed);
    expect(validateContextCompletion).toHaveBeenCalledTimes(2);
    expect(resumeResult.decision.kind).toBe("ready_to_land");

    const resumed = await reloadContext();
    expect(resumed.contextState.pendingUserInputs).toEqual({});
    // The verdict is processed exactly as an ordinary pass would be.
    expect(resumed.contextState.status).toBe("completed");
    expect(
      broadcasted.some(
        (e) =>
          e.type === "graph-workflow-validation-result" &&
          "contextId" in e &&
          e.contextId === CONTEXT_ID,
      ),
    ).toBe(true);
  });
});
