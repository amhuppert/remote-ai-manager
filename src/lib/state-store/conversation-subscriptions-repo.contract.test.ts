import { afterEach, describe, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
} from "@/lib/subscriptions/schemas";
import { createConversationSubscriptionsRepo } from "./conversation-subscriptions-repo";
import { createWriteQueue } from "./write-queue";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
const maximalSubscription = () =>
  conversationSubscriptionSchema.parse({
    id: "subscription-max",
    recipient: { projectPath: "/project", conversationId: "conversation-max" },
    source: { kind: "spec", id: "spec-max" },
    reason: "Reviewed this specification",
    mode: "active",
    eventKinds: ["gate-approved", "revision-published"],
    expiresAt: "2027-01-01T00:00:00Z",
    status: "unfollowed",
    cursor: "revision-7",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
    unfollowedAt: "2026-09-29T00:00:00Z",
    pausedAt: "2026-09-27T00:00:00Z",
    missingAt: "2026-09-28T00:00:00Z",
    lastError: "Source read failed",
  });
const maximalDelivery = () =>
  subscriptionDeliverySchema.parse({
    id: "delivery-max",
    subscriptionId: "subscription-max",
    recipient: maximalSubscription().recipient,
    source: maximalSubscription().source,
    fact: {
      occurrenceId: "event-max",
      eventKind: "gate-approved",
      category: "decision",
      sourceTitle: "Release design",
      summary: "Design approved",
      occurredAt: "2026-09-25T00:00:00Z",
      revision: "revision-7",
      outcome: "approved",
      retrievalHandle: "cctl spec show release",
      actorConversationId: "author-other",
    },
    recordedAt: "2026-09-26T00:00:00Z",
    state: "accepted",
    attemptId: "attempt-max",
    attemptCount: 3,
    queuedAt: "2026-09-27T00:00:00Z",
    acceptedAt: "2026-09-28T00:00:00Z",
    finishedAt: "2026-09-29T00:00:00Z",
    lastError: "Recovered receipt after retry",
  });
describe("conversation subscriptions maximal durability", () => {
  it("round-trips every subscription field including opt-out and lifetime", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    const repo = createConversationSubscriptionsRepo(db, createWriteQueue());
    await assertRoundTripDurability({
      label: "conversation subscription",
      schema: conversationSubscriptionSchema,
      buildMaximalFixture: maximalSubscription,
      persist: (value) => repo.createIfAbsent(value),
      reload: (value) =>
        createConversationSubscriptionsRepo(db, createWriteQueue()).get(
          value.recipient,
          value.id,
        ),
    });
  });
  it("round-trips every inbox fact and attempt receipt field", async () => {
    fixture = createPersistenceFixture();
    const db = fixture.db;
    const repo = createConversationSubscriptionsRepo(db, createWriteQueue());
    await repo.createIfAbsent(maximalSubscription());
    await assertRoundTripDurability({
      label: "subscription delivery",
      schema: subscriptionDeliverySchema,
      buildMaximalFixture: maximalDelivery,
      async persist(value) {
        await repo.recordDelivery(value);
        return value;
      },
      reload: (value) =>
        createConversationSubscriptionsRepo(db, createWriteQueue()).getDelivery(
          value.recipient,
          value.id,
        ),
    });
  });
});
