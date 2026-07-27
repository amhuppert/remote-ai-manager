import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromPromise } from "xstate";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { StateStore } from "@/lib/state-store/store";
import { queueMessage, type QueueMessageDeps } from "@/lib/prompt/queue";
import { loadActorInput } from "@/lib/workflows/conversation/actor-input-loader";
import { applySyncDerivedFields } from "@/lib/workflows/conversation/persistence-adapter";
import {
  createProvidedMachine,
  ensureConversationActorAndDrain,
  getConversationActor,
  sendConversationEvent,
  setEnsureConversationActorDeps,
  setMachineFactory,
  startConversationActor,
  _resetForTesting,
  _resetEnsureConversationActorDepsForTesting,
  _resetMachineFactoryForTesting,
} from "@/lib/workflows/conversation/manager";
import {
  setConversationQueueDeps,
  _resetConversationQueueDepsForTesting,
} from "@/lib/conversations/message-queue-drain";
import {
  setPersistenceDeps,
  _resetForTesting as _resetSnapshotPersistenceForTesting,
} from "@/lib/workflows/conversation/persistence";
import type {
  ExecutePromptInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  PromptActorResult,
} from "@/lib/workflows/conversation/types";
import { createProjectAskQuestionHandlers } from "./ask-route-handlers";
import { createProjectAnswerHandlers } from "./answer-route-handlers";
import { createMessageQueueService } from "./message-queue-service";
import { parseQuestionAnswersBlock } from "./question-answers-block";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";

/**
 * ACCEPTANCE GATE for the project Ask/Answer slice (R4.3).
 *
 * Four blockers stack between a project agent asking and a user answering, and
 * the one that survives naive testing only appears when the asking runtime is
 * gone: the shared actor input loader is session-keyed, so materializing an
 * actor for a project conversation died with `Session not found: __project__`
 * and the queued answer was never delivered.
 *
 * A same-process test cannot see that — the live actor is returned from the
 * registry and the loader never runs. So this drives the REAL ask handler
 * against a real SQLite store, then destroys every live actor AND rebuilds the
 * store over the same database (what a restarted server comes up with) before
 * answering through the real project answer route.
 */

const PROJECT_PATH = "/repos/cc";
const CONVERSATION_ID = "conv-1";
const ts = "2026-01-01T00:00:00.000Z";

