import type { Db } from "./schemas";
import type { SubscriptionRecipient } from "@/lib/subscriptions/schemas";

/** Old waits did not save a source cursor. Running is the known pre-terminal baseline. */
export function ensureFiniteWaitSourceCursor(
  db: Db,
  recipient?: SubscriptionRecipient,
): number {
  return db
    .prepare(
      `UPDATE conversation_subscriptions SET cursor='running' WHERE cursor IS NULL AND source_kind IN ('validation','git_job') AND status='following'
    AND (@project_path IS NULL OR (project_path=@project_path AND conversation_id=@conversation_id))
    AND EXISTS (SELECT 1 FROM conversation_subscription_waits w WHERE w.subscription_id=conversation_subscriptions.id)`,
    )
    .run({
      project_path: recipient?.projectPath ?? null,
      conversation_id: recipient?.conversationId ?? null,
    }).changes;
}

/** A consumed one-shot source has no further result to follow; keep controls and evidence. Caller owns serialization. */
export function retireConsumedFiniteWaitSources(
  db: Db,
  recipient?: SubscriptionRecipient,
): number {
  return db
    .prepare(
      `UPDATE conversation_subscriptions SET mode='passive',
    expires_at=(SELECT MAX(COALESCE(d.accepted_at,d.finished_at,d.recorded_at)) FROM conversation_subscription_deliveries d
      WHERE d.subscription_id=conversation_subscriptions.id AND d.state IN ('accepted','superseded')
        AND json_extract(d.fact_json,'$.eventKind') IN ('validation-completed','git-job-outcome','git-job-completed'))
    WHERE source_kind IN ('validation','git_job')
      AND (@project_path IS NULL OR (project_path=@project_path AND conversation_id=@conversation_id))
      AND EXISTS (SELECT 1 FROM conversation_subscription_waits w WHERE w.subscription_id=conversation_subscriptions.id)
      AND EXISTS (SELECT 1 FROM conversation_subscription_deliveries d WHERE d.subscription_id=conversation_subscriptions.id AND d.state IN ('accepted','superseded')
        AND json_extract(d.fact_json,'$.eventKind') IN ('validation-completed','git-job-outcome','git-job-completed'))
      AND (mode<>'passive' OR expires_at IS NULL OR expires_at>(SELECT MAX(COALESCE(d.accepted_at,d.finished_at,d.recorded_at)) FROM conversation_subscription_deliveries d
        WHERE d.subscription_id=conversation_subscriptions.id AND d.state IN ('accepted','superseded')
          AND json_extract(d.fact_json,'$.eventKind') IN ('validation-completed','git-job-outcome','git-job-completed')))`,
    )
    .run({
      project_path: recipient?.projectPath ?? null,
      conversation_id: recipient?.conversationId ?? null,
    }).changes;
}

/**
 * A run's follow ends once its final notice (success or cancellation) was
 * delivered or dismissed: the run records nothing after it.
 */
export function retireFinishedRunFollows(
  db: Db,
  recipient?: SubscriptionRecipient,
): number {
  const final = `d.subscription_id=conversation_subscriptions.id AND d.state IN ('accepted','superseded')
    AND json_extract(d.fact_json,'$.eventKind') IN ('run-boundary:succeeded','run-boundary:cancelled')`;
  return db
    .prepare(
      `UPDATE conversation_subscriptions
    SET expires_at=(SELECT MAX(COALESCE(d.accepted_at,d.finished_at,d.recorded_at)) FROM conversation_subscription_deliveries d WHERE ${final})
    WHERE source_kind='run' AND expires_at IS NULL
      AND (@project_path IS NULL OR (project_path=@project_path AND conversation_id=@conversation_id))
      AND EXISTS (SELECT 1 FROM conversation_subscription_deliveries d WHERE ${final})`,
    )
    .run({
      project_path: recipient?.projectPath ?? null,
      conversation_id: recipient?.conversationId ?? null,
    }).changes;
}

/**
 * Returns every fact a wake batch claimed to the inbox as pending, so another
 * wake or briefing can take it. Used wherever a batch ends without delivery.
 */
export function releaseBatchClaims(
  db: Db,
  recipient: SubscriptionRecipient,
  batchId: string,
): number {
  return db
    .prepare(
      `UPDATE conversation_subscription_deliveries SET state='pending',attempt_id=NULL,queued_at=NULL,accepted_at=NULL,finished_at=NULL,last_error=NULL
    WHERE project_path=@project_path AND conversation_id=@conversation_id AND attempt_id=@batch_id AND state IN ('queued','failed','uncertain')`,
    )
    .run({
      project_path: recipient.projectPath,
      conversation_id: recipient.conversationId,
      batch_id: batchId,
    }).changes;
}
