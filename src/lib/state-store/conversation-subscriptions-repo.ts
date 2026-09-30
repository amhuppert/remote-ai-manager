import { z } from "zod";
import type { Db } from "./schemas";
import type { WriteQueue } from "./write-queue";
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
    event_kinds_json: z.string().nullable(),
    expires_at: z.string().nullable(),
    status: z.string(),
    cursor: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    unfollowed_at: z.string().nullable(),
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
    db.prepare(`INSERT INTO conversation_subscriptions (id,project_path,conversation_id,source_kind,source_id,reason,mode,event_kinds_json,expires_at,status,cursor,created_at,updated_at,unfollowed_at,missing_at,last_error)
    VALUES (@id,@project_path,@conversation_id,@source_kind,@source_id,@reason,@mode,@event_kinds_json,@expires_at,@status,@cursor,@created_at,@updated_at,@unfollowed_at,@missing_at,@last_error)
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
    WHERE project_path=@project_path AND conversation_id=@conversation_id AND id=@id AND cursor IS @expected_cursor AND status='following' AND missing_at IS NULL`);
  const claim =
    db.prepare(`UPDATE conversation_subscription_deliveries SET state='queued',attempt_id=@attempt_id,attempt_count=attempt_count+1,queued_at=@at,accepted_at=NULL,finished_at=NULL,last_error=NULL
    WHERE project_path=@project_path AND conversation_id=@conversation_id AND id=@id AND state IN ('pending','failed')
    AND EXISTS (SELECT 1 FROM conversation_subscriptions s WHERE s.id=subscription_id AND s.project_path=@project_path AND s.conversation_id=@conversation_id AND s.status='following' AND s.mode='passive' AND (s.expires_at IS NULL OR s.expires_at>@at))`);
  const settle =
    db.prepare(`UPDATE conversation_subscription_deliveries SET state=@state,accepted_at=CASE WHEN @state='accepted' THEN @at ELSE NULL END,finished_at=@at,last_error=@error
    WHERE project_path=@project_path AND conversation_id=@conversation_id AND attempt_id=@attempt_id
      AND (state IN ('queued','uncertain') OR (@state='accepted' AND state='failed'))`);
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
  return {
    async createIfAbsent(input) {
      const value = conversationSubscriptionSchema.parse(input);
      return writeQueue.withWriteQueueSync("subscriptions.create", () => {
        create.run({
          id: value.id,
          ...scope(value.recipient),
          source_kind: value.source.kind,
          source_id: value.source.id,
          reason: value.reason,
          mode: value.mode,
          event_kinds_json:
            value.eventKinds === null ? null : JSON.stringify(value.eventKinds),
          expires_at: value.expiresAt,
          status: value.status,
          cursor: value.cursor,
          created_at: value.createdAt,
          updated_at: value.updatedAt,
          unfollowed_at: value.unfollowedAt,
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
    async readInbox(recipient, query) {
      const parsed = inboxQuerySchema.parse(query);
      const params = {
        ...scope(recipient),
        include_settled: parsed.includeSettled ? 1 : 0,
        limit: parsed.limit,
        offset: parsed.offset,
      };
      const where = `project_path=@project_path AND conversation_id=@conversation_id AND (@include_settled=1 OR state<>'accepted')`;
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
    async claim(recipient, ids, attemptId, at) {
      if (!attemptId)
        throw new Error("A briefing claim requires an attempt ID");
      return writeQueue.withWriteQueueSync("subscriptions.claim", () =>
        claimTx.immediate(recipient, ids, attemptId, at),
      );
    },
    async settle(recipient, attemptId, state, at, error) {
      return writeQueue.withWriteQueueSync(
        "subscriptions.settle",
        () =>
          settle.run({
            ...scope(recipient),
            attempt_id: attemptId,
            state,
            at,
            error,
          }).changes,
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
