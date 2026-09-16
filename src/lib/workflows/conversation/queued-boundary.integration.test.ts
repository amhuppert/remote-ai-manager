import { afterEach, expect, it } from "vitest";
import type { ConversationBackendTurnResult } from "@/lib/agent-backends/conversation";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";

const result: ConversationBackendTurnResult = {
  backendRef: null,
  costUsd: 0.01,
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
let failing = true;
afterEach(async () => {
  failing = false;
  await fixture?.close();
  fixture = undefined;
});

it.each(["preparation", "readiness", "transcript", "receipt"] as const)(
  "retains queued ownership across a real %s failure",
  async (phase) => {
    failing = true;
    let dispatches = 0;
    const transcript: TranscriptEntry[] = [];
    fixture = await createLifecycleFixture({
      actorDeps: {
        acquireQuerySlot: async () => {
          if (phase === "preparation" && failing)
            throw new Error("Capacity service unavailable");
          return () => {};
        },
        getConversationBackendFactory: () => ({
          backend: "claude",
          validateModelSelection() {},
          createRuntime: async () => {
            if (phase === "readiness" && failing)
              throw new Error("Provider readiness unavailable");
            return createMockBackendRuntime({
              sendTurn: async (input) => {
                dispatches++;
                await input.onEvent({ type: "input_accepted" });
                return result;
              },
            });
          },
        }),
        appendTranscriptEntryOnce: async (_id, entry) => {
          if (phase === "transcript" && failing)
            throw new Error("Transcript disk unavailable");
          if (!transcript.some((stored) => stored.id === entry.id))
            transcript.push(entry);
        },
        claimWorkflowResults: async () =>
          phase === "receipt"
            ? [
                {
                  executionId: "workflow",
                  boundarySeq: 1,
                  projectPath: "/lifecycle-fixture",
                  sessionName: "s",
                  originConversationId: "c",
                  payload: { status: "completed", output: "Completed work" },
                  recordedAt: "2026-09-06T10:00:00.000Z",
                  state: "delivering",
                  attemptId: "receipt-attempt",
                  attemptCount: 1,
                  deliveredAt: null,
                  effectsDeliveredAt: null,
                },
              ]
            : [],
        settleWorkflowResults: async () => {
          if (phase === "receipt" && failing)
            throw new Error("Required receipt unavailable");
          return 1;
        },
      },
    });
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    const entry = await fixture.queue.enqueue({
      ...fixture.identity,
      content: [{ type: "text", text: `queued-${phase}` }],
    });
    const claim = await fixture.queue.claimNextTurnBatch(fixture.identity);
    if (!claim) throw new Error("Claim missing");
    const admission = await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: { promptText: `queued-${phase}`, queuedDelivery: claim },
    });
    if (admission.kind !== "accepted") throw new Error(admission.message);
    const settled = await admission.turn.completed;
    const row = await fixture.persistence
      .recreateStore()
      .getConversation(
        fixture.identity.projectPath,
        fixture.identity.sessionName,
        fixture.identity.conversationId,
      );
    if (phase === "receipt") {
      expect(settled.outcome).toMatchObject({
        kind: "settlement_failed",
        code: "delivery_receipt",
      });
      expect(row?.pendingQueue).toMatchObject([
        { id: entry.id, status: "uncertain" },
      ]);
      expect(transcript).toEqual([]);
      expect(dispatches).toBe(1);
      failing = false;
      await fixture.manager.ensureConversationLifecycle(fixture.binding);
      expect(dispatches).toBe(1);
      expect(transcript).toEqual([]);
      expect(
        (
          await fixture.persistence.store.getConversation(
            fixture.identity.projectPath,
            fixture.identity.sessionName,
            fixture.identity.conversationId,
          )
        )?.pendingQueue,
      ).toMatchObject([{ id: entry.id, status: "uncertain" }]);
    } else {
      expect(row?.pendingQueue).toMatchObject([
        { id: entry.id, status: "uncertain" },
      ]);
      expect(
        await fixture.queue.claimNextTurnBatch(fixture.identity),
      ).toBeNull();
      expect(transcript).toEqual([]);
      expect(dispatches).toBe(phase === "transcript" ? 1 : 0);
    }
  },
);

it.each(["missing acknowledgement", "queue settlement"] as const)(
  "retains the durable claim without redelivery after %s failure",
  async (phase) => {
    let dispatches = 0;
    let answerProduced = false;
    const transcript: TranscriptEntry[] = [];
    fixture = await createLifecycleFixture({
      actorDeps: {
        getConversationBackendFactory: () => ({
          backend: "claude",
          validateModelSelection() {},
          createRuntime: async () =>
            createMockBackendRuntime({
              sendTurn: async (input) => {
                dispatches += 1;
                if (phase === "missing acknowledgement")
                  return {
                    ...result,
                    failure: {
                      kind: "backend_error",
                      message: "Written start acknowledgement lost",
                      retryable: false,
                    },
                  };
                await input.onEvent({ type: "input_accepted" });
                await input.onEvent({
                  type: "content",
                  block: { type: "text", text: "completed answer" },
                });
                answerProduced = true;
                return result;
              },
            }),
        }),
        appendTranscriptEntryOnce: async (_id, entry) => {
          transcript.push(entry);
        },
        confirmQueuedDelivery: async () => {
          throw new Error("Queue settlement unavailable");
        },
      },
    });
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    const entry = await fixture.queue.enqueue({
      ...fixture.identity,
      content: [{ type: "text", text: `queued-${phase}` }],
    });
    const claim = await fixture.queue.claimNextTurnBatch(fixture.identity);
    if (!claim) throw new Error("Claim missing");
    const admission = await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: { promptText: `queued-${phase}`, queuedDelivery: claim },
    });
    if (admission.kind !== "accepted") throw new Error(admission.message);
    await admission.turn.completed;
    expect(answerProduced).toBe(phase === "queue settlement");
    expect(transcript.filter((stored) => stored.role === "user")).toHaveLength(
      phase === "queue settlement" ? 1 : 0,
    );
    const row = await fixture.persistence
      .recreateStore()
      .getConversation(
        fixture.identity.projectPath,
        fixture.identity.sessionName,
        fixture.identity.conversationId,
      );
    expect(row?.pendingQueue).toMatchObject([
      { id: entry.id, status: "uncertain" },
    ]);
    expect(await fixture.queue.claimNextTurnBatch(fixture.identity)).toBeNull();
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    expect(dispatches).toBe(1);
  },
);
