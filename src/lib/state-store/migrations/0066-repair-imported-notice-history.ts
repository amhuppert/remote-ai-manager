import { z } from "zod";
import type { Db } from "../schemas";
import type { StateMigration } from "./types";
import { sourceFactSchema } from "@/lib/subscriptions/schemas";
import { isLegacyBackgroundTaskLoss } from "./0061-conversation-notice-inbox";
import {
  readSavedWorkflowDeliveries,
  workflowResultMigrationDeliveryId,
  workflowResultMigrationFollowId,
} from "./0063-workflow-result-inbox";

const legacyRowSchema = z.object({
  id: z.string(),
  occurrence_id: z.string(),
  fact_json: z.string(),
});
function repairLegacyOperationalText(db: Db): void {
  const rows = db
    .prepare(
      `SELECT id,occurrence_id,fact_json FROM conversation_subscription_deliveries
    WHERE source_kind='conversation' AND source_id=conversation_id
      AND id LIKE 'legacy-pending-agent-notice:%'`,
    )
    .all();
  for (const raw of rows) {
    const row = legacyRowSchema.parse(raw);
    if (
      !/^legacy-pending-agent-notice:[a-f0-9]{64}$/.test(row.id) ||
      row.occurrence_id !== row.id
    )
      continue;
    const fact = sourceFactSchema.parse(JSON.parse(row.fact_json) as unknown);
    if (
      fact.occurrenceId !== row.id ||
      fact.eventKind !== "legacy-pending-agent-notice" ||
      fact.category !== "activity" ||
      fact.outcome !== null ||
      fact.sourceText === undefined ||
      !isLegacyBackgroundTaskLoss(fact.sourceText)
    )
      continue;
    // These are delivery imports, not newly discovered domain events. Preserve
    // the legacy occurrence and all receipts; only restore the operational route.
    db.prepare(
      "UPDATE conversation_subscription_deliveries SET fact_json=? WHERE id=?",
    ).run(
      JSON.stringify({
        ...fact,
        eventKind: "background-tasks-lost",
        category: "outcome",
        outcome: "terminated",
        sourceTitle: "Imported background task loss",
      }),
      row.id,
    );
  }
}
function repairUntouchedWorkflowBaselines(db: Db): void {
  const boundaries = db.prepare(`SELECT 1 FROM graph_workflow_events
    WHERE project_path=? AND execution_id=? AND id=? AND event_type='graph-workflow-boundary'`);
  const advance = db.prepare(`UPDATE conversation_subscriptions SET cursor=@head
    WHERE id=@id AND project_path=@project_path AND conversation_id=@conversation_id AND source_kind='workflow' AND source_id=@source_id
      AND reason='Workflow result evidence' AND cursor='0' AND created_at=updated_at
      AND status='following' AND mode='passive' AND event_kinds_json IS NULL AND expires_at IS NULL
      AND paused_at IS NULL AND unfollowed_at IS NULL AND missing_at IS NULL AND last_error IS NULL`);
  const heads = new Map<
    string,
    {
      id: string;
      project_path: string;
      conversation_id: string;
      source_id: string;
      head: number;
    }
  >();
  for (const delivery of readSavedWorkflowDeliveries(db)) {
    const boundary = Number(delivery.fact.occurrenceId);
    if (
      !Number.isSafeInteger(boundary) ||
      boundary <= 0 ||
      String(boundary) !== delivery.fact.occurrenceId
    )
      continue;
    const followId = workflowResultMigrationFollowId(
      delivery.recipient,
      delivery.source.id,
    );
    if (
      delivery.subscriptionId !== followId ||
      delivery.id !==
        workflowResultMigrationDeliveryId(
          delivery.recipient,
          delivery.source.id,
          boundary,
        ) ||
      !boundaries.get(
        delivery.recipient.projectPath,
        delivery.source.id,
        boundary,
      )
    )
      continue;
    const existing = heads.get(followId);
    if (!existing || boundary > existing.head)
      heads.set(followId, {
        id: followId,
        project_path: delivery.recipient.projectPath,
        conversation_id: delivery.recipient.conversationId,
        source_id: delivery.source.id,
        head: boundary,
      });
  }
  // The original cutover did not persist its complete event head. Original
  // import identities prove this lower bound; today's head could discard later
  // unread events. Explicit/changed follows and previously projected evidence
  // are intentionally preserved because their intent cannot be reconstructed.
  for (const head of heads.values())
    advance.run({ ...head, head: String(head.head) });
}

/** Data-only repair for databases whose original notice cutovers already ran. */
export const repairImportedNoticeHistory: StateMigration = {
  name: "0066-repair-imported-notice-history",
  up: async ({ context }) => {
    context.db
      .transaction(() => {
        repairLegacyOperationalText(context.db);
        repairUntouchedWorkflowBaselines(context.db);
      })
      .immediate();
  },
};
