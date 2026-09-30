import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
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
const recipient = { projectPath: "/project", conversationId: "conversation" };
const at = "2026-09-30T12:00:00.000Z";
const subscription = (id = "sub", sourceId = "run") =>
  conversationSubscriptionSchema.parse({
    id,
    recipient,
    source: { kind: "validation", id: sourceId },
    reason: "Continue after tests",
    mode: "passive",
    eventKinds: null,
    expiresAt: null,
    status: "following",
    cursor: "passed",
    createdAt: at,
    updatedAt: at,
    unfollowedAt: null,
    missingAt: null,
    lastError: null,
  });
const wait = (id = "wait", subscriptionId = "sub", sourceId = "run") =>
  activeSubscriptionWaitSchema.parse({
    id,
    subscriptionId,
    recipient,
    source: { kind: "validation", id: sourceId },
    reason: "Continue after tests",
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
  });
const delivery = (waitId = "wait", subscriptionId = "sub", sourceId = "run") =>
  subscriptionDeliverySchema.parse({
    id: `delivery-${waitId}`,
    subscriptionId,
    recipient,
    source: { kind: "validation", id: sourceId },
    fact: {
      occurrenceId: `one-time-terminal:validation:${sourceId}`,
      eventKind: "validation-completed",
      category: "outcome",
      sourceTitle: "Tests",
      summary: "Tests passed",
      occurredAt: at,
      revision: null,
      outcome: "passed",
      retrievalHandle: "cctl validate status run",
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
  });
const batch = (
  id: string,
  waitIds: string[],
  deliveryIds: string[],
  createdAt = at,
) =>
  subscriptionWakeBatchSchema.parse({
    id,
    recipient,
    waitIds,
    deliveryIds,
    state: "planned",
    queueMessageId: id,
    message: "Quoted outcome",
    causationBatchIds: [],
    createdAt,
    updatedAt: createdAt,
    finishedAt: null,
    lastError: null,
  });

describe("one-time wait durability and governors", () => {
  it("promotes an existing source once while preserving its passive cursor", async () => {
    fixture = createPersistenceFixture();
    const queue = createWriteQueue();
    const passive = createConversationSubscriptionsRepo(fixture.db, queue);
    await passive.createIfAbsent(subscription("existing"));
    const repo = createConversationSubscriptionWaitsRepo(fixture.db, queue);
    const registered = await repo.register(wait(), subscription());
    expect(registered.subscriptionId).toBe("existing");
    expect(await passive.get(recipient, "existing")).toMatchObject({
      mode: "active",
      cursor: "passed",
    });
    expect(
      await passive.reconcile({
        recipient,
        subscriptionId: "existing",
        expectedCursor: "passed",
        nextCursor: "changed",
        deliveries: [delivery("wait", "existing")],
        missingAt: null,
        updatedAt: at,
      }),
    ).toEqual({ applied: false, inserted: 0 });
    expect(await repo.register(wait("replacement"), subscription())).toEqual(
      registered,
    );
    expect(
      await createConversationSubscriptionWaitsRepo(
        fixture.db,
        createWriteQueue(),
      ).get(recipient, "existing"),
    ).toEqual(registered);
  });

  it("atomically records one explicit outcome independent of an accepted passive fact", async () => {
    fixture = createPersistenceFixture();
    const queue = createWriteQueue();
    const repo = createConversationSubscriptionWaitsRepo(fixture.db, queue);
    const passive = createConversationSubscriptionsRepo(fixture.db, queue);
    await repo.register(wait(), subscription());
    const old = delivery("old");
    old.fact.occurrenceId = "run:passed";
    old.state = "accepted";
    await passive.recordDelivery(old);
    expect(await repo.settle("wait", "source_terminal", delivery(), at)).toBe(
      true,
    );
    expect(await repo.settle("wait", "source_terminal", delivery(), at)).toBe(
      false,
    );
    expect(await repo.get(recipient, "sub")).toMatchObject({
      state: "ready",
      deliveryId: "delivery-wait",
    });
    expect((await passive.readInbox(recipient, {})).items).toHaveLength(1);
  });

  it("holds a failed batch for review and permits a late matching positive receipt", async () => {
    fixture = createPersistenceFixture();
    const queue = createWriteQueue();
    const repo = createConversationSubscriptionWaitsRepo(fixture.db, queue);
    await repo.register(wait(), subscription());
    await repo.settle("wait", "source_terminal", delivery(), at);
    const first = batch("batch", ["wait"], ["delivery-wait"]);
    expect(await repo.reserveBatch(first)).toEqual(first);
    await repo.markBatchQueued("batch", at);
    await repo.settleBatch("batch", "failed", at, "Rejected before input");
    expect(
      await repo.reserveBatch(batch("second", ["wait"], ["delivery-wait"])),
    ).toMatchObject({ id: "batch", state: "failed" });
    await repo.settleBatch("batch", "accepted", at, null);
    expect(await repo.get(recipient, "sub")).toMatchObject({
      state: "settled",
    });
    expect(
      (
        await createConversationSubscriptionsRepo(
          fixture.db,
          queue,
        ).getDelivery(recipient, "delivery-wait")
      )?.state,
    ).toBe("accepted");
  });

  it("limits new wake reservations to three per minute across repository reloads", async () => {
    fixture = createPersistenceFixture();
    const queue = createWriteQueue();
    const repo = createConversationSubscriptionWaitsRepo(fixture.db, queue);
    for (let i = 0; i < 4; i++) {
      await repo.register(
        wait(`wait${i}`, `sub${i}`, `run${i}`),
        subscription(`sub${i}`, `run${i}`),
      );
      await repo.settle(
        `wait${i}`,
        "source_terminal",
        delivery(`wait${i}`, `sub${i}`, `run${i}`),
        at,
      );
      const reserved = await createConversationSubscriptionWaitsRepo(
        fixture.db,
        createWriteQueue(),
      ).reserveBatch(batch(`batch${i}`, [`wait${i}`], [`delivery-wait${i}`]));
      if (i < 3) {
        expect(reserved?.id).toBe(`batch${i}`);
        await repo.settleBatch(`batch${i}`, "accepted", at, null);
      } else expect(reserved).toBeNull();
    }
  });
});