const askBody = {
  questions: [
    {
      id: "approach",
      question: "Which approach?",
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
};

const answers = {
  approach: {
    selected: ["A"],
    note: "with caveats",
    skipped: false,
    question: "Which approach?",
  },
};

describe("project answer after runtime + store teardown (R4.3)", () => {
  let fixture: ReturnType<typeof createPersistenceFixture>;
  /** Rebuilt after teardown — every phase-2 read/write goes through this. */
  let store: StateStore;
  let syncWrites: Promise<unknown>[];
  /** Prompt texts the agent actually received, in delivery order. */
  let delivered: string[];
  let rowCounter: number;

  beforeEach(async () => {
    fixture = createPersistenceFixture();
    store = fixture.store;
    syncWrites = [];
    delivered = [];
    rowCounter = 0;

    fixture.seedProject(PROJECT_PATH);
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      conversationStateSchema.parse({
        id: CONVERSATION_ID,
        scope: "project",
        status: "idle",
        transcriptPath: null,
        promptCount: 0,
        createdAt: ts,
        lastActivityAt: ts,
        agentBackend: "claude",
      }),
    );

    // Snapshot durability has its own contract; an inert seam here also makes
    // the teardown honest — nothing can restore an actor from a snapshot, so
    // recovery must come from the conversation record.
    setPersistenceDeps({
      getConversationMachineSnapshot: () => null,
      upsertConversationMachineSnapshot: async () => {},
      deleteConversationMachineSnapshot: async () => {},
    });

    // The exact machine production starts actors with, with the backend actors
    // faked. `executePrompt` records the prompt text it was handed — that is
    // how "the queued answer drains to the agent" is observed.
    setMachineFactory((adapter) =>
      createProvidedMachine(adapter).provide({
        actors: {
          prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
            async () => ({ transcriptPath: "/tmp/t.jsonl" }),
          ),
          executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
            async ({ input }) => {
              delivered.push(input.promptText);
              // Held open: the asking turn must still be running when the ask
              // arrives, and the answering turn's completion is not what this
              // gate is about.
              return new Promise<PromptActorResult>(() => {});
            },
          ),
        },
        actions: {
          syncDerivedFields: ({ context }) => {
            syncWrites.push(
              store.mutateConversation(
                context.projectPath,
                context.sessionName,
                context.conversationId,
                "test.syncDerived",
                (c) => applySyncDerivedFields(context, c),
              ),
            );
          },
          persistSnapshot: () => {},
          broadcastConversationStatus: () => {},
          broadcastAskQuestion: () => {},
          broadcastDebugModeStatus: () => {},
          releaseResources: () => {},
          dispatchPushNotification: () => {},
          markUnreadOnFinish: () => {},
          markReadOnUserTurnStart: () => {},
        },
      }),
    );

    // The queue seams are the production service over whichever store is
    // current — rebound after teardown so phase 2 reads nothing phase 1 left in
    // memory.
    rebindStoreSeams();
  });

  afterEach(async () => {
    _resetForTesting();
    // Derived-field writes are fire-and-forget; letting them settle before the
    // database closes keeps a teardown race out of the run.
    await Promise.allSettled(syncWrites);
    _resetMachineFactoryForTesting();
    _resetEnsureConversationActorDepsForTesting();
    _resetConversationQueueDepsForTesting();
    _resetSnapshotPersistenceForTesting();
    fixture.close();
  });

  /** Point every injected store seam at the CURRENT `store` instance. */
  function rebindStoreSeams(): void {
    const svc = createMessageQueueService({
      mutateConversation: store.mutateConversation,
      getConversation: store.getConversation,
      getProjectDisplayName: () => "cc",
      broadcast: () => {},
      now: () => ts,
      newId: () => `row-${++rowCounter}`,
    });
    setConversationQueueDeps({
      claimNextTurnBatch: (input) => svc.claimNextTurnBatch(input),
      markPending: (input) => svc.markPending(input),
      markDelivered: (input) => svc.markDelivered(input),
      markFailed: (input) => svc.markFailed(input),
      recoverAbandonedDeliveries: (input) =>
        svc.recoverAbandonedDeliveries(input),
      runConversationCommand: async () => {
        throw new Error("no command expected");
      },
    });
    // The PRODUCTION loader, over the current repositories. Injecting the store
    // (not the decision) is the point: the scope branch under test is real.
    setEnsureConversationActorDeps({
      loadActorInput: (projectPath, sessionName, conversationId) =>
        loadActorInput(
          {
            getSession: store.getSession,
            getProjectConversation: store.getProjectConversation,
            getProjectDisplayName: () => "cc",
          },
          projectPath,
          sessionName,
          conversationId,
        ),
    });
  }

  function queueDeps(svcStore: StateStore): Partial<QueueMessageDeps> {
    const svc = createMessageQueueService({
      mutateConversation: svcStore.mutateConversation,
      getConversation: svcStore.getConversation,
      getProjectDisplayName: () => "cc",
      broadcast: () => {},
      now: () => ts,
      newId: () => `row-${++rowCounter}`,
    });
    return {
      enqueue: (input) => svc.enqueue(input),
      claimLiveDelivery: (input) => svc.claimLiveDelivery(input),
      markDelivered: (input) => svc.markDelivered(input),
      markPending: (input) => svc.markPending(input),
      getRuntime: () => undefined,
      appendTranscriptEntry: async () => {},
      getProjectDisplayName: () => "cc",
    };
  }

  function authAllows(): AgentAuth {
    return {
      async requireToken() {
        return null;
      },
      async validateOptionalToken() {
        return { kind: "valid" };
      },
    };
  }

  function askHandlers() {
    return createProjectAskQuestionHandlers({
      auth: authAllows(),
      async resolveProjectPath() {
        return PROJECT_PATH;
      },
      getProjectConversation: (p, c) => store.getProjectConversation(p, c),
      sendConversationEvent,
      generateQuestionBatchId: () => "q_gate1",
      log: createCapturingLogger(),
    });
  }

  /** The real project answer route, wired to the CURRENT store. */
  function answerHandlers() {
    const deps = queueDeps(store);
    return createProjectAnswerHandlers({
      async resolveProjectPath() {
        return PROJECT_PATH;
      },
      getProjectConversation: (p, c) => store.getProjectConversation(p, c),
      sendConversationEvent,
      queueMessage: (params) => queueMessage({ ...params, deps }),
      // The REAL materialization + drain — the seam the defect lived in.
      ensureConversationActorAndDrain,
      async readConfig() {
        return { defaultAgentBackend: "claude" as const };
      },
      log: createCapturingLogger(),
    });
  }

  const params = Promise.resolve({
    name: "cc",
    conversationId: CONVERSATION_ID,
  });

  function jsonRequest(path: string, body: unknown): Request {
    return new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function reload() {
    await Promise.all(syncWrites);
    return store.getProjectConversation(PROJECT_PATH, CONVERSATION_ID);
  }

  /** Phase 1: a live project turn asks, and the batch lands durably. */
  async function askOnALiveTurn(): Promise<void> {
    const actor = startConversationActor({
      conversationScope: "project",
      projectPath: PROJECT_PATH,
      projectName: "cc",
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      worktreePath: PROJECT_PATH,
      conversationId: CONVERSATION_ID,
      createdAt: ts,
      forkedFrom: null,
      role: null,
      transcriptPath: null,
      agentBackend: "claude",
      backendRef: null,
      promptCount: 0,
      persistence: "durable",
    });
    actor.send({
      type: "SUBMIT_PROMPT",
      promptText: "start",
      streamId: "s1",
    });
    await vi.waitFor(() => {
      expect(JSON.stringify(actor.getSnapshot().value)).toContain("executing");
    });

    const res = await askHandlers().POST(
      jsonRequest(
        `/api/projects/cc/conversations/${CONVERSATION_ID}/ask`,
        askBody,
      ),
      { params },
    );
    expect(res.status).toBe(200);

    await vi.waitFor(async () => {
      const row = await reload();
      expect(row?.pendingQuestionId).toBe("q_gate1");
      expect(row?.status).toBe("waiting_for_input");
    });
  }

  /**
   * Destroy every live actor and rebuild the store over the same database. What
   * survives is exactly what a restarted server would find on disk.
   */
  function tearDownRuntimeAndStore(): void {
    _resetForTesting();
    store = fixture.recreateStore();
    rebindStoreSeams();
    expect(
      getConversationActor(
        PROJECT_PATH,
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        CONVERSATION_ID,
      ),
    ).toBeUndefined();
  }

  it("consumes the durable marker exactly once and drains the answer to the agent", async () => {
    await askOnALiveTurn();
    tearDownRuntimeAndStore();

    // The user answers the question they were left with. Nothing about this
    // conversation is in memory.
    const res = await answerHandlers().POST(
      jsonRequest(`/api/projects/cc/conversations/${CONVERSATION_ID}/answer`, {
        questionId: "q_gate1",
        answers,
      }),
      { params },
    );
    expect(res.status).toBe(200);

    // Delivery: a fresh actor was materialized for a SESSION-LESS conversation
    // and the queued answer reached the agent. Before the loader was made
    // scope-aware this threw `Session not found: __project__` and the answer
    // sat in the queue forever.
    const promptText = await vi.waitFor(() => {
      expect(delivered).toHaveLength(2);
      return delivered[1] ?? "";
    });
    expect(parseQuestionAnswersBlock(promptText)).toEqual({
      questionBatchId: "q_gate1",
      answers,
    });

    // Exactly once: the marker is consumed and its questions cleared, the row
    // is delivered rather than left pending, and a duplicate is refused.
    const reloaded = await reload();
    expect(reloaded?.pendingQuestionId).toBeNull();
    expect(reloaded?.pendingQuestions).toBeNull();
    expect(
      reloaded?.pendingQueue.filter((m) => m.status === "pending"),
    ).toHaveLength(0);

    const duplicate = await answerHandlers().POST(
      jsonRequest(`/api/projects/cc/conversations/${CONVERSATION_ID}/answer`, {
        questionId: "q_gate1",
        answers,
      }),
      { params },
    );
    expect(duplicate.status).toBe(410);
    expect(delivered).toHaveLength(2);
  });

  it("binds the recovered actor to the project root, not a session worktree", async () => {
    await askOnALiveTurn();
    tearDownRuntimeAndStore();

    await answerHandlers().POST(
      jsonRequest(`/api/projects/cc/conversations/${CONVERSATION_ID}/answer`, {
        questionId: "q_gate1",
        answers,
      }),
      { params },
    );

    const actor = await vi.waitFor(() => {
      const found = getConversationActor(
        PROJECT_PATH,
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        CONVERSATION_ID,
      );
      expect(found).toBeDefined();
      return found;
    });
    const context = actor?.getSnapshot().context;
    // A project conversation executes in the project root; there is no session
    // worktree to bind to, and binding to a guessed one would run the agent in
    // the wrong tree.
    expect(context?.worktreePath).toBe(PROJECT_PATH);
    expect(context?.conversationScope).toBe("project");
  });
});
