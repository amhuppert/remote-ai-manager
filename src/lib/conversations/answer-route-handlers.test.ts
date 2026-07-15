import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { queueMessage, type QueueMessageDeps } from "@/lib/prompt/queue";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { RecordAnswersResult } from "@/lib/workflow-graph/user-input-gate";
import {
  createAnswerHandlers,
  type AnswerRouteDeps,
} from "./answer-route-handlers";
import { createMessageQueueService } from "./message-queue-service";
import { parseQuestionAnswersBlock } from "./question-answers-block";
import {
  conversationStateSchema,
  type AskQuestionAnswer,
  type ConversationState,
} from "./schemas";

const ts = "2026-01-01T00:00:00.000Z";
const PROJECT = "/repo";
const SESSION = "feat";
const CONV = "conv-1";

const answers: Record<string, AskQuestionAnswer> = {
  approach: {
    selected: ["A"],
    note: "with caveats",
    skipped: false,
    question: "Which approach?",
  },
};

function seedConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return conversationStateSchema.parse({
    id: CONV,
    scope: "session",
    transcriptPath: null,
    status: "waiting_for_input",
    promptCount: 1,
    createdAt: ts,
    lastActivityAt: ts,
    agentBackend: "claude",
    pendingQuestionId: "q_b1",
    pendingQuestions: [
      {
        id: "approach",
        question: "Which approach?",
        options: [{ label: "A" }],
      },
    ],
    ...overrides,
  });
}

