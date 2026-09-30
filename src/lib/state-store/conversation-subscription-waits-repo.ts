import { z } from "zod";
import type { Db } from "./schemas";
import type { WriteQueue } from "./write-queue";
import {
  ActiveWaitConflictError,
  activeSubscriptionWaitSchema,
  subscriptionWakeBatchSchema,
  type ActiveSubscriptionWait,
  type SubscriptionWakeBatch,
} from "@/lib/subscriptions/active-wait-schemas";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
  subscriptionRecipientSchema,
  type ConversationSubscription,
  type SubscriptionDelivery,
  type SubscriptionRecipient,
} from "@/lib/subscriptions/schemas";

export interface ConversationSubscriptionWaitsRepo {
  register(
    wait: ActiveSubscriptionWait,
    subscription: ConversationSubscription,
  ): Promise<ActiveSubscriptionWait>;
  get(
    recipient: SubscriptionRecipient,
    subscriptionId: string,
  ): Promise<ActiveSubscriptionWait | null>;
  list(recipient?: SubscriptionRecipient): Promise<ActiveSubscriptionWait[]>;
  settle(
    waitId: string,
    outcome: NonNullable<ActiveSubscriptionWait["outcome"]>,
    delivery: SubscriptionDelivery,
    at: string,
  ): Promise<boolean>;
  recordFailure(waitId: string, error: string, at: string): Promise<void>;
  cancel(
    recipient: SubscriptionRecipient,
    subscriptionId: string,
    at: string,
    discardMissingBatchId?: string,
  ): Promise<ActiveSubscriptionWait | null>;
  listRecipients(): Promise<SubscriptionRecipient[]>;
  reserveBatch(
    batch: SubscriptionWakeBatch,
  ): Promise<SubscriptionWakeBatch | null>;
  listPendingBatches(): Promise<SubscriptionWakeBatch[]>;
  getBatch(batchId: string): Promise<SubscriptionWakeBatch | null>;
  markBatchQueued(batchId: string, at: string): Promise<void>;
  settleBatch(
    batchId: string,
    state: "accepted" | "failed" | "uncertain" | "cancelled",
    at: string,
    error: string | null,
  ): Promise<void>;
}

const waitRowSchema = z.object({
  id: z.string(),
  subscription_id: z.string(),
  project_path: z.string(),
  conversation_id: z.string(),
  state: z.string(),
  expires_at: z.string(),
  delivery_id: z.string().nullable(),
  batch_id: z.string().nullable(),
  payload_json: z.string(),
});
const batchRowSchema = z.object({
  id: z.string(),
  project_path: z.string(),
  conversation_id: z.string(),
  state: z.string(),
  created_at: z.string(),
  payload_json: z.string(),
});
function waitFromRow(raw: unknown): ActiveSubscriptionWait {
  const row = waitRowSchema.parse(raw);
  const value = activeSubscriptionWaitSchema.parse(
    JSON.parse(row.payload_json) as unknown,
  );
  if (
    value.id !== row.id ||
    value.subscriptionId !== row.subscription_id ||
    value.recipient.projectPath !== row.project_path ||
    value.recipient.conversationId !== row.conversation_id ||
    value.state !== row.state ||
    value.expiresAt !== row.expires_at ||
    value.deliveryId !== row.delivery_id ||
    value.batchId !== row.batch_id
  )
    throw new Error("Active wait indexed identity disagrees with its payload");
  return value;
}
function batchFromRow(raw: unknown): SubscriptionWakeBatch {
  const row = batchRowSchema.parse(raw);
  const value = subscriptionWakeBatchSchema.parse(
    JSON.parse(row.payload_json) as unknown,
  );
  if (
    value.id !== row.id ||
    value.recipient.projectPath !== row.project_path ||
    value.recipient.conversationId !== row.conversation_id ||
    value.state !== row.state ||
    value.createdAt !== row.created_at
  )
    throw new Error("Wake batch indexed identity disagrees with its payload");
  return value;
}
function scope(recipient: SubscriptionRecipient) {
  const parsed = subscriptionRecipientSchema.parse(recipient);
  return {
    project_path: parsed.projectPath,
    conversation_id: parsed.conversationId,
  };
}

