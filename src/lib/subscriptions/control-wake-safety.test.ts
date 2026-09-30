import { afterEach, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createConversationSubscriptionWaitsRepo } from "@/lib/state-store/conversation-subscription-waits-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { createActiveWaitService } from "./active-wait-service";
import { createSubscriptionControlsService } from "./control-service";
import type { SSEEvent } from "@/lib/api/sse-events";
const recipient = { projectPath: "/project", conversationId: "conversation" };
let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
async function harness() {
  const writeQueue = createWriteQueue();
  fixture = createPersistenceFixture({ writeQueue });
  fixture.seedProject(recipient.projectPath);
  fixture.seedSession(recipient.projectPath, "session");
  await fixture.seedConversation(
    recipient.projectPath,
    "session",
    conversationStateSchema.parse({
      id: recipient.conversationId,
      createdAt: "2026-09-30T12:00:00.000Z",
      lastActivityAt: "2026-09-30T12:00:00.000Z",
      name: "Controls",
      transcriptPath: "/tmp/control-test.jsonl",
      status: "awaiting",
      promptCount: 0,
    }),
  );
  const repo = createConversationSubscriptionsRepo(fixture.db, writeQueue);
  const waits = createConversationSubscriptionWaitsRepo(fixture.db, writeQueue);
  let at = "2026-09-30T12:00:00.000Z";
  let missingProof = false;
  const active = createActiveWaitService({
    repo: waits,
    subscriptions: repo,
    isRecipientEligible: async () => true,
    canDiscardMissingBatch: async () => missingProof,
    now: () => at,
    readTerminalSource: async (_recipient, source) => ({
      kind: "terminal",
      fact: {
        occurrenceId: `terminal:${source.id}`,
        eventKind: "validation-completed",
        category: "outcome",
        sourceTitle: "Tests",
        summary: `Tests ${source.id} passed`,
        occurredAt: at,
        revision: null,
        outcome: "passed",
        retrievalHandle: "cctl validate status run",
        actorConversationId: null,
      },
    }),
  });
  let discarded = 0;
  const broadcasts: SSEEvent[] = [];
  const key = { ...recipient, sessionName: "session" };
  const queue = createMessageQueueService({
    ...fixture.deps,
    isSubscriptionWakeCurrent: (id) => waits.isBatchDispatchable(id),
    onSubscriptionWakeDiscarded: async () => {
      discarded++;
    },
    broadcast: (event) => {
      broadcasts.push(event);
    },
    getProjectDisplayName: () => "project",
    now: () => at,
    newId: () => crypto.randomUUID(),
  });
  const controls = createSubscriptionControlsService({
    isRecipientEligible: async () => true,
    repo,
    waits,
    activeWaits: active,
    now: () => at,
    withdrawPendingWake: (batch, commit) =>
      queue.withdrawSubscriptionWake({
        ...key,
        batchId: batch.id,
        allowMissing: batch.state === "planned",
        commit,
      }),
  });
  const first = await active.register({
    recipient,
    source: { kind: "validation", id: "first" },
    reason: "Review first",
  });
  const second = await active.register({
    recipient,
    source: { kind: "validation", id: "second" },
    reason: "Review second",
  });
  const batch = await active.prepareBatch(recipient);
  if (!batch) throw Error("Expected coalesced batch");
  return {
    repo,
    waits,
    active,
    queue,
    controls,
    first,
    second,
    batch,
    key,
    broadcasts,
    discarded: () => discarded,
    setMissingProof(value: boolean) {
      missingProof = value;
    },
    setTime(value: string) {
      at = value;
    },
  };
}
it("withdraws a pending coalesced row and preserves the other wait for rebatching", async () => {
  const h = await harness();
  await h.active.markBatchQueued(h.batch.id);
  await h.queue.enqueue({
    ...h.key,
    id: h.batch.queueMessageId,
    metadata: { kind: "subscription_update", batchId: h.batch.id },
    content: [{ type: "text", text: h.batch.message }],
  });
  await h.controls.pause(recipient, h.first.subscriptionId);
  expect(await h.queue.listActive(h.key)).toEqual([]);
  expect(h.discarded()).toBe(0);
  expect((await h.waits.getBatch(h.batch.id))?.state).toBe("cancelled");
  for (const wait of [h.first, h.second]) {
    const reloaded = await h.waits.get(recipient, wait.subscriptionId);
    expect(reloaded?.state).toBe("ready");
    expect(reloaded?.batchId).toBeNull();
    if (!reloaded?.deliveryId) throw Error("Expected delivery");
    expect(
      (await h.repo.getDelivery(recipient, reloaded.deliveryId))?.state,
    ).toBe("pending");
  }
  const rebatched = await h.active.prepareBatch(recipient);
  expect(rebatched?.waitIds).toEqual([h.second.id]);
  await expect(
    h.queue.enqueue({
      ...h.key,
      id: h.batch.queueMessageId,
      metadata: { kind: "subscription_update", batchId: h.batch.id },
      content: [{ type: "text", text: h.batch.message }],
    }),
  ).rejects.toThrow(/no longer current/);
});
it("refuses a delivering wake and keeps its acceptance receipt immutable", async () => {
  const h = await harness();
  await h.active.markBatchQueued(h.batch.id);
  await h.queue.enqueue({
    ...h.key,
    id: h.batch.queueMessageId,
    metadata: { kind: "subscription_update", batchId: h.batch.id },
    content: [{ type: "text", text: h.batch.message }],
  });
  const claimed = await h.queue.claimNextTurnBatch(h.key);
  expect(claimed?.subscriptionBatchId).toBe(h.batch.id);
  await expect(
    h.controls.setMode(recipient, h.first.subscriptionId, "passive"),
  ).rejects.toMatchObject({
    code: "ACTIVE_WAIT_QUEUE_REVIEW_REQUIRED",
    status: 409,
  });
  expect((await h.repo.get(recipient, h.first.subscriptionId))?.mode).toBe(
    "active",
  );
  await h.active.settleBatch(h.batch.id, "accepted");
  const accepted = await h.repo.getDelivery(
    recipient,
    h.batch.deliveryIds[0] ?? "",
  );
  await h.controls.unfollow(recipient, h.first.subscriptionId);
  expect(
    await h.repo.getDelivery(recipient, h.batch.deliveryIds[0] ?? ""),
  ).toEqual(accepted);
});
it("holds a stale pending wake even when only the durable reservation checker is configured", async () => {
  const h = await harness();
  await h.active.markBatchQueued(h.batch.id);
  await h.queue.enqueue({
    ...h.key,
    id: h.batch.queueMessageId,
    metadata: { kind: "subscription_update", batchId: h.batch.id },
    content: [{ type: "text", text: h.batch.message }],
  });
  await h.waits.applyControl(
    recipient,
    h.first.subscriptionId,
    { pausedAt: "2026-09-30T12:01:00.000Z" },
    "2026-09-30T12:01:00.000Z",
    h.batch.id,
  );
  expect(await h.queue.claimNextTurnBatch(h.key)).toBeNull();
});
it("refuses queued plus absent evidence, while planned plus absent can be safely released", async () => {
  const h = await harness();
  await h.active.markBatchQueued(h.batch.id);
  await expect(
    h.controls.pause(recipient, h.first.subscriptionId),
  ).rejects.toMatchObject({ status: 409 });
  expect((await h.waits.getBatch(h.batch.id))?.state).toBe("queued");
});

it("explicit cancellation can discard an orphan uncertain wake only after proven queue and receipt absence", async () => {
  const h = await harness();
  await h.active.markBatchQueued(h.batch.id);
  await h.active.settleBatch(
    h.batch.id,
    "uncertain",
    "Process stopped before queue handoff",
  );
  await expect(
    h.controls.cancel(recipient, h.first.subscriptionId),
  ).rejects.toMatchObject({ status: 409 });
  h.setMissingProof(true);
  await h.controls.cancel(recipient, h.first.subscriptionId);
  expect((await h.waits.get(recipient, h.first.subscriptionId))?.state).toBe(
    "cancelled",
  );
  expect((await h.waits.get(recipient, h.second.subscriptionId))?.state).toBe(
    "ready",
  );
  expect((await h.waits.getBatch(h.batch.id))?.state).toBe("uncertain");
  await h.controls.unfollow(recipient, h.second.subscriptionId);
  expect((await h.waits.getBatch(h.batch.id))?.state).toBe("cancelled");
});
