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
import { retireAutomaticValidationFollows } from "./0064-retire-automatic-validation-follows";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

it("retires only automatic passive validation follows without waits and preserves evidence and explicit controls", async () => {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  const repo = createConversationSubscriptionsRepo(db, createWriteQueue());
  const recipient = { projectPath: "/project", conversationId: "conversation" };
  const at = "2026-10-01T10:00:00Z";
  const automatic = "Validation submitted by this conversation";
  const rows = [
    { id: "automatic", reason: automatic },
    { id: "explicit", reason: "Tell me the validation result" },
    { id: "active", reason: automatic, mode: "active" },
    { id: "wait", reason: automatic },
    { id: "spent-wait", reason: automatic },
    {
      id: "unfollowed",
      reason: automatic,
      status: "unfollowed",
      unfollowedAt: at,
    },
    { id: "other-source", reason: automatic, sourceKind: "spec" },
  ].map(({ sourceKind = "validation", ...overrides }) =>
    conversationSubscriptionSchema.parse({
      recipient,
      source: { kind: sourceKind, id: overrides.id },
      mode: "passive",
      eventKinds: null,
      expiresAt: null,
      status: "following",
      cursor: "9",
      createdAt: at,
      updatedAt: at,
      unfollowedAt: null,
      pausedAt: at,
      missingAt: null,
      lastError: null,
      ...overrides,
    }),
  );
  for (const subscription of rows) {
    await repo.createIfAbsent(subscription);
    await repo.recordDelivery(
      subscriptionDeliverySchema.parse({
        id: `delivery-${subscription.id}`,
        subscriptionId: subscription.id,
        recipient,
        source: subscription.source,
        fact: {
          occurrenceId: "1",
          eventKind: "validation-completed",
          category: "outcome",
          sourceTitle: "Validation",
          summary: "Completed",
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
      }),
    );
  }
  db.prepare(
    "INSERT INTO conversation_subscription_waits VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "wait-row",
    "wait",
    recipient.projectPath,
    recipient.conversationId,
    "waiting",
    at,
    null,
    null,
    "{}",
  );
  db.prepare(
    "INSERT INTO conversation_subscription_waits VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "spent-row",
    "spent-wait",
    recipient.projectPath,
    recipient.conversationId,
    "settled",
    at,
    "delivery-spent-wait",
    null,
    "{}",
  );
  const evidence = await repo.listDeliveriesForOverview(recipient);
  const waits = db
    .prepare("SELECT * FROM conversation_subscription_waits ORDER BY id")
    .all();
  const migration = () =>
    retireAutomaticValidationFollows.up({
      name: retireAutomaticValidationFollows.name,
      context: { db, configDir: null },
    });
  await migration();
  const retired = await repo.get(recipient, "automatic");
  expect(retired).toMatchObject({
    status: "unfollowed",
    cursor: "9",
    pausedAt: at,
    unfollowedAt: expect.any(String),
  });
  for (const row of rows.filter((row) => row.id !== "automatic"))
    expect(await repo.get(recipient, row.id)).toEqual(row);
  expect(await repo.listDeliveriesForOverview(recipient)).toEqual(evidence);
  expect(
    db
      .prepare("SELECT * FROM conversation_subscription_waits ORDER BY id")
      .all(),
  ).toEqual(waits);
  await migration();
  expect(await repo.get(recipient, "automatic")).toEqual(retired);
});