/** Owns the atomic wait/outcome/inbox and wake reservation transitions. */
export function createConversationSubscriptionWaitsRepo(
  db: Db,
  writeQueue: WriteQueue,
): ConversationSubscriptionWaitsRepo {
  const writeWaitStatement =
    db.prepare(`INSERT INTO conversation_subscription_waits
    (id,subscription_id,project_path,conversation_id,state,expires_at,delivery_id,batch_id,payload_json)
    VALUES (@id,@subscription_id,@project_path,@conversation_id,@state,@expires_at,@delivery_id,@batch_id,@payload_json)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at,delivery_id=excluded.delivery_id,batch_id=excluded.batch_id,payload_json=excluded.payload_json`);
  const writeBatchStatement =
    db.prepare(`INSERT INTO conversation_subscription_wake_batches
    (id,project_path,conversation_id,state,created_at,payload_json) VALUES (@id,@project_path,@conversation_id,@state,@created_at,@payload_json)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json`);
  function writeWait(input: ActiveSubscriptionWait) {
    const value = activeSubscriptionWaitSchema.parse(input);
    writeWaitStatement.run({
      id: value.id,
      subscription_id: value.subscriptionId,
      ...scope(value.recipient),
      state: value.state,
      expires_at: value.expiresAt,
      delivery_id: value.deliveryId,
      batch_id: value.batchId,
      payload_json: JSON.stringify(value),
    });
  }
  function writeBatch(input: SubscriptionWakeBatch) {
    const value = subscriptionWakeBatchSchema.parse(input);
    writeBatchStatement.run({
      id: value.id,
      ...scope(value.recipient),
      state: value.state,
      created_at: value.createdAt,
      payload_json: JSON.stringify(value),
    });
  }
  function readWait(id: string) {
    const raw: unknown = db
      .prepare("SELECT * FROM conversation_subscription_waits WHERE id=?")
      .get(id);
    return raw === undefined ? null : waitFromRow(raw);
  }
  function readBatch(id: string) {
    const raw: unknown = db
      .prepare(
        "SELECT * FROM conversation_subscription_wake_batches WHERE id=?",
      )
      .get(id);
    return raw === undefined ? null : batchFromRow(raw);
  }
  function readRecipientWait(
    recipient: SubscriptionRecipient,
    subscriptionId: string,
  ) {
    const raw: unknown = db
      .prepare(
        "SELECT * FROM conversation_subscription_waits WHERE project_path=@project_path AND conversation_id=@conversation_id AND subscription_id=@subscription_id",
      )
      .get({ ...scope(recipient), subscription_id: subscriptionId });
    return raw === undefined ? null : waitFromRow(raw);
  }
  function following(wait: ActiveSubscriptionWait): boolean {
    return (
      db
        .prepare(
          "SELECT 1 FROM conversation_subscriptions WHERE id=@id AND project_path=@project_path AND conversation_id=@conversation_id AND mode='active' AND status='following'",
        )
        .get({ id: wait.subscriptionId, ...scope(wait.recipient) }) !==
      undefined
    );
  }
  function pendingBatch(recipient: SubscriptionRecipient) {
    const raw: unknown = db
      .prepare(
        "SELECT * FROM conversation_subscription_wake_batches WHERE project_path=@project_path AND conversation_id=@conversation_id AND state IN ('planned','queued','failed','uncertain') LIMIT 1",
      )
      .get(scope(recipient));
    return raw === undefined ? null : batchFromRow(raw);
  }
  const registerTx = db.transaction(
    (input: ActiveSubscriptionWait, subscription: ConversationSubscription) => {
      if (
        input.subscriptionId !== subscription.id ||
        input.recipient.projectPath !== subscription.recipient.projectPath ||
        input.recipient.conversationId !==
          subscription.recipient.conversationId ||
        input.source.kind !== subscription.source.kind ||
        input.source.id !== subscription.source.id
      )
        throw new Error("Active wait does not belong to its subscription");
      db.prepare(
        `INSERT INTO conversation_subscriptions (id,project_path,conversation_id,source_kind,source_id,reason,mode,event_kinds_json,expires_at,status,cursor,created_at,updated_at,unfollowed_at,missing_at,last_error)
      VALUES (@id,@project_path,@conversation_id,@source_kind,@source_id,@reason,'active',NULL,@expires_at,'following',@cursor,@created_at,@updated_at,NULL,NULL,NULL)
      ON CONFLICT(project_path,conversation_id,source_kind,source_id) DO NOTHING`,
      ).run({
        id: subscription.id,
        ...scope(subscription.recipient),
        source_kind: subscription.source.kind,
        source_id: subscription.source.id,
        reason: input.reason,
        expires_at: input.expiresAt,
        cursor: subscription.cursor,
        created_at: subscription.createdAt,
        updated_at: subscription.updatedAt,
      });
      const row = z.object({ id: z.string() }).parse(
        db
          .prepare(
            "SELECT id FROM conversation_subscriptions WHERE project_path=@project_path AND conversation_id=@conversation_id AND source_kind=@source_kind AND source_id=@source_id",
          )
          .get({
            ...scope(input.recipient),
            source_kind: input.source.kind,
            source_id: input.source.id,
          }),
      );
      const existing = readRecipientWait(input.recipient, row.id);
      if (existing) return existing;
      const value = { ...input, subscriptionId: row.id };
      db.prepare(
        "UPDATE conversation_subscriptions SET mode='active',status='following',reason=@reason,expires_at=@expires_at,updated_at=@at,unfollowed_at=NULL,missing_at=NULL,last_error=NULL WHERE id=@id",
      ).run({
        id: row.id,
        reason: input.reason,
        expires_at: input.expiresAt,
        at: input.updatedAt,
      });
      writeWait(value);
      return value;
    },
  );
  const settleTx = db.transaction(
    (
      waitId: string,
      outcome: NonNullable<ActiveSubscriptionWait["outcome"]>,
      input: SubscriptionDelivery,
      at: string,
    ) => {
      const wait = readWait(waitId);
      if (!wait || wait.state !== "waiting" || !following(wait)) return false;
      const delivery = subscriptionDeliverySchema.parse(input);
      if (
        delivery.subscriptionId !== wait.subscriptionId ||
        delivery.recipient.projectPath !== wait.recipient.projectPath ||
        delivery.recipient.conversationId !== wait.recipient.conversationId ||
        delivery.source.kind !== wait.source.kind ||
        delivery.source.id !== wait.source.id
      )
        throw new Error("Active wait outcome does not belong to this wait");
      db.prepare(
        `INSERT INTO conversation_subscription_deliveries (id,subscription_id,project_path,conversation_id,source_kind,source_id,occurrence_id,fact_json,recorded_at,state,attempt_id,attempt_count,queued_at,accepted_at,finished_at,last_error)
      VALUES (@id,@subscription_id,@project_path,@conversation_id,@source_kind,@source_id,@occurrence_id,@fact_json,@recorded_at,@state,@attempt_id,@attempt_count,@queued_at,@accepted_at,@finished_at,@last_error)`,
      ).run({
        id: delivery.id,
        subscription_id: delivery.subscriptionId,
        ...scope(delivery.recipient),
        source_kind: delivery.source.kind,
        source_id: delivery.source.id,
        occurrence_id: delivery.fact.occurrenceId,
        fact_json: JSON.stringify(delivery.fact),
        recorded_at: delivery.recordedAt,
        state: delivery.state,
        attempt_id: delivery.attemptId,
        attempt_count: delivery.attemptCount,
        queued_at: delivery.queuedAt,
        accepted_at: delivery.acceptedAt,
        finished_at: delivery.finishedAt,
        last_error: delivery.lastError,
      });
      writeWait({
        ...wait,
        state: "ready",
        outcome,
        deliveryId: delivery.id,
        updatedAt: at,
        lastError: null,
      });
      return true;
    },
  );
  const cancelTx = db.transaction(
    (
      recipient: SubscriptionRecipient,
      subscriptionId: string,
      at: string,
      discardMissingBatchId?: string,
    ) => {
      const wait = readRecipientWait(recipient, subscriptionId);
      if (!wait) return null;
      const batch = wait.batchId === null ? null : readBatch(wait.batchId);
      const discardMissing =
        batch !== null &&
        batch.id === discardMissingBatchId &&
        batch.state === "uncertain" &&
        batch.recipient.projectPath === recipient.projectPath &&
        batch.recipient.conversationId === recipient.conversationId;
      if (
        batch &&
        batch.state !== "accepted" &&
        batch.state !== "cancelled" &&
        wait.state !== "cancelled" &&
        !discardMissing
      )
        throw new ActiveWaitConflictError();
      const next: ActiveSubscriptionWait =
        wait.state === "settled"
          ? wait
          : { ...wait, state: "cancelled", updatedAt: at, finishedAt: at };
      writeWait(next);
      if (discardMissing && batch) {
        const error =
          "This wait's unresolved wake was explicitly discarded after confirming its queue row and acceptance receipt were absent";
        db.prepare(
          "UPDATE conversation_subscription_deliveries SET state='failed',finished_at=@at,last_error=@error WHERE id=@id AND attempt_id=@batch_id AND project_path=@project_path AND conversation_id=@conversation_id AND state IN ('queued','uncertain','failed')",
        ).run({
          id: wait.deliveryId,
          batch_id: batch.id,
          ...scope(recipient),
          at,
          error,
        });
        const remaining = db
          .prepare(
            "SELECT 1 FROM conversation_subscription_waits WHERE batch_id=? AND state IN ('waiting','ready') LIMIT 1",
          )
          .get(batch.id);
        // Unfollowing one coalesced wait spends only that wait. The governor
        // releases after every remaining member is explicitly discarded.
        if (remaining === undefined)
          writeBatch({
            ...batch,
            state: "cancelled",
            updatedAt: at,
            finishedAt: at,
            lastError: error,
          });
      }
      db.prepare(
        "UPDATE conversation_subscriptions SET status='unfollowed',unfollowed_at=COALESCE(unfollowed_at,@at),updated_at=@at WHERE id=@id AND project_path=@project_path AND conversation_id=@conversation_id",
      ).run({ id: subscriptionId, ...scope(recipient), at });
      return next;
    },
  );
  const reserveTx = db.transaction((batch: SubscriptionWakeBatch) => {
    const incumbent = pendingBatch(batch.recipient);
    if (incumbent) return incumbent;
    const cutoff = new Date(Date.parse(batch.createdAt) - 60_000).toISOString();
    const count = z
      .object({ count: z.number() })
      .parse(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM conversation_subscription_wake_batches WHERE project_path=@project_path AND conversation_id=@conversation_id AND created_at>@cutoff",
          )
          .get({ ...scope(batch.recipient), cutoff }),
      );
    if (count.count >= 3) return null;
    if (
      batch.queueMessageId !== batch.id ||
      batch.waitIds.length !== batch.deliveryIds.length
    )
      throw new Error("Wake batch identities disagree");
    const waits = batch.waitIds.map(readWait);
    if (
      waits.some(
        (wait, i) =>
          !wait ||
          wait.state !== "ready" ||
          wait.batchId !== null ||
          wait.deliveryId !== batch.deliveryIds[i] ||
          wait.recipient.projectPath !== batch.recipient.projectPath ||
          wait.recipient.conversationId !== batch.recipient.conversationId ||
          !following(wait),
      )
    )
      return null;
    writeBatch(batch);
    for (const wait of waits) {
      if (!wait) throw new Error("Reserved wait disappeared");
      writeWait({ ...wait, batchId: batch.id, updatedAt: batch.createdAt });
      const claimed = db
        .prepare(
          "UPDATE conversation_subscription_deliveries SET state='queued',attempt_id=@batch_id,attempt_count=attempt_count+1,queued_at=@at,finished_at=NULL,last_error=NULL WHERE id=@id AND state='pending'",
        )
        .run({ batch_id: batch.id, at: batch.createdAt, id: wait.deliveryId });
      if (claimed.changes !== 1)
        throw new Error("Wake delivery was not available for reservation");
    }
    return batch;
  });
  const settleBatchTx = db.transaction(
    (
      batchId: string,
      state: "accepted" | "failed" | "uncertain" | "cancelled",
      at: string,
      error: string | null,
    ) => {
      const batch = readBatch(batchId);
      if (!batch || batch.state === "accepted" || batch.state === "cancelled")
        return;
      writeBatch({
        ...batch,
        state,
        updatedAt: at,
        finishedAt: at,
        lastError: error,
      });
      for (const id of batch.waitIds) {
        const wait = readWait(id);
        if (!wait || wait.batchId !== batch.id)
          throw new Error("Wake batch lost its wait ownership");
        if (
          (state === "accepted" || state === "cancelled") &&
          wait.state !== "cancelled"
        )
          writeWait({
            ...wait,
            state: "settled",
            updatedAt: at,
            finishedAt: at,
            lastError: error,
          });
      }
      db.prepare(
        `UPDATE conversation_subscription_deliveries SET state=@state,accepted_at=CASE WHEN @state='accepted' THEN @at ELSE NULL END,finished_at=@at,last_error=@error
      WHERE project_path=@project_path AND conversation_id=@conversation_id AND attempt_id=@batch_id AND state IN ('queued','failed','uncertain')
      AND (@state='accepted' OR NOT EXISTS (SELECT 1 FROM conversation_subscription_waits AS wait WHERE wait.delivery_id=conversation_subscription_deliveries.id AND wait.state='cancelled'))`,
      ).run({
        ...scope(batch.recipient),
        batch_id: batch.id,
        state: state === "cancelled" ? "failed" : state,
        at,
        error:
          state === "cancelled"
            ? (error ?? "Wake message cancelled before input acceptance")
            : error,
      });
    },
  );
  return {
    async register(wait, subscription) {
      const parsed = activeSubscriptionWaitSchema.parse(wait);
      const parent = conversationSubscriptionSchema.parse(subscription);
      return writeQueue.withWriteQueueSync("subscriptions.wait.register", () =>
        registerTx.immediate(parsed, parent),
      );
    },
    async get(recipient, subscriptionId) {
      return readRecipientWait(recipient, subscriptionId);
    },
    async list(recipient) {
      const raw: unknown[] = recipient
        ? db
            .prepare(
              "SELECT * FROM conversation_subscription_waits WHERE project_path=@project_path AND conversation_id=@conversation_id ORDER BY rowid",
            )
            .all(scope(recipient))
        : db
            .prepare(
              "SELECT * FROM conversation_subscription_waits ORDER BY rowid",
            )
            .all();
      return raw.map(waitFromRow);
    },
    async settle(waitId, outcome, delivery, at) {
      return writeQueue.withWriteQueueSync("subscriptions.wait.settle", () =>
        settleTx.immediate(waitId, outcome, delivery, at),
      );
    },
    async recordFailure(waitId, error, at) {
      await writeQueue.withWriteQueueSync("subscriptions.wait.failure", () => {
        const wait = readWait(waitId);
        if (wait?.state === "waiting")
          writeWait({ ...wait, updatedAt: at, lastError: error });
      });
    },
    async cancel(recipient, subscriptionId, at, discardMissingBatchId) {
      return writeQueue.withWriteQueueSync("subscriptions.wait.cancel", () =>
        cancelTx.immediate(
          recipient,
          subscriptionId,
          at,
          discardMissingBatchId,
        ),
      );
    },
    async listRecipients() {
      const rows: unknown[] = db
        .prepare(
          "SELECT DISTINCT project_path AS projectPath,conversation_id AS conversationId FROM conversation_subscription_waits WHERE state IN ('waiting','ready')",
        )
        .all();
      return rows.map((row) => subscriptionRecipientSchema.parse(row));
    },
    async reserveBatch(batch) {
      const parsed = subscriptionWakeBatchSchema.parse(batch);
      return writeQueue.withWriteQueueSync("subscriptions.wake.reserve", () =>
        reserveTx.immediate(parsed),
      );
    },
    async listPendingBatches() {
      return (
        db
          .prepare(
            "SELECT * FROM conversation_subscription_wake_batches WHERE state IN ('planned','queued','failed','uncertain') ORDER BY rowid",
          )
          .all() as unknown[]
      ).map(batchFromRow);
    },
    async getBatch(batchId) {
      return readBatch(batchId);
    },
    async markBatchQueued(batchId, at) {
      await writeQueue.withWriteQueueSync("subscriptions.wake.queued", () => {
        const batch = readBatch(batchId);
        if (!batch || batch.state === "accepted" || batch.state === "cancelled")
          return;
        writeBatch({
          ...batch,
          state: "queued",
          updatedAt: at,
          finishedAt: null,
          lastError: null,
        });
        db.prepare(
          "UPDATE conversation_subscription_deliveries SET state='queued',finished_at=NULL,last_error=NULL WHERE attempt_id=@batch_id AND project_path=@project_path AND conversation_id=@conversation_id AND state IN ('failed','uncertain') AND NOT EXISTS (SELECT 1 FROM conversation_subscription_waits AS wait WHERE wait.delivery_id=conversation_subscription_deliveries.id AND wait.state='cancelled')",
        ).run({ batch_id: batch.id, ...scope(batch.recipient) });
      });
    },
    async settleBatch(batchId, state, at, error) {
      await writeQueue.withWriteQueueSync("subscriptions.wake.settle", () =>
        settleBatchTx.immediate(batchId, state, at, error),
      );
    },
  };
}
