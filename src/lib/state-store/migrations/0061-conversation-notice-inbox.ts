import type { StateMigration } from "./types";
import { z } from "zod";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  CONVERSATION_NOTICE_INBOX_SCHEMA_VERSION,
  KNOWN_SCHEMA_VERSION,
  migrateConversationNoticeSourceSchema,
} from "../state-db";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { sourceFactSchema } from "@/lib/subscriptions/schemas";

const legacyRowSchema = z.object({
  id: z.string(),
  project_path: z.string(),
  session_name: z.string().nullable(),
  pending_agent_notices: z.string(),
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function legacyIdentity(
  prefix: string,
  parts: readonly (string | number)[],
): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

/** Exact persisted producer template; arbitrary feedback mentioning task loss stays passive. */
export function isLegacyBackgroundTaskLoss(text: string): boolean {
  return /^Your previous agent session ended \([\s\S]*\) while [1-9]\d* background task\(s\) were still running: [\s\S]+\. Those processes were terminated with the session — their completion notifications will never arrive\. Do not wait for them; check any output files on disk and re-run whatever is still needed\.$/.test(
    text,
  );
}

export const conversationNoticeInbox: StateMigration = {
  name: "0061-conversation-notice-inbox",
  up: async ({ context }) => {
    if (context.configDir !== null)
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        CONVERSATION_NOTICE_INBOX_SCHEMA_VERSION,
      );
    context.db
      .transaction(() => {
        const db = context.db;
        enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
        migrateConversationNoticeSourceSchema(db);
        const recordedAt = new Date().toISOString();
        for (const table of ["conversations", "project_conversations"]) {
          const exists = db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(table);
          if (!exists) continue;
          const columns = db
            .prepare(`PRAGMA table_info(${table})`)
            .all() as Array<{ name: string }>;
          if (
            !columns.some((column) => column.name === "pending_agent_notices")
          )
            continue;
          const sessionNameColumn =
            table === "conversations" &&
            columns.some((column) => column.name === "session_name")
              ? "session_name"
              : "NULL AS session_name";
          const rows = db
            .prepare(
              `SELECT id,project_path,${sessionNameColumn},pending_agent_notices FROM ${table} WHERE pending_agent_notices IS NOT NULL`,
            )
            .all();
          for (const raw of rows) {
            const row = legacyRowSchema.parse(raw);
            const notices = z
              .array(z.string())
              .parse(JSON.parse(row.pending_agent_notices));
            if (!notices.length) continue;
            const subscriptionId = legacyIdentity(
              "legacy-conversation-notices",
              [row.project_path, row.id],
            );
            db.prepare(
              `INSERT INTO conversation_subscriptions
            (id,project_path,conversation_id,source_kind,source_id,reason,mode,event_kinds_json,expires_at,status,cursor,created_at,updated_at,unfollowed_at,paused_at,missing_at,last_error)
            VALUES (?,?,?,'conversation',?,'Imported pending agent notices','passive',NULL,NULL,'following','0',?,?,NULL,NULL,NULL,NULL)
            ON CONFLICT(project_path,conversation_id,source_kind,source_id) DO NOTHING`,
            ).run(
              subscriptionId,
              row.project_path,
              row.id,
              row.id,
              recordedAt,
              recordedAt,
            );
            const subscription = db
              .prepare(
                "SELECT id FROM conversation_subscriptions WHERE project_path=? AND conversation_id=? AND source_kind='conversation' AND source_id=?",
              )
              .get(row.project_path, row.id, row.id) as { id: string };
            for (const [index, text] of notices.entries()) {
              // Legacy strings carry no event ids. Their positions identify imports;
              // their prose cannot establish equivalence with canonical spec events.
              const occurrenceId = legacyIdentity(
                "legacy-pending-agent-notice",
                [row.project_path, row.id, index],
              );
              const omission =
                "\nSource text shortened; inspect the full original with the retrieval command.";
              const taskLoss = isLegacyBackgroundTaskLoss(text);
              const fact = sourceFactSchema.parse({
                occurrenceId,
                eventKind: taskLoss
                  ? "background-tasks-lost"
                  : "legacy-pending-agent-notice",
                category: taskLoss ? "outcome" : "activity",
                sourceTitle: taskLoss
                  ? "Imported background task loss"
                  : "Pending agent notice",
                summary:
                  text.length > 200
                    ? text.slice(0, 200 - omission.length) + omission
                    : text,
                sourceText: text,
                occurredAt: recordedAt,
                revision: null,
                outcome: taskLoss ? "terminated" : null,
                retrievalHandle: `cctl inbox get --json --project=${quote(path.basename(row.project_path))}${row.session_name === null ? "" : ` --session=${quote(row.session_name)}`} --conversation=${quote(row.id)} -- ${quote(occurrenceId)}`,
                actorConversationId: null,
              });
              db.prepare(
                `INSERT INTO conversation_subscription_deliveries
              (id,subscription_id,project_path,conversation_id,source_kind,source_id,occurrence_id,fact_json,recorded_at,state,attempt_id,attempt_count,queued_at,accepted_at,finished_at,last_error)
              VALUES (?,?,?,?,'conversation',?,?,?,?,'pending',NULL,0,NULL,NULL,NULL,NULL)
              ON CONFLICT(project_path,conversation_id,source_kind,source_id,occurrence_id) DO NOTHING`,
              ).run(
                occurrenceId,
                subscription.id,
                row.project_path,
                row.id,
                row.id,
                occurrenceId,
                JSON.stringify(fact),
                recordedAt,
              );
            }
            db.prepare(
              `UPDATE ${table} SET pending_agent_notices='[]' WHERE id=? AND project_path=?`,
            ).run(row.id, row.project_path);
          }
        }
        db.prepare(
          "INSERT OR IGNORE INTO schema_migrations(version,description) VALUES (?,?)",
        ).run(
          CONVERSATION_NOTICE_INBOX_SCHEMA_VERSION,
          "pending agent notices move to durable per-conversation inbox",
        );
      })
      .immediate();
  },
};
