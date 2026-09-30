import { afterEach, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { createConversationSubscriptionsRepo } from "./conversation-subscriptions-repo";
import {
  createConversationSubscriptionPreferencesRepo,
  subscriptionPreferencesSchema,
  subscriptionDeliveryReadStateSchema,
} from "./conversation-subscription-preferences-repo";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
} from "@/lib/subscriptions/schemas";
import { createWriteQueue } from "./write-queue";
let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
const recipient = { projectPath: "/project", conversationId: "conversation" };
const at = "2026-09-30T12:00:00.000Z";
it("round trips a persisted disabled hint preference", async () => {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  const repo = createConversationSubscriptionPreferencesRepo(
    db,
    createWriteQueue(),
  );
  await assertRoundTripDurability({
    label: "subscription preference",
    schema: subscriptionPreferencesSchema,
    buildMaximalFixture: () => ({ hintsEnabled: false }),
    persist: (value) => repo.setHintsEnabled(recipient, value.hintsEnabled),
    reload: () =>
      createConversationSubscriptionPreferencesRepo(
        db,
        createWriteQueue(),
      ).getPreferences(recipient),
  });
});
it("round trips every human read field without changing delivery evidence", async () => {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  const queue = createWriteQueue();
  const subscriptions = createConversationSubscriptionsRepo(db, queue);
  const source = { kind: "notepad", id: "notes" } as const;
  await subscriptions.createIfAbsent(
    conversationSubscriptionSchema.parse({
      id: "sub",
      recipient,
      source,
      reason: "Notes",
      mode: "passive",
      eventKinds: null,
      expiresAt: null,
      status: "following",
      cursor: "1",
      createdAt: at,
      updatedAt: at,
      unfollowedAt: null,
      pausedAt: null,
      missingAt: null,
      lastError: null,
    }),
  );
  const delivery = subscriptionDeliverySchema.parse({
    id: "delivery",
    subscriptionId: "sub",
    recipient,
    source,
    fact: {
      occurrenceId: "event",
      eventKind: "content-revised",
      category: "revision",
      sourceTitle: "Notes",
      summary: "Updated notes",
      occurredAt: at,
      revision: "2",
      outcome: null,
      retrievalHandle: "cctl notepad get notes",
      actorConversationId: null,
    },
    recordedAt: at,
    state: "accepted",
    attemptId: "attempt",
    attemptCount: 1,
    queuedAt: at,
    acceptedAt: at,
    finishedAt: at,
    lastError: null,
  });
  await subscriptions.recordDelivery(delivery);
  const repo = createConversationSubscriptionPreferencesRepo(db, queue);
  await assertRoundTripDurability({
    label: "subscription human read state",
    schema: subscriptionDeliveryReadStateSchema,
    buildMaximalFixture: () => ({
      recipient,
      deliveryId: delivery.id,
      readAt: at,
    }),
    async persist(value) {
      await repo.markDeliveryRead(
        value.recipient,
        value.deliveryId,
        true,
        value.readAt,
      );
      return value;
    },
    async reload(value) {
      const readAt = await createConversationSubscriptionPreferencesRepo(
        db,
        createWriteQueue(),
      ).getReadAt(value.recipient, value.deliveryId);
      return readAt === null
        ? null
        : { recipient: value.recipient, deliveryId: value.deliveryId, readAt };
    },
  });
  expect(await subscriptions.getDelivery(recipient, delivery.id)).toEqual(
    delivery,
  );
});
