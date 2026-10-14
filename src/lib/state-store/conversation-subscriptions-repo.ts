import { z } from "zod";
import type { Db } from "./schemas";
import type { WriteQueue } from "./write-queue";
import { importSubscriptionDelivery } from "./subscription-delivery-import";
import {
  ensureFiniteWaitSourceCursor,
  retireConsumedFiniteWaitSources,
  retireFinishedRunFollows,
} from "./subscription-wait-lifecycle";
import {
  conversationSubscriptionSchema,
  inboxQuerySchema,
  sourceFactSchema,
  subscriptionDeliverySchema,
  subscriptionRecipientSchema,
  type ConversationSubscription,
  type InboxQuery,
  type SourceCursor,
  type SubscriptionDelivery,
  type SubscriptionInboxPage,
  type SubscriptionRecipient,
  type SubscriptionSourceRef,
} from "@/lib/subscriptions/schemas";

export interface ReconcileSubscriptionInput {
  recipient: SubscriptionRecipient;
  subscriptionId: string;
  expectedCursor: SourceCursor;
  nextCursor: SourceCursor;
  deliveries: SubscriptionDelivery[];
  missingAt: string | null;
  updatedAt: string;
}

export interface ConversationSubscriptionsRepo {
  createIfAbsent(
    subscription: ConversationSubscription,
  ): Promise<ConversationSubscription>;
  get(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<ConversationSubscription | null>;
  findBySource(
    recipient: SubscriptionRecipient,
    source: SubscriptionSourceRef,
  ): Promise<ConversationSubscription | null>;
  list(recipient: SubscriptionRecipient): Promise<ConversationSubscription[]>;
  listAll(): Promise<ConversationSubscription[]>;
  listFiniteWaitSubscriptionIds(
    recipient: SubscriptionRecipient,
  ): Promise<string[]>;
  listDeliveriesReservedForActiveWait(
    recipient: SubscriptionRecipient,
  ): Promise<string[]>;
  /** Unsent facts of the recipient's waking follows, oldest first, with their follow. */
  listWakeDeliveries(
    recipient: SubscriptionRecipient,
    at: string,
  ): Promise<
    Array<{
      delivery: SubscriptionDelivery;
      subscription: ConversationSubscription;
    }>
  >;
  findDeliveryByOccurrence(
    recipient: SubscriptionRecipient,
    source: SubscriptionSourceRef,
    occurrenceId: string,
  ): Promise<SubscriptionDelivery | null>;
  listDeliveriesForOverview(
    recipient?: SubscriptionRecipient,
  ): Promise<SubscriptionDelivery[]>;
  pendingCount(recipient?: SubscriptionRecipient): Promise<number>;
  updateControls(
    recipient: SubscriptionRecipient,
    id: string,
    input: Pick<
      ConversationSubscription,
      "status" | "mode" | "pausedAt" | "eventKinds" | "expiresAt" | "reason"
    > &
      Partial<
        Pick<ConversationSubscription, "cursor" | "missingAt" | "lastError">
      >,
    at: string,
  ): Promise<ConversationSubscription | null>;
  unfollow(
    recipient: SubscriptionRecipient,
    id: string,
    at: string,
  ): Promise<boolean>;
  reconcile(
    input: ReconcileSubscriptionInput,
  ): Promise<{ applied: boolean; inserted: number }>;
  recordFailure(
    recipient: SubscriptionRecipient,
    id: string,
    expectedCursor: SourceCursor,
    error: string,
    at: string,
  ): Promise<void>;
  recordDelivery(delivery: SubscriptionDelivery): Promise<boolean>;
  recordNotice(
    subscription: ConversationSubscription,
    delivery: SubscriptionDelivery,
  ): Promise<boolean>;
  importDelivery(
    subscription: ConversationSubscription,
    delivery: SubscriptionDelivery,
  ): Promise<SubscriptionDelivery>;
  supersedePending(
    recipient: SubscriptionRecipient,
    source: SubscriptionSourceRef,
    occurrenceIds: readonly string[],
    at: string,
  ): Promise<number>;
  supersedeNotepadRevisions(
    recipient: SubscriptionRecipient,
    subscriptionId: string,
    revision: number,
    at: string,
  ): Promise<number>;
  reviewDelivery(
    recipient: SubscriptionRecipient,
    id: string,
    action: "retry" | "dismiss",
    at: string,
  ): Promise<boolean>;
  readInbox(
    recipient: SubscriptionRecipient,
    query: InboxQuery,
  ): Promise<SubscriptionInboxPage>;
  getDelivery(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<SubscriptionDelivery | null>;
  claim(
    recipient: SubscriptionRecipient,
    ids: string[],
    attemptId: string,
    at: string,
  ): Promise<SubscriptionDelivery[]>;
  listRuntimeLossNotices(
    recipient: SubscriptionRecipient,
  ): Promise<SubscriptionDelivery[]>;
  claimRuntimeLossNotices(
    recipient: SubscriptionRecipient,
    ids: string[],
    attemptId: string,
    at: string,
  ): Promise<SubscriptionDelivery[]>;
  settle(
    recipient: SubscriptionRecipient,
    attemptId: string,
    state: "accepted" | "failed" | "uncertain",
    at: string,
    error: string | null,
  ): Promise<number>;
  recoverOrphanedClaims(at: string): Promise<number>;
}

const subscriptionRowSchema = z
  .object({
    id: z.string(),
    project_path: z.string(),
    conversation_id: z.string(),
    source_kind: z.string(),
    source_id: z.string(),
    reason: z.string(),
    mode: z.string(),
    wakes: z.number().int(),
    event_kinds_json: z.string().nullable(),
    expires_at: z.string().nullable(),
    status: z.string(),
    cursor: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    unfollowed_at: z.string().nullable(),
    paused_at: z.string().nullable(),
    missing_at: z.string().nullable(),
    last_error: z.string().nullable(),
  })
  .strict();
const deliveryRowSchema = z
  .object({
    id: z.string(),
    subscription_id: z.string(),
    project_path: z.string(),
    conversation_id: z.string(),
    source_kind: z.string(),
    source_id: z.string(),
    occurrence_id: z.string(),
    fact_json: z.string(),
    recorded_at: z.string(),
    state: z.string(),
    attempt_id: z.string().nullable(),
    attempt_count: z.number(),
    queued_at: z.string().nullable(),
    accepted_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    last_error: z.string().nullable(),
  })
  .strict();
/** `s` is a follow whose new facts wake its recipient now. */
export const WAKING_FOLLOW = `s.wakes=1 AND s.status='following' AND s.paused_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>@at)`;

function subscriptionFromRow(raw: unknown): ConversationSubscription {
  const row = subscriptionRowSchema.parse(raw);
  return conversationSubscriptionSchema.parse({
    id: row.id,
    recipient: {
      projectPath: row.project_path,
      conversationId: row.conversation_id,
    },
    source: { kind: row.source_kind, id: row.source_id },
    reason: row.reason,
    mode: row.mode,
    wakes: row.wakes === 1,
    eventKinds:
      row.event_kinds_json === null
        ? null
        : (JSON.parse(row.event_kinds_json) as unknown),
    expiresAt: row.expires_at,
    status: row.status,
    cursor: row.cursor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    unfollowedAt: row.unfollowed_at,
    pausedAt: row.paused_at,
    missingAt: row.missing_at,
    lastError: row.last_error,
  });
}
function deliveryFromRow(raw: unknown): SubscriptionDelivery {
  const row = deliveryRowSchema.parse(raw);
  const fact = sourceFactSchema.parse(JSON.parse(row.fact_json) as unknown);
  if (fact.occurrenceId !== row.occurrence_id)
    throw new Error("Subscription occurrence identity is corrupt");
  return subscriptionDeliverySchema.parse({
    id: row.id,
    subscriptionId: row.subscription_id,
    recipient: {
      projectPath: row.project_path,
      conversationId: row.conversation_id,
    },
    source: { kind: row.source_kind, id: row.source_id },
    fact,
    recordedAt: row.recorded_at,
    state: row.state,
    attemptId: row.attempt_id,
    attemptCount: row.attempt_count,
    queuedAt: row.queued_at,
    acceptedAt: row.accepted_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
  });
}
function scope(recipient: SubscriptionRecipient) {
  const value = subscriptionRecipientSchema.parse(recipient);
  return {
    project_path: value.projectPath,
    conversation_id: value.conversationId,
  };
}

export function createConversationSubscriptionsRepo(
  db: Db,
  writeQueue: WriteQueue,
): ConversationSubscriptionsRepo {
  const pendingDeliveryWhere = `state NOT IN ('accepted','superseded') AND EXISTS (
    SELECT 1 FROM conversation_subscriptions s
    WHERE s.id=conversation_subscription_deliveries.subscription_id
      AND s.project_path=conversation_subscription_deliveries.project_path
      AND s.conversation_id=conversation_subscription_deliveries.conversation_id
      AND s.status='following'
  )`;
  const actionableDeliveryWhere = `state IN ('pending','failed','queued') AND EXISTS (
    SELECT 1 FROM conversation_subscriptions s WHERE s.id=conversation_subscription_deliveries.subscription_id
      AND s.project_path=conversation_subscription_deliveries.project_path AND s.conversation_id=conversation_subscription_deliveries.conversation_id
      AND s.status='following' AND s.paused_at IS NULL AND (
        state='queued' OR (
          s.mode='passive'
          AND (s.expires_at IS NULL OR s.expires_at>@at
            OR EXISTS (SELECT 1 FROM conversation_subscription_waits w WHERE w.subscription_id=s.id AND w.delivery_id=conversation_subscription_deliveries.id AND w.state='ready' AND w.batch_id IS NULL))
          AND NOT EXISTS (SELECT 1 FROM conversation_subscription_waits w WHERE w.subscription_id=s.id AND w.delivery_id=conversation_subscription_deliveries.id AND w.state='ready' AND s.mode='active')
        ) OR EXISTS (SELECT 1 FROM conversation_subscription_waits w WHERE w.subscription_id=s.id AND w.delivery_id=conversation_subscription_deliveries.id AND w.state='ready' AND w.batch_id IS NULL AND s.mode='active' AND conversation_subscription_deliveries.state='pending')
      )
  )`;
  const find = db.prepare(
    `SELECT * FROM conversation_subscriptions WHERE project_path=@project_path AND conversation_id=@conversation_id AND id=@id`,
  );
  const findSource = db.prepare(
    `SELECT * FROM conversation_subscriptions WHERE project_path=@project_path AND conversation_id=@conversation_id AND source_kind=@source_kind AND source_id=@source_id`,
  );
  const list = db.prepare(
    `SELECT * FROM conversation_subscriptions WHERE project_path=@project_path AND conversation_id=@conversation_id ORDER BY created_at,id`,
  );
  const create =
    db.prepare(`INSERT INTO conversation_subscriptions (id,project_path,conversation_id,source_kind,source_id,reason,mode,wakes,event_kinds_json,expires_at,status,cursor,created_at,updated_at,unfollowed_at,paused_at,missing_at,last_error)
    VALUES (@id,@project_path,@conversation_id,@source_kind,@source_id,@reason,@mode,@wakes,@event_kinds_json,@expires_at,@status,@cursor,@created_at,@updated_at,@unfollowed_at,@paused_at,@missing_at,@last_error)
    ON CONFLICT(project_path,conversation_id,source_kind,source_id) DO NOTHING`);
  const insertDelivery =
    db.prepare(`INSERT INTO conversation_subscription_deliveries (id,subscription_id,project_path,conversation_id,source_kind,source_id,occurrence_id,fact_json,recorded_at,state,attempt_id,attempt_count,queued_at,accepted_at,finished_at,last_error)
    VALUES (@id,@subscription_id,@project_path,@conversation_id,@source_kind,@source_id,@occurrence_id,@fact_json,@recorded_at,@state,@attempt_id,@attempt_count,@queued_at,@accepted_at,@finished_at,@last_error)
    ON CONFLICT(project_path,conversation_id,source_kind,source_id,occurrence_id) DO NOTHING`);
  const findDelivery = db.prepare(
    `SELECT * FROM conversation_subscription_deliveries WHERE project_path=@project_path AND conversation_id=@conversation_id AND id=@id`,
  );
  const advance =
    db.prepare(`UPDATE conversation_subscriptions SET cursor=@next_cursor,missing_at=@missing_at,updated_at=@at,last_error=NULL
    WHERE project_path=@project_path AND conversation_id=@conversation_id AND id=@id AND cursor IS @expected_cursor AND status='following' AND mode='passive' AND missing_at IS NULL AND (NOT EXISTS (SELECT 1 FROM conversation_subscription_waits w WHERE w.subscription_id=conversation_subscriptions.id AND (w.state='waiting' OR (w.state='ready' AND json_extract(w.payload_json,'$.outcome')='source_terminal'))))`);
  const claim =
    db.prepare(`UPDATE conversation_subscription_deliveries SET state='queued',attempt_id=@attempt_id,attempt_count=attempt_count+1,queued_at=@at,accepted_at=NULL,finished_at=NULL,last_error=NULL
    WHERE project_path=@project_path AND conversation_id=@conversation_id AND id=@id AND state IN ('pending','failed')
    AND EXISTS (SELECT 1 FROM conversation_subscriptions s WHERE s.id=subscription_id AND s.project_path=@project_path AND s.conversation_id=@conversation_id AND s.status='following' AND s.mode='passive' AND s.paused_at IS NULL AND ((s.expires_at IS NULL OR s.expires_at>@at) OR EXISTS (SELECT 1 FROM conversation_subscription_waits w WHERE w.subscription_id=s.id AND w.delivery_id=conversation_subscription_deliveries.id AND w.state='ready' AND w.batch_id IS NULL))
      AND NOT EXISTS (SELECT 1 FROM conversation_subscription_waits w WHERE w.subscription_id=s.id AND w.delivery_id=conversation_subscription_deliveries.id AND w.state='ready' AND s.mode='active'))`);
  const settle =
    db.prepare(`UPDATE conversation_subscription_deliveries SET state=@state,accepted_at=CASE WHEN @state='accepted' THEN @at ELSE NULL END,finished_at=@at,last_error=@error
    WHERE project_path=@project_path AND conversation_id=@conversation_id AND attempt_id=@attempt_id
      AND (state IN ('queued','uncertain') OR (@state='accepted' AND state='failed'))`);
  // Task loss is internal recovery context, independent of feedback follow controls.
  // Restrict this path to the owning conversation and the one operational event.
  const runtimeLossWhere = `project_path=@project_path AND conversation_id=@conversation_id
    AND source_kind='conversation' AND source_id=@conversation_id
    AND json_extract(fact_json,'$.eventKind')='background-tasks-lost'
    AND json_extract(fact_json,'$.category')='outcome'
    AND json_extract(fact_json,'$.outcome')='terminated' AND state IN ('pending','failed')`;
  const listRuntimeLoss = db.prepare(
    `SELECT * FROM conversation_subscription_deliveries WHERE ${runtimeLossWhere} ORDER BY recorded_at,id`,
  );
  const claimRuntimeLoss =
    db.prepare(`UPDATE conversation_subscription_deliveries
    SET state='queued',attempt_id=@attempt_id,attempt_count=attempt_count+1,queued_at=@at,accepted_at=NULL,finished_at=NULL,last_error=NULL
    WHERE ${runtimeLossWhere} AND id=@id`);
  const claimRuntimeLossTx = db.transaction(
    (
      recipient: SubscriptionRecipient,
      ids: string[],
      attemptId: string,
      at: string,
    ) => {
      const result: SubscriptionDelivery[] = [];
      for (const id of ids) {
        if (
          claimRuntimeLoss.run({
            ...scope(recipient),
            id,
            attempt_id: attemptId,
            at,
          }).changes === 0
        )
          continue;
        const delivery = readDelivery(recipient, id);
        if (delivery) result.push(delivery);
      }
      return result;
    },
  );
  function insert(value: SubscriptionDelivery): boolean {
    return (
      insertDelivery.run({
        id: value.id,
        subscription_id: value.subscriptionId,
        ...scope(value.recipient),
        source_kind: value.source.kind,
        source_id: value.source.id,
        occurrence_id: value.fact.occurrenceId,
        fact_json: JSON.stringify(value.fact),
        recorded_at: value.recordedAt,
        state: value.state,
        attempt_id: value.attemptId,
        attempt_count: value.attemptCount,
        queued_at: value.queuedAt,
        accepted_at: value.acceptedAt,
        finished_at: value.finishedAt,
        last_error: value.lastError,
      }).changes > 0
    );
  }
  function readDelivery(recipient: SubscriptionRecipient, id: string) {
    const row: unknown = findDelivery.get({ ...scope(recipient), id });
    return row === undefined ? null : deliveryFromRow(row);
  }
  const reconcileTx = db.transaction((input: ReconcileSubscriptionInput) => {
    if (
      advance.run({
        ...scope(input.recipient),
        id: input.subscriptionId,
        expected_cursor: input.expectedCursor,
        next_cursor: input.nextCursor,
        missing_at: input.missingAt,
        at: input.updatedAt,
      }).changes === 0
    )
      return { applied: false, inserted: 0 };
    const raw: unknown = find.get({
      ...scope(input.recipient),
      id: input.subscriptionId,
    });
    const subscription = subscriptionFromRow(raw);
    let inserted = 0;
    for (const delivery of input.deliveries) {
      if (
        delivery.subscriptionId !== subscription.id ||
        delivery.recipient.projectPath !== subscription.recipient.projectPath ||
        delivery.recipient.conversationId !==
          subscription.recipient.conversationId ||
        delivery.source.kind !== subscription.source.kind ||
        delivery.source.id !== subscription.source.id
      )
        throw new Error(
          "Reconciliation delivery does not belong to this subscription",
        );
      if (insert(delivery)) inserted++;
    }
    return { applied: true, inserted };
  });
  const claimTx = db.transaction(
    (
      recipient: SubscriptionRecipient,
      ids: string[],
      attemptId: string,
      at: string,
    ) => {
      const result: SubscriptionDelivery[] = [];
      for (const id of ids) {
        if (
          claim.run({ ...scope(recipient), id, attempt_id: attemptId, at })
            .changes === 0
        )
          continue;
        const delivery = readDelivery(recipient, id);
        if (delivery) result.push(delivery);
      }
      return result;
    },
  );
  function createSubscription(
    value: ConversationSubscription,
  ): ConversationSubscription {
    create.run({
      id: value.id,
      ...scope(value.recipient),
      source_kind: value.source.kind,
      source_id: value.source.id,
      reason: value.reason,
      mode: value.mode,
      wakes: Number(value.wakes),
      event_kinds_json:
        value.eventKinds === null ? null : JSON.stringify(value.eventKinds),
      expires_at: value.expiresAt,
      status: value.status,
      cursor: value.cursor,
      created_at: value.createdAt,
      updated_at: value.updatedAt,
      unfollowed_at: value.unfollowedAt,
      paused_at: value.pausedAt,
      missing_at: value.missingAt,
      last_error: value.lastError,
    });
    return subscriptionFromRow(
      findSource.get({
        ...scope(value.recipient),
        source_kind: value.source.kind,
        source_id: value.source.id,
      }),
    );
  }
  const recordNoticeTx = db.transaction(
    (candidate: ConversationSubscription, delivery: SubscriptionDelivery) => {
      if (
        delivery.recipient.projectPath !== candidate.recipient.projectPath ||
        delivery.recipient.conversationId !==
          candidate.recipient.conversationId ||
        delivery.source.kind !== candidate.source.kind ||
        delivery.source.id !== candidate.source.id
      )
        throw new Error("Notice delivery does not belong to this subscription");
      const subscription = createSubscription(candidate);
      if (
        subscription.status !== "following" ||
        subscription.mode !== "passive" ||
        (subscription.expiresAt !== null &&
          subscription.expiresAt <= delivery.recordedAt) ||
        (subscription.eventKinds !== null &&
          !subscription.eventKinds.includes(delivery.fact.eventKind))
      )
        return false;
      return insert({ ...delivery, subscriptionId: subscription.id });
    },
  );
  return {
    async createIfAbsent(input) {
      const value = conversationSubscriptionSchema.parse(input);
      return writeQueue.withWriteQueueSync("subscriptions.create", () => {
        return createSubscription(value);
      });
    },
    async get(recipient, id) {
      const row: unknown = find.get({ ...scope(recipient), id });
      return row === undefined ? null : subscriptionFromRow(row);
    },
    async findBySource(recipient, source) {
      const row: unknown = findSource.get({
        ...scope(recipient),
        source_kind: source.kind,
        source_id: source.id,
      });
      return row === undefined ? null : subscriptionFromRow(row);
    },
    async list(recipient) {
      return (list.all(scope(recipient)) as unknown[]).map(subscriptionFromRow);
    },
    async listFiniteWaitSubscriptionIds(recipient) {
      return (
        db
          .prepare(
            "SELECT DISTINCT w.subscription_id FROM conversation_subscription_waits w JOIN conversation_subscriptions s ON s.id=w.subscription_id WHERE w.project_path=@project_path AND w.conversation_id=@conversation_id AND (w.state='waiting' OR (w.state='ready' AND json_extract(w.payload_json,'$.outcome')='source_terminal'))",
          )
          .all(scope(recipient)) as unknown[]
      ).map(
        (raw) =>
          z.object({ subscription_id: z.string() }).parse(raw).subscription_id,
      );
    },
    async listDeliveriesReservedForActiveWait(recipient) {
      return z
        .array(z.object({ id: z.string() }))
        .parse(
          db
            .prepare(
              `SELECT DISTINCT w.delivery_id AS id FROM conversation_subscription_waits w JOIN conversation_subscriptions s ON s.id=w.subscription_id
        WHERE w.project_path=@project_path AND w.conversation_id=@conversation_id AND w.state='ready' AND w.delivery_id IS NOT NULL AND s.mode='active' AND s.status='following'`,
            )
            .all(scope(recipient)),
        )
        .map((row) => row.id);
    },
    async listWakeDeliveries(recipient, at) {
      const rows = db
        .prepare(
          `SELECT d.* FROM conversation_subscription_deliveries d JOIN conversation_subscriptions s ON s.id=d.subscription_id
        WHERE d.project_path=@project_path AND d.conversation_id=@conversation_id AND d.state IN ('pending','failed')
          AND ${WAKING_FOLLOW} ORDER BY d.recorded_at,d.rowid`,
        )
        .all({ ...scope(recipient), at }) as unknown[];
      return rows.map((raw) => {
        const delivery = deliveryFromRow(raw);
        const subscription = find.get({
          ...scope(recipient),
          id: delivery.subscriptionId,
        });
        return { delivery, subscription: subscriptionFromRow(subscription) };
      });
    },
    async findDeliveryByOccurrence(recipient, source, occurrenceId) {
      const row: unknown = db
        .prepare(
          `SELECT * FROM conversation_subscription_deliveries WHERE project_path=@project_path AND conversation_id=@conversation_id AND source_kind=@source_kind AND source_id=@source_id AND occurrence_id=@occurrence_id`,
        )
        .get({
          ...scope(recipient),
          source_kind: source.kind,
          source_id: source.id,
          occurrence_id: occurrenceId,
        });
      return row === undefined ? null : deliveryFromRow(row);
    },
    async listAll() {
      return (
        db
          .prepare(
            "SELECT * FROM conversation_subscriptions ORDER BY created_at,id",
          )
          .all() as unknown[]
      ).map(subscriptionFromRow);
    },
    async listDeliveriesForOverview(recipient) {
      const rows: unknown[] = recipient
        ? db
            .prepare(
              "SELECT * FROM conversation_subscription_deliveries WHERE project_path=@project_path AND conversation_id=@conversation_id ORDER BY recorded_at DESC,rowid DESC",
            )
            .all(scope(recipient))
        : db
            .prepare(
              "SELECT * FROM conversation_subscription_deliveries ORDER BY recorded_at DESC,rowid DESC",
            )
            .all();
      return rows.map(deliveryFromRow);
    },
    async pendingCount(recipient) {
      const params = {
        ...(recipient ? scope(recipient) : {}),
        at: new Date().toISOString(),
      };
      const row: unknown = recipient
        ? db
            .prepare(
              `SELECT COUNT(*) AS total FROM conversation_subscription_deliveries WHERE ${actionableDeliveryWhere} AND project_path=@project_path AND conversation_id=@conversation_id`,
            )
            .get(params)
        : db
            .prepare(
              `SELECT COUNT(*) AS total FROM conversation_subscription_deliveries WHERE ${actionableDeliveryWhere}`,
            )
            .get(params);
      return z.object({ total: z.number() }).parse(row).total;
    },
    async updateControls(recipient, id, input, at) {
      return writeQueue.withWriteQueueSync("subscriptions.controls", () =>
        db
          .transaction(() => {
            db.prepare(
              "UPDATE conversation_subscriptions SET status=@status,mode=@mode,paused_at=@paused_at,event_kinds_json=@event_kinds_json,expires_at=@expires_at,reason=@reason,updated_at=@at,cursor=CASE WHEN @reset_cursor THEN @cursor ELSE cursor END,missing_at=CASE WHEN @reset_missing THEN @missing_at ELSE missing_at END,last_error=CASE WHEN @reset_error THEN @last_error ELSE last_error END,unfollowed_at=CASE WHEN @status='following' THEN NULL ELSE COALESCE(unfollowed_at,@at) END WHERE id=@id AND project_path=@project_path AND conversation_id=@conversation_id",
            ).run({
              ...scope(recipient),
              id,
              status: input.status,
              mode: input.mode,
              paused_at: input.pausedAt,
              event_kinds_json:
                input.eventKinds === null
                  ? null
                  : JSON.stringify(input.eventKinds),
              expires_at: input.expiresAt,
              reason: input.reason,
              reset_cursor: Number(Object.hasOwn(input, "cursor")),
              cursor: input.cursor ?? null,
              reset_missing: Number(Object.hasOwn(input, "missingAt")),
              missing_at: input.missingAt ?? null,
              reset_error: Number(Object.hasOwn(input, "lastError")),
              last_error: input.lastError ?? null,
              at,
            });
            ensureFiniteWaitSourceCursor(db, recipient);
            retireConsumedFiniteWaitSources(db, recipient);
            const raw: unknown = find.get({ ...scope(recipient), id });
            return raw === undefined ? null : subscriptionFromRow(raw);
          })
          .immediate(),
      );
    },
    async unfollow(recipient, id, at) {
      return writeQueue.withWriteQueueSync(
        "subscriptions.unfollow",
        () =>
          db
            .prepare(
              `UPDATE conversation_subscriptions SET status='unfollowed',unfollowed_at=COALESCE(unfollowed_at,@at),updated_at=@at WHERE project_path=@project_path AND conversation_id=@conversation_id AND id=@id`,
            )
            .run({ ...scope(recipient), id, at }).changes > 0,
      );
    },
    async reconcile(input) {
      const parsed = {
        ...input,
        deliveries: input.deliveries.map((value) =>
          subscriptionDeliverySchema.parse(value),
        ),
      };
      return writeQueue.withWriteQueueSync("subscriptions.reconcile", () =>
        reconcileTx.immediate(parsed),
      );
    },
    async recordFailure(recipient, id, expectedCursor, error, at) {
      await writeQueue.withWriteQueueSync("subscriptions.failure", () =>
        db
          .prepare(
            `UPDATE conversation_subscriptions SET last_error=@error,updated_at=@at WHERE project_path=@project_path AND conversation_id=@conversation_id AND id=@id AND cursor IS @cursor AND status='following'`,
          )
          .run({ ...scope(recipient), id, cursor: expectedCursor, error, at }),
      );
    },
    async recordDelivery(delivery) {
      const value = subscriptionDeliverySchema.parse(delivery);
      return writeQueue.withWriteQueueSync("subscriptions.recordDelivery", () =>
        insert(value),
      );
    },
    async recordNotice(subscription, delivery) {
      const candidate = conversationSubscriptionSchema.parse(subscription);
      const value = subscriptionDeliverySchema.parse(delivery);
      return writeQueue.withWriteQueueSync("subscriptions.recordNotice", () =>
        recordNoticeTx.immediate(candidate, value),
      );
    },
    async importDelivery(subscription, delivery) {
      return writeQueue.withWriteQueueSync("subscriptions.importDelivery", () =>
        db
          .transaction(() =>
            importSubscriptionDelivery(db, { subscription, delivery }),
          )
          .immediate(),
      );
    },
    async supersedePending(recipient, source, occurrenceIds, at) {
      if (occurrenceIds.length === 0) return 0;
      const update = db.prepare(`UPDATE conversation_subscription_deliveries
        SET state='superseded',finished_at=@at,accepted_at=NULL,
          last_error='Source fact was superseded by accepted context or feedback withdrawal'
        WHERE project_path=@project_path AND conversation_id=@conversation_id
          AND source_kind=@source_kind AND source_id=@source_id
          AND occurrence_id=@occurrence_id AND state IN ('pending','failed')`);
      return writeQueue.withWriteQueueSync(
        "subscriptions.supersedePending",
        () =>
          db
            .transaction(() =>
              occurrenceIds.reduce(
                (count, occurrenceId) =>
                  count +
                  update.run({
                    ...scope(recipient),
                    source_kind: source.kind,
                    source_id: source.id,
                    occurrence_id: occurrenceId,
                    at,
                  }).changes,
                0,
              ),
            )
            .immediate(),
      );
    },
    async supersedeNotepadRevisions(recipient, subscriptionId, revision, at) {
      return writeQueue.withWriteQueueSync(
        "subscriptions.supersedeNotepadRevisions",
        () =>
          db
            .prepare(
              `UPDATE conversation_subscription_deliveries SET state='superseded',finished_at=@at,accepted_at=NULL,last_error='Source revision was covered by accepted context'
        WHERE project_path=@project_path AND conversation_id=@conversation_id AND subscription_id=@subscription_id AND source_kind='notepad' AND json_extract(fact_json,'$.eventKind')='notepad-content-revised' AND CAST(json_extract(fact_json,'$.revision') AS INTEGER)<=@revision AND state IN ('pending','failed')`,
            )
            .run({
              ...scope(recipient),
              subscription_id: subscriptionId,
              revision,
              at,
            }).changes,
      );
    },
    async reviewDelivery(recipient, id, action, at) {
      return writeQueue.withWriteQueueSync("subscriptions.reviewDelivery", () =>
        db
          .transaction(() => {
            const changed =
              db
                .prepare(
                  `UPDATE conversation_subscription_deliveries
        SET state=@state,attempt_id=NULL,queued_at=NULL,accepted_at=NULL,finished_at=@finished_at,last_error=@error
        WHERE project_path=@project_path AND conversation_id=@conversation_id AND id=@id AND state IN ('pending','failed','uncertain')
          AND NOT EXISTS (SELECT 1 FROM conversation_subscription_waits w JOIN conversation_subscription_wake_batches b ON b.id=w.batch_id WHERE w.delivery_id=conversation_subscription_deliveries.id AND b.state NOT IN ('accepted','cancelled'))
          AND NOT EXISTS (SELECT 1 FROM conversation_subscription_wake_batches b WHERE b.id=conversation_subscription_deliveries.attempt_id AND b.state NOT IN ('accepted','cancelled'))`,
                )
                .run({
                  ...scope(recipient),
                  id,
                  state: action === "retry" ? "pending" : "superseded",
                  finished_at: action === "retry" ? null : at,
                  error:
                    action === "retry"
                      ? null
                      : "Delivery explicitly dismissed after inspection",
                }).changes > 0;
            if (changed && action === "dismiss") {
              retireConsumedFiniteWaitSources(db, recipient);
              retireFinishedRunFollows(db, recipient);
            }
            return changed;
          })
          .immediate(),
      );
    },
    async readInbox(recipient, query) {
      const parsed = inboxQuerySchema.parse(query);
      const params = {
        ...scope(recipient),
        include_settled: parsed.includeSettled ? 1 : 0,
        limit: parsed.limit,
        offset: parsed.offset,
      };
      const where = `project_path=@project_path AND conversation_id=@conversation_id AND (@include_settled=1 OR (${pendingDeliveryWhere}))`;
      const count = z.object({ total: z.number().int().nonnegative() }).parse(
        db
          .prepare(
            `SELECT COUNT(*) AS total FROM conversation_subscription_deliveries WHERE ${where}`,
          )
          .get({
            project_path: params.project_path,
            conversation_id: params.conversation_id,
            include_settled: params.include_settled,
          }),
      );
      return {
        items: (
          db
            .prepare(
              `SELECT * FROM conversation_subscription_deliveries WHERE ${where} ORDER BY recorded_at,rowid LIMIT @limit OFFSET @offset`,
            )
            .all(params) as unknown[]
        ).map(deliveryFromRow),
        total: count.total,
        limit: parsed.limit,
        offset: parsed.offset,
      };
    },
    async getDelivery(recipient, id) {
      return readDelivery(recipient, id);
    },
    async listRuntimeLossNotices(recipient) {
      return (listRuntimeLoss.all(scope(recipient)) as unknown[]).map(
        deliveryFromRow,
      );
    },
    async claimRuntimeLossNotices(recipient, ids, attemptId, at) {
      if (!attemptId)
        throw new Error("A runtime recovery claim requires an attempt ID");
      return writeQueue.withWriteQueueSync(
        "subscriptions.claimRuntimeLoss",
        () => claimRuntimeLossTx.immediate(recipient, ids, attemptId, at),
      );
    },
    async claim(recipient, ids, attemptId, at) {
      if (!attemptId)
        throw new Error("A briefing claim requires an attempt ID");
      return writeQueue.withWriteQueueSync("subscriptions.claim", () =>
        claimTx.immediate(recipient, ids, attemptId, at),
      );
    },
    async settle(recipient, attemptId, state, at, error) {
      return writeQueue.withWriteQueueSync("subscriptions.settle", () =>
        db
          .transaction(() => {
            const changed = settle.run({
              ...scope(recipient),
              attempt_id: attemptId,
              state,
              at,
              error,
            }).changes;
            if (state === "accepted")
              retireConsumedFiniteWaitSources(db, recipient);
            return changed;
          })
          .immediate(),
      );
    },
    async recoverOrphanedClaims(at) {
      return writeQueue.withWriteQueueSync(
        "subscriptions.recover",
        () =>
          db
            .prepare(
              `UPDATE conversation_subscription_deliveries SET state='uncertain',finished_at=?,last_error='Process restarted before input acceptance was durably confirmed' WHERE state='queued'`,
            )
            .run(at).changes,
      );
    },
  };
}
