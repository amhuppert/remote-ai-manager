import { createLogger } from "@/lib/logging";
import { publishSchemaCompatibilityBarrier } from "../schema-compatibility";
import type { StateMigration } from "./types";

export const CHECKPOINT_HANDOFF_SCHEMA_VERSION = 20;
const logger = createLogger("state-store.migrations");

// Older writers cannot honor capture settlement ownership during building.
export const addCheckpointHandoff: StateMigration = {
  name: "0053-add-checkpoint-handoff",
  up: async ({ context }) => {
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        CHECKPOINT_HANDOFF_SCHEMA_VERSION,
      );
    }
    context.db
      .transaction(() => {
        const columns = context.db
          .prepare("PRAGMA table_info(conversation_checkpoint_operations)")
          .all() as { name: string }[];
        if (!columns.some((column) => column.name === "handoff_json")) {
          context.db.exec(
            "ALTER TABLE conversation_checkpoint_operations ADD COLUMN handoff_json TEXT",
          );
        }
        context.db
          .prepare(
            "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
          )
          .run(
            CHECKPOINT_HANDOFF_SCHEMA_VERSION,
            "checkpoint handoff capture ownership and settlement",
          );
      })
      .immediate();
    logger.info("checkpoint.handoff.schema_ready", {
      version: CHECKPOINT_HANDOFF_SCHEMA_VERSION,
    });
  },
};
