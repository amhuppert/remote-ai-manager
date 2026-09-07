import { askQuestionItemSchema } from "@/lib/conversations/schemas";
import { resolveConversationPersistenceAdapter } from "./persistence-adapter";
import { afterEach, expect, it } from "vitest";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";
import type { ConversationBackendTurnResult } from "@/lib/agent-backends/conversation";
import { createAnswerHandlers } from "@/lib/conversations/answer-route-handlers";
import { queueMessage } from "@/lib/prompt/queue";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { vi } from "vitest";
import type { AgentTaskRequest } from "@/lib/agent-backends/task";

const result: ConversationBackendTurnResult = {
  backendRef: null,
  costUsd: 0,
  durationMs: 1,
  numTurns: 1,
  contextTokens: 1,
  contextWindowMax: 200000,
  contentBlocks: [],
  aborted: false,
  compacted: false,
  failure: null,
  continuationDisposition: "retain",
};
let fixture: Awaited<ReturnType<typeof createLifecycleFixture>> | undefined;
let finish: ReturnType<
  typeof Promise.withResolvers<ConversationBackendTurnResult>
>;
afterEach(async () => {
  finish?.resolve(result);
  await fixture?.close();
  fixture = undefined;
});

it.each([
  { persistence: "durable", role: "validator", canAsk: true },
  { persistence: "durable", role: null, canAsk: false },
  { persistence: "ephemeral", role: "validator", canAsk: false },
] as const)(
  "grants task questioning only to a durable validator: %j",
  async ({ persistence, role, canAsk }) => {
    const started = Promise.withResolvers<AgentTaskRequest>();
    const release = Promise.withResolvers<void>();
    fixture = await createLifecycleFixture({
      conversation: { role },
      ...(persistence === "ephemeral"
        ? {
            binding: {
              kind: "ephemeral",
              address: {
                projectPath: "/lifecycle-fixture",
                target: {
                  scope: "session",
                  projectName: "lifecycle-fixture",
                  sessionName: "s",
                  conversationId: "c",
                },
              },
              backend: "claude",
              role,
              worktreePath: "/lifecycle-fixture/.worktrees/s",
            },
          }
        : {}),
      actorDeps: {
        getTaskRunner: () => ({
          backend: "claude",
          async run(request) {
            started.resolve(request);
            await release.promise;
            return {
              text: "Waiting for the answer",
              usage: null,
              error: null,
              timedOut: false,
              failure: null,
              continuationDisposition: "retain",
            };
          },
        }),
      },
    });
    const hosted = fixture;
    const admission = await hosted.manager.submitConversationTurn({
      binding: hosted.binding,
      turn: {
        kind: "task_run",
        executionClass: "governed-execution",
        promptText: "Review after asking",
      },
    });
    if (admission.kind !== "accepted") throw new Error(admission.message);
    try {
      expect((await started.promise).ccSessionScope).toEqual(
        canAsk
          ? {
              project: "lifecycle-fixture",
              session: "s",
              conversationId: "c",
            }
          : undefined,
      );
      expect(
        await hosted.manager.registerConversationQuestion(
          "/lifecycle-fixture",
          "s",
          "c",
          {
            questionId: "validator-batch",
            questions: [
              askQuestionItemSchema.parse({
                id: "choice",
                question: "Which path?",
                options: [{ label: "A" }],
              }),
            ],
          },
        ),
      ).toBe(canAsk);
    } finally {
      release.resolve();
      await admission.turn.completed;
    }
    const stored = await hosted.persistence
      .recreateStore()
      .getConversation("/lifecycle-fixture", "s", "c");
    if (persistence === "ephemeral") {
      expect(stored).toBeNull();
      return;
    }
    expect(stored).toMatchObject({
      role,
      status: canAsk ? "waiting_for_input" : "awaiting",
      pendingQuestionId: canAsk ? "validator-batch" : null,
      promptCount: 1,
    });
  },
);

it("does not let an old answer withdraw a later question batch", async () => {
  finish = Promise.withResolvers<ConversationBackendTurnResult>();
  const started = Promise.withResolvers<void>();
  fixture = await createLifecycleFixture({
    actorDeps: {
      getConversationBackendFactory: () => ({
        backend: "claude",
        validateModelSelection() {},
        createRuntime: async () =>
          createMockBackendRuntime({
            sendTurn: async () => {
              started.resolve();
              return finish.promise;
            },
            close: async () => {
              finish.resolve(result);
            },
          }),
      }),
    },
  });
  const admission = await fixture.manager.submitConversationTurn({
    binding: fixture.binding,
    turn: { promptText: "Ask a question" },
  });
  if (admission.kind !== "accepted") throw new Error(admission.message);
  await started.promise;
  const questions = [
    askQuestionItemSchema.parse({
      id: "choice",
      question: "Which path?",
      options: [{ label: "A" }, { label: "B" }],
    }),
  ];
  await fixture.manager.registerConversationQuestion(
    "/lifecycle-fixture",
    "s",
    "c",
    { questionId: "batch-a", questions },
  );
  await fixture.manager.clearConversationQuestion(
    "/lifecycle-fixture",
    "s",
    "c",
    { questionId: "batch-a" },
  );
  await fixture.manager.registerConversationQuestion(
    "/lifecycle-fixture",
    "s",
    "c",
    { questionId: "batch-b", questions },
  );
  await resolveConversationPersistenceAdapter("durable").whenDurable(
    fixture.actor("/lifecycle-fixture", "s", "c")!.getSnapshot().context,
  );
  expect(
    (
      await fixture.persistence.store.getConversation(
        "/lifecycle-fixture",
        "s",
        "c",
      )
    )?.pendingQuestionId,
  ).toBe("batch-b");
  await fixture.manager.clearConversationQuestion(
    "/lifecycle-fixture",
    "s",
    "c",
    { questionId: "batch-a" },
  );
  finish.resolve(result);
  await admission.turn.completed;
  expect(
    (
      await fixture.persistence.store.getConversation(
        "/lifecycle-fixture",
        "s",
        "c",
      )
    )?.pendingQuestionId,
  ).toBe("batch-b");
});

