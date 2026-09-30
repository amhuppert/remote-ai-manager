import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { createConversationSubscriptionWaitsRepo } from "@/lib/state-store/conversation-subscription-waits-repo";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  activeSubscriptionWaitSchema,
  subscriptionWakeBatchSchema,
} from "./active-wait-schemas";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
} from "./schemas";
import { createActiveWaitDispatcher } from "./active-wait-dispatch";

const key = {
  projectPath: "/wake-dispatch",
  sessionName: "work",
  conversationId: "recipient",
};
const recipient = {
  projectPath: key.projectPath,
  conversationId: key.conversationId,
};
const at = "2026-09-30T12:00:00.000Z";
let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

async function setup() {
  const f = createPersistenceFixture();
  fixture = f;
  f.seedProject(key.projectPath);
  f.seedSession(key.projectPath, key.sessionName);
  await f.seedConversation(
    key.projectPath,
    key.sessionName,
    makeConversationState({ id: key.conversationId }),
  );
  const writes = createWriteQueue();
  const repo = createConversationSubscriptionWaitsRepo(f.db, writes);
  const inbox = createConversationSubscriptionsRepo(f.db, writes);
  const source = { kind: "validation", id: "validation-one" } as const;
  await repo.register(
    activeSubscriptionWaitSchema.parse({
      id: "wait",
      subscriptionId: "subscription",
      recipient,
      source,
      reason: "Summarize the result",
      expiresAt: "2026-10-01T12:00:00.000Z",
      state: "waiting",
      outcome: null,
      deliveryId: null,
      batchId: null,
      causationBatchIds: [],
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
      lastError: null,
    }),
    conversationSubscriptionSchema.parse({
      id: "subscription",
      recipient,
      source,
      reason: "Summarize the result",
      mode: "active",
      eventKinds: null,
      expiresAt: "2026-10-01T12:00:00.000Z",
      status: "following",
      cursor: null,
      createdAt: at,
      updatedAt: at,
      unfollowedAt: null,
      missingAt: null,
      lastError: null,
    }),
  );
  await repo.settle(
    "wait",
    "source_terminal",
    subscriptionDeliverySchema.parse({
      id: "delivery",
      subscriptionId: "subscription",
      recipient,
      source,
      fact: {
        occurrenceId: "one-time-terminal:validation:validation-one",
        eventKind: "validation-completed",
        category: "outcome",
        sourceTitle: "Tests",
        summary: "Tests failed",
        occurredAt: at,
        revision: null,
        outcome: "failed",
        retrievalHandle: "cctl validate status validation-one",
        actorConversationId: null,
      },
      recordedAt: at,
      state: "pending",
      attemptId: null,
      attemptCount: 0,
      queuedAt: null,
      acceptedAt: null,
      finishedAt: null,
      lastError: null,
    }),
    at,
  );
  await repo.reserveBatch(
    subscriptionWakeBatchSchema.parse({
      id: "batch",
      recipient,
      waitIds: ["wait"],
      deliveryIds: ["delivery"],
      state: "planned",
      queueMessageId: "batch",
      message: "Validation failed; summarize the recorded result.",
      causationBatchIds: [],
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
      lastError: null,
    }),
  );
  const queue = createMessageQueueService({
    ...f.deps,
    getProjectDisplayName: () => "wake-dispatch",
    broadcast() {},
    now: () => at,
    newId: () => crypto.randomUUID(),
  });
  const accepted = new Set<string>();
  let enqueueThrowsAfterWrite = false;
  let enqueueCount = 0;
  let drainCount = 0;
  let observationGate: Promise<void> | undefined;
  const makeDispatcher = () =>
    createActiveWaitDispatcher({
      logger: createCapturingLogger(),
      service: {
        async reconcile() {},
        listPendingBatches: () => repo.listPendingBatches(),
        async listRecipients() {
          return [];
        },
        async prepareBatch() {
          return null;
        },
        markBatchQueued: (id) => repo.markBatchQueued(id, at),
        settleBatch: (id, state, error) =>
          repo.settleBatch(id, state, at, error ?? null),
      },
      async observe(batch) {
        await observationGate;
        const conversation = await f
          .recreateStore()
          .getConversation(
            key.projectPath,
            key.sessionName,
            key.conversationId,
          );
        const row = conversation?.pendingQueue.find(
          (entry) =>
            entry.metadata?.kind === "subscription_update" &&
            entry.metadata.batchId === batch.id,
        );
        return {
          recipientEligible: conversation !== null,
          accepted: accepted.has(batch.id),
          queueStatus: row?.status ?? null,
          error: row?.error ?? null,
        };
      },
      async enqueue(batch) {
        enqueueCount++;
        await queue.enqueue({
          ...key,
          id: batch.queueMessageId,
          inputOrigin: "generated",
          metadata: { kind: "subscription_update", batchId: batch.id },
          content: [{ type: "text", text: batch.message }],
        });
        if (enqueueThrowsAfterWrite) throw new Error("lost enqueue response");
      },
      async drain() {
        drainCount++;
      },
      async confirmAccepted(batch) {
        await queue.confirmSubscriptionWakeAccepted({
          ...key,
          batchId: batch.id,
        });
      },
    });
  return {
    f,
    repo,
    inbox,
    queue,
    accepted,
    makeDispatcher,
    counts: () => ({ enqueueCount, drainCount }),
    setEnqueueFailure(value: boolean) {
      enqueueThrowsAfterWrite = value;
    },
    setObservationGate(gate: Promise<void>) {
      observationGate = gate;
    },
  };
}

