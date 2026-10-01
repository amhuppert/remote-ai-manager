import { afterEach, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionsRepo } from "../conversation-subscriptions-repo";
import { createWriteQueue } from "../write-queue";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
} from "@/lib/subscriptions/schemas";
import { retireConsumedFiniteWaitSourcesMigration } from "./0067-retire-consumed-finite-wait-sources";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
it("retires only consumed finite terminal sources without losing explicit controls or historical receipts", async () => {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  const repo = createConversationSubscriptionsRepo(db, createWriteQueue());
  const recipient = { projectPath: "/project", conversationId: "conversation" };
  const at = "2026-10-01T12:00:00.000Z";
  const cases = [
    {
      id: "accepted",
      kind: "validation",
      event: "validation-completed",
      receipt: "accepted",
      wait: true,
    },
    {
      id: "dismissed",
      kind: "git_job",
      event: "git-job-outcome",
      receipt: "superseded",
      wait: true,
    },
    {
      id: "expired",
      kind: "validation",
      event: "subscription-wait-expired",
      receipt: "accepted",
      wait: true,
    },
    {
      id: "unknown",
      kind: "validation",
      event: "validation-completed",
      receipt: "uncertain",
      wait: true,
    },
    {
      id: "explicit-passive",
      kind: "validation",
      event: "validation-completed",
      receipt: "accepted",
      wait: false,
    },
    {
      id: "workflow",
      kind: "workflow",
      event: "graph-workflow-boundary:halt",
      receipt: "accepted",
      wait: true,
    },
  ];
  for (const row of cases) {
    const subscription = conversationSubscriptionSchema.parse({
      id: row.id,
      recipient,
      source: { kind: row.kind, id: row.id },
      reason: "Inspect",
      mode: "passive",
      eventKinds: null,
      expiresAt: null,
      status: row.id === "dismissed" ? "unfollowed" : "following",
      cursor: "running",
      createdAt: at,
      updatedAt: at,
      unfollowedAt: row.id === "dismissed" ? at : null,
      pausedAt: at,
      missingAt: null,
      lastError: null,
    });
    await repo.createIfAbsent(subscription);
    await repo.recordDelivery(
      subscriptionDeliverySchema.parse({
        id: `delivery-${row.id}`,
        subscriptionId: row.id,
        recipient,
        source: subscription.source,
        fact: {
          occurrenceId: "terminal",
          eventKind: row.event,
          category: "outcome",
          sourceTitle: "Source",
          summary: "Outcome",
          occurredAt: at,
          revision: null,
          outcome: "passed",
          retrievalHandle: "cctl inbox list",
          actorConversationId: null,
        },
        recordedAt: at,
        state: row.receipt,
        attemptId: "attempt",
        attemptCount: 1,
        queuedAt: at,
        acceptedAt: row.receipt === "accepted" ? at : null,
        finishedAt: at,
        lastError: null,
      }),
    );
    if (row.wait)
      db.prepare(
        "INSERT INTO conversation_subscription_waits VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(
        `wait-${row.id}`,
        row.id,
        recipient.projectPath,
        recipient.conversationId,
        "settled",
        at,
        `delivery-${row.id}`,
        null,
        "{}",
      );
  }
  const before = await repo.list(recipient);
  const receipts = await repo.listDeliveriesForOverview(recipient);
  const migrate = () =>
    retireConsumedFiniteWaitSourcesMigration.up({
      name: retireConsumedFiniteWaitSourcesMigration.name,
      context: { db, configDir: null },
    });
  db.exec(
    "CREATE TRIGGER reject_retirement BEFORE UPDATE ON conversation_subscriptions WHEN NEW.id='dismissed' BEGIN SELECT RAISE(ABORT,'reject'); END;",
  );
  await expect(migrate()).rejects.toThrow("reject");
  expect(await repo.list(recipient)).toEqual(before);
  db.exec("DROP TRIGGER reject_retirement");
  await migrate();
  for (const subscription of before)
    expect(await repo.get(recipient, subscription.id)).toEqual(
      ["accepted", "dismissed"].includes(subscription.id)
        ? { ...subscription, expiresAt: at }
        : subscription,
    );
  expect(await repo.listDeliveriesForOverview(recipient)).toEqual(receipts);
  const after = await repo.list(recipient);
  await migrate();
  expect(await repo.list(recipient)).toEqual(after);
});