it.each(["running", "parked", "restarted"] as const)(
  "delivers a %s ordinary question answer once on its own queued turn",
  async (state) => {
    finish = Promise.withResolvers<ConversationBackendTurnResult>();
    const started = Promise.withResolvers<void>();
    const prompts: string[] = [];
    let backendCloses = 0;
    const transcript: TranscriptEntry[] = [];
    const liveInput = vi.fn(async () => {});
    const backend = createMockBackendRuntime({
      sendTurn: async (input) => {
        prompts.push(input.promptText);
        await input.onEvent({ type: "input_accepted" });
        if (prompts.length === 1) {
          started.resolve();
          return finish.promise;
        }
        return result;
      },
      close: async () => {
        backendCloses++;
        finish.resolve(result);
      },
      queueUserInput: liveInput,
    });
    fixture = await createLifecycleFixture({
      actorDeps: {
        getConversationBackendFactory: () => ({
          backend: "claude",
          validateModelSelection() {},
          createRuntime: async () => backend,
        }),
        appendTranscriptEntryOnce: async (_id, entry) => {
          if (!transcript.some((stored) => stored.id === entry.id))
            transcript.push(entry);
        },
      },
    });
    const hosted = fixture;
    const admission = await hosted.manager.submitConversationTurn({
      binding: hosted.binding,
      turn: { promptText: "Ask" },
    });
    if (admission.kind !== "accepted") throw new Error(admission.message);
    await started.promise;
    await hosted.manager.registerConversationQuestion(
      "/lifecycle-fixture",
      "s",
      "c",
      {
        questionId: "ordinary-batch",
        questions: [
          askQuestionItemSchema.parse({
            id: "choice",
            question: "Which path?",
            options: [{ label: "A" }],
          }),
        ],
      },
    );
    if (state !== "running") {
      finish.resolve(result);
      await admission.turn.completed;
    }
    if (state === "restarted") {
      await hosted.manager.stopAllConversationActors();
      expect(backendCloses).toBe(1);
      expect(hosted.actor("/lifecycle-fixture", "s", "c")).toBeUndefined();
      const restoredStore = hosted.persistence.recreateStore();
      expect(
        await restoredStore.getConversation("/lifecycle-fixture", "s", "c"),
      ).toMatchObject({
        status: "waiting_for_input",
        pendingQuestionId: "ordinary-batch",
      });
      expect(
        restoredStore.getConversationMachineSnapshot("session", "c"),
      ).toMatchObject({
        value: "waitingForInput",
        context: { pendingQuestion: { questionId: "ordinary-batch" } },
      });
    }
    const queuedIds: string[] = [];
    const handlers = createAnswerHandlers({
      resolveProjectPath: async () => "/lifecycle-fixture",
      getConversation: hosted.persistence.store.getConversation,
      clearConversationQuestion: hosted.manager.clearConversationQuestion,
      ensureConversationActorAndDrain:
        hosted.manager.ensureConversationActorAndDrain,
      recordLaneAnswers: async () => {
        throw new Error("Ordinary answer reached graph delivery");
      },
      clearPendingQuestion: async () => {
        throw new Error("Ordinary answer bypassed atomic enqueue");
      },
      readConfig: async () => ({ defaultAgentBackend: "claude" }),
      log: createCapturingLogger(),
      queueMessage: async (params) =>
        queueMessage({
          ...params,
          deps: {
            ...hosted.queue,
            getRuntime: () => backend,
            enqueue: async (input) => {
              const row = await hosted.queue.enqueue(input);
              if (row) queuedIds.push(row.id);
              return row;
            },
            getProjectDisplayName: () => "lifecycle-fixture",
          },
        }),
    });
    const answer = () =>
      handlers.POST(
        new Request("http://fixture/answer", {
          method: "POST",
          body: JSON.stringify({
            questionId: "ordinary-batch",
            answers: {
              choice: {
                selected: ["A"],
                skipped: false,
                note: null,
                question: "Which path?",
              },
            },
          }),
        }),
        {
          params: Promise.resolve({
            name: "lifecycle-fixture",
            session: "s",
            conversationId: "c",
          }),
        },
      );
    expect((await answer()).status).toBe(200);
    expect((await answer()).status).toBe(410);
    expect(liveInput).not.toHaveBeenCalled();
    if (state === "running") {
      expect(prompts).toEqual(["Ask"]);
      finish.resolve(result);
      await admission.turn.completed;
    }
    await vi.waitFor(async () =>
      expect(
        (
          await hosted.persistence.store.getConversation(
            "/lifecycle-fixture",
            "s",
            "c",
          )
        )?.totalTurns,
      ).toBe(2),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      '<cc-question-answers batch="ordinary-batch">',
    );
    expect(queuedIds).toHaveLength(1);
    expect(transcript).toMatchObject([{ id: queuedIds[0], type: "user" }]);
    expect(transcript).toHaveLength(1);
    expect(
      (
        await hosted.persistence.store.getConversation(
          "/lifecycle-fixture",
          "s",
          "c",
        )
      )?.pendingQueue,
    ).toEqual([]);
  },
);
