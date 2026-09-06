import { describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "./testing/conversation-state-fixture";
import { createMessageQueueService } from "./message-queue-service";
import {
  claimNextTurnBatchTransform,
  createPendingEntry,
  markFailedTransform,
  listActiveEntries,
} from "./message-queue-service";
import { createQueuedDeliveryAccounting } from "@/lib/workflows/conversation/post-turn/queued-delivery-accounting";

const KEY = {
  projectPath: "/queue-recovery",
  sessionName: "session",
  conversationId: "conversation",
};

async function seedQueue(fixture: ReturnType<typeof createPersistenceFixture>) {
  fixture.seedProject(KEY.projectPath);
  fixture.seedSession(KEY.projectPath, KEY.sessionName);
  await fixture.seedConversation(
    KEY.projectPath,
    KEY.sessionName,
    makeConversationState({
      id: KEY.conversationId,
      agentBackend: "cursor",
      status: "running",
    }),
  );
  return createMessageQueueService({
    ...fixture.deps,
    getProjectDisplayName: () => "queue-recovery",
    broadcast: () => {},
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  });
}

describe("durable queue recovery", () => {
  it("retains a rejected message for review instead of losing its payload", () => {
    const row = createPendingEntry({
      id: "rejected",
      content: [{ type: "text", text: "keep rejected input" }],
      now: "now",
    });
    const claim = claimNextTurnBatchTransform([row], "attempt", "now");
    const failed = markFailedTransform(
      claim.queue,
      [row.id],
      "attempt",
      "model unavailable",
      "later",
    );
    expect(listActiveEntries(failed.queue)).toMatchObject([
      { id: row.id, status: "failed", content: row.content },
    ]);
    expect(
      claimNextTurnBatchTransform(failed.queue, "another", "later").claimed,
    ).toEqual([]);
  });
  it.each([
    "missing acknowledgement",
    "transcript failure",
    "queue acknowledgement failure",
  ])("holds the original payload after %s", async (failure) => {
    const fixture = createPersistenceFixture();
    try {
      const queue = await seedQueue(fixture);
      const entry = await queue.enqueue({
        ...KEY,
        content: [{ type: "text", text: "keep me" }],
      });
      const claim = await queue.claimNextTurnBatch(KEY);
      if (!claim) throw new Error("missing claim");
      const accounting = createQueuedDeliveryAccounting(
        {
          markQueuedDelivered: async (input) => {
            if (failure === "queue acknowledgement failure")
              throw new Error("disk unavailable");
            await queue.markDelivered(input);
          },
          markQueuedUncertain: queue.markUncertain,
        },
        {
          ...KEY,
          queuedDelivery: claim,
          appendUserEntry: async () => {
            if (failure === "transcript failure")
              throw new Error("disk unavailable");
          },
        },
      );
      if (failure !== "missing acknowledgement")
        await expect(accounting.handleInputAccepted()).rejects.toThrow(
          "disk unavailable",
        );
      await accounting.settleAfterTurn();
      const reloaded = await fixture
        .recreateStore()
        .getConversation(KEY.projectPath, KEY.sessionName, KEY.conversationId);
      expect(reloaded?.pendingQueue).toMatchObject([
        { id: entry.id, status: "uncertain", content: entry.content },
      ]);
      expect(await queue.claimNextTurnBatch(KEY)).toBeNull();
    } finally {
      fixture.close();
    }
  });
  it("retains an abandoned delivery and its images/model for review, blocking later delivery", async () => {
    const fixture = createPersistenceFixture();
    try {
      const queue = await seedQueue(fixture);
      const first = await queue.enqueue({
        ...KEY,
        content: [
          { type: "text", text: "first" },
          { type: "image", mediaType: "image/png", base64Data: "aW1hZ2U=" },
        ],
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
      });
      const claim = await queue.claimNextTurnBatch(KEY);
      await queue.enqueue({
        ...KEY,
        content: [{ type: "text", text: "second" }],
      });
      expect(claim?.messageIds).toEqual([first.id]);

      await queue.recoverAbandonedDeliveries(KEY);
      const reloaded = await fixture
        .recreateStore()
        .getConversation(KEY.projectPath, KEY.sessionName, KEY.conversationId);
      expect(reloaded?.pendingQueue[0]).toMatchObject({
        status: "uncertain",
        content: first.content,
        modelSelection: first.modelSelection,
        deliveryAttemptId: claim?.deliveryAttemptId,
      });
      expect(await queue.claimNextTurnBatch(KEY)).toBeNull();
      expect((await queue.listActive(KEY)).map((row) => row.status)).toEqual([
        "uncertain",
        "pending",
      ]);

      expect(
        await queue.resolveDelivery({ ...KEY, id: first.id, action: "retry" }),
      ).toBe("resolved");
      const retry = await queue.claimNextTurnBatch(KEY);
      expect(retry?.messageIds).toHaveLength(1);
      expect(retry?.messageIds[0]).not.toBe(first.id);
      expect(retry?.deliveryAttemptId).not.toBe(claim?.deliveryAttemptId);
      expect(retry?.content).toEqual(first.content);
      expect(retry?.modelSelection).toEqual(first.modelSelection);
      if (!claim) throw new Error("missing original claim");
      await queue.markDelivered({
        ...KEY,
        ids: claim.messageIds,
        deliveryAttemptId: claim.deliveryAttemptId,
      });
      expect((await queue.listActive(KEY))[0]?.status).toBe("delivering");
      await queue.recoverAbandonedDeliveries(KEY);
      const retryId = retry?.messageIds[0];
      if (!retryId) throw new Error("missing retried row");
      expect(
        await queue.resolveDelivery({ ...KEY, id: retryId, action: "discard" }),
      ).toBe("resolved");
      expect(
        await queue.resolveDelivery({
          ...KEY,
          id: first.id,
          action: "discard",
        }),
      ).toBe("not_found");
      expect((await queue.claimNextTurnBatch(KEY))?.content).toEqual([
        { type: "text", text: "second" },
      ]);
    } finally {
      fixture.close();
    }
  });
});