describe("durable active wake handoff", () => {
  it("resumes the same queued wake after restart and settles from input evidence", async () => {
    const s = await setup();
    const first = s.makeDispatcher();
    await Promise.all([first.tick(), first.tick()]);
    expect(s.counts().enqueueCount).toBe(1);
    expect((await s.repo.getBatch("batch"))?.state).toBe("queued");
    const restarted = s.makeDispatcher();
    await restarted.tick();
    expect(s.counts().enqueueCount).toBe(1);
    const claimed = await s.queue.claimNextTurnBatch(key);
    expect(claimed?.subscriptionBatchId).toBe("batch");
    s.accepted.add("batch");
    await restarted.tick();
    expect((await s.repo.getBatch("batch"))?.state).toBe("accepted");
    expect((await s.inbox.getDelivery(recipient, "delivery"))?.state).toBe(
      "accepted",
    );
    expect(
      (
        await s.f
          .recreateStore()
          .getConversation(key.projectPath, key.sessionName, key.conversationId)
      )?.pendingQueue,
    ).toEqual([]);
  });

  it("recovers a persisted pending row after losing the enqueue acknowledgement", async () => {
    const s = await setup();
    s.setEnqueueFailure(true);
    await s.makeDispatcher().tick();
    expect((await s.repo.getBatch("batch"))?.state).toBe("uncertain");
    s.setEnqueueFailure(false);
    await s.makeDispatcher().tick();
    expect(s.counts()).toEqual({ enqueueCount: 1, drainCount: 1 });
    expect((await s.repo.getBatch("batch"))?.state).toBe("queued");
  });

  it("reports a lost attempted handoff without fabricating acceptance or resending", async () => {
    const s = await setup();
    await s.repo.markBatchQueued("batch", at);
    await s.makeDispatcher().tick();
    await s.makeDispatcher().tick();
    expect(s.counts()).toEqual({ enqueueCount: 0, drainCount: 0 });
    expect((await s.repo.getBatch("batch"))?.state).toBe("uncertain");
    expect((await s.inbox.getDelivery(recipient, "delivery"))?.state).toBe(
      "uncertain",
    );
  });

  it("stops pending dispatch before conversation shutdown can be undone by a nudge", async () => {
    const s = await setup();
    const gate = Promise.withResolvers<void>();
    s.setObservationGate(gate.promise);
    const dispatcher = s.makeDispatcher();
    const running = dispatcher.tick();
    const stopped = dispatcher.stop();
    gate.resolve();
    await Promise.all([running, stopped]);
    await dispatcher.tick();
    expect(s.counts()).toEqual({ enqueueCount: 0, drainCount: 0 });
    expect((await s.repo.getBatch("batch"))?.state).toBe("planned");
  });
});
