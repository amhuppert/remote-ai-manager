import { afterEach, describe, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import {
  activeSubscriptionWaitSchema,
  subscriptionWakeBatchSchema,
} from "@/lib/subscriptions/active-wait-schemas";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
} from "@/lib/subscriptions/schemas";
import { createConversationSubscriptionsRepo } from "./conversation-subscriptions-repo";
import { createConversationSubscriptionWaitsRepo } from "./conversation-subscription-waits-repo";
import { createWriteQueue } from "./write-queue";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
const at = "2026-09-30T12:00:00.000Z";
const maximalWait = () =>
  activeSubscriptionWaitSchema.parse({
    id: "max-wait",
    subscriptionId: "max-sub",
    recipient: { projectPath: "/project", conversationId: "conversation" },
    source: { kind: "workflow", id: "execution" },
    reason: "Continue after the exact execution ends",
    expiresAt: "2026-10-01T12:00:00.000Z",
    state: "settled",
    outcome: "source_terminal",
    deliveryId: "max-delivery",
    baselineOccurrenceId: "prior-terminal-boundary",
    batchId: "max-batch",
    causationBatchIds: ["parent-batch"],
    createdAt: at,
    updatedAt: "2026-09-30T12:02:00.000Z",
    finishedAt: "2026-09-30T12:03:00.000Z",
    lastError: "Prior input uncertainty was resolved",
  });
const subscription = () =>
  conversationSubscriptionSchema.parse({
    id: "max-sub",
    recipient: maximalWait().recipient,
    source: maximalWait().source,
    reason: maximalWait().reason,
    mode: "active",
    eventKinds: null,
    expiresAt: maximalWait().expiresAt,
    status: "following",
    cursor: null,
    createdAt: at,
    updatedAt: at,
    unfollowedAt: null,
    pausedAt: null,
    missingAt: null,
    lastError: null,
  });
const maximalBatch = () =>
  subscriptionWakeBatchSchema.parse({
    id: "max-batch",
    recipient: maximalWait().recipient,
    waitIds: ["max-wait"],
    deliveryIds: ["max-delivery"],
    state: "failed",
    queueMessageId: "max-batch",
    message: "Quoted terminal evidence and full retrieval handle",
    causationBatchIds: ["parent-batch"],
    createdAt: at,
    updatedAt: "2026-09-30T12:04:00.000Z",
    finishedAt: "2026-09-30T12:04:00.000Z",
    lastError: "Backend input was not sent",
  });
describe("one-time wait maximal durability", () => {
  it("round-trips every wait policy, outcome and causation field", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    const repo = createConversationSubscriptionWaitsRepo(
      db,
      createWriteQueue(),
    );
    await assertRoundTripDurability({
      label: "subscription wait",
      schema: activeSubscriptionWaitSchema,
      buildMaximalFixture: maximalWait,
      persist: (value) => repo.register(value, subscription()),
      reload: (value) =>
        createConversationSubscriptionWaitsRepo(db, createWriteQueue()).get(
          value.recipient,
          value.subscriptionId,
        ),
    });
  });
  it("round-trips rendered messages, durable rate history and batch receipts", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    const queue = createWriteQueue();
    const repo = createConversationSubscriptionWaitsRepo(db, queue);
    await repo.register(
      { ...maximalWait(), state: "ready", batchId: null, finishedAt: null },
      subscription(),
    );
    await createConversationSubscriptionsRepo(db, queue).recordDelivery(
      subscriptionDeliverySchema.parse({
        id: "max-delivery",
        subscriptionId: "max-sub",
        recipient: maximalWait().recipient,
        source: maximalWait().source,
        fact: {
          occurrenceId: "terminal",
          eventKind: "workflow-terminal",
          category: "outcome",
          sourceTitle: "Workflow",
          summary: "Completed",
          occurredAt: at,
          revision: null,
          outcome: "completed",
          retrievalHandle: "cctl workflow wait execution",
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
    );
    await assertRoundTripDurability({
      label: "subscription wake batch",
      schema: subscriptionWakeBatchSchema,
      buildMaximalFixture: maximalBatch,
      async persist(value) {
        await repo.reserveBatch({
          ...value,
          state: "planned",
          updatedAt: value.createdAt,
          finishedAt: null,
          lastError: null,
        });
        await repo.settleBatch(
          value.id,
          "failed",
          value.updatedAt,
          value.lastError,
        );
        return value;
      },
      reload: (value) =>
        createConversationSubscriptionWaitsRepo(
          db,
          createWriteQueue(),
        ).getBatch(value.id),
    });
  });
});
