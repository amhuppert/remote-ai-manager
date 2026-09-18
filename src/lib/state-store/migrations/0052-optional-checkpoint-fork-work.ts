import { publishSchemaCompatibilityBarrier } from "../schema-compatibility";
import type { StateMigration } from "./types";

// Older readers discard fork provenance when relatedWork is null.
export const optionalCheckpointForkWork: StateMigration = {
  name: "0052-optional-checkpoint-fork-work",
  up: async ({ context }) => {
    if (context.configDir !== null)
      await publishSchemaCompatibilityBarrier(context.configDir, 19);
    context.db
      .prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
      )
      .run(19, "checkpoint forks without related work");
  },
};
