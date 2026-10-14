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
import { isActionableSubscriptionDelivery } from "@/lib/subscriptions/delivery-state";
import {
  activeSubscriptionWaitSchema,
  type ActiveSubscriptionWait,
} from "@/lib/subscriptions/active-wait-schemas";

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
    pausedAt: null,
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
  it("keeps SQL badges and overview actionability consistent across finite wait controls and receipt states", async () => {
    const { repo, fixture } = setup();
    const cases = [
      {
        id: "passive",
        sourceKind: "ticket",
        mode: "passive",
        state: "pending",
        actionable: true,
      },
      {
        id: "paused",
        sourceKind: "ticket",
        mode: "passive",
        state: "pending",
        paused: true,
        actionable: false,
      },
      {
        id: "optout",
        sourceKind: "ticket",
        mode: "passive",
        state: "pending",
        unfollowed: true,
        actionable: false,
      },
      {
        id: "expired",
        sourceKind: "ticket",
        mode: "passive",
        state: "pending",
        expired: true,
        actionable: false,
      },
      {
        id: "unknown",
        sourceKind: "ticket",
        mode: "passive",
        state: "uncertain",
        actionable: false,
      },
      {
        id: "queued",
        sourceKind: "ticket",
        mode: "passive",
        state: "queued",
        actionable: true,
      },
      {
        id: "gate",
        sourceKind: "validation",
        mode: "active",
        state: "pending",
        expired: true,
        actionable: false,
      },
      {
        id: "ready",
        sourceKind: "validation",
        mode: "active",
        state: "pending",
        ready: true,
        actionable: true,
      },
      {
        id: "ready-failed",
        sourceKind: "validation",
        mode: "active",
        state: "failed",
        ready: true,
        actionable: false,
      },
      {
        id: "ready-queued",
        sourceKind: "validation",
        mode: "active",
        state: "queued",
        ready: true,
        actionable: true,
      },
      {
        id: "downgraded",
        sourceKind: "validation",
        mode: "passive",
        state: "pending",
        ready: true,
        expired: true,
        actionable: true,
      },
    ];
    const waits: ActiveSubscriptionWait[] = [];
    for (const row of cases) {
      const follow = conversationSubscriptionSchema.parse({
        ...subscription(),
        id: row.id,
        source: { kind: row.sourceKind, id: row.id },
        mode: row.mode,
        pausedAt: row.paused ? at : null,
        status: row.unfollowed ? "unfollowed" : "following",
        expiresAt: row.expired ? "2000-01-01T00:00:00.000Z" : null,
      });
      const receipt = subscriptionDeliverySchema.parse({
        ...delivery(row.id),
        subscriptionId: row.id,
        source: follow.source,
        state: row.state,
      });
      await repo.createIfAbsent(follow);
      await repo.recordDelivery(receipt);
      if (row.ready) {
        const wait = activeSubscriptionWaitSchema.parse({
          id: `wait-${row.id}`,
          subscriptionId: row.id,
          recipient,
          source: follow.source,
          reason: follow.reason,
          expiresAt: at,
          state: "ready",
          outcome: "source_terminal",
          deliveryId: receipt.id,
          batchId: null,
          causationBatchIds: [],
          createdAt: at,
          updatedAt: at,
          finishedAt: null,
          lastError: null,
        });
        waits.push(wait);
        fixture.db
          .prepare(
            "INSERT INTO conversation_subscription_waits VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run(
            wait.id,
            row.id,
            recipient.projectPath,
            recipient.conversationId,
            wait.state,
            at,
            receipt.id,
            null,
            JSON.stringify(wait),
          );
      }
      expect(
        isActionableSubscriptionDelivery(
          receipt,
          follow,
          waits,
          new Date().toISOString(),
        ),
        row.id,
      ).toBe(row.actionable);
    }
    expect(await repo.pendingCount(recipient)).toBe(5);
  });
  it("counts only actionable pending work and permits explicit review without inventing acceptance", async () => {
    const { repo } = setup();
    await repo.createIfAbsent(subscription());
    await repo.recordDelivery(delivery());
    expect(await repo.pendingCount(recipient)).toBe(1);
    await repo.claim(recipient, ["delivery-1"], "attempt", at);
    await repo.settle(recipient, "attempt", "uncertain", at, "No receipt");
    expect(await repo.pendingCount(recipient)).toBe(0);
    expect(
      await repo.reviewDelivery(recipient, "delivery-1", "retry", at),
    ).toBe(true);
    expect(await repo.pendingCount(recipient)).toBe(1);
    await repo.updateControls(
      recipient,
      "sub-1",
      { ...subscription(), pausedAt: at },
      at,
    );
    expect(await repo.pendingCount(recipient)).toBe(0);
    await repo.updateControls(
      recipient,
      "sub-1",
      { ...subscription(), expiresAt: "2000-01-01T00:00:00Z" },
      at,
    );
    expect(await repo.pendingCount(recipient)).toBe(0);
    expect(
      await repo.reviewDelivery(recipient, "delivery-1", "dismiss", at),
    ).toBe(true);
    expect(await repo.getDelivery(recipient, "delivery-1")).toMatchObject({
      state: "superseded",
      acceptedAt: null,
    });
    expect(
      await repo.reviewDelivery(recipient, "delivery-1", "retry", at),
    ).toBe(false);
  });
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
      pausedAt: null,
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
  it("removes unfollowed evidence from pending backlog while retaining durable history and paused follows", async () => {
    const { fixture, repo } = setup();
    await repo.createIfAbsent(subscription());
    const history = [
      delivery("pending", "pending"),
      {
        ...delivery("failed", "failed"),
        state: "failed" as const,
        lastError: "Not sent",
      },
      {
        ...delivery("uncertain", "uncertain"),
        state: "uncertain" as const,
        lastError: "Receipt unknown",
      },
      {
        ...delivery("accepted", "accepted"),
        state: "accepted" as const,
        acceptedAt: at,
      },
    ];
    for (const item of history) await repo.recordDelivery(item);
    const paused = {
      ...subscription(),
      id: "paused",
      source: { ...source, id: "paused" },
      pausedAt: at,
    };
    await repo.createIfAbsent(paused);
    await repo.recordDelivery({
      ...delivery("paused-delivery", "paused"),
      subscriptionId: paused.id,
      source: paused.source,
    });
    const other = {
      ...subscription(),
      id: "other",
      recipient: { ...recipient, conversationId: "other" },
    };
    await repo.createIfAbsent(other);
    await repo.recordDelivery({
      ...delivery("other-delivery", "other"),
      subscriptionId: other.id,
      recipient: other.recipient,
    });
    expect(await repo.pendingCount(recipient)).toBe(2);
    expect(await repo.pendingCount()).toBe(3);
    await repo.unfollow(recipient, "sub-1", at);
    const reloaded = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    expect(await reloaded.pendingCount(recipient)).toBe(0);
    expect(await reloaded.pendingCount()).toBe(1);
    expect(await reloaded.readInbox(recipient, { limit: 1 })).toMatchObject({
      total: 1,
      items: [{ id: "paused-delivery" }],
    });
    expect(
      await reloaded.readInbox(recipient, { limit: 1, offset: 1 }),
    ).toMatchObject({ total: 1, items: [] });
    expect(
      (await reloaded.readInbox(recipient, { includeSettled: true })).total,
    ).toBe(5);
    expect(await reloaded.listDeliveriesForOverview(recipient)).toHaveLength(5);
    for (const item of history)
      expect(await reloaded.getDelivery(recipient, item.id)).toEqual(item);
  });
});

