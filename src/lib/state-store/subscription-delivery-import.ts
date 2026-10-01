import { z } from "zod";
import type { Db } from "./schemas";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
  type ConversationSubscription,
  type SubscriptionDelivery,
} from "@/lib/subscriptions/schemas";

export interface SubscriptionDeliveryImportInput {
  subscription: ConversationSubscription;
  delivery: SubscriptionDelivery;
}

const storedReceiptSchema = subscriptionDeliverySchema
  .omit({ recipient: true, source: true, fact: true })
  .extend({ factJson: z.string() });
const receiptPriority = {
  pending: 0,
  failed: 1,
  queued: 2,
  uncertain: 3,
  superseded: 4,
  accepted: 5,
};

/** The caller owns the transaction containing subscription and evidence writes. */
export function importSubscriptionDelivery(
  db: Db,
  input: SubscriptionDeliveryImportInput,
): SubscriptionDelivery {
  const subscription = conversationSubscriptionSchema.parse(input.subscription);
  const incoming = subscriptionDeliverySchema.parse(input.delivery);
  if (
    incoming.recipient.projectPath !== subscription.recipient.projectPath ||
    incoming.recipient.conversationId !==
      subscription.recipient.conversationId ||
    incoming.source.kind !== subscription.source.kind ||
    incoming.source.id !== subscription.source.id
  )
    throw new Error("Imported delivery does not belong to this subscription");
  const identity = {
    project_path: incoming.recipient.projectPath,
    conversation_id: incoming.recipient.conversationId,
    source_kind: incoming.source.kind,
    source_id: incoming.source.id,
    occurrence_id: incoming.fact.occurrenceId,
  };
  const raw = db
    .prepare(
      `SELECT id,subscription_id AS subscriptionId,
    fact_json AS factJson,recorded_at AS recordedAt,state,attempt_id AS attemptId,
    attempt_count AS attemptCount,queued_at AS queuedAt,accepted_at AS acceptedAt,
    finished_at AS finishedAt,last_error AS lastError
    FROM conversation_subscription_deliveries
    WHERE project_path=@project_path AND conversation_id=@conversation_id
      AND source_kind=@source_kind AND source_id=@source_id AND occurrence_id=@occurrence_id`,
    )
    .get(identity);
  let existing: SubscriptionDelivery | undefined;
  if (raw !== undefined) {
    const { factJson, ...receipt } = storedReceiptSchema.parse(raw);
    existing = subscriptionDeliverySchema.parse({
      ...receipt,
      recipient: incoming.recipient,
      source: incoming.source,
      fact: JSON.parse(factJson) as unknown,
    });
    if (existing.fact.occurrenceId !== incoming.fact.occurrenceId)
      throw new Error("Imported subscription occurrence identity is corrupt");
  }
  db.prepare(
    `INSERT INTO conversation_subscriptions
    (id,project_path,conversation_id,source_kind,source_id,reason,mode,event_kinds_json,
     expires_at,status,cursor,created_at,updated_at,unfollowed_at,paused_at,missing_at,last_error)
    VALUES (@id,@project_path,@conversation_id,@source_kind,@source_id,@reason,@mode,@event_kinds_json,
     @expires_at,@status,@cursor,@created_at,@updated_at,@unfollowed_at,@paused_at,@missing_at,@last_error)
    ON CONFLICT(project_path,conversation_id,source_kind,source_id) DO NOTHING`,
  ).run({
    ...identity,
    id: existing?.subscriptionId ?? subscription.id,
    reason: subscription.reason,
    mode: subscription.mode,
    event_kinds_json:
      subscription.eventKinds === null
        ? null
        : JSON.stringify(subscription.eventKinds),
    expires_at: subscription.expiresAt,
    status: subscription.status,
    cursor: subscription.cursor,
    created_at: subscription.createdAt,
    updated_at: subscription.updatedAt,
    unfollowed_at: subscription.unfollowedAt,
    paused_at: subscription.pausedAt,
    missing_at: subscription.missingAt,
    last_error: subscription.lastError,
  });
  const persistedSubscription = z.object({ id: z.string() }).parse(
    db
      .prepare(
        `SELECT id FROM conversation_subscriptions
      WHERE project_path=@project_path AND conversation_id=@conversation_id
        AND source_kind=@source_kind AND source_id=@source_id`,
      )
      .get(identity),
  );
  const strongest =
    existing &&
    receiptPriority[existing.state] >= receiptPriority[incoming.state]
      ? existing
      : incoming;
  const delivery = subscriptionDeliverySchema.parse({
    ...strongest,
    id: existing?.id ?? incoming.id,
    subscriptionId: existing?.subscriptionId ?? persistedSubscription.id,
    recordedAt: existing?.recordedAt ?? incoming.recordedAt,
    // Full source evidence is a frozen snapshot. Summary-only rows are upgraded
    // as one fact so their event metadata describes the incoming evidence too.
    fact:
      existing?.fact.sourceText !== undefined ? existing.fact : incoming.fact,
    attemptCount: Math.max(existing?.attemptCount ?? 0, incoming.attemptCount),
  });
  const parameters = {
    ...identity,
    id: delivery.id,
    subscription_id: delivery.subscriptionId,
    fact_json: JSON.stringify(delivery.fact),
    recorded_at: delivery.recordedAt,
    state: delivery.state,
    attempt_id: delivery.attemptId,
    attempt_count: delivery.attemptCount,
    queued_at: delivery.queuedAt,
    accepted_at: delivery.acceptedAt,
    finished_at: delivery.finishedAt,
    last_error: delivery.lastError,
  };
  if (existing) {
    db.prepare(
      `UPDATE conversation_subscription_deliveries SET
      fact_json=@fact_json,state=@state,attempt_id=@attempt_id,attempt_count=@attempt_count,
      queued_at=@queued_at,accepted_at=@accepted_at,finished_at=@finished_at,last_error=@last_error
      WHERE id=@id AND project_path=@project_path AND conversation_id=@conversation_id`,
    ).run(parameters);
  } else {
    db.prepare(
      `INSERT INTO conversation_subscription_deliveries
      (id,subscription_id,project_path,conversation_id,source_kind,source_id,occurrence_id,
       fact_json,recorded_at,state,attempt_id,attempt_count,queued_at,accepted_at,finished_at,last_error)
      VALUES (@id,@subscription_id,@project_path,@conversation_id,@source_kind,@source_id,@occurrence_id,
       @fact_json,@recorded_at,@state,@attempt_id,@attempt_count,@queued_at,@accepted_at,@finished_at,@last_error)`,
    ).run(parameters);
  }
  return delivery;
}
