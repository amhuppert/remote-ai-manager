import { z } from "zod";
import { importSubscriptionDelivery } from "./subscription-delivery-import";
import {
  ensureFiniteWaitSourceCursor,
  releaseBatchClaims,
  retireConsumedFiniteWaitSources,
  retireFinishedRunFollows,
} from "./subscription-wait-lifecycle";
import type { Db } from "./schemas";
import type { WriteQueue } from "./write-queue";
import { WAKING_FOLLOW } from "./conversation-subscriptions-repo";
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

export type SubscriptionControlChange = Partial<
  Pick<
    ConversationSubscription,
    | "status"
    | "mode"
    | "pausedAt"
    | "expiresAt"
    | "reason"
    | "eventKinds"
    | "cursor"
    | "missingAt"
    | "lastError"
  >
> & { cancelWait?: boolean };
export interface ConversationSubscriptionWaitsRepo {
  applyControl(
    recipient: SubscriptionRecipient,
    subscriptionId: string,
    change: SubscriptionControlChange,
    at: string,
    releaseBatchId?: string,
  ): Promise<void>;
  /** Used only within the canonical queue's serialized conversation write. */
  applyControlWithinWrite(
    recipient: SubscriptionRecipient,
    subscriptionId: string,
    change: SubscriptionControlChange,
    at: string,
    releaseBatchId?: string,
  ): void;
  isBatchDispatchable(batchId: string): Promise<boolean>;
  rateLimitUntil(
    recipient: SubscriptionRecipient,
    at: string,
  ): Promise<string | null>;
  register(
    wait: ActiveSubscriptionWait,
    subscription: ConversationSubscription,
  ): Promise<ActiveSubscriptionWait>;
  get(
    recipient: SubscriptionRecipient,
    subscriptionId: string,
    waitId?: string,
  ): Promise<ActiveSubscriptionWait | null>;
  /** Most recently registered generation first, including historical generations. */
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
  /** Recipients with a live one-time wait or an unsent fact of a follow that wakes them. */
  listRecipients(at: string): Promise<SubscriptionRecipient[]>;
  /**
   * Ends a wake of follow facts only that never reached the queue (no row, no
   * acceptance) and returns its facts for another wake. False for any other batch.
   */
  releaseUnsent(batchId: string, at: string): Promise<boolean>;
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
    waitId?: string,
  ) {
    const raw: unknown = db
      .prepare(
        "SELECT * FROM conversation_subscription_waits WHERE project_path=@project_path AND conversation_id=@conversation_id AND subscription_id=@subscription_id AND (@wait_id IS NULL OR id=@wait_id) ORDER BY rowid DESC LIMIT 1",
      )
      .get({
        ...scope(recipient),
        subscription_id: subscriptionId,
        wait_id: waitId ?? null,
      });
    return raw === undefined ? null : waitFromRow(raw);
  }
  function following(wait: ActiveSubscriptionWait): boolean {
    return (
      db
        .prepare(
          "SELECT 1 FROM conversation_subscriptions WHERE id=@id AND project_path=@project_path AND conversation_id=@conversation_id AND mode='active' AND status='following' AND paused_at IS NULL",
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
        `INSERT INTO conversation_subscriptions (id,project_path,conversation_id,source_kind,source_id,reason,mode,event_kinds_json,expires_at,status,cursor,created_at,updated_at,unfollowed_at,paused_at,missing_at,last_error)
      VALUES (@id,@project_path,@conversation_id,@source_kind,@source_id,@reason,'active',NULL,@expires_at,'following',@cursor,@created_at,@updated_at,NULL,@paused_at,NULL,NULL)
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
        paused_at: subscription.pausedAt,
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
      if (
        existing &&
        (existing.state === "waiting" || existing.state === "ready")
      )
        return existing;
      const value = { ...input, subscriptionId: row.id };
      db.prepare(
        "UPDATE conversation_subscriptions SET mode='active',status='following',reason=@reason,expires_at=@expires_at,updated_at=@at,unfollowed_at=NULL,paused_at=@paused_at,missing_at=NULL,last_error=NULL,cursor=CASE WHEN status='unfollowed' THEN @cursor ELSE cursor END WHERE id=@id",
      ).run({
        id: row.id,
        reason: input.reason,
        expires_at: input.expiresAt,
        at: input.updatedAt,
        paused_at: subscription.pausedAt,
        cursor: subscription.cursor,
      });
      writeWait(value);
      return value;
    },
  );
  function restorePassive(wait: ActiveSubscriptionWait, at: string) {
    db.prepare(
      "UPDATE conversation_subscriptions SET mode='passive',expires_at=NULL,updated_at=@at WHERE id=@id AND NOT EXISTS (SELECT 1 FROM conversation_subscription_waits WHERE subscription_id=@id AND id<>@wait_id AND state IN ('waiting','ready'))",
    ).run({ id: wait.subscriptionId, wait_id: wait.id, at });
    ensureFiniteWaitSourceCursor(db, wait.recipient);
    retireConsumedFiniteWaitSources(db, wait.recipient);
  }
  const settleTx = db.transaction(
    (
      waitId: string,
      outcome: NonNullable<ActiveSubscriptionWait["outcome"]>,
      input: SubscriptionDelivery,
      at: string,
    ) => {
      const wait = readWait(waitId);
      if (
        !wait ||
        (wait.state !== "waiting" &&
          !(
            wait.state === "ready" &&
            wait.batchId === null &&
            wait.deliveryId === input.id &&
            ["accepted", "superseded", "failed"].includes(input.state)
          ))
      )
        return false;
      if (
        db
          .prepare(
            "SELECT 1 FROM conversation_subscriptions WHERE id=? AND status='following'",
          )
          .get(wait.subscriptionId) === undefined
      )
        return false;
      const delivery = subscriptionDeliverySchema.parse(input);
      if (
        delivery.subscriptionId !== wait.subscriptionId ||
        delivery.recipient.projectPath !== wait.recipient.projectPath ||
        delivery.recipient.conversationId !== wait.recipient.conversationId ||
        delivery.source.kind !== wait.source.kind ||
        delivery.source.id !== wait.source.id
      )
        throw new Error("Active wait outcome does not belong to this wait");
      const canonical = importSubscriptionDelivery(db, {
        subscription: {
          id: wait.subscriptionId,
          recipient: wait.recipient,
          source: wait.source,
          reason: wait.reason,
          wakes: false,
          mode: "active",
          eventKinds: null,
          expiresAt: wait.expiresAt,
          status: "following",
          cursor: null,
          createdAt: wait.createdAt,
          updatedAt: at,
          unfollowedAt: null,
          pausedAt: null,
          missingAt: null,
          lastError: null,
        },
        delivery,
      });
      // Proven-unsent passive input can be retried by this explicit wait.
      // Ambiguous and already queued receipts remain held for reconciliation.
      if (canonical.state === "failed")
        db.prepare(
          "UPDATE conversation_subscription_deliveries SET state='pending',finished_at=NULL WHERE id=? AND state='failed'",
        ).run(canonical.id);
      writeWait({
        ...wait,
        state: ["accepted", "superseded"].includes(canonical.state)
          ? "settled"
          : "ready",
        outcome,
        deliveryId: canonical.id,
        finishedAt: ["accepted", "superseded"].includes(canonical.state)
          ? (canonical.acceptedAt ?? at)
          : null,
        updatedAt: at,
        lastError: null,
      });
      if (["accepted", "superseded"].includes(canonical.state))
        restorePassive(wait, at);
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
          "UPDATE conversation_subscription_deliveries SET state='superseded',finished_at=@at,last_error=@error WHERE id=@id AND attempt_id=@batch_id AND project_path=@project_path AND conversation_id=@conversation_id AND state IN ('queued','uncertain','failed')",
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
        if (remaining === undefined) {
          writeBatch({
            ...batch,
            state: "cancelled",
            updatedAt: at,
            finishedAt: at,
            lastError: error,
          });
          releaseBatchClaims(db, batch.recipient, batch.id);
        }
      }
      restorePassive(next, at);
      return next;
    },
  );
  function isBatchDispatchable(batchId: string): boolean {
    const batch = readBatch(batchId);
    if (!batch || (batch.state !== "planned" && batch.state !== "queued"))
      return false;
    // A follow's fact handed to a wake is delivered whatever later controls say:
    // pause and unfollow govern facts not yet reserved.
    const stillClaimed = db.prepare(
      "SELECT 1 FROM conversation_subscription_deliveries WHERE id=? AND attempt_id=? AND state='queued'",
    );
    if (
      batch.followDeliveryIds.some(
        (id) => stillClaimed.get(id, batch.id) === undefined,
      )
    )
      return false;
    return batch.waitIds.every((id, index) => {
      const wait = readWait(id);
      if (
        !wait ||
        wait.state !== "ready" ||
        wait.batchId !== batch.id ||
        wait.deliveryId !== batch.deliveryIds[index] ||
        !following(wait)
      )
        return false;
      return (
        db
          .prepare(
            "SELECT 1 FROM conversation_subscription_deliveries WHERE id=? AND attempt_id=? AND state='queued'",
          )
          .get(wait.deliveryId, batch.id) !== undefined
      );
    });
  }
  const controlTx = db.transaction(
    (
      recipient: SubscriptionRecipient,
      subscriptionId: string,
      change: SubscriptionControlChange,
      at: string,
      releaseBatchId?: string,
    ) => {
      const wait = readRecipientWait(recipient, subscriptionId);
      const batch = wait?.batchId ? readBatch(wait.batchId) : null;
      if (batch && batch.state !== "accepted" && batch.state !== "cancelled") {
        if (
          batch.id !== releaseBatchId ||
          (batch.state !== "planned" && batch.state !== "queued")
        )
          throw new ActiveWaitConflictError();
        writeBatch({
          ...batch,
          state: "cancelled",
          updatedAt: at,
          finishedAt: at,
          lastError: "Pending wake withdrawn for subscription control",
        });
        for (const id of batch.waitIds) {
          const member = readWait(id);
          if (!member || member.batchId !== batch.id)
            throw new Error("Wake batch lost its wait ownership");
          writeWait({ ...member, batchId: null, updatedAt: at });
        }
        releaseBatchClaims(db, batch.recipient, batch.id);
      }
      const current = readRecipientWait(recipient, subscriptionId);
      if (
        change.cancelWait &&
        current &&
        current.state !== "settled" &&
        current.state !== "cancelled"
      )
        writeWait({
          ...current,
          state: "cancelled",
          updatedAt: at,
          finishedAt: at,
        });
      if (change.cancelWait && current) restorePassive(current, at);
      const entries: object = change;
      const assignments: string[] = ["updated_at=@at"];
      const params: Record<string, string | number | null> = {
        ...scope(recipient),
        id: subscriptionId,
        at,
      };
      for (const [field, value] of Object.entries(entries)) {
        const column = (
          {
            status: "status",
            mode: "mode",
            pausedAt: "paused_at",
            expiresAt: "expires_at",
            reason: "reason",
            eventKinds: "event_kinds_json",
            cursor: "cursor",
            missingAt: "missing_at",
            lastError: "last_error",
          } as Record<string, string>
        )[field];
        if (!column) continue;
        assignments.push(`${column}=@${column}`);
        params[column] =
          field === "eventKinds" && value !== null
            ? JSON.stringify(value)
            : (value as string | null);
      }
      if (change.status !== undefined)
        assignments.push(
          change.status === "following"
            ? "unfollowed_at=NULL"
            : "unfollowed_at=COALESCE(unfollowed_at,@at)",
        );
      db.prepare(
        `UPDATE conversation_subscriptions SET ${assignments.join(",")} WHERE id=@id AND project_path=@project_path AND conversation_id=@conversation_id`,
      ).run(params);
      ensureFiniteWaitSourceCursor(db, recipient);
      retireConsumedFiniteWaitSources(db, recipient);
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
    const size = batch.waitIds.length + batch.followDeliveryIds.length;
    if (size < 1 || size > 6)
      throw new Error("A wake carries one to six facts");
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
    const follow = db.prepare(
      `SELECT 1 FROM conversation_subscription_deliveries d JOIN conversation_subscriptions s ON s.id=d.subscription_id
      WHERE d.id=@id AND d.project_path=@project_path AND d.conversation_id=@conversation_id AND d.state IN ('pending','failed') AND ${WAKING_FOLLOW}`,
    );
    if (
      batch.followDeliveryIds.some(
        (id) =>
          follow.get({ id, ...scope(batch.recipient), at: batch.createdAt }) ===
          undefined,
      )
    )
      return null;
    writeBatch(batch);
    for (const id of batch.followDeliveryIds)
      db.prepare(
        "UPDATE conversation_subscription_deliveries SET state='queued',attempt_id=@batch_id,attempt_count=attempt_count+1,queued_at=@at,finished_at=NULL,last_error=NULL WHERE id=@id",
      ).run({ batch_id: batch.id, at: batch.createdAt, id });
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
            state: state === "cancelled" ? "cancelled" : "settled",
            updatedAt: at,
            finishedAt: at,
            lastError: error,
          });
        if (state === "accepted" || state === "cancelled")
          restorePassive(wait, at);
      }
      db.prepare(
        `UPDATE conversation_subscription_deliveries SET state=@state,accepted_at=CASE WHEN @state='accepted' THEN @at ELSE NULL END,finished_at=@at,last_error=@error
      WHERE project_path=@project_path AND conversation_id=@conversation_id AND attempt_id=@batch_id AND state IN ('queued','failed','uncertain')`,
      ).run({
        ...scope(batch.recipient),
        batch_id: batch.id,
        state: state === "cancelled" ? "superseded" : state,
        at,
        error:
          state === "cancelled"
            ? (error ?? "Wake message cancelled before input acceptance")
            : error,
      });
      if (state === "accepted" || state === "cancelled") {
        retireConsumedFiniteWaitSources(db, batch.recipient);
        retireFinishedRunFollows(db, batch.recipient);
      }
    },
  );
  const releaseUnsentTx = db.transaction((batchId: string, at: string) => {
    const batch = readBatch(batchId);
    if (!batch || batch.state !== "uncertain" || batch.waitIds.length > 0)
      return false;
    writeBatch({
      ...batch,
      state: "cancelled",
      updatedAt: at,
      finishedAt: at,
      lastError:
        "Released for another wake: no queue row and no acceptance receipt",
    });
    releaseBatchClaims(db, batch.recipient, batch.id);
    return true;
  });
  return {
    async applyControl(recipient, subscriptionId, change, at, releaseBatchId) {
      await writeQueue.withWriteQueueSync("subscriptions.wait.control", () =>
        controlTx.immediate(
          recipient,
          subscriptionId,
          change,
          at,
          releaseBatchId,
        ),
      );
    },
    applyControlWithinWrite(
      recipient,
      subscriptionId,
      change,
      at,
      releaseBatchId,
    ) {
      controlTx.immediate(
        recipient,
        subscriptionId,
        change,
        at,
        releaseBatchId,
      );
    },
    async isBatchDispatchable(batchId) {
      return isBatchDispatchable(batchId);
    },
    async rateLimitUntil(recipient, at) {
      const cutoff = new Date(Date.parse(at) - 60_000).toISOString();
      const rows: unknown[] = db
        .prepare(
          "SELECT created_at FROM conversation_subscription_wake_batches WHERE project_path=@project_path AND conversation_id=@conversation_id AND created_at>@cutoff ORDER BY created_at DESC LIMIT 3",
        )
        .all({ ...scope(recipient), cutoff });
      const oldest = rows.at(-1);
      return rows.length < 3 || oldest === undefined
        ? null
        : new Date(
            Date.parse(
              z.object({ created_at: z.string() }).parse(oldest).created_at,
            ) + 60_000,
          ).toISOString();
    },
    async register(wait, subscription) {
      const parsed = activeSubscriptionWaitSchema.parse(wait);
      const parent = conversationSubscriptionSchema.parse(subscription);
      return writeQueue.withWriteQueueSync("subscriptions.wait.register", () =>
        registerTx.immediate(parsed, parent),
      );
    },
    async get(recipient, subscriptionId, waitId) {
      return readRecipientWait(recipient, subscriptionId, waitId);
    },
    async list(recipient) {
      const raw: unknown[] = recipient
        ? db
            .prepare(
              "SELECT * FROM conversation_subscription_waits WHERE project_path=@project_path AND conversation_id=@conversation_id ORDER BY rowid DESC",
            )
            .all(scope(recipient))
        : db
            .prepare(
              "SELECT * FROM conversation_subscription_waits ORDER BY rowid DESC",
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
        if (wait?.state === "waiting" || wait?.state === "ready")
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
    async listRecipients(at) {
      const rows: unknown[] = db
        .prepare(
          `SELECT project_path AS projectPath,conversation_id AS conversationId FROM conversation_subscription_waits WHERE state IN ('waiting','ready')
          UNION SELECT d.project_path,d.conversation_id FROM conversation_subscription_deliveries d JOIN conversation_subscriptions s ON s.id=d.subscription_id
          WHERE d.state IN ('pending','failed') AND ${WAKING_FOLLOW}`,
        )
        .all({ at });
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
    async releaseUnsent(batchId, at) {
      return writeQueue.withWriteQueueSync("subscriptions.wake.release", () =>
        releaseUnsentTx.immediate(batchId, at),
      );
    },
    async settleBatch(batchId, state, at, error) {
      await writeQueue.withWriteQueueSync("subscriptions.wake.settle", () =>
        settleBatchTx.immediate(batchId, state, at, error),
      );
    },
  };
}
