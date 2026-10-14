import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
  type SubscriptionDelivery,
} from "@/lib/subscriptions/schemas";
import { createConversationSubscriptionsRepo } from "./conversation-subscriptions-repo";
import { createWriteQueue } from "./write-queue";
import { importSubscriptionDelivery } from "./subscription-delivery-import";

const recipient = { projectPath: "/project", conversationId: "conversation" };
const source = { kind: "git_job", id: "job-1" } as const;
const at = "2026-10-01T12:00:00Z";
let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
function subscription(id = "subscription") {
  return conversationSubscriptionSchema.parse({
    id,
    recipient,
    source,
    reason: "Merge result",
    mode: "passive",
    eventKinds: null,
    expiresAt: null,
    status: "following",
    cursor: "4",
    createdAt: at,
    updatedAt: at,
    unfollowedAt: null,
    pausedAt: null,
    missingAt: null,
    lastError: null,
  });
}
function delivery(overrides: Partial<SubscriptionDelivery> = {}) {
  return subscriptionDeliverySchema.parse({
    id: "delivery",
    subscriptionId: "subscription",
    recipient,
    source,
    fact: {
      occurrenceId: "5",
      eventKind: "job-completed",
      category: "outcome",
      sourceTitle: "Merge",
      summary: "Completed work",
      sourceText: "Frozen complete result",
      occurredAt: at,
      revision: null,
      outcome: "completed",
      retrievalHandle: "cctl job show job-1",
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
    ...overrides,
  });
}
function setup() {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  const repo = createConversationSubscriptionsRepo(db, createWriteQueue());
  return {
    db,
    repo,
    import(input: Parameters<typeof importSubscriptionDelivery>[1]) {
      return db
        .transaction(() => importSubscriptionDelivery(db, input))
        .immediate();
    },
    reload: () => createConversationSubscriptionsRepo(db, createWriteQueue()),
  };
}

describe("subscription delivery imports", () => {
  it("durably inserts a subscription and frozen delivery once", async () => {
    const h = setup();
    const input = { subscription: subscription(), delivery: delivery() };
    expect(h.import(input)).toEqual(input.delivery);
    h.import(input);
    expect(await h.reload().get(recipient, "subscription")).toEqual(
      input.subscription,
    );
    expect(await h.reload().getDelivery(recipient, "delivery")).toEqual(
      input.delivery,
    );
    expect(
      (await h.reload().readInbox(recipient, { includeSettled: true })).total,
    ).toBe(1);
  });

  it("preserves subscription controls and canonical delivery, read, and finite wait identities while enriching summary evidence", async () => {
    const h = setup();
    const originalSubscription = {
      ...subscription(),
      status: "unfollowed" as const,
      mode: "active" as const,
      cursor: "99",
      pausedAt: at,
      eventKinds: ["some-event"],
    };
    await h.repo.createIfAbsent(originalSubscription);
    const canonical = delivery({
      id: "canonical",
      subscriptionId: originalSubscription.id,
    });
    const { sourceText: _sourceText, ...summaryFact } = canonical.fact;
    await h.repo.recordDelivery({
      ...canonical,
      fact: {
        ...summaryFact,
        eventKind: "terminal",
        outcome: null,
        summary: "Old summary",
      },
    });
    h.db
      .prepare(
        "INSERT INTO conversation_subscription_read_state VALUES (?,?,?,?)",
      )
      .run(recipient.projectPath, recipient.conversationId, "canonical", at);
    h.db
      .prepare(
        "INSERT INTO conversation_subscription_waits VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "wait",
        "subscription",
        recipient.projectPath,
        recipient.conversationId,
        "settled",
        at,
        "canonical",
        "batch",
        "{}",
      );
    const incoming = delivery({
      id: "legacy",
      subscriptionId: "legacy-subscription",
    });
    const imported = h.import({
      subscription: subscription("legacy-subscription"),
      delivery: incoming,
    });

    expect(imported).toEqual({
      ...incoming,
      id: "canonical",
      subscriptionId: "subscription",
      recordedAt: canonical.recordedAt,
    });
    expect(await h.reload().findBySource(recipient, source)).toEqual(
      originalSubscription,
    );
    expect(await h.reload().getDelivery(recipient, "canonical")).toEqual(
      imported,
    );
    expect(await h.reload().getDelivery(recipient, "legacy")).toBeNull();
    expect(
      h.db
        .prepare("SELECT delivery_id FROM conversation_subscription_read_state")
        .all(),
    ).toEqual([{ delivery_id: "canonical" }]);
    expect(
      h.db
        .prepare(
          "SELECT subscription_id,delivery_id FROM conversation_subscription_waits",
        )
        .all(),
    ).toEqual([{ subscription_id: "subscription", delivery_id: "canonical" }]);
  });

  it("keeps existing frozen source evidence unchanged on a later replay", async () => {
    const h = setup();
    const existing = delivery();
    await h.repo.createIfAbsent(subscription());
    await h.repo.recordDelivery(existing);
    const incoming = delivery({
      id: "replacement",
      fact: {
        ...existing.fact,
        summary: "Later reconstructed summary",
        sourceText: "Later reconstructed result",
        outcome: "failed",
      },
    });
    const imported = h.import({
      subscription: subscription(),
      delivery: incoming,
    });
    expect(imported.fact).toEqual(existing.fact);
    expect(await h.reload().getDelivery(recipient, existing.id)).toEqual(
      existing,
    );
  });

  const states = [
    "pending",
    "failed",
    "queued",
    "uncertain",
    "superseded",
    "accepted",
  ] as const;
  const pairs = states.flatMap((existingState, existingRank) =>
    states.map((incomingState, incomingRank) => ({
      existingState,
      incomingState,
      incomingStronger: incomingRank > existingRank,
    })),
  );
  it.each(pairs)(
    "retains the strongest receipt ($existingState existing, $incomingState imported)",
    async ({ existingState, incomingState, incomingStronger }) => {
      const h = setup();
      const existing = delivery({
        state: existingState,
        attemptId: "existing-attempt",
        attemptCount: 4,
        queuedAt: "existing-queued",
        acceptedAt: existingState === "accepted" ? "existing-accepted" : null,
        finishedAt: "existing-finished",
        lastError: "existing-error",
      });
      const incoming = delivery({
        id: "legacy",
        state: incomingState,
        attemptId: "legacy-attempt",
        attemptCount: 2,
        queuedAt: "legacy-queued",
        acceptedAt: incomingState === "accepted" ? "legacy-accepted" : null,
        finishedAt: "legacy-finished",
        lastError: "legacy-error",
      });
      await h.repo.createIfAbsent(subscription());
      await h.repo.recordDelivery(existing);
      const imported = h.import({
        subscription: subscription(),
        delivery: incoming,
      });
      const strongest = incomingStronger ? incoming : existing;
      expect(imported).toEqual({
        ...strongest,
        id: existing.id,
        subscriptionId: existing.subscriptionId,
        fact: existing.fact,
        recordedAt: existing.recordedAt,
        attemptCount: 4,
      });
      expect(await h.reload().getDelivery(recipient, existing.id)).toEqual(
        imported,
      );
    },
  );

  it("rejects a delivery for a different recipient without persisting a subscription", () => {
    const h = setup();
    expect(() =>
      h.import({
        subscription: subscription(),
        delivery: delivery({
          recipient: { ...recipient, conversationId: "other" },
        }),
      }),
    ).toThrow(/belong/i);
    expect(
      h.db
        .prepare("SELECT COUNT(*) AS total FROM conversation_subscriptions")
        .get(),
    ).toEqual({ total: 0 });
  });
});
