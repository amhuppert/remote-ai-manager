import { createLogger } from "@/lib/logging";
import { publishSchemaCompatibilityBarrier } from "../schema-compatibility";
import type { StateMigration } from "./types";

export const CHECKPOINT_FORKS_SCHEMA_VERSION = 16;
const logger = createLogger("state-store.migrations");

// Older readers cannot honor a fork's submitted backend or distinguish source
// evidence coordinates from the target transcript. The barrier protects both.
export const addCheckpointForks: StateMigration = {
  name: "0045-add-checkpoint-forks",
  up: async ({ context }) => {
    if (context.configDir !== null)
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        CHECKPOINT_FORKS_SCHEMA_VERSION,
      );
    context.db
      .transaction(() => {
        for (const table of [
          "conversations",
          "project_conversations",
        ] as const) {
          const columns = context.db
            .prepare(`PRAGMA table_info(${table})`)
            .all() as { name: string }[];
          if (!columns.some((column) => column.name === "checkpoint_fork"))
            context.db.exec(
              `ALTER TABLE ${table} ADD COLUMN checkpoint_fork TEXT`,
            );
        }
        context.db
          .prepare(
            "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
          )
          .run(
            CHECKPOINT_FORKS_SCHEMA_VERSION,
            "checkpoint fork lineage and submission admission",
          );
      })
      .immediate();
    logger.info("checkpoint.fork.schema_ready", {
      version: CHECKPOINT_FORKS_SCHEMA_VERSION,
    });
  },
};
