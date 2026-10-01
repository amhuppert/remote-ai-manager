import { afterEach, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionsRepo } from "../conversation-subscriptions-repo";
import { createConversationSubscriptionWaitsRepo } from "../conversation-subscription-waits-repo";
import { createWriteQueue } from "../write-queue";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
} from "@/lib/subscriptions/schemas";
import {
  activeSubscriptionWaitSchema,
  subscriptionWakeBatchSchema,
} from "@/lib/subscriptions/active-wait-schemas";
import { subscriptionWaitGenerations } from "./0065-subscription-wait-generations";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
const recipient = { projectPath: "/project", conversationId: "conversation" };
const at = "2026-10-01T12:00:00.000Z";

it("preserves old wait history and receipts while restoring spent follows and allowing one new live generation", async () => {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  db.exec(`DROP TABLE conversation_subscription_waits;
    CREATE TABLE conversation_subscription_waits (id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL UNIQUE,project_path TEXT NOT NULL,conversation_id TEXT NOT NULL,state TEXT NOT NULL,expires_at TEXT NOT NULL,delivery_id TEXT,batch_id TEXT,payload_json TEXT NOT NULL);`);
  const queue = createWriteQueue();
  const subscriptions = createConversationSubscriptionsRepo(db, queue);
  const waits = createConversationSubscriptionWaitsRepo(db, queue);
  const rows = [
    {
      id: "accepted",
      waitState: "settled",
      receipt: "accepted",
      batchState: "accepted",
    },
    {
      id: "discarded",
      waitState: "settled",
      receipt: "failed",
      batchState: "cancelled",
      status: "unfollowed",
    },
    {
      id: "unknown",
      waitState: "ready",
      receipt: "uncertain",
      batchState: "uncertain",
    },
    {
      id: "waiting",
      waitState: "waiting",
      receipt: "pending",
      batchState: "cancelled",
    },
  ];
  for (const row of rows) {
    const source = { kind: "workflow", id: row.id } as const;
    await subscriptions.createIfAbsent(
      conversationSubscriptionSchema.parse({
        id: row.id,
        recipient,
        source,
        reason: "Continue",
        mode: "active",
        eventKinds: null,
        expiresAt: at,
        status: row.status ?? "following",
        cursor: "9",
        createdAt: at,
        updatedAt: at,
        unfollowedAt: row.status ? at : null,
        pausedAt: at,
        missingAt: null,
        lastError: null,
      }),
    );
    await subscriptions.recordDelivery(
      subscriptionDeliverySchema.parse({
        id: `delivery-${row.id}`,
        subscriptionId: row.id,
        recipient,
        source,
        fact: {
          occurrenceId: "9",
          eventKind: "graph-workflow-terminal",
          category: "outcome",
          sourceTitle: "Workflow",
          summary: "Result",
          sourceText: "Frozen evidence",
          occurredAt: at,
          revision: null,
          outcome: "halted",
          retrievalHandle: "cctl workflow status run",
          actorConversationId: null,
        },
        recordedAt: at,
        state: row.receipt,
        attemptId: "attempt",
        attemptCount: 2,
        queuedAt: at,
        acceptedAt: row.receipt === "accepted" ? at : null,
        finishedAt: at,
        lastError: row.receipt === "failed" ? "Cancelled old wake" : null,
      }),
    );
    const batch = subscriptionWakeBatchSchema.parse({
      id: `batch-${row.id}`,
      recipient,
      waitIds: [`wait-${row.id}`],
      deliveryIds: [`delivery-${row.id}`],
      state: row.batchState,
      queueMessageId: `batch-${row.id}`,
      message: "Frozen wake",
      causationBatchIds: [],
      createdAt: at,
      updatedAt: at,
      finishedAt: at,
      lastError: null,
    });
    db.prepare(
      "INSERT INTO conversation_subscription_wake_batches VALUES (?,?,?,?,?,?)",
    ).run(
      batch.id,
      recipient.projectPath,
      recipient.conversationId,
      batch.state,
      at,
      JSON.stringify(batch),
    );
    const wait = activeSubscriptionWaitSchema.parse({
      id: `wait-${row.id}`,
      subscriptionId: row.id,
      recipient,
      source,
      reason: "Continue",
      expiresAt: at,
      state: row.waitState,
      outcome: row.waitState === "waiting" ? null : "source_terminal",
      deliveryId: `delivery-${row.id}`,
      batchId: batch.id,
      causationBatchIds: [],
      createdAt: at,
      updatedAt: at,
      finishedAt: at,
      lastError: null,
    });
    db.prepare(
      "INSERT INTO conversation_subscription_waits VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      wait.id,
      row.id,
      recipient.projectPath,
      recipient.conversationId,
      wait.state,
      at,
      wait.deliveryId,
      wait.batchId,
      JSON.stringify(wait),
    );
  }
  const beforeWaits = await waits.list(recipient);
  const beforeAccepted = await subscriptions.getDelivery(
    recipient,
    "delivery-accepted",
  );
  const beforeUnknown = await subscriptions.getDelivery(
    recipient,
    "delivery-unknown",
  );
  const migrate = () =>
    subscriptionWaitGenerations.up({
      name: subscriptionWaitGenerations.name,
      context: { db, configDir: null },
    });
  await migrate();
  expect(await waits.list(recipient)).toEqual(beforeWaits);
  expect(await subscriptions.get(recipient, "accepted")).toMatchObject({
    mode: "passive",
    expiresAt: null,
    status: "following",
    cursor: "9",
    pausedAt: at,
  });
  expect(await subscriptions.get(recipient, "discarded")).toMatchObject({
    mode: "passive",
    expiresAt: null,
    status: "unfollowed",
  });
  expect(await subscriptions.get(recipient, "unknown")).toMatchObject({
    mode: "active",
    expiresAt: at,
  });
  expect(await subscriptions.get(recipient, "waiting")).toMatchObject({
    mode: "active",
    expiresAt: at,
  });
  expect(
    await subscriptions.getDelivery(recipient, "delivery-accepted"),
  ).toEqual(beforeAccepted);
  expect(
    await subscriptions.getDelivery(recipient, "delivery-unknown"),
  ).toEqual(beforeUnknown);
  expect(
    await subscriptions.getDelivery(recipient, "delivery-discarded"),
  ).toMatchObject({
    state: "superseded",
    acceptedAt: null,
    attemptCount: 2,
    fact: { sourceText: "Frozen evidence" },
  });
  const after = await subscriptions.listDeliveriesForOverview(recipient);
  await migrate();
  expect(await subscriptions.listDeliveriesForOverview(recipient)).toEqual(
    after,
  );
  const previous = beforeWaits.find((row) => row.subscriptionId === "accepted");
  if (!previous) throw Error("Expected previous generation");
  const next = {
    ...previous,
    id: "rearmed",
    state: "waiting" as const,
    outcome: null,
    deliveryId: null,
    batchId: null,
    baselineOccurrenceId: "9",
    finishedAt: null,
  };
  const follow = await subscriptions.get(recipient, "accepted");
  if (!follow) throw Error("Expected follow");
  await waits.register(next, follow);
  expect(await waits.get(recipient, "accepted")).toMatchObject({
    id: "rearmed",
    baselineOccurrenceId: "9",
  });
  expect(
    (await waits.list(recipient)).filter(
      (row) => row.subscriptionId === "accepted",
    ),
  ).toHaveLength(2);
  expect(() =>
    db
      .prepare(
        "INSERT INTO conversation_subscription_waits SELECT 'concurrent',subscription_id,project_path,conversation_id,state,expires_at,delivery_id,batch_id,payload_json FROM conversation_subscription_waits WHERE id='rearmed'",
      )
      .run(),
  ).toThrow();
});
