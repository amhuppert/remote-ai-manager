import { describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "./testing/conversation-state-fixture";
import {
  claimLiveDeliveryTransform,
  claimNextTurnBatchTransform,
  createMessageQueueService,
  createPendingEntry,
  type MessageQueueServiceDeps,
} from "./message-queue-service";
import { pendingQueuedMessageSchema } from "./message-queue-schemas";
import { subscriptionWakeHold } from "./message-queue-subscription-admission";

const KEY = {
  projectPath: "/subscription-queue",
  sessionName: "session",
  conversationId: "conversation",
};
const NOW = "2026-09-30T12:00:00.000Z";
const wake = () =>
  createPendingEntry({
    id: "wake-batch",
    inputOrigin: "generated",
    metadata: { kind: "subscription_update", batchId: "batch" },
    content: [{ type: "text", text: "Source update" }],
    now: NOW,
  });
const human = (id: string) =>
  createPendingEntry({
    id,
    inputOrigin: "user",
    content: [{ type: "text", text: "Human instruction" }],
    now: NOW,
  });

async function seedQueue(
  fixture: ReturnType<typeof createPersistenceFixture>,
  overrides: Partial<MessageQueueServiceDeps> = {},
) {
  fixture.seedProject(KEY.projectPath);
  fixture.seedSession(KEY.projectPath, KEY.sessionName);
  await fixture.seedConversation(
    KEY.projectPath,
    KEY.sessionName,
    makeConversationState({ id: KEY.conversationId }),
  );
  return createMessageQueueService({
    ...fixture.deps,
    getProjectDisplayName: () => "subscription-queue",
    broadcast() {},
    now: () => NOW,
    newId: () => crypto.randomUUID(),
    ...overrides,
  });
}

const enqueueWake = (queue: ReturnType<typeof createMessageQueueService>) =>
  queue.enqueue({
    ...KEY,
    id: "wake-batch",
    inputOrigin: "generated",
    metadata: { kind: "subscription_update", batchId: "batch" },
    content: [{ type: "text", text: "Source update" }],
  });

describe("subscription queue admission", () => {
  it.each([false, true])(
    "keeps an empty drain from claiming ordinary input enqueued after it starts (external hold reader: %s)",
    async (withExternalHoldReader) => {
      const fixture = createPersistenceFixture();
      try {
        const queue = await seedQueue(
          fixture,
          withExternalHoldReader
            ? { readSubscriptionWakeHold: async () => null }
            : {},
        );
        const emptyDrain = queue.claimNextTurnBatch(KEY);
        const humanInput = queue.enqueue({
          ...KEY,
          inputOrigin: "user",
          content: [{ type: "text", text: "After the drain started" }],
        });
        expect(await emptyDrain).toBeNull();
        const enqueued = await humanInput;
        const reloaded = await fixture
          .recreateStore()
          .getConversation(
            KEY.projectPath,
            KEY.sessionName,
            KEY.conversationId,
          );
        expect(reloaded?.pendingQueue).toMatchObject([
          { id: enqueued.id, status: "pending" },
        ]);
      } finally {
        fixture.close();
      }
    },
  );

  it.each([null, "Approval hold"])(
    "checks the external hold before claiming a subscription candidate: %s",
    async (hold) => {
      const fixture = createPersistenceFixture();
      try {
        const queue = await seedQueue(fixture, {
          readSubscriptionWakeHold: async () => hold,
        });
        await enqueueWake(queue);
        const claimed = await queue.claimNextTurnBatch(KEY);
        expect(claimed?.messageIds ?? null).toEqual(
          hold === null ? ["wake-batch"] : null,
        );
        const reloaded = await fixture
          .recreateStore()
          .getConversation(
            KEY.projectPath,
            KEY.sessionName,
            KEY.conversationId,
          );
        expect(reloaded?.pendingQueue[0]?.status).toBe(
          hold === null ? "delivering" : "pending",
        );
      } finally {
        fixture.close();
      }
    },
  );

  it("claims the durable human answer before an older wake after consuming the question marker", async () => {
    const fixture = createPersistenceFixture();
    try {
      const queue = await seedQueue(fixture);
      await enqueueWake(queue);
      await fixture.store.mutateConversation(
        KEY.projectPath,
        KEY.sessionName,
        KEY.conversationId,
        "ask",
        (row) => {
          row.pendingQuestionId = "question";
        },
      );
      const answer = await queue.enqueue({
        ...KEY,
        inputOrigin: "generated",
        metadata: { kind: "question_answers", questionBatchId: "question" },
        consumePendingQuestionId: "question",
        content: [{ type: "text", text: "Human answer" }],
      });
      if (!answer) throw new Error("Missing answer");
      expect(
        (
          await fixture
            .recreateStore()
            .getConversation(
              KEY.projectPath,
              KEY.sessionName,
              KEY.conversationId,
            )
        )?.pendingQuestionId,
      ).toBeNull();
      const claim = await queue.claimNextTurnBatch(KEY);
      expect(claim?.messageIds).toEqual([answer.id]);
      const reloaded = await fixture
        .recreateStore()
        .getConversation(KEY.projectPath, KEY.sessionName, KEY.conversationId);
      expect(reloaded?.pendingQueue[0]?.status).toBe("pending");
      if (!claim) throw new Error("Missing answer claim");
      await queue.markDelivered({
        ...KEY,
        ids: claim.messageIds,
        deliveryAttemptId: claim.deliveryAttemptId,
      });
      expect((await queue.claimNextTurnBatch(KEY))?.messageIds).toEqual([
        "wake-batch",
      ]);
    } finally {
      fixture.close();
    }
  });

  it("lets human answers bypass an uncertain wake while retaining the wake for review", async () => {
    const fixture = createPersistenceFixture();
    try {
      const queue = await seedQueue(fixture);
      const entry = await enqueueWake(queue);
      const claim = await queue.claimNextTurnBatch(KEY);
      if (!claim) throw new Error("Missing claim");
      await queue.markUncertain({
        ...KEY,
        ids: [entry.id],
        deliveryAttemptId: claim.deliveryAttemptId,
        error: "Receipt lost",
      });
      const answer = await queue.enqueue({
        ...KEY,
        inputOrigin: "user",
        content: [{ type: "text", text: "Answer" }],
      });
      expect((await queue.claimNextTurnBatch(KEY))?.messageIds).toEqual([
        answer.id,
      ]);
      expect(
        (
          await fixture
            .recreateStore()
            .getConversation(
              KEY.projectPath,
              KEY.sessionName,
              KEY.conversationId,
            )
        )?.pendingQueue[0]?.status,
      ).toBe("uncertain");
    } finally {
      fixture.close();
    }
  });

  it("continues to block human input behind uncertain human queue rows", () => {
    const uncertain = { ...human("first"), status: "uncertain" as const };
    expect(
      claimNextTurnBatchTransform([uncertain, human("later")], "attempt", NOW)
        .claimed,
    ).toEqual([]);
  });
  it("keeps a held wake pending while a human answer behind it is claimable", async () => {
    const fixture = createPersistenceFixture();
    try {
      const queue = await seedQueue(fixture);
      await enqueueWake(queue);
      const answer = await queue.enqueue({
        ...KEY,
        inputOrigin: "user",
        content: [{ type: "text", text: "Answer" }],
      });
      await fixture.store.mutateConversation(
        KEY.projectPath,
        KEY.sessionName,
        KEY.conversationId,
        "ask",
        (row) => {
          row.pendingQuestionId = "question";
        },
      );
      expect((await queue.claimNextTurnBatch(KEY))?.messageIds).toEqual([
        answer.id,
      ]);
      const reloaded = await fixture
        .recreateStore()
        .getConversation(KEY.projectPath, KEY.sessionName, KEY.conversationId);
      expect(reloaded?.pendingQueue[0]?.status).toBe("pending");
    } finally {
      fixture.close();
    }
  });

  it("retires a pending reviewed retry when its batch already has durable acceptance proof", async () => {
    const fixture = createPersistenceFixture();
    try {
      const queue = await seedQueue(fixture);
      const entry = await enqueueWake(queue);
      const claim = await queue.claimNextTurnBatch(KEY);
      if (!claim) throw new Error("Missing claim");
      await queue.markUncertain({
        ...KEY,
        ids: [entry.id],
        deliveryAttemptId: claim.deliveryAttemptId,
        error: "Receipt lost",
      });
      await queue.resolveDelivery({ ...KEY, id: entry.id, action: "retry" });
      expect(
        await queue.confirmSubscriptionWakeAccepted({
          ...KEY,
          batchId: "batch",
        }),
      ).toBe(1);
      expect(await queue.claimNextTurnBatch(KEY)).toBeNull();
      expect(
        (
          await fixture
            .recreateStore()
            .getConversation(
              KEY.projectPath,
              KEY.sessionName,
              KEY.conversationId,
            )
        )?.pendingQueue,
      ).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it.each(["cancel", "discard"] as const)(
    "settles the batch cancellation after durable %s",
    async (action) => {
      const fixture = createPersistenceFixture();
      let cancelledBatch: string | null = null;
      try {
        const queue = await seedQueue(fixture, {
          async onSubscriptionWakeDiscarded(input) {
            cancelledBatch = input.batchId;
          },
        });
        const entry = await enqueueWake(queue);
        if (action === "discard") {
          const claim = await queue.claimNextTurnBatch(KEY);
          if (!claim) throw new Error("Missing claim");
          await queue.markUncertain({
            ...KEY,
            ids: [entry.id],
            deliveryAttemptId: claim.deliveryAttemptId,
            error: "Receipt lost",
          });
          await queue.resolveDelivery({
            ...KEY,
            id: entry.id,
            action: "discard",
          });
        } else await queue.cancel({ ...KEY, id: entry.id });
        expect(cancelledBatch).toBe("batch");
        expect(
          (
            await fixture
              .recreateStore()
              .getConversation(
                KEY.projectPath,
                KEY.sessionName,
                KEY.conversationId,
              )
          )?.pendingQueue,
        ).toEqual([]);
      } finally {
        fixture.close();
      }
    },
  );
  it.each([
    { archived: true },
    { pendingQuestionId: "question" },
    { role: "validator" as const },
  ])(
    "holds a wake when its durable recipient state disallows it: %j",
    (overrides) => {
      expect(
        subscriptionWakeHold({
          conversation: makeConversationState(overrides),
          sessionArchived: false,
        }),
      ).not.toBeNull();
    },
  );

  it("holds a wake in an archived parent session", () => {
    expect(
      subscriptionWakeHold({
        conversation: makeConversationState(),
        sessionArchived: true,
      }),
    ).not.toBeNull();
  });

  it("preserves a durable batch identity in the queue schema", () => {
    expect(pendingQueuedMessageSchema.parse(wake()).metadata).toEqual({
      kind: "subscription_update",
      batchId: "batch",
    });
  });

  it("refuses live delivery even when a caller attempts to claim a wake", () => {
    expect(
      claimLiveDeliveryTransform([wake()], "wake-batch", "attempt", NOW)
        .claimed,
    ).toBeNull();
  });

  it("keeps a pending wake from blocking live human input", () => {
    const result = claimLiveDeliveryTransform(
      [wake(), human("redirect")],
      "redirect",
      "attempt",
      NOW,
    );
    expect(result.claimed?.id).toBe("redirect");
    expect(result.queue[0]?.status).toBe("pending");
  });

  it("isolates a wake from adjacent human and generated inputs", () => {
    const before = human("before");
    const after = human("after");
    const generated = createPendingEntry({
      id: "generated",
      inputOrigin: "generated",
      content: [{ type: "text", text: "Other generated work" }],
      now: NOW,
    });
    expect(
      claimNextTurnBatchTransform(
        [before, wake(), after],
        "attempt",
        NOW,
      ).claimed.map((row) => row.id),
    ).toEqual(["before", "after"]);
    expect(
      claimNextTurnBatchTransform(
        [wake(), after, generated],
        "attempt",
        NOW,
      ).claimed.map((row) => row.id),
    ).toEqual(["after", "generated"]);
    expect(
      claimNextTurnBatchTransform(
        [wake(), generated],
        "attempt",
        NOW,
      ).claimed.map((row) => row.id),
    ).toEqual(["wake-batch"]);
    expect(
      claimNextTurnBatchTransform(
        [generated, wake()],
        "attempt",
        NOW,
      ).claimed.map((row) => row.id),
    ).toEqual(["generated"]);
  });

  it("enqueues one durable row when a recovered producer repeats its batch id", async () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(KEY.projectPath);
      fixture.seedSession(KEY.projectPath, KEY.sessionName);
      await fixture.seedConversation(
        KEY.projectPath,
        KEY.sessionName,
        makeConversationState({ id: KEY.conversationId }),
      );
      const queue = createMessageQueueService({
        ...fixture.deps,
        getProjectDisplayName: () => "subscription-queue",
        broadcast() {},
        now: () => NOW,
        newId: () => crypto.randomUUID(),
      });
      const input = {
        ...KEY,
        id: "wake-batch",
        inputOrigin: "generated" as const,
        metadata: { kind: "subscription_update" as const, batchId: "batch" },
        content: [{ type: "text" as const, text: "Source update" }],
      };
      const [first, second] = await Promise.all([
        queue.enqueue(input),
        queue.enqueue(input),
      ]);
      expect(first.id).toBe("wake-batch");
      expect(second.id).toBe(first.id);
      const reloaded = await fixture
        .recreateStore()
        .getConversation(KEY.projectPath, KEY.sessionName, KEY.conversationId);
      expect(reloaded?.pendingQueue).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });
});
