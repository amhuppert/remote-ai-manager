import type { StateMigration } from "./types";
import { z } from "zod";
import {
  KNOWN_SCHEMA_VERSION,
  WORKFLOW_RESULT_EVIDENCE_SCHEMA_VERSION,
  migrateConversationNoticeSourceSchema,
} from "../state-db";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";

export const notepadNoticeContext: StateMigration = {
  name: "0062-notepad-notice-context",
  up: async ({ context }) => {
    if (context.configDir !== null)
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        WORKFLOW_RESULT_EVIDENCE_SCHEMA_VERSION,
      );
    context.db
      .transaction(() => {
        const db = context.db;
        enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
        const columns = z
          .array(z.object({ name: z.string() }))
          .parse(
            db.prepare("PRAGMA table_info(notepad_delivery_watermarks)").all(),
          );
        if (
          columns.length &&
          !columns.some((column) => column.name === "observed_comment_ids_json")
        )
          db.exec(
            "ALTER TABLE notepad_delivery_watermarks ADD COLUMN observed_comment_ids_json TEXT",
          );
        migrateConversationNoticeSourceSchema(db);
        db.prepare(
          "INSERT OR IGNORE INTO schema_migrations(version,description) VALUES (?,?)",
        ).run(
          WORKFLOW_RESULT_EVIDENCE_SCHEMA_VERSION,
          "source-owned accepted notepad context and shared notice receipts",
        );
      })
      .immediate();
  },
};