function makeRequest(body: unknown): Request {
  return new Request(
    `http://127.0.0.1/api/projects/repo/sessions/${SESSION}/conversations/${CONV}/answer`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

const params = Promise.resolve({
  name: "repo",
  session: SESSION,
  conversationId: CONV,
});

describe("POST conversation answer (async consume + enqueue)", () => {
  let fixture: PersistenceFixture;
  let rowCounter: number;
  let failNextEnqueueWrite: boolean;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT);
    fixture.seedSession(PROJECT, SESSION);
    rowCounter = 0;
    failNextEnqueueWrite = false;
  });

  afterEach(() => {
    fixture.close();
  });

  function makeDeps(
    overrides: Partial<AnswerRouteDeps> = {},
    queueDepsOverrides: Partial<QueueMessageDeps> = {},
  ): {
    deps: AnswerRouteDeps;
    sendEvent: ReturnType<typeof vi.fn>;
    drain: ReturnType<typeof vi.fn>;
    queueMessageSpy: ReturnType<typeof vi.fn>;
    recordLaneAnswers: ReturnType<typeof vi.fn>;
  } {
    const svc = createMessageQueueService({
      mutateConversation: (
        projectPath,
        sessionName,
        conversationId,
        label,
        fn,
      ) => {
        if (failNextEnqueueWrite && label === "enqueueQueuedMessage") {
          failNextEnqueueWrite = false;
          throw new Error("simulated write failure");
        }
        return fixture.deps.mutateConversation(
          projectPath,
          sessionName,
          conversationId,
          label,
          fn,
        );
      },
      getConversation: fixture.deps.getConversation,
      getProjectDisplayName: () => "repo",
      broadcast: () => {},
      now: () => ts,
      newId: () => `row-${++rowCounter}`,
    });
    const queueDeps: Partial<QueueMessageDeps> = {
      enqueue: (input) => svc.enqueue(input),
      claimLiveDelivery: (input) => svc.claimLiveDelivery(input),
      markDelivered: (input) => svc.markDelivered(input),
      markPending: (input) => svc.markPending(input),
      getRuntime: () => undefined,
      appendTranscriptEntry: async () => {},
      getProjectDisplayName: () => "repo",
      ...queueDepsOverrides,
    };

    const sendEvent = vi.fn(() => true);
    const drain = vi.fn(async () => {});
    const queueMessageSpy = vi.fn((p: Parameters<typeof queueMessage>[0]) =>
      queueMessage({ ...p, deps: queueDeps }),
    );
    const recordLaneAnswers = vi.fn(
      async (): Promise<RecordAnswersResult> => ({ ok: true }),
    );

    const deps: AnswerRouteDeps = {
      async resolveProjectPath() {
        return PROJECT;
      },
      getConversation: fixture.deps.getConversation,
      sendConversationEvent: sendEvent,
      queueMessage: queueMessageSpy,
      ensureConversationActorAndDrain: drain,
      recordLaneAnswers,
      async readConfig() {
        return { defaultAgentBackend: "claude" as const };
      },
      ...overrides,
    };
    return { deps, sendEvent, drain, queueMessageSpy, recordLaneAnswers };
  }

  it("answer while idle/waiting: consumes the marker and enqueues the block, then drains", async () => {
    await fixture.seedConversation(PROJECT, SESSION, seedConversation());
    const { deps, drain } = makeDeps();
    const { POST } = createAnswerHandlers(deps);

    const res = await POST(makeRequest({ questionId: "q_b1", answers }), {
      params,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    // Assert on the RELOADED state — the round-trip through SQLite.
    const reloaded = await fixture.deps.getConversation(PROJECT, SESSION, CONV);
    expect(reloaded?.pendingQuestionId).toBeNull();
    expect(reloaded?.pendingQuestions).toBeNull();

    const row = reloaded?.pendingQueue[0];
    expect(row).toBeDefined();
    expect(row?.metadata).toEqual({
      kind: "question_answers",
      questionBatchId: "q_b1",
    });
    const text = row?.content.find((b) => b.type === "text");
    expect(text?.type).toBe("text");
    const parsed = parseQuestionAnswersBlock(
      text?.type === "text" ? text.text : "",
    );
    expect(parsed).toEqual({ questionBatchId: "q_b1", answers });

    // The standard submission path delivers the queued row as the next turn.
    expect(drain).toHaveBeenCalledWith(PROJECT, SESSION, CONV);
  });

  it("answer while the asking turn is still running: queues and clears the machine's pending question", async () => {
    await fixture.seedConversation(
      PROJECT,
      SESSION,
      seedConversation({ status: "running" }),
    );
    const { deps, sendEvent } = makeDeps();
    const { POST } = createAnswerHandlers(deps);

    const res = await POST(makeRequest({ questionId: "q_b1", answers }), {
      params,
    });

    expect(res.status).toBe(200);
    const reloaded = await fixture.deps.getConversation(PROJECT, SESSION, CONV);
    expect(reloaded?.pendingQuestionId).toBeNull();
    expect(reloaded?.pendingQueue).toHaveLength(1);
    expect(sendEvent).toHaveBeenCalledWith(PROJECT, SESSION, CONV, {
      type: "CLEAR_PENDING_QUESTION",
    });
  });

  it("answer while running is NEVER live-delivered into the asking turn (doc 03 §5: next turn only)", async () => {
    await fixture.seedConversation(
      PROJECT,
      SESSION,
      seedConversation({ status: "running" }),
    );
    // A live Claude runtime exists (in_turn backend capability) — a typed
    // message would be delivered into the running turn. The answer must not
    // be: it stays a pending queue row for the next-turn drain.
    const queueUserInput = vi.fn(async () => {});
    const runtime: ConversationBackendRuntime = {
      backend: "claude",
      status: "alive",
      modelId: undefined,
      reasoningEffort: undefined,
      outputFormat: undefined,
      alignmentVersion: null,
      sendTurn: vi.fn(async () => {
        throw new Error("sendTurn must not run in the answer path");
      }),
      queueUserInput,
      close: vi.fn(() => {}),
    };
    const { deps } = makeDeps({}, { getRuntime: () => runtime });
    const { POST } = createAnswerHandlers(deps);

    const res = await POST(makeRequest({ questionId: "q_b1", answers }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(queueUserInput).not.toHaveBeenCalled();

    const reloaded = await fixture.deps.getConversation(PROJECT, SESSION, CONV);
    expect(reloaded?.pendingQueue).toHaveLength(1);
    expect(reloaded?.pendingQueue[0]?.status).toBe("pending");
  });

  it("duplicate POST: first consumes, second gets 410 and enqueues nothing", async () => {
    await fixture.seedConversation(PROJECT, SESSION, seedConversation());
    const { deps } = makeDeps();
    const { POST } = createAnswerHandlers(deps);

    const first = await POST(makeRequest({ questionId: "q_b1", answers }), {
      params,
    });
    expect(first.status).toBe(200);

    const second = await POST(makeRequest({ questionId: "q_b1", answers }), {
      params,
    });
    expect(second.status).toBe(410);
    const body = (await second.json()) as { error: string };
    expect(body.error).toContain("already answered or superseded");

    const reloaded = await fixture.deps.getConversation(PROJECT, SESSION, CONV);
    expect(reloaded?.pendingQueue).toHaveLength(1);
  });

  it("a failed enqueue write leaves the marker intact so a retry succeeds (atomic consume+enqueue)", async () => {
    await fixture.seedConversation(PROJECT, SESSION, seedConversation());
    const { deps } = makeDeps();
    const { POST } = createAnswerHandlers(deps);

    failNextEnqueueWrite = true;
    await expect(
      POST(makeRequest({ questionId: "q_b1", answers }), { params }),
    ).rejects.toThrow("simulated write failure");

    // The consume and the enqueue are one durable write: if the write failed,
    // the marker must NOT have been consumed — the answer is retryable.
    const afterFailure = await fixture.deps.getConversation(
      PROJECT,
      SESSION,
      CONV,
    );
    expect(afterFailure?.pendingQuestionId).toBe("q_b1");
    expect(afterFailure?.pendingQueue).toHaveLength(0);

    const retry = await POST(makeRequest({ questionId: "q_b1", answers }), {
      params,
    });
    expect(retry.status).toBe(200);

    const reloaded = await fixture.deps.getConversation(PROJECT, SESSION, CONV);
    expect(reloaded?.pendingQuestionId).toBeNull();
    expect(reloaded?.pendingQueue).toHaveLength(1);
  });

  it("410 when the marker is consumed between the pre-check read and the durable write", async () => {
    await fixture.seedConversation(PROJECT, SESSION, seedConversation());
    // Stale read: the route sees the question still pending, but by the time
    // the durable write runs another request has consumed it.
    const staleConversation = seedConversation();
    const { deps } = makeDeps({
      async getConversation() {
        return staleConversation;
      },
    });
    const { POST } = createAnswerHandlers(deps);

    const first = await POST(makeRequest({ questionId: "q_b1", answers }), {
      params,
    });
    expect(first.status).toBe(200);

    const second = await POST(makeRequest({ questionId: "q_b1", answers }), {
      params,
    });
    expect(second.status).toBe(410);

    const reloaded = await fixture.deps.getConversation(PROJECT, SESSION, CONV);
    expect(reloaded?.pendingQueue).toHaveLength(1);
  });

  it("404 when the questionId does not match the pending batch", async () => {
    await fixture.seedConversation(PROJECT, SESSION, seedConversation());
    const { deps, queueMessageSpy } = makeDeps();
    const { POST } = createAnswerHandlers(deps);

    const res = await POST(makeRequest({ questionId: "q_other", answers }), {
      params,
    });

    expect(res.status).toBe(404);
    expect(queueMessageSpy).not.toHaveBeenCalled();
    const reloaded = await fixture.deps.getConversation(PROJECT, SESSION, CONV);
    expect(reloaded?.pendingQuestionId).toBe("q_b1");
  });

  it("400 for a body that fails answer validation", async () => {
    await fixture.seedConversation(PROJECT, SESSION, seedConversation());
    const { deps, queueMessageSpy } = makeDeps();
    const { POST } = createAnswerHandlers(deps);

    const res = await POST(
      makeRequest({ questionId: "q_b1", answers: { approach: { bogus: 1 } } }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(queueMessageSpy).not.toHaveBeenCalled();
  });

  describe("lane conversation (graph-workflow role) diverts to the gate", () => {
    it("iteration lane: records answers on the gate, clears the marker, NEVER queues or drains", async () => {
      await fixture.seedConversation(
        PROJECT,
        SESSION,
        seedConversation({ role: "iteration" }),
      );
      const { deps, sendEvent, drain, queueMessageSpy, recordLaneAnswers } =
        makeDeps();
      const { POST } = createAnswerHandlers(deps);

      const res = await POST(makeRequest({ questionId: "q_b1", answers }), {
        params,
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });

      // Diverted to the execution record — never the conversation queue.
      expect(recordLaneAnswers).toHaveBeenCalledTimes(1);
      expect(recordLaneAnswers).toHaveBeenCalledWith({
        projectPath: PROJECT,
        sessionName: SESSION,
        conversationId: CONV,
        questionBatchId: "q_b1",
        answers,
      });
      expect(queueMessageSpy).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();

      // The conversation's pending marker is cleared via a machine transition.
      expect(sendEvent).toHaveBeenCalledWith(PROJECT, SESSION, CONV, {
        type: "CLEAR_PENDING_QUESTION",
      });

      // No message was enqueued — the lane conversation's queue stays empty.
      const reloaded = await fixture.deps.getConversation(
        PROJECT,
        SESSION,
        CONV,
      );
      expect(reloaded?.pendingQueue).toHaveLength(0);
    });

    it("validator lane: also diverts to the gate", async () => {
      await fixture.seedConversation(
        PROJECT,
        SESSION,
        seedConversation({ role: "validator" }),
      );
      const { deps, queueMessageSpy, recordLaneAnswers } = makeDeps();
      const { POST } = createAnswerHandlers(deps);

      const res = await POST(makeRequest({ questionId: "q_b1", answers }), {
        params,
      });

      expect(res.status).toBe(200);
      expect(recordLaneAnswers).toHaveBeenCalledTimes(1);
      expect(queueMessageSpy).not.toHaveBeenCalled();
    });

    it("preserves a skipped answer entry verbatim in the gate payload (Req 4.4)", async () => {
      await fixture.seedConversation(
        PROJECT,
        SESSION,
        seedConversation({ role: "iteration" }),
      );
      const skippedAnswers: Record<string, AskQuestionAnswer> = {
        approach: {
          selected: [],
          note: "",
          skipped: true,
          question: "Which approach?",
        },
      };
      const { deps, recordLaneAnswers } = makeDeps();
      const { POST } = createAnswerHandlers(deps);

      const res = await POST(
        makeRequest({ questionId: "q_b1", answers: skippedAnswers }),
        { params },
      );

      expect(res.status).toBe(200);
      expect(recordLaneAnswers).toHaveBeenCalledWith(
        expect.objectContaining({ answers: skippedAnswers }),
      );
    });

    it("a duplicate lane answer (gate reports already_answered) gets 410", async () => {
      await fixture.seedConversation(
        PROJECT,
        SESSION,
        seedConversation({ role: "iteration" }),
      );
      const recordLaneAnswers = vi.fn(
        async (): Promise<RecordAnswersResult> => ({
          ok: false,
          reason: "already_answered",
        }),
      );
      const { deps, queueMessageSpy, drain } = makeDeps({ recordLaneAnswers });
      const { POST } = createAnswerHandlers(deps);

      const res = await POST(makeRequest({ questionId: "q_b1", answers }), {
        params,
      });

      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("already answered or superseded");
      expect(queueMessageSpy).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
    });

    it("a not_found lane answer (superseded batch) gets 410", async () => {
      await fixture.seedConversation(
        PROJECT,
        SESSION,
        seedConversation({ role: "iteration" }),
      );
      const recordLaneAnswers = vi.fn(
        async (): Promise<RecordAnswersResult> => ({
          ok: false,
          reason: "not_found",
        }),
      );
      const { deps } = makeDeps({ recordLaneAnswers });
      const { POST } = createAnswerHandlers(deps);

      const res = await POST(makeRequest({ questionId: "q_b1", answers }), {
        params,
      });

      expect(res.status).toBe(410);
    });

    it("second lane submission is rejected after the first clears the marker", async () => {
      await fixture.seedConversation(
        PROJECT,
        SESSION,
        seedConversation({ role: "iteration" }),
      );
      // The real gate rejects a second recordAnswers for the same batch; model
      // that with a stateful fake so the route's observable status is 410.
      let answered = false;
      const recordLaneAnswers = vi.fn(
        async (): Promise<RecordAnswersResult> => {
          if (answered) return { ok: false, reason: "already_answered" };
          answered = true;
          return { ok: true };
        },
      );
      const { deps } = makeDeps({ recordLaneAnswers });
      const { POST } = createAnswerHandlers(deps);

      const first = await POST(makeRequest({ questionId: "q_b1", answers }), {
        params,
      });
      expect(first.status).toBe(200);

      const second = await POST(makeRequest({ questionId: "q_b1", answers }), {
        params,
      });
      expect(second.status).toBe(410);
    });
  });
});