describe("subscription evidence import and source withdrawal", () => {
  it("rolls back subscription creation if an imported delivery identity conflicts", async () => {
    const { fixture, repo } = setup();
    await repo.createIfAbsent(subscription());
    await repo.recordDelivery(delivery());
    const otherSource = { kind: "run", id: "run-1" } as const;
    await expect(
      repo.importDelivery(
        { ...subscription(), id: "new-subscription", source: otherSource },
        {
          ...delivery(),
          subscriptionId: "new-subscription",
          source: otherSource,
        },
      ),
    ).rejects.toThrow(/UNIQUE/);
    const reloaded = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    expect(await reloaded.findBySource(recipient, otherSource)).toBeNull();
    expect(await reloaded.getDelivery(recipient, "delivery-1")).toEqual(
      delivery(),
    );
  });

  it("supersedes only unclaimed resolved facts and removes them from pending reads without recording acceptance", async () => {
    const { fixture, repo } = setup();
    await repo.createIfAbsent(subscription());
    for (const state of [
      "pending",
      "failed",
      "queued",
      "uncertain",
      "accepted",
    ] as const) {
      await repo.recordDelivery({ ...delivery(state, state), state });
    }
    const otherSource = { kind: "notepad", id: "notes" } as const;
    await repo.createIfAbsent({
      ...subscription(),
      id: "other-subscription",
      source: otherSource,
    });
    await repo.recordDelivery({
      ...delivery("other-source", "pending"),
      source: otherSource,
      subscriptionId: "other-subscription",
    });
    expect(
      await repo.supersedePending(
        recipient,
        source,
        ["pending", "failed", "queued", "uncertain", "accepted"],
        at,
      ),
    ).toBe(2);
    expect(
      await repo.supersedePending(recipient, source, ["pending", "failed"], at),
    ).toBe(0);
    const reloaded = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    for (const id of ["pending", "failed"]) {
      expect(await reloaded.getDelivery(recipient, id)).toMatchObject({
        state: "superseded",
        acceptedAt: null,
        finishedAt: at,
        lastError:
          "Source fact was superseded by accepted context or feedback withdrawal",
      });
    }
    expect(
      (await reloaded.readInbox(recipient, {})).items
        .map((row) => row.id)
        .sort(),
    ).toEqual(["other-source", "queued", "uncertain"]);
    expect(await reloaded.pendingCount(recipient)).toBe(2);
    expect(
      (await reloaded.readInbox(recipient, { includeSettled: true })).total,
    ).toBe(6);
    for (const state of ["queued", "uncertain", "accepted"]) {
      expect((await reloaded.getDelivery(recipient, state))?.state).toBe(state);
    }
  });
});
