import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  conversationSubscriptionSchema,
  sourceFactSchema,
  subscriptionDeliverySchema,
} from "@/lib/subscriptions/schemas";
import { createWriteQueue } from "./write-queue";
import { createConversationSubscriptionsRepo } from "./conversation-subscriptions-repo";

const recipient = { projectPath: "/project", conversationId: "conv" };
const source = { kind: "ticket", id: "ticket-1" } as const;
const at = "2026-09-30T12:00:00Z";
let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
function setup() {
  fixture = createPersistenceFixture();
  return {
    fixture,
    repo: createConversationSubscriptionsRepo(fixture.db, createWriteQueue()),
  };
}
function subscription() {
  return conversationSubscriptionSchema.parse({
    id: "sub-1",
    recipient,
    source,
    reason: "Linked ticket",
    mode: "passive",
    eventKinds: null,
    expiresAt: null,
    status: "following",
    cursor: "1",
    createdAt: at,
    updatedAt: at,
    unfollowedAt: null,
    missingAt: null,
    lastError: null,
  });
}
function delivery(id = "delivery-1", occurrenceId = "event-1") {
  return subscriptionDeliverySchema.parse({
    id,
    subscriptionId: "sub-1",
    recipient,
    source,
    fact: sourceFactSchema.parse({
      occurrenceId,
      eventKind: "status",
      category: "decision",
      sourceTitle: "Ticket",
      summary: "Approved",
      occurredAt: at,
      revision: "2",
      outcome: "approved",
      retrievalHandle: "cctl ticket show 1",
      actorConversationId: null,
    }),
    recordedAt: at,
    state: "pending",
    attemptId: null,
    attemptCount: 0,
    queuedAt: null,
    acceptedAt: null,
    finishedAt: null,
    lastError: null,
  });
}
describe("conversation subscriptions durable state", () => {
  it("retains the explicit opt-out when automatic involvement is rediscovered", async () => {
    const { fixture, repo } = setup();
    await repo.createIfAbsent(subscription());
    expect(await repo.unfollow(recipient, "sub-1", at)).toBe(true);
    await repo.createIfAbsent({
      ...subscription(),
      id: "sub-new",
      cursor: "99",
      reason: "New reason",
    });
    const reload = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    expect(await reload.findBySource(recipient, source)).toMatchObject({
      id: "sub-1",
      status: "unfollowed",
      cursor: "1",
      unfollowedAt: at,
    });
  });
  it("advances a cursor and inserts a distinct occurrence atomically; stale reconciles cannot write", async () => {
    const { fixture, repo } = setup();
    await repo.createIfAbsent(subscription());
    const input = {
      recipient,
      subscriptionId: "sub-1",
      expectedCursor: "1",
      nextCursor: "2",
      deliveries: [delivery()],
      missingAt: null,
      updatedAt: at,
    };
    expect(await repo.reconcile(input)).toEqual({ applied: true, inserted: 1 });
    expect(
      await repo.reconcile({
        ...input,
        nextCursor: "3",
        deliveries: [delivery("stale", "stale")],
      }),
    ).toEqual({ applied: false, inserted: 0 });
    const reload = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    expect(await reload.get(recipient, "sub-1")).toMatchObject({ cursor: "2" });
    expect(
      (await reload.readInbox(recipient, {})).items.map((row) => row.id),
    ).toEqual(["delivery-1"]);
    expect(
      await repo.reconcile({
        ...input,
        expectedCursor: "2",
        nextCursor: "3",
        deliveries: [delivery("duplicate")],
      }),
    ).toEqual({ applied: true, inserted: 0 });
  });
  it("keeps source and inbox evidence and does not cross recipient scope", async () => {
    const { repo } = setup();
    await repo.createIfAbsent(subscription());
    await repo.reconcile({
      recipient,
      subscriptionId: "sub-1",
      expectedCursor: "1",
      nextCursor: "2",
      deliveries: [delivery()],
      missingAt: at,
      updatedAt: at,
    });
    expect(await repo.get(recipient, "sub-1")).toMatchObject({ missingAt: at });
    expect(
      await repo.getDelivery(
        { ...recipient, conversationId: "fork" },
        "delivery-1",
      ),
    ).toBeNull();
    expect((await repo.readInbox(recipient, {})).total).toBe(1);
  });
  it("rolls back both cursor advancement and earlier facts when one insert fails", async () => {
    const { fixture, repo } = setup();
    await repo.createIfAbsent(subscription());
    await expect(
      repo.reconcile({
        recipient,
        subscriptionId: "sub-1",
        expectedCursor: "1",
        nextCursor: "3",
        deliveries: [
          delivery("same-id", "event-2"),
          delivery("same-id", "event-3"),
        ],
        missingAt: null,
        updatedAt: at,
      }),
    ).rejects.toThrow();
    const reload = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    expect(await reload.get(recipient, "sub-1")).toMatchObject({ cursor: "1" });
    expect((await reload.readInbox(recipient, {})).items).toEqual([]);
  });
  it("claims once, settles only its own attempt, and recovers orphaned claims as uncertain", async () => {
    const { fixture, repo } = setup();
    await repo.createIfAbsent(subscription());
    await repo.recordDelivery(delivery());
    expect(
      await repo.claim(recipient, ["delivery-1"], "attempt-1", at),
    ).toHaveLength(1);
    expect(
      await repo.claim(recipient, ["delivery-1"], "attempt-2", at),
    ).toHaveLength(0);
    expect(
      await repo.settle(recipient, "attempt-2", "accepted", at, null),
    ).toBe(0);
    const reload = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    expect(await reload.recoverOrphanedClaims(at)).toBe(1);
    expect(await reload.getDelivery(recipient, "delivery-1")).toMatchObject({
      state: "uncertain",
      attemptId: "attempt-1",
      attemptCount: 1,
      finishedAt: at,
    });
    expect(
      await reload.claim(recipient, ["delivery-1"], "attempt-3", at),
    ).toHaveLength(0);
  });
  it("retries a proven not-sent failure and preserves inspection without settling", async () => {
    const { repo } = setup();
    await repo.createIfAbsent(subscription());
    await repo.recordDelivery(delivery());
    await repo.readInbox(recipient, {});
    expect(await repo.getDelivery(recipient, "delivery-1")).toMatchObject({
      state: "pending",
    });
    await repo.claim(recipient, ["delivery-1"], "attempt-1", at);
    await repo.settle(recipient, "attempt-1", "failed", at, "not sent");
    expect(
      await repo.claim(recipient, ["delivery-1"], "attempt-2", at),
    ).toHaveLength(1);
    expect(
      await repo.settle(recipient, "attempt-2", "accepted", at, null),
    ).toBe(1);
    expect((await repo.readInbox(recipient, {})).total).toBe(0);
    expect(
      (await repo.readInbox(recipient, { includeSettled: true })).items[0],
    ).toMatchObject({ state: "accepted", acceptedAt: at, attemptCount: 2 });
  });
  it("refuses passive claims for persisted active-mode subscriptions", async () => {
    const { repo } = setup();
    await repo.createIfAbsent({ ...subscription(), mode: "active" });
    await repo.recordDelivery(delivery());
    expect(
      await repo.claim(recipient, ["delivery-1"], "passive-attempt", at),
    ).toEqual([]);
    expect(await repo.getDelivery(recipient, "delivery-1")).toMatchObject({
      state: "pending",
    });
  });
});
